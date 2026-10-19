import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const [configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath || process.argv.length !== 4) {
  throw new Error("Usage: node scripts/capture-deployment.mjs <config.json> <output.json>");
}
const { account_id: accountId, name: workerName } = JSON.parse(await readFile(configPath, "utf8"));
if (!/^[a-f\d]{32}$/i.test(accountId ?? "") || !/^[a-z\d]+(?:-[a-z\d]+)*$/.test(workerName ?? "")) {
  throw new Error("記録対象のアカウントID・Worker名が不正です。");
}

let deployments;
try {
  const output = execFileSync(process.execPath, [
    fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
    "deployments", "list", "--json", "--config", configPath,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  deployments = JSON.parse(output);
} catch (error) {
  if (!/\[code: 10007\]/.test(error.stderr?.toString() ?? "")) {
    throw new Error("稼働版の取得に失敗しました。認証・権限・対象Workerを確認してください。");
  }
  deployments = [];
}
if (!Array.isArray(deployments) || deployments.some(item => !Number.isFinite(Date.parse(item?.created_on)))) {
  throw new Error("deployment一覧の形式が不正です。");
}

// Select the active deployment by creation time, regardless of Wrangler's list order.
const latest = deployments.sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
let deployment = null;
if (latest) {
  const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
  if (!uuid.test(latest.id) || !Array.isArray(latest.versions) || latest.versions.length === 0 ||
      latest.versions.some(item => !uuid.test(item?.version_id) || !Number.isFinite(item.percentage) ||
        item.percentage < 0 || item.percentage > 100) ||
      Math.abs(latest.versions.reduce((sum, item) => sum + item.percentage, 0) - 100) > 1e-6) {
    throw new Error("稼働deploymentのID・version・traffic配分が不正です。");
  }
  deployment = {
    id: latest.id,
    created_on: latest.created_on,
    versions: latest.versions.map(({ version_id, percentage }) => ({ version_id, percentage })),
  };
}
await writeFile(outputPath, `${JSON.stringify({
  worker_name: workerName,
  captured_at: new Date().toISOString(),
  deployment,
}, null, 2)}\n`);
console.log(deployment ? "デプロイ前の稼働版を記録しました。" : "初回デプロイのため復旧先はありません。");
