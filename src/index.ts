// Worker入口

import type { Env } from './config.ts';

export { NotificationStore } from './notifications.ts';

export default {
  // 日次通知の登録
  async scheduled(controller, env): Promise<void> {
    await env.NOTIFICATIONS.getByName('notifications').enqueueDaily(controller.scheduledTime);
  },

  // HTTP要求を拒否
  fetch(): Response {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
