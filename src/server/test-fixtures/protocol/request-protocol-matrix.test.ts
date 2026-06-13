import { describe, expect, it } from 'vitest';

import {
  buildCanonicalRequestToAnthropicMessagesBody,
  parseAnthropicMessagesRequestToCanonical,
} from '../../transformers/anthropic/messages/requestBridge.js';
import type {
  CanonicalRequestEnvelope,
} from '../../transformers/canonical/types.js';
import {
  buildCanonicalRequestToGeminiGenerateContentBody,
  parseGeminiGenerateContentRequestToCanonical,
} from '../../transformers/gemini/generate-content/requestBridge.js';
import {
  buildCanonicalRequestToOpenAiChatBody,
  parseOpenAiChatRequestToCanonical,
} from '../../transformers/openai/chat/requestBridge.js';
import {
  buildCanonicalRequestToOpenAiResponsesBody,
  parseOpenAiResponsesRequestToCanonical,
} from '../../transformers/openai/responses/requestBridge.js';

type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini';
type Feature = 'tools' | 'images' | 'structured-output';
type ParseResult = {
  value?: CanonicalRequestEnvelope;
  error?: { statusCode: number; payload: unknown };
};

const protocols: Protocol[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'gemini',
];
const features: Feature[] = ['tools', 'images', 'structured-output'];
const imageData = 'iVBORw0KGgo=';
const weatherSchema = {
  type: 'object',
  properties: {
    temperature: { type: 'number' },
  },
  required: ['temperature'],
};
const weatherToolSchema = {
  type: 'object',
  oneOf: [
    { required: ['city'] },
    { required: ['coordinates'] },
  ],
  properties: {
    city: { type: 'string' },
    coordinates: {
      type: 'object',
      properties: {
        latitude: { type: 'number' },
        longitude: { type: 'number' },
      },
      required: ['latitude', 'longitude'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function collectRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRecords(item));
  }
  if (!isRecord(value)) return [];
  return [
    value,
    ...Object.values(value).flatMap((item) => collectRecords(item)),
  ];
}

function parseJsonSemantic(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getCanonicalToolResult(request: CanonicalRequestEnvelope): unknown {
  const result = request.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === 'tool_result');
  if (!result || result.type !== 'tool_result') return undefined;
  if (result.resultJson !== undefined) return result.resultJson;
  if (result.resultText !== undefined) return parseJsonSemantic(result.resultText);
  return parseJsonSemantic(result.resultContent);
}

function buildSourceBody(
  protocol: Protocol,
  feature: Feature,
  stream: boolean,
): Record<string, unknown> {
  if (protocol === 'openai-chat') {
    const body: Record<string, unknown> = {
      model: 'matrix-model',
      stream,
      messages: [{ role: 'user', content: 'hello' }],
    };
    if (feature === 'tools') {
      body.messages = [
        { role: 'user', content: 'lookup weather' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_weather',
            type: 'function',
            function: {
              name: 'lookup_weather',
              arguments: '{"city":"Paris"}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_weather',
          content: '{"temperature":22}',
        },
      ];
      body.tools = [{
        type: 'function',
        function: {
          name: 'lookup_weather',
          parameters: weatherToolSchema,
        },
      }];
      body.tool_choice = 'required';
      body.parallel_tool_calls = false;
    } else if (feature === 'images') {
      body.messages = [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe image' },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${imageData}`,
            },
          },
        ],
      }];
    } else {
      body.messages = [{ role: 'user', content: 'return weather JSON' }];
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'weather',
          schema: weatherSchema,
        },
      };
    }
    return body;
  }

  if (protocol === 'openai-responses') {
    const body: Record<string, unknown> = {
      model: 'matrix-model',
      stream,
      input: 'hello',
    };
    if (feature === 'tools') {
      body.input = [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'lookup weather' }],
        },
        {
          type: 'function_call',
          call_id: 'call_weather',
          name: 'lookup_weather',
          arguments: '{"city":"Paris"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_weather',
          output: '{"temperature":22}',
        },
      ];
      body.tools = [{
        type: 'function',
        name: 'lookup_weather',
        parameters: weatherToolSchema,
      }];
      body.tool_choice = 'required';
      body.parallel_tool_calls = false;
    } else if (feature === 'images') {
      body.input = [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'describe image' },
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${imageData}`,
          },
        ],
      }];
    } else {
      body.input = 'return weather JSON';
      body.text = {
        format: {
          type: 'json_schema',
          name: 'weather',
          schema: weatherSchema,
        },
      };
    }
    return body;
  }

  if (protocol === 'anthropic-messages') {
    const body: Record<string, unknown> = {
      model: 'matrix-model',
      stream,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    };
    if (feature === 'tools') {
      body.messages = [
        { role: 'user', content: 'lookup weather' },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'call_weather',
            name: 'lookup_weather',
            input: { city: 'Paris' },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_weather',
            content: '{"temperature":22}',
          }],
        },
      ];
      body.tools = [{
        name: 'lookup_weather',
        input_schema: weatherToolSchema,
      }];
      body.tool_choice = {
        type: 'any',
        disable_parallel_tool_use: true,
      };
    } else if (feature === 'images') {
      body.messages = [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe image' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: imageData,
            },
          },
        ],
      }];
    } else {
      body.messages = [{ role: 'user', content: 'return weather JSON' }];
      body.output_config = {
        format: {
          type: 'json_schema',
          schema: weatherSchema,
        },
      };
    }
    return body;
  }

  const body: Record<string, unknown> = {
    model: 'matrix-model',
    stream,
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  };
  if (feature === 'tools') {
    body.contents = [
      { role: 'user', parts: [{ text: 'lookup weather' }] },
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
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call_weather',
            name: 'lookup_weather',
            response: { temperature: 22 },
          },
        }],
      },
    ];
    body.tools = [{
      functionDeclarations: [{
        name: 'lookup_weather',
        parametersJsonSchema: weatherToolSchema,
      }],
    }];
    body.toolConfig = {
      functionCallingConfig: {
        mode: 'ANY',
      },
    };
  } else if (feature === 'images') {
    body.contents = [{
      role: 'user',
      parts: [
        { text: 'describe image' },
        {
          inlineData: {
            mimeType: 'image/png',
            data: imageData,
          },
        },
      ],
    }];
  } else {
    body.contents = [{ role: 'user', parts: [{ text: 'return weather JSON' }] }];
    body.generationConfig = {
      responseMimeType: 'application/json',
      responseJsonSchema: weatherSchema,
    };
  }
  return body;
}

function parseProtocol(protocol: Protocol, body: unknown): ParseResult {
  if (protocol === 'openai-chat') return parseOpenAiChatRequestToCanonical(body);
  if (protocol === 'openai-responses') return parseOpenAiResponsesRequestToCanonical(body);
  if (protocol === 'anthropic-messages') return parseAnthropicMessagesRequestToCanonical(body);
  return parseGeminiGenerateContentRequestToCanonical(body);
}

function buildProtocol(
  protocol: Protocol,
  request: CanonicalRequestEnvelope,
): Record<string, unknown> {
  if (protocol === 'openai-chat') return buildCanonicalRequestToOpenAiChatBody(request);
  if (protocol === 'openai-responses') return buildCanonicalRequestToOpenAiResponsesBody(request);
  if (protocol === 'anthropic-messages') {
    return buildCanonicalRequestToAnthropicMessagesBody(request, {
      defaultMaxTokens: 8_192,
    });
  }
  return buildCanonicalRequestToGeminiGenerateContentBody(request);
}

function expectCanonicalFeature(
  request: CanonicalRequestEnvelope,
  feature: Feature,
): void {
  const parts = request.messages.flatMap((message) => message.parts);
  if (feature === 'tools') {
    expect(request.tools?.find((tool) => 'name' in tool && tool.name === 'lookup_weather')).toMatchObject({
      name: 'lookup_weather',
      inputSchema: weatherToolSchema,
    });
    expect(parts).toContainEqual(expect.objectContaining({
      type: 'tool_call',
      id: 'call_weather',
      name: 'lookup_weather',
    }));
    expect(parts).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      toolCallId: 'call_weather',
    }));
    expect(getCanonicalToolResult(request)).toEqual({ temperature: 22 });
    return;
  }

  if (feature === 'images') {
    const imagePart = parts.find((part) => part.type === 'image');
    expect(imagePart).toBeDefined();
    if (imagePart?.type === 'image') {
      const source = imagePart.dataUrl ?? imagePart.url ?? '';
      expect(
        imagePart.mimeType === 'image/png'
        || source.startsWith('data:image/png;base64,'),
      ).toBe(true);
    }
    return;
  }

  expect(request.generation?.responseFormat).toMatchObject({
    type: 'json_schema',
  });
  const responseFormat = request.generation?.responseFormat;
  expect(isRecord(responseFormat) && isRecord(responseFormat.json_schema)
    ? responseFormat.json_schema.schema
    : undefined).toMatchObject(weatherSchema);
}

function expectNativeTargetFeature(
  protocol: Protocol,
  body: Record<string, unknown>,
  feature: Feature,
  stream: boolean,
): void {
  const records = collectRecords(body);
  if (protocol === 'gemini') {
    expect(body.stream).toBeUndefined();
  } else {
    expect(body.stream).toBe(stream);
  }

  if (feature === 'tools') {
    expect(records.some((record) => record.name === 'lookup_weather')).toBe(true);
    if (protocol === 'openai-chat') {
      expect(records.some((record) => record.id === 'call_weather' && isRecord(record.function))).toBe(true);
      expect(records.some((record) => record.tool_call_id === 'call_weather')).toBe(true);
    } else if (protocol === 'openai-responses') {
      expect(records.some((record) => (
        record.type === 'function_call' && record.call_id === 'call_weather'
      ))).toBe(true);
      expect(records.some((record) => (
        record.type === 'function_call_output' && record.call_id === 'call_weather'
      ))).toBe(true);
    } else if (protocol === 'anthropic-messages') {
      expect(records.some((record) => (
        record.type === 'tool_use' && record.id === 'call_weather'
      ))).toBe(true);
      expect(records.some((record) => (
        record.type === 'tool_result' && record.tool_use_id === 'call_weather'
      ))).toBe(true);
    } else {
      expect(records.some((record) => (
        isRecord(record.functionCall)
        && record.functionCall.id === 'call_weather'
      ))).toBe(true);
      expect(records.some((record) => (
        isRecord(record.functionResponse)
        && record.functionResponse.id === 'call_weather'
      ))).toBe(true);
    }
    return;
  }

  if (feature === 'images') {
    if (protocol === 'openai-chat') {
      expect(records.some((record) => record.type === 'image_url')).toBe(true);
    } else if (protocol === 'openai-responses') {
      expect(records.some((record) => record.type === 'input_image')).toBe(true);
    } else if (protocol === 'anthropic-messages') {
      expect(records.some((record) => record.type === 'image')).toBe(true);
    } else {
      expect(records.some((record) => isRecord(record.inlineData))).toBe(true);
    }
    return;
  }

  if (protocol === 'openai-chat') {
    expect(body.response_format).toMatchObject({ type: 'json_schema' });
  } else if (protocol === 'openai-responses') {
    expect(body.text).toMatchObject({
      format: {
        type: 'json_schema',
        name: expect.stringMatching(/\S/),
        schema: weatherSchema,
      },
    });
  } else if (protocol === 'anthropic-messages') {
    expect(body.output_config).toMatchObject({
      format: { type: 'json_schema', schema: weatherSchema },
    });
  } else {
    expect(body.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: weatherSchema,
    });
  }
}

describe('canonical request protocol matrix', () => {
  for (const source of protocols) {
    for (const target of protocols) {
      for (const stream of [false, true]) {
        for (const feature of features) {
          it(`${source} -> ${target}; stream=${stream}; feature=${feature}`, () => {
            const sourceResult = parseProtocol(
              source,
              buildSourceBody(source, feature, stream),
            );
            expect(sourceResult.error).toBeUndefined();
            expect(sourceResult.value).toBeDefined();
            const canonical = sourceResult.value!;
            expect(canonical.stream).toBe(stream);
            expectCanonicalFeature(canonical, feature);

            const targetBody = buildProtocol(target, canonical);
            expectNativeTargetFeature(target, targetBody, feature, stream);
            if (feature === 'tools' && canonical.parallelToolCalls === false) {
              if (target === 'openai-chat' || target === 'openai-responses') {
                expect(targetBody.parallel_tool_calls).toBe(false);
              } else if (target === 'anthropic-messages') {
                expect(targetBody.tool_choice).toMatchObject({
                  disable_parallel_tool_use: true,
                });
              }
            }

            const targetResult = parseProtocol(
              target,
              target === 'gemini'
                ? {
                  ...targetBody,
                  model: canonical.requestedModel,
                  stream,
                }
                : targetBody,
            );
            expect(targetResult.error).toBeUndefined();
            expect(targetResult.value).toBeDefined();
            expect(targetResult.value!.stream).toBe(stream);
            expectCanonicalFeature(targetResult.value!, feature);
            if (
              feature === 'tools'
              && canonical.parallelToolCalls === false
              && target !== 'gemini'
            ) {
              expect(targetResult.value!.parallelToolCalls).toBe(false);
            }
          });
        }
      }
    }
  }
});
