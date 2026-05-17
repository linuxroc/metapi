import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit } from '../../services/siteProxy.js';
import type { SiteProxyConfigLike } from '../../services/siteProxy.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import type { DownstreamRoutingPolicy } from '../../services/downstreamPolicyTypes.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { composeProxyLogMessage } from '../../services/proxyLogMessage.js';
import { resolveProxyLogBilling } from '../../services/proxyBilling.js';
import type { DownstreamClientContext } from '../downstreamClientContext.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import { dispatchRuntimeRequest } from '../../services/runtimeDispatch.js';
import type { BuiltEndpointRequest } from '../orchestration/endpointFlow.js';
import { buildUpstreamUrl } from '../orchestration/upstreamRequest.js';
import { recordOauthQuotaHeadersSnapshot, recordOauthQuotaResetHint } from '../../services/oauth/quota.js';
import { refreshOauthAccessTokenSingleflight } from '../../services/oauth/refreshSingleflight.js';
import { proxyChannelCoordinator } from '../../services/proxyChannelCoordinator.js';
import { readRuntimeResponseText } from '../executors/types.js';
import { selectProxyChannelForAttempt } from '../channelSelection.js';
import { extractOpenAiResponsesSessionId } from '../../transformers/openai/responses/sessionId.js';
import { extractResponsesTerminalResponseId } from '../../transformers/openai/responses/continuation.js';
import {
  extractAnthropicMessagesSessionId,
  extractAnthropicMessagesContinuationIdsFromResponse,
} from '../../transformers/anthropic/messages/sessionId.js';
import { config } from '../../config.js';

type SelectedChannel = Awaited<ReturnType<typeof tokenRouter.selectChannel>>;
type SurfaceWarningScope = 'chat' | 'responses';

type SurfaceSelectedChannel = {
  channel: { routeId: number | null; id: number };
  account: { id: number; username?: string | null };
  site: { name?: string | null };
  actualModel?: string | null;
};

type SurfaceFailureResponse = {
  action: 'respond';
  status: number;
  payload: {
    error: {
      message: string;
      type: 'upstream_error';
    };
  };
};

type SurfaceFailureOutcome =
  | { action: 'retry' }
  | SurfaceFailureResponse;

type SurfaceOauthRefreshSelectedChannel = {
  account: {
    id: number;
    accessToken?: string | null;
    extraConfig?: string | null;
  };
  tokenValue: string;
};

type SurfaceOauthRefreshContext<TRequest extends BuiltEndpointRequest> = {
  request: TRequest;
  response: Awaited<ReturnType<typeof dispatchRuntimeRequest>>;
  rawErrText: string;
};

type SurfaceSuccessSelectedChannel = SurfaceSelectedChannel & {
  account: Record<string, unknown> & {
    id: number;
    username?: string | null;
    accessToken?: string | null;
    apiToken?: string | null;
    extraConfig?: string | null;
    platformUserId?: number | null;
  };
  site: Record<string, unknown> & {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
    useSystemProxy?: boolean | null;
    proxyUrl?: string | null;
    name?: string | null;
  };
  tokenValue: string;
  tokenName?: string | null;
};

type SurfaceUsageSummary = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  promptTokensIncludeCache: boolean | null;
};

type SurfaceResolvedUsageSummary = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  recoveredFromSelfLog: boolean;
  estimatedCostFromQuota: number;
  selfLogBillingMeta: import('../../services/proxyUsageFallbackService.js').SelfLogBillingMeta | null;
  usageSource: 'upstream' | 'self-log' | 'unknown';
};

/**
 * Sentinel placed in the `keyIdSlot` of a Protocol_Session_Key when the
 * caller cannot be associated with a concrete `downstream_api_keys.id`
 * (anonymous request, missing key, non-positive id, or non-integer id).
 *
 * Intentionally distinct from the legacy CLI-level coordinator's
 * `'key:anonymous'` placeholder so that the two key namespaces remain
 * non-overlapping; combined with the `proto-v1|` prefix used by
 * {@link buildProtocolSessionKey}, collisions across the two stores are
 * structurally impossible.
 *
 * Part of the session-stick-routing feature; see Requirement 3.3.
 */
export const ANON_DOWNSTREAM_API_KEY_SENTINEL = 'key:anon';

/**
 * Input shape for {@link buildProtocolSessionKey}.
 *
 * Caller contract:
 * - `continuationId` MUST already be trimmed and non-empty. The composing
 *   function will trim again defensively but does not re-validate emptiness;
 *   the upstream check belongs in `buildSurfaceStickySessionKey` which feeds
 *   this helper only after the protocol-level extractor returned a non-null
 *   string.
 * - `downstreamApiKeyId` may be `null` / `undefined` / `0` / negative /
 *   non-integer / `NaN`; any of those routes the slot to
 *   {@link ANON_DOWNSTREAM_API_KEY_SENTINEL}.
 */
export type ProtocolSessionKeyInput = {
  downstreamApiKeyId: number | null | undefined;
  downstreamPath: string;
  requestedModel: string;
  protocolId: 'openai/responses' | 'anthropic/messages';
  continuationId: string;
};

