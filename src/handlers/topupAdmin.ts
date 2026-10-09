/**
 * Phase 17: admin review for wallet top-ups — the ONLY writer that credits
 * top-up money. Twin of performAdminReview() in src/admin.ts, but fully
 * isolated: no orders, no provisioning, no referrals, no reminders.
 *
 * Approve: guarded pending_review → approved claim, then creditTopupOnce()
 * (exactly-once, NOT EXISTS + UNIQUE backstop, ledger-truth). Duplicate taps
 * converge on already_reviewed without moving money.
 * Reject: guarded pending_review → rejected, zero wallet writes.
 */
import type { Env, TelegramApiLike } from '../types.ts';
import { getCustomerContact } from '../db/customers.ts';
import { getSession, setSession } from '../db/states.ts';
import {
  creditTopupOnce,
  getTopupById,
  guardedTopupTransition,
  type TopupRow,
} from '../db/topups.ts';
import { isValidOrderId, sanitizeRejectionReason } from '../lib/validate.ts';
import { retireAdminMessage } from '../admin.ts';
import { fa } from '../telegram/texts.ts';
import { uiFor } from '../telegram/i18n.ts';

export type TopupDecision = 'approve' | 'reject';

export type TopupReviewResult =
  | { ok: true; topup: TopupRow; credited: boolean }
  | { ok: false; error: 'invalid_id' | 'not_found' | 'already_reviewed' };

async function notifyTopupCustomer(
  db: D1Database,
  api: TelegramApiLike,
  topup: TopupRow,
  decision: TopupDecision,
  reason: string | null,
): Promise<void> {
  const contact = await getCustomerContact(db, topup.customer_id);
  if (!contact) return;
  const chatId = Number(contact.telegram_user_id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return;
  const { t, f } = uiFor(contact.language);
  const text =
    decision === 'approve' && topup.credit_status!=='credited'
      ? contact.language==='en'
        ? `Payment ${topup.id} is approved, but wallet credit is NOT applied. Administrator review/retry is required; you have not been charged again.`
        : `پرداخت ${topup.id} تأیید شده، اما اعتبار کیف پول هنوز اعمال نشده است. بررسی و تلاش مجدد توسط مدیریت لازم است؛ مبلغی دوباره از شما دریافت نشده است.`
      : decision === 'approve'
      ? t.topupApproved(topup.id, f.price(topup.amount_irt, 'IRT'))
      : t.topupRejected(topup.id, reason ?? t.adminRejectDefaultReason);
  await api.sendMessage(chatId, text);
}

/** Clear the customer's top-up session ONLY if it points at this top-up. */
async function clearTopupSessionIfOwned(
  db: D1Database,
  topup: TopupRow,
): Promise<void> {
  try {
    const session = await getSession(db, topup.customer_id);
    if (session.data['topup_id'] === topup.id) {
      await setSession(db, topup.customer_id, 'IDLE', {});
    }
  } catch {
    // Best effort: review outcome never depends on session cleanup.
  }
}

export async function performTopupReview(opts: {
  env: Env;
  db: D1Database;
  api: TelegramApiLike;
  actorId: number;
  topupId: string;
  decision: TopupDecision;
  reason?: string | null;
}): Promise<TopupReviewResult> {
  const { db, api, actorId, topupId } = opts;
  if (!isValidOrderId(topupId)) return { ok: false, error: 'invalid_id' };
  const reason =
    opts.decision === 'reject'
      ? (sanitizeRejectionReason(opts.reason ?? '') ?? fa.adminRejectDefaultReason)
      : null;

  const before=await getTopupById(db,topupId);
  const recoverable=opts.decision==='approve'&&before?.state==='approved'&&['uncredited','blocked'].includes(before.credit_status);
  const result = recoverable ? {ok:true as const,topup:before!} : await guardedTopupTransition(
    db,
    topupId,
    opts.decision === 'approve' ? 'approved' : 'rejected',
    `admin:${String(actorId)}`,
    reason,
  );
  if (!result.ok) {
    if (result.error === 'not_found') return { ok: false, error: 'not_found' };
    return { ok: false, error: 'already_reviewed' };
  }

  let credited = false;
  if (opts.decision === 'approve') {
    const credit = await creditTopupOnce(db, {
      customerId: result.topup.customer_id,
      topupId: result.topup.id,
      amountIrt: result.topup.amount_irt,
      actor: `admin:${String(actorId)}`,
    });
    // creditTopupOnce converges on the winner's ledger row under races; a
    // missing row with an existing customer is unexpected but must not flip
    // the review outcome — the state claim already won exactly once.
    credited = credit.ok;
    if (!credit.ok) {
      console.error(
        `topup_credit_failed topupId=${result.topup.id.slice(0, 32)} reason=${credit.reason}`,
      );
    }
  }

  const topup = (await getTopupById(db, topupId)) ?? result.topup;
  await clearTopupSessionIfOwned(db, topup);
  await notifyTopupCustomer(db, api, topup, opts.decision, reason).catch(() => undefined);
  return { ok: true, topup, credited };
}

/** Shared outcome reporting for tup:ok:/tup:no: button presses. */
export async function finishTopupReview(
  api: TelegramApiLike,
  actorId: number,
  result: TopupReviewResult,
  callbackQueryId: string,
  messageChatId: number | null,
  messageId: number | null,
): Promise<void> {
  if (!result.ok) {
    await api.answerCallbackQuery(
      callbackQueryId,
      result.error === 'not_found' || result.error === 'invalid_id'
        ? fa.invalidChoice
        : fa.adminTopupStaleToast,
      true,
    );
    return;
  }
  const approved = result.topup.state === 'approved';
  if(approved&&!result.credited){await api.answerCallbackQuery(callbackQueryId,'Payment approved; wallet credit NOT applied. Review /topups and retry after resolving the cap/error.',true);return;}
  await api.answerCallbackQuery(
    callbackQueryId,
    approved ? fa.adminTopupApprovedToast : fa.adminTopupRejectedToast,
  );
  await retireAdminMessage(
    api,
    messageChatId,
    messageId,
    approved
      ? fa.adminTopupProcessedApprove(result.topup.id, String(actorId))
      : fa.adminTopupProcessedReject(result.topup.id, String(actorId)),
  );
}
