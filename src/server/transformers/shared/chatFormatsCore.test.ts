import { describe, expect, it } from 'vitest';

import {
  convertClaudeRequestToOpenAiBody,
  createClaudeDownstreamContext,
  createStreamTransformContext,
  normalizeUpstreamFinalResponse,
  normalizeUpstreamStreamEvent,
  serializeNormalizedStreamEvent,
} from './chatFormatsCore.js';

function parseOpenAiSsePayload(lines: string[]): Record<string, unknown> {
  const dataLine = lines.find((line) => line.startsWith('data: ') && line.trim() !== 'data: [DONE]');
  if (!dataLine) {
    throw new Error('expected serialized SSE payload');
  }
  return JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
}

describe('chatFormatsCore inline think parsing', () => {
  it('does not preserve arrays in object-only request fields', () => {
    const converted = convertClaudeRequestToOpenAiBody({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hello' }],
      metadata: [],
    });

    expect(converted.payload.metadata).toBeUndefined();
  });

  it('tracks split think tags across stream chunks', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      id: 'chatcmpl-split-think',
      model: 'gpt-test',
      choices: [{
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null,
      }],
    }, context, 'gpt-test')).toMatchObject({
      role: 'assistant',
    });

    const openingFragment = normalizeUpstreamStreamEvent({
      id: 'chatcmpl-split-think',
      model: 'gpt-test',
      choices: [{
        index: 0,
        delta: { content: '<thin' },
        finish_reason: null,
      }],
    }, context, 'gpt-test');
    expect(openingFragment.contentDelta).toBeUndefined();
    expect(openingFragment.reasoningDelta).toBeUndefined();

    expect(normalizeUpstreamStreamEvent({
      id: 'chatcmpl-split-think',
      model: 'gpt-test',
      choices: [{
        index: 0,
        delta: { content: 'k>plan ' },
        finish_reason: null,
      }],
    }, context, 'gpt-test')).toMatchObject({
      reasoningDelta: 'plan ',
    });

    expect(normalizeUpstreamStreamEvent({
      id: 'chatcmpl-split-think',
      model: 'gpt-test',
      choices: [{
        index: 0,
        delta: { content: 'quietly</th' },
        finish_reason: null,
      }],
    }, context, 'gpt-test')).toMatchObject({
      reasoningDelta: 'quietly',
    });

    expect(normalizeUpstreamStreamEvent({
      id: 'chatcmpl-split-think',
      model: 'gpt-test',
      choices: [{
        index: 0,
        delta: { content: 'ink>visible answer' },
        finish_reason: null,
      }],
    }, context, 'gpt-test')).toMatchObject({
      contentDelta: 'visible answer',
    });
  });

  it('treats response.reasoning_summary_text.done as reasoning-only stream output', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.reasoning_summary_text.done',
      item_id: 'rs_1',
      output_index: 0,
      summary_index: 0,
      text: 'plan first',
    }, context, 'gpt-test')).toEqual({
      reasoningDelta: 'plan first',
    });
  });

  it('accumulates reasoning summary deltas before reconciling response.reasoning_summary_text.done', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rs_multi',
      output_index: 0,
      summary_index: 0,
      delta: 'plan ',
    }, context, 'gpt-test')).toEqual({
      reasoningDelta: 'plan ',
    });

    expect(normalizeUpstreamStreamEvent({
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rs_multi',
      output_index: 0,
      summary_index: 0,
      delta: 'first',
    }, context, 'gpt-test')).toEqual({
      reasoningDelta: 'first',
    });

    expect(normalizeUpstreamStreamEvent({
      type: 'response.reasoning_summary_text.done',
      item_id: 'rs_multi',
      output_index: 0,
      summary_index: 0,
      text: 'plan first',
    }, context, 'gpt-test')).toEqual({});
  });

  it('preserves terminal-only native responses output item payloads in stream normalization', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    }, context, 'gpt-test')).toEqual({
      role: 'assistant',
      contentDelta: 'hello',
    });

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"x"}',
        status: 'completed',
      },
    }, context, 'gpt-test')).toEqual({
      toolCallDeltas: [{
        index: 0,
        id: 'call_1',
        name: 'lookup',
        argumentsDelta: '{"q":"x"}',
      }],
    });
  });

  it('emits an assistant starter chunk for tool-first responses streams', () => {
    const context = createStreamTransformContext('gpt-test');
    const claudeContext = createClaudeDownstreamContext();

    const startEvent = normalizeUpstreamStreamEvent({
      type: 'response.created',
      response: {
        id: 'resp_tool_start',
        model: 'gpt-test',
        created_at: 1706000000,
        status: 'in_progress',
        output: [],
      },
    }, context, 'gpt-test');

    const payload = parseOpenAiSsePayload(
      serializeNormalizedStreamEvent('openai', startEvent, context, claudeContext),
    );

    expect(payload).toMatchObject({
      id: 'resp_tool_start',
      model: 'gpt-test',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: '',
        },
        finish_reason: null,
      }],
    });
  });

  it('keeps responses tool-call indices stable when response.completed replays mixed output arrays', () => {
    const context = createStreamTransformContext('gpt-test');
    const claudeContext = createClaudeDownstreamContext();

    const streamingDelta = normalizeUpstreamStreamEvent({
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      call_id: 'call_1',
      name: 'lookup',
      delta: '{"q":"x"}',
    }, context, 'gpt-test');

    expect(streamingDelta).toEqual({
      toolCallDeltas: [{
        index: 0,
        id: 'call_1',
        name: 'lookup',
        argumentsDelta: '{"q":"x"}',
      }],
    });
    expect(serializeNormalizedStreamEvent('openai', streamingDelta, context, claudeContext)).toHaveLength(1);

    expect(normalizeUpstreamStreamEvent({
      type: 'response.completed',
      response: {
        id: 'resp_3',
        model: 'gpt-test',
        status: 'completed',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'working on it' }],
          },
          {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'lookup',
            arguments: '{"q":"x"}',
            status: 'completed',
          },
        ],
      },
    }, context, 'gpt-test')).toEqual({
      role: 'assistant',
      contentDelta: 'working on it',
      finishReason: 'tool_calls',
      done: true,
    });
  });

  it('keeps terminal tool-only responses completions marked as tool_calls after earlier streamed deltas', () => {
    const context = createStreamTransformContext('gpt-test');
    const claudeContext = createClaudeDownstreamContext();

    const toolStarted = normalizeUpstreamStreamEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_tool_only',
        name: 'lookup',
      },
    }, context, 'gpt-test');
    serializeNormalizedStreamEvent('openai', toolStarted, context, claudeContext);

    const toolArgs = normalizeUpstreamStreamEvent({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      call_id: 'call_tool_only',
      delta: '{"q":"x"}',
    }, context, 'gpt-test');
    serializeNormalizedStreamEvent('openai', toolArgs, context, claudeContext);

    expect(normalizeUpstreamStreamEvent({
      type: 'response.completed',
      response: {
        id: 'resp_tool_only',
        model: 'gpt-test',
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    }, context, 'gpt-test')).toEqual({
      finishReason: 'tool_calls',
      done: true,
    });
  });

  it('keeps terminal tool-only responses completions marked as tool_calls before serialization side effects', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_pre_serialization',
        type: 'function_call',
        call_id: 'call_pre_serialization',
        name: 'lookup',
      },
    }, context, 'gpt-test')).toEqual({
      toolCallDeltas: [{
        index: 0,
        id: 'call_pre_serialization',
        name: 'lookup',
      }],
    });

    expect(normalizeUpstreamStreamEvent({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      call_id: 'call_pre_serialization',
      delta: '{"q":"x"}',
    }, context, 'gpt-test')).toEqual({
      toolCallDeltas: [{
        index: 0,
        id: 'call_pre_serialization',
        argumentsDelta: '{"q":"x"}',
      }],
    });

    expect(normalizeUpstreamStreamEvent({
      type: 'response.completed',
      response: {
        id: 'resp_pre_serialization',
        model: 'gpt-test',
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    }, context, 'gpt-test')).toEqual({
      finishReason: 'tool_calls',
      done: true,
    });
  });

  it('maps response.incomplete to stop unless the incomplete reason is max_output_tokens', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.incomplete',
      response: {
        id: 'resp_incomplete_stop',
        status: 'incomplete',
      },
    }, context, 'gpt-test')).toEqual({
      finishReason: 'stop',
      done: true,
    });

    expect(normalizeUpstreamStreamEvent({
      type: 'response.incomplete',
      response: {
        id: 'resp_incomplete_length',
        status: 'incomplete',
        incomplete_details: {
          reason: 'max_output_tokens',
        },
      },
    }, context, 'gpt-test')).toEqual({
      finishReason: 'length',
      done: true,
    });
  });

  it('preserves response.failed as an error terminal instead of reporting success', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.failed',
      response: {
        id: 'resp_failed_stop',
        status: 'failed',
      },
    }, context, 'gpt-test')).toEqual({
      finishReason: 'error',
      done: true,
    });
  });

  it('preserves Anthropic reasoning signatures in final and streaming normalization', () => {
    expect(normalizeUpstreamFinalResponse({
      id: 'msg_signature_final',
      type: 'message',
      model: 'claude-sonnet-4-5',
      content: [{
        type: 'thinking',
        thinking: 'plan',
        signature: 'sig-final',
      }],
      stop_reason: 'end_turn',
    }, 'claude-sonnet-4-5')).toMatchObject({
      reasoningContent: 'plan',
      reasoningSignature: 'metapi:anthropic-signature:sig-final',
    });

    expect(normalizeUpstreamStreamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'signature_delta',
        signature: 'sig-stream',
      },
    }, createStreamTransformContext('claude-sonnet-4-5'), 'claude-sonnet-4-5')).toEqual({
      reasoningSignature: 'metapi:anthropic-signature:sig-stream',
    });
  });

  it('treats explicit tool failure terminals as errors', () => {
    expect(normalizeUpstreamFinalResponse({
      responseId: 'gemini_unknown_finish',
      modelVersion: 'gemini-test',
      candidates: [{
        finishReason: 'TOOL_ERROR',
        content: { role: 'model', parts: [] },
      }],
    }, 'gemini-test')).toMatchObject({
      finishReason: 'error',
    });
  });

  it('does not fail closed on unknown provider terminal reasons', () => {
    expect(normalizeUpstreamFinalResponse({
      responseId: 'gemini_new_finish',
      modelVersion: 'gemini-test',
      candidates: [{
        finishReason: 'NEW_PROVIDER_TERMINAL',
        content: { role: 'model', parts: [{ text: 'completed output' }] },
      }],
    }, 'gemini-test')).toMatchObject({
      content: 'completed output',
      finishReason: 'stop',
    });

    expect(normalizeUpstreamStreamEvent({
      candidates: [{
        finishReason: 'NEW_PROVIDER_TERMINAL',
        content: { role: 'model', parts: [{ text: 'completed output' }] },
      }],
    }, createStreamTransformContext('gemini-test'), 'gemini-test')).toMatchObject({
      contentDelta: 'completed output',
      finishReason: null,
    });
  });

  it('does not backfill historical tool identity into later arguments-only deltas', () => {
    const context = createStreamTransformContext('gpt-test');
    const claudeContext = createClaudeDownstreamContext();

    const started = normalizeUpstreamStreamEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_identity',
        type: 'function_call',
        call_id: 'call_identity',
        name: 'lookup',
      },
    }, context, 'gpt-test');
    serializeNormalizedStreamEvent('openai', started, context, claudeContext);

    const argumentDelta = normalizeUpstreamStreamEvent({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      call_id: 'call_identity',
      delta: '{"q":"x"}',
    }, context, 'gpt-test');

    const payload = parseOpenAiSsePayload(
      serializeNormalizedStreamEvent('openai', argumentDelta, context, claudeContext),
    );

    expect(payload).toMatchObject({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              arguments: '{"q":"x"}',
            },
          }],
        },
        finish_reason: null,
      }],
    });
    const toolCall = (((payload.choices as any[])[0] as any).delta.tool_calls[0]) as Record<string, unknown>;
    expect(toolCall.id).toBeUndefined();
    expect(toolCall.type).toBeUndefined();
    expect((toolCall.function as Record<string, unknown>).name).toBeUndefined();
  });

  it('backfills late real tool identity after earlier id-less argument deltas', () => {
    const context = createStreamTransformContext('gpt-test');
    const claudeContext = createClaudeDownstreamContext();

    const argumentDelta = normalizeUpstreamStreamEvent({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '{"q":"x"}',
    }, context, 'gpt-test');

    expect(argumentDelta).toEqual({
      toolCallDeltas: [{
        index: 0,
        argumentsDelta: '{"q":"x"}',
      }],
    });
    serializeNormalizedStreamEvent('openai', argumentDelta, context, claudeContext);

    const started = normalizeUpstreamStreamEvent({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_late_identity',
        type: 'function_call',
        call_id: 'call_late_identity',
        name: 'lookup',
        arguments: '{"q":"x"}',
      },
    }, context, 'gpt-test');

    const payload = parseOpenAiSsePayload(
      serializeNormalizedStreamEvent('openai', started, context, claudeContext),
    );

    expect(payload).toMatchObject({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_late_identity',
            type: 'function',
            function: {
              name: 'lookup',
            },
          }],
        },
        finish_reason: null,
      }],
    });
    expect(context.toolCalls[0]).toEqual({
      id: 'call_late_identity',
      name: 'lookup',
      arguments: '{"q":"x"}',
    });
  });

  it('preserves terminal response.completed payload output when it carries the only final content', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'hello' }],
          },
        ],
      },
    }, context, 'gpt-test')).toEqual({
      role: 'assistant',
      contentDelta: 'hello',
      finishReason: 'stop',
      done: true,
    });
  });

  it('preserves streamed trailing whitespace when reconciling response.completed content', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_text.delta',
      output_index: 0,
      item_id: 'msg_ws_space',
      delta: 'hello ',
    }, context, 'gpt-test')).toEqual({
      contentDelta: 'hello ',
    });

    expect(normalizeUpstreamStreamEvent({
      type: 'response.completed',
      response: {
        id: 'resp_space_1',
        status: 'completed',
        output: [
          {
            id: 'msg_ws_space',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'hello world' }],
          },
        ],
      },
    }, context, 'gpt-test')).toEqual({
      role: 'assistant',
      contentDelta: 'world',
      finishReason: 'stop',
      done: true,
    });
  });

  it('preserves terminal response.completed custom tool metadata in stream normalization', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.completed',
      response: {
        id: 'resp_2',
        model: 'gpt-test',
        status: 'completed',
        output: [
          {
            id: 'ct_1',
            type: 'custom_tool_call',
            call_id: 'call_custom_1',
            name: 'Shell',
            input: '{"command":"pwd"}',
          },
        ],
      },
    }, context, 'gpt-test')).toEqual({
      toolCallDeltas: [{
        index: 0,
        id: 'call_custom_1',
        name: 'Shell',
        argumentsDelta: '{"command":"pwd"}',
      }],
      finishReason: 'tool_calls',
      done: true,
    });
  });

  it('normalizes custom tool calls through the existing tool-call stream shape', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'ct_1',
        type: 'custom_tool_call',
        call_id: 'call_custom',
        name: 'MyTool',
        input: '',
      },
    }, context, 'gpt-test')).toEqual({
      toolCallDeltas: [{
        index: 0,
        id: 'call_custom',
        name: 'MyTool',
      }],
    });

    expect(normalizeUpstreamStreamEvent({
      type: 'response.custom_tool_call_input.done',
      output_index: 0,
      item_id: 'ct_1',
      call_id: 'call_custom',
      name: 'MyTool',
      input: '{"path":"README.md"}',
    }, context, 'gpt-test')).toEqual({
      toolCallDeltas: [{
        index: 0,
        id: 'call_custom',
        name: 'MyTool',
        argumentsDelta: '{"path":"README.md"}',
      }],
    });
  });

  it('maps final Responses payload statuses to sub2api-like chat finish reasons', () => {
    expect(normalizeUpstreamFinalResponse({
      id: 'resp_final_stop',
      object: 'response',
      status: 'incomplete',
      output: [],
    }, 'gpt-test')).toMatchObject({
      finishReason: 'stop',
    });

    expect(normalizeUpstreamFinalResponse({
      id: 'resp_final_length',
      object: 'response',
      status: 'incomplete',
      incomplete_details: {
        reason: 'max_output_tokens',
      },
      output: [],
    }, 'gpt-test')).toMatchObject({
      finishReason: 'length',
    });

    expect(normalizeUpstreamFinalResponse({
      id: 'resp_final_failed',
      object: 'response',
      status: 'failed',
      output: [],
    }, 'gpt-test')).toMatchObject({
      finishReason: 'error',
    });
  });
});

