// Dashboard設定取得APIのHTTPステータスだけを確認

import { readFile } from "node:fs/promises";

const { account_id: accountId, name: workerName } = JSON.parse(
  await readFile("wrangler.generated.json", "utf8"),
);
if (!/^[a-f\d]{32}$/i.test(accountId ?? "") || !/^[a-z\d]+(?:-[a-z\d]+)*$/.test(workerName ?? "")) {
  throw new Error("診断対象のアカウントID・Worker名が不正です。");
}
if (!process.env.CLOUDFLARE_API_TOKEN?.trim()) {
  throw new Error("CLOUDFLARE_API_TOKEN が設定されていません。");
}

const environment = `services/${workerName}/environments/production`;
for (const [label, path] of [
  ["bindings", `${environment}/bindings`],
  ["routes", `${environment}/routes?show_zonename=true`],
  ["custom domains", `domains/records?page=0&per_page=5&service=${workerName}&environment=production`],
  ["subdomain", `${environment}/subdomain`],
  ["environment", environment],
  ["schedules", `scripts/${workerName}/schedules`],
]) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/${path}`, {
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`${label}: HTTP ${response.status}`);
    await response.body?.cancel();
  } catch {
    console.log(`${label}: request failed`);
  }
}
