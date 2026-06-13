import { describe, expect, it, vi } from 'vitest';

import {
  ANON_DOWNSTREAM_API_KEY_SENTINEL,
  buildProtocolSessionKey,
  type ProtocolSessionKeyInput,
} from './sharedSurface.js';

// `buildProtocolSessionKey` is a pure string-composition helper, but it lives
// in `sharedSurface.ts`, which transitively imports modules that connect to
// the database / runtime services at module load time (token router, runtime
// dispatch, log store, etc.). The mocks below exist purely to keep the import
// of `./sharedSurface.js` cheap in test mode; none of these mocks are invoked
// by the assertions in this file.
//
// The mock list mirrors `sharedSurface.usage-source.test.ts`, which is the
// existing minimal-surface pattern in this directory.
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

vi.mock('../../services/proxyChannelCoordinator.js', () => ({
  proxyChannelCoordinator: {
    buildStickySessionKey: vi.fn(),
    getStickyChannelId: vi.fn(),
    bindStickyChannel: vi.fn(),
    clearStickyChannel: vi.fn(),
    acquireChannelLease: vi.fn(),
  },
}));

vi.mock('../executors/types.js', () => ({
  readRuntimeResponseText: vi.fn(),
}));

vi.mock('../channelSelection.js', () => ({
  selectProxyChannelForAttempt: vi.fn(),
}));

/**
 * Unit tests for {@link buildProtocolSessionKey}.
 *
 * Pure string-composition helper introduced by Task 4 of the
 * `session-stick-routing` spec. The tests below cover:
 *
 * - **Property 4 (scope decoupling):** any single-field difference in the
 *   five-tuple `(downstreamApiKeyId, downstreamPath, requestedModel,
 *   protocolId, continuationId)` MUST produce a distinct output string.
 * - **Property 5 (anonymous keyId sentinel consistency):** any
 *   non-positive-integer `downstreamApiKeyId` (null, undefined, 0, negatives,
 *   non-integers, NaN) MUST collapse to `'key:anon'` and MUST NOT leak the
 *   raw value into the output string.
 * - **Format invariants:** every legal call returns a string starting with
 *   `'proto-v1|'`; empty/whitespace `path` is replaced with `/`;
 *   empty/whitespace `model` is replaced with `_`; surrounding whitespace on
 *   `continuationId` is stripped.
 * - **Robustness:** unusual but non-malicious inputs (Infinity, control
 *   characters, very long strings) MUST NOT throw. This robustness test
 *   indirectly covers Requirement 1.5 / Property 9 — the
 *   `buildSurfaceStickySessionKey` `try/catch` exists as a defensive
 *   guardrail; same-module limitations make injecting an in-process throw
 *   from this helper impractical, so we instead pin the contract that this
 *   function does not throw under any documented input shape.
 *
 * Validates: Requirements 3.1, 3.2, 3.3
 * Properties: P4, P5
 */
