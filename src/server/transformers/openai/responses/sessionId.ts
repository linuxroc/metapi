/**
 * Protocol-pure helper for extracting the OpenAI Responses protocol-level
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
 * - Returns the trimmed value of `parsedBody.previous_response_id` when that
 *   field is a string whose trimmed form is non-empty.
 * - Returns `null` for every other input shape, including `null`, `undefined`,
 *   primitives, arrays, missing field, non-string field, and empty / whitespace
 *   strings.
 * - Never throws, even on cyclic objects or exotic property types: it inspects
 *   only the top-level `previous_response_id` slot via a single property read.
 *
 * See: `.kiro/specs/session-stick-routing/design.md` §1 and Requirements
 * 1.1 / 1.2 / 1.3 / 9.1.
 */
export function extractOpenAiResponsesSessionId(parsedBody: unknown): string | null {
  if (
    parsedBody === null
    || typeof parsedBody !== 'object'
    || Array.isArray(parsedBody)
  ) {
    return null;
  }

  const raw = (parsedBody as { previous_response_id?: unknown }).previous_response_id;
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
