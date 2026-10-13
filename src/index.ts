import type { Env } from './config';
import { readBudgetEmail } from './email';

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

  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
