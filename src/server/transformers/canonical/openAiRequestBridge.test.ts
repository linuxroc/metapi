import { describe, expect, it } from 'vitest';

import {
  canonicalRequestFromOpenAiBody,
  canonicalRequestToOpenAiChatBody,
} from './openAiRequestBridge.js';

describe('openAiRequestBridge', () => {
  it('parses openai-compatible continuation hints into canonical envelopes', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-5',
        stream: false,
        conversation_id: 'conversation-1',
        previous_response_id: 'resp-1',
        prompt_cache_key: 'cache-1',
        metadata: {
          user_id: 'session-1',
          metapi_turn_state: 'turn-state-1',
        },
        messages: [{ role: 'user', content: 'hello' }],
      },
      surface: 'openai-responses',
    });

    expect(request).toMatchObject({
      continuation: {
        sessionId: 'session-1',
        previousResponseId: 'resp-1',
        promptCacheKey: 'cache-1',
        turnState: 'turn-state-1',
      },
    });
  });

  it('builds openai-compatible continuation fields back from canonical envelopes', () => {
    const body = canonicalRequestToOpenAiChatBody({
      operation: 'generate',
      surface: 'openai-chat',
      cliProfile: 'codex',
      requestedModel: 'gpt-5',
      stream: false,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      continuation: {
        sessionId: 'session-1',
        previousResponseId: 'resp-1',
        promptCacheKey: 'cache-1',
        turnState: 'turn-state-1',
      },
    });

    expect(body).toMatchObject({
      previous_response_id: 'resp-1',
      prompt_cache_key: 'cache-1',
      metadata: {
        user_id: 'session-1',
        metapi_turn_state: 'turn-state-1',
      },
    });
  });

  it('captures every image_url shape the Responses surface forwards into the canonical envelope', () => {
    const request = canonicalRequestFromOpenAiBody({
      body: {
        model: 'gpt-5',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'describe these' },
              { type: 'input_image', image_url: 'https://example.com/cat.png' },
              { type: 'input_image', image_url: { url: 'https://example.com/dog.png', detail: 'high' } },
              { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
              { type: 'input_image', url: 'https://example.com/bird.png' },
              { type: 'image_url', image_url: { url: 'https://example.com/fish.png' } },
            ],
          },
        ],
      },
      surface: 'openai-responses',
    });

    const userMessage = request.messages[0];
    expect(userMessage.role).toBe('user');
    const imageUrls = userMessage.parts
      .filter((part) => part.type === 'image')
      .map((part) => (part as { url?: string }).url);
    expect(imageUrls).toEqual([
      'https://example.com/cat.png',
      'https://example.com/dog.png',
      'data:image/png;base64,iVBORw0KGgo=',
      'https://example.com/bird.png',
      'https://example.com/fish.png',
    ]);
  });
});
