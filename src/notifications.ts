import { DurableObject } from 'cloudflare:workers';
import { BillingError, getBudgetSpends, getMonthlyReport } from './billing';
import { billingOptions, localDate, usdSetting, type Env } from './config';
import { pushMessage } from './line';
import type { R2BucketCreated } from './security-events';

interface Delivery {
  id: string;
  text: string;
  recipient: string;
  retryKey: string;
  firstAttemptAt: number;
  deadline: number;
}

interface Job {
  kind: 'daily' | 'budget' | 'security';
  scheduledTime: number;
  nextAttemptAt: number;
  deadline: number;
  attempts: number;
  delivery?: Delivery;
  securityEvent?: R2BucketCreated;
}

const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const RETENTION_MS = 62 * 24 * 60 * 60 * 1000;

export class NotificationStore extends DurableObject<Env> {
  async enqueueDaily(scheduledTime: number): Promise<void> {
    const id = `daily:${localDate(scheduledTime, this.env.TIME_ZONE)}`;
    const now = Date.now();
    await this.ctx.storage.transaction(async storage => {
      if (await storage.get(`done:${id}`) || await storage.get(`job:${id}`)) return;
      await storage.put(`job:${id}`, {
        kind: 'daily', scheduledTime, nextAttemptAt: now,
        deadline: now + RETRY_WINDOW_MS, attempts: 0,
      } satisfies Job);
      const alarm = await storage.getAlarm();
      if (alarm === null || alarm > now) await storage.setAlarm(now);
    });
  }

  async enqueueBudget(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.transaction(async storage => {
      // API・LINE の応答待ち中も、alarm が保存するジョブとは別に新着を保持する。
      await storage.put('budget-request', now);
      const alarm = await storage.getAlarm();
      if (alarm === null || alarm > now) await storage.setAlarm(now);
    });
  }

