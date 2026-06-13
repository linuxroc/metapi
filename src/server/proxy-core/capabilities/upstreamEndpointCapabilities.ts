import type { UpstreamEndpoint } from '../orchestration/upstreamRequest.js';

export type EndpointCapabilityPreference = 'openai' | 'claude' | 'responses';
export type UpstreamTransport =
  | 'anthropic-messages'
  | 'codex-responses'
  | 'gemini-internal'
  | 'gemini-openai-compatible'
  | 'openai-compatible';

export type UpstreamEndpointCapability = {
  platform: string;
  nativeProvider: boolean;
  transport: UpstreamTransport;
  supportedEndpoints: UpstreamEndpoint[];
  preferredEndpoints: UpstreamEndpoint[];
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isNativeOpenAiUrl(siteUrl: string | undefined): boolean {
  const rawUrl = asTrimmedString(siteUrl);
  if (!rawUrl) return false;

  try {
    return new URL(rawUrl).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

function alignOpenAiCompatibleEndpoints(
  downstreamFormat: EndpointCapabilityPreference,
  supportedEndpoints: UpstreamEndpoint[],
): UpstreamEndpoint[] {
  const preferred = downstreamFormat === 'openai'
    ? ['chat', 'responses', 'messages']
    : downstreamFormat === 'responses'
    ? ['responses', 'chat', 'messages']
    : ['responses', 'chat', 'messages'];
  return preferred.filter((endpoint): endpoint is UpstreamEndpoint => supportedEndpoints.includes(
    endpoint as UpstreamEndpoint,
  ));
}

export function resolveUpstreamEndpointCapability(input: {
  sitePlatform?: string;
  siteUrl?: string;
  downstreamFormat: EndpointCapabilityPreference;
  preferMessagesForClaudeModel?: boolean;
  oauthProvider?: string | null;
}): UpstreamEndpointCapability {
  const platform = asTrimmedString(input.sitePlatform).toLowerCase();
  const oauthProvider = asTrimmedString(input.oauthProvider).toLowerCase();

  if (platform === 'codex') {
    return {
      platform,
      nativeProvider: true,
      transport: 'codex-responses',
      supportedEndpoints: ['responses'],
      preferredEndpoints: ['responses'],
    };
  }

  if (platform === 'gemini' || platform === 'gemini-cli') {
    return {
      platform,
      nativeProvider: true,
      transport: platform === 'gemini-cli' ? 'gemini-internal' : 'gemini-openai-compatible',
      supportedEndpoints: ['chat'],
      preferredEndpoints: ['chat'],
    };
  }

  if (platform === 'antigravity') {
    return {
      platform,
      nativeProvider: true,
      transport: 'gemini-internal',
      supportedEndpoints: ['chat'],
      preferredEndpoints: ['chat'],
    };
  }

  if (platform === 'claude') {
    return {
      platform,
      nativeProvider: true,
      transport: 'anthropic-messages',
      supportedEndpoints: ['messages'],
      preferredEndpoints: ['messages'],
    };
  }

  if (platform === 'openai') {
    const nativeProvider = isNativeOpenAiUrl(input.siteUrl);
    const supportedEndpoints: UpstreamEndpoint[] = ['chat', 'responses'];
    const alignedEndpoints = alignOpenAiCompatibleEndpoints(
      input.downstreamFormat,
      supportedEndpoints,
    );
    return {
      platform,
      nativeProvider,
      transport: 'openai-compatible',
      supportedEndpoints,
      preferredEndpoints: oauthProvider === 'codex'
        ? [
          'responses',
          ...alignedEndpoints.filter((endpoint) => endpoint !== 'responses'),
        ]
        : alignedEndpoints,
    };
  }

  let preferredEndpoints: UpstreamEndpoint[];
  if (input.downstreamFormat === 'responses') {
    preferredEndpoints = input.preferMessagesForClaudeModel
      ? ['messages', 'chat', 'responses']
      : ['responses', 'chat', 'messages'];
  } else if (
    input.downstreamFormat === 'claude'
    || (input.downstreamFormat === 'openai' && input.preferMessagesForClaudeModel)
  ) {
    preferredEndpoints = ['messages', 'chat', 'responses'];
  } else {
    preferredEndpoints = ['chat', 'messages', 'responses'];
  }

  if (oauthProvider === 'codex') {
    preferredEndpoints = [
      'responses',
      ...preferredEndpoints.filter((endpoint) => endpoint !== 'responses'),
    ];
  }

  return {
    platform,
    nativeProvider: false,
    transport: 'openai-compatible',
    supportedEndpoints: ['chat', 'messages', 'responses'],
    preferredEndpoints,
  };
}
