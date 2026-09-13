import type { Env } from './types.ts';
import { handleHealth } from './routes/health.ts';
import { handleWebhook } from './routes/webhook.ts';
import { runPaymentReminderSweep } from './handlers/paymentReminders.ts';
import { text } from './lib/http.ts';

export default {
  async fetch(
    request: Request,
    env: Env,
    executionCtx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return handleHealth(env);
    }

    if (request.method === 'POST' && url.pathname === '/telegram/webhook') {
      return handleWebhook(request, env, executionCtx);
    }

    return text('telbotv2 — see /health', 404);
  },

  /**
   * Phase 8C: payment review reminders (five-minute cron). Sweeps are
   * claim-idempotent, so overlapping/jittered runs are safe; nothing may
   * throw past here — identical to the webhook never-throw policy.
   */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    try {
      const at = typeof controller.scheduledTime === 'number' ? controller.scheduledTime : Date.now();
      await runPaymentReminderSweep(env, Number.isFinite(at) ? at : Date.now());
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      console.error(`payment_reminder_sweep_failed error=${name}`);
    }
  },
} satisfies ExportedHandler<Env>;
