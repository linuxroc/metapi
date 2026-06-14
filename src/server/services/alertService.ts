import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { sendNotification } from './notifyService.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { appendSessionTokenRebindHint } from './alertRules.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';

type TokenExpiredParams = {
  accountId: number;
  username?: string | null;
  siteName?: string | null;
  detail?: string;
};

type TokenExpiredAlert = {
  accountId: number;
  title: string;
  message: string;
  createdAt: string;
};

async function markTokenExpired(params: TokenExpiredParams): Promise<TokenExpiredAlert> {
  const accountLabel = params.username || `ID:${params.accountId}`;
  const siteLabel = params.siteName || 'unknown-site';
  const detailText = params.detail ? appendSessionTokenRebindHint(params.detail) : '';
  const detail = detailText ? ` (${detailText})` : '';
  const createdAt = formatUtcSqlDateTime(new Date());
  const title = 'Token 已失效';
  const message = `${accountLabel} @ ${siteLabel} 的 Token 无效或已过期${detail}`;

  await db.update(schema.accounts).set({
    status: 'expired',
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.accounts.id, params.accountId)).run();
  invalidateTokenRouterCache();

  await setAccountRuntimeHealth(params.accountId, {
    state: 'unhealthy',
    reason: detailText ? `访问令牌失效：${detailText}` : '访问令牌失效',
    source: 'auth',
  });

  return {
    accountId: params.accountId,
    title,
    message,
    createdAt,
  };
}

async function publishTokenExpiredAlert(alert: TokenExpiredAlert): Promise<void> {
  await db.insert(schema.events).values({
    type: 'token',
    title: alert.title,
    message: alert.message,
    level: 'error',
    relatedId: alert.accountId,
    relatedType: 'account',
    createdAt: alert.createdAt,
  }).run();

  await sendNotification(
    alert.title,
    alert.message,
    'error',
  );
}

export async function reportTokenExpired(
  params: TokenExpiredParams,
  options: { waitForAlert?: boolean } = {},
): Promise<void> {
  const alert = await markTokenExpired(params);
  const publish = publishTokenExpiredAlert(alert);
  if (options.waitForAlert === false) {
    void publish.catch((error) => {
      console.warn('[alertService] failed to publish token expiration alert', error);
    });
    return;
  }
  await publish;
}

async function publishProxyAllFailedAlert(params: {
  model: string;
  reason: string;
}): Promise<void> {
  const createdAt = formatUtcSqlDateTime(new Date());
  const title = '代理全部失败';
  const message = `模型=${params.model}, 原因=${params.reason}`;
  await db.insert(schema.events).values({
    type: 'proxy',
    title,
    message,
    level: 'error',
    relatedType: 'route',
    createdAt,
  }).run();

  await sendNotification(title, message, 'error');
}

export async function reportProxyAllFailed(params: {
  model: string;
  reason: string;
}): Promise<void> {
  void publishProxyAllFailedAlert(params).catch((error) => {
    console.warn('[alertService] failed to publish proxy failure notification', error);
  });
}
