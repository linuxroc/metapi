/**
 * Protocol-pure helper for extracting the Anthropic Messages protocol-level
 * continuation identifier from an already parsed downstream request body.
 *
 * This module is intentionally **opt-in** and dispatched by
 * `proxy-core/surfaces/sharedSurface.ts`; it has no knowledge of scope fields
 * (`downstreamApiKeyId`, `downstreamPath`, `requestedModel`), the channel
 * selector, the sticky session store, Fastify routing, OAuth services, the
 * token router, or the runtime dispatch layer. By design it depends solely on
 * TypeScript built-ins and does not import any other module in the repo.
 *
 * Behaviour summary:
 * - Walks `parsedBody.messages` in document order, descending into each
 *   message's `content` array, and records the trimmed `tool_use_id` of every
 *   `block.type === 'tool_result'` block whose `tool_use_id` is a non-empty
 *   string after `trim()`. The function returns the **last** such value found
 *   (i.e. an overwriting `lastFound`, not a break-on-first-match), or `null`
 *   when no eligible block exists.
 * - The role of the enclosing message is **not** inspected; even though the
 *   Anthropic protocol prescribes that `tool_result` blocks live on `user`
 *   messages, eligibility is determined purely by the block shape so that
 *   benign client deviations do not silently lose stickiness.
 * - **Hard constraint (Requirement 2.3):** this extractor SHALL NOT read
 *   `metadata.user_id`, `prompt_cache_key`, `previous_response_id`, or any
 *   custom HTTP header as a continuation source. The only field it inspects
 *   below the top level is `messages[].content[].tool_use_id` for blocks where
 *   `type === 'tool_result'`.
 * - Returns `null` for every other input shape, including `null`, `undefined`,
 *   primitives, arrays at the top level, missing or non-array `messages`,
 *   non-object messages, non-array `content`, non-object blocks, blocks of any
 *   other `type`, non-string or whitespace-only `tool_use_id`.
 * - Never throws, even on cyclic objects or exotic property types: the walk is
 *   bounded by `messages.length` and `content.length`, and every property read
 *   is guarded by a type check before it is used.
 *
 * See: `.kiro/specs/session-stick-routing/design.md` §2 and Requirements
 * 2.1 / 2.2 / 2.3 / 2.4 / 9.1.
 */
export function extractAnthropicMessagesSessionId(parsedBody: unknown): string | null {
  if (
    parsedBody === null
    || typeof parsedBody !== 'object'
    || Array.isArray(parsedBody)
  ) {
    return null;
  }

  const messages = (parsedBody as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;

  let lastFound: string | null = null;

  for (const message of messages) {
    if (
      message === null
      || typeof message !== 'object'
      || Array.isArray(message)
    ) {
      continue;
    }

    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (
        block === null
        || typeof block !== 'object'
        || Array.isArray(block)
      ) {
        continue;
      }

      const blockRecord = block as { type?: unknown; tool_use_id?: unknown };
      if (blockRecord.type !== 'tool_result') continue;

      const rawId = blockRecord.tool_use_id;
      if (typeof rawId !== 'string') continue;

      const trimmed = rawId.trim();
      if (trimmed.length === 0) continue;

      lastFound = trimmed;
    }
  }

  return lastFound;
}

