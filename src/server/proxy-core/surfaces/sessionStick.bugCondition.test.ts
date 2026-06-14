/**
 * Bug condition exploration tests — finalized as regression tests
 * (Task 11 of spec session-stick-routing-binding-timing-fix).
 *
 * Phase 1 of the bugfix workflow: each `it(...)` here describes a
 * post-fix invariant. On the original main HEAD before fix, these
 * assertions deliberately failed (then wrapped in `it.fails(...)`) to
 * prove P1/P2/P3 bugs existed. Tasks 4–8 in `tasks.md` applied the
 * fixes; Task 11 now strips `.fails` and the assertions naturally pass.
 *
 * The file remains as a regression suite: any future regression to P1
 * (write-key timing), P2 (switch bypass), or P3 (failure-clear of
 * protocol-level keys) will be caught here.
 *
 * Validates: bugfix.md Expected 2.1, 2.2, 2.3, 2.6, 2.7, 2.8 + Unchanged 3.6
 * Bug Conditions: P1, P2, P3 — all FIXED, this file is now a guardrail.
 * Properties: P1, P2, P3
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';

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

// The mocks below exist purely to keep `import('./sharedSurface.js')` cheap.
// None of them are exercised by the assertions in this file; they mirror
// `sessionStick.integration.test.ts` minimal-surface pattern.
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
  isExplicitTokenExpiredError: vi.fn(() => false),
  isExplicitTokenExpirationResponse: vi.fn(() => false),
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

// Forward-looking type for the post-fix `bindSurfaceStickyChannelFromResponse`
// export added by Task 5. We feature-detect it at runtime so the test file
// compiles and runs both pre-fix (function absent) and post-fix (present).
type BindFromResponseFn = (input: {
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
}) => void;

const RESPONSES_DOWNSTREAM_PATH = '/v1/responses';
const MESSAGES_DOWNSTREAM_PATH = '/v1/messages';
const RESPONSES_MODEL = 'gpt-5';
const MESSAGES_MODEL = 'claude-sonnet-4-5';
const DOWNSTREAM_API_KEY_ID = 7;

const originalProxyStickySessionEnabled = config.proxyStickySessionEnabled;

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

/**
 * Wires {@link bindStickyChannelMock} and {@link getStickyChannelIdMock} so
 * they share an in-memory store that mirrors the real coordinator's
 * trim-empty-then-set / trim-empty-then-get semantics. Returns the backing
 * Map so individual tests can prefill or inspect it.
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
  return store;
}

/**
 * Best-effort feature detection for the post-fix `bindSurfaceStickyChannelFromResponse`
 * export. Pre-fix the symbol is `undefined`; post-fix it is a function that
 * extracts the response-side continuation id and writes the matching
 * `proto-v1|...` key to the store.
 */
function getBindFromResponse(
  surface: typeof import('./sharedSurface.js'),
): BindFromResponseFn | null {
  const candidate = (surface as unknown as Record<string, unknown>)
    .bindSurfaceStickyChannelFromResponse;
  return typeof candidate === 'function' ? (candidate as BindFromResponseFn) : null;
}