/**
 * Compose a Protocol_Session_Key string for the session-stick-routing feature.
 *
 * This is the single, scope-aware assembler that turns a protocol-level
 * continuation identifier (extracted upstream by a transformer-pure helper)
 * plus the request scope tuple into the Map key consumed by
 * `proxyChannelCoordinator`'s sticky bindings.
 *
 * Encoding format:
 * ```
 * proto-v1|{keyIdSlot}|{path}|{model}|{protocolId}|{continuationId}
 * ```
 * - `keyIdSlot`: `key:${id}` when `downstreamApiKeyId` is a positive integer,
 *   otherwise {@link ANON_DOWNSTREAM_API_KEY_SENTINEL}.
 * - `path`: trimmed `downstreamPath`, or `/` when empty.
 * - `model`: trimmed `requestedModel`, or `_` when empty.
 * - `continuationId`: trimmed continuation identifier (caller guarantees
 *   non-empty after trim).
 *
 * The `proto-v1|` prefix carves out a stable namespace that cannot collide
 * with the legacy CLI-level `proxyChannelCoordinator.buildStickySessionKey`
 * output (which uses `key:` / `key:anonymous` without the version prefix).
 *
 * Intended caller: {@link buildSurfaceStickySessionKey} only. Surface files
 * MUST go through `buildSurfaceStickySessionKey` rather than calling this
 * helper directly so that the protocol-level vs CLI-level priority order
 * stays centralized in one place.
 *
 * @see Requirements 3.1, 3.2, 3.3, 9.3
 */
export function buildProtocolSessionKey(input: ProtocolSessionKeyInput): string {
  const rawKeyId = input.downstreamApiKeyId;
  const keyIdSlot = typeof rawKeyId === 'number'
    && Number.isFinite(rawKeyId)
    && Number.isInteger(rawKeyId)
    && rawKeyId > 0
    ? `key:${rawKeyId}`
    : ANON_DOWNSTREAM_API_KEY_SENTINEL;
  const trimmedPath = (input.downstreamPath || '').trim();
  const path = trimmedPath.length > 0 ? trimmedPath : '/';
  const trimmedModel = (input.requestedModel || '').trim();
  const model = trimmedModel.length > 0 ? trimmedModel : '_';
  const cont = input.continuationId.trim();
  return `proto-v1|${keyIdSlot}|${path}|${model}|${input.protocolId}|${cont}`;
}

export async function selectSurfaceChannelForAttempt(input: {
  requestedModel: string;
  downstreamPolicy: DownstreamRoutingPolicy;
  excludeChannelIds: number[];
  retryCount: number;
  stickySessionKey?: string | null;
  forcedChannelId?: number | null;
}): Promise<SelectedChannel> {
  return await selectProxyChannelForAttempt(input);
}

/**
 * Compose the sticky session key for a surface request.
 *
 * The function defines the **single, centralized priority order** between the
 * protocol-level continuation key (introduced by the session-stick-routing
 * feature) and the legacy CLI-level `clientContext.sessionId` key:
 *
 * 1. **Protocol-level path (preferred).** When the caller passes both
 *    `parsedBody` (any value, including `null`) and a truthy `protocolHint`,
 *    this function dispatches to the matching transformer-pure extractor
 *    (`extractOpenAiResponsesSessionId` for `'openai/responses'`,
 *    `extractAnthropicMessagesSessionId` for `'anthropic/messages'`). When the
 *    extractor returns a non-null continuation identifier, the result of
 *    {@link buildProtocolSessionKey} is returned (a string starting with
 *    `proto-v1|...`).
 *
 * 2. **CLI-level fallback (legacy).** When the protocol-level path is not
 *    available — that is, the caller did not pass `parsedBody` /
 *    `protocolHint`, the `protocolHint` is falsy, the extractor returned
 *    `null`, **or** the `buildProtocolSessionKey` call threw unexpectedly —
 *    this function falls back to `proxyChannelCoordinator.buildStickySessionKey`
 *    with the same inputs as before the feature was introduced. The return
 *    value is byte-equivalent to the pre-feature behavior in this branch.
 *
 * Behavioural guarantees:
 * - When the caller does **not** pass `parsedBody` or `protocolHint` (the
 *   shape used by OpenAI Chat Completions and Gemini surfaces), the return
 *   value is byte-equivalent to the pre-feature behavior.
 * - The protocol-level branch never propagates an exception to the caller;
 *   any unexpected throw from the extractors or `buildProtocolSessionKey` is
 *   silently swallowed (no `console.warn` / `console.error`) and the function
 *   degrades to the CLI-level fallback (Requirement 1.5).
 *
 * @see Requirements 1.5, 5.1, 5.2, 5.3, 5.4
 */
