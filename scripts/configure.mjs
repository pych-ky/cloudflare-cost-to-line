// デプロイ設定の生成

import { writeFile } from "node:fs/promises";
import template from "../wrangler.json" with { type: "json" };
import { usdSetting } from "../src/config.ts";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const timeZone = process.env.TIME_ZONE?.trim() || template.vars.TIME_ZONE;
const fixedCost = process.env.MONTHLY_FIXED_COST_USD?.trim() || template.vars.MONTHLY_FIXED_COST_USD;

if (!/^[a-f\d]{32}$/i.test(accountId ?? "")) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID は32桁の16進数で指定してください。");
}
try {
  new Intl.DateTimeFormat("en", { timeZone });
} catch {
  throw new Error("TIME_ZONE は有効な IANA タイムゾーンを指定してください。");
}
usdSetting(fixedCost);

template.account_id = accountId;
template.name = process.env.WORKER_NAME?.trim() || template.name;
template.triggers.crons = [process.env.DAILY_CRON?.trim() || template.triggers.crons[0]];
Object.assign(template.vars, {
  ACCOUNT_ID: accountId,
  TIME_ZONE: timeZone,
  MONTHLY_FIXED_COST_USD: fixedCost,
});
await writeFile(
  new URL("../wrangler.generated.json", import.meta.url),
  `${JSON.stringify(template, null, 2)}\n`,
);
console.log("公開設定から wrangler.generated.json を生成しました。");
