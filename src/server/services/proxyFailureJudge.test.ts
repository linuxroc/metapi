import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { detectProxyFailure } from './proxyFailureJudge.js';

describe('detectProxyFailure (empty content)', () => {
  const originalEmptyFail = config.proxyEmptyContentFailEnabled;
  const originalKeywords = Array.isArray(config.proxyErrorKeywords) ? [...config.proxyErrorKeywords] : config.proxyErrorKeywords;

  afterEach(() => {
    config.proxyEmptyContentFailEnabled = originalEmptyFail;
    config.proxyErrorKeywords = originalKeywords as any;
  });

  it('flags empty assistant content even when total tokens > 0', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_empty',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 12, completionTokens: 0, totalTokens: 12 },
    });

    expect(failure).toMatchObject({ status: 502 });
  });

  it('does not flag when output exists even if usage is missing', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_has_output',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hi' },
        finish_reason: 'stop',
      }],
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toBeNull();
  });

  it('does not treat tool call payloads as empty content', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'resp_tool',
      object: 'response',
      status: 'completed',
      output: [{
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_abc',
        name: 'Glob',
        arguments: '{"pattern":"README*"}',
      }],
      output_text: '',
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toBeNull();
  });

  it('does not treat reasoning-only or Gemini audio output as empty content', () => {
    config.proxyEmptyContentFailEnabled = true;

    expect(detectProxyFailure({
      rawText: JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'internal plan',
          },
          finish_reason: 'stop',
        }],
      }),
      usage: { completionTokens: 0 },
    })).toBeNull();

    expect(detectProxyFailure({
      rawText: JSON.stringify({
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              inlineData: {
                mimeType: 'audio/wav',
                data: 'UklGRg==',
              },
            }],
          },
          finishReason: 'STOP',
        }],
      }),
      usage: { completionTokens: 0 },
    })).toBeNull();
  });

  it('flags empty SSE streams that contain no content deltas', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = [
      'data: {"id":"evt_1","choices":[{"delta":{}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toMatchObject({ status: 502 });
  });

  it('treats DONE-only SSE as no output and flags failure', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = [
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    expect(failure).toMatchObject({ status: 502 });
  });

  it('truncates fractional token counts before empty-content detection', () => {
    config.proxyEmptyContentFailEnabled = true;

    const rawText = JSON.stringify({
      id: 'chatcmpl_fractional_empty',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 3.9, completion_tokens: 0.6, total_tokens: 4.5 },
    });

    const failure = detectProxyFailure({
      rawText,
      usage: { promptTokens: 3.9, completionTokens: 0.6, totalTokens: 4.5 } as any,
    });

    expect(failure).toMatchObject({ status: 502 });
  });

  it('flags Responses failure terminals even when empty-content checks are disabled', () => {
    config.proxyEmptyContentFailEnabled = false;

    expect(detectProxyFailure({
      rawText: JSON.stringify({
        type: 'response.failed',
        response: {
          status: 'failed',
          error: { message: 'tool execution failed' },
        },
      }),
    })).toEqual({
      status: 502,
      reason: 'tool execution failed',
    });
  });

  it('flags Gemini malformed and unexpected tool terminals without substring matching', () => {
    config.proxyEmptyContentFailEnabled = false;

    for (const finishReason of ['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOOL_ERROR']) {
      expect(detectProxyFailure({
        rawText: JSON.stringify({
          candidates: [{ finishReason, content: { parts: [] } }],
        }),
      })).toEqual({
        status: 502,
        reason: `Upstream returned error finish reason: ${finishReason}`,
      });
    }
  });

  it('does not treat Gemini safety or max-token terminals as transport failures', () => {
    config.proxyEmptyContentFailEnabled = false;

    expect(detectProxyFailure({
      rawText: JSON.stringify({
        candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
      }),
    })).toBeNull();
    expect(detectProxyFailure({
      rawText: JSON.stringify({
        candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }],
      }),
    })).toBeNull();
  });

  it('does not fail closed on unknown provider finish reasons', () => {
    config.proxyEmptyContentFailEnabled = false;

    expect(detectProxyFailure({
      rawText: JSON.stringify({
        candidates: [{
          finishReason: 'NEW_PROVIDER_TERMINAL',
          content: { parts: [{ text: 'completed output' }] },
        }],
      }),
    })).toBeNull();
    expect(detectProxyFailure({
      rawText: JSON.stringify({
        choices: [{
          finish_reason: 'provider_completed',
          message: { content: 'completed output' },
        }],
      }),
    })).toBeNull();
  });
});