export function buildSurfaceStickySessionKey(input: {
  clientContext?: DownstreamClientContext | null;
  requestedModel: string;
  downstreamPath: string;
  downstreamApiKeyId?: number | null;
  /**
   * Already-parsed downstream request body. Only inspected when paired with a
   * truthy `protocolHint`. When undefined (the legacy call shape), the
   * function skips the protocol-level path entirely and degrades to CLI-level
   * behavior.
   */
  parsedBody?: unknown;
  /**
   * Identifier of the downstream protocol whose extractor should be invoked
   * to derive a continuation identifier. When `null` / `undefined` / empty
   * the function skips the protocol-level path entirely and degrades to
   * CLI-level behavior.
   */
  protocolHint?: 'openai/responses' | 'anthropic/messages' | null;
}): string | null {
  // Step 1 — Protocol-level priority.
  // The protocol-level path is opt-in: callers that don't pass both
  // `parsedBody` and a truthy `protocolHint` keep the legacy behavior.
  //
  // P2 fix (spec session-stick-routing-binding-timing-fix): the protocol-level
  // branch must respect the `proxyStickySessionEnabled` global switch, matching
  // the CLI-level `proxyChannelCoordinator.buildStickySessionKey` semantics.
  // When the switch is off both paths return null so no `proto-v1|...` key
  // can leak into `acquireSurfaceChannelLease`'s per-channel lease pool and
  // lock session-scoped accounts against the user's intent.
  if (
    config.proxyStickySessionEnabled
    && input.parsedBody !== undefined
    && input.protocolHint
  ) {
    let continuationId: string | null = null;
    if (input.protocolHint === 'openai/responses') {
      continuationId = extractOpenAiResponsesSessionId(input.parsedBody);
    } else if (input.protocolHint === 'anthropic/messages') {
      continuationId = extractAnthropicMessagesSessionId(input.parsedBody);
    }

    if (continuationId !== null) {
      try {
        return buildProtocolSessionKey({
          downstreamApiKeyId: input.downstreamApiKeyId,
          downstreamPath: input.downstreamPath,
          requestedModel: input.requestedModel,
          protocolId: input.protocolHint,
          continuationId,
        });
      } catch {
        // Requirement 1.5: never let a protocol-level composition failure
        // reject the request. Silently fall through to the CLI-level path
        // below; do not log here because this branch is a defensive fallback,
        // not a user-actionable error condition.
      }
    }
  }

  // Step 2 — CLI-level fallback (byte-equivalent to pre-feature behavior).
  return proxyChannelCoordinator.buildStickySessionKey({
    clientKind: input.clientContext?.clientKind || null,
    sessionId: input.clientContext?.sessionId || null,
    requestedModel: input.requestedModel,
    downstreamPath: input.downstreamPath,
    downstreamApiKeyId: input.downstreamApiKeyId,
  });
}

export function getSurfaceStickyPreferredChannelId(stickySessionKey?: string | null): number | null {
  if (!stickySessionKey) return null;
  return proxyChannelCoordinator.getStickyChannelId(stickySessionKey) ?? null;
}

export function bindSurfaceStickyChannel(input: {
  stickySessionKey?: string | null;
  selected: {
    channel: { id: number };
    account?: { extraConfig?: string | null; oauthProvider?: string | null } | null;
  };
}): void {
  proxyChannelCoordinator.bindStickyChannel(
    input.stickySessionKey,
    input.selected.channel.id,
    input.selected.account || undefined,
  );
}

/**
 * Input shape for {@link bindSurfaceStickyChannelFromResponse}.
 *
 * The "from response" binding is the P1 fix of spec
 * session-stick-routing-binding-timing-fix: rather than binding the
 * request-side sticky session key (which is *the previous round's*
 * response continuation ID—too late for the current round to be useful),
 * this API extracts the **current round's** newly-produced continuation
 * ID from the upstream response payload and uses it as the binding key.
 *
 * Caller contract:
 * - `requestSideStickySessionKey` is the value returned earlier by
 *   `buildSurfaceStickySessionKey`, used here only as a read-only signal
 *   for diagnostics — it is NOT used as a guard. Round 1 of a fresh
 *   conversation has no request-side continuation (`previous_response_id`
 *   / `tool_result.tool_use_id` are absent), so the request-side key is
 *   either `null` or a CLI-level fallback. In both cases the response
 *   carries the ID round 2 will use, so this function still binds. The
 *   protocol-level write coexists with whatever {@link bindSurfaceStickyChannel}
 *   wrote for the CLI-level key — they target distinct keyspaces and
 *   never collide.
 * - `responsePayload` should be the aggregated/parsed upstream response
 *   for the current round. Both the OpenAI Responses extractor
 *   (`extractResponsesTerminalResponseId`) and the new Anthropic Messages
 *   extractor (`extractAnthropicMessagesContinuationIdsFromResponse`)
 *   tolerate every shape the surface might forward (raw JSON terminal,
 *   aggregated SSE final payload, NormalizedFinalResponse).
 * - `scope` mirrors the request-side scope tuple. The composed write key
 *   reuses {@link buildProtocolSessionKey} so the bytewise format is
 *   identical to the request-side query key for the next round.
 * - `selected` is the channel actually serving this request to terminal
 *   success. On retries that switched channels, this is the new channel,
 *   so the bind correctly overwrites any stale binding.
 */
