// 設定検証と現地日付

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

// 料金API設定の検証
export function billingOptions(env: Pick<Env, 'ACCOUNT_ID' | 'BILLING_API_TOKEN'>) {
  if (!/^[a-f0-9]{32}$/i.test(env.ACCOUNT_ID) || !env.BILLING_API_TOKEN) {
    throw new Error('Cloudflare の料金参照設定が不足しています。');
  }
  return { accountId: env.ACCOUNT_ID, apiToken: env.BILLING_API_TOKEN };
}

// 固定費の検証・数値化
export function usdSetting(value: string): number {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) {
    throw new Error('MONTHLY_FIXED_COST_USD は小数2桁までの非負のドル額を指定してください。');
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(Math.round(amount * 100))) {
    throw new Error('MONTHLY_FIXED_COST_USD が大きすぎます。');
  }
  return amount;
}

// 現地の年月日を返す
export function localDate(timestamp: number, timeZone: string): string {
  const date = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(timestamp).map(/* 日付要素の対応付け */ ({ type, value }) => [type, value]));
  return `${date.year}-${date.month}-${date.day}`;
}
