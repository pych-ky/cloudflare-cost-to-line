import type { NotificationStore } from './notifications.ts';

export interface Env {
  ACCOUNT_ID: string;
  BILLING_API_TOKEN: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_RECIPIENT_ID: string;
  TIME_ZONE: string;
  MONTHLY_FIXED_COST_USD: string;
  NOTIFICATIONS: DurableObjectNamespace<NotificationStore>;
}

export function billingOptions(env: Pick<Env, 'ACCOUNT_ID' | 'BILLING_API_TOKEN'>) {
  if (!/^[a-f0-9]{32}$/i.test(env.ACCOUNT_ID) || !env.BILLING_API_TOKEN) {
    throw new Error('Cloudflare の料金参照設定が不足しています。');
  }
  return { accountId: env.ACCOUNT_ID, apiToken: env.BILLING_API_TOKEN };
}

export function usdSetting(value: string, name: string): number {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) {
    throw new Error(`${name} は小数2桁までの非負のドル額を指定してください。`);
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(Math.round(amount * 100))) {
    throw new Error(`${name} が大きすぎます。`);
  }
  return amount;
}

export function localDate(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(timestamp);
  const part = (type: string) => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
