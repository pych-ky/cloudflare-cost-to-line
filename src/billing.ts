import { forecastMonthlyCost, type DailyCost } from "./forecast.ts";

const DAY_MS = 86_400_000;

export interface BillingOptions {
  accountId: string;
  apiToken: string;
}

export interface MonthlyReport {
  message: string;
  period: string;
}

export interface CurrentSpend {
  amountUsd: number;
  periodKey: string;
  label: string;
  dataThrough: string;
}

interface Subscription {
  id: string;
  anchor: number;
  start: number;
  end: number | null;
}

interface UsageRow {
  amountUsd: number;
  start: number;
  end: number;
  billingStart: number;
  subscriptionId: string | null;
  seriesKey: string;
}

export class BillingError extends Error {
  readonly kind: "not-covered" | "unsupported" | "unavailable";

  constructor(message: string, kind: BillingError["kind"] = "unavailable") {
    super(message);
    this.name = "BillingError";
    this.kind = kind;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BillingError("Cloudflare 料金 API の応答形式が未対応です。", "unsupported");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BillingError("Cloudflare 料金 API に必要な項目がありません。");
  }
  return value;
}

function timestamp(value: unknown): number {
  const text = string(value);
  const parsed = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(parsed)) {
    throw new BillingError("Cloudflare 料金 API の日付形式が未対応です。", "unsupported");
  }
  return parsed;
}

async function request(options: BillingOptions, path: string): Promise<Record<string, unknown>> {
  if (!/^[a-f\d]{32}$/i.test(options.accountId) || !options.apiToken) {
    throw new BillingError("Cloudflare のアカウント ID または料金参照トークンが未設定です。");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}${path}`, {
      headers: { Authorization: `Bearer ${options.apiToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new BillingError(`Cloudflare 料金 API が HTTP ${response.status} を返しました。`);
    }
    const envelope = object(await response.json());
    if (envelope.success !== true) {
      throw new BillingError("Cloudflare 料金 API の取得に失敗しました。");
    }
    return envelope;
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError("Cloudflare 料金 API の通信または応答の読み取りに失敗しました。");
  } finally {
    clearTimeout(timeout);
  }
}

function isEmptyList(envelope: Record<string, unknown>): boolean {
  if (!Array.isArray(envelope.result)) {
    throw new BillingError("Cloudflare の契約・料金明細一覧の形式が未対応です。", "unsupported");
  }
  if (envelope.result.length > 0) return false;
  if (envelope.result_info === undefined) return true;
  const page = object(envelope.result_info);
  // 空のページでも、別ページや未取得の項目があれば不存在とは判定しない。
  return (page.count === undefined || page.count === 0)
    && (page.total_count === undefined || page.total_count === 0)
    && (page.total_pages === undefined || page.total_pages === 0 || page.total_pages === 1)
    && (page.page === undefined || page.page === 1);
}

async function getSubscriptions(options: BillingOptions): Promise<Subscription[] | null> {
  const info = object((await request(options, "/billable-usage/info")).result);
  if (typeof info.covered !== "boolean") {
    throw new BillingError("Cloudflare 料金 API の対象判定を読み取れません。", "unsupported");
  }
  if (!Array.isArray(info.subscriptions)) {
    throw new BillingError("Cloudflare の契約情報の形式が未対応です。", "unsupported");
  }
  if (!info.covered) {
    if (info.subscriptions.length === 0) return null;
    throw new BillingError("このアカウントは Cloudflare 料金 API の対象外です。", "not-covered");
  }
  const subscriptions = info.subscriptions.map((value: unknown) => {
    const item = object(value);
    const subscription: Subscription = {
      id: string(item.id),
      anchor: timestamp(item.billing_cycle_anchor_timestamp),
      start: timestamp(item.start_timestamp),
      end: item.end_timestamp == null ? null : timestamp(item.end_timestamp),
    };
    if (subscription.end !== null && subscription.end < subscription.start) {
      throw new BillingError("Cloudflare の契約期間が不正です。");
    }
    return subscription;
  });
  if (new Set(subscriptions.map((subscription) => subscription.id)).size !== subscriptions.length) {
    throw new BillingError("Cloudflare の契約情報が重複しています。");
  }
  return subscriptions;
}

