/**
 * Admin surface (Phase 4): authorization, receipt forwarding, review actions,
 * customer notices. Every state change goes through the guarded transitions
 * in `db/orders.ts` — double-taps and races can never process an order twice.
 * No PasarGuard call happens here (or anywhere in Phase 4).
 */
import type { Env, TelegramApiLike } from './types.ts';
import {
  getCustomerContact,
  isAdminUserId,
  resolveAdminChatIds,
} from './db/customers.ts';
import { clearSession } from './db/states.ts';
import {
  approveOrderByAdmin,
  getOrderById,
  rejectOrderByAdmin,
  type OrderRow,
} from './db/orders.ts';
import { provisionOrder } from './provision/provision.ts';
import { payReferrerIfDue } from './lib/referralPayout.ts';
import { isValidOrderId, type ReceiptMedia } from './lib/validate.ts';
import { adminReceiptKeyboard } from './telegram/menu.ts';
import { fa, faAdmin } from './telegram/texts.ts';
import { FA_UI, uiFor } from './telegram/i18n.ts';

/** ADMIN_CHAT_ID env OR customers.is_admin — never anything else. */
export async function resolveIsAdmin(
  env: Env,
  db: D1Database,
  actorId: number,
): Promise<boolean> {
  const configured = env.ADMIN_CHAT_ID?.trim() ?? '';
  if (configured !== '' && configured === String(actorId)) return true;
  return isAdminUserId(db, actorId);
}

function parseSnapshot(order: OrderRow): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(order.selections);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Wallet credit stored in the order snapshot (0 when the order is plain). */
export function walletCreditFromOrder(order: OrderRow): number {
  const wallet = parseSnapshot(order)['wallet'];
  if (typeof wallet === 'object' && wallet !== null && !Array.isArray(wallet)) {
    const credit = (wallet as Record<string, unknown>)['credit_irt'];
    if (typeof credit === 'number' && Number.isSafeInteger(credit) && credit > 0) {
      return credit;
    }
  }
  return 0;
}

/** Server-side rendering of an order for admin review (snapshot is trusted). */
export function orderSummaryLines(order: OrderRow): string[] {
  const snapshot = parseSnapshot(order);
  const price = FA_UI.f.price(order.amount, order.currency);
  const lines = [
    `🆔 ${order.id}`,
    fa.summaryPrice(price),
  ];
  // Phase 6: renewals must be unmistakable in the review queue / forwards.
  // Phase 18: repurchase rows (kind='renewal' + snapshot.kind='repurchase')
  // render as repurchases — never confused with historical renewals.
  if (order.kind === 'renewal' && snapshot['kind'] === 'repurchase') {
    const serviceId =
      typeof snapshot['repurchases_order_id'] === 'string'
        ? snapshot['repurchases_order_id']
        : typeof snapshot['renews_order_id'] === 'string'
          ? snapshot['renews_order_id']
          : '—';
    lines.push(fa.adminRepurchaseKind(serviceId));
    lines.push(fa.ordersKindRepurchase);
    const gb = snapshot['volume_gb'];
    const days = snapshot['duration_days'];
    const devices = snapshot['device_count'];
    const snapshotPrice = snapshot['price'];
    const months =
      snapshotPrice && typeof snapshotPrice === 'object'
        ? (snapshotPrice as Record<string, unknown>)['months']
        : undefined;
    const cfgName = snapshot['config_name'];
    if (typeof gb === 'number') lines.push(fa.summaryVolume(gb));
    if (typeof days === 'number') {
      lines.push(fa.summaryDuration(days, typeof months === 'number' ? months : 1));
    }
    if (typeof devices === 'number') lines.push(fa.summaryDevices(devices));
    if (typeof cfgName === 'string') lines.push(fa.summaryName(cfgName));
    return lines;
  }
  if (order.kind === 'renewal') {
    const serviceId =
      typeof snapshot['renews_order_id'] === 'string' ? snapshot['renews_order_id'] : '—';
    lines.push(fa.adminRenewalKind(serviceId));
    const days = snapshot['duration_days'];
    const addedGb = snapshot['added_volume_gb'];
    const cfgName = snapshot['config_name'];
    if (typeof days === 'number') {
      const price = snapshot['price'];
      const months =
        price && typeof price === 'object'
          ? (price as Record<string, unknown>)['months']
          : undefined;
      lines.push(fa.summaryDuration(days, typeof months === 'number' ? months : 0));
    }
    if (typeof addedGb === 'number' && addedGb > 0) lines.push(fa.summaryVolume(addedGb));
    if (typeof cfgName === 'string') lines.push(fa.summaryName(cfgName));
    return lines;
  }
  const name = snapshot['config_name'];
  const gb = snapshot['volume_gb'];
  const days = snapshot['duration_days'];
  const devices = snapshot['device_count'];
  const snapshotPrice = snapshot['price'];
  const months =
    snapshotPrice && typeof snapshotPrice === 'object'
      ? (snapshotPrice as Record<string, unknown>)['months']
      : undefined;
  if (typeof name === 'string') lines.push(fa.summaryName(name));
  if (typeof gb === 'number' && typeof days === 'number' && typeof devices === 'number') {
    lines.push(fa.summaryVolume(gb));
    lines.push(fa.summaryDuration(days, typeof months === 'number' ? months : 1));
    lines.push(fa.summaryDevices(devices));
  }
  return lines;
}

