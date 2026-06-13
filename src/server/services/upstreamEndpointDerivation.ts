import {
  rankConversationFileEndpoints,
  type ConversationFileInputSummary,
} from '../proxy-core/capabilities/conversationFileCapabilities.js';
import {
  resolveUpstreamEndpointCapability,
} from '../proxy-core/capabilities/upstreamEndpointCapabilities.js';
import type { UpstreamEndpoint } from '../proxy-core/orchestration/upstreamRequest.js';
import { fetchModelPricingCatalog } from './modelPricingService.js';
import {
  applyUpstreamEndpointRuntimePreference,
  buildEndpointCapabilityProfile,
} from './upstreamEndpointRuntimeMemory.js';
import type { DownstreamFormat } from '../transformers/shared/normalized.js';

export type EndpointPreference = DownstreamFormat | 'responses';
export type EndpointDerivationHints = {
  oauthProvider?: string | null;
  requestKind?: 'default' | 'responses-compact' | 'claude-count-tokens';
  requiresNativeResponsesFileUrl?: boolean;
};

type ChannelContext = {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlatformName(platform: unknown): string {
  return asTrimmedString(platform).toLowerCase();
}

type NormalizedEndpointType = {
  concrete: boolean;
  endpoints: UpstreamEndpoint[];
};

const ENDPOINT_TYPE_ALIASES: Record<string, NormalizedEndpointType> = {
  anthropic: { concrete: false, endpoints: ['messages'] },
  chat: { concrete: true, endpoints: ['chat'] },
  chat_completions: { concrete: true, endpoints: ['chat'] },
  claude: { concrete: false, endpoints: ['messages'] },
  completions: { concrete: true, endpoints: ['chat'] },
  messages: { concrete: true, endpoints: ['messages'] },
  openai: { concrete: false, endpoints: ['chat', 'responses'] },
  openai_chat: { concrete: true, endpoints: ['chat'] },
  openai_responses: { concrete: true, endpoints: ['responses'] },
  responses: { concrete: true, endpoints: ['responses'] },
};

const ENDPOINT_PATH_ALIASES: Record<string, UpstreamEndpoint> = {
  '/chat/completions': 'chat',
  '/messages': 'messages',
  '/responses': 'responses',
  '/v1/chat/completions': 'chat',
  '/v1/messages': 'messages',
  '/v1/responses': 'responses',
  'chat/completions': 'chat',
  'v1/chat/completions': 'chat',
  'v1/messages': 'messages',
  'v1/responses': 'responses',
};

function normalizeEndpointPath(value: string): string {
  let path = value;
  try {
    path = new URL(value).pathname;
  } catch {
    path = value.split(/[?#]/, 1)[0] || '';
  }
  const normalized = path.trim().toLowerCase().replace(/\/+$/, '');
  return normalized || '/';
}

function normalizeEndpointType(value: unknown): NormalizedEndpointType {
  const raw = asTrimmedString(value).toLowerCase();
  if (!raw) return { concrete: false, endpoints: [] };

  const aliasedEndpoints = ENDPOINT_TYPE_ALIASES[raw];
  if (aliasedEndpoints) {
    return aliasedEndpoints;
  }

  const endpoint = ENDPOINT_PATH_ALIASES[normalizeEndpointPath(raw)];
  return endpoint
    ? { concrete: true, endpoints: [endpoint] }
    : { concrete: false, endpoints: [] };
}

function preferredEndpointOrder(
  downstreamFormat: EndpointPreference,
  sitePlatform?: string,
  siteUrl?: string,
  preferMessagesForClaudeModel = false,
  hints?: EndpointDerivationHints,
): UpstreamEndpoint[] {
  if (hints?.requestKind === 'responses-compact') {
    return ['responses'];
  }

  const capability = resolveUpstreamEndpointCapability({
    sitePlatform,
    siteUrl,
    downstreamFormat,
    preferMessagesForClaudeModel,
    oauthProvider: hints?.oauthProvider,
  });
  if (hints?.requestKind === 'claude-count-tokens') {
    const supportsMessages = capability.supportedEndpoints.includes('messages')
      || (capability.platform === 'openai' && !capability.nativeProvider);
    return supportsMessages ? ['messages'] : [];
  }
  return capability.preferredEndpoints;
}

export async function resolveUpstreamEndpointCandidates(
  context: ChannelContext,
  modelName: string,
  downstreamFormat: EndpointPreference,
  requestedModelHint?: string,
  requestCapabilities?: {
    hasNonImageFileInput?: boolean;
    conversationFileSummary?: ConversationFileInputSummary;
    wantsNativeResponsesReasoning?: boolean;
    wantsContinuationAwareResponses?: boolean;
  },
  hints?: EndpointDerivationHints,
): Promise<UpstreamEndpoint[]> {
  const sitePlatform = normalizePlatformName(context.site.platform);
  const endpointCapability = resolveUpstreamEndpointCapability({
    sitePlatform: context.site.platform,
    siteUrl: context.site.url,
    downstreamFormat,
    oauthProvider: hints?.oauthProvider,
  });
  if (hints?.requestKind === 'responses-compact') {
    return endpointCapability.supportedEndpoints.includes('responses')
      ? ['responses']
      : [];
  }
  if (
    hints?.requiresNativeResponsesFileUrl
    && sitePlatform !== 'claude'
    && sitePlatform !== 'anyrouter'
  ) {
    return endpointCapability.supportedEndpoints.includes('responses')
      ? ['responses']
      : [];
  }

  const capabilityProfile = buildEndpointCapabilityProfile({
    modelName,
    requestedModelHint,
    requestCapabilities,
  });
  const preferMessagesForClaudeModel = capabilityProfile.preferMessagesForClaudeModel;
  const hasNonImageFileInput = capabilityProfile.hasNonImageFileInput;
  const wantsNativeResponsesReasoning = capabilityProfile.wantsNativeResponsesReasoning;
  const wantsContinuationAwareResponses = capabilityProfile.wantsContinuationAwareResponses;
  const applyRuntimePreference = (candidates: UpstreamEndpoint[]) => (
    applyUpstreamEndpointRuntimePreference(candidates, {
      siteId: context.site.id,
      downstreamFormat,
      capabilityProfile,
    })
  );
  const finalizeCandidates = (candidates: UpstreamEndpoint[]): UpstreamEndpoint[] => {
    const preferredCandidates = applyRuntimePreference(candidates);
    if (hints?.requestKind === 'claude-count-tokens') {
      return preferredCandidates.includes('messages') ? ['messages'] : ([] as UpstreamEndpoint[]);
    }
    return preferredCandidates;
  };
  const conversationFileSummary = requestCapabilities?.conversationFileSummary ?? {
    hasImage: false,
    hasAudio: false,
    hasDocument: hasNonImageFileInput,
    hasRemoteDocumentUrl: false,
  };

  if (sitePlatform === 'anyrouter') {
    if (hasNonImageFileInput) {
      return finalizeCandidates(downstreamFormat === 'responses'
        ? ['responses', 'messages', 'chat']
        : ['messages', 'responses', 'chat']);
    }
    if (downstreamFormat === 'responses') {
      return finalizeCandidates(['responses', 'messages', 'chat']);
    }
    return finalizeCandidates(['messages', 'chat', 'responses']);
  }

  const preferred = preferredEndpointOrder(
    downstreamFormat,
    context.site.platform,
    context.site.url,
    preferMessagesForClaudeModel,
    hints,
  );
  const preferredWithCapabilities = hasNonImageFileInput
    ? (() => {
      if (sitePlatform === 'claude') return ['messages'] as UpstreamEndpoint[];
      if (sitePlatform === 'gemini') return ['chat'] as UpstreamEndpoint[];
      if (sitePlatform === 'gemini-cli') return ['chat'] as UpstreamEndpoint[];
      if (sitePlatform === 'antigravity') return ['chat'] as UpstreamEndpoint[];
      if (sitePlatform === 'openai') {
        const capability = resolveUpstreamEndpointCapability({
          sitePlatform: context.site.platform,
          siteUrl: context.site.url,
          downstreamFormat,
          preferMessagesForClaudeModel,
          oauthProvider: hints?.oauthProvider,
        });
        return [
          'responses',
          ...capability.supportedEndpoints.filter((endpoint) => endpoint !== 'responses'),
        ] as UpstreamEndpoint[];
      }
      return rankConversationFileEndpoints({
        sitePlatform,
        requestedOrder: preferMessagesForClaudeModel
          ? ['messages', 'responses', 'chat']
          : ['responses', 'messages', 'chat'],
        summary: conversationFileSummary,
        preferMessagesForClaudeModel,
      });
    })()
    : preferred;
  const prioritizedPreferredEndpoints: UpstreamEndpoint[] = (
    preferredWithCapabilities.includes('responses')
    && (
      wantsContinuationAwareResponses
      || (wantsNativeResponsesReasoning && preferMessagesForClaudeModel)
    )
  )
    ? [
      'responses',
      ...preferredWithCapabilities.filter((endpoint): endpoint is UpstreamEndpoint => endpoint !== 'responses'),
    ]
    : preferredWithCapabilities;
  const forceMessagesFirstForClaudeModel = (
    downstreamFormat === 'openai'
    && preferMessagesForClaudeModel
    && sitePlatform !== 'openai'
    && sitePlatform !== 'gemini'
    && sitePlatform !== 'antigravity'
    && sitePlatform !== 'gemini-cli'
  );

  try {
    const catalog = await fetchModelPricingCatalog({
      site: {
        id: context.site.id,
        url: context.site.url,
        platform: context.site.platform,
      },
      account: {
        id: context.account.id,
        accessToken: context.account.accessToken ?? null,
        apiToken: context.account.apiToken ?? null,
      },
      modelName,
      totalTokens: 0,
    });

    if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
      return finalizeCandidates(prioritizedPreferredEndpoints);
    }

    const matched = catalog.models.find((item) =>
      asTrimmedString(item?.modelName).toLowerCase() === modelName.toLowerCase(),
    );
    if (!matched) return finalizeCandidates(prioritizedPreferredEndpoints);

    const supportedRaw = Array.isArray(matched.supportedEndpointTypes) ? matched.supportedEndpointTypes : [];
    const normalizedEndpointTypes = supportedRaw.map((endpoint) => normalizeEndpointType(endpoint));
    const hasConcreteEndpointHint = normalizedEndpointTypes.some((item) => item.concrete);
    if (forceMessagesFirstForClaudeModel && !hasConcreteEndpointHint) {
      return finalizeCandidates(prioritizedPreferredEndpoints);
    }
    const shouldIgnoreCatalogOrderingForClaudeMessages = (
      preferMessagesForClaudeModel
      && (downstreamFormat !== 'responses' || sitePlatform !== 'openai')
    );
    if (shouldIgnoreCatalogOrderingForClaudeMessages && !hasConcreteEndpointHint) {
      return finalizeCandidates(prioritizedPreferredEndpoints);
    }

    const supported = new Set<UpstreamEndpoint>();
    for (const normalizedEndpointType of normalizedEndpointTypes) {
      for (const normalized of normalizedEndpointType.endpoints) {
        supported.add(normalized);
      }
    }

    if (supported.size === 0) {
      return finalizeCandidates(prioritizedPreferredEndpoints);
    }

    const supportedCandidates = prioritizedPreferredEndpoints.filter((endpoint) => (
      supported.has(endpoint)
    ));
    if (supportedCandidates.length > 0) {
      return finalizeCandidates(supportedCandidates);
    }

    return hasConcreteEndpointHint
      ? []
      : finalizeCandidates(prioritizedPreferredEndpoints);
  } catch {
    return finalizeCandidates(prioritizedPreferredEndpoints);
  }
}
