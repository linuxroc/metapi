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
