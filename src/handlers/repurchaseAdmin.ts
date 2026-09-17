/**
 * Admin repurchase-lock queue: visibility + safe cancellation for
 * active/in-progress repurchase orders. Read-only list reuses the existing
 * admin queue patterns; cancellation reuses the shared idempotent core in
 * `admin.ts` (guarded D1 claim, exactly-once wallet refund, conditional
 * session restore, zero PasarGuard calls).
 */
import type { UpdateContext } from '../types.ts';
import { listActiveRepurchases, isRepurchaseProvisioningStarted } from '../db/orders.ts';
import { performRepurchaseCancel, retireAdminMessage } from '../admin.ts';
import { adminRepurchaseQueueKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { FA_UI } from '../telegram/i18n.ts';

const REPURCHASE_QUEUE_LIMIT = 20;

/** `/repurchases` — admin-only list of lock-holding repurchase orders. */
export async function showActiveRepurchases(ctx: UpdateContext): Promise<void> {
  const rows = await listActiveRepurchases(ctx.db, REPURCHASE_QUEUE_LIMIT);
  if (rows.length === 0) {
    await ctx.api.sendMessage(ctx.chatId, fa.adminRepurchaseQueueEmpty);
    return;
  }
  const lines: string[] = [fa.adminRepurchaseQueueHeader];
  rows.forEach((row, index) => {
    const uploader = row.telegram_username ? `@${row.telegram_username}` : row.telegram_user_id;
    const mode = row.repurchase_mode === 'custom' ? 'custom' : row.repurchase_mode === 'same' ? 'same' : '—';
    const serviceId = (() => {
      try {
        const snapshot = JSON.parse(row.selections) as Record<string, unknown>;
        const service =
          snapshot['repurchases_order_id'] ?? snapshot['renews_order_id'];
        return typeof service === 'string' ? service.slice(0, 10) : '—';
      } catch {
        return '—';
      }
    })();
    lines.push(
      fa.adminRepurchaseEntry(
        index + 1,
        row.id,
        FA_UI.t.orderStatus(row.state),
        mode,
        serviceId,
      ),
    );
    lines.push(
      `   👤 ${uploader} — ${FA_UI.f.price(row.amount, row.currency)} — ${row.created_at.slice(0, 10)}`,
    );
    lines.push(
      isRepurchaseProvisioningStarted(row)
        ? `   ${fa.adminRepurchaseProvisioningLine}`
        : `   ${fa.adminRepurchaseLockLine}`,
    );
  });
  await ctx.api.sendMessage(
    ctx.chatId,
    lines.join('\n'),
    adminRepurchaseQueueKeyboard(
      rows.map((row) => ({
        orderId: row.id,
        cancellable:
          (row.state === 'pending_payment' ||
            row.state === 'awaiting_review' ||
            row.state === 'approved' ||
            row.state === 'failed') &&
          !isRepurchaseProvisioningStarted(row),
      })),
    ),
  );
}

/** Shared outcome plumbing for the `adm:cancel:` tap. */
export async function answerRepurchaseCancel(
  ctx: UpdateContext,
  orderId: string,
  callbackQueryId: string,
  messageChatId: number | null,
  messageId: number | null,
): Promise<void> {
  const result = await performRepurchaseCancel({
    db: ctx.db,
    api: ctx.api,
    actorTag: `admin:${String(ctx.actor.id)}`,
    orderId,
    reason: 'admin cancelled repurchase',
  });
  if (!result.ok) {
    const toast =
      result.error === 'provisioning_started'
        ? fa.adminRepurchaseProvisioningBlocked
        : result.error === 'not_found' || result.error === 'invalid_id'
          ? fa.invalidChoice
          : fa.adminRepurchaseCancelStale;
    await ctx.api.answerCallbackQuery(callbackQueryId, toast, true);
    return;
  }
  await ctx.api.answerCallbackQuery(
    callbackQueryId,
    result.alreadyCancelled ? fa.adminRepurchaseCancelStale : fa.adminRepurchaseCancelledToast,
  );
  await retireAdminMessage(
    ctx.api,
    messageChatId,
    messageId,
    fa.adminRepurchaseCancelledMsg(result.order.id, String(ctx.actor.id)),
  );
}
