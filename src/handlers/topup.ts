/**
 * Phase 17: customer wallet top-up flow — isolated from orders.
 *
 * Path: wallet view → `top:start` → WAITING_TOPUP_AMOUNT (free text) →
 * payment instructions → WAITING_TOPUP_RECEIPT (photo/document) →
 * wallet_topups.pending_review → admin `tup:ok:/tup:no:` review.
 *
 * Isolation contract: this module never writes orders/order_events, never
 * calls provisioning, referrals, reminders or renewals. Money moves only in
 * db/topups.ts creditTopupOnce() (called from the admin review path).
 * Sales stop blocks every step (UI hides the button; server re-checks before
 * any write). Wallet kill-switch degrades to walletUnavailable, same as the
 * existing wallet view.
 */
import type { UpdateContext } from '../types.ts';
import type { Session } from '../db/states.ts';
import { getSession, setSession } from '../db/states.ts';
import { reduce } from '../state/machine.ts';
import { loadWalletConfig } from '../catalog/wallet.ts';
import { loadPaymentInfo, paymentCardFromEnv } from '../catalog/payment.ts';
import { isSalesStopped } from '../catalog/sales.ts';
import { newOrderId } from '../lib/security.ts';
import {
  MIN_TOPUP_IRT,
  isValidOrderId,
  parseTopupAmount,
  type ReceiptMedia,
} from '../lib/validate.ts';
import {
  createTopupRequest,
  findTopupByIdempotencyKey,
  getTopupById,
  submitTopupReceipt as commitTopupReceipt,
} from '../db/topups.ts';
import { resolveAdminChatIds } from '../db/customers.ts';
import {
  backToMenuKeyboard,
  composingKeyboard,
  mainMenuKeyboard,
  topupReviewKeyboard,
} from '../telegram/menu.ts';
import { fa, faAdmin } from '../telegram/texts.ts';
import { FA_UI, uiFor } from '../telegram/i18n.ts';

const TOPUP_QUEUE_LIMIT = 10;

function minTopupLabel(ctx: UpdateContext): string {
  return ctx.ui.f.price(MIN_TOPUP_IRT, 'IRT');
}

/** Entry guard shared by the callback tap and any resume path. */
async function topupBlockedReason(ctx: UpdateContext): Promise<'wallet' | 'sales' | null> {
  const loaded = await loadWalletConfig(ctx.db);
  if (!loaded.ok || !loaded.config.enabled) return 'wallet';
  if (await isSalesStopped(ctx.db)) return 'sales';
  return null;
}

/**
 * `top:start` — mint (or reuse) the session token and ask for the amount.
 * The token doubles as the wallet_topups.idempotency_key, so retried taps
 * can never create two request rows.
 */
export async function handleTopupStart(
  ctx: UpdateContext,
  session: Session,
  callbackQueryId: string,
): Promise<void> {
  const blocked = await topupBlockedReason(ctx);
  if (blocked === 'sales') {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.salesStoppedNotice, mainMenuKeyboard(ctx.ui));
    await ctx.api.answerCallbackQuery(callbackQueryId);
    return;
  }
  if (blocked === 'wallet') {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.walletUnavailable, backToMenuKeyboard(ctx.ui));
    await ctx.api.answerCallbackQuery(callbackQueryId);
    return;
  }
  if (session.state !== 'IDLE' && session.state !== 'WAITING_TOPUP_AMOUNT') {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.staleChoice, true);
    return;
  }
  const token =
    typeof session.data['topup_token'] === 'string' && session.data['topup_token'] !== ''
      ? (session.data['topup_token'] as string)
      : newOrderId();
  await setSession(ctx.db, ctx.customerId, reduce('IDLE', 'topup_start'), {
    ...session.data,
    topup_token: token,
  });
  await ctx.api.answerCallbackQuery(callbackQueryId);
  await ctx.api.sendMessage(
    ctx.chatId,
    ctx.ui.t.topupPromptAmount(minTopupLabel(ctx)),
    composingKeyboard(ctx.ui),
  );
}

/**
 * Free text while WAITING_TOPUP_AMOUNT: validate → create/reuse the request
 * row → payment instructions → WAITING_TOPUP_RECEIPT.
 */
