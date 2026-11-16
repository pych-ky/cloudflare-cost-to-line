// 設定の型・固定費の検証・現地日付

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

// 固定費の検証・数値化
export function usdSetting(value: string): number {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) {
    throw new Error('MONTHLY_FIXED_COST_USD は小数2桁までの非負のドル額を指定してください。');
  }
  return Number(value);
}

// 現地の年月日を返す
export function localDate(timestamp: number, timeZone: string): string {
  const date = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(timestamp).map(/* 日付要素の対応付け */ ({ type, value }) => [type, value]));
  return `${date.year}-${date.month}-${date.day}`;
}
