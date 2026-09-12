/**
 * The `/failed` recovery queue and the `adm:rt:` retry action. Both act ONLY
 * through `provisionOrder`, whose guarded claim keeps concurrent
 * taps/instances single-winner.
 */
import type { UpdateContext } from '../types.ts';
import { listOrdersFailed } from '../db/orders.ts';
import { provisionOrder } from '../provision/provision.ts';
import { retireAdminMessage } from '../admin.ts';
import { failedQueueKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';

const FAILED_QUEUE_LIMIT = 10;

/** `/failed` — recent provisioning failures with retry buttons. */
export async function showFailedQueue(ctx: UpdateContext): Promise<void> {
  const orders = await listOrdersFailed(ctx.db, FAILED_QUEUE_LIMIT);
  if (orders.length === 0) {
    await ctx.api.sendMessage(ctx.chatId, fa.failedQueueEmpty);
    return;
  }
  const lines: string[] = [fa.failedQueueHeader];
  orders.forEach((order, index) => {
    lines.push(
      fa.failedQueueEntry(
        index + 1,
        order.id,
        order.failure_reason ?? '—',
        order.provision_attempts,
      ),
    );
  });
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), failedQueueKeyboard(orders.map((o) => o.id)));
}

export interface RetryResponse {
  toast: string;
  alert: boolean;
  retireText: string | null;
}

/** Re-run provisioning for one failed order; classify the outcome for the tap. */
export async function handleProvisionRetry(
  ctx: UpdateContext,
  orderId: string,
): Promise<RetryResponse> {
  const result = await provisionOrder(
    { env: ctx.env, db: ctx.db, api: ctx.api },
    { orderId, retry: true },
  );

  if (result.ok) {
    return { toast: fa.adminRetryOkToast, alert: false, retireText: fa.adminProvisionDone(orderId) };
  }
  if ('skip' in result) {
    const toast =
      result.skip === 'disabled'
        ? fa.adminProvisionDisabledToast
        : result.skip === 'renewal_disabled'
          ? fa.renewDisabledNotice
          : result.skip === 'unconfigured'
            ? fa.adminPanelUnavailableToast
            : fa.adminPanelUnavailableToast;
    return { toast, alert: true, retireText: null };
  }
  switch (result.error) {
    case 'attempts_exhausted':
      return {
        toast: fa.adminRetryExhaustedToast,
        alert: true,
        retireText: fa.adminProvisionStale(orderId),
      };
    case 'state_changed':
    case 'not_found':
      return {
        toast: fa.adminRetryStaleToast,
        alert: true,
        retireText: fa.adminProvisionStale(orderId),
      };
    default:
      // provision_failed / invalid_id: the order is (still) failed — buttons
      // stay live on this message so another attempt (within the cap) works.
      return { toast: fa.adminRetryFailToast, alert: true, retireText: null };
  }
}

/** Shared outcome plumbing for the admin tap: toast + dead-button cleanup. */
export async function answerProvisionRetry(
  ctx: UpdateContext,
  callbackQueryId: string,
  messageChatId: number | null,
  messageId: number | null,
  response: RetryResponse,
): Promise<void> {
  await ctx.api.answerCallbackQuery(callbackQueryId, response.toast, response.alert);
  if (response.retireText !== null) {
    await retireAdminMessage(ctx.api, messageChatId, messageId, response.retireText);
  }
}
