import { toOpenAiChatFileBlock } from '../../shared/inputFile.js';
import {
  createStreamTransformContext,
  normalizeUpstreamStreamEvent,
  pullSseEventsWithDone,
  type NormalizedFinalResponse,
} from '../../shared/normalized.js';
import { extractReasoningMetadataFromGeminiRequest } from './convert.js';

type GeminiRecord = Record<string, unknown>;

function isRecord(value: unknown): value is GeminiRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('image/');
}

function parseJsonIfPossible(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: value };
  }
}

function buildDataUrl(part: GeminiRecord): string | null {
  const inlineData = isRecord(part.inlineData) ? part.inlineData : null;
  if (!inlineData) return null;
  const mimeType = asTrimmedString(inlineData.mime_type ?? inlineData.mimeType) || 'application/octet-stream';
  const data = asTrimmedString(inlineData.data);
  if (!data) return null;
  return `data:${mimeType};base64,${data}`;
}

function buildInlineData(
  part: GeminiRecord,
): { mimeType: string; data: string } | null {
  const inlineData = isRecord(part.inlineData) ? part.inlineData : null;
  if (!inlineData) return null;
  const mimeType = asTrimmedString(inlineData.mime_type ?? inlineData.mimeType) || 'application/octet-stream';
  const data = asTrimmedString(inlineData.data);
  if (!data) return null;
  return { mimeType, data };
}

function buildFileDataSource(
  part: GeminiRecord,
): { fileUri: string; mimeType: string | null } | null {
  const fileData = isRecord(part.fileData) ? part.fileData : null;
  if (!fileData) return null;
  const fileUri = asTrimmedString(fileData.fileUri ?? fileData.file_uri);
  if (!fileUri) return null;
  const mimeType = asTrimmedString(fileData.mimeType ?? fileData.mime_type) || null;
  return { fileUri, mimeType };
}

function toOpenAiBlockFromGeminiPart(part: GeminiRecord): Record<string, unknown> | null {
  const inlineData = buildInlineData(part);
  if (inlineData) {
    const normalizedMimeType = inlineData.mimeType.toLowerCase();
    if (normalizedMimeType.startsWith('image/')) {
      return {
        type: 'image_url',
        image_url: { url: buildDataUrl(part)! },
      };
    }

    return toOpenAiChatFileBlock({
      fileData: inlineData.data,
      mimeType: inlineData.mimeType,
    });
  }

  const fileData = buildFileDataSource(part);
  if (!fileData) return null;
  if (fileData.mimeType?.toLowerCase().startsWith('image/')) {
    return {
      type: 'image_url',
      image_url: { url: fileData.fileUri },
    };
  }

  return toOpenAiChatFileBlock({
    fileUrl: fileData.fileUri,
    mimeType: fileData.mimeType,
  });
}

function toOpenAiContent(contentParts: GeminiRecord[]): string | Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  let textContent = '';

  for (const part of contentParts) {
    if (typeof part.text === 'string' && part.text.length > 0) {
      if (part.thought === true) continue;
      textContent += part.text;
      continue;
    }

    const block = toOpenAiBlockFromGeminiPart(part);
    if (block) {
      blocks.push(block);
    }
  }

  if (blocks.length <= 0) {
    return textContent;
  }

  if (textContent) {
    blocks.unshift({
      type: 'text',
      text: textContent,
    });
  }
  return blocks;
}

function extractToolDeclarations(tools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const next = tools.flatMap((tool) => {
    if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) return [];
    return tool.functionDeclarations.flatMap((declaration) => {
      if (!isRecord(declaration)) return [];
      const name = asTrimmedString(declaration.name);
      if (!name) return [];
      return [{
        type: 'function',
        function: {
          name,
          ...(asTrimmedString(declaration.description)
            ? { description: asTrimmedString(declaration.description) }
            : {}),
          parameters: isRecord(declaration.parametersJsonSchema)
            ? declaration.parametersJsonSchema
            : (isRecord(declaration.parameters) ? declaration.parameters : { type: 'object', properties: {} }),
        },
      }];
    });
  });
  return next.length > 0 ? next : undefined;
}

