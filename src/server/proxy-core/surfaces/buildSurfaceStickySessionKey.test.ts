/**
 * Unit tests for the extended {@link buildSurfaceStickySessionKey} surface
 * dispatcher introduced by Task 5 of the `session-stick-routing` spec.
 *
 * The function defines the **single, centralized priority order** between the
 * protocol-level continuation key (this feature) and the legacy CLI-level
 * `proxyChannelCoordinator.buildStickySessionKey` path. This file pins three
 * groups of behaviour:
 *
 * 1. **Protocol-level path:** when `parsedBody` is paired with a truthy
 *    `protocolHint` and the matching transformer-pure extractor returns a
 *    non-null continuation identifier, the result is a `proto-v1|...` string
 *    composed by `buildProtocolSessionKey`. The CLI-level fallback mock MUST
 *    NOT be invoked in this case.
 * 2. **CLI-level fallback equivalence:** when `parsedBody` / `protocolHint`
 *    are absent, falsy, or the extractor returns `null`, the function is
 *    byte-equivalent to the pre-feature `proxyChannelCoordinator
 *    .buildStickySessionKey` call shape and forwards the same five fields.
 * 3. **Defensive fallback (Requirement 1.5):** the protocol-level branch is
 *    wrapped in a `try/catch`. A direct runtime injection of a thrown error
 *    from `buildProtocolSessionKey` is intentionally NOT exercised here,
 *    because:
 *    - `buildSurfaceStickySessionKey` and `buildProtocolSessionKey` live in
 *      the same module, so `vi.spyOn` on the export site does not intercept
 *      the same-module reference path actually taken at runtime.
 *    - `buildProtocolSessionKey` is a pure string-composition helper whose
 *      only operations on user-supplied input are property reads, type
 *      checks, `String(...)` coercion, and `String.prototype.trim()` — none
 *      of which can throw on the documented input shapes.
 *    The contract that `buildProtocolSessionKey` does not throw on any
 *    documented input shape is covered by `buildProtocolSessionKey.test.ts`,
 *    which pins the static condition that makes the `try/catch` provably
 *    dead code at the unit level while preserving it as a runtime safety
 *    net.
 *
 * Validates: Requirements 1.5, 3.1, 3.2, 3.3, 5.1, 5.2, 5.4, 11.3
 * Properties: P3, P4, P5, P9
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildStickySessionKeyMock = vi.fn();
const getStickyChannelIdMock = vi.fn();
const bindStickyChannelMock = vi.fn();
const clearStickyChannelMock = vi.fn();
const acquireChannelLeaseMock = vi.fn();

// Mocks unrelated to this file are kept minimal; their only purpose is to
// make `import('./sharedSurface.js')` cheap. Mirrors the pattern in
// `sharedSurface.usage-source.test.ts`.
vi.mock('../../services/localTimeService.js', () => ({
  formatUtcSqlDateTime: vi.fn(),
}));

vi.mock('../../services/siteProxy.js', () => ({
  resolveChannelProxyUrl: vi.fn(),
  withSiteRecordProxyRequestInit: vi.fn(),
}));

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
  },
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: vi.fn(),
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
}));

vi.mock('../../services/proxyLogMessage.js', () => ({
  composeProxyLogMessage: vi.fn(),
}));

vi.mock('../../services/proxyBilling.js', () => ({
  resolveProxyLogBilling: vi.fn(),
}));

vi.mock('../../services/proxyLogStore.js', () => ({
  insertProxyLog: vi.fn(),
}));

vi.mock('../../services/runtimeDispatch.js', () => ({
  dispatchRuntimeRequest: vi.fn(),
}));

vi.mock('../orchestration/upstreamRequest.js', () => ({
  buildUpstreamUrl: vi.fn(),
}));

vi.mock('../../services/oauth/quota.js', () => ({
  recordOauthQuotaHeadersSnapshot: vi.fn(),
  recordOauthQuotaResetHint: vi.fn(),
}));

vi.mock('../../services/oauth/refreshSingleflight.js', () => ({
  refreshOauthAccessTokenSingleflight: vi.fn(),
}));

// The CLI-level fallback target. We need real call recording on
// `buildStickySessionKey` to assert (a) it is bypassed on the protocol-level
// path, and (b) it receives the legacy five-field shape on the fallback
// path.
vi.mock('../../services/proxyChannelCoordinator.js', () => ({
  proxyChannelCoordinator: {
    buildStickySessionKey: (...args: unknown[]) => buildStickySessionKeyMock(...args),
    getStickyChannelId: (...args: unknown[]) => getStickyChannelIdMock(...args),
    bindStickyChannel: (...args: unknown[]) => bindStickyChannelMock(...args),
    clearStickyChannel: (...args: unknown[]) => clearStickyChannelMock(...args),
    acquireChannelLease: (...args: unknown[]) => acquireChannelLeaseMock(...args),
  },
}));

vi.mock('../executors/types.js', () => ({
  readRuntimeResponseText: vi.fn(),
}));

vi.mock('../channelSelection.js', () => ({
  selectProxyChannelForAttempt: vi.fn(),
}));

beforeEach(() => {
  buildStickySessionKeyMock.mockReset();
  getStickyChannelIdMock.mockReset();
  bindStickyChannelMock.mockReset();
  clearStickyChannelMock.mockReset();
  acquireChannelLeaseMock.mockReset();
});

describe('buildSurfaceStickySessionKey - protocol-level path', () => {
  it('returns a proto-v1 key for OpenAI Responses with a valid previous_response_id', async () => {
    const { buildSurfaceStickySessionKey } = await import('./sharedSurface.js');

    const result = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'codex', sessionId: 'cli-session-irrelevant' },
      requestedModel: 'gpt-5',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 7,
      parsedBody: { previous_response_id: 'resp_openai_first' },
      protocolHint: 'openai/responses',
    });

    expect(typeof result).toBe('string');
    expect(result?.startsWith('proto-v1|')).toBe(true);
    // Scope must include the protocol identifier and the continuation token.
    expect(result?.includes('|openai/responses|')).toBe(true);
    expect(result?.endsWith('|resp_openai_first')).toBe(true);
    // CLI-level fallback MUST be bypassed entirely.
    expect(buildStickySessionKeyMock).not.toHaveBeenCalled();
  });

  it('returns a proto-v1 key for Anthropic Messages with a valid tool_result.tool_use_id', async () => {
    const { buildSurfaceStickySessionKey } = await import('./sharedSurface.js');

    const result = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'claude', sessionId: 'cli-session-irrelevant' },
      requestedModel: 'claude-sonnet-4-5',
      downstreamPath: '/v1/messages',
      downstreamApiKeyId: 9,
      parsedBody: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_anthropic_first', content: 'ok' },
            ],
          },
        ],
      },
      protocolHint: 'anthropic/messages',
    });

    expect(typeof result).toBe('string');
    expect(result?.startsWith('proto-v1|')).toBe(true);
    expect(result?.includes('|anthropic/messages|')).toBe(true);
    expect(result?.endsWith('|toolu_anthropic_first')).toBe(true);
    expect(buildStickySessionKeyMock).not.toHaveBeenCalled();
  });

  it('picks the last tool_result block in document order for Anthropic Messages', async () => {
    const { buildSurfaceStickySessionKey } = await import('./sharedSurface.js');

    const result = buildSurfaceStickySessionKey({
      requestedModel: 'claude-sonnet-4-5',
      downstreamPath: '/v1/messages',
      downstreamApiKeyId: 9,
      parsedBody: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_first', content: 'a' },
              { type: 'tool_result', tool_use_id: 'toolu_last', content: 'b' },
            ],
          },
        ],
      },
      protocolHint: 'anthropic/messages',
    });

    // The composed key MUST end with the last tool_use_id, not the first.
    expect(result?.endsWith('|toolu_last')).toBe(true);
    expect(result?.includes('toolu_first')).toBe(false);
    expect(buildStickySessionKeyMock).not.toHaveBeenCalled();
  });
});

describe('buildSurfaceStickySessionKey - CLI-level fallback equivalence', () => {
  it('forwards the legacy five-field shape when parsedBody and protocolHint are not provided', async () => {
    buildStickySessionKeyMock.mockReturnValue('cli-key-X');
    const { buildSurfaceStickySessionKey } = await import('./sharedSurface.js');

    const result = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'codex', sessionId: 'session-abc' },
      requestedModel: 'gpt-5',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 7,
    });

    // Output must be byte-equivalent to whatever the CLI-level helper returned.
    expect(result).toBe('cli-key-X');
    // The mock must receive the legacy five-field shape.
    expect(buildStickySessionKeyMock).toHaveBeenCalledTimes(1);
    expect(buildStickySessionKeyMock).toHaveBeenCalledWith({
      clientKind: 'codex',
      sessionId: 'session-abc',
      requestedModel: 'gpt-5',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 7,
    });
  });

  it('forwards null fields when clientContext is null', async () => {
    buildStickySessionKeyMock.mockReturnValue(null);
    const { buildSurfaceStickySessionKey } = await import('./sharedSurface.js');

    const result = buildSurfaceStickySessionKey({
      clientContext: null,
      requestedModel: 'gpt-5',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: undefined,
    });

    expect(result).toBeNull();
    expect(buildStickySessionKeyMock).toHaveBeenCalledTimes(1);
    expect(buildStickySessionKeyMock).toHaveBeenCalledWith({
      clientKind: null,
      sessionId: null,
      requestedModel: 'gpt-5',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: undefined,
    });
  });

  it.each<{ description: string; protocolHint: 'openai/responses' | 'anthropic/messages' | null | undefined | '' }>([
    { description: 'null', protocolHint: null },
    { description: 'undefined', protocolHint: undefined },
    { description: 'empty string', protocolHint: '' as ''},
  ])('falls back to CLI-level when protocolHint is $description (parsedBody present)', async ({ protocolHint }) => {
    buildStickySessionKeyMock.mockReturnValue('cli-fallback');
    const { buildSurfaceStickySessionKey } = await import('./sharedSurface.js');

    const result = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'codex', sessionId: 'session-abc' },
      requestedModel: 'gpt-5',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 7,
      parsedBody: { previous_response_id: 'resp_should_be_ignored' },
      // The protocol-level branch is gated by `protocolHint` truthiness.
      protocolHint: protocolHint as 'openai/responses' | 'anthropic/messages' | null,
    });

    expect(result).toBe('cli-fallback');
    expect(buildStickySessionKeyMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to CLI-level when parsedBody is undefined even with a truthy protocolHint', async () => {
    buildStickySessionKeyMock.mockReturnValue('cli-fallback-no-body');
    const { buildSurfaceStickySessionKey } = await import('./sharedSurface.js');

    const result = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'codex', sessionId: 'session-abc' },
      requestedModel: 'gpt-5',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 7,
      // parsedBody intentionally omitted; the `parsedBody !== undefined` guard
      // is therefore false, so the protocol-level branch is skipped.
      protocolHint: 'openai/responses',
    });

    expect(result).toBe('cli-fallback-no-body');
    expect(buildStickySessionKeyMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to CLI-level when OpenAI Responses extractor returns null (missing previous_response_id)', async () => {
    buildStickySessionKeyMock.mockReturnValue('cli-key-when-extractor-null');
    const { buildSurfaceStickySessionKey } = await import('./sharedSurface.js');

    const result = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'codex', sessionId: 'session-abc' },
      requestedModel: 'gpt-5',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 7,
      // No `previous_response_id` field — extractor returns null.
      parsedBody: { model: 'gpt-5', input: 'hello' },
      protocolHint: 'openai/responses',
    });

    expect(result).toBe('cli-key-when-extractor-null');
    expect(buildStickySessionKeyMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to CLI-level when Anthropic Messages extractor returns null (no tool_result block)', async () => {
    buildStickySessionKeyMock.mockReturnValue('cli-key-when-no-tool-result');
    const { buildSurfaceStickySessionKey } = await import('./sharedSurface.js');

    const result = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'claude', sessionId: 'session-xyz' },
      requestedModel: 'claude-sonnet-4-5',
      downstreamPath: '/v1/messages',
      downstreamApiKeyId: 9,
      parsedBody: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'no tool_result here' },
            ],
          },
        ],
      },
      protocolHint: 'anthropic/messages',
    });

    expect(result).toBe('cli-key-when-no-tool-result');
    expect(buildStickySessionKeyMock).toHaveBeenCalledTimes(1);
  });

  it('falls back byte-equivalent for OpenAI Responses with empty/whitespace previous_response_id', async () => {
    buildStickySessionKeyMock.mockReturnValue('cli-key-empty-previous');
    const { buildSurfaceStickySessionKey } = await import('./sharedSurface.js');

    const result = buildSurfaceStickySessionKey({
      clientContext: { clientKind: 'codex', sessionId: 'session-abc' },
      requestedModel: 'gpt-5',
      downstreamPath: '/v1/responses',
      downstreamApiKeyId: 7,
      parsedBody: { previous_response_id: '   ' },
      protocolHint: 'openai/responses',
    });

    // Whitespace-only continuation IDs cause the extractor to return null,
    // so the CLI-level path takes over.
    expect(result).toBe('cli-key-empty-previous');
    expect(buildStickySessionKeyMock).toHaveBeenCalledTimes(1);
  });
});