describe('chatFormatsCore protocol regressions', () => {
  it('maps Anthropic model context window termination to length', () => {
    expect(normalizeUpstreamFinalResponse({
      id: 'msg_context_limit',
      type: 'message',
      model: 'claude-test',
      content: [{ type: 'text', text: 'partial' }],
      stop_reason: 'model_context_window_exceeded',
    }, 'claude-test')).toMatchObject({
      content: 'partial',
      finishReason: 'length',
    });

    const context = createStreamTransformContext('claude-test');
    expect(normalizeUpstreamStreamEvent({
      type: 'message_delta',
      delta: {
        stop_reason: 'model_context_window_exceeded',
      },
    }, context, 'claude-test')).toMatchObject({
      finishReason: 'length',
    });
  });

  it('does not terminate Gemini SSE on a non-terminal function-call chunk', () => {
    const context = createStreamTransformContext('gemini-test');
    const claudeContext = createClaudeDownstreamContext();
    const normalized = normalizeUpstreamStreamEvent({
      responseId: 'gemini-response-1',
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call_1',
              name: 'lookup',
              args: { q: 'weather' },
            },
          }],
        },
      }],
    }, context, 'gemini-test');

    expect(normalized.finishReason).toBeNull();
    const payload = parseOpenAiSsePayload(
      serializeNormalizedStreamEvent('openai', normalized, context, claudeContext),
    );
    expect((payload.choices as any[])[0].finish_reason).toBeNull();
  });

  it('preserves Gemini function-call thought signatures in OpenAI SSE', () => {
    const context = createStreamTransformContext('gemini-test');
    const claudeContext = createClaudeDownstreamContext();
    const normalized = normalizeUpstreamStreamEvent({
      responseId: 'gemini-response-2',
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call_2',
              name: 'lookup',
              args: { q: 'weather' },
            },
            thoughtSignature: 'gemini-tool-signature',
          }],
        },
      }],
    }, context, 'gemini-test');

    expect(normalized.toolCallDeltas).toEqual([{
      index: 0,
      id: 'call_2',
      name: 'lookup',
      argumentsDelta: '{"q":"weather"}',
      thoughtSignature: 'gemini-tool-signature',
    }]);
    const payload = parseOpenAiSsePayload(
      serializeNormalizedStreamEvent('openai', normalized, context, claudeContext),
    );
    expect(payload).toMatchObject({
      choices: [{
        delta: {
          tool_calls: [{
            provider_specific_fields: {
              thought_signature: 'gemini-tool-signature',
            },
          }],
        },
        finish_reason: null,
      }],
    });
  });
});