function extractToolChoice(toolConfig: unknown): string | undefined {
  const functionCallingConfig = (
    isRecord(toolConfig) && isRecord(toolConfig.functionCallingConfig)
      ? toolConfig.functionCallingConfig
      : null
  );
  const mode = asTrimmedString(functionCallingConfig?.mode).toUpperCase();
  if (mode === 'NONE') return 'none';
  if (mode === 'ANY' || mode === 'VALIDATED') return 'required';
  if (mode === 'AUTO') return 'auto';
  return undefined;
}

function buildGeminiMessages(body: GeminiRecord): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const pendingToolCallIdsByName = new Map<string, string[]>();
  let nextSyntheticToolCallIndex = 0;

  if (isRecord(body.systemInstruction) && Array.isArray(body.systemInstruction.parts)) {
    const content = toOpenAiContent(
      body.systemInstruction.parts.filter((part): part is GeminiRecord => isRecord(part)),
    );
    const hasContent = typeof content === 'string' ? content.length > 0 : content.length > 0;
    if (hasContent) {
      messages.push({
        role: 'system',
        content,
      });
    }
  }

  const contents = Array.isArray(body.contents) ? body.contents : [];
  for (const contentItem of contents) {
    if (!isRecord(contentItem)) continue;
    const role = asTrimmedString(contentItem.role) === 'model' ? 'assistant' : 'user';
    const parts = Array.isArray(contentItem.parts)
      ? contentItem.parts.filter((part): part is GeminiRecord => isRecord(part))
      : [];

    const toolCalls = parts
      .map((part) => {
        const functionCall = isRecord(part.functionCall) ? part.functionCall : null;
        const name = asTrimmedString(functionCall?.name);
        if (!functionCall || !name) return null;
        const id = asTrimmedString(functionCall.id) || `call_${nextSyntheticToolCallIndex}`;
        nextSyntheticToolCallIndex += 1;
        const pendingIds = pendingToolCallIdsByName.get(name) || [];
        pendingIds.push(id);
        pendingToolCallIdsByName.set(name, pendingIds);
        return {
          id,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(functionCall.args ?? {}),
          },
          ...(asTrimmedString(part.thoughtSignature)
            ? {
              provider_specific_fields: {
                thought_signature: asTrimmedString(part.thoughtSignature),
              },
            }
            : {}),
        };
      })
      .filter((item): item is NonNullable<typeof item> => !!item);

    const functionResponses = parts
      .map((part) => (isRecord(part.functionResponse) ? part.functionResponse : null))
      .filter((item): item is GeminiRecord => !!item);

    if (functionResponses.length > 0) {
      for (let index = 0; index < functionResponses.length; index += 1) {
        const functionResponse = functionResponses[index] as GeminiRecord;
        const toolName = asTrimmedString(functionResponse.name) || `tool_${index}`;
        const explicitToolCallId = asTrimmedString(functionResponse.id);
        const pendingIds = pendingToolCallIdsByName.get(toolName) || [];
        let toolCallId = explicitToolCallId;
        if (toolCallId) {
          const matchingIndex = pendingIds.indexOf(toolCallId);
          if (matchingIndex >= 0) pendingIds.splice(matchingIndex, 1);
        } else {
          toolCallId = pendingIds.shift() || toolName;
        }
        if (pendingIds.length > 0) {
          pendingToolCallIdsByName.set(toolName, pendingIds);
        } else {
          pendingToolCallIdsByName.delete(toolName);
        }
        const toolResponse = functionResponse.response;
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify(toolResponse ?? {}),
        });
      }
      continue;
    }

    const openAiParts = parts.filter((part) => !part.functionCall && !part.functionResponse);
    const content = toOpenAiContent(openAiParts);
    const hasContent = typeof content === 'string' ? content.length > 0 : content.length > 0;
    if (!hasContent && toolCalls.length <= 0) continue;

    const message: Record<string, unknown> = {
      role,
    };
    if (hasContent) {
      message.content = content;
    }
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
      if (!hasContent) message.content = '';
    }
    messages.push(message);
  }

  return messages;
}

