/**
 * Regression suite for the OpenAI Chat proxy stream session, focused on the
 * cross-protocol P1 fix in spec session-stick-routing-binding-timing-fix.
 *
 * The session is the only place where streamed upstream events are
 * aggregated into a single NormalizedFinalResponse for downstream
 * serialization. The protocol-level sticky bind helper
 * (`bindSurfaceStickyChannelFromResponse`) reads `toolCalls[].id` from the
 * snapshot returned by `getTerminalNormalizedFinal()` so that the next
 * round's `tool_result.tool_use_id` lookup can find the channel.
 *
 * Three end-to-end shapes are exercised here:
 *
 *  - **Anthropic native SSE** (`content_block_start` → `content_block_delta`
 *    → `content_block_stop` → `message_stop`). These events are taken by
 *    the Anthropic raw-event fast path (`consumeSseEventBlock`) which
 *    forwards the original frame without going through the slow normalize
 *    path. The aggregator MUST still capture `tool_use.id` so the snapshot
 *    is not silently empty.
 *
 *  - **OpenAI Chat upstream as the cross-protocol fallback for a Claude
 *    downstream**. Upstream emits `choices[].delta.tool_calls` deltas; the
 *    proxy serializes them as Anthropic-shaped output but the snapshot is
 *    captured on the OpenAI Chat aggregator side regardless of downstream.
 *
 *  - **OpenAI Chat downstream**. Same upstream deltas, but downstream
 *    serializer is OpenAI Chat — confirming the aggregator state remains
 *    available to `getTerminalNormalizedFinal()` for both downstreams.
 *
 * If any of these tests fail, the protocol-level sticky bind in
 * `chatSurface.ts` will silently miss `tool_use.id` in the corresponding
 * upstream shape and multi-round sticky breaks for that traffic class.
 */
import { describe, expect, it } from 'vitest';
import { openAiChatTransformer } from './index.js';

type WriteCapture = {
  lines: string[];
  raw: string[];
};

function createWriteCapture(): {
  capture: WriteCapture;
  writeLines: (lines: string[]) => void;
  writeRaw: (chunk: string) => void;
} {
  const capture: WriteCapture = { lines: [], raw: [] };
  return {
    capture,
    writeLines: (lines) => {
      capture.lines.push(...lines);
    },
    writeRaw: (chunk) => {
      capture.raw.push(chunk);
    },
  };
}

function createSingleChunkReader(text: string) {
  let consumed = false;
  return {
    async read() {
      if (consumed) return { done: true, value: undefined } as const;
      consumed = true;
      return {
        done: false,
        value: new TextEncoder().encode(text),
      } as const;
    },
    async cancel() {
      return undefined;
    },
    releaseLock() {
      // no-op
    },
  };
}

function buildAnthropicNativeStreamText(toolUseId: string): string {
  // Real Anthropic SSE shape: each event has both `event: NAME\n` and
  // `data: {...}\n\n`. We carry the `tool_use.id` on `content_block_start`
  // (the only frame that has it; subsequent `content_block_delta` frames
  // only carry `partial_json`).
  const messageStart = {
    type: 'message_start',
    message: {
      id: 'msg_native_1',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-5',
    },
  };
  const contentBlockStart = {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'tool_use',
      id: toolUseId,
      name: 'web_search',
      input: {},
    },
  };
  const contentBlockDelta = {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"q":"hi"}',
    },
  };
  const contentBlockStop = {
    type: 'content_block_stop',
    index: 0,
  };
  const messageDelta = {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 5 },
  };
  const messageStop = { type: 'message_stop' };

  const block = (event: string, payload: unknown) => (
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  );

  return [
    block('message_start', messageStart),
    block('content_block_start', contentBlockStart),
    block('content_block_delta', contentBlockDelta),
    block('content_block_stop', contentBlockStop),
    block('message_delta', messageDelta),
    block('message_stop', messageStop),
  ].join('');
}

