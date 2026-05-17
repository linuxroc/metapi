/**
 * End-to-end coordination test for the session-stick-routing feature
 * (after the binding-timing fix).
 *
 * Scope rationale:
 * - `sharedSurface.test.ts` already covers `selectSurfaceChannelForAttempt`
 *   in isolation across every sticky branch (forced > sticky hit > refresh
 *   recovery > sticky miss with stale binding cleanup).
 * - `buildProtocolSessionKey.test.ts` and `buildSurfaceStickySessionKey.test.ts`
 *   already cover protocol-level key composition and the protocol→CLI
 *   fallback dispatcher.
 * - `sessionStick.bugCondition.test.ts` proves P1/P2/P3 bugs existed on the
 *   pre-fix HEAD via deliberately-failing assertions.
 *
 * What this file pins, post-fix, is the **co-operation** between the
 * extractors (request-side and response-side), the `proto-v1|` write/read
 * paths, and the cross-cutting invariants around `forcedChannelId`,
 * `excludeChannelIds`, the failure-preserve contract, the
 * `proxyStickySessionEnabled` switch, and the retry-switch overwrite path
 * (spec session-stick-routing Requirement 6.7).
 *
 * Mock strategy:
 * - The transformer-pure extractors (`extractOpenAiResponsesSessionId`,
 *   `extractAnthropicMessagesSessionId`, `extractResponsesTerminalResponseId`,
 *   `extractAnthropicMessagesContinuationIdsFromResponse`) are intentionally
 *   **not** mocked. Running real protocol parsers against real payload
 *   shapes is the entire point of an integration assertion at this seam.
 * - `selectProxyChannelForAttempt` (in `channelSelection.ts`) is also **not**
 *   mocked, so the real branching logic (forced → sticky → general) executes
 *   end-to-end. Only its dependencies (`tokenRouter`, `proxyChannelCoordinator`,
 *   `routeRefreshWorkflow`) are stubbed.
 * - For Scenarios A / B / H / I we wire `bindStickyChannel` /
 *   `getStickyChannelId` / `clearStickyChannel` against an in-memory `Map`
 *   that mirrors the coordinator's trim-empty-then-set semantics, so two
 *   rounds of the same conversation can verify the post-fix double-key
 *   contract (request-side query key vs response-side write key).
 * - All other proxy-core dependencies pulled in transitively by
 *   `./sharedSurface.js` are mocked to keep module load cheap; their methods
 *   are not exercised here.
 *
 * Surface entry points (Fastify request/reply, runtime dispatch, streaming)
 * are **not** invoked. The mock cost of fully replaying a Fastify lifecycle
 * here would dwarf the assertion value: the surface files only weave the
 * composed primitives this test already exercises directly.
 *
 * Validates: bugfix.md Expected 2.1, 2.2, 2.3, 2.6, 2.7, 2.8,
 *            Unchanged 3.6, 3.14, 3.15
 *            (and the original spec session-stick-routing Requirements
 *             4.1-4.7, 5.2, 6.4, 6.7, 8.2, 8.4, 11.4-11.7 that survive the fix)
 * Properties: P1, P2, P3, P6
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import { EMPTY_DOWNSTREAM_ROUTING_POLICY } from '../../services/downstreamPolicyTypes.js';

const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const selectPreferredChannelMock = vi.fn();
const recordFailureMock = vi.fn();
const recordSuccessMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const getStickyChannelIdMock = vi.fn();
const bindStickyChannelMock = vi.fn();
const clearStickyChannelMock = vi.fn();
const acquireChannelLeaseMock = vi.fn();
const buildStickySessionKeyMock = vi.fn();

const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    selectPreferredChannel: (...args: unknown[]) => selectPreferredChannelMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
  },
}));

vi.mock('../../services/proxyChannelCoordinator.js', () => ({
  proxyChannelCoordinator: {
    getStickyChannelId: (...args: unknown[]) => getStickyChannelIdMock(...args),
    bindStickyChannel: (...args: unknown[]) => bindStickyChannelMock(...args),
    clearStickyChannel: (...args: unknown[]) => clearStickyChannelMock(...args),
    acquireChannelLease: (...args: unknown[]) => acquireChannelLeaseMock(...args),
    buildStickySessionKey: (...args: unknown[]) => buildStickySessionKeyMock(...args),
  },
}));

vi.mock('../../services/routeRefreshWorkflow.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

// The mocks below exist purely to keep `import('./sharedSurface.js')` cheap
// at test mode. None of these mocks are exercised by the assertions in this
// file; they mirror the minimal-surface pattern from
// `sharedSurface.usage-source.test.ts`.
vi.mock('../../services/proxyLogMessage.js', () => ({
  composeProxyLogMessage: vi.fn(),
}));

vi.mock('../../services/localTimeService.js', () => ({
  formatUtcSqlDateTime: vi.fn(),
}));

vi.mock('../../services/proxyLogStore.js', () => ({
  insertProxyLog: vi.fn(),
}));

vi.mock('../../services/siteProxy.js', () => ({
  resolveChannelProxyUrl: vi.fn(),
  withSiteRecordProxyRequestInit: vi.fn(),
}));

vi.mock('../../services/runtimeDispatch.js', () => ({
  dispatchRuntimeRequest: vi.fn(),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: vi.fn(),
  reportTokenExpired: vi.fn(),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: vi.fn(() => false),
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldRetryProxyRequest: vi.fn(() => false),
  shouldAbortSameSiteEndpointFallback: vi.fn(() => false),
}));

vi.mock('../../services/oauth/quota.js', () => ({
  recordOauthQuotaHeadersSnapshot: vi.fn(),
  recordOauthQuotaResetHint: vi.fn(),
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: vi.fn(),
}));

vi.mock('../../services/proxyBilling.js', () => ({
  resolveProxyLogBilling: vi.fn(),
}));

vi.mock('../../services/oauth/refreshSingleflight.js', () => ({
  refreshOauthAccessTokenSingleflight: vi.fn(),
}));

vi.mock('../orchestration/upstreamRequest.js', () => ({
  buildUpstreamUrl: vi.fn(),
}));

vi.mock('../executors/types.js', () => ({
  readRuntimeResponseText: vi.fn(),
}));

const RESPONSES_DOWNSTREAM_PATH = '/v1/responses';
const MESSAGES_DOWNSTREAM_PATH = '/v1/messages';
const RESPONSES_MODEL = 'gpt-5';
const MESSAGES_MODEL = 'claude-sonnet-4-5';
const DOWNSTREAM_API_KEY_ID = 7;

/**
 * Wires {@link bindStickyChannelMock}, {@link getStickyChannelIdMock} and
 * {@link clearStickyChannelMock} so they share an in-memory `Map` that
 * mirrors the real coordinator's trim-empty-then-set / trim-empty-then-get /
 * trim-empty-then-delete semantics. Returns the backing Map so individual
 * tests can prefill or inspect it.
 *
 * The mock fidelity here matters because Scenarios A / B / H / I assert the
 * end-to-end "round-1 success writes a key, round-2 query reads the same
 * key" contract — checking only call-arguments would not catch a regression
 * where the surface called `bindStickyChannel` with the wrong key shape.
 */
