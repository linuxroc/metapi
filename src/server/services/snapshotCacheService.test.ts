import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSnapshotCache,
  readSnapshotCache,
  type PersistedSnapshotRecord,
} from "./snapshotCacheService.js";

describe("snapshotCacheService", () => {
  let previousVitestEnv: string | undefined;

  beforeEach(() => {
    previousVitestEnv = process.env.VITEST;
    delete process.env.VITEST;
    clearSnapshotCache();
  });

  afterEach(() => {
    if (previousVitestEnv === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = previousVitestEnv;
    }
  });

  it("degrades persistence read and write failures without breaking the read path", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await readSnapshotCache({
      namespace: "test",
      key: "persistence-failure",
      ttlMs: 1000,
      loader: async () => ({ ok: true }),
      persistence: {
        read: async () => {
          throw new Error("read failed");
        },
        write: async () => {
          throw new Error("write failed");
        },
      },
    });

    expect(result.payload).toEqual({ ok: true });
    expect(result.cacheStatus).toBe("miss");
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("reuses an in-flight loader after async hydration misses", async () => {
    let loaderCalls = 0;
    const persistenceRead = vi.fn(async (): Promise<PersistedSnapshotRecord<number> | null> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return null;
    });

    const [left, right] = await Promise.all([
      readSnapshotCache({
        namespace: "test",
        key: "coalesce",
        ttlMs: 1000,
        loader: async () => {
          loaderCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return 42;
        },
        persistence: {
          read: persistenceRead,
          write: async () => {},
        },
      }),
      readSnapshotCache({
        namespace: "test",
        key: "coalesce",
        ttlMs: 1000,
        loader: async () => {
          loaderCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return 42;
        },
        persistence: {
          read: persistenceRead,
          write: async () => {},
        },
      }),
    ]);

    expect(left.payload).toBe(42);
    expect(right.payload).toBe(42);
    expect(loaderCalls).toBe(1);
  });

  it("does not repopulate an invalidated cache from an older in-flight loader", async () => {
    let resolveFirstLoader: ((value: number) => void) | null = null;
    const firstLoader = new Promise<number>((resolve) => {
      resolveFirstLoader = resolve;
    });

    const firstRead = readSnapshotCache({
      namespace: "accounts-snapshot",
      key: "all",
      ttlMs: 1000,
      loader: () => firstLoader,
    });

    await Promise.resolve();
    clearSnapshotCache("accounts-snapshot");
    resolveFirstLoader?.(1);
    expect((await firstRead).payload).toBe(1);

    const secondLoader = vi.fn(async () => 2);
    const secondRead = await readSnapshotCache({
      namespace: "accounts-snapshot",
      key: "all",
      ttlMs: 1000,
      loader: secondLoader,
    });

    expect(secondRead.payload).toBe(2);
    expect(secondLoader).toHaveBeenCalledTimes(1);
  });

  it("deletes an older persisted write that finishes after invalidation", async () => {
    let resolveWrite: (() => void) | null = null;
    const writeStarted = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    let finishWrite: (() => void) | null = null;
    const writeFinished = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const deletePersisted = vi.fn(async () => {});

    const read = readSnapshotCache({
      namespace: "accounts-snapshot",
      key: "all",
      ttlMs: 1000,
      loader: async () => 1,
      persistence: {
        read: async () => null,
        write: async () => {
          resolveWrite?.();
          await writeFinished;
        },
        delete: deletePersisted,
      },
    });

    await writeStarted;
    clearSnapshotCache("accounts-snapshot");
    finishWrite?.();
    await read;

    expect(deletePersisted).toHaveBeenCalledTimes(1);
    expect(deletePersisted).toHaveBeenCalledWith(expect.objectContaining({
      payload: 1,
    }));
  });

  it("keeps in-flight loads isolated across snapshot namespaces", async () => {
    let resolveAccounts: ((value: number) => void) | null = null;
    const accountsLoader = new Promise<number>((resolve) => {
      resolveAccounts = resolve;
    });

    const accountsRead = readSnapshotCache({
      namespace: "accounts-snapshot",
      key: "all",
      ttlMs: 1000,
      loader: () => accountsLoader,
    });

    await Promise.resolve();
    clearSnapshotCache("dashboard-summary");
    resolveAccounts?.(7);
    await accountsRead;

    const cached = await readSnapshotCache({
      namespace: "accounts-snapshot",
      key: "all",
      ttlMs: 1000,
      loader: async () => 8,
    });
    expect(cached.payload).toBe(7);
    expect(cached.cacheStatus).toBe("hit");
  });
});