export async function handleTopupAmountText(
  ctx: UpdateContext,
  session: Session,
  text: string,
): Promise<void> {
  const t = ctx.ui.t;
  const blocked = await topupBlockedReason(ctx);
  if (blocked === 'sales') {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.salesStoppedNotice, mainMenuKeyboard(ctx.ui));
    return;
  }
  if (blocked === 'wallet') {
    await ctx.api.sendMessage(ctx.chatId, t.walletUnavailable, backToMenuKeyboard(ctx.ui));
    return;
  }
  const token = session.data['topup_token'];
  if (session.state !== 'WAITING_TOPUP_AMOUNT' || typeof token !== 'string' || token === '') {
    await ctx.api.sendMessage(ctx.chatId, t.topupReceiptMissing, backToMenuKeyboard(ctx.ui));
    return;
  }
  const parsed = parseTopupAmount(text);
  if (parsed === null) {
    await ctx.api.sendMessage(ctx.chatId, t.topupAmountInvalid, composingKeyboard(ctx.ui));
    return;
  }
  if (parsed < MIN_TOPUP_IRT) {
    await ctx.api.sendMessage(
      ctx.chatId,
      t.topupAmountTooSmall(ctx.ui.f.price(MIN_TOPUP_IRT, 'IRT')),
      composingKeyboard(ctx.ui),
    );
    return;
  }
  const loaded = await loadWalletConfig(ctx.db);
  if (!loaded.ok || !loaded.config.enabled) {
    await ctx.api.sendMessage(ctx.chatId, t.walletUnavailable, backToMenuKeyboard(ctx.ui));
    return;
  }
  if (parsed > loaded.config.maxCreditIrt) {
    await ctx.api.sendMessage(
      ctx.chatId,
      t.topupAmountTooBig(ctx.ui.f.price(loaded.config.maxCreditIrt, 'IRT')),
      composingKeyboard(ctx.ui),
    );
    return;
  }
  // Reuse on token hit (retried submit): never two rows per token.
  const preExisting = await findTopupByIdempotencyKey(ctx.db, token);
  let topupId: string;
  let amount = parsed;
  if (preExisting) {
    if (preExisting.customer_id !== ctx.customerId) {
      await ctx.api.sendMessage(ctx.chatId, t.topupReceiptMissing, backToMenuKeyboard(ctx.ui));
      return;
    }
    topupId = preExisting.id;
    amount = preExisting.amount_irt;
    // Amount change on the same token before any receipt: keep the FIRST
    // committed amount (idempotency over editability) — resend instructions.
  } else {
    try {
      const { topup } = await createTopupRequest(ctx.db, {
        customerId: ctx.customerId,
        amountIrt: parsed,
        idempotencyKey: token,
      });
      topupId = topup.id;
      amount = topup.amount_irt;
    } catch {
      await ctx.api.sendMessage(ctx.chatId, t.walletUnavailable, backToMenuKeyboard(ctx.ui));
      return;
    }
  }
  await setSession(ctx.db, ctx.customerId, 'WAITING_TOPUP_RECEIPT', {
    ...session.data,
    topup_token: token,
    topup_id: topupId,
    topup_amount: amount,
  });
  await sendTopupInstructions(ctx, amount);
}

/**
 * Payment instructions for a top-up amount. Reuses the configured
 * payment_info doc + PAYMENT_CARD_NUMBER secret; fails closed exactly like
 * the order instructions bubble (never renders half-configured details).
 */
export async function sendTopupInstructions(
  ctx: UpdateContext,
  amountIrt: number,
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
    await ctx.api.sendMessage(ctx.chatId, t.paymentInfoUnavailable, backToMenuKeyboard(ctx.ui));
    console.error('payment_card_secret_unconfigured');
    return;
  }
  const { info } = loaded;
  const lines = [
    t.paymentInstructionsHeader,
    t.paymentHolder(info.holder),
    t.paymentCard(card),
    ...(info.iban !== null ? [t.paymentIban(info.iban)] : []),
    t.topupAmountLine(f.price(amountIrt, 'IRT')),
    t.topupReceiptPrompt,
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
 * Photo/document received while WAITING_TOPUP_RECEIPT. The stored
 * wallet_topups row is the authority; the session only points at it.
 */
export async function submitTopupReceiptInput(
  ctx: UpdateContext,
  session: Session,
  receipt: ReceiptMedia,
): Promise<void> {
  const t = ctx.ui.t;
  const blocked = await topupBlockedReason(ctx);
  if (blocked === 'sales') {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.salesStoppedNotice, mainMenuKeyboard(ctx.ui));
    return;
  }
  if (blocked === 'wallet') {
    await ctx.api.sendMessage(ctx.chatId, t.walletUnavailable, backToMenuKeyboard(ctx.ui));
    return;
  }
  const topupId = session.data['topup_id'];
  if (typeof topupId !== 'string' || !isValidOrderId(topupId)) {
    await ctx.api.sendMessage(ctx.chatId, t.topupReceiptMissing, backToMenuKeyboard(ctx.ui));
    return;
  }
  const result = await commitTopupReceipt(ctx.db, {
    topupId,
    customerId: ctx.customerId,
    receiptFileId: receipt.fileId,
    receiptKind: receipt.kind,
    paymentReference: receipt.reference ?? null,
  });
  if (!result.ok) {
    switch (result.error) {
      case 'not_found':
      case 'owner_mismatch':
      case 'invalid_state': {
        await ctx.api.sendMessage(ctx.chatId, t.topupNotPayable, backToMenuKeyboard(ctx.ui));
        return;
      }
      case 'state_changed': {
        const fresh = await getTopupById(ctx.db, topupId);
        await ctx.api.sendMessage(
          ctx.chatId,
          fresh && fresh.state === 'pending_review' ? t.topupSubmitted(fresh.id) : t.topupNotPayable,
          backToMenuKeyboard(ctx.ui),
        );
        return;
      }
    }
    return;
  }
  await forwardTopupToAdmins(ctx, result.topup.id, receipt, uploaderLabel(ctx));
  await ctx.api.sendMessage(
    ctx.chatId,
    result.replaced ? t.topupReceiptReplaced(result.topup.id) : t.topupSubmitted(result.topup.id),
    backToMenuKeyboard(ctx.ui),
  );
}

