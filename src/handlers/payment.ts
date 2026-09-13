/**
 * Phase 4 customer + admin-facing pieces that are NOT the review action
 * itself (performAdminReview lives in src/admin.ts). Everything read from a
 * session/callback is re-validated against the DB order; keyboard content
 * never determines what gets stored.
 */
import type { UpdateContext } from '../types.ts';
import type { Session } from '../db/states.ts';
import { clearSession } from '../db/states.ts';
import {
  getOrderById,
  listOrdersAwaitingReview,
  listRecentOrdersForCustomer,
  submitOrderReceipt,
  type OrderRow,
} from '../db/orders.ts';
import { loadPaymentInfo, paymentCardFromEnv } from '../catalog/payment.ts';
import { isValidOrderId, type ReceiptMedia } from '../lib/validate.ts';
import { forwardReceiptToAdmins } from '../admin.ts';
import { adminQueueKeyboard, backToMenuKeyboard } from '../telegram/menu.ts';
import { fa, formatPrice } from '../telegram/texts.ts';
import { tgEscapeHtml } from '../telegram/format.ts';

const MY_ORDERS_LIMIT = 8;
const PENDING_QUEUE_LIMIT = 10;

export function statusFa(state: string): string {
  switch (state) {
    case 'pending_payment':
      return fa.statusPendingPayment;
    case 'awaiting_review':
      return fa.statusAwaitingReview;
    case 'approved':
      return fa.statusApproved;
    case 'provisioning':
      return fa.statusProvisioning;
    case 'completed':
      return fa.statusCompleted;
    case 'rejected':
      return fa.statusRejected;
    case 'failed':
      return fa.statusFailed;
    case 'cancelled':
      return fa.statusCancelled;
    default:
      return state;
  }
}

/**
 * Payment card + "send your receipt" instructions right after confirmation.
 * Phase 8C: the card number comes ONLY from the PAYMENT_CARD_NUMBER secret
 * and the bubble is the bot's lone HTML send — values render as tap-to-copy
 * inline code, every dynamic string goes through the escape helper.
 */
export async function sendPaymentInstructions(
  ctx: UpdateContext,
  order: OrderRow,
): Promise<void> {
  const [loaded, card] = await Promise.all([
    loadPaymentInfo(ctx.db),
    Promise.resolve(paymentCardFromEnv(ctx.env)),
  ]);
  if (!loaded.ok) {
    await ctx.api.sendMessage(ctx.chatId, fa.paymentInfoUnavailable, backToMenuKeyboard());
    console.error(`payment_info_unavailable code=${loaded.error.slice(0, 60)}`);
    return;
  }
  if (card === null) {
    // Fail CLOSED: never render a half-instructed payment bubble and never
    // fall back to the settings doc. The secret value is never logged.
    await ctx.api.sendMessage(ctx.chatId, fa.paymentInfoUnavailable, backToMenuKeyboard());
    console.error('payment_card_secret_unconfigured');
    return;
  }
  const { info } = loaded;
  // Phase 7: an order may carry a wallet credit; the payable line below the
  // header is the ORDER AMOUNT column (the checkout already stored the
  // remainder there), so instructions can never quote the pre-credit price.
  const lines = [
    fa.paymentInstructionsHeader,
    fa.paymentHolder(info.holder),
    fa.paymentCard(card),
    ...(info.iban !== null ? [fa.paymentIban(info.iban)] : []),
    fa.paymentAmountLine(formatPrice(order.amount, order.currency)),
    tgEscapeHtml(info.instructions),
    fa.paymentReceiptPrompt,
    fa.copyHint,
  ];
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), backToMenuKeyboard(), 'HTML');
}

function uploaderLabel(ctx: UpdateContext): string {
  const actor = ctx.actor;
  return actor.username
    ? `@${actor.username}`
    : `${actor.first_name ?? 'کاربر'} (${String(actor.id)})`;
}

