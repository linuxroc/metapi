import type { DownstreamFormat } from './normalized.js';

export type CompatibilityEndpoint = 'chat' | 'messages' | 'responses';
export type CompatibilityEndpointPreference = DownstreamFormat | 'responses';

type ParsedEndpointErrorShape = {
  code: string;
  message: string;
  text: string;
  type: string;
};

type PreferResponsesAfterLegacyChatErrorInput = {
  status: number;
  upstreamErrorText?: string | null;
  downstreamFormat: CompatibilityEndpointPreference;
  sitePlatform?: string | null;
  modelName?: string | null;
  requestedModelHint?: string | null;
  currentEndpoint?: CompatibilityEndpoint | null;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlatformName(platform: unknown): string {
  return asTrimmedString(platform).toLowerCase();
}

function isClaudeFamilyModel(modelName: string): boolean {
  const normalized = asTrimmedString(modelName).toLowerCase();
  if (!normalized) return false;
  return normalized === 'claude' || normalized.startsWith('claude-') || normalized.includes('claude');
}

function headerValueToString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }

  return null;
}

function normalizeHeaderMap(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    const value = headerValueToString(rawValue);
    if (!value) continue;
    normalized[key] = value;
  }
  return normalized;
}

function parseEndpointErrorShape(upstreamErrorText?: string | null): ParsedEndpointErrorShape {
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) {
    return {
      code: '',
      message: '',
      text: '',
      type: '',
    };
  }

  try {
    const parsed = JSON.parse(upstreamErrorText || '{}') as Record<string, unknown>;
    const error = (parsed.error && typeof parsed.error === 'object')
      ? parsed.error as Record<string, unknown>
      : parsed;
    return {
      code: asTrimmedString(error.code).toLowerCase(),
      message: asTrimmedString(error.message).toLowerCase(),
      text,
      type: asTrimmedString(error.type).toLowerCase(),
    };
  } catch {
    return {
      code: '',
      message: '',
      text,
      type: '',
    };
  }
}

function inferEndpointMentionFromText(text: string): CompatibilityEndpoint | null {
  if (!text) return null;
  if (text.includes('/v1/responses') || /\bresponses\b/.test(text)) return 'responses';
  if (text.includes('/v1/messages') || /\bmessages\b/.test(text)) return 'messages';
  if (text.includes('/v1/chat/completions') || /\bchat(?:\/completions)?\b/.test(text)) return 'chat';
  return null;
}

function hasLocalizedEndpointMismatchHint(text: string): boolean {
  if (!text) return false;
  const endpointNoun = '(?:api\\s*)?(?:接口|端点|路径|路由|请求地址|请求路径)';
  const mismatch = '(?:不存在|未找到|找不到|不支持|无效|错误|未实现|不可用|未开放|不匹配)';
  return new RegExp(`${endpointNoun}[^\\n]{0,24}${mismatch}`, 'i').test(text)
    || new RegExp(`${mismatch}[^\\n]{0,24}${endpointNoun}`, 'i').test(text);
}

function hasEnglishEndpointMismatchHint(text: string): boolean {
  if (!text) return false;
  const explicitPhrases = [
    'unknown endpoint',
    'unsupported endpoint',
    'unsupported path',
    'unrecognized request url',
    'no route matched',
    'endpoint not found',
    'path not found',
    'route not found',
    'invalid endpoint',
    'invalid path',
    'invalid url',
    'api not implemented',
    'unsupported legacy protocol',
  ];
  if (explicitPhrases.some((phrase) => text.includes(phrase))) return true;

  const endpointNoun = '(?:api\\s+)?(?:endpoint|path|route|request\\s+url|url)';
  const mismatch = '(?:not\\s+found|does\\s+not\\s+exist|unknown|unsupported|not\\s+supported|invalid|not\\s+implemented|unavailable)';
  return new RegExp(`\\b${endpointNoun}\\b[^\\n]{0,48}\\b${mismatch}\\b`, 'i').test(text)
    || new RegExp(`\\b${mismatch}\\b[^\\n]{0,48}\\b${endpointNoun}\\b`, 'i').test(text)
    || /\bcannot\s+(?:post|get|put|patch|delete)\s+\/v\d+\//i.test(text)
    || /\/v\d+\/[a-z0-9/_:-]+[^\\n]{0,48}\b(?:not\s+found|unsupported|not\s+supported|not\s+implemented)\b/i.test(text);
}