describe('convertClaudeRequestToOpenAiBody', () => {
  it('does not invent a max_tokens limit when the downstream request omits it', () => {
    const { payload } = convertClaudeRequestToOpenAiBody({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(payload.max_tokens).toBeUndefined();
  });

  it('maps Claude disabled parallel tool use to OpenAI parallel_tool_calls', () => {
    const { payload } = convertClaudeRequestToOpenAiBody({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'lookup',
        input_schema: { type: 'object' },
      }],
      tool_choice: {
        type: 'auto',
        disable_parallel_tool_use: true,
      },
    });

    expect(payload).toMatchObject({
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });
  });

  it('keeps Claude tool_result content structured when a tool produces image blocks', () => {
    const payload = {
      model: 'gpt-test',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call-image',
              name: 'ImageTool',
              input: { query: 'cat' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-image',
              content: [
                { type: 'text', text: 'found 1' },
                {
                  type: 'image',
                  source: {
                    type: 'url',
                    url: 'https://example.com/cat.png',
                    media_type: 'image/png',
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const { messages } = convertClaudeRequestToOpenAiBody(payload);
    const toolMessage = messages.find((message) => message.role === 'tool');
    expect(toolMessage).toBeTruthy();
    expect(Array.isArray(toolMessage?.content)).toBe(true);
    expect(toolMessage?.content.some((part: any) => part?.type === 'image_url')).toBe(true);
  });
});