/**
 * Photo/document received while WAITING_PAYMENT_RECEIPT. The stored order is
 * the authority; the session only points at which order we are talking about.
 */
export async function submitReceipt(
  ctx: UpdateContext,
  session: Session,
  receipt: ReceiptMedia,
): Promise<void> {
  const orderId = session.data['order_id'];
  if (typeof orderId !== 'string' || !isValidOrderId(orderId)) {
    await clearSession(ctx.db, ctx.customerId);
    await ctx.api.sendMessage(ctx.chatId, fa.receiptOrderMissing, backToMenuKeyboard());
    return;
  }

  const result = await submitOrderReceipt(ctx.db, {
    orderId,
    customerId: ctx.customerId,
    receiptFileId: receipt.fileId,
    paymentReference: receipt.reference ?? null,
  });

  if (!result.ok) {
    switch (result.error) {
      case 'not_found':
      case 'owner_mismatch':
      case 'invalid_state': {
        await clearSession(ctx.db, ctx.customerId);
        await ctx.api.sendMessage(ctx.chatId, fa.receiptOrderNotPayable, backToMenuKeyboard());
        return;
      }
      case 'state_changed': {
        // Lost a race: the order moved under us — tell the truth, do nothing.
        const fresh = await getOrderById(ctx.db, orderId);
        await clearSession(ctx.db, ctx.customerId);
        const text =
          fresh && (fresh.state === 'approved' || fresh.state === 'rejected')
            ? fa.receiptOrderNotPayable
            : fa.receiptAccepted;
        await ctx.api.sendMessage(ctx.chatId, text, backToMenuKeyboard());
        return;
      }
    }
    return;
  }

  await forwardReceiptToAdmins(
    ctx.env,
    ctx.db,
    ctx.api,
    result.order,
    receipt,
    uploaderLabel(ctx),
  );
  await ctx.api.sendMessage(
    ctx.chatId,
    result.replaced ? fa.receiptReplaced : fa.receiptAccepted,
    backToMenuKeyboard(),
  );
}

/** `menu:orders` — the customer's own recent orders, rendered from the DB. */
export async function showMyOrders(ctx: UpdateContext): Promise<void> {
  const orders = await listRecentOrdersForCustomer(ctx.db, ctx.customerId, MY_ORDERS_LIMIT);
  if (orders.length === 0) {
    await ctx.api.sendMessage(ctx.chatId, fa.ordersEmpty, backToMenuKeyboard());
    return;
  }
  const lines: string[] = [fa.ordersHeader];
  orders.forEach((order, index) => {
    lines.push(
      fa.ordersEntry(
        index + 1,
        order.id.slice(0, 10),
        statusFa(order.state) + (order.kind === 'renewal' ? ` ${fa.ordersKindRenewal}` : ''),
        formatPrice(order.amount, order.currency),
        order.created_at.slice(0, 10),
      ),
    );
  });
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), backToMenuKeyboard());
}

/** `/pending` — recovery view onto the awaiting_review queue, with buttons. */
export async function showPendingQueue(ctx: UpdateContext): Promise<void> {
  const rows = await listOrdersAwaitingReview(ctx.db, PENDING_QUEUE_LIMIT);
  if (rows.length === 0) {
    await ctx.api.sendMessage(ctx.chatId, fa.adminQueueEmpty);
    return;
  }
  const lines: string[] = [fa.adminQueueHeader];
  rows.forEach((row, index) => {
    const uploader = row.telegram_username
      ? `@${row.telegram_username}`
      : row.telegram_user_id;
    lines.push(
      fa.adminReceiptLine(
        index + 1,
        row.id,
        statusFa(row.state),
        formatPrice(row.amount, row.currency),
        uploader,
      ),
    );
  });
  await ctx.api.sendMessage(
    ctx.chatId,
    lines.join('\n\n'),
    adminQueueKeyboard(rows.map((row) => row.id)),
  );
}
