// 本番の稼働版と公開設定の照合

import { appendFile, readFile, writeFile } from "node:fs/promises";

const [configPath, wranglerOutputPath, outputPath] = process.argv.slice(2);
if (!configPath || !wranglerOutputPath || !outputPath || process.argv.length !== 5) {
  throw new Error("Usage: node scripts/verify-deployment.mjs <config.json> <wrangler.ndjson> <output.json>");
}
const config = JSON.parse(await readFile(configPath, "utf8"));
const { account_id: accountId, name: workerName } = config;
if (!/^[a-f\d]{32}$/i.test(accountId ?? "") || !/^[a-z\d]+(?:-[a-z\d]+)*$/.test(workerName ?? "")) {
  throw new Error("確認対象のアカウントID・Worker名が不正です。");
}
if (!process.env.CLOUDFLARE_API_TOKEN?.trim() || !/^[a-f\d]{40}$/i.test(process.env.GITHUB_SHA ?? "")) {
  throw new Error("CLOUDFLARE_API_TOKEN・GITHUB_SHA が設定されていません。");
}
let records;
try {
  records = (await readFile(wranglerOutputPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
} catch {
  throw new Error("Wrangler のデプロイ結果を読み取れません。");
}
const deployed = records.filter(record => record.type === "deploy");
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
if (deployed.length !== 1 || deployed[0].version !== 1 || deployed[0].worker_name !== workerName ||
    !uuid.test(deployed[0].version_id ?? "")) {
  throw new Error("Wrangler のデプロイ結果が不正です。");
}
const versionId = deployed[0].version_id;
const record = {
  worker_name: workerName,
  commit_sha: process.env.GITHUB_SHA,
  version_id: versionId,
  status: "verification_failed",
};
// 照合に失敗してもアップロード済みの版を残す
await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`);

// 応答本文や認証情報をエラーに含めない
async function get(path) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/${path}`, {
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error();
    const body = await response.json();
    if (body.success !== true) throw new Error();
    return body.result;
  } catch {
    throw new Error(`本番の ${path} の取得に失敗しました。`);
  }
}

const { deployments } = await get("deployments");
if (!Array.isArray(deployments) || deployments.some(item => !Number.isFinite(Date.parse(item?.created_on)))) {
  throw new Error("本番の deployment 一覧が不正です。");
}
const latest = deployments[0];
if (!uuid.test(latest?.id ?? "") || latest.versions?.length !== 1 ||
    latest.versions[0].version_id !== versionId || latest.versions[0].percentage !== 100) {
  throw new Error("今回のバージョンが本番の100%を担っていません。");
}

const settings = await get("settings");
const bindings = settings.bindings;
if (!Array.isArray(bindings)) throw new Error("本番の bindings が不正です。");
for (const [name, value] of Object.entries(config.vars)) {
  const matches = bindings.filter(binding => binding.name === name);
  if (matches.length !== 1 || matches[0].type !== "plain_text" || matches[0].text !== value) {
    throw new Error(`本番の Variable ${name} が設定と一致しません。`);
  }
}
for (const { name, class_name: className } of config.durable_objects.bindings) {
  const matches = bindings.filter(binding => binding.name === name);
  if (matches.length !== 1 || matches[0].type !== "durable_object_namespace" ||
      (matches[0].class_name !== undefined && matches[0].class_name !== className)) {
    throw new Error(`本番の Durable Object binding ${name} が設定と一致しません。`);
  }
}
for (const name of ["BILLING_API_TOKEN", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_RECIPIENT_ID"]) {
  if (bindings.filter(binding => binding.name === name && binding.type === "secret_text").length !== 1) {
    throw new Error(`本番の Secret ${name} がありません。`);
  }
}
if (settings.compatibility_date !== config.compatibility_date ||
    JSON.stringify([...(settings.compatibility_flags ?? [])].sort()) !==
      JSON.stringify([...(config.compatibility_flags ?? [])].sort())) {
  throw new Error("本番の互換性設定が一致しません。");
}

const schedules = await get("schedules");
const crons = schedules.schedules?.map(schedule => schedule.cron).sort();
if (JSON.stringify(crons) !== JSON.stringify([...config.triggers.crons].sort())) {
  throw new Error("本番の Cron が設定と一致しません。");
}
await writeFile(outputPath, `${JSON.stringify({
  ...record,
  status: "verified",
  verified_at: new Date().toISOString(),
  deployment_id: latest.id,
  percentage: 100,
  crons,
  checks: ["version", "variables", "durable_object_bindings", "secret_names", "compatibility", "crons"],
}, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, [
    `本番反映を確認しました: \`${workerName}\``,
    "",
    `- Commit: \`${process.env.GITHUB_SHA}\``,
    `- Version: \`${versionId}\`（100%）`,
    "- Cron・Variables・Durable Object binding・Secrets名・互換性設定: 照合済み",
    "- 課金APIの取得・LINE配信の成否はこの確認に含みません。",
    "",
  ].join("\n"));
}
console.log("本番の稼働版・Cron・設定を確認しました。");
