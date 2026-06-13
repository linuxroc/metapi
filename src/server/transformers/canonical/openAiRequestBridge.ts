import {
  canonicalAttachmentFromInputFileBlock,
  canonicalAttachmentToNormalizedInputFile,
  type CanonicalAttachment,
} from './attachments.js';
import { createCanonicalRequestEnvelope } from './envelope.js';
import {
  applyOpenAiCompatibleContinuation,
  readOpenAiCompatibleContinuation,
} from './continuationBridge.js';
import { normalizeCanonicalReasoningRequest } from './reasoning.js';
import type { CanonicalTool, CanonicalToolChoice } from './tools.js';
import type {
  CanonicalContentPart,
  CanonicalCliProfile,
  CanonicalContinuation,
  CanonicalGenerationConfig,
  CanonicalMessage,
  CanonicalMessageRole,
  CanonicalOperation,
  CanonicalRequestEnvelope,
  CanonicalSurface,
} from './types.js';
import { toOpenAiChatFileBlock } from '../shared/inputFile.js';

type CanonicalRequestFromOpenAiBodyInput = {
  body: Record<string, unknown>;
  surface: CanonicalSurface;
  cliProfile?: CanonicalCliProfile;
  operation?: CanonicalOperation;
  metadata?: Record<string, unknown>;
  passthrough?: Record<string, unknown>;
  continuation?: CanonicalContinuation;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractImageUrlFromContentItem(item: Record<string, unknown>): string {
  // Handles every shape we see at the canonical boundary:
  //   - OpenAI Chat:    { type:'image_url', image_url:{ url, detail? } }
  //   - OpenAI Responses (string form):  { type:'input_image', image_url:'https://...' or 'data:...' }
  //   - OpenAI Responses (object form):  { type:'input_image', image_url:{ url } }
  //   - Loose variants that put the URL on item.url
  // Without recognizing the string forms here, the image part silently dropped
  // before any downstream protocol could see it (canonical envelope is the
  // single source of truth for downstream conversion).
  const directImageUrl = item.image_url;
  if (typeof directImageUrl === 'string') {
    const url = directImageUrl.trim();
    if (url) return url;
  } else if (isRecord(directImageUrl)) {
    const nestedUrl = asTrimmedString(directImageUrl.url) || asTrimmedString(directImageUrl.image_url);
    if (nestedUrl) return nestedUrl;
  }

  const fallbackUrl = item.url;
  if (typeof fallbackUrl === 'string') {
    const url = fallbackUrl.trim();
    if (url) return url;
  }

  return '';
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    ) as T;
  }
  return value;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toFiniteInteger(value: unknown): number | undefined {
  const numberValue = toFiniteNumber(value);
  return numberValue === undefined ? undefined : Math.trunc(numberValue);
}

function toBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values)) return undefined;
  const normalized = values
    .map((item) => asTrimmedString(item))
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeNumericRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, toFiniteNumber(item)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] !== undefined),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function canonicalGenerationFromOpenAiBody(
  body: Record<string, unknown>,
): CanonicalGenerationConfig | undefined {
  const maxOutputTokens = (
    toFiniteInteger(body.max_output_tokens)
    ?? toFiniteInteger(body.max_completion_tokens)
    ?? toFiniteInteger(body.max_tokens)
  );
  const maxToolCalls = toFiniteInteger(body.max_tool_calls);
  const temperature = toFiniteNumber(body.temperature);
  const topP = toFiniteNumber(body.top_p);
  const topK = toFiniteNumber(body.top_k);
  const stopSequences = normalizeStringList(body.stop ?? body.stop_sequences);
  const modalities = normalizeStringList(body.modalities);
  const audio = isRecord(body.audio) ? cloneJsonValue(body.audio) : undefined;
  const serviceTier = asTrimmedString(body.service_tier) || undefined;
  const topLogprobs = toFiniteInteger(body.top_logprobs);
  const logitBias = normalizeNumericRecord(body.logit_bias);
  const safetyIdentifier = asTrimmedString(body.safety_identifier) || undefined;
  const user = asTrimmedString(body.user) || undefined;
  const verbosity = asTrimmedString(body.verbosity) || undefined;
  const streamOptions = isRecord(body.stream_options) ? body.stream_options : null;
  const streamOptionsIncludeUsage = typeof streamOptions?.include_usage === 'boolean'
    ? streamOptions.include_usage
    : undefined;
  const background = toBooleanLike(body.background);

  const generation: CanonicalGenerationConfig = {
    ...(maxOutputTokens !== undefined && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(stopSequences ? { stopSequences } : {}),
    ...(body.response_format !== undefined
      ? { responseFormat: cloneJsonValue(body.response_format) }
      : {}),
    ...(modalities ? { modalities } : {}),
    ...(audio ? { audio } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(topLogprobs !== undefined ? { topLogprobs } : {}),
    ...(logitBias ? { logitBias } : {}),
    ...(safetyIdentifier ? { safetyIdentifier } : {}),
    ...(user ? { user } : {}),
    ...(verbosity ? { verbosity } : {}),
    ...(streamOptionsIncludeUsage !== undefined ? { streamOptionsIncludeUsage } : {}),
    ...(body.prompt_cache_retention !== undefined
      ? { promptCacheRetention: cloneJsonValue(body.prompt_cache_retention) }
      : {}),
    ...(background !== undefined ? { background } : {}),
    ...(body.truncation !== undefined
      ? { truncation: cloneJsonValue(body.truncation) }
      : {}),
  };

  return Object.keys(generation).length > 0 ? generation : undefined;
}

function joinNonEmpty(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function normalizeRole(value: unknown): CanonicalMessageRole {
  const role = asTrimmedString(value).toLowerCase();
  switch (role) {
    case 'system':
    case 'developer':
    case 'assistant':
    case 'tool':
      return role;
    default:
      return 'user';
  }
}

function openAiContentToCanonicalParts(content: unknown): CanonicalContentPart[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }

  if (!Array.isArray(content)) return [];

  const parts: CanonicalContentPart[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      if (item) parts.push({ type: 'text', text: item });
      continue;
    }
    if (!isRecord(item)) continue;

    const type = asTrimmedString(item.type).toLowerCase();
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = asTrimmedString(item.text);
      if (text) parts.push({ type: 'text', text });
      continue;
    }
    if (type === 'reasoning' || type === 'thinking' || type === 'redacted_reasoning') {
      const text = asTrimmedString(item.text ?? item.reasoning ?? item.thinking);
      if (text) parts.push({ type: 'text', text, thought: true });
      continue;
    }
    if (type === 'image_url' || type === 'input_image') {
      const url = extractImageUrlFromContentItem(item);
      if (url) parts.push({ type: 'image', url });
      continue;
    }
    if (type === 'input_file' || type === 'file') {
      const attachment = canonicalAttachmentFromInputFileBlock(item);
      if (attachment) {
        parts.push({
          type: 'file',
          ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
          ...(attachment.fileUrl ? { fileUrl: attachment.fileUrl } : {}),
          ...(attachment.fileData ? { fileData: attachment.fileData } : {}),
          ...(attachment.mimeType !== undefined ? { mimeType: attachment.mimeType } : {}),
          ...(attachment.filename ? { filename: attachment.filename } : {}),
        });
      }
      continue;
    }
    if (type === 'input_audio') {
      const audio = isRecord(item.input_audio) ? item.input_audio : item;
      const data = asTrimmedString(audio.data);
      if (!data) continue;
      const format = asTrimmedString(audio.format);
      const mimeType = asTrimmedString(audio.mime_type ?? audio.mimeType)
        || (
          format === 'mp3'
            ? 'audio/mpeg'
            : (format ? `audio/${format}` : 'audio/wav')
        );
      parts.push({
        type: 'audio',
        data,
        ...(format ? { format } : {}),
        mimeType,
      });
      continue;
    }
  }

  return parts;
}