export function buildOpenAiBodyFromGeminiRequest(input: {
  body: GeminiRecord;
  modelName: string;
  stream: boolean;
}): Record<string, unknown> {
  const openAiBody: Record<string, unknown> = {
    model: input.modelName,
    stream: input.stream,
    messages: buildGeminiMessages(input.body),
  };

  const generationConfig = isRecord(input.body.generationConfig) ? input.body.generationConfig : null;
  const maxTokens = Number(
    generationConfig?.maxOutputTokens
    ?? input.body.max_output_tokens
    ?? input.body.max_completion_tokens
    ?? input.body.max_tokens
    ?? 0,
  );
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    openAiBody.max_tokens = Math.trunc(maxTokens);
  }
  const temperature = Number(generationConfig?.temperature);
  if (Number.isFinite(temperature)) openAiBody.temperature = temperature;
  const topP = Number(generationConfig?.topP);
  if (Number.isFinite(topP)) openAiBody.top_p = topP;
  const topK = Number(generationConfig?.topK);
  if (Number.isFinite(topK)) openAiBody.top_k = topK;
  if (Array.isArray(generationConfig?.stopSequences) && generationConfig!.stopSequences.length > 0) {
    openAiBody.stop = generationConfig!.stopSequences;
  }
  const responseMimeType = asTrimmedString(generationConfig?.responseMimeType).toLowerCase();
  const responseSchema = generationConfig?.responseJsonSchema ?? generationConfig?.responseSchema;
  if (responseMimeType === 'application/json') {
    openAiBody.response_format = isRecord(responseSchema)
      ? {
        type: 'json_schema',
        json_schema: {
          name: 'gemini_response',
          schema: responseSchema,
        },
      }
      : { type: 'json_object' };
  }

  const tools = extractToolDeclarations(input.body.tools);
  if (tools) {
    openAiBody.tools = tools;
  }
  const toolChoice = extractToolChoice(input.body.toolConfig);
  if (toolChoice) {
    openAiBody.tool_choice = toolChoice;
  }

  const reasoning = extractReasoningMetadataFromGeminiRequest(input.body);
  if (reasoning) {
    openAiBody.reasoning = {
      effort: reasoning.reasoningEffort,
      budget_tokens: reasoning.reasoningBudget,
    };
    openAiBody.reasoning_effort = reasoning.reasoningEffort;
  }

  return openAiBody;
}

export function normalizeUpstreamSseTextToFinal(input: {
  rawText: string;
  modelName: string;
}): {
  normalized: NormalizedFinalResponse;
  payloads: unknown[];
} {
  const context = createStreamTransformContext(input.modelName);
  const toolCalls = new Map<number, {
    id?: string;
    name?: string;
    arguments: string;
    thoughtSignature?: string;
  }>();
  const payloads: unknown[] = [];
  let content = '';
  let reasoningContent = '';
  let reasoningSignature: string | undefined;
  let finishReason = '';

  const terminatedText = input.rawText.endsWith('\n\n')
    ? input.rawText
    : `${input.rawText}\n\n`;
  const { events } = pullSseEventsWithDone(terminatedText);
  for (const event of events) {
    if (event.data === '[DONE]') {
      if (!finishReason) finishReason = toolCalls.size > 0 ? 'tool_calls' : 'stop';
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }
    payloads.push(payload);
    const payloadRecord = isRecord(payload) ? payload : null;
    const eventType = asTrimmedString(event.event).toLowerCase();
    const payloadType = asTrimmedString(payloadRecord?.type).toLowerCase();
    const responseStatus = isRecord(payloadRecord?.response)
      ? asTrimmedString(payloadRecord.response.status).toLowerCase()
      : '';
    if (
      eventType === 'error'
      || eventType === 'response.failed'
      || payloadType === 'error'
      || payloadType === 'response.failed'
      || responseStatus === 'failed'
    ) {
      const errorRecord = isRecord(payloadRecord?.error)
        ? payloadRecord.error
        : (isRecord(payloadRecord?.response) && isRecord(payloadRecord.response.error)
          ? payloadRecord.response.error
          : null);
      const message = asTrimmedString(errorRecord?.message)
        || 'Upstream SSE terminated with a failure event';
      throw new Error(message);
    }

    const normalizedEvent = normalizeUpstreamStreamEvent(payload, context, input.modelName);
    if (normalizedEvent.contentDelta) content += normalizedEvent.contentDelta;
    if (normalizedEvent.reasoningDelta) reasoningContent += normalizedEvent.reasoningDelta;
    if (normalizedEvent.reasoningSignature) {
      reasoningSignature = normalizedEvent.reasoningSignature;
    }
    if (normalizedEvent.finishReason) finishReason = normalizedEvent.finishReason;

    for (const toolCallDelta of normalizedEvent.toolCallDeltas || []) {
      const current = toolCalls.get(toolCallDelta.index) || { arguments: '' };
      if (toolCallDelta.id) current.id = toolCallDelta.id;
      if (toolCallDelta.name) current.name = toolCallDelta.name;
      if (toolCallDelta.argumentsDelta) current.arguments += toolCallDelta.argumentsDelta;
      if (toolCallDelta.thoughtSignature) {
        current.thoughtSignature = toolCallDelta.thoughtSignature;
      }
      toolCalls.set(toolCallDelta.index, current);
      context.toolCalls[toolCallDelta.index] = {
        ...(current.id ? { id: current.id } : {}),
        ...(current.name ? { name: current.name } : {}),
        arguments: current.arguments,
        ...(current.thoughtSignature ? { thoughtSignature: current.thoughtSignature } : {}),
      };
    }
  }

  const normalizedToolCalls = Array.from(toolCalls.entries())
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([index, toolCall]) => ({
      id: toolCall.id || `call_${index}`,
      name: toolCall.name || `tool_${index}`,
      arguments: toolCall.arguments,
      ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}),
    }));

  return {
    normalized: {
      id: context.id,
      model: context.model || input.modelName,
      created: context.created,
      content,
      reasoningContent,
      ...(reasoningSignature ? { reasoningSignature } : {}),
      finishReason: finishReason || (normalizedToolCalls.length > 0 ? 'tool_calls' : 'stop'),
      toolCalls: normalizedToolCalls,
    },
    payloads,
  };
}