/**
 * Forward a top-up receipt to every admin chat with review buttons.
 * DB state is already committed; the /topups queue is the recovery path.
 */
export async function forwardTopupToAdmins(
  ctx: UpdateContext,
  topupId: string,
  receipt: ReceiptMedia,
  uploader: string,
): Promise<boolean> {
  const topup = await getTopupById(ctx.db, topupId);
  if (!topup) return false;
  const chatIds = await resolveAdminChatIds(ctx.env, ctx.db);
  if (chatIds.length === 0) return false;
  const lines = [
    fa.adminTopupHeader,
    `🆔 ${topup.id}`,
    fa.summaryPrice(FA_UI.f.price(topup.amount_irt, 'IRT')),
    faAdmin.payerLine(uploader),
  ];
  if (topup.payment_reference) lines.push(fa.paymentReferenceLine(topup.payment_reference));
  const caption = lines.join('\n').slice(0, 1000);
  let delivered = false;
  for (const chatId of chatIds) {
    const send =
      receipt.kind === 'document'
        ? ctx.api.sendDocument(chatId, receipt.fileId, caption, topupReviewKeyboard(topup.id))
        : ctx.api.sendPhoto(chatId, receipt.fileId, caption, topupReviewKeyboard(topup.id));
    if (await send) delivered = true;
  }
  return delivered;
}

/** `/topups` — admin-only recovery view onto the pending_review queue. */
export async function showTopupQueue(ctx: UpdateContext): Promise<void> {
  const { listPendingTopups } = await import('../db/topups.ts');
  const { topupQueueKeyboard } = await import('../telegram/menu.ts');
  const rows = await listPendingTopups(ctx.db, TOPUP_QUEUE_LIMIT);
  if (rows.length === 0) {
    await ctx.api.sendMessage(ctx.chatId, fa.adminTopupQueueEmpty);
    return;
  }
  const lines: string[] = [fa.adminTopupHeader, fa.adminTopupQueueHeader];
  rows.forEach((row, index) => {
    const uploader = row.telegram_username
      ? `@${row.telegram_username}`
      : String(row.telegram_user_id);
    lines.push(
      `${index + 1}. 🆔 ${row.id}\n   ${FA_UI.f.price(row.amount_irt, 'IRT')} — ${faAdmin.payerLine(uploader)}${row.state==='approved'?`\n   Credit NOT applied (${row.credit_status}); Approve retries credit only.`:''}`,
    );
  });
  await ctx.api.sendMessage(
    ctx.chatId,
    lines.join('\n\n'),
    topupQueueKeyboard(rows.map((row) => row.id)),
  );
}

/** Re-read helper for stale-session resume paths. */
export async function resumeTopup(ctx: UpdateContext): Promise<void> {
  const session: Session = await getSession(ctx.db, ctx.customerId);
  if (session.state === 'WAITING_TOPUP_AMOUNT') {
    await ctx.api.sendMessage(
      ctx.chatId,
      ctx.ui.t.topupPromptAmount(minTopupLabel(ctx)),
      composingKeyboard(ctx.ui),
    );
    return;
  }
  if (session.state === 'WAITING_TOPUP_RECEIPT') {
    await ctx.api.sendMessage(ctx.chatId, ctx.ui.t.topupWaitNotice, backToMenuKeyboard(ctx.ui));
    return;
  }
}
