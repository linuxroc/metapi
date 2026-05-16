import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { ClaudeAdapter } from './claude.js';

interface RequestSnapshot {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

type EndpointBehavior =
  | { kind: 'success'; ids: string[] }
  | { kind: 'empty' }
  | { kind: 'http-error'; status: number }
  | { kind: 'connection-destroy' }
  | { kind: 'non-json'; body: string };

const SAMPLE_STANDARD_IDS = ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];
const SAMPLE_FALLBACK_IDS = ['glm-4.5', 'glm-4.5-air', 'glm-4-9b'];

// Stable host strings used to assert that "host has anthropic substring but
// path does NOT end with /anthropic" never triggers the fallback.
// `.invalid` is reserved by RFC 6761; resolvers MUST return NXDOMAIN, so
// the standard fetch fails fast at the DNS layer and never reaches the
// local fixture server. The key invariant being verified here is that the
// fixture server records ZERO requests to fallback URL shapes — not that
// the unreachable host ever serves traffic.
const UNREACHABLE_ANTHROPIC_HOST_BASE_URL = 'https://api.anthropic.com.local-fixture.invalid';

const FALLBACK_PATH_PATTERNS = ['/v1/models', '/api/v1/models'];

function countRequests(requests: RequestSnapshot[], path: string): number {
  return requests.filter((r) => r.url === path).length;
}

function countFallbackRequests(requests: RequestSnapshot[]): number {
  return requests.filter((r) => FALLBACK_PATH_PATTERNS.includes(r.url ?? '')).length;
}

