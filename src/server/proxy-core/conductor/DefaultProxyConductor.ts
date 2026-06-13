import {
  failureActionOf,
  isTerminalFailure,
  shouldFailover,
  shouldRefreshAuth,
  shouldRetrySameChannel,
} from './retryPolicy.js';
import type { ExecuteInput, ExecuteResult, ProxyConductorDependencies, SelectedChannelLike } from './types.js';
import { recordFailedAttempt, recordSuccessfulAttempt } from './usageHooks.js';

const DEFAULT_MAX_ATTEMPTS = 32;
const DEFAULT_MAX_SAME_CHANNEL_RETRIES = 1;

function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function normalizeRetryLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

export class DefaultProxyConductor {
  constructor(private readonly deps: ProxyConductorDependencies) {}

  async previewSelectedChannel(requestedModel: string, downstreamPolicy?: unknown): Promise<SelectedChannelLike | null> {
    if (this.deps.previewSelectedChannel) {
      return this.deps.previewSelectedChannel(requestedModel, downstreamPolicy);
    }
    return this.deps.selectChannel(requestedModel, downstreamPolicy);
  }

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const excludeChannelIds: number[] = [];
    const maxAttempts = normalizePositiveLimit(input.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    const maxSameChannelRetries = normalizeRetryLimit(
      input.maxSameChannelRetries,
      DEFAULT_MAX_SAME_CHANNEL_RETRIES,
    );
    let attempts = 0;
    let sameChannelRetries = 0;
    let selected = await this.deps.selectChannel(input.requestedModel, input.downstreamPolicy);
    if (!selected) {
      return {
        ok: false,
        reason: 'no_channel',
        attempts: 0,
      };
    }

    while (selected) {
      const result = await input.attempt({
        selected,
        attemptIndex: attempts,
        excludeChannelIds: [...excludeChannelIds],
      });
      attempts += 1;

      if (result.ok) {
        await recordSuccessfulAttempt(this.deps, selected.channel.id, {
          latencyMs: result.latencyMs ?? null,
          cost: result.cost ?? null,
        });
        return {
          ok: true,
          selected,
          response: result.response,
          attempts,
        };
      }

      const action = failureActionOf(result);
      await recordFailedAttempt(this.deps, selected.channel.id, {
        status: result.status,
        rawErrorText: result.rawErrorText,
      });

      if (isTerminalFailure(action)) {
        await input.onTerminalFailure?.(selected, {
          status: result.status,
          rawErrorText: result.rawErrorText,
        });
        return {
          ok: false,
          reason: 'terminal',
          selected,
          status: result.status,
          rawErrorText: result.rawErrorText,
          attempts,
        };
      }

      if (shouldRetrySameChannel(action)) {
        if (sameChannelRetries < maxSameChannelRetries && attempts < maxAttempts) {
          sameChannelRetries += 1;
          continue;
        }
      }

      if (attempts >= maxAttempts) {
        return {
          ok: false,
          reason: 'failed',
          selected,
          status: result.status,
          rawErrorText: result.rawErrorText,
          attempts,
        };
      }

      if (shouldRefreshAuth(action) && this.deps.refreshAuth) {
        const refreshed = await this.deps.refreshAuth(selected, {
          status: result.status,
          rawErrorText: result.rawErrorText,
        });
        if (refreshed) {
          selected = refreshed;
          continue;
        }
      }

      if (shouldFailover(action) || shouldRetrySameChannel(action)) {
        excludeChannelIds.push(selected.channel.id);
        const next = await this.deps.selectNextChannel(
          input.requestedModel,
          excludeChannelIds,
          input.downstreamPolicy,
        );
        if (!next) {
          return {
            ok: false,
            reason: 'failed',
            selected,
            status: result.status,
            rawErrorText: result.rawErrorText,
            attempts,
          };
        }
        selected = next;
        sameChannelRetries = 0;
        continue;
      }

      return {
        ok: false,
        reason: 'failed',
        selected,
        status: result.status,
        rawErrorText: result.rawErrorText,
        attempts,
      };
    }

    return {
      ok: false,
      reason: 'failed',
      attempts,
    };
  }
}
