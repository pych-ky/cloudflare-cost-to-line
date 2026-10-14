import { DurableObject } from 'cloudflare:workers';
import { getDailyMessage } from './billing';
import { localDate, type Env } from './config';
import { pushMessage } from './line';

interface Delivery {
  id: string;
  text: string;
  recipient: string;
  retryKey: string;
  deadline: number;
}

interface Job {
  kind: 'daily';
  scheduledTime: number;
  nextAttemptAt: number;
  deadline: number;
  attempts: number;
  delivery?: Delivery;
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

  async alarm(): Promise<void> {
    const { storage } = this.ctx;
    await storage.delete('budget-request');
    for (const [key, job] of await storage.list<Job>({ prefix: 'job:' })) {
      // 廃止した通知の保存済みジョブを破棄する。
      if (job.kind !== 'daily') {
        await storage.delete(key);
        continue;
      }
      if (job.nextAttemptAt > Date.now()) continue;
      if (Date.now() >= job.deadline || (job.delivery && Date.now() >= job.delivery.deadline)) {
        console.error('通知の再試行期限切れです。');
        await storage.delete(key);
        continue;
      }
      const preparingDelivery = job.delivery === undefined;
      try {
        if (!job.delivery) {
          job.delivery = await this.prepareDelivery(key, job);
          // 停止後も同じキー・本文・宛先で再試行する。
          await storage.put(key, job);
        }
        if (Date.now() >= job.delivery.deadline) {
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
          await storage.transaction(async storage => {
            await storage.put(`done:${job.delivery!.id}`, Date.now());
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
        // 例外本文は個人設定を含む可能性があるため記録しない。
        console.error('料金取得・通知を再試行します。');
        await this.retry(key, job);
      }
    }
    for (const prefix of ['done:', 'exhausted:', 'security-day:']) {
      for (const [key, timestamp] of await storage.list<number>({ prefix })) {
        if (timestamp < Date.now() - RETENTION_MS) await storage.delete(key);
      }
    }
    await storage.transaction(async storage => {
      const pending = await storage.list<Job>({ prefix: 'job:' });
      if (pending.size > 0) {
        await storage.setAlarm(Math.min(...Array.from(pending.values(), job => job.nextAttemptAt)));
      }
    });
  }

  private async prepareDelivery(key: string, job: Job): Promise<Delivery> {
    if (!this.env.LINE_CHANNEL_ACCESS_TOKEN || !/^[UCR][a-f0-9]{32}$/i.test(this.env.LINE_RECIPIENT_ID)) {
      throw new Error();
    }
    const text = await getDailyMessage(this.env, job.scheduledTime, job.attempts);
    return {
      id: key.slice('job:'.length), text, recipient: this.env.LINE_RECIPIENT_ID,
      retryKey: crypto.randomUUID(), deadline: job.deadline,
    };
  }

  private async retry(key: string, job: Job): Promise<void> {
    job.attempts += 1;
    const delay = Math.min(60_000 * 2 ** (job.attempts - 1), 60 * 60_000);
    job.nextAttemptAt = Math.min(Date.now() + delay, job.deadline, job.delivery?.deadline ?? Infinity);
    await this.ctx.storage.put(key, job);
  }
}