  async enqueueSecurityEvent(event: R2BucketCreated): Promise<void> {
    const now = Date.now();
    const receivedDate = localDate(now, this.env.TIME_ZONE);
    const id = `security:r2-bucket-created:${receivedDate}`;
    await this.ctx.storage.transaction(async storage => {
      // 送信の成否に関係なく、受信日の最初の作成イベントだけを予約する。
      if (await storage.get(`security-day:${receivedDate}`) !== undefined) return;
      await storage.put(`security-day:${receivedDate}`, now);
      await storage.put(`job:${id}`, {
        kind: 'security', scheduledTime: now, nextAttemptAt: now,
        deadline: now + RETRY_WINDOW_MS, attempts: 0, securityEvent: event,
      } satisfies Job);
      const alarm = await storage.getAlarm();
      if (alarm === null || alarm > now) await storage.setAlarm(now);
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.transaction(async storage => {
      const receivedAt = await storage.get<number>('budget-request');
      if (receivedAt === undefined) return;
      const job = await storage.get<Job>('job:budget-check');
      await storage.put('job:budget-check', {
        ...job,
        kind: 'budget', scheduledTime: receivedAt, nextAttemptAt: Date.now(),
        deadline: receivedAt + RETRY_WINDOW_MS, attempts: 0,
      } satisfies Job);
      await storage.delete('budget-request');
    });
    const jobs = await this.ctx.storage.list<Job>({ prefix: 'job:' });
    for (const [key, job] of jobs) {
      if (job.nextAttemptAt > Date.now()) continue;
      if (job.delivery && Date.now() >= Math.min(job.delivery.deadline, job.delivery.firstAttemptAt + RETRY_WINDOW_MS)) {
        console.error('LINE 通知の再試行期限を超えました。');
        if (job.kind !== 'budget') {
          await this.ctx.storage.delete(key);
          continue;
        }
        const expiredId = job.delivery.id;
        delete job.delivery;
        job.attempts = 0;
        await this.ctx.storage.transaction(async storage => {
          // 受理されたか不明な送信を、新しい Retry-Key でやり直さない。
          await storage.put(`exhausted:${expiredId}`, Date.now());
          await storage.put(key, job);
        });
      }
      if (Date.now() >= job.deadline) {
        if (job.kind === 'budget') console.warn('予算アラート受信後の料金確認期間を終了しました。');
        else console.error('通知の再試行期限を超えました。');
        await this.ctx.storage.delete(key);
        continue;
      }
      const preparingDelivery = job.delivery === undefined;
      try {
        if (!job.delivery) {
          const delivery = await this.prepareDelivery(key, job);
          job.delivery = delivery;
          // LINE が受理した直後に停止しても、同じキー・本文・宛先で再試行する。
          await this.ctx.storage.put(key, job);
        }
        if (Date.now() >= job.delivery.deadline) {
          // この実行で準備した通知はまだ LINE に送っていない。
          if (preparingDelivery) delete job.delivery;
          await this.retry(key, job);
          continue;
        }
        const result = await pushMessage(
          this.env.LINE_CHANNEL_ACCESS_TOKEN,
          job.delivery.recipient,
          job.delivery.text,
          job.delivery.retryKey,
        );
        if (result.kind === 'accepted') {
          const acceptedId = job.delivery.id;
          const nextJob = { ...job, attempts: 0, nextAttemptAt: Date.now() };
          delete nextJob.delivery;
          await this.ctx.storage.transaction(async storage => {
            await storage.put(`done:${acceptedId}`, Date.now());
            if (job.kind === 'budget') {
              await storage.put(key, nextJob);
            } else {
              await storage.delete(key);
            }
          });
          console.log('LINE が通知を受理しました。');
        } else if (result.kind === 'failed') {
          console.error(`LINE の設定または送信内容を確認してください。HTTP ${result.status}`);
          await this.ctx.storage.delete(key);
        } else {
          await this.retry(key, job);
        }
      } catch {
        // 外部応答や例外本文には個人設定が含まれる可能性があるため記録しない。
        console.error(job.kind === 'budget'
          ? '料金の反映と未通知の請求期間を再確認します。'
          : job.kind === 'security'
            ? 'Cloudflare イベントの通知処理に失敗しました。再試行します。'
            : '料金取得または通知処理に失敗しました。再試行します。');
        await this.retry(key, job);
      }
    }
    for (const prefix of ['done:', 'exhausted:', 'security-day:']) {
      const completed = await this.ctx.storage.list<number>({ prefix });
      for (const [key, timestamp] of completed) {
        if (timestamp < Date.now() - RETENTION_MS) await this.ctx.storage.delete(key);
      }
    }
    await this.ctx.storage.transaction(async storage => {
      if (await storage.get<number>('budget-request') !== undefined) {
        await storage.setAlarm(Date.now());
        return;
      }
      const pending = await storage.list<Job>({ prefix: 'job:' });
      if (pending.size > 0) {
        await storage.setAlarm(Math.min(...Array.from(pending.values(), job => job.nextAttemptAt)));
      }
    });
  }

  private async prepareDelivery(key: string, job: Job): Promise<Delivery> {
    if (!this.env.LINE_CHANNEL_ACCESS_TOKEN || !/^[UCR][a-f0-9]{32}$/i.test(this.env.LINE_RECIPIENT_ID)) {
      throw new Error('LINE の送信設定が不足しています。');
    }
    let id: string;
    let text: string;
    if (job.kind === 'daily') {
      id = key.slice('job:'.length);
      try {
        const report = await getMonthlyReport(
          billingOptions(this.env), new Date(job.scheduledTime), this.env.TIME_ZONE,
          usdSetting(this.env.MONTHLY_FIXED_COST_USD, 'MONTHLY_FIXED_COST_USD'),
        );
        text = report.message;
      } catch (error) {
        if (!(error instanceof BillingError) || error.kind !== 'unsupported') throw error;
        text = [
          `Cloudflare ${localDate(job.scheduledTime, this.env.TIME_ZONE)} 料金`,
          '計上額・月末予測: 算出不可',
          error.message,
        ].join('\n');
      }
    } else if (job.kind === 'security') {
      if (!job.securityEvent) throw new Error('Cloudflare イベント通知の情報がありません。');
      id = key.slice('job:'.length);
      text = [
        'Cloudflare アカウントの操作警告',
        'R2 バケットの作成イベントを検知しました。',
        `バケット: ${job.securityEvent.bucketName}`,
        `作成イベント日時: ${job.securityEvent.eventTimestamp} (UTC)`,
        '身に覚えがない場合は Cloudflare アカウントへのアクセスを確認してください。',
        '料金超過の判定とは別の通知です。',
        `受信日 ${localDate(job.scheduledTime, this.env.TIME_ZONE)} (${this.env.TIME_ZONE}) の最初の作成のみ通知します。`,
      ].join('\n');
    } else {
      const threshold = usdSetting(this.env.ALERT_THRESHOLD_USD, 'ALERT_THRESHOLD_USD');
      if (threshold <= 0) throw new Error('アラート閾値は0より大きい値が必要です。');
      // メールは未信頼の起動契機とし、金額と請求期間を必ず API で確認する。
      const exceeded = await getBudgetSpends(billingOptions(this.env), new Date(), threshold);
      if (exceeded.length === 0) {
        throw new Error('予算アラートと料金 API の反映時刻が一致していません。');
      }
      let spend;
      for (const candidate of exceeded) {
        const candidateId = `budget:${candidate.periodKey}:${threshold}`;
        if (!await this.ctx.storage.get(`done:${candidateId}`) && !await this.ctx.storage.get(`exhausted:${candidateId}`)) {
          spend = candidate;
          break;
        }
      }
      if (!spend) {
        throw new Error('通知済み・再試行終了の周期と、未反映の現在周期を区別できないため再確認します。');
      }
      id = `budget:${spend.periodKey}:${threshold}`;
      text = [
        'Cloudflare 料金アラート',
        `累積従量料金: $${spend.amountUsd.toFixed(2)}`,
        `設定閾値: $${threshold.toFixed(2)}`,
        `対象: ${spend.label}`,
        `データ対象: ${spend.dataThrough} (UTC)`,
        '固定費・税などを含まない、日次集計後の通知です。',
      ].join('\n');
    }
    const firstAttemptAt = Date.now();
    return {
      id, text, recipient: this.env.LINE_RECIPIENT_ID,
      retryKey: crypto.randomUUID(), firstAttemptAt,
      deadline: Math.min(job.deadline, firstAttemptAt + RETRY_WINDOW_MS),
    };
  }

  private async retry(key: string, job: Job): Promise<void> {
    job.attempts += 1;
    const delay = Math.min(60_000 * 2 ** Math.min(job.attempts - 1, 6), 60 * 60_000);
    job.nextAttemptAt = Math.min(Date.now() + delay, job.deadline, job.delivery?.deadline ?? Infinity);
    await this.ctx.storage.put(key, job);
  }
}