async function getUsage(options: BillingOptions, subscriptions: readonly Subscription[], suffix = ""): Promise<UsageRow[]> {
  const result = (await request(options, `/billable-usage${suffix}`)).result;
  if (!Array.isArray(result)) {
    throw new BillingError("Cloudflare の料金明細の形式が未対応です。", "unsupported");
  }
  const ids = new Set(subscriptions.map((subscription) => subscription.id));
  const seen = new Set<string>();
  return result.map((value: unknown) => {
    const item = object(value);
    if (item.BillingCurrency !== "USD" || item.ChargeCategory !== "Usage") {
      throw new BillingError("USD の従量料金以外の明細には対応していません。", "unsupported");
    }
    if (typeof item.ContractedCost !== "number" || !Number.isFinite(item.ContractedCost) || item.ContractedCost < 0) {
      throw new BillingError("Cloudflare の料金明細の金額が不正です。");
    }
    const subscriptionId = item.SubscriptionId == null
      ? subscriptions.length === 1 ? subscriptions[0]!.id : null
      : string(item.SubscriptionId);
    if (subscriptionId !== null && !ids.has(subscriptionId)) {
      throw new BillingError("Cloudflare の料金明細を契約に対応付けられません。");
    }
    const start = timestamp(item.ChargePeriodStart);
    const end = timestamp(item.ChargePeriodEnd);
    const billingStart = timestamp(item.BillingPeriodStart);
    if (start % DAY_MS !== 0 || end - start !== DAY_MS || billingStart >= end) {
      throw new BillingError("UTC の日次料金以外の明細には対応していません。", "unsupported");
    }
    const seriesKey = JSON.stringify([
      subscriptionId, string(item.ServiceName), item.ZoneId ?? "",
      item.ConsumedUnit ?? "", item.PricingUnit ?? "", item.ChargeDescription ?? "",
    ]);
    const rowKey = JSON.stringify([seriesKey, start, billingStart]);
    if (seen.has(rowKey)) {
      throw new BillingError("Cloudflare の料金明細が重複しています。");
    }
    seen.add(rowKey);
    return { amountUsd: item.ContractedCost, start, end, billingStart, subscriptionId, seriesKey };
  });
}

function dailyCosts(rows: readonly UsageRow[], subscriptions: readonly Subscription[]): DailyCost[] {
  const series = new Map<string, string | null>();
  const days = new Map<number, Map<string, number>>();
  for (const row of rows) {
    series.set(row.seriesKey, row.subscriptionId);
    const costs = days.get(row.start) ?? new Map<string, number>();
    costs.set(row.seriesKey, (costs.get(row.seriesKey) ?? 0) + row.amountUsd);
    days.set(row.start, costs);
  }
  return [...days].map(([date, costs]) => {
    const active = new Set(subscriptions.filter((subscription) => (
      subscription.start < date + DAY_MS && (subscription.end === null || subscription.end >= date)
    )).map((subscription) => subscription.id));
    const represented = new Set([...costs.keys()].map((key) => series.get(key)));
    const complete = [...active].every((id) => represented.has(id))
      && [...series].every(([key, id]) => id === null ? costs.has(key) : !active.has(id) || costs.has(key));
    return {
      date: new Date(date).toISOString().slice(0, 10),
      amountUsd: [...costs.values()].reduce((sum, amount) => sum + amount, 0),
      complete,
    };
  });
}

function usd(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) throw new BillingError("Cloudflare の料金合計が不正です。");
  if (amount > 0 && amount < 0.01) return "$0.01 USD 未満";
  return `$${amount.toFixed(2)} USD`;
}

