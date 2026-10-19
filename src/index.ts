import type { Env } from './config.ts';

export { NotificationStore } from './notifications.ts';

export default {
  async scheduled(controller, env): Promise<void> {
    await env.NOTIFICATIONS.getByName('notifications').enqueueDaily(controller.scheduledTime);
  },

  fetch(): Response {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
