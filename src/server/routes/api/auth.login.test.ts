import Fastify, { type FastifyInstance } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  isValidAdminSession,
  resetAdminSessionsForTests,
} from '../../services/adminSessionService.js';

type ConfigModule = typeof import('../../config.js');
type RateLimitModule = typeof import('../../middleware/requestRateLimit.js');

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

describe('POST /api/auth/login', () => {
  let app: FastifyInstance;
  let config: ConfigModule['config'];
  let resetRequestRateLimitStore: RateLimitModule['resetRequestRateLimitStore'];
  let dataDir = '';
  let originalDataDir: string | undefined;
  let originalAuthToken = '';
  let originalSiteKey = '';
  let originalSecret = '';
  let originalAdminAllowlist: string[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-auth-login-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const configModule = await import('../../config.js');
    const rateLimitModule = await import('../../middleware/requestRateLimit.js');
    const routesModule = await import('./auth.js');
    config = configModule.config;
    resetRequestRateLimitStore = rateLimitModule.resetRequestRateLimitStore;

    originalAuthToken = config.authToken;
    originalSiteKey = config.cloudflareTurnstileSiteKey;
    originalSecret = config.cloudflareTurnstileSecret;
    originalAdminAllowlist = config.adminIpAllowlist;

    app = Fastify({ trustProxy: true });
    await app.register(routesModule.authRoutes);
  });

  beforeEach(() => {
    config.authToken = 'secret-token';
    config.cloudflareTurnstileSiteKey = '';
    config.cloudflareTurnstileSecret = '';
    config.adminIpAllowlist = [];
    resetRequestRateLimitStore();
    resetAdminSessionsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    config.authToken = originalAuthToken;
    config.cloudflareTurnstileSiteKey = originalSiteKey;
    config.cloudflareTurnstileSecret = originalSecret;
    config.adminIpAllowlist = originalAdminAllowlist;
    await app.close();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('returns 200 when Turnstile is disabled and the admin token matches', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'secret-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      sessionToken: expect.any(String),
      expiresAt: expect.any(Number),
    });
    // No Turnstile call when the feature is off.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('revokes bearer and cookie sessions on logout', async () => {
    const bearerSession = createAdminSession();
    const cookieSession = createAdminSession();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        authorization: `Bearer ${bearerSession.token}`,
        cookie: `${ADMIN_SESSION_COOKIE}=${cookieSession.token}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(isValidAdminSession(bearerSession.token)).toBe(false);
    expect(isValidAdminSession(cookieSession.token)).toBe(false);
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
  });

  it('trims whitespace from the submitted admin token before comparing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: '  secret-token  ' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      sessionToken: expect.any(String),
    });
  });

  it('returns 400 when the admin token is missing or blank', async () => {
    const missingResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {},
    });
    expect(missingResponse.statusCode).toBe(400);
    expect(missingResponse.json()).toEqual({
      success: false,
      error: 'missing_admin_token',
    });

    const blankResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: '   ' },
    });
    expect(blankResponse.statusCode).toBe(400);
    expect(blankResponse.json()).toEqual({
      success: false,
      error: 'missing_admin_token',
    });
  });

  it('returns 401 when the admin token does not match', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'wrong-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      success: false,
      error: 'invalid_admin_token',
    });
  });

  it('returns 403 when the client IP is not in the admin allowlist', async () => {
    config.adminIpAllowlist = ['10.0.0.1'];

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '203.0.113.5',
      payload: { token: 'secret-token' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      success: false,
      error: 'ip_not_allowed',
    });
  });

  it('honors the admin allowlist for matching IPs even when the IP differs from prior requests', async () => {
    config.adminIpAllowlist = ['10.0.0.1'];

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '10.0.0.1',
      payload: { token: 'secret-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      sessionToken: expect.any(String),
    });
  });

  it('rejects invalid admin token before checking Turnstile when allowlist denies the request', async () => {
    // IP allowlist must short-circuit BEFORE Turnstile so blocked IPs
    // cannot probe the Turnstile verifier or the admin token.
    config.adminIpAllowlist = ['10.0.0.1'];
    config.cloudflareTurnstileSiteKey = 'site-key-x';
    config.cloudflareTurnstileSecret = 'secret-key-x';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '203.0.113.5',
      payload: { token: 'secret-token', turnstileToken: 'cf-token-x' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ success: false, error: 'ip_not_allowed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats half-configured Turnstile (site key only) as disabled and lets login through', async () => {
    config.cloudflareTurnstileSiteKey = 'site-key-only';
    config.cloudflareTurnstileSecret = '';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      // No turnstileToken — must still succeed because the feature is
      // disabled when half-configured.
      payload: { token: 'secret-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      sessionToken: expect.any(String),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats half-configured Turnstile (secret only) as disabled and lets login through', async () => {
    config.cloudflareTurnstileSiteKey = '';
    config.cloudflareTurnstileSecret = 'secret-only';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'secret-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      sessionToken: expect.any(String),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 403 when Turnstile is enabled but no turnstile token is supplied', async () => {
    config.cloudflareTurnstileSiteKey = 'site-key-x';
    config.cloudflareTurnstileSecret = 'secret-key-x';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'secret-token' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      success: false,
      error: 'missing_turnstile_token',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 403 with reason when Cloudflare reports verification failure', async () => {
    config.cloudflareTurnstileSiteKey = 'site-key-x';
    config.cloudflareTurnstileSecret = 'secret-key-x';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'secret-token', turnstileToken: 'cf-token-bad' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      success: false,
      error: 'turnstile_failed',
      reason: 'invalid-input-response',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(TURNSTILE_VERIFY_URL);
    expect(calledInit?.method).toBe('POST');
  });

  it('returns 403 when Cloudflare verify endpoint returns an HTTP error', async () => {
    config.cloudflareTurnstileSiteKey = 'site-key-x';
    config.cloudflareTurnstileSecret = 'secret-key-x';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('upstream error', { status: 502 }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'secret-token', turnstileToken: 'cf-token-x' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      success: false,
      error: 'turnstile_failed',
      reason: 'turnstile_http_502',
    });
  });

  it('still rejects an invalid admin token even when Turnstile passes', async () => {
    config.cloudflareTurnstileSiteKey = 'site-key-x';
    config.cloudflareTurnstileSecret = 'secret-key-x';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'wrong-token', turnstileToken: 'cf-token-good' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      success: false,
      error: 'invalid_admin_token',
    });
  });

  it('returns 200 when both Turnstile verification and admin token succeed', async () => {
    config.cloudflareTurnstileSiteKey = 'site-key-x';
    config.cloudflareTurnstileSecret = 'secret-key-x';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'secret-token', turnstileToken: 'cf-token-good' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      sessionToken: expect.any(String),
    });

    // The verify call should have included secret and response fields.
    const [, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const bodyText = typeof calledInit?.body === 'string'
      ? calledInit.body
      : (calledInit?.body as URLSearchParams)?.toString?.() ?? '';
    expect(bodyText).toContain('secret=secret-key-x');
    expect(bodyText).toContain('response=cf-token-good');
  });
});