export async function getMonthlyReport(
  options: BillingOptions,
  now: Date,
  timeZone: string,
  fixedMonthlyCostUsd: number,
): Promise<MonthlyReport> {
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(fixedMonthlyCostUsd) || fixedMonthlyCostUsd < 0) {
    throw new BillingError("日次通知の日付または固定費設定が不正です。");
  }
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const subscriptions = await getSubscriptions(options);
  // 全契約の月次起算日を含め、JST月初もUTCの日付範囲が逆転しない期間を取得する。
  const from = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  const query = new URLSearchParams({ from, to });
  if (subscriptions === null) {
    // 対象外だけでは0にせず、契約と対象期間の料金明細も正常な空配列か確認する。
    if (!isEmptyList(await request(options, "/subscriptions"))) {
      throw new BillingError("契約なしを確認できないため、0ドルと判定できません。", "not-covered");
    }
    if (!isEmptyList(await request(options, `/billable-usage?${query}`))) {
      throw new BillingError("料金明細なしを確認できないため、0ドルと判定できません。", "not-covered");
    }
    const lines = [
      `Cloudflare ${period} 料金`,
      "",
      "当月の従量料金: 0ドル",
      "月末予測: 算出不可（日別データなし）",
      "",
      "判定根拠: 契約・料金明細なし",
    ];
    if (fixedMonthlyCostUsd > 0) lines.push(`固定月額（設定値）: ${usd(fixedMonthlyCostUsd)}`);
    console.log("料金APIの対象外で、契約・対象期間の明細が空であることを確認しました。");
    return { period, message: lines.join("\n") };
  }
  const rows = await getUsage(options, subscriptions, `?${query}`);
  const forecast = forecastMonthlyCost(dailyCosts(rows, subscriptions), monthStart, monthEnd, now);
  const hasMonthlyData = rows.some((row) => row.start >= monthStart.getTime() && row.end <= Math.min(monthEnd.getTime(), Math.floor(now.getTime() / DAY_MS) * DAY_MS));
  const lines = [
    `Cloudflare ${period} 料金`,
    "",
  ];
  if (!hasMonthlyData) {
    lines.push("当月の従量料金: 不明（当月データなし）");
  } else if (!forecast.recordedComplete) {
    lines.push("当月の従量料金: 不明（欠測あり）");
  } else {
    lines.push(`当月の従量料金: ${usd(forecast.recordedUsd)}`);
  }
  if (forecast.estimatedUsd !== null) {
    lines.push(`月末予測: 約 ${usd(forecast.estimatedUsd + fixedMonthlyCostUsd)}`);
  } else {
    lines.push(`月末予測: 算出不可（${forecast.unavailableReason}）`);
  }
  const details: string[] = [];
  if (hasMonthlyData && !forecast.recordedComplete) {
    details.push(`取得分の小計: ${usd(forecast.recordedUsd)}`);
  }
  if (forecast.dataThrough) {
    details.push(`データ対象: ${forecast.dataThrough} UTC まで`);
    const dataThrough = Date.parse(`${forecast.dataThrough}T00:00:00Z`);
    const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
    if (today - dataThrough >= 3 * DAY_MS) {
      details.push("注意: 最終データ日が3日以上前です。");
    }
    const recentStart = dataThrough - 6 * DAY_MS;
    if (forecast.estimatedUsd !== null && recentStart < monthStart.getTime()) {
      details.push("予測根拠: 前月分を含む7日平均");
    }
  }
  if (fixedMonthlyCostUsd > 0) {
    details.push(`固定月額（設定値）: ${usd(fixedMonthlyCostUsd)}${forecast.estimatedUsd === null ? "" : " (予測に含む)"}`);
  }
  if (details.length > 0) lines.push("", ...details);
  if (forecast.estimatedUsd !== null) {
    lines.push("※予測は概算です。無料枠超過・税・クレジットは未反映。");
  }
  return { period, message: lines.join("\n") };
}

function nextBillingStart(start: number, anchorDay: number): number {
  const date = new Date(start);
  const nextMonth = date.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), nextMonth + 1, 0)).getUTCDate();
  return Date.UTC(
    date.getUTCFullYear(), nextMonth, Math.min(anchorDay, lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
  );
}

function reachesThreshold(amounts: readonly number[], thresholdUsd: number): boolean {
  // 小数セントを丸めず、十進数の桁を揃えて閾値ちょうどの比較誤差を防ぐ。
  const decimals = [thresholdUsd, ...amounts].map((amount) => {
    const [coefficient, exponent = "0"] = amount.toString().split("e");
    const fractionLength = coefficient!.split(".")[1]?.length ?? 0;
    return {
      units: BigInt(coefficient!.replace(".", "")),
      exponent: Number(exponent) - fractionLength,
    };
  });
  const exponent = decimals.reduce((minimum, value) => Math.min(minimum, value.exponent), 0);
  const [threshold, ...charges] = decimals.map((value) => value.units * 10n ** BigInt(value.exponent - exponent));
  return charges.reduce((sum, charge) => sum + charge, 0n) >= threshold!;
}