function buildOpenAiChatStreamText(toolCallId: string): string {
  // OpenAI Chat upstream tool-call shape: `id` only appears on the first
  // delta; subsequent deltas only carry `function.arguments`.
  const chunk1 = {
    id: 'chatcmpl-x1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'gpt-4.1',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: toolCallId,
          type: 'function',
          function: { name: 'web_search', arguments: '' },
        }],
      },
      finish_reason: null,
    }],
  };
  const chunk2 = {
    id: 'chatcmpl-x1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'gpt-4.1',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: '{"q":"hi"}' },
        }],
      },
      finish_reason: null,
    }],
  };
  const chunk3 = {
    id: 'chatcmpl-x1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'gpt-4.1',
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'tool_calls',
    }],
  };
  return [
    `data: ${JSON.stringify(chunk1)}\n\n`,
    `data: ${JSON.stringify(chunk2)}\n\n`,
    `data: ${JSON.stringify(chunk3)}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

describe('createChatProxyStreamSession - getTerminalNormalizedFinal()', () => {
  // ──────────────────────────────────────────────────────────────────────
  // Anthropic native upstream + Claude downstream.
  //
  // Reproduces the High-priority bug spotted in code review:
  //   - `consumeSseEventBlock` matches every Anthropic raw event name
  //     (`message_start`, `content_block_start`, etc.) and returns
  //     `handled: true`, which the proxy stream's pre-fix code path
  //     short-circuited on. That skipped the OpenAI Chat aggregator, so
  //     `getTerminalNormalizedFinal()` returned null and protocol-level
  //     sticky never recorded the round-1 `tool_use.id`.
  //   - This test fails on the pre-fix `proxyStream.ts:247-260` (handled
  //     branch returns before `applyOpenAiChatStreamEvent`).
  //   - Post-fix, the handled branch also runs `transformStreamEvent`
  //     and `applyOpenAiChatStreamEvent`, so the snapshot carries
  //     `toolCalls[0].id === 'toolu_native_alpha'`.
  // ──────────────────────────────────────────────────────────────────────
  it('captures tool_use.id from Anthropic native SSE for Claude downstream', async () => {
    const { capture, writeLines, writeRaw } = createWriteCapture();
    const session = openAiChatTransformer.proxyStream.createSession({
      downstreamFormat: 'claude',
      modelName: 'claude-sonnet-4-5',
      successfulUpstreamPath: '/v1/messages',
      writeLines,
      writeRaw,
    });

    const sseText = buildAnthropicNativeStreamText('toolu_native_alpha');
    const result = await session.run(
      createSingleChunkReader(sseText),
      { end: () => {} },
    );

    expect(result.status).toBe('completed');
    // Sanity: the original Anthropic frames were forwarded as-is to the
    // downstream client; the aggregator is a side-channel and does not
    // mutate the wire output.
    const forwarded = capture.lines.join('') + capture.raw.join('');
    expect(forwarded).toContain('"toolu_native_alpha"');

    const snapshot = session.getTerminalNormalizedFinal();
    expect(snapshot).not.toBeNull();
    expect(Array.isArray(snapshot?.toolCalls)).toBe(true);
    expect(snapshot?.toolCalls?.[0]?.id).toBe('toolu_native_alpha');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Cross-protocol: OpenAI Chat upstream + Claude downstream.
  //
  // Reproduces the case where the proxy falls back from Anthropic to
  // OpenAI Chat for an Anthropic-format client. The aggregator must
  // capture `choices[].delta.tool_calls[].id` from the first delta even
  // though the downstream serializer is Anthropic.
  // ──────────────────────────────────────────────────────────────────────
  it('captures tool_calls[].id from OpenAI Chat upstream for Claude downstream (cross-protocol)', async () => {
    const { writeLines, writeRaw } = createWriteCapture();
    const session = openAiChatTransformer.proxyStream.createSession({
      downstreamFormat: 'claude',
      modelName: 'gpt-4.1',
      successfulUpstreamPath: '/v1/chat/completions',
      writeLines,
      writeRaw,
    });

    const sseText = buildOpenAiChatStreamText('call_xprotocol_alpha');
    const result = await session.run(
      createSingleChunkReader(sseText),
      { end: () => {} },
    );

    expect(result.status).toBe('completed');
    const snapshot = session.getTerminalNormalizedFinal();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.toolCalls?.[0]?.id).toBe('call_xprotocol_alpha');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Same-protocol baseline: OpenAI Chat upstream + OpenAI Chat downstream.
  //
  // Confirms the always-on aggregator does not regress the original
  // OpenAI-only path (this case worked even before the fix, but the
  // previous gating was `input.downstreamFormat === 'openai'` so we want
  // explicit coverage to catch any future re-gating that might break it).
  // ──────────────────────────────────────────────────────────────────────
  it('captures tool_calls[].id from OpenAI Chat upstream for OpenAI Chat downstream', async () => {
    const { writeLines, writeRaw } = createWriteCapture();
    const session = openAiChatTransformer.proxyStream.createSession({
      downstreamFormat: 'openai',
      modelName: 'gpt-4.1',
      successfulUpstreamPath: '/v1/chat/completions',
      writeLines,
      writeRaw,
    });

    const sseText = buildOpenAiChatStreamText('call_same_proto_alpha');
    const result = await session.run(
      createSingleChunkReader(sseText),
      { end: () => {} },
    );

    expect(result.status).toBe('completed');
    const snapshot = session.getTerminalNormalizedFinal();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.toolCalls?.[0]?.id).toBe('call_same_proto_alpha');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Empty-output stream: no tool calls, no content.
  //
  // Pre-fix the snapshot was always null for claude downstream. Post-fix
  // the snapshot remains null when nothing meaningful aggregated, so the
  // bind helper short-circuits without writing a useless protocol-level
  // entry to the sticky store.
  // ──────────────────────────────────────────────────────────────────────
  it('returns null snapshot when no tool calls or content streamed', async () => {
    const { writeLines, writeRaw } = createWriteCapture();
    const session = openAiChatTransformer.proxyStream.createSession({
      downstreamFormat: 'claude',
      modelName: 'claude-sonnet-4-5',
      successfulUpstreamPath: '/v1/messages',
      writeLines,
      writeRaw,
    });

    // Anthropic native ping/message_stop only — no content_block_start.
    const sseText = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_empty', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-5' } })}\n\n`,
      `event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ].join('');

    const result = await session.run(
      createSingleChunkReader(sseText),
      { end: () => {} },
    );

    expect(result.status).toBe('completed');
    expect(session.getTerminalNormalizedFinal()).toBeNull();
  });
});
