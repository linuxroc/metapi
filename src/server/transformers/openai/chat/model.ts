import type {
  NormalizedFinalResponse,
  NormalizedStreamEvent,
  ParsedDownstreamChatRequest,
} from '../../shared/normalized.js';
import type { ProtocolRequestEnvelope } from '../../shared/protocolModel.js';

export type OpenAiChatAudioRequest = {
  format?: string;
  voice?: string;
  [key: string]: unknown;
};

export type OpenAiChatRequestMetadata = {
  modalities?: string[];
  audio?: OpenAiChatAudioRequest;
  reasoningEffort?: string;
  reasoningBudget?: number;
  reasoningSummary?: string;
  serviceTier?: string;
  topLogprobs?: number;
  logitBias?: Record<string, number>;
  promptCacheKey?: string;
  safetyIdentifier?: string;
  verbosity?: string;
  responseFormat?: unknown;
  streamOptionsIncludeUsage?: boolean | null;
};

export type OpenAiChatUsageDetails = {
  prompt_tokens_details?: Record<string, number>;
  completion_tokens_details?: Record<string, number>;
};

export type OpenAiChatParsedRequest = ParsedDownstreamChatRequest;
export type OpenAiChatRequestEnvelope = ProtocolRequestEnvelope<
  'openai/chat',
  OpenAiChatParsedRequest,
  OpenAiChatRequestMetadata
>;

export type OpenAiChatToolCall = {
  id: string;
  name: string;
  arguments: string;
  thoughtSignature?: string;
};

export type OpenAiChatChoice = {
  index: number;
  role?: 'assistant';
  content: string;
  reasoningContent: string;
  reasoningSignature?: string;
  toolCalls: OpenAiChatToolCall[];
  finishReason: string;
  annotations?: Array<Record<string, unknown>>;
  citations?: string[];
};

export type OpenAiChatNormalizedFinalResponse = NormalizedFinalResponse & {
  choices?: OpenAiChatChoice[];
  annotations?: Array<Record<string, unknown>>;
  citations?: string[];
  usageDetails?: OpenAiChatUsageDetails;
  usagePayload?: Record<string, unknown>;
};

export type OpenAiChatChoiceDelta = {
  index: number;
  role?: 'assistant';
  contentDelta?: string;
  reasoningDelta?: string;
  reasoningSignature?: string;
  toolCallDeltas?: Array<{
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
    thoughtSignature?: string;
  }>;
  finishReason?: string | null;
  annotations?: Array<Record<string, unknown>>;
  citations?: string[];
};

export type OpenAiChatNormalizedStreamEvent = NormalizedStreamEvent & {
  choiceIndex?: number;
  choiceEvents?: OpenAiChatChoiceDelta[];
  annotations?: Array<Record<string, unknown>>;
  citations?: string[];
  usageDetails?: OpenAiChatUsageDetails;
  usagePayload?: Record<string, unknown>;
};