// ──────────────────────────────────────────────────────────────────────
// P1 — OpenAI Responses
// ──────────────────────────────────────────────────────────────────────
describe('P1 bug condition: OpenAI Responses sticky never hits on multi-round requests', () => {
  // REGRESSION GUARD: P1 fix (Tasks 5 + 7) wires
  // `bindSurfaceStickyChannelFromResponse` into the OpenAI Responses
  // surface success terminals so that `proto-v1|...|resp_alpha → 42` is
  // written to the store at round-1 success. If this assertion fails on a
  // future commit, the response-side bind has been broken.
  it(
    'second round carrying previous_response_id from first response should hit the first round channel',
    async () => {
      const store = installInMemoryStickyStore();
      const sharedSurface = await import('./sharedSurface.js');
      const {
        buildSurfaceStickySessionKey,
        bindSurfaceStickyChannel,
      } = sharedSurface;
      const bindFromResponse = getBindFromResponse(sharedSurface);

      // CLI-level fallback returns null when no clientContext.sessionId is
      // provided in the round-1 simulation, so the round-1 query key is null.
      buildStickySessionKeyMock.mockReturnValue(null);

      // Round 1 — request body has no previous_response_id; the upstream
      // response carries `response.id = 'resp_alpha'`, which is the
      // continuation anchor that the next round will reference.
      const round1QueryKey = buildSurfaceStickySessionKey({
        clientContext: null,
        requestedModel: RESPONSES_MODEL,
        downstreamPath: RESPONSES_DOWNSTREAM_PATH,
        downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
        parsedBody: {},
        protocolHint: 'openai/responses',
      });
      // On main HEAD the protocol-level branch returns null (no
      // previous_response_id) and the CLI fallback also returns null, so
      // round1QueryKey is null. Document the precondition to make the bug
      // mechanism obvious.
      expect(round1QueryKey).toBeNull();

      const stickyChannelId = 42;
      const account = { extraConfig: '{"credentialMode":"session"}', oauthProvider: 'openai' };

      // Pre-fix success terminal: surface code calls only the legacy
      // request-side bind. With a null/CLI key this writes nothing useful.
      bindSurfaceStickyChannel({
        stickySessionKey: round1QueryKey,
        selected: { channel: { id: stickyChannelId }, account },
      });

      // Post-fix success terminal: surface code ALSO invokes the new
      // `bindSurfaceStickyChannelFromResponse` API which extracts the
      // response-side `response.id` and writes
      // `proto-v1|...|resp_alpha → 42`. Pre-fix that function does not exist
      // and this branch is a no-op.
      if (bindFromResponse) {
        bindFromResponse({
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
      }

      // Round 2 — request body carries previous_response_id from round 1.
      // The protocol-level extractor produces a `proto-v1|...|resp_alpha`
      // query key.
      const round2QueryKey = buildSurfaceStickySessionKey({
        clientContext: null,
        requestedModel: RESPONSES_MODEL,
        downstreamPath: RESPONSES_DOWNSTREAM_PATH,
        downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
        parsedBody: { previous_response_id: 'resp_alpha' },
        protocolHint: 'openai/responses',
      });
      expect(round2QueryKey).not.toBeNull();
      expect(round2QueryKey?.startsWith('proto-v1|')).toBe(true);
      expect(round2QueryKey?.endsWith('|resp_alpha')).toBe(true);

      // Bug P1: the store was never written under `proto-v1|...|resp_alpha`
      // by the round-1 success terminal, so the round-2 lookup returns null
      // even though the same session is continuing. Post-fix the store
      // contains the response-side key and the lookup returns 42.
      expect(store.get(round2QueryKey as string)).toBe(stickyChannelId);
    },
  );

  // REGRESSION GUARD (round-1 has CLI session header, no previous_response_id):
  // a Codex CLI client carrying `OpenAI-Session-Id` will produce a CLI-level
  // fallback key on round 1 (e.g. `key:cli-session-abc:...`), not null. The
  // response-side bind MUST STILL write the protocol-level key derived from
  // `response.id` because round 2 will switch to looking THAT up. If the
  // helper early-returns on "request-side key is CLI-level", multi-round
  // sticky breaks for the most common production traffic pattern (CLIs
  // that always send a session header).
  it(
    'response-side bind should still write the protocol-level key when round-1 has a CLI-level fallback key',
    async () => {
      const store = installInMemoryStickyStore();
      const sharedSurface = await import('./sharedSurface.js');
      const { buildSurfaceStickySessionKey } = sharedSurface;
      const bindFromResponse = getBindFromResponse(sharedSurface);

      const cliRound1Key = 'key:1|codex|/v1/responses|gpt-5|cli-session-abc';
      buildStickySessionKeyMock.mockReturnValue(cliRound1Key);

      const round1QueryKey = buildSurfaceStickySessionKey({
        clientContext: { clientKind: 'codex', sessionId: 'cli-session-abc' },
        requestedModel: RESPONSES_MODEL,
        downstreamPath: RESPONSES_DOWNSTREAM_PATH,
        downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
        parsedBody: {},
        protocolHint: 'openai/responses',
      });
      expect(round1QueryKey).toBe(cliRound1Key);
      expect(round1QueryKey?.startsWith('proto-v1|')).toBe(false);

      const stickyChannelId = 42;

      if (bindFromResponse) {
        bindFromResponse({
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
          selected: { channel: { id: stickyChannelId } },
        });
      }

      const round2QueryKey = buildSurfaceStickySessionKey({
        clientContext: { clientKind: 'codex', sessionId: 'cli-session-abc' },
        requestedModel: RESPONSES_MODEL,
        downstreamPath: RESPONSES_DOWNSTREAM_PATH,
        downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
        parsedBody: { previous_response_id: 'resp_alpha' },
        protocolHint: 'openai/responses',
      });
      expect(round2QueryKey?.startsWith('proto-v1|')).toBe(true);
      expect(round2QueryKey?.endsWith('|resp_alpha')).toBe(true);

      expect(store.get(round2QueryKey as string)).toBe(stickyChannelId);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────
// P1 — Anthropic Messages
// ──────────────────────────────────────────────────────────────────────
describe('P1 bug condition: Anthropic Messages sticky never hits on multi-round tool calls', () => {
  // REGRESSION GUARD: P1 fix (Tasks 2 + 5 + 8) wires the Anthropic
  // Messages surface success terminals to extract the response-side
  // `tool_use.id` and write `proto-v1|...|toolu_alpha → 17` to the store.
  // If this assertion fails on a future commit, the Anthropic
  // response-side bind path has been broken.
  it(
    'second round carrying tool_result.tool_use_id from first response tool_use should hit the first round channel',
    async () => {
      const store = installInMemoryStickyStore();
      const sharedSurface = await import('./sharedSurface.js');
      const {
        buildSurfaceStickySessionKey,
        bindSurfaceStickyChannel,
      } = sharedSurface;
      const bindFromResponse = getBindFromResponse(sharedSurface);

      buildStickySessionKeyMock.mockReturnValue(null);

      // Round 1 — request body has no tool_result block (first turn). The
      // upstream Anthropic response includes a tool_use block with
      // `id = 'toolu_alpha'`, which is the continuation anchor for round 2.
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

      bindSurfaceStickyChannel({
        stickySessionKey: round1QueryKey,
        selected: { channel: { id: stickyChannelId }, account },
      });

      if (bindFromResponse) {
        bindFromResponse({
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
      }

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
      expect(round2QueryKey).not.toBeNull();
      expect(round2QueryKey?.startsWith('proto-v1|')).toBe(true);
      expect(round2QueryKey?.endsWith('|toolu_alpha')).toBe(true);

      // Bug P1: same shape as the OpenAI Responses scenario — the round-1
      // success terminal never writes the response-side `tool_use.id`, so
      // the round-2 lookup misses the binding even though the conversation
      // is continuing.
      expect(store.get(round2QueryKey as string)).toBe(stickyChannelId);
    },
  );

  // REGRESSION GUARD (round-1 has CLI session header, no tool_result):
  // a Claude Code CLI client carrying its own `Anthropic-Session-Id`
  // header will have round-1 produce a CLI-level fallback key (e.g.
  // `key:cli-session-abc:...`), not null. The response-side bind MUST
  // STILL write the protocol-level `proto-v1|...|toolu_alpha → 17` key
  // because round 2 will switch to looking that up. An over-eager
  // early-return on "CLI-level request key" would silently drop the
  // protocol-level write and leave the multi-round chain broken even
  // though sticky is enabled.
  it(
    'response-side bind should still write the protocol-level key when round-1 has a CLI-level fallback key',
    async () => {
      const store = installInMemoryStickyStore();
      const sharedSurface = await import('./sharedSurface.js');
      const { buildSurfaceStickySessionKey } = sharedSurface;
      const bindFromResponse = getBindFromResponse(sharedSurface);

      // Round 1 — request body has no tool_result block; CLI session
      // header produces a non-null CLI-level key.
      const cliRound1Key = 'key:1|codex|/v1/messages|claude-sonnet-4-5|cli-session-abc';
      buildStickySessionKeyMock.mockReturnValue(cliRound1Key);

      const round1QueryKey = buildSurfaceStickySessionKey({
        clientContext: { clientKind: 'codex', sessionId: 'cli-session-abc' },
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
      expect(round1QueryKey).toBe(cliRound1Key);
      expect(round1QueryKey?.startsWith('proto-v1|')).toBe(false);

      const stickyChannelId = 17;

      if (bindFromResponse) {
        bindFromResponse({
          requestSideStickySessionKey: round1QueryKey,
          protocolHint: 'anthropic/messages',
          responsePayload: {
            id: 'msg_round1',
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_alpha', name: 'search', input: {} },
            ],
          },
          scope: {
            downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
            downstreamPath: MESSAGES_DOWNSTREAM_PATH,
            requestedModel: MESSAGES_MODEL,
          },
          selected: { channel: { id: stickyChannelId } },
        });
      }

      const round2QueryKey = buildSurfaceStickySessionKey({
        clientContext: { clientKind: 'codex', sessionId: 'cli-session-abc' },
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
      expect(round2QueryKey?.startsWith('proto-v1|')).toBe(true);
      expect(round2QueryKey?.endsWith('|toolu_alpha')).toBe(true);

      expect(store.get(round2QueryKey as string)).toBe(stickyChannelId);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────
// P2 — protocol-level path bypasses the proxyStickySessionEnabled switch
// ──────────────────────────────────────────────────────────────────────
describe('P2 bug condition: protocol-level sticky bypasses the proxyStickySessionEnabled switch', () => {
  // REGRESSION GUARD: P2 fix (Task 4) added the
  // `proxyStickySessionEnabled` guard to the protocol-level branch of
  // `buildSurfaceStickySessionKey`. If this assertion fails on a future
  // commit, the switch is once again being bypassed for protocol-level
  // continuation ids.
  it(
    'buildSurfaceStickySessionKey should return null when proxyStickySessionEnabled is false',
    async () => {
      // CLI-level fallback returns null when the switch is off (verified by
      // the real coordinator). We mock it to null so the only surviving path
      // that could yield a non-null result is the protocol-level branch.
      buildStickySessionKeyMock.mockReturnValue(null);
      config.proxyStickySessionEnabled = false;

      const { buildSurfaceStickySessionKey } = await import('./sharedSurface.js');

      const result = buildSurfaceStickySessionKey({
        clientContext: { clientKind: 'codex', sessionId: 'cli-session-abc' },
        requestedModel: RESPONSES_MODEL,
        downstreamPath: RESPONSES_DOWNSTREAM_PATH,
        downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
        parsedBody: { previous_response_id: 'resp_switch_off' },
        protocolHint: 'openai/responses',
      });

      // Bug P2: on main HEAD the protocol-level branch does not consult
      // `config.proxyStickySessionEnabled` and returns
      // `proto-v1|...|resp_switch_off`, locking the request into the
      // session-scoped channel lease pool against the user's intent.
      expect(result).toBeNull();
    },
  );

  // REGRESSION GUARD: P2 lease-pool corollary — with the switch off,
  // `buildSurfaceStickySessionKey` returns null and the lease helper
  // therefore passes `channelId: 0` (the no-op lease branch). If this
  // assertion fails on a future commit, the user's intent to disable
  // session affinity is no longer being honored at the lease pool.
  it(
    'acquireSurfaceChannelLease should receive channelId === 0 when proxyStickySessionEnabled is false',
    async () => {
      buildStickySessionKeyMock.mockReturnValue(null);
      acquireChannelLeaseMock.mockResolvedValue({
        status: 'acquired',
        lease: { release: () => {}, keepAlive: () => {} },
      });
      config.proxyStickySessionEnabled = false;

      const {
        buildSurfaceStickySessionKey,
        acquireSurfaceChannelLease,
      } = await import('./sharedSurface.js');

      const stickyKey = buildSurfaceStickySessionKey({
        clientContext: { clientKind: 'codex', sessionId: 'cli-session-abc' },
        requestedModel: RESPONSES_MODEL,
        downstreamPath: RESPONSES_DOWNSTREAM_PATH,
        downstreamApiKeyId: DOWNSTREAM_API_KEY_ID,
        parsedBody: { previous_response_id: 'resp_switch_off' },
        protocolHint: 'openai/responses',
      });

      await acquireSurfaceChannelLease({
        stickySessionKey: stickyKey,
        selected: {
          channel: { id: 42 },
          account: { extraConfig: '{}', oauthProvider: 'openai' },
        },
      });

      // Bug P2 corollary: pre-fix `stickyKey` is non-null, so the lease
      // helper passes `channelId: 42` and the request is funneled into the
      // per-channel lease pool. Post-fix `stickyKey` is null so the helper
      // passes `channelId: 0` (the no-op lease branch) and the user's
      // intent — disable session affinity — is honored.
      expect(acquireChannelLeaseMock).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 0 }),
      );
    },
  );
});

// ──────────────────────────────────────────────────────────────────────
// P3 — failure terminals erroneously clear protocol-level bindings
// ──────────────────────────────────────────────────────────────────────
describe('P3 bug condition: clearSurfaceStickyChannel erroneously clears protocol-level bindings on failure', () => {
  // REGRESSION GUARD: P3 fix (Task 6) added the `proto-v1|` prefix
  // short-circuit inside `clearSurfaceStickyChannel`. Failure terminals
  // must NOT clear protocol-level bindings (spec session-stick-routing
  // Requirements 6.4 + 8.4). If this assertion fails on a future commit,
  // single-failure clearing has overshot into the protocol-level path.
  it(
    'clearSurfaceStickyChannel should noop when called with a proto-v1 key (failure-preserve invariant)',
    async () => {
      const { clearSurfaceStickyChannel } = await import('./sharedSurface.js');

      const protocolKey = 'proto-v1|key:1|/v1/responses|gpt-5|openai/responses|resp_X';

      clearSurfaceStickyChannel({
        stickySessionKey: protocolKey,
        selected: { channel: { id: 42 } },
      });

      // Bug P3: on main HEAD the surface helper unconditionally forwards to
      // `proxyChannelCoordinator.clearStickyChannel`, which deletes the
      // protocol-level binding on every failure terminal (lease timeout,
      // streamFailed, detectProxyFailure, top-level catch). This violates
      // the spec's "single-failure does not clear sticky" contract
      // (Requirements 6.4 + 8.4 of the original session-stick-routing
      // feature). Post-fix the helper short-circuits on the `proto-v1|`
      // prefix and the coordinator is never invoked.
      expect(clearStickyChannelMock).not.toHaveBeenCalled();
    },
  );

  // Sanity check (regular `it`, not `.fails`): CLI-level keys must continue
  // to be cleared on failure to preserve pre-feature behaviour. This guard
  // passes both on main HEAD and after the fix; if it ever transitions to
  // failing, the P3 fix has overshot and broken the legacy CLI-level path.
  it('clearSurfaceStickyChannel should still forward CLI-level keys to the coordinator', async () => {
    const { clearSurfaceStickyChannel } = await import('./sharedSurface.js');

    const cliKey = 'key:1|codex|/v1/responses|gpt-5|cli-session-abc';

    clearSurfaceStickyChannel({
      stickySessionKey: cliKey,
      selected: { channel: { id: 42 } },
    });

    expect(clearStickyChannelMock).toHaveBeenCalledTimes(1);
    expect(clearStickyChannelMock).toHaveBeenCalledWith(cliKey, 42);
  });
});
