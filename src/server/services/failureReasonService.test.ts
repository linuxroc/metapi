import { describe, expect, it } from 'vitest';
import { classifyFailureReason } from './failureReasonService.js';

describe('failureReasonService', () => {
  it('classifies turnstile requirement as manual verification', () => {
    const result = classifyFailureReason({
      message: 'Turnstile token 为空',
      status: 'failed',
    });
    expect(result.code).toBe('manual_turnstile_required');
    expect(result.category).toBe('verification');
  });

  it('classifies cloudflare tunnel outage', () => {
    const result = classifyFailureReason({
      message: 'HTTP 530 Cloudflare Tunnel error | Error 1033',
      status: 'failed',
      httpStatus: 530,
    });
    expect(result.code).toBe('cloudflare_tunnel_unavailable');
    expect(result.category).toBe('network');
  });

  it('classifies token errors using status and message', () => {
    const result = classifyFailureReason({
      message: 'invalid access token',
      status: 'failed',
      httpStatus: 401,
    });
    expect(result.code).toBe('token_expired');
    expect(result.category).toBe('auth');
  });

  it('classifies already checked in as state info', () => {
    const result = classifyFailureReason({
      message: '今天已经签到过啦',
      status: 'success',
    });
    expect(result.code).toBe('already_checked_in');
    expect(result.category).toBe('state');
  });

  it('classifies missing checkin endpoint as site capability issue', () => {
    const result = classifyFailureReason({
      message: 'checkin endpoint not found',
      status: 'skipped',
    });
    expect(result.code).toBe('checkin_not_supported');
    expect(result.category).toBe('site');
    expect(result.title).toBe('站点未开启签到');
  });

  it('classifies sub2api unsupported checkin message as site capability issue', () => {
    const result = classifyFailureReason({
      message: 'Check-in is not supported by Sub2API',
      status: 'failed',
    });
    expect(result.code).toBe('checkin_not_supported');
    expect(result.category).toBe('site');
  });

  it.each([
    'fetch failed',
    'socket hang up',
    'read ECONNRESET',
    'connect ECONNREFUSED 127.0.0.1:443',
    'getaddrinfo ENOTFOUND upstream.example.com',
    'getaddrinfo EAI_AGAIN upstream.example.com',
  ])('classifies transient connection failure: %s', (message) => {
    const result = classifyFailureReason({ message, status: 'failed' });
    expect(result.code).toBe('network_connection_error');
    expect(result.category).toBe('network');
  });
});
