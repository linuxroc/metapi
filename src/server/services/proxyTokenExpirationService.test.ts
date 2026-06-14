import { beforeEach, describe, expect, it, vi } from 'vitest';

const isExplicitTokenExpirationResponseMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const consoleWarnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});

vi.mock('./alertRules.js', () => ({
  isExplicitTokenExpirationResponse: (...args: unknown[]) => isExplicitTokenExpirationResponseMock(...args),
}));

vi.mock('./alertService.js', () => ({
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

describe('proxyTokenExpirationService', () => {
  beforeEach(() => {
    isExplicitTokenExpirationResponseMock.mockReset();
    reportTokenExpiredMock.mockReset();
    consoleWarnMock.mockClear();
  });

  it('reports explicit credential failures', async () => {
    isExplicitTokenExpirationResponseMock.mockReturnValue(true);

    const { reportExplicitProxyTokenExpiration } = await import('./proxyTokenExpirationService.js');
    await expect(reportExplicitProxyTokenExpiration({
      status: 401,
      errorText: 'invalid_api_key',
      accountId: 12,
      username: 'user',
      siteName: 'site',
      warningScope: 'chat',
    })).resolves.toBe(true);

    expect(reportTokenExpiredMock).toHaveBeenCalledWith({
      accountId: 12,
      username: 'user',
      siteName: 'site',
      detail: 'HTTP 401',
    }, {
      waitForAlert: false,
    });
  });

  it('leaves terminal reporting available when critical expiration persistence fails', async () => {
    isExplicitTokenExpirationResponseMock.mockReturnValue(true);
    reportTokenExpiredMock.mockRejectedValue(new Error('notification unavailable'));

    const { reportExplicitProxyTokenExpiration } = await import('./proxyTokenExpirationService.js');
    await expect(reportExplicitProxyTokenExpiration({
      status: 401,
      errorText: 'expired token',
      accountId: 12,
      warningScope: 'responses',
    })).resolves.toBe(false);

    expect(consoleWarnMock).toHaveBeenCalled();
  });

  it('ignores ambiguous authorization failures', async () => {
    isExplicitTokenExpirationResponseMock.mockReturnValue(false);

    const { reportExplicitProxyTokenExpiration } = await import('./proxyTokenExpirationService.js');
    await expect(reportExplicitProxyTokenExpiration({
      status: 401,
      errorText: 'Unauthorized',
      accountId: 12,
      warningScope: 'chat',
    })).resolves.toBe(false);

    expect(reportTokenExpiredMock).not.toHaveBeenCalled();
  });

  it('ignores explicit-looking credential text on retryable upstream statuses', async () => {
    isExplicitTokenExpirationResponseMock.mockReturnValue(false);

    const { reportExplicitProxyTokenExpiration } = await import('./proxyTokenExpirationService.js');
    await expect(reportExplicitProxyTokenExpiration({
      status: 503,
      errorText: 'token expired in upstream cache',
      accountId: 12,
      warningScope: 'chat',
    })).resolves.toBe(false);

    expect(isExplicitTokenExpirationResponseMock).toHaveBeenCalledWith({
      status: 503,
      message: 'token expired in upstream cache',
    });
    expect(reportTokenExpiredMock).not.toHaveBeenCalled();
  });
});
