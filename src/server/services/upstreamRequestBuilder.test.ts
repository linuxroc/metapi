import { describe, expect, it } from 'vitest';

import {
  buildClaudeCountTokensUpstreamRequest,
  buildUpstreamEndpointRequest,
} from './upstreamRequestBuilder.js';

describe('upstreamRequestBuilder', () => {
  it('normalizes single-message OpenAI requests to structured responses input', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
    });

    expect(request.path).toBe('/v1/responses');
    expect(request.headers.accept).toBe('application/json');
    expect(request.body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
    expect(request.body.store).toBe(false);
  });

  it('preserves Responses target controls when Chat requests fall back to Responses', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
        max_tool_calls: 2,
        prompt_cache_retention: '24h',
        background: true,
        truncation: 'auto',
      },
      downstreamFormat: 'openai',
    });

    expect(request.body).toMatchObject({
      max_tool_calls: 2,
      prompt_cache_retention: '24h',
      background: true,
      truncation: 'auto',
    });
  });

  it('forces store=false for sub2api native responses passthrough bodies', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {},
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'gpt-5.2',
        input: 'hello',
        store: true,
      },
    });

    expect(request.path).toBe('/v1/responses');
    expect(request.headers.accept).toBe('text/event-stream');
    expect(request.body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
    expect(request.body.stream).toBe(true);
    expect(request.body.store).toBe(false);
  });

  it('overrides downstream Accept so responses transport mode wins', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
      downstreamHeaders: {
        accept: 'application/json',
      },
    });

    expect(request.headers.accept).toBe('text/event-stream');
  });

  it('uses canonical conversion for Responses to Chat fallback fields and tools', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'upstream-gpt',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteUrl: 'https://example.com',
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'gpt-5',
        input: 'hello',
        previous_response_id: 'resp_prev_1',
        include: ['reasoning.encrypted_content'],
      },
      openaiBody: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 256,
        reasoning_effort: 'high',
        parallel_tool_calls: false,
        previous_response_id: 'resp_prev_1',
        include: ['reasoning.encrypted_content'],
        max_tool_calls: 3,
        prompt_cache_retention: '24h',
        background: true,
        truncation: 'auto',
        tools: [
          {
            type: 'custom',
            name: 'browser',
          },
          {
            type: 'image_generation',
            background: 'transparent',
          },
        ],
        tool_choice: {
          type: 'allowed_tools',
          mode: 'required',
          tools: [
            { type: 'custom', name: 'browser' },
          ],
        },
      },
    });

    expect(request.body).toMatchObject({
      model: 'upstream-gpt',
      max_completion_tokens: 256,
      reasoning_effort: 'high',
      parallel_tool_calls: false,
      tools: [{
        type: 'custom',
        custom: {
          name: 'browser',
        },
      }],
      tool_choice: {
        type: 'allowed_tools',
        allowed_tools: {
          mode: 'required',
          tools: [{
            type: 'custom',
            custom: {
              name: 'browser',
            },
          }],
        },
      },
    });
    expect(request.body).not.toHaveProperty('previous_response_id');
    expect(request.body).not.toHaveProperty('include');
    expect(request.body).not.toHaveProperty('max_tool_calls');
    expect(request.body).not.toHaveProperty('prompt_cache_retention');
    expect(request.body).not.toHaveProperty('background');
    expect(request.body).not.toHaveProperty('truncation');
  });

  it('uses canonical token and parallel-tool semantics for Chat to Messages conversion', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'messages',
      modelName: 'claude-opus-4-6',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteUrl: 'https://example.com',
      downstreamFormat: 'openai',
      openaiBody: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
        max_completion_tokens: 321,
        parallel_tool_calls: false,
        tools: [{
          type: 'function',
          function: {
            name: 'lookup',
            parameters: { type: 'object' },
          },
        }],
      },
    });

    expect(request.body).toMatchObject({
      model: 'claude-opus-4-6',
      max_tokens: 321,
      tool_choice: {
        type: 'auto',
        disable_parallel_tool_use: true,
      },
    });
  });

  it('uses canonical generation and structured-output settings for Gemini-compatible upstreams', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'gemini-2.5-pro',
      stream: false,
      tokenValue: 'oauth-test',
      oauthProjectId: 'project-test',
      sitePlatform: 'gemini-cli',
      siteUrl: 'https://example.com',
      downstreamFormat: 'openai',
      openaiBody: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'return json' }],
        max_completion_tokens: 128,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 16,
        stop: ['END'],
        response_format: { type: 'json_object' },
      },
    });

    expect(request.body.request).toMatchObject({
      contents: [{
        role: 'user',
        parts: [{ text: 'return json' }],
      }],
      generationConfig: {
        maxOutputTokens: 128,
        temperature: 0.2,
        topP: 0.9,
        topK: 16,
        stopSequences: ['END'],
        responseMimeType: 'application/json',
      },
    });
  });

  it('applies a sub2api-style allowlist to generic passthrough headers', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'upstream-gpt',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
      downstreamHeaders: {
        accept: 'application/json',
        'accept-language': 'zh-CN',
        'user-agent': 'client-ua/1.0',
        originator: 'codex_cli_rs',
        session_id: 'session-123',
        conversation_id: 'conversation-123',
        'x-codex-turn-state': 'turn-state',
        'x-codex-turn-metadata': 'turn-metadata',
        origin: 'https://client.example',
        referer: 'https://client.example/chat',
        'x-forwarded-for': '203.0.113.1',
        'x-real-ip': '203.0.113.2',
        version: '0.202.0',
        'x-test-header': 'drop-me',
      },
    });

    expect(request.headers.accept).toBe('application/json');
    expect(request.headers['accept-language']).toBe('zh-CN');
    expect(request.headers['user-agent']).toBe('client-ua/1.0');
    expect(request.headers.originator).toBe('codex_cli_rs');
    expect(request.headers.session_id).toBe('session-123');
    expect(request.headers.conversation_id).toBe('conversation-123');
    expect(request.headers['x-codex-turn-state']).toBe('turn-state');
    expect(request.headers['x-codex-turn-metadata']).toBe('turn-metadata');

    expect(request.headers.origin).toBeUndefined();
    expect(request.headers.referer).toBeUndefined();
    expect(request.headers['x-forwarded-for']).toBeUndefined();
    expect(request.headers['x-real-ip']).toBeUndefined();
    expect(request.headers.version).toBeUndefined();
    expect(request.headers['x-test-header']).toBeUndefined();
  });

  it('drops responses-style continuation fields before proxying Claude count_tokens upstream', () => {
    const request = buildClaudeCountTokensUpstreamRequest({
      modelName: 'claude-opus-4-6',
      tokenValue: 'sk-test',
      sitePlatform: 'claude',
      claudeBody: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        previous_response_id: 'resp_prev_1',
        prompt_cache_key: 'cache-key-1',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(request.body).toMatchObject({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user' }],
    });
    expect(request.body).not.toHaveProperty('previous_response_id');
    expect(request.body).not.toHaveProperty('prompt_cache_key');
    expect(request.body).not.toHaveProperty('max_tokens');
    expect(request.body).not.toHaveProperty('maxTokens');
  });

  it('merges body betas with existing anthropic-beta headers for Claude count_tokens', () => {
    const request = buildClaudeCountTokensUpstreamRequest({
      modelName: 'claude-opus-4-6',
      tokenValue: 'sk-test',
      sitePlatform: 'claude',
      claudeBody: {
        model: 'claude-opus-4-6',
        betas: ['beta-from-body'],
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamHeaders: {
        'anthropic-beta': 'header-beta',
      },
    });

    expect(request.headers['anthropic-beta']).toContain('header-beta');
    expect(request.headers['anthropic-beta']).toContain('beta-from-body');
  });
});