export type SurfaceBindFromResponseInput = {
  requestSideStickySessionKey?: string | null;
  protocolHint: 'openai/responses' | 'anthropic/messages';
  responsePayload: unknown;
  scope: {
    downstreamApiKeyId?: number | null;
    downstreamPath: string;
    requestedModel: string;
  };
  selected: {
    channel: { id: number };
    account?: { extraConfig?: string | null; oauthProvider?: string | null } | null;
  };
};

/**
 * Bind the surface sticky channel using a continuation identifier extracted
 * from the **response** payload (P1 fix of spec
 * session-stick-routing-binding-timing-fix).
 *
 * Unlike the legacy {@link bindSurfaceStickyChannel}, which writes whatever
 * key the request-side `buildSurfaceStickySessionKey` produced, this function
 * derives a fresh `proto-v1|...` key from the **current round's** newly
 * generated upstream continuation ID (`response.id` for OpenAI Responses,
 * the last `tool_use.id` in document order for Anthropic Messages). That key
 * matches what the next request will carry as `previous_response_id` /
 * `tool_result.tool_use_id`, so the next round actually hits sticky.
 *
 * Behavioural guarantees:
 * - Returns silently (no-op) when `proxyStickySessionEnabled` is false,
 *   matching the P2 switch semantics enforced in
 *   {@link buildSurfaceStickySessionKey}.
 * - Always attempts the bind regardless of whether
 *   `requestSideStickySessionKey` is `null`, a CLI-level key, or an
 *   already-protocol-level key. The protocol-level write key is always
 *   freshly composed from the response-side extractor output, so it
 *   never collides with the CLI-level key written by
 *   {@link bindSurfaceStickyChannel} (the two go to disjoint keyspaces).
 *   Round 1 of a fresh session — when the request carried no continuation
 *   ID — must still bind because the response produces the ID that
 *   round 2 will use as its `previous_response_id` / `tool_result.tool_use_id`.
 * - Returns silently when the response-side extractor produces no IDs.
 *   Critically does NOT fall back to `requestSideStickySessionKey` as a
 *   write key, because that is the exact bug P1 is fixing.
 * - Never throws into the surface caller; defensive try/catch absorbs any
 *   unexpected extractor or coordinator error.
 *
 * @see spec `session-stick-routing-binding-timing-fix`
 *      bugfix.md Expected 2.1, 2.2, 2.3, 2.4
 *      design.md §2.2
 */
export function bindSurfaceStickyChannelFromResponse(
  input: SurfaceBindFromResponseInput,
): void {
  // 0. P2 switch consistency: short-circuit when sticky is globally off.
  if (!config.proxyStickySessionEnabled) return;

  // 1. The protocol-level write key always uses the response-side ID;
  //    the request-side key is informational only. We deliberately do
  //    NOT early-return on a CLI-level / null request-side key: round 1
  //    of a fresh session has no request-side continuation yet, but the
  //    response carries the ID that round 2 will use to look this binding
  //    up. The CLI-level legacy bind written by `bindSurfaceStickyChannel`
  //    targets a different keyspace and never collides with the
  //    `proto-v1|...` key written here.
  void input.requestSideStickySessionKey;

  try {
    // 2. Dispatch to the matching response-side extractor.
    let continuationIdToBind: string | null = null;
    if (input.protocolHint === 'openai/responses') {
      continuationIdToBind = extractResponsesTerminalResponseId(input.responsePayload);
    } else if (input.protocolHint === 'anthropic/messages') {
      const ids = extractAnthropicMessagesContinuationIdsFromResponse(input.responsePayload);
      // Mirror the request-side "last in document order" rule: the response
      // array's last `tool_use.id` is what the next request will echo back
      // as `tool_result.tool_use_id` for the same turn boundary.
      continuationIdToBind = ids.length > 0 ? ids[ids.length - 1] : null;
    }

    // 3. No usable response-side ID -> do not write. We must NOT fall back
    //    to `requestSideStickySessionKey`; that is precisely the bug P1
    //    fixes (writing the previous round's key as if it were this round's).
    if (continuationIdToBind === null || continuationIdToBind.length === 0) return;

    // 4. Compose the response-side write key and bind via the coordinator.
    const responseSideKey = buildProtocolSessionKey({
      downstreamApiKeyId: input.scope.downstreamApiKeyId,
      downstreamPath: input.scope.downstreamPath,
      requestedModel: input.scope.requestedModel,
      protocolId: input.protocolHint,
      continuationId: continuationIdToBind,
    });

    proxyChannelCoordinator.bindStickyChannel(
      responseSideKey,
      input.selected.channel.id,
      input.selected.account || undefined,
    );
  } catch {
    // Defensive last line of defence: this function promises never to
    // propagate exceptions to the surface caller. The transformer-pure
    // extractors already guard against malformed inputs, so reaching this
    // catch is unexpected; silently swallow and fall through to no-op.
  }
}