/**
 * Protocol-pure helper for extracting **response-side** Anthropic Messages
 * continuation identifiers from an already aggregated upstream response
 * payload. The dual of {@link extractAnthropicMessagesSessionId}: where the
 * latter parses the *request* body and yields the **single** trimmed
 * `tool_result.tool_use_id` to use as a sticky session **query key**, this
 * function parses the *response* and yields every newly minted `tool_use.id`
 * to use as a sticky session **write key**.
 *
 * This split exists because the bug being fixed (P1 of the
 * `session-stick-routing-binding-timing-fix` spec) showed that conflating the
 * request-side and response-side identifiers caused every multi-round sticky
 * lookup to miss by one round. The response-side IDs of round N are exactly
 * what round N+1's request will carry as `tool_result.tool_use_id`, so they
 * are the correct binding key.
 *
 * Like the request-side extractor, this helper is dispatched by
 * `proxy-core/surfaces/sharedSurface.ts`; it has no knowledge of scope fields,
 * the channel selector, the sticky session store, Fastify routing, OAuth
 * services, the token router, or the runtime dispatch layer. It depends
 * solely on TypeScript built-ins and does not import any other module in the
 * repo.
 *
 * Behaviour summary:
 * - Path 1 (Anthropic native shape: non-streaming JSON terminal or aggregated
 *   streaming final): when `responsePayload.content` is an array, walks the
 *   array in document order and records the trimmed `block.id` of every
 *   `block.type === 'tool_use'` block whose `id` is a non-empty string after
 *   `trim()`. The function returns the accumulated array as-is **even when
 *   empty** — once an Anthropic-native `content` array is detected, the
 *   extractor SHALL NOT fall back to the normalized shape, because that would
 *   silently change the semantics of an empty assistant turn.
 * - Path 2 (NormalizedFinalResponse fallback): only attempted when
 *   `responsePayload.content` is not an array. When `responsePayload.toolCalls`
 *   is an array, walks it in document order and records the trimmed
 *   `toolCall.id` of every entry whose `id` is a non-empty string after
 *   `trim()`.
 * - Returns `[]` for every other input shape, including `null`, `undefined`,
 *   primitives, arrays at the top level, missing or non-array `content` /
 *   `toolCalls`, non-object blocks, blocks of any other `type`, or
 *   non-string / whitespace-only `id`.
 * - **Hard constraint (mirroring Requirement 2.3):** SHALL NOT read
 *   `message.id` (it is per-response unique and never echoed back as a
 *   `tool_result.tool_use_id`, so it cannot serve as a continuation anchor),
 *   `metadata.user_id`, `prompt_cache_key`, or any custom HTTP header. The
 *   only fields inspected below the top level are `content[].type`,
 *   `content[].id`, `toolCalls[].id`.
 * - Never throws, even on cyclic objects or exotic property types: every
 *   property read is guarded by a type check before it is used and the
 *   bounded walks cannot recurse.
 *
 * See: `.kiro/specs/session-stick-routing-binding-timing-fix/design.md` §1.2
 * and Requirements 2.2 / 2.5 / Unchanged 3.10.
 */
export function extractAnthropicMessagesContinuationIdsFromResponse(
  responsePayload: unknown,
): string[] {
  if (
    responsePayload === null
    || typeof responsePayload !== 'object'
    || Array.isArray(responsePayload)
  ) {
    return [];
  }

  const found: string[] = [];

  // Path 1 — Anthropic native shape. Once `content` is an array we lock onto
  // path 1 and return its result without falling back to `toolCalls`. This
  // preserves the contract that an aggregated Anthropic native response with
  // an empty assistant turn (no tool_use blocks) returns `[]` rather than
  // accidentally drawing IDs from a normalized shape that may coexist on the
  // same object.
  const content = (responsePayload as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block === null
        || typeof block !== 'object'
        || Array.isArray(block)
      ) {
        continue;
      }

      const blockRecord = block as { type?: unknown; id?: unknown };
      if (blockRecord.type !== 'tool_use') continue;

      const rawId = blockRecord.id;
      if (typeof rawId !== 'string') continue;

      const trimmed = rawId.trim();
      if (trimmed.length === 0) continue;

      found.push(trimmed);
    }
    return found;
  }

  // Path 2 — NormalizedFinalResponse fallback (e.g. when the surface forwards
  // a transformer-normalized shape rather than the raw Anthropic body). Only
  // reachable when `content` was not an array.
  const toolCalls = (responsePayload as { toolCalls?: unknown }).toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      if (
        toolCall === null
        || typeof toolCall !== 'object'
        || Array.isArray(toolCall)
      ) {
        continue;
      }

      const rawId = (toolCall as { id?: unknown }).id;
      if (typeof rawId !== 'string') continue;

      const trimmed = rawId.trim();
      if (trimmed.length === 0) continue;

      found.push(trimmed);
    }
  }

  return found;
}