function appendAssistantReasoningPart(
  parts: CanonicalContentPart[],
  rawMessage: Record<string, unknown>,
): void {
  const directReasoning = joinNonEmpty([
    asTrimmedString(rawMessage.reasoning_content),
    asTrimmedString(rawMessage.reasoning),
  ]);
  if (!directReasoning) return;

  const alreadyPresent = parts.some((part) => (
    part.type === 'text'
    && part.thought === true
    && part.text === directReasoning
  ));
  if (alreadyPresent) return;

  parts.unshift({
    type: 'text',
    text: directReasoning,
    thought: true,
  });
}

function parseToolChoice(rawToolChoice: unknown): CanonicalToolChoice | undefined {
  if (typeof rawToolChoice === 'string') {
    const normalized = rawToolChoice.trim().toLowerCase();
    if (normalized === 'auto' || normalized === 'none' || normalized === 'required') return normalized;
    if (normalized === 'any') return 'required';
    return rawToolChoice.trim() ? { type: 'raw', value: rawToolChoice } : undefined;
  }

  if (!isRecord(rawToolChoice)) return undefined;
  const type = asTrimmedString(rawToolChoice.type).toLowerCase();
  if (type === 'auto' || type === 'none') return type;
  if (type === 'any' || type === 'required') return 'required';
  if (type === 'function') {
    const name = asTrimmedString(
      (isRecord(rawToolChoice.function) ? rawToolChoice.function.name : undefined)
      ?? rawToolChoice.name,
    );
    return name ? { type: 'tool', name } : undefined;
  }
  if (type && type !== 'tool') {
    return { type: 'raw', value: cloneJsonValue(rawToolChoice) as Record<string, unknown> };
  }

  const name = asTrimmedString(
    rawToolChoice.name
    ?? (isRecord(rawToolChoice.tool) ? rawToolChoice.tool.name : undefined),
  );
  const toolChoiceKeys = Object.keys(rawToolChoice);
  const hasExtraToolFields = toolChoiceKeys.some((key) => key !== 'type' && key !== 'name' && key !== 'tool');
  if (hasExtraToolFields) {
    return { type: 'raw', value: cloneJsonValue(rawToolChoice) as Record<string, unknown> };
  }
  if (name) return { type: 'tool', name };
  return { type: 'raw', value: cloneJsonValue(rawToolChoice) as Record<string, unknown> };
}

function parseTools(rawTools: unknown): CanonicalTool[] | undefined {
  if (!Array.isArray(rawTools)) return undefined;

  const tools: CanonicalTool[] = rawTools
    .flatMap((item): CanonicalTool[] => {
      if (!isRecord(item)) return [];
      const itemType = asTrimmedString(item.type).toLowerCase();

      if (itemType === 'function') {
        const rawFunction = isRecord(item.function) ? item.function : item;
        const name = asTrimmedString(rawFunction.name);
        if (!name) return [];
        return [{
          name,
          ...(asTrimmedString(rawFunction.description)
            ? { description: asTrimmedString(rawFunction.description) }
            : {}),
          ...(typeof rawFunction.strict === 'boolean' ? { strict: rawFunction.strict } : {}),
          ...(isRecord(rawFunction.parameters) ? { inputSchema: cloneJsonValue(rawFunction.parameters) } : {}),
        }];
      }

      if ((itemType === '' || itemType === 'tool') && asTrimmedString(item.name)) {
        return [{
          name: asTrimmedString(item.name),
          ...(asTrimmedString(item.description)
            ? { description: asTrimmedString(item.description) }
            : {}),
          ...(typeof item.strict === 'boolean' ? { strict: item.strict } : {}),
          ...(isRecord(item.input_schema)
            ? { inputSchema: cloneJsonValue(item.input_schema) }
            : (isRecord(item.inputSchema) ? { inputSchema: cloneJsonValue(item.inputSchema) } : {})),
        }];
      }

      if (Array.isArray(item.functionDeclarations)) {
        return item.functionDeclarations.flatMap((declaration) => {
          if (!isRecord(declaration)) return [];
          const name = asTrimmedString(declaration.name);
          if (!name) return [];
          return [{
            name,
            ...(asTrimmedString(declaration.description)
              ? { description: asTrimmedString(declaration.description) }
              : {}),
            ...(isRecord(declaration.parametersJsonSchema)
              ? { inputSchema: cloneJsonValue(declaration.parametersJsonSchema) }
              : (isRecord(declaration.parameters) ? { inputSchema: cloneJsonValue(declaration.parameters) } : {})),
          }];
        });
      }

      if (itemType) {
        return [{
          type: itemType,
          raw: cloneJsonValue(item) as Record<string, unknown>,
        }];
      }

      return [];
    });

  return tools.length > 0 ? tools : undefined;
}