/**
 * Clear a surface sticky channel binding.
 *
 * P3 fix (spec session-stick-routing-binding-timing-fix): protocol-level
 * keys (i.e. those starting with `proto-v1|`) MUST NOT be cleared on
 * single-request failure. This honors:
 *   - spec session-stick-routing Requirement 6.4: a single failed attempt
 *     does not clear protocol-level sticky bindings; they remain until TTL
 *     expiry or overwrite by a subsequent successful response (via
 *     {@link bindSurfaceStickyChannelFromResponse}).
 *   - spec session-stick-routing Requirement 8.4 / Property 7: the only
 *     allowed protocol-level clear is via `proxyChannelCoordinator`'s
 *     internal "refresh-failed" branch, never via surface failure paths
 *     (lease timeout, streamFailed, detectProxyFailure, top-level catch).
 *
 * CLI-level keys (those derived from `clientContext.sessionId` by
 * `proxyChannelCoordinator.buildStickySessionKey`) keep the pre-feature
 * clear-on-failure semantics intact: surface code paths that historically
 * cleared the binding to let the next request re-pick still work as before.
 *
 * The function signature is unchanged so that the ~16 call sites scattered
 * across `openAiResponsesSurface.ts` and `chatSurface.ts` need no edits.
 *
 * @see bugfix.md Expected 2.7, 2.8, Unchanged 3.6, 3.14
 *      design.md §2.3
 */
export function clearSurfaceStickyChannel(input: {
  stickySessionKey?: string | null;
  selected: {
    channel: { id: number };
  };
}): void {
  if (!input.stickySessionKey) return;

  // P3 fix: protocol-level keys honor spec session-stick-routing
  // Requirement 6.4 + 8.4 (single-failure does not clear sticky). Wait for
  // either TTL expiry or overwrite by a subsequent successful response.
  if (input.stickySessionKey.startsWith('proto-v1|')) return;

  // CLI-level keys retain pre-feature clear-on-failure semantics.
  proxyChannelCoordinator.clearStickyChannel(
    input.stickySessionKey,
    input.selected.channel.id,
  );
}

export async function acquireSurfaceChannelLease(input: {
  stickySessionKey?: string | null;
  selected: {
    channel: { id: number };
    account?: { extraConfig?: string | null; oauthProvider?: string | null } | null;
  };
}) {
  return await proxyChannelCoordinator.acquireChannelLease({
    // Only session-addressable requests should consume the guarded per-channel
    // lease pool. Requests without a stable downstream session key should keep
    // the pre-sticky-session parallel behavior instead of contending globally.
    channelId: input.stickySessionKey ? input.selected.channel.id : 0,
    accountExtraConfig: input.selected.account?.extraConfig,
    accountOauthProvider: input.selected.account?.oauthProvider,
  });
}

export function buildSurfaceChannelBusyMessage(waitMs: number): string {
  return waitMs > 0
    ? `Channel busy: waited ${waitMs}ms for an available session slot`
    : 'Channel busy: no session slot available';
}

export async function writeSurfaceProxyLog(input: {
  warningScope: string;
  selected: {
    channel: { routeId: number | null; id: number | null };
    account: { id: number | null };
    actualModel?: string | null;
  };
  modelRequested: string;
  status: string;
  httpStatus: number;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  latencyMs: number;
  errorMessage: string | null;
  retryCount: number;
  downstreamPath: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  estimatedCost?: number;
  billingDetails?: unknown;
  upstreamPath?: string | null;
  usageSource?: 'upstream' | 'self-log' | 'unknown' | null;
  clientContext?: DownstreamClientContext | null;
  downstreamApiKeyId?: number | null;
}): Promise<void> {
  try {
    const createdAt = formatUtcSqlDateTime(new Date());
    const normalizedErrorMessage = composeProxyLogMessage({
      clientKind: input.clientContext?.clientKind && input.clientContext.clientKind !== 'generic'
        ? input.clientContext.clientKind
        : null,
      sessionId: input.clientContext?.sessionId || null,
      traceHint: input.clientContext?.traceHint || null,
      downstreamPath: input.downstreamPath,
      upstreamPath: input.upstreamPath || null,
      usageSource: input.usageSource || null,
      errorMessage: input.errorMessage,
    });
    await insertProxyLog({
      routeId: input.selected.channel.routeId,
      channelId: input.selected.channel.id,
      accountId: input.selected.account.id,
      downstreamApiKeyId: input.downstreamApiKeyId ?? null,
      modelRequested: input.modelRequested,
      modelActual: input.selected.actualModel ?? null,
      status: input.status,
      httpStatus: input.httpStatus,
      isStream: input.isStream ?? null,
      firstByteLatencyMs: input.firstByteLatencyMs ?? null,
      latencyMs: input.latencyMs,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      estimatedCost: input.estimatedCost ?? 0,
      billingDetails: input.billingDetails ?? null,
      clientFamily: input.clientContext?.clientKind || null,
      clientAppId: input.clientContext?.clientAppId || null,
      clientAppName: input.clientContext?.clientAppName || null,
      clientConfidence: input.clientContext?.clientConfidence || null,
      errorMessage: normalizedErrorMessage,
      retryCount: input.retryCount,
      createdAt,
    });
  } catch (error) {
    console.warn(`[proxy/${input.warningScope}] failed to write proxy log`, error);
  }
}

