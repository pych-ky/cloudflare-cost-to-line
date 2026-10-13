import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getDailyMessage } from "../src/daily.ts";
import { pushMessage } from "../src/line.ts";

async function notify() {
  const template = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const env = {
    ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "",
    BILLING_API_TOKEN: process.env.BILLING_API_TOKEN?.trim() ?? "",
    TIME_ZONE: process.env.TIME_ZONE?.trim() || template.vars.TIME_ZONE,
    MONTHLY_FIXED_COST_USD: process.env.MONTHLY_FIXED_COST_USD?.trim() || template.vars.MONTHLY_FIXED_COST_USD,
  };
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  const recipient = process.env.LINE_RECIPIENT_ID?.trim();
  if (!token || !/^[UCR][a-f0-9]{32}$/i.test(recipient ?? "")) {
    throw new Error("LINE configuration is invalid");
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
      if (attempts === 2) throw new Error("Daily report could not be prepared");
      console.log("料金の取得・集計を再試行します。");
      await delay(60_000 * 2 ** attempts);
    }
  }
  const message = `【手動実行】${executionTime} (${env.TIME_ZONE})\n\n${text}`;
  const retryKey = crypto.randomUUID();
  for (let attempts = 0; attempts < 3; attempts++) {
    const result = await pushMessage(token, recipient, message, retryKey);
    if (result.kind === "accepted") {
      console.log("LINE が手動の料金通知を受理しました。金額・取得状態はLINEの本文を確認してください。");
      return;
    }
    if (result.kind === "failed" || attempts === 2) {
      console.error(`LINE の手動通知を完了できませんでした。HTTP ${result.status ?? "応答なし"}`);
      process.exitCode = 1;
      return;
    }
    console.log("LINE の送信を同じ Retry-Key で再試行します。");
    await delay(60_000 * 2 ** attempts);
  }
}

try {
  await notify();
} catch {
  console.error("手動通知の処理に失敗しました。production の設定を確認してください。");
  process.exitCode = 1;
}
