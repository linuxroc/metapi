import { describe, expect, it } from 'vitest';

import { serializeAnthropicFinalAsStream } from '../../transformers/anthropic/messages/streamBridge.js';
import {
  normalizeUpstreamSseTextToFinal,
  serializeNormalizedFinalToGemini,
} from '../../transformers/gemini/generate-content/compatibility.js';
import { geminiGenerateContentStream } from '../../transformers/gemini/generate-content/streamBridge.js';
import { buildNormalizedFinalToOpenAiChatChunks } from '../../transformers/openai/chat/responseBridge.js';
import { buildNormalizedFinalToOpenAiResponsesPayload } from '../../transformers/openai/responses/responseBridge.js';
import { serializeResponsesUpstreamFinalAsStream } from '../../transformers/openai/responses/streamBridge.js';
import {
  createClaudeDownstreamContext,
  createStreamTransformContext,
  type NormalizedFinalResponse,
} from '../../transformers/shared/normalized.js';

type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini';
type StreamFeature = 'text-reasoning' | 'tool-call';

const protocols: Protocol[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'gemini',
];
const features: StreamFeature[] = ['text-reasoning', 'tool-call'];

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function buildSourceSse(protocol: Protocol, feature: StreamFeature): string {
  if (feature === 'text-reasoning') {
    if (protocol === 'openai-chat') {
      return [
        sseData({
          id: 'chat_matrix',
          model: 'matrix-model',
          choices: [{
            index: 0,
            delta: { role: 'assistant', reasoning_content: 'plan' },
            finish_reason: null,
          }],
        }),
        sseData({
          id: 'chat_matrix',
          model: 'matrix-model',
          choices: [{
            index: 0,
            delta: { content: 'sunny' },
            finish_reason: 'stop',
          }],
        }),
        'data: [DONE]\n\n',
      ].join('');
    }

    if (protocol === 'openai-responses') {
      return [
        sseEvent('response.created', {
          type: 'response.created',
          response: {
            id: 'resp_matrix',
            model: 'matrix-model',
            status: 'in_progress',
            output: [],
          },
        }),
        sseEvent('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          output_index: 0,
          delta: 'plan',
        }),
        sseEvent('response.output_text.delta', {
          type: 'response.output_text.delta',
          output_index: 1,
          delta: 'sunny',
        }),
        sseEvent('response.completed', {
          type: 'response.completed',
          response: {
            id: 'resp_matrix',
            model: 'matrix-model',
            status: 'completed',
            output: [
              {
                type: 'reasoning',
                summary: [{ type: 'summary_text', text: 'plan' }],
              },
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'sunny' }],
              },
            ],
          },
        }),
        'data: [DONE]\n\n',
      ].join('');
    }

    if (protocol === 'anthropic-messages') {
      return [
        sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_matrix',
            model: 'matrix-model',
            role: 'assistant',
            content: [],
          },
        }),
        sseEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'plan' },
        }),
        sseEvent('content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        }),
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'sunny' },
        }),
        sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
        }),
        sseEvent('message_stop', { type: 'message_stop' }),
      ].join('');
    }

    return sseData({
      responseId: 'gemini_matrix',
      modelVersion: 'matrix-model',
      candidates: [{
        index: 0,
        finishReason: 'STOP',
        content: {
          role: 'model',
          parts: [
            { text: 'plan', thought: true },
            { text: 'sunny' },
          ],
        },
      }],
    });
  }

  if (protocol === 'openai-chat') {
    return [
      sseData({
        id: 'chat_tool_matrix',
        model: 'matrix-model',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_weather',
              type: 'function',
              function: {
                name: 'lookup_weather',
                arguments: '{"city":"Paris"}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
      'data: [DONE]\n\n',
    ].join('');
  }

  if (protocol === 'openai-responses') {
    return [
      sseEvent('response.created', {
        type: 'response.created',
        response: {
          id: 'resp_tool_matrix',
          model: 'matrix-model',
          status: 'in_progress',
          output: [],
        },
      }),
      sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'fc_weather',
          type: 'function_call',
          call_id: 'call_weather',
          name: 'lookup_weather',
          arguments: '',
        },
      }),
      sseEvent('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'fc_weather',
        call_id: 'call_weather',
        delta: '{"city":"Paris"}',
      }),
      sseEvent('response.completed', {
        type: 'response.completed',
        response: {
          id: 'resp_tool_matrix',
          model: 'matrix-model',
          status: 'completed',
          output: [{
            id: 'fc_weather',
            type: 'function_call',
            call_id: 'call_weather',
            name: 'lookup_weather',
            arguments: '{"city":"Paris"}',
          }],
        },
      }),
      'data: [DONE]\n\n',
    ].join('');
  }

  if (protocol === 'anthropic-messages') {
    return [
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_tool_matrix',
          model: 'matrix-model',
          role: 'assistant',
          content: [],
        },
      }),
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_weather',
          name: 'lookup_weather',
          input: {},
        },
      }),
      sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"city":"Paris"}',
        },
      }),
      sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
      }),
      sseEvent('message_stop', { type: 'message_stop' }),
    ].join('');
  }

  return sseData({
    responseId: 'gemini_tool_matrix',
    modelVersion: 'matrix-model',
    candidates: [{
      index: 0,
      finishReason: 'STOP',
      content: {
        role: 'model',
        parts: [{
          functionCall: {
            id: 'call_weather',
            name: 'lookup_weather',
            args: { city: 'Paris' },
          },
        }],
      },
    }],
  });
}

