export function isCloudflareChallenge(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return text.includes('cloudflare') || text.includes('cf challenge') || text.includes('challenge required');
}

const SESSION_TOKEN_REBIND_HINT = '请在中转站重新生成系统访问令牌后重新绑定账号';

function isEndpointDispatchDeniedMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i.test(message)
    || text.includes('dispatch denied')
  );
}

function containsHttpStatus(message: string | null | undefined, status: number): boolean {
  if (!message) return false;
  return new RegExp(`(?:^|\\b)(?:http\\s*)?${status}(?:\\b|:)`, 'i').test(message);
}

export function isTokenExpiredError(input: { status?: number; message?: string | null }): boolean {
  const rawMessage = input.message || '';
  if (isEndpointDispatchDeniedMessage(rawMessage)) return false;
  if (input.status === 401 || containsHttpStatus(rawMessage, 401)) return true;
  return isExplicitTokenExpiredError(rawMessage);
}

export function isExplicitTokenExpiredError(message?: string | null): boolean {
  const rawMessage = message || '';
  const text = rawMessage.toLowerCase();
  if (isEndpointDispatchDeniedMessage(rawMessage) || !text) return false;

  // NewAPI-like sites may return this when session context is missing for an action,
  // which does not always mean the account token is expired.
  if (text.includes('未登录且未提供 access token')) return false;

  const tokenPhrase = text.includes('token') || text.includes('令牌') || text.includes('访问令牌');
  const apiKeyPhrase = (
    text.includes('api key')
    || text.includes('api_key')
    || text.includes('apikey')
    || text.includes('密钥')
  );
  const hasInvalid = text.includes('invalid') || text.includes('无效');
  const hasExpired = text.includes('expired') || text.includes('过期');
  const hasRevoked = text.includes('revoked') || text.includes('撤销') || text.includes('吊销');

  return (
    text.includes('jwt expired') ||
    text.includes('token expired') ||
    (tokenPhrase && (hasInvalid || hasExpired)) ||
    (apiKeyPhrase && (hasInvalid || hasExpired || hasRevoked)) ||
    /incorrect\s+api[_\s-]?key/.test(text) ||
    /invalid\s+access\s+token/.test(text) ||
    /access\s+token\s+is\s+invalid/.test(text)
  );
}

export function isExplicitTokenExpirationResponse(input: {
  status?: number;
  message?: string | null;
}): boolean {
  if (
    input.status !== 400
    && input.status !== 401
    && input.status !== 403
  ) {
    return false;
  }
  return isExplicitTokenExpiredError(input.message);
}

export function appendSessionTokenRebindHint(message?: string | null): string {
  const raw = String(message || '').trim();
  if (!raw) return raw;
  if (raw.includes(SESSION_TOKEN_REBIND_HINT)) return raw;

  const text = raw.toLowerCase();
  const looksLikeInvalidAccessToken = (
    raw.includes('无权进行此操作，access token 无效') ||
    /invalid\s+access\s+token/.test(text) ||
    /access\s+token\s+is\s+invalid/.test(text) ||
    /access\s+token.*无效/.test(raw)
  );
  if (!looksLikeInvalidAccessToken) return raw;

  return `${raw}，${SESSION_TOKEN_REBIND_HINT}`;
}
