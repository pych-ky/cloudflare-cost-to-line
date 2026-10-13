import { BillingError, getAccountPlanSummary, getMonthlyReport } from './billing.ts';
import { billingOptions, localDate, usdSetting, type Env } from './config.ts';

export async function getDailyMessage(
  env: Pick<Env, 'ACCOUNT_ID' | 'BILLING_API_TOKEN' | 'TIME_ZONE' | 'MONTHLY_FIXED_COST_USD'>,
  scheduledTime: number,
  attempts: number,
): Promise<string> {
  try {
    const report = await getMonthlyReport(
      billingOptions(env), new Date(scheduledTime), env.TIME_ZONE,
      usdSetting(env.MONTHLY_FIXED_COST_USD, 'MONTHLY_FIXED_COST_USD'),
    );
    return report.message;
  } catch (error) {
    const billingError = error instanceof BillingError ? error : null;
    // 一時的な失敗は2回再試行し、復旧しなければ当日はエラーを通知する。
    if ((!billingError || billingError.kind === 'unavailable') && attempts < 2) throw error;
    const notCovered = billingError?.kind === 'not-covered';
    if (notCovered) {
      let plans: string;
      try {
        plans = await getAccountPlanSummary(billingOptions(env));
        console.log('料金API対象外のため、契約情報を参照しました。');
      } catch {
        plans = '契約情報: 取得できませんでした。';
        console.warn('料金APIは対象外です。補足する契約情報の取得に失敗しました。');
      }
      return [
        `Cloudflare ${localDate(scheduledTime, env.TIME_ZONE)} 料金`,
        '',
        '料金データ: 提供対象外',
        plans,
      ].join('\n');
    }
    return [
      `Cloudflare ${localDate(scheduledTime, env.TIME_ZONE)} 料金`,
      '',
      '料金を確認できませんでした。',
      '0ドルかどうかは不明です。',
      '',
      `理由: ${billingError?.message ?? '料金の取得・集計に失敗しました。'}`,
    ].join('\n');
  }
}