export function buildMinimalJsonHeadersForCompatibility(input: {
  headers: Record<string, string>;
  endpoint: CompatibilityEndpoint;
  stream: boolean;
}): Record<string, string> {
  const source = normalizeHeaderMap(input.headers);
  const minimal: Record<string, string> = {};

  if (source.authorization) minimal.authorization = source.authorization;
  if (source['x-api-key']) minimal['x-api-key'] = source['x-api-key'];

  if (input.endpoint === 'messages') {
    for (const [key, value] of Object.entries(source)) {
      if (!key.startsWith('anthropic-')) continue;
      minimal[key] = value;
    }
    if (!minimal['anthropic-version']) {
      minimal['anthropic-version'] = '2023-06-01';
    }
  }

  minimal['content-type'] = 'application/json';
  minimal.accept = input.stream ? 'text/event-stream' : 'application/json';
  return minimal;
}

export function isUnsupportedMediaTypeError(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 400) return false;
  if (status !== 400 && status !== 415) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) return status === 415;

  return (
    text.includes('unsupported media type')
    || text.includes("only 'application/json' is allowed")
    || text.includes('only "application/json" is allowed')
    || text.includes('application/json')
    || text.includes('content-type')
  );
}

export function isEndpointDispatchDeniedError(status: number, upstreamErrorText?: string | null): boolean {
  if (status !== 403) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) return false;

  return (
    /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i.test(upstreamErrorText || '')
    || text.includes('dispatch denied')
  );
}

export function inferRequiredEndpointFromProtocolError(
  upstreamErrorText?: string | null,
): CompatibilityEndpoint | null {
  const parsed = parseEndpointErrorShape(upstreamErrorText);
  const combined = `${parsed.text}\n${parsed.message}`;
  if (!combined.trim()) return null;
  if (/messages\s+is\s+required/i.test(combined)) return 'messages';
  if (/input\s+is\s+required/i.test(combined)) return 'responses';
  return null;
}

export function inferSuggestedEndpointFromUpstreamError(
  upstreamErrorText?: string | null,
): CompatibilityEndpoint | null {
  const requiredEndpoint = inferRequiredEndpointFromProtocolError(upstreamErrorText);
  if (requiredEndpoint) return requiredEndpoint;

  const parsed = parseEndpointErrorShape(upstreamErrorText);
  return (
    inferEndpointMentionFromText(parsed.message)
    || inferEndpointMentionFromText(parsed.text)
  );
}

export function hasEndpointMismatchHint(upstreamErrorText?: string | null): boolean {
  const parsed = parseEndpointErrorShape(upstreamErrorText);
  if (!parsed.text) return false;

  return hasEnglishEndpointMismatchHint(parsed.text)
    || hasEnglishEndpointMismatchHint(parsed.message)
    || hasLocalizedEndpointMismatchHint(parsed.text)
    || hasLocalizedEndpointMismatchHint(parsed.message)
    || inferRequiredEndpointFromProtocolError(upstreamErrorText) !== null;
}

export function promoteRequiredEndpointCandidateAfterProtocolError(
  endpointCandidates: CompatibilityEndpoint[],
  input: {
    currentEndpoint?: CompatibilityEndpoint | null;
    upstreamErrorText?: string | null;
  },
): void {
  const currentEndpoint = input.currentEndpoint ?? null;
  const requiredEndpoint = inferRequiredEndpointFromProtocolError(input.upstreamErrorText);
  if (!currentEndpoint || !requiredEndpoint || currentEndpoint === requiredEndpoint) return;

  const currentIndex = endpointCandidates.findIndex((endpoint) => endpoint === currentEndpoint);
  const requiredIndex = endpointCandidates.indexOf(requiredEndpoint);
  if (currentIndex < 0 || requiredIndex < 0 || requiredIndex <= currentIndex + 1) return;

  endpointCandidates.splice(requiredIndex, 1);
  endpointCandidates.splice(currentIndex + 1, 0, requiredEndpoint);
}