/**
 * Forward a receipt (photo/document) to every admin chat with review buttons.
 * Returns whether at least one admin was reached (DB state is already
 * committed regardless — the queue command is the recovery path).
 */
export async function forwardReceiptToAdmins(
  env: Env,
  db: D1Database,
  api: TelegramApiLike,
  order: OrderRow,
  receipt: ReceiptMedia,
  uploader: string,
): Promise<boolean> {
  const chatIds = await resolveAdminChatIds(env, db);
  if (chatIds.length === 0) return false;
  const lines = [
    fa.adminReceiptHeader,
    ...orderSummaryLines(order),
    faAdmin.payerLine(uploader),
  ];
  if (order.payment_reference) lines.push(fa.paymentReferenceLine(order.payment_reference));
  const caption = lines.join('\n').slice(0, 1000);
  let delivered = false;
  for (const chatId of chatIds) {
    const send =
      receipt.kind === 'document'
        ? api.sendDocument(chatId, receipt.fileId, caption, adminReceiptKeyboard(order.id))
        : api.sendPhoto(chatId, receipt.fileId, caption, adminReceiptKeyboard(order.id));
    // Truthy means Telegram accepted the send (boolean or Message).
    if (await send) delivered = true;
  }
  return delivered;
}

export type ReviewDecision = 'approve' | 'reject';

export type ReviewResult =
  | { ok: true; order: OrderRow }
  | { ok: false; error: 'invalid_id' | 'not_found' | 'already_reviewed' };

/** Proactive result notice to the customer. Failures are logged, not fatal.
 *  Returns whether a wallet refund was applied (for the admin line). */
