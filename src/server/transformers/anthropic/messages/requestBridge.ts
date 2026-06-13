import { canonicalRequestFromOpenAiBody, canonicalRequestToOpenAiChatBody } from '../../canonical/openAiRequestBridge.js';
import type { CanonicalRequestEnvelope } from '../../canonical/types.js';
import type { ProtocolParseContext } from '../../contracts.js';
import { anthropicMessagesInbound } from './inbound.js';
import { convertOpenAiBodyToAnthropicMessagesBody } from './conversion.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneJsonValue<T>(value: T): T | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return undefined;
  }
}

function anthropicFormatToOpenAiResponseFormat(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const type = asTrimmedString(value.type).toLowerCase();
  if (type !== 'json_schema') return undefined;

  const nestedJsonSchema = isRecord(value.json_schema) ? value.json_schema : null;
  const schema = cloneJsonValue(nestedJsonSchema?.schema ?? value.schema);
  if (!isRecord(schema)) return undefined;

  const name = (
    asTrimmedString(nestedJsonSchema?.name)
    || asTrimmedString(value.name)
    || 'response'
  );
  return {
    type: 'json_schema',
    json_schema: {
      name,
      schema,
      ...(typeof nestedJsonSchema?.strict === 'boolean'
        ? { strict: nestedJsonSchema.strict }
        : (typeof value.strict === 'boolean' ? { strict: value.strict } : {})),
    },
  };
}

function openAiResponseFormatToAnthropicFormat(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const type = asTrimmedString(value.type).toLowerCase();
  if (type === 'json_object') {
    return {
      type: 'json_schema',
      schema: { type: 'object' },
    };
  }
  if (type !== 'json_schema') return undefined;

  const jsonSchema = isRecord(value.json_schema) ? value.json_schema : value;
  const schema = cloneJsonValue(jsonSchema.schema);
  if (!isRecord(schema)) return undefined;
  return {
    type: 'json_schema',
    schema,
  };
}

export function parseAnthropicMessagesRequestToCanonical(
  body: unknown,
  ctx?: ProtocolParseContext,
): { value?: CanonicalRequestEnvelope; error?: { statusCode: number; payload: unknown } } {
  const parsed = anthropicMessagesInbound.parse(body);
  if (parsed.error) {
    return { error: parsed.error };
  }
  if (!parsed.value) {
    return {
      error: {
        statusCode: 400,
        payload: {
          error: {
            message: 'invalid messages request',
            type: 'invalid_request_error',
          },
        },
      },
    };
  }

  const canonical = canonicalRequestFromOpenAiBody({
    body: parsed.value.parsed.upstreamBody,
    surface: 'anthropic-messages',
    cliProfile: ctx?.cliProfile,
    operation: ctx?.operation,
    metadata: ctx?.metadata,
    passthrough: ctx?.passthrough,
    continuation: ctx?.continuation,
  });
  const originalBody = parsed.value.parsed.claudeOriginalBody;
  const outputConfig = isRecord(originalBody?.output_config)
    ? originalBody.output_config
    : null;
  const responseFormat = anthropicFormatToOpenAiResponseFormat(outputConfig?.format);

  return {
    value: {
      ...canonical,
      ...(responseFormat
        ? {
          generation: {
            ...(canonical.generation ?? {}),
            responseFormat,
          },
        }
        : {}),
    },
  };
}

export function buildCanonicalRequestToAnthropicMessagesBody(
  request: CanonicalRequestEnvelope,
  options: {
    defaultMaxTokens?: number;
  } = {},
): Record<string, unknown> {
  const openAiBody = canonicalRequestToOpenAiChatBody(request);
  const body = convertOpenAiBodyToAnthropicMessagesBody(
    openAiBody,
    request.requestedModel,
    request.stream,
    options,
  );
  const format = openAiResponseFormatToAnthropicFormat(request.generation?.responseFormat);
  if (format) {
    body.output_config = {
      ...(isRecord(body.output_config) ? body.output_config : {}),
      format,
    };
  }
  return body;
}
