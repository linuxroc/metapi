import { beforeEach, describe, expect, it, vi } from 'vitest';

const accountUpdateRunMock = vi.fn();
const eventInsertRunMock = vi.fn();
const setAccountRuntimeHealthMock = vi.fn();
const invalidateTokenRouterCacheMock = vi.fn();
const sendNotificationMock = vi.fn();
const consoleWarnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});

vi.mock('../db/index.js', () => {
  const updateChain = {
    set: () => updateChain,
    where: () => updateChain,
    run: (...args: unknown[]) => accountUpdateRunMock(...args),
  };
  const insertChain = {
    values: () => insertChain,
    run: (...args: unknown[]) => eventInsertRunMock(...args),
  };
  return {
    db: {
      update: () => updateChain,
      insert: () => insertChain,
    },
    schema: {
      accounts: { id: 'id' },
      events: {},
    },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
}));

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

vi.mock('./accountHealthService.js', () => ({
  setAccountRuntimeHealth: (...args: unknown[]) => setAccountRuntimeHealthMock(...args),
}));

vi.mock('./alertRules.js', () => ({
  appendSessionTokenRebindHint: (message: string) => message,
}));

vi.mock('./localTimeService.js', () => ({
  formatUtcSqlDateTime: () => '2026-06-14 10:00:00',
}));

vi.mock('./tokenRouter.js', () => ({
  invalidateTokenRouterCache: (...args: unknown[]) => invalidateTokenRouterCacheMock(...args),
}));

describe('alertService delivery', () => {
  beforeEach(() => {
    accountUpdateRunMock.mockReset();
    eventInsertRunMock.mockReset();
    setAccountRuntimeHealthMock.mockReset();
    invalidateTokenRouterCacheMock.mockReset();
    sendNotificationMock.mockReset();
    consoleWarnMock.mockClear();
    accountUpdateRunMock.mockResolvedValue(undefined);
    eventInsertRunMock.mockResolvedValue(undefined);
    setAccountRuntimeHealthMock.mockResolvedValue(undefined);
  });

  it('returns after critical state is persisted without waiting for notification delivery', async () => {
    sendNotificationMock.mockImplementation(() => new Promise(() => {}));

    const { reportTokenExpired } = await import('./alertService.js');
    await expect(reportTokenExpired({
      accountId: 12,
      username: 'user',
      siteName: 'site',
      detail: 'HTTP 401',
    }, {
      waitForAlert: false,
    })).resolves.toBeUndefined();

    expect(accountUpdateRunMock).toHaveBeenCalledTimes(1);
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledTimes(1);
    expect(invalidateTokenRouterCacheMock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the account expired when event persistence fails in background delivery', async () => {
    eventInsertRunMock.mockRejectedValue(new Error('event storage unavailable'));

    const { reportTokenExpired } = await import('./alertService.js');
    await expect(reportTokenExpired({
      accountId: 12,
      username: 'user',
      siteName: 'site',
    }, {
      waitForAlert: false,
    })).resolves.toBeUndefined();

    expect(accountUpdateRunMock).toHaveBeenCalledTimes(1);
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(consoleWarnMock).toHaveBeenCalled();
  });

  it('does not wait for proxy failure notification delivery', async () => {
    sendNotificationMock.mockImplementation(() => new Promise(() => {}));

    const { reportProxyAllFailed } = await import('./alertService.js');
    await expect(reportProxyAllFailed({
      model: 'gpt-test',
      reason: 'upstream unavailable',
    })).resolves.toBeUndefined();

    expect(eventInsertRunMock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('does not fail proxy reporting when event persistence is unavailable', async () => {
    eventInsertRunMock.mockRejectedValue(new Error('event storage unavailable'));

    const { reportProxyAllFailed } = await import('./alertService.js');
    await expect(reportProxyAllFailed({
      model: 'gpt-test',
      reason: 'upstream unavailable',
    })).resolves.toBeUndefined();

    await Promise.resolve();
    expect(consoleWarnMock).toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});