export function canonicalRequestFromOpenAiBody(
  input: CanonicalRequestFromOpenAiBodyInput,
): CanonicalRequestEnvelope {
  const body = input.body;
  const metadata = isRecord(input.metadata)
    ? input.metadata
    : (isRecord(body.metadata) ? cloneJsonValue(body.metadata) : undefined);
  const attachments = Array.isArray(body.attachments)
    ? cloneJsonValue(body.attachments) as CanonicalAttachment[]
    : undefined;
  const messages: CanonicalMessage[] = [];
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];

  for (const rawMessage of rawMessages) {
    if (!isRecord(rawMessage)) continue;
    const rawRole = asTrimmedString(rawMessage.role).toLowerCase();
    const role = rawRole === 'function' ? 'tool' : normalizeRole(rawMessage.role);

    if (role === 'tool') {
      const toolCallId = asTrimmedString(
        rawMessage.tool_call_id
        ?? rawMessage.id
        ?? (rawRole === 'function' ? rawMessage.name : undefined),
      );
      const rawContent = rawMessage.content;
      const resultText = typeof rawContent === 'string'
        ? rawContent
        : (!Array.isArray(rawContent) && !isRecord(rawContent) ? safeJsonStringify(rawContent ?? '') : '');
      messages.push({
        role: 'tool',
        parts: [{
          type: 'tool_result',
          toolCallId: toolCallId || 'tool',
          ...(resultText ? { resultText } : {}),
          ...(Array.isArray(rawContent)
            ? { resultContent: cloneJsonValue(rawContent) as Array<string | Record<string, unknown>> }
            : (isRecord(rawContent)
                ? { resultContent: [cloneJsonValue(rawContent) as Record<string, unknown>] }
                : {})),
        }],
      });
      continue;
    }

    const parts = openAiContentToCanonicalParts(rawMessage.content);
    if (role === 'assistant') {
      appendAssistantReasoningPart(parts, rawMessage);
    }
    const legacyFunctionCall = isRecord(rawMessage.function_call)
      ? [{
        id: asTrimmedString(rawMessage.function_call.name) || `tool_${parts.length}`,
        type: 'function',
        function: rawMessage.function_call,
      }]
      : [];
    const toolCalls = Array.isArray(rawMessage.tool_calls)
      ? rawMessage.tool_calls
      : legacyFunctionCall;
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) continue;
      const fn = isRecord(toolCall.function) ? toolCall.function : {};
      const id = asTrimmedString(toolCall.id);
      const name = asTrimmedString(toolCall.name ?? fn.name);
      const argumentsJson = typeof fn.arguments === 'string'
        ? fn.arguments
        : safeJsonStringify(fn.arguments ?? toolCall.arguments ?? {});
      if (!name) continue;
      parts.push({
        type: 'tool_call',
        id: id || `tool_${parts.length}`,
        name,
        argumentsJson,
        ...(isRecord(toolCall.provider_specific_fields)
          && asTrimmedString(toolCall.provider_specific_fields.thought_signature)
          ? { thoughtSignature: asTrimmedString(toolCall.provider_specific_fields.thought_signature) }
          : {}),
      });
    }

    messages.push({
      role,
      parts,
      ...(asTrimmedString(rawMessage.phase) ? { phase: asTrimmedString(rawMessage.phase) } : {}),
      ...(asTrimmedString(rawMessage.reasoning_signature)
        ? { reasoningSignature: asTrimmedString(rawMessage.reasoning_signature) }
        : {}),
    });
  }

  const reasoningResult = normalizeCanonicalReasoningRequest({
    include: body.include,
    reasoning: body.reasoning,
    reasoning_effort: body.reasoning_effort,
    reasoning_budget: body.reasoning_budget,
    reasoning_summary: body.reasoning_summary,
  });

  const continuation = readOpenAiCompatibleContinuation(body, input.continuation);
  const generation = canonicalGenerationFromOpenAiBody(body);
  const legacyTools = Array.isArray(body.functions)
    ? body.functions
      .filter((item) => isRecord(item))
      .map((item) => ({
        type: 'function',
        function: cloneJsonValue(item),
      }))
    : undefined;
  const tools = parseTools(body.tools ?? legacyTools);
  const legacyFunctionCall = isRecord(body.function_call)
    ? {
      type: 'function',
      function: {
        name: body.function_call.name,
      },
    }
    : body.function_call;
  const toolChoice = parseToolChoice(body.tool_choice ?? legacyFunctionCall);

  const passthrough = {
    ...(input.passthrough ?? {}),
    ...(reasoningResult.metadata ? { transformerMetadata: reasoningResult.metadata } : {}),
  };

  return createCanonicalRequestEnvelope({
    operation: input.operation ?? 'generate',
    surface: input.surface,
    cliProfile: input.cliProfile ?? 'generic',
    requestedModel: asTrimmedString(body.model),
    stream: body.stream === true,
    messages,
    ...(reasoningResult.reasoning ? { reasoning: reasoningResult.reasoning } : {}),
    ...(generation ? { generation } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(typeof body.parallel_tool_calls === 'boolean'
      ? { parallelToolCalls: body.parallel_tool_calls }
      : {}),
    ...(continuation ? { continuation } : {}),
    ...(metadata ? { metadata } : {}),
    ...(attachments ? { attachments } : {}),
    ...(Object.keys(passthrough).length > 0 ? { passthrough } : {}),
  });
}

