import { acquireServiceLock,releaseServiceLock } from '../panels/registry.ts';
/**
 * Phase 16 — ADMIN panel-service delete, with an explicit two-step
 * confirmation, and the two passive reconciliation points.
 *
 * Entry points (both gated on `ctx.isAdmin`, same authorization model as
 * /pending, /failed, /tickets):
 *   /panel_del <panel-username | 28-char order-id>  → confirmation card
 *   pdel:ok:<order-id>  → delete on the panel, THEN book `panel_deleted`
 *   pdel:no:<order-id>  → cancel, zero writes
 *
 * Ordering discipline (mirrors provisioning): the panel write comes FIRST
 * and its read-back is the ONLY proof; D1 is stamped exclusively through
 * `markPanelDeleted`, whose guarded UPDATE makes double taps and concurrent
 * admins collapse into exactly one stamp + one audit event. A failed or
 * ambiguous panel delete leaves D1 COMPLETELY untouched (fail closed; the
 * confirmation card survives for a retry). Order/payment/renewal history is
 * never deleted — the terminal `panel_deleted` disposition is additive.
 *
 * Passive reconciliation (the service was removed directly on the panel):
 * a customer live-refresh observing 404 and the usage sweep observing 404
 * both stamp the same disposition with 'system:<observer>' as the actor —
 * they never call the panel themselves.
 */
