// Cloudflare 料金の取得・予測

import { localDate, usdSetting, type Env } from "./config.ts";

const DAY_MS = 86_400_000;

type BillingEnv = Pick<Env, "ACCOUNT_ID" | "BILLING_API_TOKEN">;

interface UsageInfo {
  covered: boolean;
  subscriptions: { id: string; start_timestamp: string; end_timestamp?: string | null }[];
}

interface UsageItem {
  BillingCurrency: string;
  ChargeCategory: string;
  ContractedCost: number;
  SubscriptionId?: string | null;
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  ServiceName: string;
  ZoneId?: string | null;
  ConsumedUnit?: string | null;
  PricingUnit?: string | null;
  ChargeDescription?: string | null;
}

interface Subscription {
  id: string;
  start: number;
  end: number | null;
}

interface UsageRow {
  amountUsd: number;
  start: number;
  subscriptionId: string | null;
  seriesKey: string;
}

class BillingError extends Error {
  readonly kind: "unsupported" | "unavailable";

  // 再試行の要否を保持
  constructor(message: string, kind: BillingError["kind"] = "unavailable") {
    super(message);
    this.kind = kind;
  }
}

// 条件を検証
function check(condition: unknown, message: string, kind: BillingError["kind"] = "unavailable"): asserts condition {
  if (!condition) throw new BillingError(message, kind);
}

// 日時をミリ秒に変換
function timestamp(value: string): number {
  const parsed = Date.parse(value);
  check(Number.isFinite(parsed), "日付形式が未対応です。", "unsupported");
  return parsed;
}

// UTC 日付を返す
function dateText(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

// 料金 API の結果を取得
async function request<T>(env: BillingEnv, path: string): Promise<T> {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}${path}`, {
      headers: { Authorization: `Bearer ${env.BILLING_API_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    check(response.ok, `料金 API: HTTP ${response.status}`);
    const envelope = await response.json<{ success: boolean; result: T }>();
    check(envelope.success === true, "料金 API の取得に失敗しました。");
    return envelope.result;
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError("料金 API の通信・応答読取に失敗しました。");
  }
}

// 一覧が空かを判定
async function isEmptyList(env: BillingEnv, path: string): Promise<boolean> {
  const result = await request<unknown>(env, path);
  return Array.isArray(result) && result.length === 0;
}

// 契約を取得
async function getSubscriptions(env: BillingEnv): Promise<Subscription[] | null> {
  const info = await request<UsageInfo>(env, "/billable-usage/info");
  if (!info.covered) {
    check(info.subscriptions.length === 0, "料金 API の対象外です。", "unsupported");
    return null;
  }
  return info.subscriptions.map(/* 契約期間を変換 */ (item) => ({
    id: item.id,
    start: timestamp(item.start_timestamp),
    end: item.end_timestamp == null ? null : timestamp(item.end_timestamp),
  }));
}

// 日次明細を取得
async function getUsage(env: BillingEnv, subscriptions: readonly Subscription[], path: string): Promise<UsageRow[]> {
  const items = await request<UsageItem[]>(env, path);
  return items.map(/* 明細を検証 */ (item) => {
    check(item.BillingCurrency === "USD" && item.ChargeCategory === "Usage", "USD の従量料金以外は未対応です。", "unsupported");
    check(Number.isFinite(item.ContractedCost) && item.ContractedCost >= 0, "明細金額が不正です。");
    const start = timestamp(item.ChargePeriodStart);
    check(start % DAY_MS === 0 && timestamp(item.ChargePeriodEnd) - start === DAY_MS, "UTC の日次料金以外は未対応です。", "unsupported");
    const subscriptionId = item.SubscriptionId ?? (subscriptions.length === 1 ? subscriptions[0]!.id : null);
    const seriesKey = JSON.stringify([
      subscriptionId, item.ServiceName, item.ZoneId ?? "",
      item.ConsumedUnit ?? "", item.PricingUnit ?? "", item.ChargeDescription ?? "",
    ]);
    return { amountUsd: item.ContractedCost, start, subscriptionId, seriesKey };
  });
}

// 月末料金を予測
function forecastMonthlyCost(rows: readonly UsageRow[], subscriptions: readonly Subscription[], start: number, end: number, now: number) {
  const series = new Map<string, string | null>();
  const days = new Map<number, Map<string, number>>();
  for (const row of rows) {
    series.set(row.seriesKey, row.subscriptionId);
    const costs = days.get(row.start) ?? new Map<string, number>();
    costs.set(row.seriesKey, (costs.get(row.seriesKey) ?? 0) + row.amountUsd);
    days.set(row.start, costs);
  }
  const daily = new Map([...days].map(/* 日別料金と欠測を集計 */ ([date, costs]) => {
    const active = new Set(subscriptions.filter(/* 有効契約を選択 */ (subscription) => (
      subscription.start < date + DAY_MS && (subscription.end === null || subscription.end >= date)
    )).map(/* 契約IDを抽出 */ (subscription) => subscription.id));
    const represented = new Set([...costs.keys()].map(/* 契約IDを抽出 */ (key) => series.get(key)));
    return [date, {
      amountUsd: [...costs.values()].reduce(/* 金額を合算 */ (sum, amount) => sum + amount, 0),
      complete: [...active].every(/* 契約漏れを確認 */ (id) => represented.has(id))
        && [...series].every(/* 明細漏れを確認 */ ([key, id]) => (id !== null && !active.has(id)) || costs.has(key)),
    }] as const;
  }));
  const completeBefore = Math.floor(now / DAY_MS) * DAY_MS;
  let recordedUsd = 0;
  let hasMonthlyData = false;
  let latest: number | null = null;
  for (const [date, day] of daily) {
    if (!(date < end && date < completeBefore)) continue;
    latest = latest === null ? date : Math.max(latest, date);
    if (date >= start) {
      recordedUsd += day.amountUsd;
      hasMonthlyData = true;
    }
  }
  const result = { recordedUsd, recordedComplete: false, dataThrough: latest, hasMonthlyData };
  // 予測不可の理由を返す
  const unavailable = (reason: string) => ({ ...result, estimatedUsd: null, unavailableReason: reason });
  if (latest === null || (completeBefore > start && !result.hasMonthlyData)) return unavailable("当月データなし");

  // 最新計上日後の集計待ちは欠測扱いしない
  for (let day = start; day <= latest; day += DAY_MS) {
    if (!daily.get(day)?.complete) return unavailable("日別データに欠測あり");
  }
  result.recordedComplete = result.hasMonthlyData;
  let recentTotal = 0;
  for (let offset = 0; offset < 7; offset++) {
    const day = daily.get(latest - offset * DAY_MS);
    if (!day?.complete) return unavailable("連続7日分のデータ不足");
    recentTotal += day.amountUsd;
  }
  if (recentTotal === 0) return unavailable("直近7日が0ドル");
  const remainingDays = Math.max(0, Math.round((end - Math.max(start, latest + DAY_MS)) / DAY_MS));
  return { ...result, estimatedUsd: recordedUsd + recentTotal / 7 * remainingDays, unavailableReason: null };
}

