import { describe, expect, it } from 'vitest';

import {
  canonicalRequestFromOpenAiBody,
  canonicalRequestToOpenAiChatBody,
  createCanonicalRequestEnvelope,
} from './request.js';

describe('canonical request helpers', () => {
  it('normalizes a count_tokens request without provider-owned fields', () => {
    const request = createCanonicalRequestEnvelope({
      operation: 'count_tokens',
      surface: 'anthropic-messages',
      cliProfile: 'claude_code',
      requestedModel: ' claude-sonnet-4-5 ',
      stream: false,
      continuation: {
        sessionId: '  session-1  ',
        promptCacheKey: '  cache-1  ',
      },
    });

    expect(request).toEqual({
      operation: 'count_tokens',
      surface: 'anthropic-messages',
      cliProfile: 'claude_code',
      requestedModel: 'claude-sonnet-4-5',
      stream: false,
      messages: [],
      continuation: {
        sessionId: 'session-1',
        promptCacheKey: 'cache-1',
      },
    });
  });

  it('defaults generate requests to generic profile and empty collections', () => {
    const request = createCanonicalRequestEnvelope({
      requestedModel: 'gpt-5.2-codex',
      surface: 'openai-responses',
    });

    expect(request).toEqual({
      operation: 'generate',
      surface: 'openai-responses',
      cliProfile: 'generic',
      requestedModel: 'gpt-5.2-codex',
      stream: false,
      messages: [],
    });
  });

  it('parses metadata and explicit function tool choice from OpenAI-compatible bodies', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-5',
        stream: true,
        metadata: { user_id: 'user-1' },
        tools: [{
          type: 'function',
          function: {
            name: 'Glob',
            description: 'Search files',
            strict: true,
            parameters: {
              type: 'object',
              properties: {
                pattern: { type: 'string' },
              },
            },
          },
        }],
        tool_choice: {
          type: 'function',
          function: {
            name: 'Glob',
          },
        },
        messages: [{ role: 'user', content: 'hello' }],
      },
      surface: 'openai-chat',
    });

    expect(request).toMatchObject({
      requestedModel: 'gpt-5',
      stream: true,
      metadata: { user_id: 'user-1' },
      tools: [{
        name: 'Glob',
        description: 'Search files',
        strict: true,
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
          },
        },
      }],
      toolChoice: {
        type: 'tool',
        name: 'Glob',
      },
    });
  });

  it('collects continuation session ids from OpenAI-compatible metadata and custom session fields', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-5',
        stream: false,
        session_id: 'session-body-1',
        conversation_id: 'conversation-body-1',
        metadata: {
          user_id: 'session-metadata-1',
        },
        messages: [{ role: 'user', content: 'hello' }],
      },
      surface: 'openai-chat',
    });

    expect(request).toMatchObject({
      continuation: {
        sessionId: 'session-metadata-1',
      },
    });
  });

  it('collects continuation turnState from OpenAI-compatible metadata namespace', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-5',
        stream: false,
        metadata: {
          metapi_turn_state: 'turn-state-1',
        },
        messages: [{ role: 'user', content: 'hello' }],
      },
      surface: 'openai-chat',
    });

    expect(request).toMatchObject({
      continuation: {
        turnState: 'turn-state-1',
      },
    });
  });

  it('materializes continuation session ids into metadata.user_id without overwriting explicit metadata', () => {
    const body = canonicalRequestToOpenAiChatBody({
      operation: 'generate',
      surface: 'anthropic-messages',
      cliProfile: 'claude_code',
      requestedModel: 'claude-sonnet-4-5',
      stream: false,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      continuation: {
        sessionId: 'session-bridge-1',
        promptCacheKey: 'cache-1',
      },
      metadata: {
        existing: true,
      },
    });

    expect(body).toMatchObject({
      metadata: {
        existing: true,
        user_id: 'session-bridge-1',
      },
      prompt_cache_key: 'cache-1',
    });
  });

  it('materializes continuation turnState into metadata without overwriting explicit metadata', () => {
    const body = canonicalRequestToOpenAiChatBody({
      operation: 'generate',
      surface: 'openai-chat',
      cliProfile: 'codex',
      requestedModel: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      continuation: {
        turnState: 'turn-state-2',
      },
      metadata: {
        existing: true,
      },
    });

    expect(body).toMatchObject({
      metadata: {
        existing: true,
        metapi_turn_state: 'turn-state-2',
      },
    });
  });

  it('parses anthropic-shaped tools from compatibility bodies', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-5',
        tools: [{
          name: 'Glob',
          description: 'Search files',
          input_schema: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
            },
          },
        }],
        tool_choice: {
          type: 'tool',
          name: 'Glob',
        },
        messages: [{ role: 'user', content: 'hello' }],
      },
      surface: 'openai-chat',
    });

    expect(request.tools).toEqual([{
      name: 'Glob',
      description: 'Search files',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
        },
      },
    }]);
    expect(request.toolChoice).toEqual({
      type: 'tool',
      name: 'Glob',
    });
  });

  it('builds metadata back into OpenAI chat requests', () => {
    const body = canonicalRequestToOpenAiChatBody({
      operation: 'generate',
      surface: 'openai-chat',
      cliProfile: 'generic',
      requestedModel: 'gpt-5',
      stream: false,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      metadata: { user_id: 'user-1' },
      toolChoice: {
        type: 'tool',
        name: 'Glob',
      },
      tools: [{
        name: 'Glob',
        strict: true,
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
          },
        },
      }],
    });

    expect(body).toMatchObject({
      model: 'gpt-5',
      metadata: { user_id: 'user-1' },
      tool_choice: {
        type: 'function',
        function: {
          name: 'Glob',
        },
      },
      tools: [{
        type: 'function',
        function: {
          name: 'Glob',
          strict: true,
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
            },
          },
        },
      }],
    });
  });

  it('round-trips include metadata only for Responses-compatible bodies', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-5',
        stream: true,
        include: ['reasoning.encrypted_content', 'message.input_image.image_url'],
        reasoning: {
          effort: 'high',
        },
        messages: [{ role: 'user', content: 'hello' }],
      },
      surface: 'openai-responses',
    });

    const chatBody = canonicalRequestToOpenAiChatBody(request);
    const responsesBody = canonicalRequestToOpenAiChatBody(request, {
      preserveResponsesExtensions: true,
    });

    expect(chatBody).toMatchObject({
      model: 'gpt-5',
      reasoning_effort: 'high',
    });
    expect(chatBody.include).toBeUndefined();
    expect(responsesBody).toMatchObject({
      model: 'gpt-5',
      reasoning_effort: 'high',
      include: ['reasoning.encrypted_content', 'message.input_image.image_url'],
    });
  });

  it('drops Responses-only raw tool choices from Chat-compatible bodies', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-5',
        tool_choice: {
          type: 'tool',
          name: 'browser',
          mode: 'required',
          disable_parallel_tool_use: true,
        },
        tools: [{
          type: 'custom',
          name: 'browser',
        }],
        messages: [{ role: 'user', content: 'hello' }],
      },
      surface: 'openai-responses',
    });

    const body = canonicalRequestToOpenAiChatBody(request);

    expect(body.tool_choice).toBeUndefined();
  });

  it('preserves structured tool outputs and top-level attachments through canonical round-trips', () => {
    const request = createCanonicalRequestEnvelope({
      requestedModel: 'gpt-5',
      surface: 'openai-chat',
      attachments: [{
        kind: 'file',
        fileId: 'file-top-level',
      }],
      messages: [{
        role: 'tool',
        parts: [{
          type: 'tool_result',
          toolCallId: 'call_1',
          resultContent: [
            { type: 'text', text: 'tool result' },
            { type: 'image_url', image_url: { url: 'https://example.com/tool.png' } },
          ],
        } as any],
      }],
    });

    const body = canonicalRequestToOpenAiChatBody(request);

    expect(body.attachments).toEqual([{
      kind: 'file',
      fileId: 'file-top-level',
    }]);
    expect(body.messages).toEqual([{
      role: 'tool',
      tool_call_id: 'call_1',
      content: [
        { type: 'text', text: 'tool result' },
        { type: 'image_url', image_url: { url: 'https://example.com/tool.png' } },
      ],
    }]);
  });

  it('preserves richer Responses extensions through canonical Responses round-trips', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-5',
        parallel_tool_calls: false,
        tools: [
          {
            type: 'custom',
            name: 'browser',
            description: 'browse the web',
            format: { type: 'text' },
          },
          {
            type: 'image_generation',
            background: 'transparent',
          },
        ],
        tool_choice: {
          type: 'allowed_tools',
          mode: 'auto',
          tools: [{ type: 'custom', name: 'browser' }],
        },
        messages: [
          {
            role: 'assistant',
            phase: 'analysis',
            reasoning_signature: 'sig_123',
            content: 'thinking',
          },
          {
            role: 'user',
            content: 'hello',
          },
        ],
      },
      surface: 'openai-responses',
    });

    const body = canonicalRequestToOpenAiChatBody(request, {
      preserveResponsesExtensions: true,
    });

    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tools).toEqual([
      {
        type: 'custom',
        name: 'browser',
        description: 'browse the web',
        format: { type: 'text' },
      },
      {
        type: 'image_generation',
        background: 'transparent',
      },
    ]);
    expect(body.tool_choice).toEqual({
      type: 'allowed_tools',
      mode: 'auto',
      tools: [{ type: 'custom', name: 'browser' }],
    });
    expect(body.messages).toMatchObject([
      {
        role: 'assistant',
        phase: 'analysis',
        reasoning_signature: 'sig_123',
        content: 'thinking',
      },
      {
        role: 'user',
        content: 'hello',
      },
    ]);
  });

  it('keeps generation settings and tool thought signatures in canonical Chat conversions', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-5',
        max_completion_tokens: 512,
        temperature: 0.3,
        top_p: 0.8,
        top_k: 20,
        stop: ['END'],
        response_format: { type: 'json_object' },
        parallel_tool_calls: false,
        messages: [{
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'lookup',
              arguments: '{"topic":"weather"}',
            },
            provider_specific_fields: {
              thought_signature: 'sig_tool_1',
            },
          }],
        }],
      },
      surface: 'openai-chat',
    });

    expect(request).toMatchObject({
      generation: {
        maxOutputTokens: 512,
        temperature: 0.3,
        topP: 0.8,
        topK: 20,
        stopSequences: ['END'],
        responseFormat: { type: 'json_object' },
      },
      parallelToolCalls: false,
      messages: [{
        parts: [{
          type: 'tool_call',
          thoughtSignature: 'sig_tool_1',
        }],
      }],
    });

    expect(canonicalRequestToOpenAiChatBody(request)).toMatchObject({
      max_completion_tokens: 512,
      temperature: 0.3,
      top_p: 0.8,
      top_k: 20,
      stop: ['END'],
      response_format: { type: 'json_object' },
      parallel_tool_calls: false,
      messages: [{
        tool_calls: [{
          provider_specific_fields: {
            thought_signature: 'sig_tool_1',
          },
        }],
      }],
    });
  });

  it('preserves standard OpenAI input_audio blocks through canonical Chat conversion', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-audio',
        messages: [{
          role: 'user',
          content: [{
            type: 'input_audio',
            input_audio: {
              data: 'UklGRg==',
              format: 'wav',
            },
          }],
        }],
      },
      surface: 'openai-chat',
    });

    expect(request.messages).toEqual([{
      role: 'user',
      parts: [{
        type: 'audio',
        data: 'UklGRg==',
        format: 'wav',
        mimeType: 'audio/wav',
      }],
    }]);
    expect(canonicalRequestToOpenAiChatBody(request)).toMatchObject({
      messages: [{
        content: [{
          type: 'input_audio',
          input_audio: {
            data: 'UklGRg==',
            format: 'wav',
          },
        }],
      }],
    });
  });

  it('writes raw canonical tool types back into OpenAI-compatible bodies when the raw payload omits the discriminator', () => {
    const request = createCanonicalRequestEnvelope({
      requestedModel: 'gpt-5',
      surface: 'openai-responses',
      tools: [{
        type: 'custom',
        raw: {
          name: 'browser',
          description: 'browse the web',
          format: { type: 'text' },
        },
      }],
    });

    const body = canonicalRequestToOpenAiChatBody(request);

    expect(body.tools).toEqual([{
      type: 'custom',
      custom: {
        name: 'browser',
        description: 'browse the web',
        format: { type: 'text' },
      },
    }]);
  });
});
