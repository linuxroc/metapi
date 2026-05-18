import type { FastifyInstance } from 'fastify';

const DESKTOP_HEALTH_ROUTE = '/api/desktop/health';
const TURNSTILE_CONFIG_ROUTE = '/api/auth/turnstile-config';
const LOGIN_ROUTE = '/api/auth/login';

export function isPublicApiRoute(url: string): boolean {
  // Strip query string before comparing — public route checks should be
  // path-only so callers can attach `?t=...` cache-busters without losing
  // the public bypass.
  const pathname = url.split('?', 1)[0];
  return (
    pathname === DESKTOP_HEALTH_ROUTE
    || pathname === TURNSTILE_CONFIG_ROUTE
    || pathname === LOGIN_ROUTE
    || pathname.startsWith('/api/oauth/callback/')
  );
}

export async function registerDesktopRoutes(app: FastifyInstance) {
  app.get(DESKTOP_HEALTH_ROUTE, async () => ({ ok: true }));
}