export async function getBudgetSpends(options: BillingOptions, now: Date, thresholdUsd: number): Promise<CurrentSpend[]> {
  if (!Number.isFinite(now.getTime())) throw new BillingError("アラート確認の日付が不正です。");
  if (!Number.isFinite(thresholdUsd) || thresholdUsd <= 0) throw new BillingError("アラート閾値は0より大きい値が必要です。");
  const subscriptions = await getSubscriptions(options);
  if (subscriptions === null) {
    throw new BillingError("このアカウントは Cloudflare 料金 API の対象外です。", "not-covered");
  }
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  const rows = await getUsage(options, subscriptions, `?${new URLSearchParams({ from, to })}`);
  if (rows.length === 0) return [];
  if (rows.some((row) => row.end > now.getTime())) {
    throw new BillingError("Cloudflare の料金データに未完了の集計期間があります。");
  }
  const anchors = new Set(subscriptions.map((subscription) => {
    const anchor = new Date(subscription.anchor);
    return [anchor.getUTCDate(), anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds()].join(":");
  }));
  if (anchors.size > 1) {
    throw new BillingError("異なる請求起算日の契約をまとめたアラートには対応していません。", "unsupported");
  }
  const grouped = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = row.subscriptionId ?? "without-subscription";
    const items = grouped.get(key) ?? [];
    items.push(row);
    grouped.set(key, items);
  }
  const groups = [...grouped].flatMap(([key, items]) => {
    const starts = [...new Set(items.map((row) => row.billingStart))].sort((left, right) => right - left);
    const latest = starts[0]!;
    const subscription = subscriptions.find((item) => item.id === key);
    const anchorDay = new Date(subscription?.anchor ?? subscriptions[0]?.anchor ?? latest).getUTCDate();
    const next = nextBillingStart(latest, anchorDay);
    const following = nextBillingStart(next, anchorDay);
    if (following <= now.getTime()) return [];
    const current = next <= now.getTime() ? next : latest;
    return [{ items, starts, anchorDay, current, subscription }];
  });
  if (groups.length === 0) return [];

  // 最終日の課金通知は翌周期に届くため、直前の account snapshot も確認する。
  const boundary = Math.max(...groups.map((group) => group.current));
  const snapshots = [now.getTime(), boundary - 1];
  const candidates = new Map<string, CurrentSpend>();
  for (const snapshot of snapshots) {
    const selected: { start: number; rows: UsageRow[] }[] = [];
    let unavailable = false;
    for (const group of groups) {
      if (group.subscription && group.subscription.start > snapshot) continue;
      const cancelled = group.subscription?.end;
      if (cancelled !== undefined && cancelled !== null && cancelled < group.current && snapshot === now.getTime()) continue;
      const start = group.starts.find((period) => period <= snapshot && snapshot < nextBillingStart(period, group.anchorDay));
      if (start === undefined) {
        unavailable = true;
        break;
      }
      // 日次明細の終了時刻が起算時刻をまたいでも、API の請求期間への所属を優先する。
      const items = group.items.filter((row) => row.billingStart === start);
      if (items.length === 0) {
        unavailable = true;
        break;
      }
      selected.push({ start, rows: items });
    }
    if (unavailable || selected.length === 0) continue;
    if (!reachesThreshold(selected.flatMap((group) => group.rows.map((row) => row.amountUsd)), thresholdUsd)) continue;
    const periodKey = JSON.stringify([
      options.accountId,
      [...new Set(selected.map((group) => group.start))].sort((left, right) => left - right),
    ]);
    const amountUsd = selected.reduce((total, group) => total + group.rows.reduce((sum, row) => sum + row.amountUsd, 0), 0);
    if (!Number.isFinite(amountUsd)) throw new BillingError("Cloudflare の料金合計が不正です。");
    const dataThrough = Math.min(...selected.map((group) => Math.max(...group.rows.map((row) => row.end)))) - DAY_MS;
    const starts = selected.map((group) => group.start);
    candidates.set(periodKey, {
      amountUsd,
      periodKey,
      label: starts.every((start) => start === starts[0])
        ? `請求期間 ${new Date(starts[0]!).toISOString().slice(0, 10)} 開始`
        : "各契約の請求期間の計上額合計",
      dataThrough: new Date(dataThrough).toISOString().slice(0, 10),
    });
  }
  return [...candidates.values()];
}