function installInMemoryStickyStore(): Map<string, number> {
  const store = new Map<string, number>();
  bindStickyChannelMock.mockImplementation((key: unknown, channelId: unknown) => {
    const k = String(key || '').trim();
    if (!k) return;
    const id = Number(channelId);
    if (!Number.isFinite(id) || id <= 0) return;
    store.set(k, Math.trunc(id));
  });
  getStickyChannelIdMock.mockImplementation((key: unknown) => {
    const k = String(key || '').trim();
    if (!k) return null;
    return store.get(k) ?? null;
  });
  clearStickyChannelMock.mockImplementation((key: unknown, channelId: unknown) => {
    const k = String(key || '').trim();
    if (!k) return;
    const expected = Number(channelId);
    const current = store.get(k);
    if (current === undefined) return;
    // Mirror the coordinator's compare-and-delete: only clear when the
    // channelId matches the binding (avoids stale-clear races). When the
    // caller does not specify a channelId we delete unconditionally.
    if (Number.isFinite(expected) && expected > 0 && current !== Math.trunc(expected)) {
      return;
    }
    store.delete(k);
  });
  return store;
}

const originalProxyStickySessionEnabled = config.proxyStickySessionEnabled;

describe('session-stick-routing integration', () => {
  afterAll(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  beforeEach(() => {
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    selectPreferredChannelMock.mockReset();
    recordFailureMock.mockReset();
    recordSuccessMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    getStickyChannelIdMock.mockReset();
    bindStickyChannelMock.mockReset();
    clearStickyChannelMock.mockReset();
    acquireChannelLeaseMock.mockReset();
    buildStickySessionKeyMock.mockReset();
    consoleWarnSpy.mockClear();
    consoleErrorSpy.mockClear();
    config.proxyStickySessionEnabled = true;
  });

  afterEach(() => {
    config.proxyStickySessionEnabled = originalProxyStickySessionEnabled;
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario A — OpenAI Responses protocol-level key end-to-end (P1 fix).
  //
  // Validates the post-fix double-key contract:
  //   1. Round 1 has no `previous_response_id`; the request-side query key
  //      is null (CLI fallback also null) so the surface does NOT bind a
  //      protocol-level key from the request side.
  //   2. The upstream response carries `response.id = 'resp_alpha'`. The
  //      surface success terminal calls `bindSurfaceStickyChannelFromResponse`
  //      which extracts that ID and writes
  //      `proto-v1|key:7|/v1/responses|gpt-5|openai/responses|resp_alpha → 42`.
  //   3. Round 2 carries `previous_response_id = 'resp_alpha'`; the
  //      request-side extractor produces the same `proto-v1|...` key, the
  //      sticky lookup hits, and the selector returns ch42 again.
  //
  // Pre-fix (bug P1) the round-1 success terminal wrote the wrong key
  // (request-side ID, which was null in round 1) so round 2 always missed.
  //
  // Validates: bugfix.md Expected 2.1, 2.3 + Property 1
  // ──────────────────────────────────────────────────────────────────────
  it('OpenAI Responses: round-1 success writes response.id key; round-2 query hits ch42', async () => {
    const store = installInMemoryStickyStore();
    const {
      buildSurfaceStickySessionKey,
      bindSurfaceStickyChannelFromResponse,
      selectSurfaceChannelForAttempt,
    } = await import('./sharedSurface.js');

    // CLI-level fallback returns null when the round-1 request body has no
    // `previous_response_id` (no continuation anchor exists yet).
    buildStickySessionKeyMock.mockReturnValue(null);

    // Round 1 — request body has no continuation; the round-1 query key is
    // null (protocol-level extractor returns null for an empty body, then
    // CLI fallback returns null too).
    const round1QueryKey = buildSurfaceStickySessionKey({
      clientContext: null,
      requestedModel: RESPONSES_MODEL,
      downstreamPath: RESPONSES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: {},
      protocolHint: 'openai/responses',
    });
    expect(round1QueryKey).toBeNull();

    const stickyChannelId = 42;
    const account = { extraConfig: '{"credentialMode":"session"}', oauthProvider: 'openai' };

    // Round-1 success terminal — surface calls the new response-side bind.
    // The legacy `bindSurfaceStickyChannel(null, ...)` call (which is still
    // emitted by the surface for CLI-level continuity) is a no-op for a
    // null key, so we omit it from the test for clarity.
    bindSurfaceStickyChannelFromResponse({
      requestSideStickySessionKey: round1QueryKey,
      protocolHint: 'openai/responses',
      responsePayload: {
        id: 'resp_alpha',
        object: 'response',
        status: 'completed',
      },
      scope: {
        downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
        downstreamPath: RESPONSES_DOWNSTREAM_PATH,
        requestedModel: RESPONSES_MODEL,
      },
      selected: { channel: { id: stickyChannelId }, account },
    });

    // The bind must address the response-side ID, not request-side ID nor
    // null. Verify the call shape directly (in addition to the in-memory
    // store inspection below) so a future refactor that changes the
    // composition of the write key surfaces here.
    const expectedResponseSideKey
      = `proto-v1|key:${DOWNSTREAM_API_KEY_ID}|${RESPONSES_DOWNSTREAM_PATH}|${RESPONSES_MODEL}|openai/responses|resp_alpha`;
    expect(bindStickyChannelMock).toHaveBeenCalledTimes(1);
    expect(bindStickyChannelMock).toHaveBeenCalledWith(
      expectedResponseSideKey,
      stickyChannelId,
      account,
    );

    // Round 2 — request body carries `previous_response_id = 'resp_alpha'`.
    // The request-side extractor produces the same `proto-v1|...` key.
    const round2QueryKey = buildSurfaceStickySessionKey({
      clientContext: null,
      requestedModel: RESPONSES_MODEL,
      downstreamPath: RESPONSES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: { previous_response_id: 'resp_alpha' },
      protocolHint: 'openai/responses',
    });
    expect(round2QueryKey).toBe(expectedResponseSideKey);

    // Direct store inspection — round-1 success wrote the response-side key
    // and round-2 query reads it.
    expect(store.get(round2QueryKey as string)).toBe(stickyChannelId);

    // End-to-end through the real selector: sticky lookup hits, ch42 is
    // returned without falling back to general scoring.
    const reselected = { channel: { id: stickyChannelId }, account };
    selectPreferredChannelMock.mockResolvedValueOnce(reselected);

    const result = await selectSurfaceChannelForAttempt({
      requestedModel: RESPONSES_MODEL,
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey: round2QueryKey,
    });

    expect(result).toBe(reselected);
    expect(selectPreferredChannelMock).toHaveBeenCalledWith(
      RESPONSES_MODEL,
      stickyChannelId,
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
      [],
    );
    expect(selectChannelMock).not.toHaveBeenCalled();
    expect(selectNextChannelMock).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario B — Anthropic Messages tool_use.id end-to-end (P1 fix).
  //
  // Same shape as Scenario A but for the Anthropic chain:
  //   1. Round 1 has no `tool_result` block (kick-off user message); query
  //      key is null.
  //   2. The upstream response carries a `content[]` array that includes
  //      `{ type: 'tool_use', id: 'toolu_alpha', ... }`. The surface success
  //      terminal extracts the **last** tool_use.id (mirror of the
  //      request-side "last tool_result in document order" rule) and binds
  //      `proto-v1|...|toolu_alpha → 17`.
  //   3. Round 2 carries `tool_result.tool_use_id = 'toolu_alpha'`; the
  //      request-side extractor produces the same `proto-v1|...` key.
  //
  // Validates: bugfix.md Expected 2.2, 2.3 + Property 1
  // ──────────────────────────────────────────────────────────────────────
  it('Anthropic Messages: round-1 success writes last tool_use.id key; round-2 query hits ch17', async () => {
    const store = installInMemoryStickyStore();
    const {
      buildSurfaceStickySessionKey,
      bindSurfaceStickyChannelFromResponse,
      selectSurfaceChannelForAttempt,
    } = await import('./sharedSurface.js');

    buildStickySessionKeyMock.mockReturnValue(null);

    // Round 1 — request body has no tool_result block.
    const round1QueryKey = buildSurfaceStickySessionKey({
      clientContext: null,
      requestedModel: MESSAGES_MODEL,
      downstreamPath: MESSAGES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'kick off' }] },
        ],
      },
      protocolHint: 'anthropic/messages',
    });
    expect(round1QueryKey).toBeNull();

    const stickyChannelId = 17;
    const account = { extraConfig: '{"credentialMode":"session"}', oauthProvider: 'anthropic' };

    bindSurfaceStickyChannelFromResponse({
      requestSideStickySessionKey: round1QueryKey,
      protocolHint: 'anthropic/messages',
      responsePayload: {
        id: 'msg_round1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling tool' },
          { type: 'tool_use', id: 'toolu_alpha', name: 'search', input: {} },
        ],
      },
      scope: {
        downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
        downstreamPath: MESSAGES_DOWNSTREAM_PATH,
        requestedModel: MESSAGES_MODEL,
      },
      selected: { channel: { id: stickyChannelId }, account },
    });

    const expectedResponseSideKey
      = `proto-v1|key:${DOWNSTREAM_API_KEY_ID}|${MESSAGES_DOWNSTREAM_PATH}|${MESSAGES_MODEL}|anthropic/messages|toolu_alpha`;
    expect(bindStickyChannelMock).toHaveBeenCalledTimes(1);
    expect(bindStickyChannelMock).toHaveBeenCalledWith(
      expectedResponseSideKey,
      stickyChannelId,
      account,
    );

    // Round 2 — request body carries the tool_result that points back at
    // round-1's tool_use.id.
    const round2QueryKey = buildSurfaceStickySessionKey({
      clientContext: null,
      requestedModel: MESSAGES_MODEL,
      downstreamPath: MESSAGES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_alpha', content: 'ok' },
            ],
          },
        ],
      },
      protocolHint: 'anthropic/messages',
    });
    expect(round2QueryKey).toBe(expectedResponseSideKey);
    expect(store.get(round2QueryKey as string)).toBe(stickyChannelId);

    const reselected = { channel: { id: stickyChannelId }, account };
    selectPreferredChannelMock.mockResolvedValueOnce(reselected);

    const result = await selectSurfaceChannelForAttempt({
      requestedModel: MESSAGES_MODEL,
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey: round2QueryKey,
    });

    expect(result).toBe(reselected);
    expect(selectPreferredChannelMock).toHaveBeenCalledWith(
      MESSAGES_MODEL,
      stickyChannelId,
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
      [],
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario C — `excludeChannelIds` containing the sticky channel forces
  // a fallback to general scoring (Req 11.4 c, Req 4.2, 8.2).
  //
  // The real `selectProxyChannelForAttempt` inspects
  // `!input.excludeChannelIds.includes(preferredChannelId)` *before* calling
  // `selectPreferredChannel`. When the sticky channel is excluded, the entire
  // sticky branch is skipped and `selectChannel` (general scoring) drives
  // selection. This pins that contract in the integration seam.
  //
  // Unchanged by P1/P2/P3 fixes — preserved as-is.
  // ──────────────────────────────────────────────────────────────────────
  it('excludeChannelIds containing the sticky channel forces fallback to general scoring', async () => {
    const {
      buildSurfaceStickySessionKey,
      selectSurfaceChannelForAttempt,
    } = await import('./sharedSurface.js');

    const stickySessionKey = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'codex', sessionId: 'cli-session-irrelevant' },
      requestedModel: RESPONSES_MODEL,
      downstreamPath: RESPONSES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: { previous_response_id: 'resp_z' },
      protocolHint: 'openai/responses',
    });
    expect(stickySessionKey?.startsWith('proto-v1|')).toBe(true);

    const stickyChannelId = 42;
    const fallbackChannelId = 99;
    const fallbackSelection = { channel: { id: fallbackChannelId } };

    // The sticky binding is "stale": it points to a channel the current
    // attempt has already excluded (e.g. previous attempt failed on it).
    getStickyChannelIdMock.mockReturnValueOnce(stickyChannelId);
    selectChannelMock.mockResolvedValueOnce(fallbackSelection);

    const result = await selectSurfaceChannelForAttempt({
      requestedModel: RESPONSES_MODEL,
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [stickyChannelId],
      retryCount: 0,
      stickySessionKey,
    });

    // General scoring drove the selection, not the sticky preference.
    expect(result).toBe(fallbackSelection);
    expect(selectChannelMock).toHaveBeenCalledWith(
      RESPONSES_MODEL,
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
    );

    // Critical: the excluded sticky channel must never be offered to
    // `selectPreferredChannel`, otherwise the breaker / route candidate
    // judgement could silently re-admit it (Req 8.1, 8.2).
    expect(selectPreferredChannelMock).not.toHaveBeenCalled();
    // Selector also doesn't clear the stale binding here — the caller's
    // `excludeChannelIds` is per-attempt state and the binding may still be
    // valid for future requests once the breaker settles (Req 6.4, 8.4).
    expect(clearStickyChannelMock).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario D — Forced channel overrides protocol-level sticky (Req 11.6, 4.7).
  //
  // Unchanged by P1/P2/P3 fixes — preserved as-is.
  // ──────────────────────────────────────────────────────────────────────
  it('forcedChannelId overrides protocol-level sticky binding', async () => {
    const {
      buildSurfaceStickySessionKey,
      selectSurfaceChannelForAttempt,
    } = await import('./sharedSurface.js');

    const stickySessionKey = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'codex', sessionId: 'cli-session-irrelevant' },
      requestedModel: RESPONSES_MODEL,
      downstreamPath: RESPONSES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: { previous_response_id: 'resp_forced_test' },
      protocolHint: 'openai/responses',
    });
    expect(stickySessionKey?.startsWith('proto-v1|')).toBe(true);

    const forcedChannelId = 88;
    const stickyChannelId = 42;
    const forcedSelection = { channel: { id: forcedChannelId } };

    // Even though a sticky binding exists, the forced path must short-circuit
    // before any sticky lookup is attempted.
    getStickyChannelIdMock.mockReturnValueOnce(stickyChannelId);
    selectPreferredChannelMock.mockResolvedValueOnce(forcedSelection);

    const result = await selectSurfaceChannelForAttempt({
      requestedModel: RESPONSES_MODEL,
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey,
      forcedChannelId,
    });

    expect(result).toBe(forcedSelection);
    expect(selectPreferredChannelMock).toHaveBeenCalledWith(
      RESPONSES_MODEL,
      forcedChannelId,
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
      [],
    );

    // Forced path returns before reading the sticky map at all (Property 6).
    expect(getStickyChannelIdMock).not.toHaveBeenCalled();
    expect(selectChannelMock).not.toHaveBeenCalled();
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(refreshModelsAndRebuildRoutesMock).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario E — Failure-preserve contract for protocol-level keys
  // (P3 fix; reinforces Req 11.7, 6.4, 8.4).
  //
  // Strengthened from the pre-fix shape ("bind never triggers clear") to
  // explicitly verify the P3 invariant: a `clearSurfaceStickyChannel` call
  // carrying a `proto-v1|` key is a no-op all the way through the in-memory
  // store, while a CLI-level key under the same call still clears as
  // before. The combined assertion proves the fix is precise — protocol
  // keys are protected, CLI keys keep pre-feature semantics.
  // ──────────────────────────────────────────────────────────────────────
  it('clearSurfaceStickyChannel: proto-v1 key is a no-op; CLI-level key still clears (P3 fix)', async () => {
    const store = installInMemoryStickyStore();
    const { clearSurfaceStickyChannel } = await import('./sharedSurface.js');

    // Pre-seed both a protocol-level and a CLI-level binding, both pointing
    // at ch42, so any erroneous unconditional clear would wipe both.
    const protocolKey
      = `proto-v1|key:${DOWNSTREAM_API_KEY_ID}|${RESPONSES_DOWNSTREAM_PATH}|${RESPONSES_MODEL}|openai/responses|resp_E`;
    const cliKey = 'codex|cli-session-E|/v1/responses|gpt-5|key:7';
    bindStickyChannelMock(protocolKey, 42);
    bindStickyChannelMock(cliKey, 42);
    expect(store.get(protocolKey)).toBe(42);
    expect(store.get(cliKey)).toBe(42);

    // Reset the call recorder so subsequent assertions only count the
    // clears we are about to issue. (The pre-seed bind calls above are not
    // under test here.)
    bindStickyChannelMock.mockClear();
    clearStickyChannelMock.mockClear();

    // Step 1 — clear with the protocol-level key. P3 surface-level guard
    // must short-circuit before the coordinator sees anything.
    clearSurfaceStickyChannel({
      stickySessionKey: protocolKey,
      selected: { channel: { id: 42 } },
    });
    expect(clearStickyChannelMock).not.toHaveBeenCalled();
    expect(store.get(protocolKey)).toBe(42);

    // Step 2 — clear with the CLI-level key (no `proto-v1|` prefix). The
    // pre-feature path must remain intact: the surface helper forwards to
    // the coordinator and the in-memory store removes the entry.
    clearSurfaceStickyChannel({
      stickySessionKey: cliKey,
      selected: { channel: { id: 42 } },
    });
    expect(clearStickyChannelMock).toHaveBeenCalledTimes(1);
    expect(clearStickyChannelMock).toHaveBeenCalledWith(cliKey, 42);
    expect(store.has(cliKey)).toBe(false);

    // Final state: protocol key preserved, CLI key cleared. This is the
    // exact split P3 needs.
    expect(store.get(protocolKey)).toBe(42);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario F — Anthropic Messages without tool_result falls back to
  // CLI-level path (Req 11.5 c, Req 5.2).
  //
  // Unchanged by P1/P2/P3 fixes — preserved as-is.
  // ──────────────────────────────────────────────────────────────────────
  it('Anthropic Messages without tool_result falls back to CLI-level sticky key', async () => {
    const { buildSurfaceStickySessionKey } = await import('./sharedSurface.js');

    // The CLI-level helper returns its own opaque key when invoked.
    const cliLevelSessionKey = 'cli-level-claude-key';
    buildStickySessionKeyMock.mockReturnValueOnce(cliLevelSessionKey);

    const stickySessionKey = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'claude', sessionId: 'cli-session-claude' },
      requestedModel: MESSAGES_MODEL,
      downstreamPath: MESSAGES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      // Only `text` blocks — no `tool_result`, so the extractor returns null.
      parsedBody: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi' },
            ],
          },
        ],
      },
      protocolHint: 'anthropic/messages',
    });

    // Output is the CLI-level helper's opaque return value, byte-equivalent
    // to pre-feature behaviour (Property 3).
    expect(stickySessionKey).toBe(cliLevelSessionKey);
    expect(stickySessionKey?.startsWith('proto-v1|')).toBe(false);

    // The CLI-level fallback received the legacy five-field call shape.
    expect(buildStickySessionKeyMock).toHaveBeenCalledTimes(1);
    expect(buildStickySessionKeyMock).toHaveBeenCalledWith({
      clientKind: 'claude',
      sessionId: 'cli-session-claude',
      requestedModel: MESSAGES_MODEL,
      downstreamPath: MESSAGES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario G — `proxyStickySessionEnabled === false` short-circuits
  // every protocol-level sticky path (P2 fix).
  //
  // Three observations under the same switch state:
  //   1. `buildSurfaceStickySessionKey` returns null instead of a
  //      `proto-v1|...` key (the CLI fallback also returns null when the
  //      switch is off).
  //   2. `acquireSurfaceChannelLease` is called with `channelId === 0`
  //      (the no-op lease branch), so session-scoped accounts are NOT
  //      funneled into the per-channel lease pool.
  //   3. `bindSurfaceStickyChannelFromResponse` is a no-op — the
  //      coordinator's `bindStickyChannel` mock is never invoked, so
  //      no `proto-v1|...` key is leaked into the store while the user
  //      believes sticky is disabled.
  //
  // Validates: bugfix.md Expected 2.6, 2.7, 2.8 + Property 2
  // ──────────────────────────────────────────────────────────────────────
  it('proxyStickySessionEnabled === false: protocol-level key + lease + bind all short-circuit (P2 fix)', async () => {
    buildStickySessionKeyMock.mockReturnValue(null);
    acquireChannelLeaseMock.mockResolvedValue({
      status: 'acquired',
      lease: { release: () => {}, keepAlive: () => {} },
    });
    config.proxyStickySessionEnabled = false;

    try {
      const {
        buildSurfaceStickySessionKey,
        acquireSurfaceChannelLease,
        bindSurfaceStickyChannelFromResponse,
      } = await import('./sharedSurface.js');

      // (1) Build returns null even though parsedBody has a continuation.
      const stickyKey = buildSurfaceStickySessionKey({
        clientContext: { clientKind: 'codex', sessionId: 'cli-session-G' },
        requestedModel: RESPONSES_MODEL,
        downstreamPath: RESPONSES_DOWNSTREAM_PATH,
        downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
        parsedBody: { previous_response_id: 'resp_G' },
        protocolHint: 'openai/responses',
      });
      expect(stickyKey).toBeNull();

      // (2) Lease is acquired with channelId === 0 (no-op branch).
      await acquireSurfaceChannelLease({
        stickySessionKey: stickyKey,
        selected: {
          channel: { id: 42 },
          account: { extraConfig: '{}', oauthProvider: 'openai' },
        },
      });
      expect(acquireChannelLeaseMock).toHaveBeenCalledTimes(1);
      expect(acquireChannelLeaseMock).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 0 }),
      );

      // (3) Response-side bind is a no-op despite a fully-formed payload.
      bindSurfaceStickyChannelFromResponse({
        requestSideStickySessionKey: stickyKey,
        protocolHint: 'openai/responses',
        responsePayload: {
          id: 'resp_G',
          object: 'response',
          status: 'completed',
        },
        scope: {
          downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
          downstreamPath: RESPONSES_DOWNSTREAM_PATH,
          requestedModel: RESPONSES_MODEL,
        },
        selected: { channel: { id: 42 }, account: { extraConfig: '{}', oauthProvider: 'openai' } },
      });
      expect(bindStickyChannelMock).not.toHaveBeenCalled();
    } finally {
      config.proxyStickySessionEnabled = originalProxyStickySessionEnabled;
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario H — Retry switch: sticky hit ch42 fails, retry general-scores
  // ch99 to success, response-side bind overwrites with ch99 (Req 6.7).
  //
  // Combines three invariants in one flow:
  //   - P1 fix: response-side bind addresses the new round's response.id.
  //   - P3 fix: the failure terminal between attempts does NOT clear the
  //     pre-existing sticky binding (Req 6.4 + 8.4); proves the fix
  //     coexists with Req 6.7's "final attempt overwrites" rule rather
  //     than fighting it.
  //   - Req 6.7: when retryCount > 0 picks a different channel and that
  //     channel's response succeeds, the new (response-side key, channel)
  //     pair lands in the store and supersedes any prior round's binding.
  //
  // Round 1 simulation (single integration call):
  //   * Pre-seed `(proto-v1|...|R0 → 42)` to model an earlier turn's
  //     successful binding.
  //   * Attempt 1 with `previous_response_id = 'R0'` hits sticky and
  //     receives ch42 from `selectPreferredChannel`. Then fails (we
  //     simulate by triggering `clearSurfaceStickyChannel` afterwards;
  //     P3 makes the clear a no-op).
  //   * Attempt 2 with retryCount = 1 and `excludeChannelIds = [42]`
  //     general-scores ch99 to selection.
  //   * Attempt 2 succeeds with `response.id = 'R1'`; the surface invokes
  //     `bindSurfaceStickyChannelFromResponse` and writes
  //     `(proto-v1|...|R1 → 99)`.
  //
  // Round 2 (verification):
  //   * `previous_response_id = 'R1'` produces the same `proto-v1|...`
  //     query key, sticky lookup returns ch99.
  //
  // Validates: bugfix.md Expected 2.1, 2.7, 2.8, Unchanged 3.6 +
  //            Properties 1, 3, 6
  // ──────────────────────────────────────────────────────────────────────
  it('retry switch: ch42 fails, ch99 succeeds, response.id rewrites sticky to ch99 (Req 6.7 + P1/P3)', async () => {
    const store = installInMemoryStickyStore();
    const {
      buildSurfaceStickySessionKey,
      selectSurfaceChannelForAttempt,
      bindSurfaceStickyChannelFromResponse,
      clearSurfaceStickyChannel,
    } = await import('./sharedSurface.js');

    const r0Key
      = `proto-v1|key:${DOWNSTREAM_API_KEY_ID}|${RESPONSES_DOWNSTREAM_PATH}|${RESPONSES_MODEL}|openai/responses|R0`;
    const r1Key
      = `proto-v1|key:${DOWNSTREAM_API_KEY_ID}|${RESPONSES_DOWNSTREAM_PATH}|${RESPONSES_MODEL}|openai/responses|R1`;

    // Pre-seed the sticky store with the binding from a hypothetical
    // earlier successful turn that produced response.id = 'R0' on ch42.
    bindStickyChannelMock(r0Key, 42);
    expect(store.get(r0Key)).toBe(42);
    bindStickyChannelMock.mockClear();

    // ── Round-1 attempt 1 (retryCount = 0): sticky hit picks ch42 ──
    const round1RequestKey = buildSurfaceStickySessionKey({
      clientContext: null,
      requestedModel: RESPONSES_MODEL,
      downstreamPath: RESPONSES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: { previous_response_id: 'R0' },
      protocolHint: 'openai/responses',
    });
    expect(round1RequestKey).toBe(r0Key);

    const ch42Account = { extraConfig: '{"credentialMode":"session"}', oauthProvider: 'openai' };
    const attempt1Selection = { channel: { id: 42 }, account: ch42Account };
    selectPreferredChannelMock.mockResolvedValueOnce(attempt1Selection);

    const attempt1 = await selectSurfaceChannelForAttempt({
      requestedModel: RESPONSES_MODEL,
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey: round1RequestKey,
    });
    expect(attempt1).toBe(attempt1Selection);
    expect(selectPreferredChannelMock).toHaveBeenCalledWith(
      RESPONSES_MODEL,
      42,
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
      [],
    );

    // ── Attempt 1 fails: surface invokes clear with the protocol key ──
    // P3 must protect the pre-existing R0 binding.
    clearSurfaceStickyChannel({
      stickySessionKey: round1RequestKey,
      selected: { channel: { id: 42 } },
    });
    expect(clearStickyChannelMock).not.toHaveBeenCalled();
    expect(store.get(r0Key)).toBe(42);

    // ── Round-1 attempt 2 (retryCount = 1, exclude ch42): general scoring picks ch99 ──
    const ch99Account = { extraConfig: '{"credentialMode":"session"}', oauthProvider: 'openai' };
    const attempt2Selection = { channel: { id: 99 }, account: ch99Account };
    selectNextChannelMock.mockResolvedValueOnce(attempt2Selection);

    const attempt2 = await selectSurfaceChannelForAttempt({
      requestedModel: RESPONSES_MODEL,
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [42],
      retryCount: 1,
      stickySessionKey: round1RequestKey,
    });
    expect(attempt2).toBe(attempt2Selection);
    // Sticky branch is structurally skipped on retryCount > 0.
    expect(selectPreferredChannelMock).toHaveBeenCalledTimes(1); // only attempt 1
    expect(selectNextChannelMock).toHaveBeenCalledWith(
      RESPONSES_MODEL,
      [42],
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
    );

    // ── Attempt 2 succeeds with response.id = 'R1' ──
    bindSurfaceStickyChannelFromResponse({
      requestSideStickySessionKey: round1RequestKey,
      protocolHint: 'openai/responses',
      responsePayload: {
        id: 'R1',
        object: 'response',
        status: 'completed',
      },
      scope: {
        downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
        downstreamPath: RESPONSES_DOWNSTREAM_PATH,
        requestedModel: RESPONSES_MODEL,
      },
      selected: attempt2Selection,
    });

    // Final store inventory after round 1:
    //   - R0 binding preserved (P3) on ch42.
    //   - R1 binding written (Req 6.7) on ch99.
    expect(store.get(r0Key)).toBe(42);
    expect(store.get(r1Key)).toBe(99);

    // ── Round 2 verification: previous_response_id = 'R1' hits ch99 ──
    const round2RequestKey = buildSurfaceStickySessionKey({
      clientContext: null,
      requestedModel: RESPONSES_MODEL,
      downstreamPath: RESPONSES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: { previous_response_id: 'R1' },
      protocolHint: 'openai/responses',
    });
    expect(round2RequestKey).toBe(r1Key);

    const round2Selection = { channel: { id: 99 }, account: ch99Account };
    selectPreferredChannelMock.mockResolvedValueOnce(round2Selection);

    const round2 = await selectSurfaceChannelForAttempt({
      requestedModel: RESPONSES_MODEL,
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey: round2RequestKey,
    });
    expect(round2).toBe(round2Selection);
    expect(selectPreferredChannelMock).toHaveBeenLastCalledWith(
      RESPONSES_MODEL,
      99,
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
      [],
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario I — CLI-level keys are still cleared on failure (regression
  // guard for the P3 fix).
  //
  // Independent assertion to catch a future regression where a too-broad
  // "no-op every clear" rewrite accidentally protects CLI-level keys too.
  // The pre-feature CLI-level path must continue to clear bindings on
  // failure so the next request re-picks freshly. This is a load-bearing
  // invariant for non-protocol surfaces (OpenAI Chat Completions, Gemini,
  // count_tokens).
  //
  // Validates: bugfix.md Unchanged 3.14, 3.15 + Property 3 (CLI clause)
  // ──────────────────────────────────────────────────────────────────────
  it('CLI-level key still clears on failure (P3 fix does not overshoot)', async () => {
    const store = installInMemoryStickyStore();
    const { clearSurfaceStickyChannel } = await import('./sharedSurface.js');

    const cliKey = 'codex|cli-session-I|/v1/responses|gpt-5|key:7';
    bindStickyChannelMock(cliKey, 42);
    expect(store.get(cliKey)).toBe(42);

    bindStickyChannelMock.mockClear();
    clearStickyChannelMock.mockClear();

    clearSurfaceStickyChannel({
      stickySessionKey: cliKey,
      selected: { channel: { id: 42 } },
    });

    // The coordinator was invoked exactly once with the CLI-level key, and
    // the store reflects the deletion.
    expect(clearStickyChannelMock).toHaveBeenCalledTimes(1);
    expect(clearStickyChannelMock).toHaveBeenCalledWith(cliKey, 42);
    expect(store.has(cliKey)).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Cross-protocol response shape — Anthropic downstream + OpenAI Chat
  // upstream tool_calls.
  //
  // Validates the cross-protocol fix that complements P1: a Claude client
  // routed to an upstream account that speaks OpenAI Chat Completions
  // produces a NormalizedFinalResponse where tool_call ids land on the
  // top-level `toolCalls[]` array (path 2 of the Anthropic response-side
  // extractor) — NOT on `content[].tool_use.id` (path 1, which is the
  // Anthropic-native shape). The bind helper must handle both shapes;
  // passing raw upstream payloads (which would only contain
  // `choices[].message.tool_calls[]`) silently no-ops the bind and breaks
  // protocol-level sticky for any cross-protocol fallback. Surfaces are
  // therefore expected to feed the bind helper with the normalized final
  // shape, not the raw upstream JSON.
  //
  // Validates: bugfix.md Expected 2.2, Unchanged 3.7
  //            Properties 1, 6 + cross-protocol invariant
  // ──────────────────────────────────────────────────────────────────────
  it('cross-protocol: Anthropic bind helper accepts NormalizedFinalResponse with toolCalls[] (path 2)', async () => {
    const store = installInMemoryStickyStore();
    const { bindSurfaceStickyChannelFromResponse, buildSurfaceStickySessionKey } = await import(
      './sharedSurface.js'
    );

    // Round 1 — round-1 query key is null because no tool_result is in the
    // request body yet. The CLI fallback also returns null in this scenario
    // (no clientContext.sessionId provided).
    buildStickySessionKeyMock.mockReturnValue(null);

    const round1QueryKey = buildSurfaceStickySessionKey({
      clientContext: null,
      requestedModel: MESSAGES_MODEL,
      downstreamPath: MESSAGES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'kick off' }] }],
      },
      protocolHint: 'anthropic/messages',
    });
    expect(round1QueryKey).toBeNull();

    // Cross-protocol upstream: an OpenAI Chat upstream emits a tool call.
    // After the proxy normalizes the final response (via
    // `transformFinalResponse` for the claude downstream transformer),
    // the result lacks the Anthropic-native `content[].tool_use` shape but
    // carries the tool call on the top-level `toolCalls[]` array — which
    // is exactly what extractor path 2 reads. The same shape is also
    // produced by the OpenAI Chat aggregator wired into proxyStream for
    // streaming claude downstream traffic (see proxyStream.ts
    // `getTerminalNormalizedFinal`).
    const normalizedFinal = {
      id: 'chatcmpl-xprotocol-1',
      model: 'gpt-4.1',
      // No `content[]` array on this shape; path 1 of the extractor must
      // miss and fall through to path 2.
      content: '',
      reasoningContent: '',
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'toolu_xprotocol_alpha', name: 'search', arguments: '{"q":"hi"}' },
      ],
    };

    const stickyChannelId = 99;
    bindSurfaceStickyChannelFromResponse({
      requestSideStickySessionKey: round1QueryKey,
      protocolHint: 'anthropic/messages',
      responsePayload: normalizedFinal,
      scope: {
        downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
        downstreamPath: MESSAGES_DOWNSTREAM_PATH,
        requestedModel: MESSAGES_MODEL,
      },
      selected: { channel: { id: stickyChannelId } },
    });

    // Round 2 — request body now carries `tool_result.tool_use_id =
    // 'toolu_xprotocol_alpha'`, which produces the same protocol-level
    // key the response-side bind wrote in round 1. Despite upstream
    // protocol mismatch, the user's continuation is bound to ch99.
    const round2QueryKey = buildSurfaceStickySessionKey({
      clientContext: null,
      requestedModel: MESSAGES_MODEL,
      downstreamPath: MESSAGES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_xprotocol_alpha', content: 'ok' },
            ],
          },
        ],
      },
      protocolHint: 'anthropic/messages',
    });
    expect(round2QueryKey?.startsWith('proto-v1|')).toBe(true);
    expect(round2QueryKey?.endsWith('|toolu_xprotocol_alpha')).toBe(true);

    expect(store.get(round2QueryKey as string)).toBe(stickyChannelId);
  });
});
