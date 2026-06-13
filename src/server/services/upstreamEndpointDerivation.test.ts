import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchModelPricingCatalogMock = vi.fn(async (_arg?: unknown): Promise<any> => null);

vi.mock('./modelPricingService.js', () => ({
  fetchModelPricingCatalog: (arg: unknown) => fetchModelPricingCatalogMock(arg),
}));

import { resolveUpstreamEndpointCandidates } from './upstreamEndpointDerivation.js';
import { resetUpstreamEndpointRuntimeState } from './upstreamEndpointRuntimeMemory.js';

const baseContext = {
  site: {
    id: 1,
    url: 'https://upstream.example.com',
    platform: 'new-api',
    apiKey: null,
  },
  account: {
    id: 2,
    accessToken: 'token-demo',
    apiToken: null,
  },
};

describe('upstreamEndpointDerivation', () => {
  beforeEach(() => {
    fetchModelPricingCatalogMock.mockReset();
    fetchModelPricingCatalogMock.mockResolvedValue(null);
    resetUpstreamEndpointRuntimeState();
  });

  it('derives compact requests directly to responses from the service owner', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'responses',
      undefined,
      undefined,
      {
        requestKind: 'responses-compact',
      },
    );

    expect(order).toEqual(['responses']);
  });

  it('derives codex oauth openai requests as responses-first without surface-local reordering', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
      undefined,
      undefined,
      {
        oauthProvider: 'codex',
      },
    );

    expect(order).toEqual(['responses', 'chat', 'messages']);
  });

  it('keeps generic openai-compatible chat requests on chat before cross-protocol fallbacks', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
        },
      },
      'claude-opus-4-6',
      'openai',
    );

    expect(order).toEqual(['chat', 'responses']);
  });

  it('declares antigravity compatibility requests as Gemini-internal chat normalization', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'antigravity',
        },
      },
      'claude-opus-4-6',
      'openai',
      undefined,
      {
        hasNonImageFileInput: true,
      },
    );

    expect(order).toEqual(['chat']);
  });

  it('keeps inline document requests on the Gemini chat endpoint', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'gemini',
          url: 'https://generativelanguage.googleapis.com',
        },
      },
      'gemini-2.5-pro',
      'responses',
      undefined,
      {
        hasNonImageFileInput: true,
        conversationFileSummary: {
          hasImage: false,
          hasAudio: false,
          hasDocument: true,
          hasRemoteDocumentUrl: false,
        },
      },
    );

    expect(order).toEqual(['chat']);
  });

  it('ignores ambiguous catalog labels instead of misclassifying endpoint support', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [{
        modelName: 'gpt-5.3',
        supportedEndpointTypes: [
          'chatty-relay',
          'openai-response-cache',
          'response-auditing',
        ],
      }],
      groupRatio: {},
    });

    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
    );

    expect(order).toEqual(['chat', 'messages', 'responses']);
  });

  it('recognizes exact endpoint paths and URLs from catalog metadata', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [{
        modelName: 'gpt-5.3',
        supportedEndpointTypes: ['https://gateway.example.com/v1/responses?beta=true'],
      }],
      groupRatio: {},
    });

    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
    );

    expect(order).toEqual(['responses']);
  });

  it('rejects compact requests on native platforms without a responses endpoint', async () => {
    for (const platform of ['claude', 'gemini', 'gemini-cli', 'antigravity']) {
      const order = await resolveUpstreamEndpointCandidates(
        {
          ...baseContext,
          site: {
            ...baseContext.site,
            platform,
          },
        },
        'gpt-5.3',
        'responses',
        undefined,
        undefined,
        {
          requestKind: 'responses-compact',
        },
      );

      expect(order, platform).toEqual([]);
    }
  });

  it('keeps claude-family file-url requests messages-first for claude upstreams', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'claude',
        },
      },
      'claude-opus-4-6',
      'responses',
      undefined,
      {
        hasNonImageFileInput: true,
      },
      {
        requiresNativeResponsesFileUrl: true,
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('rejects native responses file URLs on Gemini chat-only transports', async () => {
    for (const platform of ['gemini', 'gemini-cli', 'antigravity']) {
      const order = await resolveUpstreamEndpointCandidates(
        {
          ...baseContext,
          site: {
            ...baseContext.site,
            platform,
          },
        },
        'gemini-2.5-pro',
        'responses',
        undefined,
        {
          hasNonImageFileInput: true,
          conversationFileSummary: {
            hasImage: false,
            hasAudio: false,
            hasDocument: true,
            hasRemoteDocumentUrl: true,
          },
        },
        {
          requiresNativeResponsesFileUrl: true,
        },
      );

      expect(order, platform).toEqual([]);
    }
  });

  it('derives claude count_tokens requests as messages-only when the upstream supports messages', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
        },
      },
      'claude-sonnet-4-5-20250929',
      'claude',
      undefined,
      undefined,
      {
        requestKind: 'claude-count-tokens',
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('returns no candidates for claude count_tokens when the upstream does not support messages', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'codex',
          url: 'https://chatgpt.com/backend-api/codex',
        },
      },
      'gpt-5.4',
      'claude',
      undefined,
      undefined,
      {
        requestKind: 'claude-count-tokens',
      },
    );

    expect(order).toEqual([]);
  });
});