export function createSurfaceDispatchRequest(input: {
  site: SiteProxyConfigLike & { url: string };
  accountExtraConfig?: string | null;
  siteUrl?: string;
}) {
  const channelProxyUrl = resolveChannelProxyUrl(input.site, input.accountExtraConfig);
  return (
    request: BuiltEndpointRequest,
    targetUrl?: string,
    signal?: AbortSignal,
  ) => (
    dispatchRuntimeRequest({
      siteUrl: input.siteUrl ?? input.site.url,
      targetUrl,
      signal,
      request,
      buildInit: (_requestUrl, requestForFetch) => withSiteRecordProxyRequestInit(input.site, {
        method: 'POST',
        headers: requestForFetch.headers,
        body: JSON.stringify(requestForFetch.body),
      }, channelProxyUrl),
    })
  );
}

export async function trySurfaceOauthRefreshRecovery<TRequest extends BuiltEndpointRequest>(input: {
  ctx: SurfaceOauthRefreshContext<TRequest>;
  selected: SurfaceOauthRefreshSelectedChannel;
  siteUrl: string;
  buildRequest: (endpoint: TRequest['endpoint']) => TRequest;
  dispatchRequest: (
    request: TRequest,
    targetUrl: string,
  ) => Promise<Awaited<ReturnType<typeof dispatchRuntimeRequest>>>;
  captureFailureBody?: boolean;
}): Promise<{
  upstream: Awaited<ReturnType<typeof dispatchRuntimeRequest>>;
  upstreamPath: string;
  request?: TRequest;
  targetUrl?: string;
} | null> {
  try {
    const refreshed = await refreshOauthAccessTokenSingleflight(input.selected.account.id);
    input.selected.tokenValue = refreshed.accessToken;
    input.selected.account = {
      ...input.selected.account,
      accessToken: refreshed.accessToken,
      extraConfig: refreshed.extraConfig ?? input.selected.account.extraConfig,
    };

    const refreshedRequest = input.buildRequest(input.ctx.request.endpoint);
    const refreshedTargetUrl = buildUpstreamUrl(input.siteUrl, refreshedRequest.path);
    const refreshedResponse = await input.dispatchRequest(refreshedRequest, refreshedTargetUrl);
    if (refreshedResponse.ok) {
      return {
        upstream: refreshedResponse,
        upstreamPath: refreshedRequest.path,
        request: refreshedRequest,
        targetUrl: refreshedTargetUrl,
      };
    }

    input.ctx.request = refreshedRequest;
    input.ctx.response = refreshedResponse;
    if (input.captureFailureBody !== false) {
      const failureBody = await readRuntimeResponseText(refreshedResponse).catch(() => '');
      input.ctx.rawErrText = failureBody.trim() || 'unknown error';
    }
  } catch {
    return null;
  }

  return null;
}

export async function recordSurfaceSuccess(input: {
  selected: SurfaceSuccessSelectedChannel;
  requestedModel: string;
  modelName: string;
  parsedUsage: SurfaceUsageSummary;
  upstreamUsagePresent?: boolean;
  upstreamHeaders?: { get(name: string): string | null } | null;
  requestStartedAtMs: number;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  latencyMs: number;
  retryCount: number;
  upstreamPath?: string | null;
  logSuccess: (args: {
    selected: SurfaceSelectedChannel;
    modelRequested: string;
    status: string;
    httpStatus: number;
    isStream?: boolean | null;
    firstByteLatencyMs?: number | null;
    latencyMs: number;
    errorMessage: string | null;
    retryCount: number;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    usageSource?: 'upstream' | 'self-log' | 'unknown';
    estimatedCost?: number;
    billingDetails?: unknown;
    upstreamPath?: string | null;
  }) => Promise<void>;
  recordDownstreamCost?: (estimatedCost: number) => void;
  bestEffortMetrics?: {
    errorLabel: string;
  };
}): Promise<{
  resolvedUsage: SurfaceResolvedUsageSummary;
  estimatedCost: number;
  billingDetails: unknown;
}> {
  const hasUpstreamUsage = input.upstreamUsagePresent ?? (
    input.parsedUsage.totalTokens > 0
    || input.parsedUsage.promptTokens > 0
    || input.parsedUsage.completionTokens > 0
  );
  let resolvedUsage: SurfaceResolvedUsageSummary = {
    promptTokens: input.parsedUsage.promptTokens,
    completionTokens: input.parsedUsage.completionTokens,
    totalTokens: input.parsedUsage.totalTokens,
    recoveredFromSelfLog: false,
    estimatedCostFromQuota: 0,
    selfLogBillingMeta: null,
    usageSource: hasUpstreamUsage ? 'upstream' : 'unknown',
  };
  let estimatedCost = 0;
  let billingDetails: unknown = null;

  try {
    resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
      site: input.selected.site,
      account: input.selected.account,
      tokenValue: input.selected.tokenValue,
      tokenName: input.selected.tokenName,
      modelName: input.modelName,
      requestStartedAtMs: input.requestStartedAtMs,
      requestEndedAtMs: input.requestStartedAtMs + input.latencyMs,
      localLatencyMs: input.latencyMs,
      upstreamUsagePresent: hasUpstreamUsage,
      usage: {
        promptTokens: input.parsedUsage.promptTokens,
        completionTokens: input.parsedUsage.completionTokens,
        totalTokens: input.parsedUsage.totalTokens,
      },
    });
    const billing = await resolveProxyLogBilling({
      site: input.selected.site,
      account: input.selected.account,
      modelName: input.modelName,
      parsedUsage: input.parsedUsage,
      resolvedUsage,
    });
    estimatedCost = billing.estimatedCost;
    billingDetails = billing.billingDetails;
  } catch (error) {
    if (!input.bestEffortMetrics) {
      throw error;
    }
    console.error(input.bestEffortMetrics.errorLabel, error);
  }

  tokenRouter.recordSuccess(
    input.selected.channel.id,
    input.latencyMs,
    estimatedCost,
    input.modelName,
  );
  input.recordDownstreamCost?.(estimatedCost);
  const logTokens = resolvedUsage.usageSource === 'unknown'
    ? {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    }
    : {
      promptTokens: resolvedUsage.promptTokens,
      completionTokens: resolvedUsage.completionTokens,
      totalTokens: resolvedUsage.totalTokens,
    };
  await input.logSuccess({
    selected: input.selected,
    modelRequested: input.requestedModel,
    status: 'success',
    httpStatus: 200,
    isStream: input.isStream ?? null,
    firstByteLatencyMs: input.firstByteLatencyMs ?? null,
    latencyMs: input.latencyMs,
    errorMessage: null,
    retryCount: input.retryCount,
    promptTokens: logTokens.promptTokens,
    completionTokens: logTokens.completionTokens,
    totalTokens: logTokens.totalTokens,
    usageSource: resolvedUsage.usageSource,
    estimatedCost,
    billingDetails,
    upstreamPath: input.upstreamPath,
  });

  if (input.upstreamHeaders) {
    void recordOauthQuotaHeadersSnapshot({
      accountId: input.selected.account.id,
      headers: input.upstreamHeaders,
    }).catch((error) => {
      console.warn('[proxy/shared] failed to record oauth quota headers', error);
    });
  }

  return {
    resolvedUsage,
    estimatedCost,
    billingDetails,
  };
}