describe('buildProtocolSessionKey', () => {
  // ---------------------------------------------------------------------------
  // Property 4 — scope decoupling.
  //
  // Each row carries two five-tuples that differ in exactly one field; the
  // resulting protocol session key strings must therefore be distinct. The
  // last row uses two completely distinct tuples as a sanity baseline.
  // ---------------------------------------------------------------------------
  const baseTuple: ProtocolSessionKeyInput = {
    downstreamApiKeyId: 1,
    downstreamPath: '/v1/responses',
    requestedModel: 'gpt-5',
    protocolId: 'openai/responses',
    continuationId: 'resp_a',
  };

  it.each<{ description: string; t1: ProtocolSessionKeyInput; t2: ProtocolSessionKeyInput }>([
    {
      description: 'differing downstreamApiKeyId yields distinct keys',
      t1: baseTuple,
      t2: { ...baseTuple, downstreamApiKeyId: 2 },
    },
    {
      description: 'differing downstreamPath yields distinct keys',
      t1: baseTuple,
      t2: { ...baseTuple, downstreamPath: '/v1/messages' },
    },
    {
      description: 'differing requestedModel yields distinct keys',
      t1: baseTuple,
      t2: { ...baseTuple, requestedModel: 'gpt-4' },
    },
    {
      description: 'differing protocolId yields distinct keys',
      t1: baseTuple,
      t2: { ...baseTuple, protocolId: 'anthropic/messages' },
    },
    {
      description: 'differing continuationId yields distinct keys',
      t1: baseTuple,
      t2: { ...baseTuple, continuationId: 'resp_b' },
    },
    {
      description: 'completely distinct tuples yield distinct keys',
      t1: baseTuple,
      t2: {
        downstreamApiKeyId: 99,
        downstreamPath: '/v1/messages',
        requestedModel: 'claude-sonnet-4-5',
        protocolId: 'anthropic/messages',
        continuationId: 'toolu_z',
      },
    },
  ])('Property 4: $description', ({ t1, t2 }) => {
    const k1 = buildProtocolSessionKey(t1);
    const k2 = buildProtocolSessionKey(t2);
    expect(typeof k1).toBe('string');
    expect(typeof k2).toBe('string');
    expect(k1).not.toBe(k2);
  });

  // ---------------------------------------------------------------------------
  // Property 5 — anonymous keyId sentinel consistency.
  //
  // Any non-positive-integer keyId must route to ANON_DOWNSTREAM_API_KEY_SENTINEL
  // (`'key:anon'`). The output must NOT contain literal substrings derived
  // from the raw value (e.g. `key:0`, `key:-1`, `key:NaN`, `key:undefined`,
  // `key:0.5`). The base tuple's other fields are held fixed so failure
  // signatures are easy to read.
  // ---------------------------------------------------------------------------
  const SENTINEL = ANON_DOWNSTREAM_API_KEY_SENTINEL;

  it.each<{ description: string; keyId: ProtocolSessionKeyInput['downstreamApiKeyId'] }>([
    { description: 'null', keyId: null },
    { description: 'undefined', keyId: undefined },
    { description: 'zero', keyId: 0 },
    { description: 'negative integer', keyId: -1 },
    { description: 'positive non-integer', keyId: 0.5 },
    { description: 'NaN', keyId: Number.NaN },
  ])('Property 5: keyId=$description routes to anon sentinel and never leaks raw value', ({ keyId }) => {
    const result = buildProtocolSessionKey({
      downstreamApiKeyId: keyId,
      downstreamPath: '/v1/responses',
      requestedModel: 'gpt-5',
      protocolId: 'openai/responses',
      continuationId: 'resp_anon',
    });

    // Sentinel MUST appear (Requirement 3.3).
    expect(result.includes(SENTINEL)).toBe(true);

    // No anomalous literal forms of the raw keyId may leak through.
    expect(result.includes('key:0|')).toBe(false);
    expect(result.includes('key:-1')).toBe(false);
    expect(result.includes('key:undefined')).toBe(false);
    expect(result.includes('key:NaN')).toBe(false);
    expect(result.includes('key:0.5')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Format invariants.
  // ---------------------------------------------------------------------------
  it('every legal output starts with the proto-v1 namespace prefix', () => {
    const result = buildProtocolSessionKey({
      downstreamApiKeyId: 1,
      downstreamPath: '/v1/responses',
      requestedModel: 'gpt-5',
      protocolId: 'openai/responses',
      continuationId: 'resp_x',
    });
    expect(result.startsWith('proto-v1|')).toBe(true);
  });

  it.each<{ description: string; downstreamPath: string }>([
    { description: 'empty string', downstreamPath: '' },
    { description: 'whitespace-only string', downstreamPath: '   ' },
  ])('uses "/" placeholder when downstreamPath is $description', ({ downstreamPath }) => {
    const result = buildProtocolSessionKey({
      downstreamApiKeyId: 1,
      downstreamPath,
      requestedModel: 'gpt-5',
      protocolId: 'openai/responses',
      continuationId: 'resp_x',
    });
    // Output shape is `proto-v1|key:1|/|gpt-5|openai/responses|resp_x` — the
    // sandwich `|/|` MUST appear when the path falls back to the placeholder.
    expect(result.includes('|/|')).toBe(true);
  });

  it.each<{ description: string; requestedModel: string }>([
    { description: 'empty string', requestedModel: '' },
    { description: 'whitespace-only string', requestedModel: '   ' },
  ])('uses "_" placeholder when requestedModel is $description', ({ requestedModel }) => {
    const result = buildProtocolSessionKey({
      downstreamApiKeyId: 1,
      downstreamPath: '/v1/responses',
      requestedModel,
      protocolId: 'openai/responses',
      continuationId: 'resp_x',
    });
    // Output shape is `proto-v1|key:1|/v1/responses|_|openai/responses|resp_x`
    // so the `|_|` sandwich MUST appear.
    expect(result.includes('|_|')).toBe(true);
  });

  it('trims surrounding whitespace from continuationId', () => {
    const result = buildProtocolSessionKey({
      downstreamApiKeyId: 1,
      downstreamPath: '/v1/responses',
      requestedModel: 'gpt-5',
      protocolId: 'openai/responses',
      continuationId: '  resp_x  ',
    });
    // The trimmed continuation must appear at the tail without trailing
    // whitespace; `'  resp_x'` and `'resp_x  '` would both indicate a bug.
    expect(result.endsWith('|resp_x')).toBe(true);
    expect(result.includes('|resp_x ')).toBe(false);
    expect(result.includes(' resp_x|')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Robustness: unusual key ids remain supported, while unsafe continuation
  // identifiers are rejected before they can create unbounded or ambiguous
  // sticky-map keys. Surface callers own the non-fatal fallback behavior.
  // ---------------------------------------------------------------------------
  it.each<{ description: string; input: ProtocolSessionKeyInput }>([
    {
      description: 'positive Infinity keyId',
      input: {
        downstreamApiKeyId: Number.POSITIVE_INFINITY,
        downstreamPath: '/v1/responses',
        requestedModel: 'gpt-5',
        protocolId: 'openai/responses',
        continuationId: 'resp_inf',
      },
    },
    {
      description: 'negative Infinity keyId',
      input: {
        downstreamApiKeyId: Number.NEGATIVE_INFINITY,
        downstreamPath: '/v1/responses',
        requestedModel: 'gpt-5',
        protocolId: 'openai/responses',
        continuationId: 'resp_neginf',
      },
    },
  ])('does not throw on $description', ({ input }) => {
    expect(() => buildProtocolSessionKey(input)).not.toThrow();
    const result = buildProtocolSessionKey(input);
    expect(typeof result).toBe('string');
    expect(result.startsWith('proto-v1|')).toBe(true);
  });

  it.each<{ description: string; continuationId: string }>([
    {
      description: 'a NUL byte',
      continuationId: '\u0000resp_nul\u0000',
    },
    {
      description: 'an overlong value',
      continuationId: 'a'.repeat(8192),
    },
  ])('rejects continuationId containing $description', ({ continuationId }) => {
    expect(() => buildProtocolSessionKey({
      downstreamApiKeyId: 1,
      downstreamPath: '/v1/responses',
      requestedModel: 'gpt-5',
      protocolId: 'openai/responses',
      continuationId,
    })).toThrow('Invalid protocol continuation identifier');
  });

  it('keeps delimiter-bearing model and continuation fields collision-free', () => {
    const first = buildProtocolSessionKey({
      downstreamApiKeyId: 1,
      downstreamPath: '/v1/responses',
      requestedModel: 'model|openai/responses',
      protocolId: 'openai/responses',
      continuationId: 'resp',
    });
    const second = buildProtocolSessionKey({
      downstreamApiKeyId: 1,
      downstreamPath: '/v1/responses',
      requestedModel: 'model',
      protocolId: 'openai/responses',
      continuationId: 'openai/responses|resp',
    });

    expect(first).not.toBe(second);
    expect(first).toContain('model%7Copenai/responses');
    expect(second).toContain('openai/responses%7Cresp');
  });
});
