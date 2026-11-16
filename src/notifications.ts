// 永続通知キュー

import { DurableObject } from 'cloudflare:workers';
import { getDailyMessage } from './billing.ts';
import { localDate, type Env } from './config.ts';
import { pushMessage } from './line.ts';

interface Job {
  kind: 'daily';
  scheduledTime: number;
  nextAttemptAt: number;
  deadline: number;
  attempts: number;
  delivery?: { text: string; retryKey: string };
}

const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const RETENTION_MS = 62 * 24 * 60 * 60 * 1000;

export class NotificationStore extends DurableObject<Env> {
  // 日付単位で重複を抑止して登録
  async enqueueDaily(scheduledTime: number): Promise<void> {
    const id = `daily:${localDate(scheduledTime, this.env.TIME_ZONE)}`;
    const now = Date.now();
    // 重複確認・登録・起動予約
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

  // 送信・再試行と古い記録の回収
  async alarm(): Promise<void> {
    const { storage } = this.ctx;
    // 旧機能の保存値の回収
    await storage.delete('budget-request');
    for (const [key, job] of await storage.list<Job>({ prefix: 'job:' })) {
      // 旧通知ジョブの回収
      if (job.kind !== 'daily') {
        await storage.delete(key);
        continue;
      }
      if (job.nextAttemptAt > Date.now()) continue;
      if (Date.now() >= job.deadline) {
        console.error('通知の再試行期限切れです。');
        await storage.delete(key);
        continue;
      }
      try {
        if (!job.delivery) {
          job.delivery = {
            text: await getDailyMessage(this.env, job.scheduledTime, job.attempts),
            retryKey: crypto.randomUUID(),
          };
          // 停止後も再送内容を固定
          await storage.put(key, job);
        }
        const result = await pushMessage(
          this.env.LINE_CHANNEL_ACCESS_TOKEN,
          this.env.LINE_RECIPIENT_ID,
          job.delivery.text,
          job.delivery.retryKey,
        );
        if (result.kind === 'accepted') {
          // 受理記録とジョブ削除
          await storage.transaction(async storage => {
            await storage.put(`done:${key.slice('job:'.length)}`, Date.now());
            await storage.delete(key);
          });
          console.log('LINE が通知を受理しました。');
        } else if (result.kind === 'failed') {
          console.error(`LINE 設定・本文を確認してください。HTTP ${result.status}`);
          await storage.delete(key);
        } else {
          await this.retry(key, job);
        }
      } catch {
        // 個人設定を含みうる例外本文は記録しない
        console.error('料金取得・通知を再試行します。');
        await this.retry(key, job);
      }
    }
    // exhausted:・security-day: は旧機能の記録
    for (const prefix of ['done:', 'exhausted:', 'security-day:']) {
      for (const [key, timestamp] of await storage.list<number>({ prefix })) {
        if (timestamp < Date.now() - RETENTION_MS) await storage.delete(key);
      }
    }
    // 送信中に登録されたジョブも含めて次回を予約
    const pending = await storage.list<Job>({ prefix: 'job:' });
    if (pending.size > 0) {
      await storage.setAlarm(Math.min(...Array.from(pending.values(), /* 再試行時刻の抽出 */ job => job.nextAttemptAt)));
    }
  }

  // 期限内で指数バックオフ
  private async retry(key: string, job: Job): Promise<void> {
    job.attempts += 1;
    const delay = Math.min(60_000 * 2 ** (job.attempts - 1), 60 * 60_000);
    job.nextAttemptAt = Math.min(Date.now() + delay, job.deadline);
    await this.ctx.storage.put(key, job);
  }
}
