import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cronStopMock = vi.fn();
const scheduleMock = vi.fn(() => ({
  stop: cronStopMock,
}));
const validateMock = vi.fn(() => true);
const allMock = vi.fn();
const dbRowsMock = vi.fn(() => []);
const dbCheckinLogsRowsMock = vi.fn(() => []);

vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: unknown[]) => scheduleMock(...args),
    validate: (...args: unknown[]) => validateMock(...args),
  },
}));

vi.mock('../db/index.js', () => {
  const schema = {
    settings: { key: 'key' },
    accounts: { id: 'id', siteId: 'siteId', checkinEnabled: 'checkinEnabled', status: 'status', lastCheckinAt: 'lastCheckinAt' },
    sites: { id: 'id', status: 'status' },
    checkinLogs: { accountId: 'accountId', status: 'status', createdAt: 'createdAt' },
  };
  let selectedTable: unknown;
  const queryChain = {
    where: () => queryChain,
    get: () => undefined,
    all: () => (selectedTable === schema.checkinLogs ? dbCheckinLogsRowsMock() : dbRowsMock()),
    from: (table: unknown) => {
      selectedTable = table;
      return queryChain;
    },
    innerJoin: () => queryChain,
  };

  return {
    db: {
      select: () => queryChain,
    },
    schema,
  };
});

vi.mock('./checkinService.js', () => ({
  checkinAll: (...args: unknown[]) => allMock(...args),
}));

describe('checkinScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cronStopMock.mockReset();
    scheduleMock.mockClear();
    validateMock.mockClear();
    allMock.mockReset();
    dbRowsMock.mockReset();
    dbRowsMock.mockReturnValue([]);
    dbCheckinLogsRowsMock.mockReset();
    dbCheckinLogsRowsMock.mockReturnValue([]);
  });

  afterEach(async () => {
    const scheduler = await import('./checkinScheduler.js');
    scheduler.__resetCheckinSchedulerForTests();
    vi.useRealTimers();
  });

  it('switches from cron mode to interval mode and back', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '0 8 * * *',
      intervalHours: 6,
    });
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'interval',
      intervalHours: 6,
    });
    expect(cronStopMock).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '5 9 * * *',
      intervalHours: 6,
    });
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledTimes(2);
  });

  it('switches into random-window mode without registering a cron task', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    setIntervalSpy.mockClear();
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateCheckinSchedule({
      mode: 'random',
      cronExpr: '0 8 * * *',
      intervalHours: 6,
    });

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('selects due accounts from the last successful checkin time', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date('2026-03-20T12:00:00.000Z');

    expect(scheduler.selectDueIntervalCheckinAccountIds([
      { id: 1, lastCheckinAt: null },
      { id: 2, lastCheckinAt: '2026-03-20T05:59:59.000Z' },
      { id: 3, lastCheckinAt: '2026-03-20T06:30:00.000Z' },
    ], 6, now)).toEqual([1, 2]);
  });

  it('creates random checkin times inside the 08:00-22:30 local window', async () => {
    const scheduler = await import('./checkinScheduler.js');

    const earliest = scheduler.createRandomWindowCheckinRunAt(
      new Date(2026, 2, 20, 7, 15, 0, 0),
      () => 0,
    );
    expect(earliest.getHours()).toBe(8);
    expect(earliest.getMinutes()).toBe(0);

    const latest = scheduler.createRandomWindowCheckinRunAt(
      new Date(2026, 2, 20, 7, 15, 0, 0),
      () => 0.999999,
    );
    expect(latest.getHours()).toBe(22);
    expect(latest.getMinutes()).toBe(30);

    const tomorrow = scheduler.createRandomWindowCheckinRunAt(
      new Date(2026, 2, 20, 22, 31, 0, 0),
      () => 0,
    );
    expect(tomorrow.getDate()).toBe(21);
    expect(tomorrow.getHours()).toBe(8);
    expect(tomorrow.getMinutes()).toBe(0);
  });

  it('selects due random-window accounts and skips accounts checked in today', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date(2026, 2, 20, 10, 0, 0, 0);
    const scheduleState = new Map<number, { dateKey: string; runAtMs: number }>();

    const due = scheduler.selectDueRandomWindowCheckinAccountIds([
      { id: 1, lastCheckinAt: null },
      { id: 2, lastCheckinAt: '2026-03-20T09:00:00' },
    ], now, scheduleState, () => 0);

    expect(due).toEqual([1]);
  });

  it('does not duplicate a random-window checkin while the account is in flight', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date(2026, 2, 20, 22, 30, 0, 0);
    dbRowsMock.mockReturnValue([
      {
        accounts: {
          id: 1,
          siteId: 1,
          checkinEnabled: true,
          status: 'active',
          lastCheckinAt: null,
        },
        sites: { id: 1, status: 'active' },
      },
    ]);

    let resolveCheckin: (value: unknown[]) => void = () => {};
    allMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCheckin = resolve;
    }));

    const firstPass = scheduler.__runRandomWindowCheckinPassForTests(now);
    await Promise.resolve();
    await scheduler.__runRandomWindowCheckinPassForTests(now);

    expect(allMock).toHaveBeenCalledTimes(1);
    resolveCheckin([{ accountId: 1, result: { success: true } }]);
    await firstPass;

    await scheduler.__runRandomWindowCheckinPassForTests(now);
    expect(allMock).toHaveBeenCalledTimes(1);
  });

  it('retries a random-window account after checkinAll throws instead of advancing it to tomorrow', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date(2026, 2, 20, 22, 30, 0, 0);
    dbRowsMock.mockReturnValue([
      {
        accounts: {
          id: 2,
          siteId: 1,
          checkinEnabled: true,
          status: 'active',
          lastCheckinAt: null,
        },
        sites: { id: 1, status: 'active' },
      },
    ]);

    allMock
      .mockRejectedValueOnce(new Error('upstream unavailable'))
      .mockResolvedValueOnce([{ accountId: 2, result: { success: true } }]);

    await scheduler.__runRandomWindowCheckinPassForTests(now);
    await scheduler.__runRandomWindowCheckinPassForTests(now);

    expect(allMock).toHaveBeenCalledTimes(2);
  });

  it('defers random-window auto recovery until the next day when the account failed today', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const today = new Date(2026, 2, 20, 22, 30, 0, 0);
    const tomorrow = new Date(2026, 2, 21, 22, 30, 0, 0);
    dbRowsMock.mockReturnValue([
      {
        accounts: {
          id: 3,
          siteId: 1,
          checkinEnabled: true,
          status: 'active',
          lastCheckinAt: null,
        },
        sites: { id: 1, status: 'active' },
      },
    ]);
    dbCheckinLogsRowsMock.mockReturnValueOnce([
      { checkin_logs: { accountId: 3 } },
    ]);

    await scheduler.__runRandomWindowCheckinPassForTests(today);
    expect(allMock).not.toHaveBeenCalled();

    dbCheckinLogsRowsMock.mockReturnValue([]);
    allMock.mockResolvedValueOnce([{ accountId: 3, result: { success: true } }]);
    await scheduler.__runRandomWindowCheckinPassForTests(tomorrow);
    expect(allMock).toHaveBeenCalledTimes(1);
  });
});
