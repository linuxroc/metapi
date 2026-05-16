import { describe, expect, it } from 'vitest';

import { extractAnthropicMessagesSessionId } from './sessionId.js';

/**
 * Parameterized coverage for {@link extractAnthropicMessagesSessionId}.
 *
 * The cases below mirror Testing Strategy §1 of the
 * `session-stick-routing` design document (≥ 14 rows mandated). Each row
 * asserts both the return TYPE and the return VALUE, so we never rely on
 * truthy/falsy fuzzy matching:
 *   - When `expected` is `null`, assert `toBeNull()` exactly.
 *   - When `expected` is a string, assert `typeof === 'string'` and the
 *     equality of the trimmed value.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 11.2
 * Properties: P1, P2
 */
describe('extractAnthropicMessagesSessionId', () => {
  it.each<{ description: string; input: unknown; expected: string | null }>([
    // -----------------------------------------------------------------------
    // Single tool_result block on a single user message.
    // -----------------------------------------------------------------------
    {
      description: 'returns the tool_use_id when a single user message has one tool_result block',
      input: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' },
            ],
          },
        ],
      },
      expected: 'toolu_a',
    },

    // -----------------------------------------------------------------------
    // Multiple tool_result blocks within one message: pick the LAST in
    // document order.
    // -----------------------------------------------------------------------
    {
      description: 'picks the last tool_result block in document order within a single user message',
      input: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_a', content: 'first' },
              { type: 'tool_result', tool_use_id: 'toolu_b', content: 'second' },
            ],
          },
        ],
      },
      expected: 'toolu_b',
    },

    // -----------------------------------------------------------------------
    // Multiple user messages each with their own tool_result: pick the LAST
    // across the whole document order.
    // -----------------------------------------------------------------------
    {
      description: 'picks the last tool_result across multiple user messages in document order',
      input: {
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_first', content: 'a' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'between' }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_middle', content: 'b' },
              { type: 'tool_result', tool_use_id: 'toolu_last', content: 'c' },
            ],
          },
        ],
      },
      expected: 'toolu_last',
    },

    // -----------------------------------------------------------------------
    // Trim semantics: surrounding whitespace must be stripped.
    // -----------------------------------------------------------------------
    {
      description: 'trims surrounding whitespace from the matched tool_use_id',
      input: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: '  toolu_x  ', content: 'ok' },
            ],
          },
        ],
      },
      expected: 'toolu_x',
    },

    // -----------------------------------------------------------------------
    // Single block whose tool_use_id is empty / whitespace-only / non-string:
    // each must yield null because the block does not contribute a candidate.
    // -----------------------------------------------------------------------
    {
      description: 'returns null when the only tool_result block has an empty tool_use_id',
      input: {
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: '', content: 'ok' }],
          },
        ],
      },
      expected: null,
    },
    {
      description: 'returns null when the only tool_result block has a whitespace-only tool_use_id',
      input: {
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: '   ', content: 'ok' }],
          },
        ],
      },
      expected: null,
    },
    {
      description: 'returns null when the only tool_result block has a non-string tool_use_id',
      input: {
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 123, content: 'ok' }],
          },
        ],
      },
      expected: null,
    },

    // -----------------------------------------------------------------------
    // Mixed-block content: must match only blocks with type === 'tool_result'.
    // tool_use / text blocks must be ignored even if they look superficially
    // similar.
    // -----------------------------------------------------------------------
    {
      description: 'matches only tool_result blocks when content mixes tool_use and text blocks',
      input: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'human turn' },
              { type: 'tool_use', id: 'toolu_should_be_ignored', name: 'calc', input: {} },
              { type: 'tool_result', tool_use_id: 'toolu_real', content: 'value' },
              { type: 'text', text: 'trailing' },
            ],
          },
        ],
      },
      expected: 'toolu_real',
    },

    // -----------------------------------------------------------------------
    // No tool_result blocks anywhere.
    // -----------------------------------------------------------------------
    {
      description: 'returns null when content only contains text blocks',
      input: {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
          },
        ],
      },
      expected: null,
    },

    // -----------------------------------------------------------------------
    // messages field shape errors.
    // -----------------------------------------------------------------------
    {
      description: 'returns null when messages field is missing',
      input: { model: 'claude-sonnet-4-5' },
      expected: null,
    },
    {
      description: 'returns null when messages is a string instead of an array',
      input: { messages: 'not an array' },
      expected: null,
    },

    // -----------------------------------------------------------------------
    // parsedBody itself has the wrong shape.
    // -----------------------------------------------------------------------
    {
      description: 'returns null when parsedBody is null',
      input: null,
      expected: null,
    },
    {
      description: 'returns null when parsedBody is undefined',
      input: undefined,
      expected: null,
    },
    {
      description: 'returns null when parsedBody is a primitive string',
      input: 'string body',
      expected: null,
    },
    {
      description: 'returns null when parsedBody is a primitive number',
      input: 42,
      expected: null,
    },
    {
      description: 'returns null when parsedBody is a top-level array',
      input: [{ messages: [] }],
      expected: null,
    },

    // -----------------------------------------------------------------------
    // Per-message content shape errors: skip silently and look at the rest.
    // -----------------------------------------------------------------------
    {
      description: 'returns null when content is a string (even if it mentions tool_result)',
      input: {
        messages: [
          {
            role: 'user',
            content: 'tool_result toolu_pretend',
          },
        ],
      },
      expected: null,
    },
    {
      description: 'skips messages with non-array content but still picks tool_result from the next valid message',
      input: {
        messages: [
          { role: 'user', content: 'tool_result toolu_pretend' },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_real', content: 'ok' },
            ],
          },
        ],
      },
      expected: 'toolu_real',
    },

    // -----------------------------------------------------------------------
    // Hard constraint (Requirement 2.3): the extractor MUST NOT read
    // metadata.user_id, prompt_cache_key, or previous_response_id.
    // -----------------------------------------------------------------------
    {
      description: 'does not consult metadata.user_id as a continuation source',
      input: { metadata: { user_id: 'u1' }, messages: [] },
      expected: null,
    },
    {
      description: 'does not consult prompt_cache_key when no tool_result block is present',
      input: {
        prompt_cache_key: 'cache_should_be_ignored',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
      },
      expected: null,
    },
    {
      description: 'does not consult previous_response_id (OpenAI-only field) on Anthropic input',
      input: {
        previous_response_id: 'resp_should_be_ignored',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
      },
      expected: null,
    },

    // -----------------------------------------------------------------------
    // Tolerance: tool_result on a non-user role is still recognized by shape.
    // The extractor inspects block.type alone, not message.role.
    // -----------------------------------------------------------------------
    {
      description: 'recognizes tool_result blocks even when they appear on a non-user role message',
      input: {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_off_role', content: 'edge' },
            ],
          },
        ],
      },
      expected: 'toolu_off_role',
    },
  ])('$description', ({ input, expected }) => {
    const actual = extractAnthropicMessagesSessionId(input);
    if (expected === null) {
      expect(actual).toBeNull();
    } else {
      expect(typeof actual).toBe('string');
      expect(actual).toBe(expected);
    }
  });
});