export function createSurfaceFailureToolkit(input: {
  warningScope: SurfaceWarningScope;
  downstreamPath: string;
  maxRetries: number;
  clientContext?: DownstreamClientContext | null;
  downstreamApiKeyId?: number | null;
}) {
  const log = async (args: {
    selected: SurfaceSelectedChannel;
    modelRequested: string;
    status: string;
    httpStatus: number;
    isStream?: boolean | null;
    firstByteLatencyMs?: number | null;
    latencyMs: number;
    errorMessage: string | null;
    retryCount: number;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    usageSource?: 'upstream' | 'self-log' | 'unknown';
    estimatedCost?: number;
    billingDetails?: unknown;
    upstreamPath?: string | null;
  }) => {
    await writeSurfaceProxyLog({
      warningScope: input.warningScope,
      selected: args.selected,
      modelRequested: args.modelRequested,
      status: args.status,
      httpStatus: args.httpStatus,
      isStream: args.isStream ?? null,
      firstByteLatencyMs: args.firstByteLatencyMs ?? null,
      latencyMs: args.latencyMs,
      errorMessage: args.errorMessage,
      retryCount: args.retryCount,
      downstreamPath: input.downstreamPath,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      totalTokens: args.totalTokens,
      usageSource: args.usageSource,
      estimatedCost: args.estimatedCost,
      billingDetails: args.billingDetails,
      upstreamPath: args.upstreamPath,
      clientContext: input.clientContext,
      downstreamApiKeyId: input.downstreamApiKeyId,
    });
  };

  const maybeRetry = (retryCount: number) => retryCount < input.maxRetries
    ? { action: 'retry' as const }
    : null;

  const runBestEffort = (label: string, fn: () => Promise<unknown>) => {
    void Promise.resolve()
      .then(fn)
      .catch((error) => {
        console.warn(`[proxy/${input.warningScope}] failed to ${label}`, error);
      });
  };

  return {
    log,
    async handleUpstreamFailure(args: {
      selected: SurfaceSelectedChannel;
      requestedModel: string;
      modelName: string;
      status: number;
      errText: string;
      rawErrText?: string | null;
      isStream?: boolean | null;
      firstByteLatencyMs?: number | null;
      latencyMs: number;
      retryCount: number;
    }): Promise<SurfaceFailureOutcome> {
      const rawErrText = args.rawErrText || args.errText;
      await tokenRouter.recordFailure(args.selected.channel.id, {
        status: args.status,
        errorText: rawErrText,
        modelName: args.modelName,
      });
      await log({
        selected: args.selected,
        modelRequested: args.requestedModel,
        status: 'failed',
        httpStatus: args.status,
        isStream: args.isStream ?? null,
        firstByteLatencyMs: args.firstByteLatencyMs ?? null,
        latencyMs: args.latencyMs,
        errorMessage: args.errText,
        retryCount: args.retryCount,
      });
      runBestEffort('record oauth quota reset hint', () => recordOauthQuotaResetHint({
        accountId: args.selected.account.id,
        statusCode: args.status,
        errorText: rawErrText,
      }));

      if (isTokenExpiredError({ status: args.status, message: args.errText })) {
        runBestEffort('report token expired', () => reportTokenExpired({
          accountId: args.selected.account.id,
          username: args.selected.account.username,
          siteName: args.selected.site.name,
          detail: `HTTP ${args.status}`,
        }));
      }

      if (shouldRetryProxyRequest(args.status, args.errText)) {
        const retry = maybeRetry(args.retryCount);
        if (retry) return retry;
      }

      runBestEffort('report proxy all failed', () => reportProxyAllFailed({
        model: args.requestedModel,
        reason: `upstream returned HTTP ${args.status}`,
      }));

      return {
        action: 'respond',
        status: args.status,
        payload: {
          error: {
            message: args.errText,
            type: 'upstream_error',
          },
        },
      };
    },

    async handleDetectedFailure(args: {
      selected: SurfaceSelectedChannel;
      requestedModel: string;
      modelName: string;
      failure: { status: number; reason: string };
      isStream?: boolean | null;
      firstByteLatencyMs?: number | null;
      latencyMs: number;
      retryCount: number;
      promptTokens?: number | null;
      completionTokens?: number | null;
      totalTokens?: number | null;
      upstreamPath?: string | null;
    }): Promise<SurfaceFailureOutcome> {
      await tokenRouter.recordFailure(args.selected.channel.id, {
        status: args.failure.status,
        errorText: args.failure.reason,
        modelName: args.modelName,
      });
      await log({
        selected: args.selected,
        modelRequested: args.requestedModel,
        status: 'failed',
        httpStatus: args.failure.status,
        isStream: args.isStream ?? null,
        firstByteLatencyMs: args.firstByteLatencyMs ?? null,
        latencyMs: args.latencyMs,
        errorMessage: args.failure.reason,
        retryCount: args.retryCount,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        totalTokens: args.totalTokens,
        upstreamPath: args.upstreamPath,
      });

      if (shouldRetryProxyRequest(args.failure.status, args.failure.reason)) {
        const retry = maybeRetry(args.retryCount);
        if (retry) return retry;
      }

      runBestEffort('report proxy all failed', () => reportProxyAllFailed({
        model: args.requestedModel,
        reason: args.failure.reason,
      }));

      return {
        action: 'respond',
        status: args.failure.status,
        payload: {
          error: {
            message: args.failure.reason,
            type: 'upstream_error',
          },
        },
      };
    },

    async handleExecutionError(args: {
      selected: SurfaceSelectedChannel;
      requestedModel: string;
      modelName: string;
      errorMessage: string;
      isStream?: boolean | null;
      firstByteLatencyMs?: number | null;
      latencyMs: number;
      retryCount: number;
    }): Promise<SurfaceFailureOutcome> {
      await tokenRouter.recordFailure(args.selected.channel.id, {
        errorText: args.errorMessage,
        modelName: args.modelName,
      });
      await log({
        selected: args.selected,
        modelRequested: args.requestedModel,
        status: 'failed',
        httpStatus: 0,
        isStream: args.isStream ?? null,
        firstByteLatencyMs: args.firstByteLatencyMs ?? null,
        latencyMs: args.latencyMs,
        errorMessage: args.errorMessage,
        retryCount: args.retryCount,
      });

      const retry = maybeRetry(args.retryCount);
      if (retry) return retry;

      runBestEffort('report proxy all failed', () => reportProxyAllFailed({
        model: args.requestedModel,
        reason: args.errorMessage || 'network failure',
      }));

      return {
        action: 'respond',
        status: 502,
        payload: {
          error: {
            message: `Upstream error: ${args.errorMessage || 'network failure'}`,
            type: 'upstream_error',
          },
        },
      };
    },

    async recordStreamFailure(args: {
      selected: SurfaceSelectedChannel;
      requestedModel: string;
      modelName: string;
      errorMessage: string | null;
      isStream?: boolean | null;
      firstByteLatencyMs?: number | null;
      latencyMs: number;
      retryCount: number;
      promptTokens?: number | null;
      completionTokens?: number | null;
      totalTokens?: number | null;
      upstreamPath?: string | null;
      httpStatus?: number;
      runtimeFailureStatus?: number | null;
    }) {
      const errorMessage = args.errorMessage || 'stream processing failed';
      if (typeof args.runtimeFailureStatus === 'number') {
        await tokenRouter.recordFailure(args.selected.channel.id, {
          status: args.runtimeFailureStatus,
          errorText: errorMessage,
          modelName: args.modelName,
        });
      } else {
        await tokenRouter.recordFailure(args.selected.channel.id, {
          errorText: errorMessage,
          modelName: args.modelName,
        });
      }
      await log({
        selected: args.selected,
        modelRequested: args.requestedModel,
        status: 'failed',
        httpStatus: args.httpStatus ?? 200,
        isStream: args.isStream ?? null,
        firstByteLatencyMs: args.firstByteLatencyMs ?? null,
        latencyMs: args.latencyMs,
        errorMessage,
        retryCount: args.retryCount,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        totalTokens: args.totalTokens,
        upstreamPath: args.upstreamPath,
      });
    },
  };
}
