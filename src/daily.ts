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
    const notCovered = billingError?.kind === 'not-covered';
    return [
      `Cloudflare ${localDate(scheduledTime, env.TIME_ZONE)} 料金`,
      `状態: ${notCovered ? '料金データの提供対象外' : '料金データ取得エラー'}`,
      '計上済み従量料金: 未確認（0ドルとは判定できません）',
      '月末予測: 料金データを取得できないため保留',
      `理由: ${billingError?.message ?? '料金の取得・集計処理に失敗しました。Bot の設定とログを確認してください。'}`,
      notCovered
        ? 'Cloudflare の請求画面で確認してください。次回の定期通知で対象判定を再確認します。'
        : 'Cloudflare の請求画面と Bot の料金参照設定を確認してください。次回の定期通知で再取得します。',
    ].join('\n');
  }
}
