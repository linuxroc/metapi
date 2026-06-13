import { describe, expect, it } from 'vitest';
import {
  ADMIN_SESSION_COOKIE,
  buildAdminSessionCookie,
  createAdminSession,
  isValidAdminSession,
  parseCookieValue,
  resetAdminSessionsForTests,
  revokeAdminSession,
} from './adminSessionService.js';
import { secureTokenEqual } from './secureTokenCompare.js';

describe('admin session security', () => {
  it('compares tokens through fixed-size digests', () => {
    expect(secureTokenEqual('secret-token', 'secret-token')).toBe(true);
    expect(secureTokenEqual('secret-toke', 'secret-token')).toBe(false);
    expect(secureTokenEqual('x'.repeat(4096), 'secret-token')).toBe(false);
  });

  it('creates expiring, revocable admin sessions', () => {
    resetAdminSessionsForTests();
    const session = createAdminSession(1_000);

    expect(isValidAdminSession(session.token, 1_001)).toBe(true);
    revokeAdminSession(session.token);
    expect(isValidAdminSession(session.token, 1_002)).toBe(false);
  });

  it('returns an empty value for malformed cookie encoding', () => {
    expect(parseCookieValue(
      `${ADMIN_SESSION_COOKIE}=%E0%A4%A`,
      ADMIN_SESSION_COOKIE,
    )).toBe('');
  });

  it('round-trips the generated session cookie', () => {
    const session = createAdminSession(1_000);
    expect(parseCookieValue(
      buildAdminSessionCookie(session.token, false),
      ADMIN_SESSION_COOKIE,
    )).toBe(session.token);
  });

  it('isolates monitor sessions from admin authentication and capacity', () => {
    resetAdminSessionsForTests();
    const adminSession = createAdminSession(1_000);
    const monitorSession = createAdminSession(1_000, {
      scope: 'monitor',
      ttlMs: 2_000,
    });

    expect(isValidAdminSession(monitorSession.token, 1_001)).toBe(false);
    expect(isValidAdminSession(monitorSession.token, 1_001, 'monitor')).toBe(true);

    for (let index = 0; index < 257; index += 1) {
      createAdminSession(1_001 + index, { scope: 'monitor' });
    }

    expect(isValidAdminSession(adminSession.token, 2_000)).toBe(true);
  });

  it('builds a scoped monitor cookie without string rewriting', () => {
    const session = createAdminSession(1_000, { scope: 'monitor' });
    const cookie = buildAdminSessionCookie(session.token, false, {
      name: 'meta_monitor_auth',
      maxAgeSeconds: 7_200,
    });

    expect(cookie).toContain('meta_monitor_auth=');
    expect(cookie).toContain('Max-Age=7200');
    expect(parseCookieValue(cookie, 'meta_monitor_auth')).toBe(session.token);
  });
});
