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
import { isValidOrderId, type ReceiptMedia } from './lib/validate.ts';
import { adminReceiptKeyboard } from './telegram/menu.ts';
import { fa, formatPrice } from './telegram/texts.ts';

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

/** Server-side rendering of an order for admin review (snapshot is trusted). */
export function orderSummaryLines(order: OrderRow): string[] {
  const snapshot = parseSnapshot(order);
  const price = formatPrice(order.amount, order.currency);
  const lines = [
    `🆔 ${order.id}`,
    fa.summaryPrice(price),
  ];
  // Phase 6: renewals must be unmistakable in the review queue / forwards.
  if (order.kind === 'renewal') {
    const serviceId =
      typeof snapshot['renews_order_id'] === 'string' ? snapshot['renews_order_id'] : '—';
    lines.push(fa.adminRenewalKind(serviceId));
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
    `پرداخت‌کننده: ${uploader}`,
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

/** Proactive result notice to the customer. Failures are logged, not fatal. */
async function notifyCustomerOfReview(
  db: D1Database,
  api: TelegramApiLike,
  order: OrderRow,
  decision: ReviewDecision,
  reason: string | null,
): Promise<void> {
  const contact = await getCustomerContact(db, order.customer_id);
  if (!contact) return;
  const chatId = Number(contact.telegram_user_id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return;
  const text =
    decision === 'approve'
      ? order.kind === 'renewal'
        ? fa.notifyApprovedRenewal(order.id, formatPrice(order.amount, order.currency))
        : fa.notifyApproved(order.id, formatPrice(order.amount, order.currency))
      : fa.notifyRejected(order.id, reason ?? fa.adminRejectDefaultReason);
  await api.sendMessage(chatId, text);
}

/**
 * The one admin write path: guarded transition → session reset → customer
 * notice → (on approval) provisioning. `actorId` is taken from the verified
 * callback/text sender only. Phase 5: an approved order is fed to
 * `provisionOrder`, which stays a strict no-op until the panel + provisioning
 * document are configured, so approvals before Phase 5 wiring remain inert.
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

  const result =
    opts.decision === 'approve'
      ? await approveOrderByAdmin(db, orderId, String(actorId))
      : await rejectOrderByAdmin(db, orderId, String(actorId), opts.reason ?? null);

  if (!result.ok) {
    if (result.error === 'not_found') return { ok: false, error: 'not_found' };
    return { ok: false, error: 'already_reviewed' };
  }

  const order = await getOrderById(db, orderId);
  if (!order) return { ok: false, error: 'not_found' };

  // The customer's receipt-waiting conversation is over either way.
  await clearSession(db, order.customer_id);
  await notifyCustomerOfReview(db, api, order, opts.decision, opts.reason ?? null);

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
    // Defer past the webhook ACK in production; inline in tests/harnesses.
    if (opts.waitUntil) opts.waitUntil(provisioning);
    else await provisioning;
  }

  return { ok: true, order };
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
