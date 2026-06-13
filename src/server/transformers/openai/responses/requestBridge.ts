import { canonicalRequestFromOpenAiBody, canonicalRequestToOpenAiChatBody } from '../../canonical/openAiRequestBridge.js';
import { readOpenAiCompatibleContinuation } from '../../canonical/continuationBridge.js';
import { normalizeCanonicalReasoningRequest } from '../../canonical/reasoning.js';
import type { CanonicalRequestEnvelope } from '../../canonical/types.js';
import type { ProtocolParseContext } from '../../contracts.js';
import {
  convertOpenAiBodyToResponsesBody,
  convertResponsesBodyToOpenAiBody,
} from './conversion.js';
import { openAiResponsesInbound } from './inbound.js';

function normalizeIncludeList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

export function parseOpenAiResponsesRequestToCanonical(
  body: unknown,
  ctx?: ProtocolParseContext,
): { value?: CanonicalRequestEnvelope; error?: { statusCode: number; payload: unknown } } {
  const parsed = openAiResponsesInbound.parse(body, {
    defaultEncryptedReasoningInclude: ctx?.defaultEncryptedReasoningInclude,
  });
  if (parsed.error) {
    return { error: parsed.error };
  }
  if (!parsed.value) {
    return {
      error: {
        statusCode: 400,
        payload: {
          error: {
            message: 'invalid responses request',
            type: 'invalid_request_error',
          },
        },
      },
    };
  }

  const responsesBody = parsed.value.parsed.normalizedBody;
  const openAiBody = convertResponsesBodyToOpenAiBody(
    responsesBody,
    typeof responsesBody.model === 'string' ? responsesBody.model : parsed.value.model,
    responsesBody.stream === true,
    { defaultEncryptedReasoningInclude: ctx?.defaultEncryptedReasoningInclude },
  );
  const continuation = readOpenAiCompatibleContinuation(responsesBody, ctx?.continuation);
  const canonical = canonicalRequestFromOpenAiBody({
    body: openAiBody,
    surface: 'openai-responses',
    cliProfile: ctx?.cliProfile,
    operation: ctx?.operation,
    metadata: ctx?.metadata,
    passthrough: ctx?.passthrough,
    continuation,
  });
  const responsesToolContract = canonicalRequestFromOpenAiBody({
    body: {
      model: canonical.requestedModel,
      messages: [],
      tools: responsesBody.tools,
      tool_choice: responsesBody.tool_choice,
      parallel_tool_calls: responsesBody.parallel_tool_calls,
    },
    surface: 'openai-responses',
  });
  const responsesGenerationContract = canonicalRequestFromOpenAiBody({
    body: {
      ...responsesBody,
      model: canonical.requestedModel,
      messages: [],
    },
    surface: 'openai-responses',
  });
  const reasoningResult = normalizeCanonicalReasoningRequest({
    include: responsesBody.include,
    reasoning: responsesBody.reasoning,
    reasoning_effort: responsesBody.reasoning_effort,
    reasoning_budget: responsesBody.reasoning_budget,
    reasoning_summary: responsesBody.reasoning_summary,
  });
  const transformerMetadata = {
    ...(typeof canonical.passthrough?.transformerMetadata === 'object'
      ? canonical.passthrough.transformerMetadata as Record<string, unknown>
      : {}),
    ...(reasoningResult.metadata ?? {}),
  };

  return {
    value: {
      ...canonical,
      ...(reasoningResult.reasoning ? { reasoning: reasoningResult.reasoning } : {}),
      ...(responsesGenerationContract.generation
        ? {
          generation: {
            ...(canonical.generation ?? {}),
            ...responsesGenerationContract.generation,
          },
        }
        : {}),
      ...(responsesToolContract.tools ? { tools: responsesToolContract.tools } : {}),
      ...(responsesToolContract.toolChoice !== undefined
        ? { toolChoice: responsesToolContract.toolChoice }
        : {}),
      ...(typeof responsesToolContract.parallelToolCalls === 'boolean'
        ? { parallelToolCalls: responsesToolContract.parallelToolCalls }
        : {}),
      ...(Object.keys(transformerMetadata).length > 0
        ? {
          passthrough: {
            ...(canonical.passthrough ?? {}),
            transformerMetadata,
          },
        }
        : {}),
    },
  };
}

export function buildCanonicalRequestToOpenAiResponsesBody(
  request: CanonicalRequestEnvelope,
): Record<string, unknown> {
  const openAiBody = canonicalRequestToOpenAiChatBody(request, {
    preserveResponsesExtensions: true,
  });
  if (request.reasoning) {
    openAiBody.reasoning = {
      ...(request.reasoning.effort ? { effort: request.reasoning.effort } : {}),
      ...(request.reasoning.budgetTokens !== undefined ? { budget_tokens: request.reasoning.budgetTokens } : {}),
      ...(request.reasoning.summary ? { summary: request.reasoning.summary } : {}),
    };
  }
  const body = convertOpenAiBodyToResponsesBody(openAiBody, request.requestedModel, request.stream);
  const mergedInclude = Array.from(new Set([
    ...(request.cliProfile === 'codex' || request.reasoning?.includeEncryptedContent
      ? ['reasoning.encrypted_content']
      : []),
    ...normalizeIncludeList(body.include),
  ]));
  return {
    ...body,
    ...(mergedInclude.length > 0 ? { include: mergedInclude } : {}),
    store: false,
  };
}
