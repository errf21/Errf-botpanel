/**
 * Phase 8C: payment review reminder sweep. Driven ONLY by the cron-triggered
 * `scheduled` handler (or a direct call from tests) — no webhook path reaches
 * it. Per due order exactly one stage claim can win (atomic UPDATE in
 * `db/paymentReminders.ts`), so overlapping cron runs, manual re-runs and
 * clock-skewed stale invocations can never double-send; a won-then-crashed
 * claim loses at most one nudge (at-most-once is the deliberate tradeoff).
 * Approved/rejected/cancelled orders are filtered INSIDE the claim itself,
 * so a review committing concurrently can never yield a stale reminder.
 */
import type { Env, TelegramApiLike } from '../types.ts';
import { TelegramApi } from '../telegram/api.ts';
import { resolveAdminChatIds } from '../db/customers.ts';
import {
  REMINDER_MAX_STAGE,
  REMINDER_STAGE_MINUTES,
  REMINDER_SWEEP_LIMIT,
  claimStage,
  elapsedMinutes,
  listDueCandidates,
  type ReminderCandidate,
} from '../db/paymentReminders.ts';
import { adminQueueKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { uiFor } from '../telegram/i18n.ts';

export interface SweepResult {
  claimed: number;
  customerMessages: number;
  adminDigests: number;
}

/** 15→stage1, 30→stage2, 45+→stage3 (cap); never early, 0 when not yet due. */
export function dueStageFor(anchorMs: number, nowMs: number): number {
  if (!Number.isFinite(anchorMs) || !Number.isFinite(nowMs)) return 0;
  const minutes = Math.floor((nowMs - anchorMs) / (REMINDER_STAGE_MINUTES * 60_000));
  if (minutes < 1) return 0;
  return Math.min(REMINDER_MAX_STAGE, minutes);
}

function reminderCustomerText(lang: string | null, stage: number, orderId: string): string {
  const t = uiFor(lang).t;
  switch (stage) {
    case 1:
      return t.reminderCustomer1(orderId);
    case 2:
      return t.reminderCustomer2(orderId);
    default:
      return t.reminderCustomer3(orderId);
  }
}

export async function runPaymentReminderSweep(
  env: Env,
  nowMs: number = Date.now(),
  apiOverride?: TelegramApiLike,
): Promise<SweepResult> {
  const db = env.DB;
  const api: TelegramApiLike = apiOverride ?? new TelegramApi(env.TELEGRAM_BOT_TOKEN);
  const result: SweepResult = { claimed: 0, customerMessages: 0, adminDigests: 0 };
  const candidates = await listDueCandidates(db, new Date(nowMs).toISOString(), REMINDER_SWEEP_LIMIT);
  const claimed: Array<{ row: ReminderCandidate; minutes: number }> = [];

  for (const row of candidates) {
    const target = dueStageFor(Date.parse(row.created_at), nowMs);
    if (target <= row.reminded_stage) continue; // includes stale runs (now < t0)
    let won = false;
    try {
      won = await claimStage(db, row.order_id, row.reminded_stage, target);
    } catch {
      // A row-level failure must not abort the rest of the sweep.
      console.error(`payment_reminder_claim_failed orderId=${row.order_id.slice(0, 32)}`);
      continue;
    }
    if (!won) continue; // an overlapping run (or a review) got there first
    claimed.push({ row, minutes: elapsedMinutes(row.created_at, nowMs) });
    const chatId = Number(row.telegram_user_id);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) continue;
    try {
      // Phase 10: the nudge follows the recipient's persisted language.
      await api.sendMessage(chatId, reminderCustomerText(row.language, target, row.order_id));
      result.customerMessages += 1;
    } catch {
      console.error(`payment_reminder_send_failed orderId=${row.order_id.slice(0, 32)}`);
    }
  }

  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  // One consolidated digest per run per admin chat — existing `adm:` buttons,
  // so approvals from here route through the unchanged review path.
  const lines: string[] = [fa.reminderAdminHeader];
  claimed.forEach((entry, index) => {
    lines.push(fa.reminderAdminEntry(index + 1, entry.row.order_id.slice(0, 10), entry.minutes));
  });
  const keyboard = adminQueueKeyboard(claimed.map((entry) => entry.row.order_id));
  const adminChats = await resolveAdminChatIds(env, db);
  for (const chatId of adminChats) {
    try {
      await api.sendMessage(chatId, lines.join('\n'), keyboard);
      result.adminDigests += 1;
    } catch {
      console.error(`payment_reminder_digest_failed chat=${String(chatId).slice(0, 20)}`);
    }
  }
  return result;
}
