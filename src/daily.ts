import { BillingError, getMonthlyReport } from './billing.ts';
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
    if (billingError?.kind === 'not-covered') {
      console.log('料金API対象外のため、当月料金と月末予測は不明です。');
    }
    return [
      `Cloudflare ${localDate(scheduledTime, env.TIME_ZONE).slice(0, 7)} 料金`,
      '',
      '当月の従量料金: 不明（0ドルかは未確認）',
      '月末予測: 算出不可',
      '',
      `理由: ${billingError?.message ?? '料金の取得・集計に失敗しました。'}`,
    ].join('\n');
  }
}
