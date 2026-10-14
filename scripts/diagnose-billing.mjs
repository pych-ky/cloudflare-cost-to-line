const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const token = process.env.BILLING_API_TOKEN?.trim();
if (!/^[a-f0-9]{32}$/i.test(accountId ?? "") || !token) {
  console.error("Billing configuration is invalid");
  process.exit(1);
}

const now = new Date();
const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const query = new URLSearchParams({
  from: from.toISOString().slice(0, 10),
  to: now.toISOString().slice(0, 10),
});
const probes = [
  { name: "coverage", path: "/billable-usage/info" },
  { name: "subscriptions", path: "/subscriptions" },
  { name: "v1-usage", path: `/billable-usage?${query}` },
  { name: "v2-usage", path: `/billable/usage?${query}` },
  { name: "v2-metrics", path: "/billable/usage/billable-metrics" },
];
if (to > from) {
  probes.push({
    name: "v2-cost",
    path: "/billable/usage",
    body: { Metric: "cost", TimePeriod: { From: from.toISOString(), To: to.toISOString() } },
  });
}

for (const probe of probes) {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${probe.path}`, {
      method: probe.body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(probe.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(probe.body ? { body: JSON.stringify(probe.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    const rows = Array.isArray(body.result) ? body.result : null;
    // 公開ログには識別子・契約名・金額・応答本文を含めない。
    console.log(JSON.stringify({
      probe: probe.name,
      httpStatus: response.status,
      success: body.success === true,
      errorCodes: Array.isArray(body.errors)
        ? body.errors.flatMap((error) => typeof error?.code === "number" ? [error.code] : []) : [],
      ...(probe.name === "coverage" ? {
        covered: typeof body.result?.covered === "boolean" ? body.result.covered : null,
        subscriptionCount: Array.isArray(body.result?.subscriptions) ? body.result.subscriptions.length : null,
      } : {}),
      ...(rows ? { rowCount: rows.length } : {}),
      ...(rows && ["v1-usage", "v2-usage", "v2-cost"].includes(probe.name) ? {
        usdRows: rows.filter((row) => row?.BillingCurrency === "USD").length,
        costFields: Object.fromEntries(["BilledCost", "ContractedCost", "EffectiveCost"].map((field) => [
          field, rows.filter((row) => typeof row?.[field] === "number" && Number.isFinite(row[field])).length,
        ])),
        dailyRows: rows.filter((row) => {
          const start = Date.parse(row?.ChargePeriodStart);
          const end = Date.parse(row?.ChargePeriodEnd);
          return start >= from.getTime() && end <= to.getTime()
            && start % 86_400_000 === 0 && end - start === 86_400_000;
        }).length,
      } : {}),
    }));
  } catch {
    console.log(JSON.stringify({ probe: probe.name, responseUnreadable: true }));
  }
}