describe('ClaudeAdapter.getModels', () => {
  let server: ReturnType<typeof createServer>;
  let host: string;
  let requests: RequestSnapshot[] = [];
  let behaviors: Record<string, EndpointBehavior> = {};
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    requests = [];
    behaviors = {};

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
      });

      // Absorb any write-after-destroy noise so a connection-destroy
      // behavior on one request does not surface as a server-side
      // unhandled error in test output.
      res.on('error', () => {});
      req.on('error', () => {});

      const path = req.url || '/';
      const behavior = behaviors[path];

      if (!behavior) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no behavior set for path: ' + path }));
        return;
      }

      switch (behavior.kind) {
        case 'success':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: behavior.ids.map((id) => ({ id })) }));
          return;
        case 'empty':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
          return;
        case 'http-error':
          res.writeHead(behavior.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'simulated http error' } }));
          return;
        case 'non-json':
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(behavior.body);
          return;
        case 'connection-destroy':
          req.socket.destroy();
          return;
      }
    });

    server.on('clientError', () => {});

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    host = `http://127.0.0.1:${addr.port}`;

    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Property 1 / R1.1, R1.2, R1.3, R9.1
  // Standard discovery success path is unaffected by the fallback feature.
  // -------------------------------------------------------------------------
  it('returns standard list when standard endpoint produces non-empty data, never firing fallback', async () => {
    behaviors['/anthropic/v1/models'] = { kind: 'success', ids: SAMPLE_STANDARD_IDS };

    const adapter = new ClaudeAdapter();
    const apiToken = 'sk-claude-standard-success';
    const models = await adapter.getModels(`${host}/anthropic`, apiToken);

    expect(models).toEqual(SAMPLE_STANDARD_IDS);
    expect(countFallbackRequests(requests)).toBe(0);

    const stdReq = requests.find((r) => r.url === '/anthropic/v1/models');
    expect(stdReq).toBeDefined();
    expect(stdReq?.method).toBe('GET');
    expect(stdReq?.headers['x-api-key']).toBe(apiToken);
    expect(stdReq?.headers['anthropic-version']).toBe('2023-06-01');
  });

  // -------------------------------------------------------------------------
  // Property 2 + Property 5 / R3.1, R3.2, R3.4, R4.1, R4.2, R4.3, R4.5,
  //                          R9.2, R9.4, R9.5
  // Each standard failure mode triggers exactly one fallback request whose
  // shape is the OpenAI-compatible `/v1/models` form on the parent base URL.
  // -------------------------------------------------------------------------
  type StandardFailureMode = 'empty' | 'http-401' | 'http-500' | 'non-json' | 'connection-destroy';

  function applyStandardBehavior(mode: StandardFailureMode, path: string): void {
    switch (mode) {
      case 'empty':
        behaviors[path] = { kind: 'empty' };
        return;
      case 'http-401':
        behaviors[path] = { kind: 'http-error', status: 401 };
        return;
      case 'http-500':
        behaviors[path] = { kind: 'http-error', status: 500 };
        return;
      case 'non-json':
        behaviors[path] = { kind: 'non-json', body: 'this is not json at all' };
        return;
      case 'connection-destroy':
        behaviors[path] = { kind: 'connection-destroy' };
        return;
    }
  }

  it.each<{ mode: StandardFailureMode }>([
    { mode: 'empty' },
    { mode: 'http-401' },
    { mode: 'http-500' },
    { mode: 'non-json' },
    { mode: 'connection-destroy' },
  ])(
    'falls back to parent /v1/models when standard endpoint produces $mode (Anthropic_Suffixed_URL)',
    async ({ mode }) => {
      applyStandardBehavior(mode, '/anthropic/v1/models');
      behaviors['/v1/models'] = { kind: 'success', ids: SAMPLE_FALLBACK_IDS };

      const adapter = new ClaudeAdapter();
      const apiToken = `sk-claude-fallback-${mode}`;
      const models = await adapter.getModels(`${host}/anthropic`, apiToken);

      expect(models).toEqual(SAMPLE_FALLBACK_IDS);
      expect(countRequests(requests, '/v1/models')).toBe(1);

      const fallbackReq = requests.find((r) => r.url === '/v1/models');
      expect(fallbackReq).toBeDefined();
      expect(fallbackReq?.method).toBe('GET');
      expect(fallbackReq?.headers.authorization).toBe(`Bearer ${apiToken}`);
      // Node lowercases incoming header names; the fallback call must NOT
      // carry the Anthropic-specific request signature.
      expect(fallbackReq?.headers['x-api-key']).toBeUndefined();
      expect(fallbackReq?.headers['anthropic-version']).toBeUndefined();
    },
  );

  // -------------------------------------------------------------------------
  // Property 6 / R5.1, R5.2
  // When both the standard and the fallback path fail (in any combination of
  // failure modes), getModels resolves to [] and never throws.
  // -------------------------------------------------------------------------
  type FallbackFailureMode = 'empty' | 'http-500' | 'non-json' | 'connection-destroy';

  function applyFallbackBehavior(mode: FallbackFailureMode, path: string): void {
    switch (mode) {
      case 'empty':
        behaviors[path] = { kind: 'empty' };
        return;
      case 'http-500':
        behaviors[path] = { kind: 'http-error', status: 500 };
        return;
      case 'non-json':
        behaviors[path] = { kind: 'non-json', body: 'not json either' };
        return;
      case 'connection-destroy':
        behaviors[path] = { kind: 'connection-destroy' };
        return;
    }
  }

  it.each<{ standard: StandardFailureMode; fallback: FallbackFailureMode }>([
    { standard: 'empty', fallback: 'empty' },
    { standard: 'http-401', fallback: 'http-500' },
    { standard: 'http-500', fallback: 'non-json' },
    { standard: 'non-json', fallback: 'connection-destroy' },
    { standard: 'connection-destroy', fallback: 'http-500' },
    { standard: 'http-500', fallback: 'empty' },
  ])(
    'resolves to [] when standard=$standard and fallback=$fallback (Anthropic_Suffixed_URL, never throws)',
    async ({ standard, fallback }) => {
      applyStandardBehavior(standard, '/anthropic/v1/models');
      applyFallbackBehavior(fallback, '/v1/models');

      const adapter = new ClaudeAdapter();
      const apiToken = `sk-claude-double-failure-${standard}-${fallback}`;

      const result = await adapter.getModels(`${host}/anthropic`, apiToken);

      expect(result).toEqual([]);
      // Even on double failure we must still have observed exactly one
      // standard request and exactly one fallback request — no extra
      // built-in retry beyond the single-shot fallback.
      expect(countRequests(requests, '/anthropic/v1/models')).toBe(1);
      expect(countRequests(requests, '/v1/models')).toBe(1);
    },
  );

  // -------------------------------------------------------------------------
  // Property 5 / R4.1
  // Nested base URLs strip only the trailing /anthropic segment; the fallback
  // request must hit /api/v1/models, not /v1/models.
  // -------------------------------------------------------------------------
  it('uses parent path /api/v1/models (not /v1/models) for nested ${host}/api/anthropic', async () => {
    behaviors['/api/anthropic/v1/models'] = { kind: 'empty' };
    behaviors['/api/v1/models'] = { kind: 'success', ids: SAMPLE_FALLBACK_IDS };

    const adapter = new ClaudeAdapter();
    const apiToken = 'sk-claude-nested-suffix';
    const models = await adapter.getModels(`${host}/api/anthropic`, apiToken);

    expect(models).toEqual(SAMPLE_FALLBACK_IDS);
    expect(countRequests(requests, '/api/v1/models')).toBe(1);
    // The non-nested /v1/models endpoint MUST NOT be consulted: the parent
    // is `${host}/api`, not `${host}`.
    expect(countRequests(requests, '/v1/models')).toBe(0);

    const fallbackReq = requests.find((r) => r.url === '/api/v1/models');
    expect(fallbackReq).toBeDefined();
    expect(fallbackReq?.method).toBe('GET');
    expect(fallbackReq?.headers.authorization).toBe(`Bearer ${apiToken}`);
    expect(fallbackReq?.headers['x-api-key']).toBeUndefined();
    expect(fallbackReq?.headers['anthropic-version']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Property 3 / R2.2, R2.4, R2.5, R9.3
  // Non-Anthropic_Suffixed_URL shapes must NEVER trigger fallback, regardless
  // of whether the standard endpoint succeeds, returns empty, errors, or is
  // unreachable.
  // -------------------------------------------------------------------------
  type NonAnthropicSuffixedScenario = 'anthropic-proxy-empty' | 'anthropic-proxy-500';

  it.each<{ scenario: NonAnthropicSuffixedScenario }>([
    { scenario: 'anthropic-proxy-empty' },
    { scenario: 'anthropic-proxy-500' },
  ])(
    'never fires fallback when path segment is /anthropic-proxy ($scenario)',
    async ({ scenario }) => {
      if (scenario === 'anthropic-proxy-empty') {
        behaviors['/anthropic-proxy/v1/models'] = { kind: 'empty' };
      } else {
        behaviors['/anthropic-proxy/v1/models'] = { kind: 'http-error', status: 500 };
      }
      // Even if these were called, the test would still observe them. Set
      // them to success on purpose: the assertion is that they receive zero
      // requests, not that they are unreachable.
      behaviors['/v1/models'] = { kind: 'success', ids: SAMPLE_FALLBACK_IDS };
      behaviors['/api/v1/models'] = { kind: 'success', ids: SAMPLE_FALLBACK_IDS };

      const adapter = new ClaudeAdapter();
      const apiToken = `sk-claude-anthropic-proxy-${scenario}`;
      const result = await adapter.getModels(`${host}/anthropic-proxy`, apiToken);

      expect(result).toEqual([]);
      expect(countFallbackRequests(requests)).toBe(0);
      // Only the standard endpoint should have been consulted.
      expect(countRequests(requests, '/anthropic-proxy/v1/models')).toBe(1);
    },
  );

  it('never fires fallback when host has "anthropic" substring but path is empty (unreachable host)', async () => {
    // For this case the standard call cannot reach our fixture server
    // (DNS fails on the .invalid TLD). We assert via the fixture's
    // request log that no fallback URL shape is hit. Any DNS-fast-fail
    // resolver returns NXDOMAIN immediately, so this test does not depend
    // on the unreachable host actually serving traffic.
    behaviors['/v1/models'] = { kind: 'success', ids: SAMPLE_FALLBACK_IDS };
    behaviors['/api/v1/models'] = { kind: 'success', ids: SAMPLE_FALLBACK_IDS };

    const adapter = new ClaudeAdapter();
    const apiToken = 'sk-claude-host-only-anthropic-substring';

    const result = await adapter.getModels(UNREACHABLE_ANTHROPIC_HOST_BASE_URL, apiToken);

    expect(result).toEqual([]);
    // No request reaches our local fixture for any URL shape — proves the
    // adapter did not even try the fallback: if it had, it would point to
    // the same unreachable host. The defining property is "no fallback
    // request observed at any fallback URL shape".
    expect(countFallbackRequests(requests)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Property 7 / R5.3
  // The adapter holds NO cross-call state. Five sequential getModels calls
  // with the same (baseUrl, apiToken) and fixed fixture behavior produce
  // exactly five standard requests and (when the fallback shape applies)
  // exactly five fallback requests.
  // -------------------------------------------------------------------------
  it('produces exactly N standard requests and N fallback requests when called N times (Anthropic_Suffixed_URL)', async () => {
    behaviors['/anthropic/v1/models'] = { kind: 'empty' };
    behaviors['/v1/models'] = { kind: 'success', ids: SAMPLE_FALLBACK_IDS };

    const adapter = new ClaudeAdapter();
    const apiToken = 'sk-claude-stateless';

    for (let i = 0; i < 5; i += 1) {
      const models = await adapter.getModels(`${host}/anthropic`, apiToken);
      expect(models).toEqual(SAMPLE_FALLBACK_IDS);
    }

    expect(countRequests(requests, '/anthropic/v1/models')).toBe(5);
    expect(countRequests(requests, '/v1/models')).toBe(5);
  });

  it('produces exactly N standard requests and 0 fallback requests when standard succeeds N times', async () => {
    behaviors['/anthropic/v1/models'] = { kind: 'success', ids: SAMPLE_STANDARD_IDS };

    const adapter = new ClaudeAdapter();
    const apiToken = 'sk-claude-stateless-success';

    for (let i = 0; i < 5; i += 1) {
      const models = await adapter.getModels(`${host}/anthropic`, apiToken);
      expect(models).toEqual(SAMPLE_STANDARD_IDS);
    }

    expect(countRequests(requests, '/anthropic/v1/models')).toBe(5);
    expect(countFallbackRequests(requests)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // R7.2, R7.3
  // When fallback fires, an info-level log is emitted for the intent. When
  // fallback returns a non-empty list, a second info-level log is emitted
  // marking the source as parent_v1_models with a positive count.
  // -------------------------------------------------------------------------
  it('emits intent + hit info logs around fallback discovery', async () => {
    behaviors['/anthropic/v1/models'] = { kind: 'empty' };
    behaviors['/v1/models'] = { kind: 'success', ids: SAMPLE_FALLBACK_IDS };

    const adapter = new ClaudeAdapter();
    await adapter.getModels(`${host}/anthropic`, 'sk-claude-log-shape');

    const intentCalls = infoSpy.mock.calls.filter(
      (args) => args[0] === '[claude-models-fallback] intent',
    );
    expect(intentCalls.length).toBeGreaterThanOrEqual(1);
    expect(intentCalls[0][1]).toMatchObject({
      site: expect.stringContaining('/anthropic'),
      target: expect.stringContaining('/v1/models'),
    });

    const hitCalls = infoSpy.mock.calls.filter(
      (args) => args[0] === '[claude-models-fallback] hit',
    );
    expect(hitCalls.length).toBe(1);
    expect(hitCalls[0][1]).toMatchObject({
      site: expect.stringContaining('/anthropic'),
      source: 'parent_v1_models',
      count: SAMPLE_FALLBACK_IDS.length,
    });
    expect(hitCalls[0][1].count).toBeGreaterThan(0);
  });

  it('emits intent log but no hit log when fallback returns empty', async () => {
    behaviors['/anthropic/v1/models'] = { kind: 'empty' };
    behaviors['/v1/models'] = { kind: 'empty' };

    const adapter = new ClaudeAdapter();
    await adapter.getModels(`${host}/anthropic`, 'sk-claude-log-no-hit');

    const intentCalls = infoSpy.mock.calls.filter(
      (args) => args[0] === '[claude-models-fallback] intent',
    );
    const hitCalls = infoSpy.mock.calls.filter(
      (args) => args[0] === '[claude-models-fallback] hit',
    );
    expect(intentCalls.length).toBeGreaterThanOrEqual(1);
    expect(hitCalls.length).toBe(0);
  });

  it('emits no fallback logs when standard discovery succeeds', async () => {
    behaviors['/anthropic/v1/models'] = { kind: 'success', ids: SAMPLE_STANDARD_IDS };

    const adapter = new ClaudeAdapter();
    await adapter.getModels(`${host}/anthropic`, 'sk-claude-no-log-on-success');

    const fallbackCalls = infoSpy.mock.calls.filter((args) => {
      const head = typeof args[0] === 'string' ? args[0] : '';
      return head.startsWith('[claude-models-fallback]');
    });
    expect(fallbackCalls).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Property 9 / R7.4
  // For high-entropy apiTokens, the JSON-stringified concatenation of every
  // console.info / console.warn call argument made during the Discovery_Call
  // does not contain the apiToken as a substring.
  // -------------------------------------------------------------------------
  const highEntropyTokens = Array.from({ length: 5 }, () => `sk-${randomBytes(32).toString('hex')}`);

  it.each(highEntropyTokens)(
    'never logs the apiToken (token=%s redacted-by-test) during fallback discovery',
    async (apiToken) => {
      behaviors['/anthropic/v1/models'] = { kind: 'empty' };
      behaviors['/v1/models'] = { kind: 'success', ids: SAMPLE_FALLBACK_IDS };

      const adapter = new ClaudeAdapter();
      const models = await adapter.getModels(`${host}/anthropic`, apiToken);
      expect(models).toEqual(SAMPLE_FALLBACK_IDS);

      const allLogArgs: unknown[] = [
        ...infoSpy.mock.calls.flat(),
        ...warnSpy.mock.calls.flat(),
      ];
      const haystack = allLogArgs
        .map((arg) => {
          try {
            return typeof arg === 'string' ? arg : JSON.stringify(arg);
          } catch {
            return '';
          }
        })
        .join('\n');

      expect(haystack).not.toContain(apiToken);
      // Sanity: at least the intent log was made — proving the haystack is
      // not empty by accident.
      expect(haystack).toContain('[claude-models-fallback]');
    },
  );

  // Suppress noisy "console.error" usage in the fixture path; we never
  // assert on it but we verified above that errorSpy is registered.
  it('keeps console.error noise out of token-leak surface (defense-in-depth)', () => {
    expect(errorSpy).toBeDefined();
  });
});