export function shouldPreferResponsesAfterLegacyChatError(
  input: PreferResponsesAfterLegacyChatErrorInput,
): boolean {
  if (input.status < 400) return false;
  if (input.downstreamFormat !== 'openai') return false;
  if (input.currentEndpoint !== 'chat') return false;

  const sitePlatform = normalizePlatformName(input.sitePlatform);
  if (sitePlatform === 'openai' || sitePlatform === 'claude' || sitePlatform === 'gemini' || sitePlatform === 'anyrouter') {
    return false;
  }

  const modelName = asTrimmedString(input.modelName);
  const requestedModelHint = asTrimmedString(input.requestedModelHint);
  if (isClaudeFamilyModel(modelName) || isClaudeFamilyModel(requestedModelHint)) {
    return false;
  }

  const text = (input.upstreamErrorText || '').toLowerCase();
  return (
    text.includes('unsupported legacy protocol')
    && text.includes('/v1/chat/completions')
    && text.includes('/v1/responses')
  );
}

export function promoteResponsesCandidateAfterLegacyChatError(
  endpointCandidates: CompatibilityEndpoint[],
  input: PreferResponsesAfterLegacyChatErrorInput,
): void {
  if (!shouldPreferResponsesAfterLegacyChatError(input)) return;

  const currentIndex = endpointCandidates.findIndex((endpoint) => endpoint === input.currentEndpoint);
  const responsesIndex = endpointCandidates.indexOf('responses');
  if (currentIndex < 0 || responsesIndex < 0 || responsesIndex <= currentIndex + 1) return;

  endpointCandidates.splice(responsesIndex, 1);
  endpointCandidates.splice(currentIndex + 1, 0, 'responses');
}

export function isEndpointDowngradeError(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 400) return false;
  const parsed = parseEndpointErrorShape(upstreamErrorText);
  const text = parsed.text;
  if (status === 405 || status === 415 || status === 501) return true;
  if (!text) return false;
  const endpointMismatchHint = hasEndpointMismatchHint(upstreamErrorText);
  const explicitEndpointCode = (
    parsed.code === 'endpoint_not_found'
    || parsed.code === 'unknown_endpoint'
    || parsed.code === 'unsupported_endpoint'
    || parsed.code === 'unsupported_path'
    || parsed.type === 'unsupported_endpoint'
    || parsed.type === 'unsupported_path'
  );

  return (
    isEndpointDispatchDeniedError(status, upstreamErrorText)
    || inferRequiredEndpointFromProtocolError(upstreamErrorText) !== null
    || text.includes('convert_request_failed')
    || explicitEndpointCode
    || endpointMismatchHint
    || text.includes('unsupported media type')
    || text.includes("only 'application/json' is allowed")
    || text.includes('only "application/json" is allowed')
    || text.includes('unsupported legacy protocol')
    || parsed.code === 'convert_request_failed'
    || (
      parsed.code === 'openai_error'
      && endpointMismatchHint
    )
    || (
      parsed.code === 'upstream_error'
      && endpointMismatchHint
    )
    || (
      parsed.type === 'openai_error'
      && endpointMismatchHint
    )
    || (
      parsed.type === 'upstream_error'
      && endpointMismatchHint
    )
    || parsed.message.includes('unsupported media type')
    || parsed.message.includes("only 'application/json' is allowed")
    || parsed.message.includes('only "application/json" is allowed')
    || (
      status === 400
      && parsed.code === 'invalid_request'
      && parsed.type === 'new_api_error'
      && (parsed.message.includes('claude code cli') || text.includes('claude code cli'))
    )
  );
}
