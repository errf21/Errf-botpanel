import {syncConfiguredPanels} from './panels/bindings.ts';
import { cleanupExpiredAdminTokens } from './db/maintenance.ts';
import { cleanupExpiredUpdates } from './db/dedupe.ts';
import {recoverUnlinkedWalletPayments} from './db/wallet.ts';
import {runAnnouncementSweep} from './handlers/announcements.ts';
import { deliverMigrationNotices } from './handlers/serviceMigration.ts';
import { recoverServiceMigrations } from './migrations/service.ts';
import { recoverPanelOperations } from './panels/recovery.ts';
import { panelAdminRoute } from './panels/admin.ts';
import type { Env } from './types.ts';
import { handleHealth } from './routes/health.ts';
import { handleWebhook } from './routes/webhook.ts';
import { runPaymentReminderSweep } from './handlers/paymentReminders.ts';
import { runServiceNotificationSweep } from './handlers/serviceNotifications.ts';
import { text } from './lib/http.ts';

export default {
  async fetch(
    request: Request,
    env: Env,
    executionCtx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/admin/panels' || url.pathname === '/admin/panels/configure' || url.pathname === '/admin/panels/metadata' || url.pathname === '/admin/panels/groups') return panelAdminRoute(request,env);

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
   * Phase 9 piggybacks the same trigger: service usage/expiry notices are
   * day-scale deadlines, so an extra cron would buy nothing. The two sweeps
   * are independent runs: one failing never cancels the other.
   */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    try{await syncConfiguredPanels(env);}catch{console.error('panel_binding_sync_failed');}
    const at = typeof controller.scheduledTime === 'number' ? controller.scheduledTime : Date.now();
    const when = Number.isFinite(at) ? at : Date.now();
    // Authorization expiry is enforced on reads; hourly garbage collection
    // uses the existing five-minute trigger, not a new schedule/product.
    if (new Date(when).getUTCMinutes()<5) {
      try { await cleanupExpiredAdminTokens(env.DB,when); } catch { console.error('admin_token_cleanup_failed'); }
    }
    try { await cleanupExpiredUpdates(env.DB,when); } catch { console.error('dedupe_cleanup_failed'); }
    try{await recoverUnlinkedWalletPayments(env.DB,when);}catch{console.error('wallet_checkout_recovery_failed');}
    try{await runAnnouncementSweep(env);}catch{console.error('announcement_sweep_failed');}
    try { await recoverServiceMigrations(env); } catch { console.error('service_migration_recovery_failed'); }
    try { await deliverMigrationNotices(env); } catch { console.error('service_migration_notice_failed'); }
    try { await recoverPanelOperations(env); } catch { console.error('panel_recovery_failed'); }
    try {
      await runPaymentReminderSweep(env, when);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      console.error(`payment_reminder_sweep_failed error=${name}`);
    }
    try {
      await runServiceNotificationSweep(env, when);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      console.error(`service_notification_sweep_failed error=${name}`);
    }
  },
} satisfies ExportedHandler<Env>;