async function notifyCustomerOfReview(
  db: D1Database,
  api: TelegramApiLike,
  order: OrderRow,
  decision: ReviewDecision,
  reason: string | null,
): Promise<boolean> {
  const contact = await getCustomerContact(db, order.customer_id);
  if (!contact) return false;
  const chatId = Number(contact.telegram_user_id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return false;
  // Phase 10: review results are CUSTOMER notices — language follows the
  // recipient. The rejection reason itself is admin-authored content and is
  // delivered verbatim.
  const { t, f } = uiFor(contact.language);
  const snapshot = parseSnapshot(order);
  const isRepurchase = order.kind === 'renewal' && snapshot['kind'] === 'repurchase';
  const text =
    decision === 'approve'
      ? isRepurchase
        ? t.notifyApprovedRepurchase(order.id, f.price(order.amount, order.currency))
        : order.kind === 'renewal'
          ? t.notifyApprovedRenewal(order.id, f.price(order.amount, order.currency))
          : t.notifyApproved(order.id, f.price(order.amount, order.currency))
      // The admin's typed reason is authored content — verbatim; only the
      // built-in default reason localizes with the recipient.
      : t.notifyRejected(order.id, reason ?? t.adminRejectDefaultReason);
  await api.sendMessage(chatId, text);
  return true;
}

/**
 * The one admin write path: guarded transition → session reset → customer
 * notice → (on approval) provisioning. `actorId` is taken from the verified
 * callback/text sender only. Phase 5: an approved order is fed to
 * `provisionOrder`, which stays a strict no-op until the panel + provisioning
 * document are configured, so approvals before Phase 5 wiring remain inert.
 * Phase 7 additions, both inside the SAME guarded-transaction philosophy:
 *  - approve → referral payout attempt (exactly-once via referral_rewards);
 *  - reject  → wallet credit applied to this order is refunded inside the
 *    reject batch and the customer is told.
 */
export async function performAdminReview(opts: {
  env: Env;
  db: D1Database;
  api: TelegramApiLike;
  actorId: number;
  orderId: string;
  decision: ReviewDecision;
  reason?: string | null;
  waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<ReviewResult> {
  const { db, api, actorId, orderId } = opts;
  if (!isValidOrderId(orderId)) return { ok: false, error: 'invalid_id' };

  const preImage = opts.decision === 'approve' ? null : await getOrderById(db, orderId);
  const creditIrt = preImage !== null ? walletCreditFromOrder(preImage) : 0;

  const result =
    opts.decision === 'approve'
      ? await approveOrderByAdmin(db, orderId, String(actorId))
      : await rejectOrderByAdmin(
          db,
          orderId,
          String(actorId),
          opts.reason ?? null,
          preImage && creditIrt > 0
            ? { customerId: preImage.customer_id, amountIrt: creditIrt }
            : undefined,
        );

  if (!result.ok) {
    if (result.error === 'not_found') return { ok: false, error: 'not_found' };
    return { ok: false, error: 'already_reviewed' };
  }

  const order = await getOrderById(db, orderId);
  if (!order) return { ok: false, error: 'not_found' };

  // The customer's receipt-waiting conversation is over either way.
  await clearSession(db, order.customer_id);
  await notifyCustomerOfReview(db, api, order, opts.decision, opts.reason ?? null);
  if (opts.decision === 'reject' && creditIrt > 0) {
    await notifyWalletRefunded(db, api, order, creditIrt).catch(() => undefined);
  }

  if (opts.decision === 'approve') {
    const provisioning = provisionOrder(
      { env: opts.env, db, api },
      { orderId: order.id },
    ).then((outcome) => {
      if (!outcome.ok && 'skip' in outcome) {
        console.log(`provision_skipped orderId=${order.id.slice(0, 32)} reason=${outcome.skip}`);
      }
      return outcome;
    });
    const payout = payReferrerIfDue(db, api, order, `admin:${String(actorId)}`);
    // Defer past the webhook ACK in production; inline in tests/harnesses.
    if (opts.waitUntil) {
      opts.waitUntil(provisioning);
      opts.waitUntil(payout);
    } else {
      await Promise.all([provisioning, payout]);
    }
  }

  return { ok: true, order };
}

/** Second notice on a rejected order that carried wallet credit. */
async function notifyWalletRefunded(
  db: D1Database,
  api: TelegramApiLike,
  order: OrderRow,
  creditIrt: number,
): Promise<void> {
  const contact = await getCustomerContact(db, order.customer_id);
  const chatId = Number(contact?.telegram_user_id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return;
  const ui = uiFor(contact?.language);
  await api.sendMessage(chatId, ui.t.notifyWalletRefunded(order.id, ui.f.price(creditIrt, 'IRT')));
}

/**
 * Neutralize the admin message that carried the action buttons (forwarded
 * media caption first, plain-text queue message as fallback).
 */
export async function retireAdminMessage(
  api: TelegramApiLike,
  chatId: number | null,
  messageId: number | null,
  text: string,
): Promise<void> {
  if (chatId === null || messageId === null) return;
  const captionEdited = await api.editMessageCaption(chatId, messageId, text);
  if (!captionEdited) await api.editMessageText(chatId, messageId, text);
}
