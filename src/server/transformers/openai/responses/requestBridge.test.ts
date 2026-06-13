import { describe, expect, it } from 'vitest';

import {
  buildCanonicalRequestToOpenAiResponsesBody,
  parseOpenAiResponsesRequestToCanonical,
} from './requestBridge.js';
import { canonicalRequestToOpenAiChatBody } from '../../canonical/openAiRequestBridge.js';

describe('openai responses request bridge', () => {
  it('parses OpenAI Responses bodies into canonical envelopes', () => {
    const result = parseOpenAiResponsesRequestToCanonical({
      model: 'gpt-5',
      input: 'hello',
      previous_response_id: 'resp_prev_1',
      prompt_cache_key: 'cache-key',
      reasoning: {
        effort: 'high',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      operation: 'generate',
      surface: 'openai-responses',
      requestedModel: 'gpt-5',
      continuation: {
        previousResponseId: 'resp_prev_1',
        promptCacheKey: 'cache-key',
      },
      reasoning: {
        effort: 'high',
      },
    });
  });

  it('builds OpenAI Responses bodies from canonical envelopes', () => {
    const body = buildCanonicalRequestToOpenAiResponsesBody({
      operation: 'generate',
      surface: 'openai-responses',
      cliProfile: 'codex',
      requestedModel: 'gpt-5',
      stream: true,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      continuation: {
        previousResponseId: 'resp_prev_1',
        promptCacheKey: 'cache-key',
      },
      reasoning: {
        effort: 'high',
      },
    });

    expect(body).toMatchObject({
      model: 'gpt-5',
      stream: true,
      store: false,
      previous_response_id: 'resp_prev_1',
      prompt_cache_key: 'cache-key',
      include: ['reasoning.encrypted_content'],
      reasoning: {
        effort: 'high',
      },
    });
  });

  it('builds Responses tool-turn history from canonical assistant reasoning and tool results', () => {
    const body = buildCanonicalRequestToOpenAiResponsesBody({
      operation: 'generate',
      surface: 'openai-responses',
      cliProfile: 'codex',
      requestedModel: 'gpt-5',
      stream: false,
      messages: [
        {
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'plan quietly',
              thought: true,
            },
            {
              type: 'tool_call',
              id: 'call_1',
              name: 'Glob',
              argumentsJson: '{"pattern":"README*"}',
            },
          ],
        },
        {
          role: 'tool',
          parts: [{
            type: 'tool_result',
            toolCallId: 'call_1',
            resultText: 'README.md',
          }],
        },
      ],
    });

    expect(body).toMatchObject({
      model: 'gpt-5',
      store: false,
      include: ['reasoning.encrypted_content'],
      input: [
        {
          type: 'reasoning',
          summary: [{
            type: 'summary_text',
            text: 'plan quietly',
          }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'Glob',
          arguments: '{"pattern":"README*"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'README.md',
        },
      ],
    });
  });

  it('preserves Chat fields that are valid only on the Responses target', () => {
    const body = buildCanonicalRequestToOpenAiResponsesBody({
      operation: 'generate',
      surface: 'openai-chat',
      cliProfile: 'generic',
      requestedModel: 'gpt-5',
      stream: false,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      generation: {
        maxToolCalls: 2,
        promptCacheRetention: { scope: 'workspace' },
        background: false,
        truncation: 'auto',
      },
    });

    expect(body).toMatchObject({
      max_tool_calls: 2,
      prompt_cache_retention: { scope: 'workspace' },
      background: false,
      truncation: 'auto',
    });
  });

  it('round-trips Responses-only generation fields through canonical form', () => {
    const parsed = parseOpenAiResponsesRequestToCanonical({
      model: 'gpt-5',
      input: 'hello',
      max_tool_calls: 2,
      prompt_cache_retention: { scope: 'workspace' },
      background: false,
      truncation: 'auto',
    });

    expect(parsed.error).toBeUndefined();
    expect(parsed.value?.generation).toMatchObject({
      maxToolCalls: 2,
      promptCacheRetention: { scope: 'workspace' },
      background: false,
      truncation: 'auto',
    });

    expect(buildCanonicalRequestToOpenAiResponsesBody(parsed.value!)).toMatchObject({
      max_tool_calls: 2,
      prompt_cache_retention: { scope: 'workspace' },
      background: false,
      truncation: 'auto',
    });
  });

  it('preserves Responses-only tools in canonical form without leaking them into Chat bodies', () => {
    const parsed = parseOpenAiResponsesRequestToCanonical({
      model: 'gpt-5',
      input: 'draw a diagram',
      tools: [
        {
          type: 'function',
          name: 'lookup',
          parameters: { type: 'object' },
        },
        {
          type: 'image_generation',
          background: 'transparent',
        },
      ],
      tool_choice: 'auto',
    });

    expect(parsed.error).toBeUndefined();
    expect(parsed.value?.tools).toEqual([
      {
        name: 'lookup',
        inputSchema: { type: 'object' },
      },
      {
        type: 'image_generation',
        raw: {
          type: 'image_generation',
          background: 'transparent',
        },
      },
    ]);

    const responsesBody = buildCanonicalRequestToOpenAiResponsesBody(parsed.value!);
    expect(responsesBody.tools).toEqual([
      {
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object' },
      },
      {
        type: 'image_generation',
        background: 'transparent',
      },
    ]);

    const chatBody = canonicalRequestToOpenAiChatBody(parsed.value!);
    expect(chatBody.tools).toEqual([{
      type: 'function',
      function: {
        name: 'lookup',
        parameters: { type: 'object' },
      },
    }]);
  });
});
