import { classifyFailureReason } from './failureReasonService.js';

const ACCOUNT_HEALTH_REFRESH_TIMEOUT_MS = 10_000;
const ACCOUNT_HEALTH_REFRESH_MAX_RETRIES = 1;
const ACCOUNT_HEALTH_REFRESH_RETRY_DELAY_MS = 200;

export class AccountHealthRefreshTimeoutError extends Error {
  constructor() {
    super(timeoutMessage());
    this.name = 'AccountHealthRefreshTimeoutError';
  }
}

export function isAccountHealthRefreshTimeoutError(
  error: unknown,
): error is AccountHealthRefreshTimeoutError {
  return error instanceof AccountHealthRefreshTimeoutError;
}

function isTransientAccountHealthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  const failure = classifyFailureReason({ message });
  return failure.category === 'network' || failure.code === 'upstream_error';
}

function timeoutMessage(): string {
  return `站点健康检查超时（${Math.max(1, Math.round(ACCOUNT_HEALTH_REFRESH_TIMEOUT_MS / 1000))}s）`;
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const controller = new AbortController();
  const timeoutError = new AccountHealthRefreshTimeoutError();
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runAccountHealthRefreshWithRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadlineAt = Date.now() + ACCOUNT_HEALTH_REFRESH_TIMEOUT_MS;

  for (let attempt = 0; attempt <= ACCOUNT_HEALTH_REFRESH_MAX_RETRIES; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new AccountHealthRefreshTimeoutError();

    try {
      return await withTimeout(operation, remainingMs);
    } catch (error) {
      if (
        attempt >= ACCOUNT_HEALTH_REFRESH_MAX_RETRIES
        || !isTransientAccountHealthError(error)
      ) {
        throw error;
      }

      const retryDelayMs = Math.min(
        ACCOUNT_HEALTH_REFRESH_RETRY_DELAY_MS,
        Math.max(0, deadlineAt - Date.now() - 1),
      );
      if (retryDelayMs <= 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new AccountHealthRefreshTimeoutError();
}