// USD 表記に整形
function usd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "$0.01 USD 未満";
  return `$${amount.toFixed(2)} USD`;
}

// 通知文を整形
function report(period: string, cost: string, forecast: string, details: string[]): string {
  return `Cloudflare ${period} 料金

当月の従量料金: ${cost}
月末予測: ${forecast}${details.length ? `\n\n${details.join("\n")}` : ""}`;
}

// 月次報告を生成
async function getMonthlyReport(
  env: BillingEnv,
  time: number,
  timeZone: string,
  fixedMonthlyCostUsd: number,
): Promise<string> {
  const date = localDate(time, timeZone).split("-");
  const year = Number(date[0]);
  const month = Number(date[1]);
  const period = `${year}-${date[1]}`;
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd = Date.UTC(year, month, 1);
  const subscriptions = await getSubscriptions(env);
  // 請求起算日・月初の時差を含め前月から取得
  const path = `/billable-usage?${new URLSearchParams({ from: dateText(Date.UTC(year, month - 2, 1)), to: dateText(time) })}`;
  if (subscriptions === null) {
    check(await isEmptyList(env, "/subscriptions"), "契約なしを確認できず、0ドルと判定できません。", "unsupported");
    check(await isEmptyList(env, path), "料金明細なしを確認できず、0ドルと判定できません。", "unsupported");
    const details = ["判定根拠: 契約・料金明細なし"];
    if (fixedMonthlyCostUsd > 0) details.push(`固定月額（設定値）: ${usd(fixedMonthlyCostUsd)}`);
    return report(period, "0ドル", "算出不可（日別データなし）", details);
  }
  const rows = await getUsage(env, subscriptions, path);
  const { recordedUsd, recordedComplete, estimatedUsd, dataThrough, hasMonthlyData, unavailableReason }
    = forecastMonthlyCost(rows, subscriptions, monthStart, monthEnd, time);
  const cost = !hasMonthlyData ? "不明（当月データなし）" : !recordedComplete ? "不明（欠測あり）" : usd(recordedUsd);
  const forecast = estimatedUsd === null ? `算出不可（${unavailableReason}）` : `約 ${usd(estimatedUsd + fixedMonthlyCostUsd)}`;
  const details: string[] = [];
  if (hasMonthlyData && !recordedComplete) {
    details.push(`取得分の小計: ${usd(recordedUsd)}`);
  }
  if (dataThrough !== null) {
    details.push(`データ対象: ${dateText(dataThrough)} UTC まで`);
    const today = Math.floor(time / DAY_MS) * DAY_MS;
    if (today - dataThrough >= 3 * DAY_MS) {
      details.push("注意: 最終データ日が3日以上前です。");
    }
    if (estimatedUsd !== null && dataThrough - 6 * DAY_MS < monthStart) {
      details.push("予測根拠: 前月分を含む7日平均");
    }
  }
  if (fixedMonthlyCostUsd > 0) {
    details.push(`固定月額（設定値）: ${usd(fixedMonthlyCostUsd)}${estimatedUsd === null ? "" : " (予測に含む)"}`);
  }
  if (estimatedUsd !== null) {
    details.push("※予測は概算です。無料枠超過・税・クレジットは未反映。");
  }
  return report(period, cost, forecast, details);
}

// 料金通知の生成と再試行判定
export async function getDailyMessage(
  env: Pick<Env, "ACCOUNT_ID" | "BILLING_API_TOKEN" | "TIME_ZONE" | "MONTHLY_FIXED_COST_USD">,
  scheduledTime: number,
  attempts: number,
): Promise<string> {
  try {
    return await getMonthlyReport(env, scheduledTime, env.TIME_ZONE, usdSetting(env.MONTHLY_FIXED_COST_USD));
  } catch (error) {
    const billingError = error instanceof BillingError ? error : null;
    if (billingError?.kind !== "unsupported" && attempts < 2) throw error;
    return report(localDate(scheduledTime, env.TIME_ZONE).slice(0, 7), "不明（0ドルかは未確認）", "算出不可", [
      `理由: ${billingError?.message ?? "料金の取得・集計に失敗しました。"}`,
    ]);
  }
}
