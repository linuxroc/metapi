import { isExplicitTokenExpirationResponse } from './alertRules.js';
import { reportTokenExpired } from './alertService.js';

type ProxyTokenExpirationInput = {
  status: number;
  errorText: string;
  accountId: number;
  username?: string | null;
  siteName?: string | null;
  warningScope: string;
};

export async function reportExplicitProxyTokenExpiration(
  input: ProxyTokenExpirationInput,
): Promise<boolean> {
  if (!isExplicitTokenExpirationResponse({
    status: input.status,
    message: input.errorText,
  })) {
    return false;
  }

  try {
    await reportTokenExpired({
      accountId: input.accountId,
      username: input.username,
      siteName: input.siteName,
      detail: `HTTP ${input.status}`,
    }, {
      waitForAlert: false,
    });
  } catch (error) {
    console.warn(`[proxy/${input.warningScope}] failed to report token expired`, error);
    return false;
  }

  return true;
}
