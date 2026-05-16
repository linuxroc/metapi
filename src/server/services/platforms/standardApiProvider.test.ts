import { describe, expect, it } from 'vitest';
import {
  StandardApiProviderAdapterBase,
  isAnthropicSuffixedBaseUrl,
  normalizePlatformBaseUrl,
  resolveVersionedModelsUrl,
  stripAnthropicSuffixSegment,
} from './standardApiProvider.js';

class TestStandardApiProviderAdapter extends StandardApiProviderAdapterBase {
  readonly platformName = 'test-standard';
  fetchJsonImpl = async () => ({ data: [] as Array<{ id: string }> });

  async detect(_url: string): Promise<boolean> {
    return false;
  }

  async getModels(_baseUrl: string, _token: string): Promise<string[]> {
    return [];
  }

  protected override async fetchJson<T>(url: string, options?: Parameters<StandardApiProviderAdapterBase['fetchJson']>[1]): Promise<T> {
    return this.fetchJsonImpl(url, options) as Promise<T>;
  }

  async fetchModelsForTest(options: Parameters<StandardApiProviderAdapterBase['fetchModelsFromStandardEndpoint']>[0]) {
    return this.fetchModelsFromStandardEndpoint(options);
  }
}

describe('standardApiProvider helpers', () => {
  it('normalizes provider base urls and appends /v1/models when needed', () => {
    expect(normalizePlatformBaseUrl('https://api.example.com///')).toBe('https://api.example.com');
    expect(resolveVersionedModelsUrl('https://api.example.com')).toBe('https://api.example.com/v1/models');
    expect(resolveVersionedModelsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/models');
    expect(resolveVersionedModelsUrl('https://api.example.com/v1beta')).toBe('https://api.example.com/v1beta/models');
  });

  it('provides shared unsupported login/checkin and zero-balance defaults', async () => {
    const adapter = new TestStandardApiProviderAdapter();

    await expect(adapter.login('https://api.example.com', 'user', 'pass')).resolves.toEqual({
      success: false,
      message: 'login endpoint not supported',
    });
    await expect(adapter.getUserInfo('https://api.example.com', 'token')).resolves.toBe(null);
    await expect(adapter.checkin('https://api.example.com', 'token')).resolves.toEqual({
      success: false,
      message: 'checkin endpoint not supported',
    });
    await expect(adapter.getBalance('https://api.example.com', 'token')).resolves.toEqual({
      balance: 0,
      used: 0,
      quota: 0,
    });
  });

  it('does not swallow mapper bugs while still returning empty lists for network failures', async () => {
    const adapter = new TestStandardApiProviderAdapter();
    adapter.fetchJsonImpl = async () => ({ data: [{ id: 'gpt-5' }] });

    await expect(adapter.fetchModelsForTest({
      baseUrl: 'https://api.example.com',
      mapResponse: () => {
        throw new Error('mapper exploded');
      },
    })).rejects.toThrow('mapper exploded');

    adapter.fetchJsonImpl = async () => {
      throw new Error('network failed');
    };

    await expect(adapter.fetchModelsForTest({
      baseUrl: 'https://api.example.com',
    })).resolves.toEqual([]);
  });

  it('rejects invalid payload shapes instead of silently treating them as no models', async () => {
    const adapter = new TestStandardApiProviderAdapter();
    adapter.fetchJsonImpl = async () => ({ data: 'not-an-array' });

    await expect(adapter.fetchModelsForTest({
      baseUrl: 'https://api.example.com',
    })).rejects.toThrow('invalid standard models payload');
  });
});

describe('isAnthropicSuffixedBaseUrl (Property 4)', () => {
  // Validates: Requirements 2.3
  // Property 4: any URL whose pathname's last segment is exactly `anthropic`
  //             (case-insensitive, with optional single trailing slash) is
  //             recognized as an Anthropic-suffixed base URL.
  it.each([
    'https://example.com/anthropic',
    'https://example.com/anthropic/',
    'https://example.com/api/anthropic',
    'https://example.com/Anthropic',
    'https://example.com/ANTHROPIC',
    'https://example.com/AnThRoPiC',
    'https://open.bigmodel.cn/api/anthropic',
    'https://example.com:8443/api/anthropic',
  ])('returns true for Anthropic-suffixed URL %s', (input) => {
    expect(isAnthropicSuffixedBaseUrl(input)).toBe(true);
  });

  // Validates: Requirements 2.4, 2.5
  // Negative equivalence classes:
  //   - host-only (host name happens to contain `anthropic`)
  //   - last segment is an extension of `anthropic` (prefix/suffix variants)
  //   - mid-path matches but last segment is not `anthropic`
  //   - empty / non-URL strings
  it.each([
    'https://api.anthropic.com',
    'https://api.anthropic.com/',
    'https://example.com/anthropic-proxy',
    'https://example.com/anthropicV2',
    'https://example.com/v1/anthropic-something',
    'https://example.com/anthropic/v1',
    'https://example.com',
    'https://example.com/',
    '',
    'not a url',
  ])('returns false for non-Anthropic-suffixed URL %s', (input) => {
    expect(isAnthropicSuffixedBaseUrl(input)).toBe(false);
  });
});

describe('stripAnthropicSuffixSegment (Property 8)', () => {
  // Validates: Requirements 2.3, 8.3
  // Property 8: stripping the trailing `/anthropic` segment yields the same
  //             string as `normalizePlatformBaseUrl` of the parent input,
  //             across hosts/ports, optional trailing slashes, and case.
  it.each([
    {
      input: 'https://example.com/anthropic',
      parent: 'https://example.com/',
      expected: 'https://example.com',
    },
    {
      input: 'https://example.com/anthropic/',
      parent: 'https://example.com/',
      expected: 'https://example.com',
    },
    {
      input: 'https://example.com/api/anthropic',
      parent: 'https://example.com/api',
      expected: 'https://example.com/api',
    },
    {
      input: 'https://open.bigmodel.cn/api/anthropic',
      parent: 'https://open.bigmodel.cn/api',
      expected: 'https://open.bigmodel.cn/api',
    },
    {
      input: 'https://example.com/Anthropic',
      parent: 'https://example.com/',
      expected: 'https://example.com',
    },
    {
      // The URL parser preserves port and query string while we strip only
      // the trailing `/anthropic` segment from pathname. The query string
      // survives the strip, so the assertion holds for the WHATWG-derived
      // serialization observed at runtime.
      input: 'https://example.com:8443/api/anthropic?x=1',
      parent: 'https://example.com:8443/api?x=1',
      expected: 'https://example.com:8443/api?x=1',
    },
  ])('strips trailing /anthropic segment for $input', ({ input, parent, expected }) => {
    const actual = stripAnthropicSuffixSegment(input);
    expect(actual).toBe(expected);
    expect(actual).toBe(normalizePlatformBaseUrl(parent));
  });

  // Validates: Requirements 2.4, 2.5, 8.3
  // Every input that `isAnthropicSuffixedBaseUrl` rejects must yield `null`
  // here, so callers can use the result as a single-source-of-truth signal.
  it.each([
    'https://api.anthropic.com',
    'https://api.anthropic.com/',
    'https://example.com/anthropic-proxy',
    'https://example.com/anthropicV2',
    'https://example.com/v1/anthropic-something',
    'https://example.com/anthropic/v1',
    'https://example.com',
    'https://example.com/',
    '',
    'not a url',
  ])('returns null for non-Anthropic-suffixed URL %s', (input) => {
    expect(stripAnthropicSuffixSegment(input)).toBeNull();
  });
});
