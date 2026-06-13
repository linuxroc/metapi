import { describe, expect, it } from 'vitest';

import { resolveUpstreamEndpointCapability } from './upstreamEndpointCapabilities.js';

describe('upstreamEndpointCapabilities', () => {
  it('keeps generic OpenAI-compatible chat requests on chat before cross-protocol fallbacks', () => {
    const capability = resolveUpstreamEndpointCapability({
      sitePlatform: 'openai',
      siteUrl: 'https://gateway.example.com',
      downstreamFormat: 'openai',
    });

    expect(capability).toMatchObject({
      nativeProvider: false,
      supportedEndpoints: ['chat', 'responses'],
      preferredEndpoints: ['chat', 'responses'],
    });
  });

  it('uses Responses first only for Responses downstream requests', () => {
    const capability = resolveUpstreamEndpointCapability({
      sitePlatform: 'openai',
      siteUrl: 'https://gateway.example.com',
      downstreamFormat: 'responses',
    });

    expect(capability.preferredEndpoints).toEqual(['responses', 'chat']);
  });

  it('does not advertise Anthropic Messages for the native OpenAI API', () => {
    const capability = resolveUpstreamEndpointCapability({
      sitePlatform: 'openai',
      siteUrl: 'https://api.openai.com/v1',
      downstreamFormat: 'openai',
    });

    expect(capability).toMatchObject({
      nativeProvider: true,
      supportedEndpoints: ['chat', 'responses'],
      preferredEndpoints: ['chat', 'responses'],
    });
  });

  it('keeps Codex OAuth requests on the native Responses endpoint', () => {
    const capability = resolveUpstreamEndpointCapability({
      sitePlatform: 'openai',
      siteUrl: 'https://gateway.example.com',
      downstreamFormat: 'openai',
      oauthProvider: 'codex',
    });

    expect(capability.preferredEndpoints).toEqual(['responses', 'chat']);
  });

  it('distinguishes antigravity Gemini-internal transport from Claude Messages', () => {
    const antigravity = resolveUpstreamEndpointCapability({
      sitePlatform: 'antigravity',
      downstreamFormat: 'openai',
    });
    const claude = resolveUpstreamEndpointCapability({
      sitePlatform: 'claude',
      downstreamFormat: 'claude',
    });

    expect(antigravity).toMatchObject({
      transport: 'gemini-internal',
      supportedEndpoints: ['chat'],
      preferredEndpoints: ['chat'],
    });
    expect(claude).toMatchObject({
      transport: 'anthropic-messages',
      supportedEndpoints: ['messages'],
      preferredEndpoints: ['messages'],
    });
  });
});