function canonicalPartsToOpenAiContent(
  role: CanonicalMessageRole,
  parts: CanonicalContentPart[],
): { content: string | Array<Record<string, unknown>>; reasoning?: string; toolCalls?: Array<Record<string, unknown>> } {
  const contentBlocks: Array<Record<string, unknown>> = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const visibleText: string[] = [];
  const reasoningText: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      if (part.thought === true) {
        reasoningText.push(part.text);
      } else {
        visibleText.push(part.text);
      }
      continue;
    }
    if (part.type === 'image') {
      const url = asTrimmedString(part.url ?? part.dataUrl);
      if (url) {
        contentBlocks.push({
          type: 'image_url',
          image_url: { url },
        });
      }
      continue;
    }
    if (part.type === 'file') {
      const normalizedFile = canonicalAttachmentToNormalizedInputFile({
        kind: 'file',
        ...(part.fileId ? { fileId: part.fileId } : {}),
        ...(part.fileUrl ? { fileUrl: part.fileUrl } : {}),
        ...(part.fileData ? { fileData: part.fileData } : {}),
        ...(part.filename ? { filename: part.filename } : {}),
        ...(part.mimeType !== undefined ? { mimeType: part.mimeType } : {}),
      });
      contentBlocks.push(toOpenAiChatFileBlock(normalizedFile));
      continue;
    }
    if (part.type === 'audio') {
      const mimeSubtype = asTrimmedString(part.mimeType).split('/')[1] || '';
      const format = part.format
        || (mimeSubtype === 'mpeg' ? 'mp3' : mimeSubtype)
        || 'wav';
      contentBlocks.push({
        type: 'input_audio',
        input_audio: {
          data: part.data,
          format,
        },
      });
      continue;
    }
    if (part.type === 'tool_call') {
      toolCalls.push({
        id: part.id,
        type: 'function',
        function: {
          name: part.name,
          arguments: part.argumentsJson,
        },
        ...(part.thoughtSignature
          ? { provider_specific_fields: { thought_signature: part.thoughtSignature } }
          : {}),
      });
      continue;
    }
    if (part.type === 'tool_result' && role !== 'tool') {
      const text = part.resultText
        ?? (typeof part.resultContent === 'string'
          ? part.resultContent
          : safeJsonStringify(part.resultJson ?? part.resultContent ?? ''));
      if (text) {
        visibleText.push(text);
      }
    }
  }

  if (contentBlocks.length <= 0) {
    return {
      content: visibleText.join(''),
      ...(reasoningText.length > 0 ? { reasoning: reasoningText.join('') } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  if (visibleText.length > 0) {
    contentBlocks.unshift({
      type: 'text',
      text: visibleText.join(''),
    });
  }

  return {
    content: contentBlocks,
    ...(reasoningText.length > 0 ? { reasoning: reasoningText.join('') } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function canonicalToolChoiceToOpenAi(toolChoice: CanonicalToolChoice | undefined): unknown {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto' || toolChoice === 'none') return toolChoice;
  if (toolChoice === 'required') return 'required';
  if (toolChoice.type === 'raw') return cloneJsonValue(toolChoice.value);
  return {
    type: 'function',
    function: {
      name: toolChoice.name,
    },
  };
}

function extractCustomToolDefinition(
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const nestedCustom = isRecord(raw.custom) ? raw.custom : null;
  const name = asTrimmedString(nestedCustom?.name ?? raw.name);
  if (!name) return null;
  return {
    ...(nestedCustom ? cloneJsonValue(nestedCustom) : {}),
    name,
    ...(!nestedCustom && asTrimmedString(raw.description)
      ? { description: asTrimmedString(raw.description) }
      : {}),
    ...(!nestedCustom && raw.format !== undefined
      ? { format: cloneJsonValue(raw.format) }
      : {}),
  };
}

function canonicalToolToOpenAiTarget(
  tool: CanonicalTool,
  preserveResponsesExtensions: boolean,
): Record<string, unknown> | null {
  if (!('raw' in tool)) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
        parameters: cloneJsonValue(tool.inputSchema ?? { type: 'object' }),
      },
    };
  }

  const raw = cloneJsonValue(tool.raw) as Record<string, unknown>;
  const type = asTrimmedString(raw.type || tool.type).toLowerCase();
  if (type === 'custom') {
    const custom = extractCustomToolDefinition(raw);
    if (!custom) return null;
    return preserveResponsesExtensions
      ? { type: 'custom', ...custom }
      : { type: 'custom', custom };
  }
  if (!preserveResponsesExtensions || !type) return null;
  raw.type = type;
  return raw;
}

function normalizeRawToolChoiceForOpenAiTarget(
  value: string | Record<string, unknown>,
  preserveResponsesExtensions: boolean,
): unknown {
  if (!isRecord(value)) return value;
  const type = asTrimmedString(value.type).toLowerCase();
  if (type === 'custom') {
    const custom = extractCustomToolDefinition(value);
    if (!custom) return undefined;
    return preserveResponsesExtensions
      ? { type: 'custom', name: custom.name }
      : { type: 'custom', custom: { name: custom.name } };
  }
  if (type !== 'allowed_tools') {
    return preserveResponsesExtensions ? cloneJsonValue(value) : undefined;
  }

  const allowedTools = isRecord(value.allowed_tools) ? value.allowed_tools : value;
  const tools = Array.isArray(allowedTools.tools)
    ? allowedTools.tools
      .map((tool): Record<string, unknown> | null => {
        if (!isRecord(tool)) return null;
        const toolType = asTrimmedString(tool.type).toLowerCase();
        if (toolType === 'function') {
          const name = asTrimmedString(
            (isRecord(tool.function) ? tool.function.name : undefined) ?? tool.name,
          );
          if (!name) return null;
          return preserveResponsesExtensions
            ? { type: 'function', name }
            : { type: 'function', function: { name } };
        }
        if (toolType === 'custom') {
          const custom = extractCustomToolDefinition(tool);
          if (!custom) return null;
          return preserveResponsesExtensions
            ? { type: 'custom', name: custom.name }
            : { type: 'custom', custom: { name: custom.name } };
        }
        return null;
      })
      .filter((tool): tool is Record<string, unknown> => tool !== null)
    : [];
  if (tools.length === 0) return undefined;
  const normalized = {
    mode: asTrimmedString(allowedTools.mode).toLowerCase() === 'required' ? 'required' : 'auto',
    tools,
  };
  return preserveResponsesExtensions
    ? { type: 'allowed_tools', ...normalized }
    : { type: 'allowed_tools', allowed_tools: normalized };
}

function canonicalToolChoiceToOpenAiTarget(
  toolChoice: CanonicalToolChoice | undefined,
  preserveResponsesExtensions: boolean,
): unknown {
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'raw') {
    return normalizeRawToolChoiceForOpenAiTarget(
      toolChoice.value,
      preserveResponsesExtensions,
    );
  }
  return canonicalToolChoiceToOpenAi(toolChoice);
}

export function canonicalRequestToOpenAiChatBody(
  request: CanonicalRequestEnvelope,
  options: { preserveResponsesExtensions?: boolean } = {},
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  for (const message of request.messages) {
    if (message.role === 'tool') {
      for (const part of message.parts) {
        if (part.type !== 'tool_result') continue;
        messages.push({
          role: 'tool',
          tool_call_id: part.toolCallId,
          content: part.resultContent
            ?? part.resultText
            ?? safeJsonStringify(part.resultJson ?? ''),
        });
      }
      continue;
    }

    const converted = canonicalPartsToOpenAiContent(message.role, message.parts);
    const nextMessage: Record<string, unknown> = {
      role: message.role,
      content: converted.content,
    };
    if (message.role === 'assistant' && converted.reasoning) {
      nextMessage.reasoning_content = converted.reasoning;
    }
    if (message.phase) nextMessage.phase = message.phase;
    if (message.reasoningSignature) nextMessage.reasoning_signature = message.reasoningSignature;
    if (message.role === 'assistant' && converted.toolCalls && converted.toolCalls.length > 0) {
      nextMessage.tool_calls = converted.toolCalls;
      if (typeof nextMessage.content !== 'string' && (nextMessage.content as Array<unknown>).length <= 0) {
        nextMessage.content = '';
      }
    }
    messages.push(nextMessage);
  }

  const body: Record<string, unknown> = {
    model: request.requestedModel,
    stream: request.stream,
    messages,
  };

  if (request.reasoning?.effort) body.reasoning_effort = request.reasoning.effort;
  if (request.reasoning?.budgetTokens !== undefined) body.reasoning_budget = request.reasoning.budgetTokens;
  if (request.reasoning?.summary) body.reasoning_summary = request.reasoning.summary;
  if (request.generation?.maxOutputTokens !== undefined) {
    body.max_completion_tokens = request.generation.maxOutputTokens;
  }
  if (request.generation?.temperature !== undefined) body.temperature = request.generation.temperature;
  if (request.generation?.topP !== undefined) body.top_p = request.generation.topP;
  if (request.generation?.topK !== undefined) body.top_k = request.generation.topK;
  if (request.generation?.stopSequences) body.stop = cloneJsonValue(request.generation.stopSequences);
  if (request.generation?.responseFormat !== undefined) {
    body.response_format = cloneJsonValue(request.generation.responseFormat);
  }
  if (request.generation?.modalities) body.modalities = cloneJsonValue(request.generation.modalities);
  if (request.generation?.audio) body.audio = cloneJsonValue(request.generation.audio);
  if (request.generation?.serviceTier) body.service_tier = request.generation.serviceTier;
  if (request.generation?.topLogprobs !== undefined) {
    body.logprobs = true;
    body.top_logprobs = request.generation.topLogprobs;
  }
  if (request.generation?.logitBias) body.logit_bias = cloneJsonValue(request.generation.logitBias);
  if (request.generation?.safetyIdentifier) body.safety_identifier = request.generation.safetyIdentifier;
  if (request.generation?.user) body.user = request.generation.user;
  if (request.generation?.verbosity) body.verbosity = request.generation.verbosity;
  if (request.generation?.streamOptionsIncludeUsage !== undefined) {
    body.stream_options = {
      include_usage: request.generation.streamOptionsIncludeUsage,
    };
  }
  if (options.preserveResponsesExtensions) {
    if (request.generation?.maxToolCalls !== undefined) {
      body.max_tool_calls = request.generation.maxToolCalls;
    }
    if (request.generation?.promptCacheRetention !== undefined) {
      body.prompt_cache_retention = cloneJsonValue(request.generation.promptCacheRetention);
    }
    if (request.generation?.background !== undefined) {
      body.background = request.generation.background;
    }
    if (request.generation?.truncation !== undefined) {
      body.truncation = cloneJsonValue(request.generation.truncation);
    }
  }
  if (typeof request.parallelToolCalls === 'boolean') {
    body.parallel_tool_calls = request.parallelToolCalls;
  }
  const transformerMetadata = isRecord(request.passthrough?.transformerMetadata)
    ? request.passthrough.transformerMetadata as Record<string, unknown>
    : null;
  const passthroughInclude = Array.isArray(transformerMetadata?.include)
    ? (transformerMetadata.include as unknown[])
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
  const mergedInclude = [
    ...(request.reasoning?.includeEncryptedContent ? ['reasoning.encrypted_content'] : []),
    ...passthroughInclude,
  ].filter((item, index, all) => all.indexOf(item) === index);
  if (options.preserveResponsesExtensions && mergedInclude.length > 0) {
    body.include = mergedInclude;
  }
  const metadata = isRecord(request.metadata)
    ? cloneJsonValue(request.metadata)
    : {};
  applyOpenAiCompatibleContinuation(body, request.continuation, metadata);
  if (!options.preserveResponsesExtensions) {
    delete body.previous_response_id;
  }
  if (Array.isArray(request.attachments) && request.attachments.length > 0) {
    body.attachments = cloneJsonValue(request.attachments);
  }
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools
      .map((tool) => canonicalToolToOpenAiTarget(
        tool,
        options.preserveResponsesExtensions === true,
      ))
      .filter((tool): tool is Record<string, unknown> => !!tool);
    if ((body.tools as unknown[]).length === 0) {
      delete body.tools;
    }
  }
  const toolChoice = canonicalToolChoiceToOpenAiTarget(
    request.toolChoice,
    options.preserveResponsesExtensions === true,
  );
  if (toolChoice !== undefined && Array.isArray(body.tools) && body.tools.length > 0) {
    body.tool_choice = toolChoice;
  }

  if (isRecord(request.passthrough)) {
    for (const [key, value] of Object.entries(request.passthrough)) {
      if (
        key === 'transformerMetadata'
        || key === 'parallel_tool_calls'
        || body[key] !== undefined
      ) continue;
      body[key] = cloneJsonValue(value);
    }
  }

  return body;
}
