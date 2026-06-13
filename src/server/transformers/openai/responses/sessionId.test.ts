import { describe, expect, it } from 'vitest';

import { extractOpenAiResponsesSessionId } from './sessionId.js';

/**
 * Parameterized coverage for {@link extractOpenAiResponsesSessionId}.
 *
 * The cases below mirror Testing Strategy §1 of the
 * `session-stick-routing` design document (≥ 12 rows mandated). Each row
 * asserts both the return TYPE and the return VALUE, so we never rely on
 * truthy/falsy fuzzy matching:
 *   - When `expected` is `null`, assert `toBeNull()` exactly.
 *   - When `expected` is a string, assert `typeof === 'string'` and the
 *     trimmed equality of the value.
 *
 * Validates: Requirements 1.1, 1.2, 11.1
 * Properties: P1, P2
 */
describe('extractOpenAiResponsesSessionId', () => {
  it.each<{ description: string; input: unknown; expected: string | null }>([
    // -----------------------------------------------------------------------
    // Happy path: well-formed string inputs.
    // -----------------------------------------------------------------------
    {
      description: 'returns previous_response_id verbatim when it is a non-empty string',
      input: { previous_response_id: 'resp_abc' },
      expected: 'resp_abc',
    },
    {
      description: 'trims surrounding whitespace from previous_response_id',
      input: { previous_response_id: '  resp_abc  ' },
      expected: 'resp_abc',
    },
    {
      description: 'ignores unrelated sibling fields and still extracts previous_response_id',
      input: {
        previous_response_id: 'resp_with_siblings',
        model: 'gpt-5',
        input: [],
        instructions: 'system prompt',
      },
      expected: 'resp_with_siblings',
    },

    // -----------------------------------------------------------------------
    // String-shaped but logically empty.
    // -----------------------------------------------------------------------
    {
      description: 'returns null when previous_response_id is the empty string',
      input: { previous_response_id: '' },
      expected: null,
    },
    {
      description: 'returns null when previous_response_id is whitespace-only',
      input: { previous_response_id: '   ' },
      expected: null,
    },

    // -----------------------------------------------------------------------
    // Non-string field types.
    // -----------------------------------------------------------------------
    {
      description: 'returns null when previous_response_id is a number',
      input: { previous_response_id: 123 },
      expected: null,
    },
    {
      description: 'returns null when previous_response_id is null',
      input: { previous_response_id: null },
      expected: null,
    },
    {
      description: 'returns null when previous_response_id is explicitly undefined',
      input: { previous_response_id: undefined },
      expected: null,
    },
    {
      description: 'returns null when previous_response_id is a wrapped object',
      input: { previous_response_id: { wrapped: 'no' } },
      expected: null,
    },

    // -----------------------------------------------------------------------
    // Field absent and parsedBody shape mismatches.
    // -----------------------------------------------------------------------
    {
      description: 'returns null when previous_response_id field is missing',
      input: {},
      expected: null,
    },
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
      description: 'returns null when parsedBody is an array (top-level)',
      input: [],
      expected: null,
    },
    {
      description: 'returns null when parsedBody is a primitive string',
      input: 'a string',
      expected: null,
    },
  ])('$description', ({ input, expected }) => {
    const actual = extractOpenAiResponsesSessionId(input);
    if (expected === null) {
      expect(actual).toBeNull();
    } else {
      expect(typeof actual).toBe('string');
      expect(actual).toBe(expected);
    }
  });
});

describe('OpenAI Responses session identifier bounds', () => {
  it('rejects oversized and control-character continuation ids', () => {
    expect(extractOpenAiResponsesSessionId({
      previous_response_id: `resp_${'x'.repeat(300)}`,
    })).toBeNull();
    expect(extractOpenAiResponsesSessionId({
      previous_response_id: 'resp_ok\nspoofed',
    })).toBeNull();
  });
});
