import type { Env } from './config';
import { readBudgetEmail } from './email';
import { readR2BucketCreated } from './security-events';

export { NotificationStore } from './notifications';

export default {
  async scheduled(controller, env): Promise<void> {
    await env.NOTIFICATIONS.getByName('notifications').enqueueDaily(controller.scheduledTime);
  },

  async email(message, env): Promise<void> {
    if (!env.ALERT_EMAIL_RECIPIENT || !env.ALERT_EMAIL_SENDER || !env.ALERT_EMAIL_SUBJECT) {
      message.setReject('Budget email settings are missing');
      return;
    }
    try {
      await readBudgetEmail(message, {
        recipient: env.ALERT_EMAIL_RECIPIENT,
        sender: env.ALERT_EMAIL_SENDER,
        subject: env.ALERT_EMAIL_SUBJECT,
      });
    } catch {
      console.warn('設定に一致しないメール、またはサイズ上限を超えるメールを拒否しました。');
      message.setReject('Unrecognized budget notification');
      return;
    }
    try {
      await env.NOTIFICATIONS.getByName('notifications').enqueueBudget();
    } catch {
      throw new Error('Budget notification could not be queued');
    }
  },

  async queue(batch: MessageBatch<unknown>, env): Promise<void> {
    for (const message of batch.messages) {
      const event = readR2BucketCreated(message.body, env.ACCOUNT_ID);
      if (!event) {
        console.warn('対象外または不正な Cloudflare イベントを破棄しました。');
        message.ack();
        continue;
      }
      try {
        await env.NOTIFICATIONS.getByName('notifications').enqueueSecurityEvent(event);
        message.ack();
      } catch {
        console.error('Cloudflare イベント通知を保存できませんでした。再配信を要求します。');
        message.retry();
      }
    }
  },

  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
