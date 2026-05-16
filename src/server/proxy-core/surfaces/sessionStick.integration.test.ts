/**
 * End-to-end coordination test for the session-stick-routing feature.
 *
 * Scope rationale:
 * - `sharedSurface.test.ts` already covers `selectSurfaceChannelForAttempt`
 *   in isolation across every sticky branch (forced > sticky hit > refresh
 *   recovery > sticky miss with stale binding cleanup).
 * - `buildProtocolSessionKey.test.ts` and `buildSurfaceStickySessionKey.test.ts`
 *   already cover protocol-level key composition and the protocol→CLI
 *   fallback dispatcher.
 *
 * What is **not** yet covered, and what this file pins, is the
 * **co-operation** between those layers: a protocol-level continuation
 * identifier extracted from a real downstream payload flowing through
 * `buildSurfaceStickySessionKey` → `selectSurfaceChannelForAttempt` →
 * `bindSurfaceStickyChannel`, and the cross-cutting invariants around
 * `forcedChannelId`, `excludeChannelIds`, and the failure-preserve contract
 * of the bind path.
 *
 * Mock strategy:
 * - The transformer-pure session-id extractors (`extractOpenAiResponsesSessionId`,
 *   `extractAnthropicMessagesSessionId`) are intentionally **not** mocked.
 *   Running real protocol parsers against real payload shapes is the entire
 *   point of an integration assertion at this seam.
 * - `selectProxyChannelForAttempt` (in `channelSelection.ts`) is also **not**
 *   mocked, so the real branching logic (forced → sticky → general) executes
 *   end-to-end. Only its dependencies (`tokenRouter`, `proxyChannelCoordinator`,
 *   `routeRefreshWorkflow`) are stubbed.
 * - All other proxy-core dependencies pulled in transitively by
 *   `./sharedSurface.js` are mocked to keep module load cheap; their methods
 *   are not exercised here.
 *
 * Surface entry points (Fastify request/reply, runtime dispatch, streaming)
 * are **not** invoked. The mock cost of fully replaying a Fastify lifecycle
 * here would dwarf the assertion value: the surface files only weave the
 * three composed primitives this test already exercises directly.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1, 6.4, 6.7,
 *            8.1, 8.2, 8.4, 11.4, 11.5, 11.6, 11.7
 * Properties: P3, P6, P7
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario A — OpenAI Responses protocol-level key end-to-end (Req 11.4 a+b)
  // ──────────────────────────────────────────────────────────────────────
  it('OpenAI Responses: protocol-level key produces sticky hit and binds same channel on success', async () => {
    const {
      buildSurfaceStickySessionKey,
      selectSurfaceChannelForAttempt,
      bindSurfaceStickyChannel,
    } = await import('./sharedSurface.js');

    // Step 1 — compose the sticky key from a real OpenAI Responses payload.
    // The real `extractOpenAiResponsesSessionId` runs unmocked here.
    const stickySessionKey = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'codex', sessionId: 'cli-session-irrelevant' },
      requestedModel: RESPONSES_MODEL,
      downstreamPath: RESPONSES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: { previous_response_id: 'resp_alpha' },
      protocolHint: 'openai/responses',
    });

    // The protocol-level branch should win and the CLI-level fallback mock
    // should be bypassed entirely (Property 3).
    expect(stickySessionKey).not.toBeNull();
    expect(stickySessionKey?.startsWith('proto-v1|')).toBe(true);
    expect(stickySessionKey?.includes('|openai/responses|')).toBe(true);
    expect(stickySessionKey?.endsWith('|resp_alpha')).toBe(true);
    expect(buildStickySessionKeyMock).not.toHaveBeenCalled();

    // Step 2 — sticky hit path through the real `selectProxyChannelForAttempt`.
    const stickyChannelId = 42;
    const selected = {
      channel: { id: stickyChannelId },
      account: { extraConfig: '{"proxy":"y"}', oauthProvider: 'openai' },
    };
    getStickyChannelIdMock.mockReturnValueOnce(stickyChannelId);
    selectPreferredChannelMock.mockResolvedValueOnce(selected);

    const result = await selectSurfaceChannelForAttempt({
      requestedModel: RESPONSES_MODEL,
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey,
    });

    expect(result).toBe(selected);
    expect(getStickyChannelIdMock).toHaveBeenCalledWith(stickySessionKey);
    expect(selectPreferredChannelMock).toHaveBeenCalledWith(
      RESPONSES_MODEL,
      stickyChannelId,
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
      [],
    );
    // The general scoring path must not fire when sticky hit succeeds.
    expect(selectChannelMock).not.toHaveBeenCalled();
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(refreshModelsAndRebuildRoutesMock).not.toHaveBeenCalled();
    expect(clearStickyChannelMock).not.toHaveBeenCalled();

    // Step 3 — successful terminal binds (Protocol_Session_Key, channel, account)
    // through the real `bindSurfaceStickyChannel` (Property 7).
    bindSurfaceStickyChannel({
      stickySessionKey,
      selected,
    });

    expect(bindStickyChannelMock).toHaveBeenCalledTimes(1);
    expect(bindStickyChannelMock).toHaveBeenCalledWith(
      stickySessionKey,
      stickyChannelId,
      selected.account,
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario B — Anthropic Messages tool_result protocol key (Req 11.5 a+b)
  // ──────────────────────────────────────────────────────────────────────
  it('Anthropic Messages: tool_result.tool_use_id produces sticky hit and binds same channel on success', async () => {
    const {
      buildSurfaceStickySessionKey,
      selectSurfaceChannelForAttempt,
      bindSurfaceStickyChannel,
    } = await import('./sharedSurface.js');

    // Real `extractAnthropicMessagesSessionId` walks the messages array.
    const stickySessionKey = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'claude', sessionId: 'cli-session-irrelevant' },
      requestedModel: MESSAGES_MODEL,
      downstreamPath: MESSAGES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' },
            ],
          },
        ],
      },
      protocolHint: 'anthropic/messages',
    });

    expect(stickySessionKey).not.toBeNull();
    expect(stickySessionKey?.startsWith('proto-v1|')).toBe(true);
    expect(stickySessionKey?.includes('|anthropic/messages|')).toBe(true);
    expect(stickySessionKey?.endsWith('|toolu_x')).toBe(true);
    expect(buildStickySessionKeyMock).not.toHaveBeenCalled();

    const stickyChannelId = 17;
    const selected = {
      channel: { id: stickyChannelId },
      account: { extraConfig: '{}', oauthProvider: 'anthropic' },
    };
    getStickyChannelIdMock.mockReturnValueOnce(stickyChannelId);
    selectPreferredChannelMock.mockResolvedValueOnce(selected);

    const result = await selectSurfaceChannelForAttempt({
      requestedModel: MESSAGES_MODEL,
      downstreamPolicy: EMPTY_DOWNSTREAM_ROUTING_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey,
    });

    expect(result).toBe(selected);
    expect(getStickyChannelIdMock).toHaveBeenCalledWith(stickySessionKey);
    expect(selectPreferredChannelMock).toHaveBeenCalledWith(
      MESSAGES_MODEL,
      stickyChannelId,
      EMPTY_DOWNSTREAM_ROUTING_POLICY,
      [],
    );
    expect(selectChannelMock).not.toHaveBeenCalled();

    bindSurfaceStickyChannel({
      stickySessionKey,
      selected,
    });

    expect(bindStickyChannelMock).toHaveBeenCalledTimes(1);
    expect(bindStickyChannelMock).toHaveBeenCalledWith(
      stickySessionKey,
      stickyChannelId,
      selected.account,
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
  // Scenario E — Failure-preserve contract on the bind path (Req 11.7, 6.4, 8.4).
  //
  // Per the spec's simplified test plan: rather than replaying a full Fastify
  // failure flow (whose mock cost would dwarf the assertion value), we pin
  // the unit-level contract that makes the failure-preserve invariant true:
  //   1. `bindSurfaceStickyChannel` forwards (key, channelId, account)
  //      verbatim to `proxyChannelCoordinator.bindStickyChannel`.
  //   2. The bind call itself never triggers a `clearStickyChannel`. Combined
  //      with the static fact that `clearSurfaceStickyChannel` is only called
  //      from explicit failure / lease-timeout / stream-failure paths in
  //      `chatSurface.ts` and `openAiResponsesSurface.ts` (the architecture
  //      test in Task 11 pins those), this proves the failure-preserve
  //      invariant: no surface code path on a *bind* converts into a *clear*.
  // ──────────────────────────────────────────────────────────────────────
  it('bindSurfaceStickyChannel forwards (proto-v1 key, channelId, account) and never triggers clear', async () => {
    const {
      buildSurfaceStickySessionKey,
      bindSurfaceStickyChannel,
    } = await import('./sharedSurface.js');

    const stickySessionKey = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'codex', sessionId: 'cli-session-irrelevant' },
      requestedModel: RESPONSES_MODEL,
      downstreamPath: RESPONSES_DOWNSTREAM_PATH,
      downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
      parsedBody: { previous_response_id: 'resp_preserve_on_failure' },
      protocolHint: 'openai/responses',
    });
    expect(stickySessionKey?.startsWith('proto-v1|')).toBe(true);

    const channelId = 31;
    const account = { extraConfig: '{}', oauthProvider: 'openai' };

    bindSurfaceStickyChannel({
      stickySessionKey,
      selected: { channel: { id: channelId }, account },
    });

    // Bind contract: key, channelId, account passed through verbatim.
    expect(bindStickyChannelMock).toHaveBeenCalledTimes(1);
    expect(bindStickyChannelMock).toHaveBeenCalledWith(
      stickySessionKey,
      channelId,
      account,
    );

    // Failure-preserve invariant on the bind path: a successful bind never
    // converts into a clear. The only `clearStickyChannel` call site this
    // feature touches at the proxy-core level is inside the selector's
    // refresh-failed branch (`channelSelection.ts` line 136). The bind path
    // is structurally separate from that branch.
    expect(clearStickyChannelMock).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario F — Anthropic Messages without tool_result falls back to
  // CLI-level path (Req 11.5 c, Req 5.2).
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
});
