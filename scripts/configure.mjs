import { writeFile } from "node:fs/promises";
import template from "../wrangler.json" with { type: "json" };
import { usdSetting } from "../src/config.ts";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const workerName = process.env.WORKER_NAME?.trim() || template.name;
const timeZone = process.env.TIME_ZONE?.trim() || template.vars.TIME_ZONE;
const dailyCron = process.env.DAILY_CRON?.trim() || template.triggers.crons[0];
const fixedCost = process.env.MONTHLY_FIXED_COST_USD?.trim() || template.vars.MONTHLY_FIXED_COST_USD;

if (!accountId || !/^[a-f\d]{32}$/i.test(accountId)) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.");
}
if (workerName.length > 63 || !/^[a-z\d]+(?:-[a-z\d]+)*$/.test(workerName)) {
  throw new Error("WORKER_NAME must contain lowercase letters, numbers, and hyphens, up to 63 characters.");
}
try {
  new Intl.DateTimeFormat("en", { timeZone });
} catch {
  throw new Error("TIME_ZONE must be a valid IANA time zone.");
}
// Workers uses UTC; limit this bot's schedule to one execution per day.
if (!/^(?:[0-5]?\d) (?:[01]?\d|2[0-3]) \* \* \*$/.test(dailyCron)) {
  throw new Error("DAILY_CRON must use the daily UTC format 'minute hour * * *'.");
}
usdSetting(fixedCost, "MONTHLY_FIXED_COST_USD");

template.account_id = accountId;
template.name = workerName;
template.triggers.crons = [dailyCron];
template.vars = {
  ...template.vars,
  ACCOUNT_ID: accountId,
  TIME_ZONE: timeZone,
  MONTHLY_FIXED_COST_USD: fixedCost,
};
await writeFile(
  new URL("../wrangler.generated.json", import.meta.url),
  `${JSON.stringify(template, null, 2)}\n`,
);
console.log("Generated wrangler.generated.json from non-secret configuration.");
