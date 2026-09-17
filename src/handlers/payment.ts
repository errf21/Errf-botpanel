/**
 * Phase 4 customer + admin-facing pieces that are NOT the review action
 * itself (performAdminReview lives in src/admin.ts). Everything read from a
 * session/callback is re-validated against the DB order; keyboard content
 * never determines what gets stored.
 * Phase 10: customer views render through `ctx.ui`; the `/pending` admin
 * queue is the Persian-only operational surface (operator decision).
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
import { fa, faAdmin } from '../telegram/texts.ts';
import { FA_UI } from '../telegram/i18n.ts';

const MY_ORDERS_LIMIT = 8;
const PENDING_QUEUE_LIMIT = 10;

/**
 * Phase 8C: the seller card is a Worker secret; the bubble is the bot's lone
 * HTML send — values render as tap-to-copy inline code, every dynamic string
 * goes through the escape helper. Phase 10: the STATUS LABEL lives in the
 * bundle now (`t.orderStatus`); both locales reproduce this function's old
 * per-state mapping byte-for-byte in Persian.
 */
export async function sendPaymentInstructions(
  ctx: UpdateContext,
  order: OrderRow,
): Promise<void> {
  const t = ctx.ui.t;
  const f = ctx.ui.f;
  const [loaded, card] = await Promise.all([
    loadPaymentInfo(ctx.db),
    Promise.resolve(paymentCardFromEnv(ctx.env)),
  ]);
  if (!loaded.ok) {
    await ctx.api.sendMessage(ctx.chatId, t.paymentInfoUnavailable, backToMenuKeyboard(ctx.ui));
    console.error(`payment_info_unavailable code=${loaded.error.slice(0, 60)}`);
    return;
  }
  if (card === null) {
    // Fail CLOSED: never render a half-instructed payment bubble and never
    // fall back to the settings doc. The secret value is never logged.
    await ctx.api.sendMessage(ctx.chatId, t.paymentInfoUnavailable, backToMenuKeyboard(ctx.ui));
    console.error('payment_card_secret_unconfigured');
    return;
  }
  const { info } = loaded;
  // Phase 7: an order may carry a wallet credit; the payable line below the
  // header is the ORDER AMOUNT column (the checkout already stored the
  // remainder there), so instructions can never quote the pre-credit price.
  // Payment-copy fix (2026-09): `info.instructions` (admin-authored settings
  // content) is no longer rendered in the customer bubble — the fixed localized
  // wording below is the single source of instruction copy. The stored D1
  // value remains untouched and still validated at parse time.
  const lines = [
    t.paymentInstructionsHeader,
    t.paymentHolder(info.holder),
    t.paymentCard(card),
    ...(info.iban !== null ? [t.paymentIban(info.iban)] : []),
    t.paymentAmountLine(f.price(order.amount, order.currency)),
    t.paymentReceiptPrompt,
    t.paymentCopyHint,
  ];
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), backToMenuKeyboard(ctx.ui), 'HTML');
}

function uploaderLabel(ctx: UpdateContext): string {
  const actor = ctx.actor;
  return actor.username
    ? `@${actor.username}`
    : `${actor.first_name ?? faAdmin.uploaderFallback} (${String(actor.id)})`;
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
  const t = ctx.ui.t;
  const orderId = session.data['order_id'];
  if (typeof orderId !== 'string' || !isValidOrderId(orderId)) {
    await clearSession(ctx.db, ctx.customerId);
    await ctx.api.sendMessage(ctx.chatId, t.receiptOrderMissing, backToMenuKeyboard(ctx.ui));
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
        await ctx.api.sendMessage(ctx.chatId, t.receiptOrderNotPayable, backToMenuKeyboard(ctx.ui));
        return;
      }
      case 'state_changed': {
        // Lost a race: the order moved under us — tell the truth, do nothing.
        const fresh = await getOrderById(ctx.db, orderId);
        await clearSession(ctx.db, ctx.customerId);
        const text =
          fresh && (fresh.state === 'approved' || fresh.state === 'rejected')
            ? t.receiptOrderNotPayable
            : t.receiptAccepted;
        await ctx.api.sendMessage(ctx.chatId, text, backToMenuKeyboard(ctx.ui));
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
    result.replaced ? t.receiptReplaced : t.receiptAccepted,
    backToMenuKeyboard(ctx.ui),
  );
}

/** `menu:orders` — the customer's own recent orders, rendered from the DB. */
export async function showMyOrders(ctx: UpdateContext): Promise<void> {
  const t = ctx.ui.t;
  const f = ctx.ui.f;
  const orders = await listRecentOrdersForCustomer(ctx.db, ctx.customerId, MY_ORDERS_LIMIT);
  if (orders.length === 0) {
    await ctx.api.sendMessage(ctx.chatId, t.ordersEmpty, backToMenuKeyboard(ctx.ui));
    return;
  }
  const lines: string[] = [t.ordersHeader];
  orders.forEach((order, index) => {
    // Phase 18: repurchase rows (kind='renewal' + repurchase_mode) are labeled
    // distinctly from historical renewals.
    const kindSuffix =
      order.kind === 'renewal'
        ? ` ${order.repurchase_mode ? t.ordersKindRepurchase : t.ordersKindRenewal}`
        : '';
    lines.push(
      t.ordersEntry(
        index + 1,
        order.id.slice(0, 10),
        t.orderStatus(order.state) + kindSuffix,
        f.price(order.amount, order.currency),
        order.created_at.slice(0, 10),
      ),
    );
  });
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), backToMenuKeyboard(ctx.ui));
}

/** `/pending` — recovery view onto the awaiting_review queue, with buttons.
 *  Admin-only surface: always Persian (Phase 10 policy). */
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
        FA_UI.t.orderStatus(row.state),
        FA_UI.f.price(row.amount, row.currency),
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
