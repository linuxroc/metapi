import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, schema } from '../../db/index.js';
import { config } from '../../config.js';
import { eq } from 'drizzle-orm';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { parseAuthChangePayload } from '../../contracts/supportRoutePayloads.js';
import { extractClientIp, isIpAllowed } from '../../middleware/auth.js';
import {
  ADMIN_SESSION_COOKIE,
  buildAdminSessionCookie,
  buildExpiredAdminSessionCookie,
  createAdminSession,
  parseCookieValue,
  revokeAdminSession,
  revokeAllAdminSessions,
} from '../../services/adminSessionService.js';
import { secureTokenEqual } from '../../services/secureTokenCompare.js';

const limitAdminTokenChange = createRateLimitGuard({
  bucket: 'auth-change',
  max: 3,
  windowMs: 60_000,
});

// Tight rate limit on the public login endpoint to slow down brute-force
// attempts even when Turnstile is disabled.
const limitLoginAttempt = createRateLimitGuard({
  bucket: 'auth-login',
  max: 10,
  windowMs: 60_000,
});

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_VERIFY_TIMEOUT_MS = 5_000;

function isTurnstileEnabled(): boolean {
  // Turnstile only activates when BOTH the public site key (used by the
  // login page widget) and the server-side secret (used by the verify
  // call) are present. Half-configured deployments would either render a
  // widget no one can verify or skip verification entirely; both are
  // unsafe, so we treat the feature as disabled in that case and emit a
  // startup warning via warnTurnstileMisconfiguration().
  return (
    config.cloudflareTurnstileSiteKey.length > 0
    && config.cloudflareTurnstileSecret.length > 0
  );
}

let turnstileMisconfigurationWarned = false;
function warnTurnstileMisconfiguration(): void {
  if (turnstileMisconfigurationWarned) return;
  const hasSiteKey = config.cloudflareTurnstileSiteKey.length > 0;
  const hasSecret = config.cloudflareTurnstileSecret.length > 0;
  if (hasSiteKey === hasSecret) return; // both set or both empty
  turnstileMisconfigurationWarned = true;
  const missing = hasSiteKey ? 'CLOUDFLARE_TURNSTILE_SECRET' : 'CLOUDFLARE_TURNSTILE_SITE_KEY';
  // eslint-disable-next-line no-console
  console.warn(
    `[turnstile] disabled: ${missing} is empty. Set both CLOUDFLARE_TURNSTILE_SITE_KEY and CLOUDFLARE_TURNSTILE_SECRET to enable.`,
  );
}

async function verifyTurnstileToken(token: string, clientIp: string): Promise<{ ok: boolean; reason?: string }> {
  if (!config.cloudflareTurnstileSecret) {
    return { ok: false, reason: 'turnstile_secret_missing' };
  }

  const body = new URLSearchParams();
  body.set('secret', config.cloudflareTurnstileSecret);
  body.set('response', token);
  if (clientIp) body.set('remoteip', clientIp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURNSTILE_VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, reason: `turnstile_http_${res.status}` };
    }
    const payload = (await res.json()) as { success?: unknown; 'error-codes'?: unknown };
    if (payload && payload.success === true) return { ok: true };
    const codes = Array.isArray(payload?.['error-codes'])
      ? (payload['error-codes'] as unknown[]).filter((item) => typeof item === 'string').join(',')
      : '';
    return { ok: false, reason: codes || 'turnstile_failed' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : 'turnstile_network_error' };
  } finally {
    clearTimeout(timer);
  }
}