function mapFinishReason(finishReason: string): string {
  const normalized = finishReason.trim().toLowerCase();
  if (!normalized) return 'STOP';
  if (normalized === 'stop' || normalized === 'completed' || normalized === 'tool_calls') return 'STOP';
  if (normalized === 'length' || normalized === 'max_tokens' || normalized === 'max_output_tokens') return 'MAX_TOKENS';
  if (normalized === 'content_filter' || normalized === 'safety') return 'SAFETY';
  return normalized.toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
}

function buildUsageMetadata(usage?: {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
}): Record<string, number> | undefined {
  if (!usage) return undefined;
  const metadata: Record<string, number> = {};
  if (typeof usage.promptTokens === 'number' && Number.isFinite(usage.promptTokens)) {
    metadata.promptTokenCount = usage.promptTokens;
  }
  if (typeof usage.completionTokens === 'number' && Number.isFinite(usage.completionTokens)) {
    metadata.candidatesTokenCount = usage.completionTokens;
  }
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) {
    metadata.totalTokenCount = usage.totalTokens;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function serializeNormalizedFinalToGemini(input: {
  normalized: NormalizedFinalResponse;
  usage?: {
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
  };
}): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];

  if (input.normalized.reasoningContent) {
    parts.push({
      text: input.normalized.reasoningContent,
      thought: true,
      ...(input.normalized.reasoningSignature
        ? { thoughtSignature: input.normalized.reasoningSignature }
        : {}),
    });
  }
  if (input.normalized.content) {
    parts.push({
      text: input.normalized.content,
    });
  }
  for (const toolCall of input.normalized.toolCalls) {
    parts.push({
      functionCall: {
        ...(toolCall.id ? { id: toolCall.id } : {}),
        name: toolCall.name,
        args: parseJsonIfPossible(toolCall.arguments),
      },
      ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}),
    });
  }

  const response: Record<string, unknown> = {
    responseId: input.normalized.id || '',
    modelVersion: input.normalized.model || '',
    candidates: [
      {
        index: 0,
        content: {
          role: 'model',
          parts,
        },
        finishReason: mapFinishReason(input.normalized.finishReason),
      },
    ],
  };

  const usageMetadata = buildUsageMetadata(input.usage);
  if (usageMetadata) {
    response.usageMetadata = usageMetadata;
  }

  return response;
}
