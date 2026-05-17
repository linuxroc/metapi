import { describe, expect, it } from 'vitest';

import {
  extractAnthropicMessagesContinuationIdsFromResponse,
  extractAnthropicMessagesSessionId,
} from './sessionId.js';

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

/**
 * Parameterized coverage for {@link extractAnthropicMessagesContinuationIdsFromResponse}.
 *
 * Mirrors Task 3 of the `session-stick-routing-binding-timing-fix` spec; each
 * row asserts both the return TYPE (always `string[]`) and the return VALUE
 * via `toEqual`, so we never rely on truthy/falsy fuzzy matching.
 *
 * The cases below specifically pin down the path-1 vs path-2 first-come
 * semantics described in design.md §1.2:
 *   - Path 1 (Anthropic native `content[]`): once the extractor sees an
 *     array `content`, it locks onto path 1 and returns its accumulated
 *     result, *even when that result is `[]`*.
 *   - Path 2 (NormalizedFinalResponse `toolCalls[]`): only attempted when
 *     path 1 was not entered (i.e. `content` was not an array).
 *
 * Validates: Requirements 2.2, 2.5
 * Properties: P4
 */
describe('extractAnthropicMessagesContinuationIdsFromResponse', () => {
  it.each<{ description: string; input: unknown; expected: string[] }>([
    // -----------------------------------------------------------------------
    // Case 1: Single tool_use block — happy path.
    // -----------------------------------------------------------------------
    {
      description: 'returns [id] when content has a single tool_use block',
      input: {
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'calc', input: {} },
        ],
      },
      expected: ['toolu_a'],
    },

    // -----------------------------------------------------------------------
    // Case 2: Multiple tool_use blocks must be returned in document order.
    // -----------------------------------------------------------------------
    {
      description: 'returns ids in document order when content has multiple tool_use blocks',
      input: {
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'first', input: {} },
          { type: 'tool_use', id: 'toolu_b', name: 'second', input: {} },
        ],
      },
      expected: ['toolu_a', 'toolu_b'],
    },

    // -----------------------------------------------------------------------
    // Case 3: trim() must strip surrounding whitespace.
    // -----------------------------------------------------------------------
    {
      description: 'trims surrounding whitespace from tool_use.id',
      input: {
        content: [
          { type: 'tool_use', id: '  toolu_x  ', name: 'pad', input: {} },
        ],
      },
      expected: ['toolu_x'],
    },

    // -----------------------------------------------------------------------
    // Case 4: Empty-string id must be skipped, leaving subsequent valid ids.
    // -----------------------------------------------------------------------
    {
      description: 'skips blocks whose tool_use.id is the empty string',
      input: {
        content: [
          { type: 'tool_use', id: '', name: 'bad', input: {} },
          { type: 'tool_use', id: 'toolu_real', name: 'good', input: {} },
        ],
      },
      expected: ['toolu_real'],
    },

    // -----------------------------------------------------------------------
    // Case 5: Whitespace-only id must be skipped.
    // -----------------------------------------------------------------------
    {
      description: 'skips blocks whose tool_use.id is whitespace-only',
      input: {
        content: [
          { type: 'tool_use', id: '   ', name: 'bad', input: {} },
          { type: 'tool_use', id: 'toolu_real', name: 'good', input: {} },
        ],
      },
      expected: ['toolu_real'],
    },

    // -----------------------------------------------------------------------
    // Case 6: Non-string ids (number, null, undefined) must be skipped.
    // -----------------------------------------------------------------------
    {
      description: 'skips blocks whose tool_use.id is not a string (number / null / undefined)',
      input: {
        content: [
          { type: 'tool_use', id: 123, name: 'numeric', input: {} },
          { type: 'tool_use', id: null, name: 'null id', input: {} },
          { type: 'tool_use', name: 'missing id', input: {} },
          { type: 'tool_use', id: 'toolu_real', name: 'good', input: {} },
        ],
      },
      expected: ['toolu_real'],
    },

    // -----------------------------------------------------------------------
    // Case 7: Mixed-block content — only tool_use blocks must contribute.
    // text / thinking / redacted_thinking blocks must be ignored even when
    // they happen to carry an `id` field.
    // -----------------------------------------------------------------------
    {
      description: 'matches only tool_use blocks when content mixes text / thinking / redacted_thinking',
      input: {
        content: [
          { type: 'text', text: 'thinking out loud' },
          { type: 'thinking', thinking: 'inner monologue', id: 'should_be_ignored_1' },
          { type: 'redacted_thinking', data: '...' , id: 'should_be_ignored_2' },
          { type: 'tool_use', id: 'toolu_only_match', name: 'go', input: {} },
          { type: 'text', text: 'trailing' },
        ],
      },
      expected: ['toolu_only_match'],
    },

    // -----------------------------------------------------------------------
    // Case 8: content is not an array (string) → path 1 misses, path 2
    // fallback fires. Here `toolCalls` carries valid ids.
    // -----------------------------------------------------------------------
    {
      description: 'falls back to toolCalls when content is a string',
      input: {
        content: 'not-an-array',
        toolCalls: [
          { id: 'call_1', name: 'go' },
          { id: 'call_2', name: 'go again' },
        ],
      },
      expected: ['call_1', 'call_2'],
    },

    // -----------------------------------------------------------------------
    // Case 9: Path 2 — toolCalls array with several valid ids, with one
    // empty-string id skipped to confirm the same trim/skip semantics.
    // -----------------------------------------------------------------------
    {
      description: 'returns trimmed toolCalls ids in document order via path 2',
      input: {
        toolCalls: [
          { id: '  call_a  ', name: 'a' },
          { id: '', name: 'skip-empty' },
          { id: 'call_b', name: 'b' },
        ],
      },
      expected: ['call_a', 'call_b'],
    },

    // -----------------------------------------------------------------------
    // Case 10: Path 2 — toolCalls is not an array.
    // -----------------------------------------------------------------------
    {
      description: 'returns [] when toolCalls is present but not an array',
      input: {
        toolCalls: 'not-an-array',
      },
      expected: [],
    },

    // -----------------------------------------------------------------------
    // Case 11 (CRITICAL — path-1 lock-in): when content is an array — *even
    // an empty one* — the extractor SHALL NOT fall back to toolCalls. Path
    // 1's first-come-first-served semantics are exactly what guarantees an
    // Anthropic-native empty assistant turn returns `[]`.
    // -----------------------------------------------------------------------
    {
      description: 'when content is an empty array AND toolCalls has ids, path 1 wins and returns []',
      input: {
        content: [],
        toolCalls: [
          { id: 'call_should_not_be_returned', name: 'fallback' },
        ],
      },
      expected: [],
    },
    {
      description: 'when content is a non-empty array of non-tool_use blocks AND toolCalls has ids, path 1 still wins',
      input: {
        content: [
          { type: 'text', text: 'just a chat reply' },
        ],
        toolCalls: [
          { id: 'call_should_not_be_returned', name: 'fallback' },
        ],
      },
      expected: [],
    },
    {
      description: 'when content has tool_use ids AND toolCalls has different ids, path 1 returns content ids only',
      input: {
        content: [
          { type: 'tool_use', id: 'toolu_native', name: 'native', input: {} },
        ],
        toolCalls: [
          { id: 'call_should_not_be_returned', name: 'fallback' },
        ],
      },
      expected: ['toolu_native'],
    },

    // -----------------------------------------------------------------------
    // Case 12: responsePayload itself has the wrong shape.
    // -----------------------------------------------------------------------
    {
      description: 'returns [] when responsePayload is null',
      input: null,
      expected: [],
    },
    {
      description: 'returns [] when responsePayload is undefined',
      input: undefined,
      expected: [],
    },
    {
      description: 'returns [] when responsePayload is a primitive string',
      input: 'string body',
      expected: [],
    },
    {
      description: 'returns [] when responsePayload is a primitive number',
      input: 99,
      expected: [],
    },
    {
      description: 'returns [] when responsePayload is a top-level array',
      input: [{ content: [{ type: 'tool_use', id: 'toolu_a', input: {} }] }],
      expected: [],
    },

    // -----------------------------------------------------------------------
    // Case 13: Hard constraint — does NOT read message.id. The Anthropic
    // protocol's `message.id` is per-response unique and never echoed back
    // as a `tool_result.tool_use_id` on the next round, so it would never
    // produce a sticky hit. Constructing an input that ONLY carries
    // `message.id` (no content / no toolCalls) must yield [].
    // -----------------------------------------------------------------------
    {
      description: 'does not consult top-level id (e.g. message.id) as a continuation source',
      input: {
        id: 'msg_should_be_ignored',
        type: 'message',
        role: 'assistant',
      },
      expected: [],
    },

    // -----------------------------------------------------------------------
    // Case 14: Hard constraint — does NOT read metadata.user_id /
    // prompt_cache_key (they exist in the request body shape; copying the
    // same defensive coverage to the response-side extractor).
    // -----------------------------------------------------------------------
    {
      description: 'does not consult metadata.user_id as a continuation source',
      input: {
        metadata: { user_id: 'u1' },
      },
      expected: [],
    },
    {
      description: 'does not consult prompt_cache_key as a continuation source',
      input: {
        prompt_cache_key: 'cache_should_be_ignored',
      },
      expected: [],
    },
  ])('$description', ({ input, expected }) => {
    const actual = extractAnthropicMessagesContinuationIdsFromResponse(input);
    expect(Array.isArray(actual)).toBe(true);
    expect(actual).toEqual(expected);
  });
});
