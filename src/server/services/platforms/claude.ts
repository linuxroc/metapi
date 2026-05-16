import {
  StandardApiProviderAdapterBase,
  isAnthropicSuffixedBaseUrl,
  stripAnthropicSuffixSegment,
} from './standardApiProvider.js';
import { CLAUDE_DEFAULT_ANTHROPIC_VERSION } from '../oauth/claudeProvider.js';

type FetchModelsOptions = Parameters<
  StandardApiProviderAdapterBase['fetchModelsFromStandardEndpoint']
>[0];

export class ClaudeAdapter extends StandardApiProviderAdapterBase {
  readonly platformName = 'claude';

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('api.anthropic.com') || normalized.includes('anthropic.com/v1');
  }

  async getModels(baseUrl: string, apiToken: string): Promise<string[]> {
    // 1. Standard discovery: x-api-key + anthropic-version. Identical to the
    //    pre-fallback behavior. If the standard endpoint returns a non-empty
    //    list we return immediately and never touch the fallback endpoint.
    const standardModels = await this.tryFetchModels({
      baseUrl,
      headers: {
        'x-api-key': apiToken,
        'anthropic-version': CLAUDE_DEFAULT_ANTHROPIC_VERSION,
      },
    });
    if (standardModels.length > 0) {
      return standardModels;
    }

    // 2. Restricted fallback: only when the configured base URL is an
    //    Anthropic_Suffixed_URL (its path ends with a literal `/anthropic`
    //    segment, case-insensitive). For any other shape — including
    //    `https://api.anthropic.com` (host-only) or `/anthropic-proxy`
    //    (last segment merely starts with `anthropic`) — return the empty
    //    standard result without firing a second request.
    const parentBaseUrl = stripAnthropicSuffixSegment(baseUrl);
    if (parentBaseUrl == null) {
      return standardModels;
    }

    // 3. Fallback discovery: OpenAI-compatible `/v1/models` on the parent
    //    base URL. Carries `Authorization: Bearer <apiToken>` only — no
    //    `x-api-key`, no `anthropic-version`. Reuses
    //    `fetchModelsFromStandardEndpoint` so site proxy, timeout, and
    //    `data[].id` parsing all flow through the same stack as the
    //    standard call.
    const fallbackTargetUrl = `${parentBaseUrl}/v1/models`;
    this.logFallbackIntent(baseUrl, fallbackTargetUrl);

    const fallbackModels = await this.tryFetchModels({
      baseUrl: parentBaseUrl,
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    // 4. On a non-empty fallback hit, log once with the source marker so
    //    operators can distinguish a parent-derived list from a native
    //    Claude one. On empty/failed fallback, return [] silently — the
    //    intent log already records that we tried.
    if (fallbackModels.length > 0) {
      this.logFallbackHit(baseUrl, fallbackModels.length);
    }

    return fallbackModels;
  }

  /**
   * Wraps `fetchModelsFromStandardEndpoint` so that any underlying error
   * (HTTP non-2xx, network/DNS/TLS failure, unparseable payload) is
   * absorbed and rendered as `[]`. This is what lets `getModels` honor
   * R3.4 / R5.2 — the caller never sees an exception originating from
   * either the standard or the fallback call.
   */
  private async tryFetchModels(options: FetchModelsOptions): Promise<string[]> {
    try {
      return await this.fetchModelsFromStandardEndpoint(options);
    } catch {
      return [];
    }
  }

  private logFallbackIntent(siteBaseUrl: string, fallbackUrl: string): void {
    console.info('[claude-models-fallback] intent', {
      site: deriveSiteLogLabel(siteBaseUrl),
      target: fallbackUrl,
    });
  }

  private logFallbackHit(siteBaseUrl: string, modelCount: number): void {
    console.info('[claude-models-fallback] hit', {
      site: deriveSiteLogLabel(siteBaseUrl),
      source: 'parent_v1_models',
      count: modelCount,
    });
  }
}

/**
 * Render a stable, token-free label for log output. Parses the site base
 * URL and emits `${host}${pathname-without-trailing-slash}` so we never
 * leak the protocol+credentials portion of the URL string. On parse
 * failure we fall back to the raw input — but `apiToken` is never part of
 * the input here, so there is nothing token-shaped to leak.
 */
function deriveSiteLogLabel(siteBaseUrl: string): string {
  try {
    const parsed = new URL(siteBaseUrl);
    const path = parsed.pathname.replace(/\/$/, '');
    return `${parsed.host}${path}`;
  } catch {
    return siteBaseUrl;
  }
}
