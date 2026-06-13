import { createHash, randomBytes } from 'node:crypto';

export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const ADMIN_SESSION_COOKIE = 'metapi_admin_session';

export type AdminSessionScope = 'admin' | 'monitor';

type AdminSession = {
  expiresAt: number;
  scope: AdminSessionScope;
};

const sessions = new Map<string, AdminSession>();
const MAX_SESSIONS_PER_SCOPE = 256;

function sessionKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function pruneExpiredSessions(nowMs: number): void {
  for (const [key, session] of sessions.entries()) {
    if (session.expiresAt <= nowMs) sessions.delete(key);
  }
}

export function createAdminSession(
  nowMs = Date.now(),
  options: {
    scope?: AdminSessionScope;
    ttlMs?: number;
  } = {},
): {
  token: string;
  expiresAt: number;
} {
  pruneExpiredSessions(nowMs);
  const scope = options.scope ?? 'admin';
  let scopedSessionCount = 0;
  for (const session of sessions.values()) {
    if (session.scope === scope) scopedSessionCount += 1;
  }
  while (scopedSessionCount >= MAX_SESSIONS_PER_SCOPE) {
    const oldestKey = Array.from(sessions.entries())
      .find(([, session]) => session.scope === scope)?.[0];
    if (!oldestKey) break;
    sessions.delete(oldestKey);
    scopedSessionCount -= 1;
  }
  const token = randomBytes(32).toString('base64url');
  const ttlMs = Math.max(1, Math.floor(options.ttlMs ?? ADMIN_SESSION_TTL_MS));
  const expiresAt = nowMs + ttlMs;
  sessions.set(sessionKey(token), { expiresAt, scope });
  return { token, expiresAt };
}

export function isValidAdminSession(
  token: unknown,
  nowMs = Date.now(),
  scope: AdminSessionScope = 'admin',
): boolean {
  if (typeof token !== 'string' || !token.trim()) return false;
  pruneExpiredSessions(nowMs);
  const session = sessions.get(sessionKey(token.trim()));
  return !!session && session.scope === scope && session.expiresAt > nowMs;
}

export function revokeAdminSession(token: unknown): void {
  if (typeof token !== 'string' || !token.trim()) return;
  sessions.delete(sessionKey(token.trim()));
}

export function revokeAllAdminSessions(): void {
  sessions.clear();
}

export function parseCookieValue(rawCookie: string | undefined, name: string): string {
  if (!rawCookie) return '';
  for (const part of rawCookie.split(';')) {
    const entry = part.trim();
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

export function buildAdminSessionCookie(
  token: string,
  secure: boolean,
  options: {
    name?: string;
    maxAgeSeconds?: number;
  } = {},
): string {
  const name = options.name ?? ADMIN_SESSION_COOKIE;
  const maxAge = Math.max(
    1,
    Math.floor(options.maxAgeSeconds ?? ADMIN_SESSION_TTL_MS / 1000),
  );
  return [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function buildExpiredAdminSessionCookie(secure: boolean): string {
  return [
    `${ADMIN_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function resetAdminSessionsForTests(): void {
  sessions.clear();
}
