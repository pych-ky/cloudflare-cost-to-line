// Cloudflare 料金の取得・予測

import { billingOptions, localDate, usdSetting, type Env } from "./config.ts";

const DAY_MS = 86_400_000;

type BillingOptions = ReturnType<typeof billingOptions>;

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
  readonly kind: "not-covered" | "unsupported" | "unavailable";

  // エラー種別を保持
  constructor(message: string, kind: BillingError["kind"] = "unavailable") {
    super(message);
    this.name = "BillingError";
    this.kind = kind;
  }
}

// 条件を検証
function check(condition: unknown, message: string, kind: BillingError["kind"] = "unavailable"): asserts condition {
  if (!condition) throw new BillingError(message, kind);
}

// オブジェクトを検証
function object(value: unknown): Record<string, unknown> {
  check(typeof value === "object" && value !== null && !Array.isArray(value), "応答形式が未対応です。", "unsupported");
  return value as Record<string, unknown>;
}

// 必須文字列を検証
function string(value: unknown): string {
  check(typeof value === "string" && value, "必要な項目がありません。");
  return value;
}

// 日時をミリ秒に変換
function timestamp(value: unknown): number {
  const text = string(value);
  const parsed = Date.parse(text);
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(parsed), "日付形式が未対応です。", "unsupported");
  return parsed;
}

// UTC 日付を返す
function dateText(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

// 料金応答を取得
async function request(options: BillingOptions, path: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}${path}`, {
      headers: { Authorization: `Bearer ${options.apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    check(response.ok, `料金 API: HTTP ${response.status}`);
    const envelope = object(await response.json());
    check(envelope.success === true, "料金 API の取得に失敗しました。");
    return envelope;
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError("料金 API の通信・応答読取に失敗しました。");
  }
}

// ページ情報込みで空を判定
function isEmptyList(envelope: Record<string, unknown>): boolean {
  check(Array.isArray(envelope.result), "契約・料金明細一覧の形式が未対応です。", "unsupported");
  if (envelope.result.length > 0) return false;
  if (envelope.result_info === undefined) return true;
  const page = object(envelope.result_info);
  return (page.count === undefined || page.count === 0)
    && (page.total_count === undefined || page.total_count === 0)
    && (page.total_pages === undefined || page.total_pages === 0 || page.total_pages === 1)
    && (page.page === undefined || page.page === 1);
}

// 契約を取得
async function getSubscriptions(options: BillingOptions): Promise<Subscription[] | null> {
  const info = object((await request(options, "/billable-usage/info")).result);
  check(typeof info.covered === "boolean", "料金 API の対象判定を読み取れません。", "unsupported");
  check(Array.isArray(info.subscriptions), "契約情報の形式が未対応です。", "unsupported");
  if (!info.covered) {
    check(info.subscriptions.length === 0, "料金 API の対象外です。", "not-covered");
    return null;
  }
  const subscriptions = info.subscriptions.map(/* 契約を検証 */ (value: unknown) => {
    const item = object(value);
    const subscription = {
      id: string(item.id),
      start: timestamp(item.start_timestamp),
      end: item.end_timestamp == null ? null : timestamp(item.end_timestamp),
    };
    check(subscription.end === null || subscription.end >= subscription.start, "契約期間が不正です。");
    return subscription;
  });
  check(new Set(subscriptions.map(/* 契約IDを抽出 */ (subscription) => subscription.id)).size === subscriptions.length, "契約情報が重複しています。");
  return subscriptions;
}

// 日次明細を取得
async function getUsage(options: BillingOptions, subscriptions: readonly Subscription[], path: string): Promise<UsageRow[]> {
  const result = (await request(options, path)).result;
  check(Array.isArray(result), "料金明細の形式が未対応です。", "unsupported");
  const ids = new Set(subscriptions.map(/* 契約IDを抽出 */ (subscription) => subscription.id));
  const seen = new Set<string>();
  return result.map(/* 明細を検証 */ (value: unknown) => {
    const item = object(value);
    check(item.BillingCurrency === "USD" && item.ChargeCategory === "Usage", "USD の従量料金以外は未対応です。", "unsupported");
    check(typeof item.ContractedCost === "number" && Number.isFinite(item.ContractedCost) && item.ContractedCost >= 0, "明細金額が不正です。");
    const subscriptionId = item.SubscriptionId == null
      ? subscriptions.length === 1 ? subscriptions[0]!.id : null
      : string(item.SubscriptionId);
    check(subscriptionId === null || ids.has(subscriptionId), "料金明細を契約に対応付けられません。");
    const start = timestamp(item.ChargePeriodStart);
    const end = timestamp(item.ChargePeriodEnd);
    const billingStart = timestamp(item.BillingPeriodStart);
    check(start % DAY_MS === 0 && end - start === DAY_MS && billingStart < end, "UTC の日次料金以外は未対応です。", "unsupported");
    const seriesKey = JSON.stringify([
      subscriptionId, string(item.ServiceName), item.ZoneId ?? "",
      item.ConsumedUnit ?? "", item.PricingUnit ?? "", item.ChargeDescription ?? "",
    ]);
    const rowKey = JSON.stringify([seriesKey, start, billingStart]);
    check(!seen.has(rowKey), "料金明細が重複しています。");
    seen.add(rowKey);
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
  check(Number.isFinite(amount) && amount >= 0, "料金合計が不正です。");
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
  options: BillingOptions,
  time: number,
  timeZone: string,
  fixedMonthlyCostUsd: number,
): Promise<string> {
  check(Number.isFinite(time), "日付または固定費設定が不正です。");
  const date = localDate(time, timeZone).split("-");
  const year = Number(date[0]);
  const month = Number(date[1]);
  const period = `${year}-${date[1]}`;
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd = Date.UTC(year, month, 1);
  const subscriptions = await getSubscriptions(options);
  // 請求起算日・月初の時差を含め前月から取得
  const path = `/billable-usage?${new URLSearchParams({ from: dateText(Date.UTC(year, month - 2, 1)), to: dateText(time) })}`;
  if (subscriptions === null) {
    check(isEmptyList(await request(options, "/subscriptions")), "契約なしを確認できず、0ドルと判定できません。", "not-covered");
    check(isEmptyList(await request(options, path)), "料金明細なしを確認できず、0ドルと判定できません。", "not-covered");
    const details = ["判定根拠: 契約・料金明細なし"];
    if (fixedMonthlyCostUsd > 0) details.push(`固定月額（設定値）: ${usd(fixedMonthlyCostUsd)}`);
    console.log("料金APIの対象外で、契約・対象期間の明細が空であることを確認しました。");
    return report(period, "0ドル", "算出不可（日別データなし）", details);
  }
  const rows = await getUsage(options, subscriptions, path);
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
    return await getMonthlyReport(
      billingOptions(env), new Date(scheduledTime).getTime(), env.TIME_ZONE,
      usdSetting(env.MONTHLY_FIXED_COST_USD),
    );
  } catch (error) {
    const billingError = error instanceof BillingError ? error : null;
    if ((!billingError || billingError.kind === "unavailable") && attempts < 2) throw error;
    if (billingError?.kind === "not-covered") console.log("料金API対象外のため、料金・予測は不明です。");
    return report(localDate(scheduledTime, env.TIME_ZONE).slice(0, 7), "不明（0ドルかは未確認）", "算出不可", [
      `理由: ${billingError?.message ?? "料金の取得・集計に失敗しました。"}`,
    ]);
  }
}
