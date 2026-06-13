import { describe, expect, it } from 'vitest';

import {
  buildGeminiGenerateContentRequestFromOpenAi,
  buildCanonicalRequestToGeminiGenerateContentBody,
  parseGeminiGenerateContentRequestToCanonical,
} from './requestBridge.js';

describe('gemini generate-content request bridge', () => {
  it('parses Gemini generateContent bodies into canonical envelopes', () => {
    const result = parseGeminiGenerateContentRequestToCanonical({
      model: 'gemini-2.5-pro',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'hello' }],
        },
      ],
      generationConfig: {
        thinkingConfig: {
          thinkingBudget: 512,
        },
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      surface: 'gemini-generate-content',
      requestedModel: 'gemini-2.5-pro',
      reasoning: {
        budgetTokens: 512,
      },
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: 'hello' }],
        },
      ],
    });
  });

  it('builds Gemini generateContent bodies from canonical envelopes', () => {
    const body = buildCanonicalRequestToGeminiGenerateContentBody({
      operation: 'generate',
      surface: 'gemini-generate-content',
      cliProfile: 'gemini_cli',
      requestedModel: 'gemini-2.5-pro',
      stream: false,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      reasoning: {
        budgetTokens: 512,
      },
      tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
      toolChoice: 'required',
    });

    expect(body).toMatchObject({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'hello' }],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'lookup',
              parametersJsonSchema: { type: 'object' },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: 'ANY',
        },
      },
      generationConfig: {
        thinkingConfig: {
          thinkingBudget: 512,
          includeThoughts: true,
        },
      },
    });
  });

  it('maps canonical and standard OpenAI audio input to Gemini inlineData', () => {
    const canonicalBody = buildCanonicalRequestToGeminiGenerateContentBody({
      operation: 'generate',
      surface: 'openai-chat',
      cliProfile: 'generic',
      requestedModel: 'gemini-2.5-pro',
      stream: false,
      messages: [{
        role: 'user',
        parts: [{
          type: 'audio',
          data: 'UklGRg==',
          format: 'wav',
          mimeType: 'audio/wav',
        }],
      }],
    });
    const compatibilityBody = buildGeminiGenerateContentRequestFromOpenAi({
      body: {
        messages: [{
          role: 'user',
          content: [{
            type: 'input_audio',
            input_audio: {
              data: 'SUQzBA==',
              format: 'mp3',
            },
          }],
        }],
      },
      modelName: 'gemini-2.5-pro',
    });

    expect(canonicalBody).toMatchObject({
      contents: [{
        role: 'user',
        parts: [{
          inlineData: {
            mimeType: 'audio/wav',
            data: 'UklGRg==',
          },
        }],
      }],
    });
    expect(compatibilityBody).toMatchObject({
      contents: [{
        role: 'user',
        parts: [{
          inlineData: {
            mime_type: 'audio/mpeg',
            data: 'SUQzBA==',
          },
        }],
      }],
    });
  });

  it('uses Gemini 3 thinking levels and preserves full JSON Schema tool declarations', () => {
    const body = buildCanonicalRequestToGeminiGenerateContentBody({
      operation: 'generate',
      surface: 'openai-chat',
      cliProfile: 'generic',
      requestedModel: 'gemini-3-pro-preview',
      stream: false,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'lookup' }] }],
      reasoning: {
        budgetTokens: 8192,
      },
      tools: [{
        name: 'lookup',
        inputSchema: {
          type: 'object',
          oneOf: [{ required: ['query'] }],
          properties: {
            query: { type: 'string' },
          },
          additionalProperties: false,
        },
      }],
    });

    expect(body.generationConfig).toMatchObject({
      thinkingConfig: {
        thinkingLevel: 'medium',
        includeThoughts: true,
      },
    });
    expect(body.tools).toEqual([{
      functionDeclarations: [{
        name: 'lookup',
        parametersJsonSchema: {
          type: 'object',
          oneOf: [{ required: ['query'] }],
          properties: {
            query: { type: 'string' },
          },
          additionalProperties: false,
        },
      }],
    }]);
  });

  it('injects provider thought signatures into functionCall parts', () => {
    const result = buildGeminiGenerateContentRequestFromOpenAi({
      modelName: 'gemini-3-flash-preview',
      body: {
        model: 'gemini-3-flash-preview',
        messages: [
          { role: 'user', content: 'What is the weather?' },
          {
            role: 'assistant',
            content: 'Let me check.',
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
                provider_specific_fields: { thought_signature: 'real_sig_abc' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_123', content: '{"temp":"22C"}' },
        ],
      },
    }) as Record<string, unknown>;

    const contents = result.contents as Array<Record<string, unknown>>;
    const modelMessages = contents.filter((content) => content.role === 'model');
    const functionCallParts = modelMessages
      .flatMap((message) => message.parts as Array<Record<string, unknown>>)
      .filter((part) => 'functionCall' in part);

    expect(functionCallParts).toHaveLength(1);
    expect(functionCallParts[0].thoughtSignature).toBe('real_sig_abc');
  });

  it('splits text and signed functionCall parts into separate model messages', () => {
    const result = buildGeminiGenerateContentRequestFromOpenAi({
      modelName: 'gemini-3-flash-preview',
      body: {
        model: 'gemini-3-flash-preview',
        messages: [
          { role: 'user', content: 'Read the file.' },
          {
            role: 'assistant',
            content: 'I will read it.',
            tool_calls: [
              {
                id: 'call_456',
                type: 'function',
                function: { name: 'Read', arguments: '{"path":"/tmp/x"}' },
                provider_specific_fields: { thought_signature: 'sig_split_test' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_456', content: 'file content here' },
        ],
      },
    }) as Record<string, unknown>;

    const contents = result.contents as Array<Record<string, unknown>>;
    const modelMessages = contents.filter((content) => content.role === 'model');

    expect(modelMessages).toHaveLength(2);
    expect((modelMessages[0].parts as Array<Record<string, unknown>>).every((part) => 'text' in part)).toBe(true);
    expect((modelMessages[1].parts as Array<Record<string, unknown>>).every((part) => 'functionCall' in part)).toBe(true);
    expect((modelMessages[1].parts as Array<Record<string, unknown>>)[0].thoughtSignature).toBe('sig_split_test');
  });

  it('disables thinking config when signatures are missing for non-gemini targets', () => {
    const result = buildGeminiGenerateContentRequestFromOpenAi({
      modelName: 'claude-sonnet-4-5',
      body: {
        model: 'claude-sonnet-4-5',
        reasoning_effort: 'high',
        messages: [
          { role: 'user', content: 'Do something.' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_no_sig_non_gemini',
                type: 'function',
                function: { name: 'Bash', arguments: '{"command":"ls"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_no_sig_non_gemini', content: 'file1\nfile2' },
        ],
      },
    }) as Record<string, unknown>;

    const contents = result.contents as Array<Record<string, unknown>>;
    const modelMessages = contents.filter((content) => content.role === 'model');
    const functionCallParts = modelMessages
      .flatMap((message) => message.parts as Array<Record<string, unknown>>)
      .filter((part) => 'functionCall' in part);

    expect(functionCallParts).toHaveLength(1);
    expect(functionCallParts[0].thoughtSignature).toBeUndefined();
    expect((result.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig).toBeUndefined();
  });

  it('injects a dummy thought signature when thinking is enabled and no signature is available', () => {
    const result = buildGeminiGenerateContentRequestFromOpenAi({
      modelName: 'gemini-3-flash-preview',
      body: {
        model: 'gemini-3-flash-preview',
        reasoning_effort: 'high',
        messages: [
          { role: 'user', content: 'Do something.' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_no_sig',
                type: 'function',
                function: { name: 'Bash', arguments: '{"command":"ls"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_no_sig', content: 'file1\nfile2' },
        ],
      },
    }) as Record<string, unknown>;

    const contents = result.contents as Array<Record<string, unknown>>;
    const modelMessages = contents.filter((content) => content.role === 'model');
    const functionCallParts = modelMessages
      .flatMap((message) => message.parts as Array<Record<string, unknown>>)
      .filter((part) => 'functionCall' in part);

    expect(functionCallParts).toHaveLength(1);
    expect(typeof functionCallParts[0].thoughtSignature).toBe('string');
    expect((functionCallParts[0].thoughtSignature as string).length).toBeGreaterThan(0);
  });

  it('preserves functionResponse count matching functionCall count', () => {
    const result = buildGeminiGenerateContentRequestFromOpenAi({
      modelName: 'gemini-3-flash-preview',
      body: {
        model: 'gemini-3-flash-preview',
        messages: [
          { role: 'user', content: 'Read two files.' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_a',
                type: 'function',
                function: { name: 'Read', arguments: '{"path":"/a"}' },
                provider_specific_fields: { thought_signature: 'sig_a' },
              },
              {
                id: 'call_b',
                type: 'function',
                function: { name: 'Read', arguments: '{"path":"/b"}' },
                provider_specific_fields: { thought_signature: 'sig_b' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_a', content: 'content a' },
          { role: 'tool', tool_call_id: 'call_b', content: 'content b' },
        ],
      },
    }) as Record<string, unknown>;

    const contents = result.contents as Array<Record<string, unknown>>;
    let functionCallCount = 0;
    let functionResponseCount = 0;
    for (const content of contents) {
      for (const part of (content.parts as Array<Record<string, unknown>>)) {
        if ('functionCall' in part) functionCallCount += 1;
        if ('functionResponse' in part) functionResponseCount += 1;
      }
    }

    expect(functionCallCount).toBe(2);
    expect(functionResponseCount).toBe(2);
  });

  it('uses canonical tool-call names for Gemini functionResponse parts', () => {
    const body = buildCanonicalRequestToGeminiGenerateContentBody({
      operation: 'generate',
      surface: 'gemini-generate-content',
      cliProfile: 'generic',
      requestedModel: 'gemini-2.5-pro',
      stream: false,
      messages: [
        {
          role: 'assistant',
          parts: [{
            type: 'tool_call',
            id: 'call_weather',
            name: 'lookup_weather',
            argumentsJson: '{"city":"Paris"}',
          }],
        },
        {
          role: 'tool',
          parts: [{
            type: 'tool_result',
            toolCallId: 'call_weather',
            resultJson: { temperature: '22C' },
          }],
        },
      ],
    });

    expect(body.contents).toEqual([
      {
        role: 'model',
        parts: [{
          functionCall: {
            id: 'call_weather',
            name: 'lookup_weather',
            args: { city: 'Paris' },
          },
        }],
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call_weather',
            name: 'lookup_weather',
            response: { temperature: '22C' },
          },
        }],
      },
    ]);
  });
});
describe('OpenAI -> Gemini image content forwarding', () => {
  it('forwards every supported OpenAI image content shape into Gemini parts', () => {
    const result = buildGeminiGenerateContentRequestFromOpenAi({
      modelName: 'gemini-2.5-flash',
      body: {
        model: 'gemini-2.5-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe these' },
              { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
              { type: 'input_image', image_url: 'https://example.com/dog.png' },
              { type: 'input_image', image_url: { url: 'https://example.com/bird.png', detail: 'high' } },
              { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
              { type: 'input_image', url: 'https://example.com/fish.png' },
            ],
          },
        ],
      },
    });

    const contents = result.contents as Array<Record<string, unknown>>;
    const userMessage = contents.find((c) => c.role === 'user');
    expect(userMessage).toBeTruthy();
    const parts = userMessage!.parts as Array<Record<string, unknown>>;
    expect(parts).toEqual([
      { text: 'describe these' },
      { fileData: { fileUri: 'https://example.com/cat.png' } },
      { fileData: { fileUri: 'https://example.com/dog.png' } },
      { fileData: { fileUri: 'https://example.com/bird.png' } },
      { inlineData: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { fileData: { fileUri: 'https://example.com/fish.png' } },
    ]);
  });
});

describe('Gemini -> canonical request fidelity', () => {
  it('preserves responseJsonSchema and tool-call thought signatures', () => {
    const result = parseGeminiGenerateContentRequestToCanonical({
      model: 'gemini-2.5-pro',
      contents: [
        {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call_weather',
              name: 'lookup_weather',
              args: { city: 'Paris' },
            },
            thoughtSignature: 'sig_weather',
          }],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: {
            temperature: { type: 'number' },
          },
        },
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.value?.generation?.responseFormat).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'gemini_response',
        schema: {
          type: 'object',
          properties: {
            temperature: { type: 'number' },
          },
        },
      },
    });
    expect(result.value?.messages).toEqual([
      {
        role: 'assistant',
        parts: [{
          type: 'tool_call',
          id: 'call_weather',
          name: 'lookup_weather',
          argumentsJson: '{"city":"Paris"}',
          thoughtSignature: 'sig_weather',
        }],
      },
    ]);
  });
});
