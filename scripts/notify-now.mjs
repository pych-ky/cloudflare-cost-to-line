// 料金の手動通知

import template from "../wrangler.json" with { type: "json" };
import { setTimeout as delay } from "node:timers/promises";
import { getDailyMessage } from "../src/billing.ts";
import { pushMessage } from "../src/line.ts";

try {
  const env = {
    ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "",
    BILLING_API_TOKEN: process.env.BILLING_API_TOKEN?.trim() ?? "",
    TIME_ZONE: process.env.TIME_ZONE?.trim() || template.vars.TIME_ZONE,
    MONTHLY_FIXED_COST_USD: process.env.MONTHLY_FIXED_COST_USD?.trim() || template.vars.MONTHLY_FIXED_COST_USD,
  };
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  const recipient = process.env.LINE_RECIPIENT_ID?.trim();
  if (!token || !/^[UCR][a-f0-9]{32}$/i.test(recipient ?? "")) {
    console.error(!token ? "LINE_CHANNEL_ACCESS_TOKEN が設定されていません。" : "LINE_RECIPIENT_ID の形式が不正です。");
    throw new Error();
  }
  const now = Date.now();
  const executionTime = new Intl.DateTimeFormat("ja-JP", {
    timeZone: env.TIME_ZONE, dateStyle: "short", timeStyle: "short",
  }).format(now);
  let text;
  for (let attempts = 0; attempts < 3; attempts++) {
    try {
      text = await getDailyMessage(env, now, attempts);
      break;
    } catch {
      if (attempts === 2) throw new Error();
      console.log("料金の取得・集計を再試行します。");
      await delay(60_000 * 2 ** attempts);
    }
  }
  const message = `【手動実行】${executionTime} (${env.TIME_ZONE})\n\n${text}`;
  const retryKey = crypto.randomUUID();
  for (let attempts = 0; attempts < 3; attempts++) {
    const result = await pushMessage(token, recipient, message, retryKey);
    if (result.kind === "accepted") {
      console.log("LINE が手動通知を受理しました。");
      break;
    }
    if (result.kind === "failed" || attempts === 2) {
      console.error(`LINE 送信失敗: HTTP ${result.status ?? "応答なし"}`);
      process.exitCode = 1;
      break;
    }
    console.log("LINE の送信を同じ Retry-Key で再試行します。");
    await delay(60_000 * 2 ** attempts);
  }
} catch {
  console.error("手動通知失敗: production の設定を確認してください。");
  process.exitCode = 1;
}
