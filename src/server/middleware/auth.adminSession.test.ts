import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  resetAdminSessionsForTests,
  revokeAdminSession,
} from '../services/adminSessionService.js';
import { authMiddleware } from './auth.js';

describe('admin session middleware', () => {
  const originalAuthToken = config.authToken;
  const originalAllowlist = config.adminIpAllowlist;

  afterEach(() => {
    config.authToken = originalAuthToken;
    config.adminIpAllowlist = originalAllowlist;
    resetAdminSessionsForTests();
  });

  it('accepts an issued session and rejects it after revocation', async () => {
    config.authToken = 'admin-secret';
    config.adminIpAllowlist = [];
    const session = createAdminSession();
    const app = Fastify();
    app.addHook('onRequest', authMiddleware);
    app.get('/protected', async () => ({ ok: true }));

    const accepted = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${session.token}` },
    });
    revokeAdminSession(session.token);
    const rejected = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${session.token}` },
    });

    expect(accepted.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a malformed session cookie without throwing', async () => {
    config.authToken = 'admin-secret';
    config.adminIpAllowlist = [];
    const app = Fastify();
    app.addHook('onRequest', authMiddleware);
    app.get('/protected', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE}=%E0%A4%A`,
      },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