type LoginRequestBody = {
  token: unknown;
  turnstileToken?: unknown;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function authRoutes(app: FastifyInstance) {
  warnTurnstileMisconfiguration();

  // Public endpoint so the login page can know whether to render the
  // Cloudflare Turnstile widget and which site key to load. Only exposes
  // the public site key; the secret never leaves the server.
  app.get('/api/auth/turnstile-config', async () => ({
    enabled: isTurnstileEnabled(),
    siteKey: isTurnstileEnabled() ? config.cloudflareTurnstileSiteKey : '',
  }));

  // Dedicated public login endpoint. Turnstile (when enabled) is checked
  // BEFORE the admin token comparison, so the challenge applies to every
  // unauthenticated attempt — including wrong-token brute force. This
  // route is whitelisted in isPublicApiRoute so the global admin auth
  // middleware does not pre-empt it; for the same reason, the IP
  // allowlist check that lives inside that middleware must be replicated
  // here so login does not become an allowlist bypass.
  app.post<{ Body: LoginRequestBody }>(
    '/api/auth/login',
    { preHandler: [limitLoginAttempt] },
    async (request, reply) => {
      const clientIp = extractClientIp(request.ip);
      if (!isIpAllowed(clientIp, config.adminIpAllowlist)) {
        return reply.code(403).send({ success: false, error: 'ip_not_allowed' });
      }

      const body = (request.body && typeof request.body === 'object' && !Array.isArray(request.body))
        ? (request.body as LoginRequestBody)
        : { token: undefined };
      const submittedToken = asTrimmedString(body.token);
      if (!submittedToken) {
        return reply.code(400).send({ success: false, error: 'missing_admin_token' });
      }

      if (isTurnstileEnabled()) {
        const turnstileToken = asTrimmedString(body.turnstileToken);
        if (!turnstileToken) {
          return reply.code(403).send({ success: false, error: 'missing_turnstile_token' });
        }
        const result = await verifyTurnstileToken(turnstileToken, clientIp);
        if (!result.ok) {
          return reply.code(403).send({ success: false, error: 'turnstile_failed', reason: result.reason });
        }
      }

      if (!secureTokenEqual(submittedToken, config.authToken)) {
        return reply.code(401).send({ success: false, error: 'invalid_admin_token' });
      }

      const session = createAdminSession();
      reply.header(
        'set-cookie',
        buildAdminSessionCookie(session.token, request.protocol === 'https'),
      );
      return {
        success: true,
        sessionToken: session.token,
        expiresAt: session.expiresAt,
      };
    },
  );

  // Change admin auth token (requires old token verification).
  // This is a logged-in flow guarded by the admin auth middleware plus a
  // rate-limit, so Turnstile is intentionally NOT applied here — the
  // caller is already authenticated.
  app.post<{ Body: unknown }>(
    '/api/settings/auth/change',
    { preHandler: [limitAdminTokenChange] },
    async (request, reply) => {
    const parsedBody = parseAuthChangePayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const { oldToken, newToken } = parsedBody.data;

    if (!oldToken || !newToken) {
      return reply.code(400).send({ success: false, message: '请填写所有字段' });
    }

    if (newToken.length < 6) {
      return reply.code(400).send({ success: false, message: '新 Token 至少 6 个字符' });
    }

    if (!secureTokenEqual(oldToken, config.authToken)) {
      return reply.code(403).send({ success: false, message: '旧 Token 验证失败' });
    }

    // Save to settings table
    const existing = await db.select().from(schema.settings).where(eq(schema.settings.key, 'auth_token')).get();
    if (existing) {
      await db.update(schema.settings).set({ value: JSON.stringify(newToken) }).where(eq(schema.settings.key, 'auth_token')).run();
    } else {
      await db.insert(schema.settings).values({ key: 'auth_token', value: JSON.stringify(newToken) }).run();
    }

    // Update runtime config
    config.authToken = newToken;
    revokeAllAdminSessions();
    const session = createAdminSession();
    reply.header(
      'set-cookie',
      buildAdminSessionCookie(session.token, request.protocol === 'https'),
    );

    try {
      const createdAt = formatUtcSqlDateTime(new Date());
      await db.insert(schema.events).values({
        type: 'token',
        title: '管理员登录令牌已更新',
        message: '管理员登录 Token 已被修改，请使用新 Token 登录。',
        level: 'warning',
        relatedType: 'settings',
        createdAt,
      }).run();
    } catch {}

    return {
      success: true,
      message: 'Token 已更新',
      sessionToken: session.token,
      expiresAt: session.expiresAt,
    };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = typeof request.headers.authorization === 'string'
      ? request.headers.authorization.replace(/^Bearer\s+/i, '').trim()
      : '';
    const cookieToken = parseCookieValue(request.headers.cookie, ADMIN_SESSION_COOKIE);
    revokeAdminSession(auth);
    revokeAdminSession(cookieToken);
    reply.header(
      'set-cookie',
      buildExpiredAdminSessionCookie(request.protocol === 'https'),
    );
    return { success: true };
  });

  // Get masked current token (for display). Used by the Settings page on
  // an already-authenticated session — the global admin auth middleware
  // is the only guard, no Turnstile here so logged-in flows are
  // unaffected by the feature.
  app.get('/api/settings/auth/info', async () => {
    const token = config.authToken;
    const masked = token.length > 8
      ? token.slice(0, 4) + '****' + token.slice(-4)
      : '****';
    return { masked };
  });
}
