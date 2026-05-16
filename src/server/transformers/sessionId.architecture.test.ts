import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Architecture test for the session-stick-routing feature.
 *
 * This test enforces the boundary invariants declared in Requirement 9.4 of
 * `.kiro/specs/session-stick-routing/requirements.md`:
 *
 * 1. Protocol-pure session-id extractors:
 *    `transformers/openai/responses/sessionId.ts` and
 *    `transformers/anthropic/messages/sessionId.ts` must not reference
 *    Fastify, the route layer, OAuth services, the token router, runtime
 *    dispatch, `proxyChannelCoordinator`, `sharedSurface`, or
 *    `channelSelection` in their executable code. JSDoc comments may
 *    legitimately mention these by name as cross-references; block comments
 *    are stripped before checking so the assertion stays faithful to the
 *    actual import / reference graph instead of to documentation phrasing.
 *
 * 2. `src/server/routes/proxy/**` must not directly read or write the
 *    session stick store, nor call the protocol-level session helpers. All
 *    session-stick orchestration flows through
 *    `proxy-core/surfaces/sharedSurface.ts`. The scan walks every `.ts` file
 *    under the directory recursively (including `*.test.ts`) — test files
 *    intentionally are not whitelisted: a test that pokes at the store
 *    directly would itself be a boundary violation.
 *
 * 3. `geminiSurface.ts` must not reference any session-stick-routing
 *    symbol or protocol-id literal introduced by this feature; Gemini is
 *    explicitly out of scope per Requirement 10.5.
 *
 * 4. `chatSurface.ts` carries the `'anthropic/messages'` protocol-id
 *    literal only on its Anthropic Messages branches (the main entry
 *    `protocolHint` argument and the `count_tokens` entry); the
 *    `'openai/responses'` literal does not appear in this surface, because
 *    OpenAI Chat Completions is also out of scope per Requirement 10.4.
 *
 * The test file itself is protocol-pure: it imports only `node:fs`,
 * `node:path`, `node:url`, and `vitest`. The forbidden module names appear
 * solely as string literals in the assertion tables below.
 */

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

/**
 * Strip `/* ... *\/` block comments (including JSDoc) so substring
 * assertions don't fire on legitimate documentation that mentions a
 * forbidden module name. Single-line `//` comments are preserved because
 * they rarely contain the cross-edge references we screen for, and
 * stripping them naively would require parsing string literals to avoid
 * tearing through `://` URL prefixes — we do not need that complexity here.
 */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function walkTypeScriptFiles(rootDir: string): string[] {
  const acc: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && full.endsWith('.ts')) {
        acc.push(full);
      }
    }
  }
  return acc;
}

const FORBIDDEN_TRANSFORMER_REFERENCES = [
  "from 'fastify'",
  "from '../../../routes/",
  'tokenRouter',
  'proxyChannelCoordinator',
  '../oauth/',
  'runtimeDispatch',
  'sharedSurface',
  'channelSelection',
] as const;

const FORBIDDEN_PROXY_ROUTE_REFERENCES = [
  'proxyChannelCoordinator.bindStickyChannel',
  'proxyChannelCoordinator.getStickyChannelId',
  'proxyChannelCoordinator.clearStickyChannel',
  'buildProtocolSessionKey',
  'extractOpenAiResponsesSessionId',
  'extractAnthropicMessagesSessionId',
  "from '../../proxy-core/surfaces/sharedSurface",
] as const;

const FORBIDDEN_GEMINI_SURFACE_REFERENCES = [
  'protocolHint',
  'extractAnthropicMessagesSessionId',
  'extractOpenAiResponsesSessionId',
  'buildProtocolSessionKey',
  "'openai/responses'",
  "'anthropic/messages'",
] as const;

describe('session-stick-routing architecture boundaries', () => {
  it('keeps openai/responses sessionId.ts protocol-pure', () => {
    const source = stripBlockComments(readSource('./openai/responses/sessionId.ts'));
    for (const forbidden of FORBIDDEN_TRANSFORMER_REFERENCES) {
      expect(
        source.includes(forbidden),
        `transformers/openai/responses/sessionId.ts must not reference '${forbidden}'`,
      ).toBe(false);
    }
  });

  it('keeps anthropic/messages sessionId.ts protocol-pure', () => {
    const source = stripBlockComments(readSource('./anthropic/messages/sessionId.ts'));
    for (const forbidden of FORBIDDEN_TRANSFORMER_REFERENCES) {
      expect(
        source.includes(forbidden),
        `transformers/anthropic/messages/sessionId.ts must not reference '${forbidden}'`,
      ).toBe(false);
    }
  });

  it('keeps routes/proxy/** out of the session stick store and protocol-level session helpers', () => {
    const proxyRoutesDir = fileURLToPath(new URL('../routes/proxy/', import.meta.url));
    const files = walkTypeScriptFiles(proxyRoutesDir);
    // Sanity check: ensure the walker actually found the routes directory.
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_PROXY_ROUTE_REFERENCES) {
        expect(
          source.includes(forbidden),
          `routes/proxy/** must not reference '${forbidden}' (found in ${file})`,
        ).toBe(false);
      }
    }
  });

  it('keeps geminiSurface.ts free of session-stick-routing protocol symbols', () => {
    const source = readSource('../proxy-core/surfaces/geminiSurface.ts');
    for (const forbidden of FORBIDDEN_GEMINI_SURFACE_REFERENCES) {
      expect(
        source.includes(forbidden),
        `proxy-core/surfaces/geminiSurface.ts must not reference '${forbidden}'`,
      ).toBe(false);
    }
  });

  it('centralizes the anthropic/messages literal on chatSurface.ts and keeps openai/responses out of it', () => {
    // We strip block comments so the count is robust to harmless JSDoc
    // edits that happen to mention either protocol id literally.
    const codeOnly = stripBlockComments(readSource('../proxy-core/surfaces/chatSurface.ts'));
    const anthropicMatches = codeOnly.match(/'anthropic\/messages'/g) || [];
    const openAiResponsesMatches = codeOnly.match(/'openai\/responses'/g) || [];
    // The Anthropic literal appears on the main entry's `protocolHint`
    // ternary and on the `handleClaudeCountTokensSurfaceRequest` entry —
    // exactly two anchored sites today. We assert >= 2 so the test does
    // not flake when a future refactor consolidates both via a shared
    // constant (which would still keep two textual occurrences) or adds
    // a third Claude-only entry.
    expect(anthropicMatches.length).toBeGreaterThanOrEqual(2);
    // OpenAI Chat Completions is explicitly out of scope (Requirement
    // 10.4); the OpenAI Responses literal must never leak into this
    // surface.
    expect(openAiResponsesMatches.length).toBe(0);
  });
});