function serializeTargetSse(
  protocol: Protocol,
  normalized: NormalizedFinalResponse,
): string {
  if (protocol === 'openai-chat') {
    return [
      ...buildNormalizedFinalToOpenAiChatChunks(normalized)
        .map((chunk) => sseData(chunk)),
      'data: [DONE]\n\n',
    ].join('');
  }

  if (protocol === 'openai-responses') {
    const usage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const payload = buildNormalizedFinalToOpenAiResponsesPayload({
      upstreamPayload: null,
      normalized,
      usage,
    });
    return serializeResponsesUpstreamFinalAsStream({
      payload,
      modelName: normalized.model,
      fallbackText: '',
      usage,
    }).lines.join('');
  }

  if (protocol === 'anthropic-messages') {
    return serializeAnthropicFinalAsStream(
      normalized,
      createStreamTransformContext(normalized.model),
      createClaudeDownstreamContext(),
    ).join('');
  }

  return geminiGenerateContentStream.serializeSsePayload(
    serializeNormalizedFinalToGemini({ normalized }),
  );
}

function normalizeSse(rawText: string): NormalizedFinalResponse {
  return normalizeUpstreamSseTextToFinal({
    rawText,
    modelName: 'matrix-model',
  }).normalized;
}

function parseJsonArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function expectFeatureSemantics(
  normalized: NormalizedFinalResponse,
  feature: StreamFeature,
): void {
  if (feature === 'text-reasoning') {
    expect(normalized.content).toBe('sunny');
    expect(normalized.reasoningContent).toBe('plan');
    expect(normalized.toolCalls).toEqual([]);
    return;
  }

  expect(normalized.content).toBe('');
  expect(normalized.finishReason).toBe('tool_calls');
  expect(normalized.toolCalls).toHaveLength(1);
  expect(normalized.toolCalls[0]).toMatchObject({
    id: 'call_weather',
    name: 'lookup_weather',
  });
  expect(parseJsonArguments(normalized.toolCalls[0].arguments)).toEqual({
    city: 'Paris',
  });
}

describe('SSE protocol semantic matrix', () => {
  for (const source of protocols) {
    for (const target of protocols) {
      for (const feature of features) {
        it(`${source} -> ${target}; feature=${feature}`, () => {
          const sourceNormalized = normalizeSse(buildSourceSse(source, feature));
          expectFeatureSemantics(sourceNormalized, feature);

          const targetSse = serializeTargetSse(target, sourceNormalized);
          const targetNormalized = normalizeSse(targetSse);
          expectFeatureSemantics(targetNormalized, feature);
        });
      }
    }
  }

  it('rejects Responses failure terminals before Gemini serialization', () => {
    expect(() => normalizeSse([
      sseEvent('response.created', {
        type: 'response.created',
        response: {
          id: 'resp_failed_matrix',
          model: 'matrix-model',
          status: 'in_progress',
          output: [],
        },
      }),
      sseEvent('response.failed', {
        type: 'response.failed',
        response: {
          id: 'resp_failed_matrix',
          model: 'matrix-model',
          status: 'failed',
          error: { message: 'tool execution failed' },
        },
      }),
      'data: [DONE]\n\n',
    ].join(''))).toThrow('tool execution failed');
  });

  for (const target of protocols) {
    it(`anthropic signature_delta -> ${target}; preserves the opaque reasoning signature`, () => {
      const sourceNormalized = normalizeSse([
        sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_signature_matrix',
            model: 'matrix-model',
            role: 'assistant',
            content: [],
          },
        }),
        sseEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'plan' },
        }),
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-matrix' },
        }),
        sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
        }),
        sseEvent('message_stop', { type: 'message_stop' }),
      ].join(''));

      expect(sourceNormalized.reasoningSignature).toBe('metapi:anthropic-signature:sig-matrix');

      const targetNormalized = normalizeSse(serializeTargetSse(target, sourceNormalized));
      expect(targetNormalized.reasoningSignature).toBe('metapi:anthropic-signature:sig-matrix');
    });
  }

  for (const target of protocols) {
    it(`gemini parallel tool chunks -> ${target}; preserves call identity`, () => {
      const sourceNormalized = normalizeSse([
        sseData({
          responseId: 'gemini_parallel_matrix',
          modelVersion: 'matrix-model',
          candidates: [{
            index: 0,
            content: {
              role: 'model',
              parts: [{
                functionCall: {
                  id: 'call_a',
                  name: 'lookup_a',
                  args: { x: 1 },
                },
              }],
            },
          }],
        }),
        sseData({
          responseId: 'gemini_parallel_matrix',
          modelVersion: 'matrix-model',
          candidates: [{
            index: 0,
            finishReason: 'STOP',
            content: {
              role: 'model',
              parts: [{
                functionCall: {
                  id: 'call_b',
                  name: 'lookup_b',
                  args: { y: 2 },
                },
              }],
            },
          }],
        }),
      ].join(''));

      expect(sourceNormalized.toolCalls.map((call) => call.id)).toEqual(['call_a', 'call_b']);

      const targetNormalized = normalizeSse(serializeTargetSse(target, sourceNormalized));
      expect(targetNormalized.toolCalls).toHaveLength(2);
      expect(targetNormalized.toolCalls.map((call) => call.id)).toEqual(['call_a', 'call_b']);
      expect(targetNormalized.toolCalls.map((call) => call.name)).toEqual(['lookup_a', 'lookup_b']);
    });
  }
});
