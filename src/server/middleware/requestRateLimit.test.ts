import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createRateLimitGuard,
  resetRequestRateLimitStore,
} from './requestRateLimit.js';

describe('request rate limiting', () => {
  beforeEach(() => {
    resetRequestRateLimitStore();
  });

  it('does not let callers rotate X-Forwarded-For to bypass a bucket', async () => {
    const app = Fastify();
    app.get('/limited', {
      preHandler: [createRateLimitGuard({
        bucket: 'test',
        max: 1,
        windowMs: 60_000,
      })],
    }, async () => ({ ok: true }));

    const first = await app.inject({
      method: 'GET',
      url: '/limited',
      remoteAddress: '10.0.0.8',
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    const second = await app.inject({
      method: 'GET',
      url: '/limited',
      remoteAddress: '10.0.0.8',
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    await app.close();
  });
});