import type { UpdateContext } from '../types.ts';
import {
  findActiveRenewalForService,
  getOrderById,
  getOrderByPanelUsername,
  markPanelDeleted,
  type OrderRow,
} from '../db/orders.ts';
import { getCustomerContact } from '../db/customers.ts';
import { deletePanelService } from '../provision/provision.ts';
import { isValidOrderId, type PanelDeleteCallback } from '../lib/validate.ts';
import { panelDeleteConfirmKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { uiFor } from '../telegram/i18n.ts';
import { orderSummaryLines } from '../admin.ts';
import { serviceSnapshotData } from './services.ts';

/** The panel username an admin typed on the command line. */
const USERNAME_ARG = /^[a-z0-9]{3,32}$/;

export function normalizePanelUsername(raw: string): string | null {
  const lowered = raw.trim().toLowerCase();
  return USERNAME_ARG.test(lowered) ? lowered : null;
}

/** Deletable = a linked purchase service whose disposition is not final yet. */
function deletableService(order: OrderRow | null): order is OrderRow {
  return (
    order !== null &&
    order.kind === 'purchase' &&
    order.pasarguard_username !== null &&
    order.panel_deleted_at === null &&
    (order.state === 'completed' || order.state === 'failed')
  );
}

/** `/panel_del <arg>` — ONLY called with ctx.isAdmin already true. */
export async function handlePanelDeleteCommand(
  ctx: UpdateContext,
  rawArg: string,
): Promise<void> {
  if (!ctx.isAdmin) return; // defense in depth (commands.ts gates first)
  const arg = rawArg.trim();
  if (arg === '') {
    await ctx.api.sendMessage(ctx.chatId, fa.pdlUsage);
    return;
  }
  let order: OrderRow | null = null;
  if (isValidOrderId(arg)) {
    order = await getOrderById(ctx.db, arg);
  } else {
    const username = normalizePanelUsername(arg);
    if (username !== null) order = await getOrderByPanelUsername(ctx.db, username);
  }
  if (order !== null && order.panel_deleted_at !== null && order.kind === 'purchase') {
    await ctx.api.sendMessage(ctx.chatId, fa.pdlAlready);
    return;
  }
  if (!deletableService(order)) {
    await ctx.api.sendMessage(ctx.chatId, fa.pdlNotFound);
    return;
  }
  const contact = await getCustomerContact(ctx.db, order.customer_id);
  const snapshot = serviceSnapshotData(order);
  const active = await findActiveRenewalForService(ctx.db, order.id);
  const lines = [
    fa.adminPdlConfirmHeader(order.id),
    `👤 ${order.pasarguard_username ?? '—'}`,
    ...(snapshot.name !== null ? [`📦 ${snapshot.name}`] : []),
    fa.adminPdlCustomer(
      contact !== null ? contact.telegram_user_id : `#${String(order.customer_id)}`,
    ),
    `📌 ${order.state}`,
    ...(active !== null ? [fa.svcPendingRenewal(active.id.slice(0, 10))] : []),
    fa.adminPdlWarning,
  ];
  await ctx.api.sendMessage(ctx.chatId, lines.join('\n\n'), panelDeleteConfirmKeyboard(order.id));
}

/** `pdel:no:<id>` and `pdel:ok:<id>` — admin re-checked by the ROUTER. */
export async function handlePanelDeleteCallback(
  ctx: UpdateContext,
  parsed: PanelDeleteCallback,
  callbackQueryId: string,
  messageChatId: number | null,
  messageId: number | null,
): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.invalidChoice, true);
    return;
  }
  if (!isValidOrderId(parsed.orderId)) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.invalidChoice, true);
    return;
  }
  if (parsed.action === 'no') {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.pdlCancelled);
    await retireCard(ctx, messageChatId, messageId, fa.pdlCancelled);
    return;
  }

  const order = await getOrderById(ctx.db, parsed.orderId);
  if (order === null) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.pdlNotFound, true);
    return;
  }
  if (
    order.kind !== 'purchase' ||
    order.pasarguard_username === null ||
    (order.state !== 'completed' && order.state !== 'failed')
  ) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.pdlNotFound, true);
    return;
  }
  if (order.panel_deleted_at !== null) {
    // Concurrent admin already booked it — idempotent: same final card, zero
    // panel calls (the other tap's delete already proved the state).
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.pdlAlready, true);
    await retireCard(ctx, messageChatId, messageId, fa.pdlAlready);
    return;
  }
  const username = order.pasarguard_username;

  const owner=crypto.randomUUID();
  if (!await acquireServiceLock(ctx.db,order.id,owner)) {
    await ctx.api.answerCallbackQuery(callbackQueryId,'Service operation in progress; retry later.',true);return;
  }
  try {
  const latest = await getOrderById(ctx.db,order.id);
  if (!latest || latest.panel_id!==order.panel_id || latest.pasarguard_user_id!==order.pasarguard_user_id || latest.pasarguard_username!==username) {
    await ctx.api.answerCallbackQuery(callbackQueryId,'Service changed; reopen the service.',true);return;
  }
  const panel = await deletePanelService(ctx.env, username, order);
  if (!panel.ok) {
    // FAIL CLOSED: D1 state, history and the row stay untouched beyond one
    // edit — the card is RE-SENT with the same buttons so the admin can
    // retry; the sanitized panel reason is visible to this admin only.
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.pdlToastFailed, true);
    if (messageChatId !== null && messageId !== null) {
      await ctx.api.editMessageText(
        messageChatId,
        messageId,
        fa.adminPdlFailed(order.id, panel.reason),
        panelDeleteConfirmKeyboard(order.id),
      );
    }
    return;
  }
  const marked = await markPanelDeleted(ctx.db, {
    orderId: order.id,
    panelUsername: username,
    via: `admin:${String(ctx.actor.id)}`,
  });
  if (!marked.ok && marked.error === 'not_found') {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.pdlNotFound, true);
    return;
  }
  const cardText = panel.alreadyGone
    ? fa.adminPdlAlreadyGone(order.id)
    : marked.ok
      ? fa.adminPdlDone(order.id)
      : fa.pdlAlready; // raced double-book: another tap stamped + notified
  await ctx.api.answerCallbackQuery(callbackQueryId, fa.pdlToastDone);
  await retireCard(ctx, messageChatId, messageId, cardText);
  if (marked.ok) await notifyCustomerOfRevocation(ctx, order);
  } finally { await releaseServiceLock(ctx.db,order.id,owner); }
}

/** Best-effort, recipient-language notice; never fails the admin flow. */
async function notifyCustomerOfRevocation(
  ctx: UpdateContext,
  order: OrderRow,
): Promise<void> {
  try {
    const contact = await getCustomerContact(ctx.db, order.customer_id);
    if (contact === null) return;
    const chatId = Number(contact.telegram_user_id);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) return;
    const snapshot = serviceSnapshotData(order);
    const ui = uiFor(contact.language);
    await ctx.api.sendMessage(
      chatId,
      ui.t.serviceRevokedNotice(snapshot.name ?? order.id.slice(0, 10)),
    );
  } catch {
    console.error(`panel_delete_notice_failed orderId=${order.id.slice(0, 32)}`);
  }
}

/** Neutralize the confirmation card after a decision (mirrors retireAdminMessage). */
async function retireCard(
  ctx: UpdateContext,
  messageChatId: number | null,
  messageId: number | null,
  text: string,
): Promise<void> {
  if (messageChatId === null || messageId === null) return;
  await ctx.api.editMessageText(messageChatId, messageId, text);
}
