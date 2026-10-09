import { getOrderById } from '../db/orders.ts';
/**
 * Phase 9: service notification sweep. Driven ONLY by the cron-triggered
 * `scheduled` handler (or tests with an explicit now). Independent legs:
 *
 *  1. expiring — pure D1 bookkeeping (service_expires_at is authoritative
 *     local record, forward-only); the 3-day window is evaluated locally;
 *     the panel is NEVER required for this leg. PAID ONLY.
 *  2. Phase 15 free-test expiry — a dedicated once-only notice for a claimed
 *     test order in its final 2 hours (+30-min post-expiry catch-up grace);
 *     the paid legs structurally skip claimed orders so these never cross
 *     over.
 *  3. usage90 — PAID ONLY; needs one live panel read per service (used vs
 *     total bytes); strictly bounded: ≤ USAGE_CHECK_LIMIT GETs per run +
 *     ≥ 60-min per-service backoff. Fail-closed when the panel is
 *     unconfigured.
 *  4. Phase 15b free_test_usage90 — TEST ONLY, isolated leg/budget mirroring
 *     usage90 at >=90% with MB-level remaining.
 *  5. Phase 15b free_test_exhausted — TEST ONLY, isolated leg/budget at
 *     used >= limit. Distinct PK row from usage90, so both can fire
 *     independently for one service.
 *
 * Exactly-once mechanics: the (order_id, kind) PK row is birthed by
 * `ensurePending`, claimed as a single lease-guarded UPDATE, sent, and only
 * THEN booked `sent`. Overlapping/replayed/stale runs converge on one winner;
 * a won-then-crashed claim is retried after the 30-min lease — the one
 * accepted duplicate window is a crash between Telegram-accept and the book
 * write (see README §Service notifications). Terminal sent/skipped/failed
 * rows leave the candidate set forever, so expired/gone/blocked services can
 * never loop. Telegram delivery success is detected the same way Phase 7
 * announcements do: a non-null send result.
 */
import type { Env, TelegramApiLike, NoticeKind } from '../types.ts';
import { TelegramApi } from '../telegram/api.ts';
import { resolveServicePanel,clientFor,acquireServiceLock,releaseServiceLock } from '../panels/registry.ts';
import { fa } from '../telegram/texts.ts';
import { FA_UI, uiFor } from '../telegram/i18n.ts';
import { serviceNoticeKeyboard } from '../telegram/menu.ts';
import { GB_BYTES } from '../provision/provision.ts';
import { MB_BYTES } from '../catalog/freeTest.ts';
import { markPanelDeleted } from '../db/orders.ts';
import {
  EXPIRY_NOTICE_DAYS,
  EXPIRY_SWEEP_LIMIT,
  FREE_TEST_EXHAUSTED_CHECK_LIMIT,
  FREE_TEST_EXPIRY_GRACE_MINUTES,
  FREE_TEST_NOTICE_HOURS,
  FREE_TEST_USAGE_CHECK_LIMIT,
  USAGE_CHECK_LIMIT,
  USAGE_THRESHOLD_RATIO,
  bookSent,
  claimNotice,
  ensurePending,
  listExpiryCandidates,
  listFreeTestExhaustedCandidates,
  listFreeTestExpiryCandidates,
  listFreeTestUsageCandidates,
  listUsageCandidates,
  markSkipped,
  releaseFailedSend,
  stampUsageCheck,
  type NoticeCandidate,
} from '../db/serviceNotifications.ts';

const DAY_MS = 86_400_000;

export interface ServiceNoticeSweepResult {
  expirySent: number;
  usageSent: number;
  /** Phase 15: free-test dedicated expiry notices (own 2h window + grace, paid legs skip tests). */
  freeTestSent: number;
  /** Phase 15b: free-test 90% usage notices (isolated leg/budget). */
  freeTestUsageSent: number;
  /** Phase 15b: free-test quota-exhausted notices (isolated leg/budget). */
  freeTestExhaustedSent: number;
  /** Panel answered "this service is gone / usage terminal" (settled). */
  skipped: number;
  /** Claims won whose Telegram send failed (already returned to retry). */
  sendFailed: number;
}

/** Exact gate for the expiry leg (SQL carries 1-min slack; this never lies). */
export function expiryNoticeDue(expiresIso: string | null, nowMs: number): boolean {
  if (expiresIso === null) return false;
  const expires = Date.parse(expiresIso);
  if (!Number.isFinite(expires) || !Number.isFinite(nowMs)) return false;
  return expires > nowMs && expires - nowMs <= EXPIRY_NOTICE_DAYS * DAY_MS;
}

/** Exact gate for the free-test leg: the 2-hour pre-expiry window plus a
 *  30-minute post-expiry catch-up grace (one missed 5-minute sweep cannot
 *  lose the notice forever). Upper bound unchanged; paid 3-day leg untouched. */
export function freeTestExpiryDue(expiresIso: string | null, nowMs: number): boolean {
  if (expiresIso === null) return false;
  const expires = Date.parse(expiresIso);
  if (!Number.isFinite(expires) || !Number.isFinite(nowMs)) return false;
  return (
    expires > nowMs - FREE_TEST_EXPIRY_GRACE_MINUTES * 60_000 &&
    expires - nowMs <= FREE_TEST_NOTICE_HOURS * 3_600_000
  );
}

export type UsageDecision =
  | { kind: 'due'; percent: number; remainingGb: number; remainingMb: number }
  | { kind: 'not_yet' }
  | { kind: 'not_evaluable' }; // unlimited cap / unknown usage

export type ExhaustedDecision =
  | { kind: 'due' }
  | { kind: 'not_yet' }
  | { kind: 'not_evaluable' }; // unlimited cap / unknown usage

/** Pure byte math on panel values already coerced by the client. */
export function usageNoticeDecision(
  usedBytes: number | null,
  limitBytes: number | null,
): UsageDecision {
  if (usedBytes === null || limitBytes === null || limitBytes <= 0) {
    return { kind: 'not_evaluable' };
  }
  const ratio = usedBytes / limitBytes;
  if (ratio < USAGE_THRESHOLD_RATIO) return { kind: 'not_yet' };
  return {
    kind: 'due',
    percent: Math.min(99, Math.floor(ratio * 100)),
    remainingGb: Math.max(0, Math.round(((limitBytes - usedBytes) / GB_BYTES) * 10) / 10),
    remainingMb: Math.max(0, Math.round(((limitBytes - usedBytes) / MB_BYTES) * 10) / 10),
  };
}

/** Binary quota-exhausted gate on live panel bytes (>= counts, above too). */
export function freeTestExhaustedDue(
  usedBytes: number | null,
  limitBytes: number | null,
): ExhaustedDecision {
  if (usedBytes === null || limitBytes === null || limitBytes <= 0) {
    return { kind: 'not_evaluable' };
  }
  return usedBytes >= limitBytes ? { kind: 'due' } : { kind: 'not_yet' };
}

/** «2 روز و 11 ساعت» / «کمتر از یک ساعت» — bounded by the 3-day window.
 *  Thin fa alias of the bundle formatter (Phase 10); English users get the
 *  sibling formatter via `uiFor(row.language).f.remainingUntil`. */
export function remainingUntilFa(expiresIso: string, nowMs: number): string {
  return FA_UI.f.remainingUntil(expiresIso, nowMs);
}

/** ISO date + UTC time, ASCII digits (display rule: English digits everywhere). */
export function expiryDateTimeFa(expiresIso: string): string {
  return FA_UI.f.dateTime(expiresIso);
}

/** Config name from the immutable selections snapshot: display-safe text. */
export function noticeServiceName(selections: string, fallback?: string): string {
  const name = fallback ?? fa.noticeServiceFallback;
  let raw: string | null = null;
  try {
    const parsed: unknown = JSON.parse(selections);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>)['config_name'];
      if (typeof value === 'string') raw = value;
    }
  } catch {
    raw = null;
  }
  if (raw === null) return name;
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64) || name;
}

function chatIdOf(row: NoticeCandidate): number {
  return Number(row.telegram_user_id);
}

async function sendAndBook(
  db: D1Database,
  api: TelegramApiLike,
  row: NoticeCandidate,
  kind: NoticeKind,
  nowIso: string,
  text: string,
): Promise<'sent' | 'failed'> {
  // The claim was already won; this is the only send path for the notice.
  // An unconvertible chat id counts as a failed send: it burns an attempt and
  // eventually rests terminal ('failed') — unreachable chats never loop.
  const chatId = chatIdOf(row);
  let delivered = false;
  if (Number.isSafeInteger(chatId) && chatId > 0) {
    // Phase 10: the notice follows the RECIPIENT's persisted language.
    const buttons = serviceNoticeKeyboard(uiFor(row.language), row.order_id);
    try {
      delivered = (await api.sendMessage(chatId, text, buttons)) !== null;
    } catch {
      delivered = false;
    }
  }
  if (delivered) {
    await bookSent(db, { orderId: row.order_id, kind, nowIso });
    return 'sent';
  }
  await releaseFailedSend(db, { orderId: row.order_id, kind, nowIso });
  return 'failed';
}

export async function runServiceNotificationSweep(
  env: Env,
  nowMs: number = Date.now(),
  apiOverride?: TelegramApiLike,
): Promise<ServiceNoticeSweepResult> {
  const db = env.DB;
  const api: TelegramApiLike = apiOverride ?? new TelegramApi(env.TELEGRAM_BOT_TOKEN);
  const nowIso = new Date(nowMs).toISOString();
  const result: ServiceNoticeSweepResult = {
    expirySent: 0,
    usageSent: 0,
    freeTestSent: 0,
    freeTestUsageSent: 0,
    freeTestExhaustedSent: 0,
    skipped: 0,
    sendFailed: 0,
  };

  /* ———— leg 1: expiry (never touches the panel) ———— */
  let expiryCandidates: NoticeCandidate[] = [];
  try {
    expiryCandidates = await listExpiryCandidates(db, nowIso, EXPIRY_SWEEP_LIMIT);
  } catch {
    console.error('service_notice_expiry_query_failed');
  }
  for (const row of expiryCandidates) {
    try {
      if (row.service_expires_at === null) continue;
      if (!expiryNoticeDue(row.service_expires_at, nowMs)) continue;
      await ensurePending(db, row.order_id, 'expiring');
      if (!(await claimNotice(db, { orderId: row.order_id, kind: 'expiring', nowIso }))) {
        continue; // overlapping run won, or eligibility changed
      }
      const ui = uiFor(row.language);
      const text = ui.t.expiryNotice(
        noticeServiceName(row.selections, ui.t.noticeServiceFallback),
        ui.f.remainingUntil(row.service_expires_at, nowMs),
        ui.f.dateTime(row.service_expires_at),
      );
      const outcome = await sendAndBook(db, api, row, 'expiring', nowIso, text);
      if (outcome === 'sent') {
        result.expirySent += 1;
      } else {
        result.sendFailed += 1;
        console.error(`service_notice_send_failed orderId=${row.order_id.slice(0, 32)}`);
      }
    } catch {
      console.error(`service_notice_row_failed orderId=${row.order_id.slice(0, 32)}`);
    }
  }

  /* ———— leg 1b: free-test expiry (Phase 15, pure D1, never the panel) ————
   * A dedicated, once-only notice ~2h before the test's expiry (+30-min
   * post-expiry catch-up grace). Fully separate kind/PK row from the paid
   * set, and the paid legs structurally skip claimed orders, so a test
   * never double-notifies and a paid service never sees this copy. Same
   * lease/claim/book mechanics as the other legs. */
  let freeTestCandidates: NoticeCandidate[] = [];
  try {
    freeTestCandidates = await listFreeTestExpiryCandidates(db, nowIso, EXPIRY_SWEEP_LIMIT);
  } catch {
    console.error('service_notice_freetest_query_failed');
  }
  for (const row of freeTestCandidates) {
    try {
      if (row.service_expires_at === null) continue;
      if (!freeTestExpiryDue(row.service_expires_at, nowMs)) continue;
      await ensurePending(db, row.order_id, 'free_test_expiring');
      if (
        !(await claimNotice(db, { orderId: row.order_id, kind: 'free_test_expiring', nowIso }))
      ) {
        continue; // overlapping run won, or eligibility changed
      }
      const ui = uiFor(row.language);
      const text = ui.t.freeTestExpiryNotice(
        noticeServiceName(row.selections, ui.t.noticeServiceFallback),
        ui.f.remainingUntil(row.service_expires_at, nowMs),
        ui.f.dateTime(row.service_expires_at),
      );
      const outcome = await sendAndBook(db, api, row, 'free_test_expiring', nowIso, text);
      if (outcome === 'sent') {
        result.freeTestSent += 1;
      } else {
        result.sendFailed += 1;
        console.error(`service_notice_send_failed orderId=${row.order_id.slice(0, 32)}`);
      }
    } catch {
      console.error(`service_notice_row_failed orderId=${row.order_id.slice(0, 32)}`);
    }
  }

  /* ———— leg 2: usage90 (panel-backed, fail-closed + bounded) ———— */
  let usageCandidates: NoticeCandidate[] = [];
  try {
    usageCandidates = await listUsageCandidates(db, nowIso, USAGE_CHECK_LIMIT);
  } catch {
    console.error('service_notice_usage_query_failed');
    return result;
  }
  for (const row of usageCandidates) {
    const readOwner=crypto.randomUUID();
    if(!await acquireServiceLock(db,row.order_id,readOwner))continue;
    const current=await getOrderById(db,row.order_id);
    if(!current || current.panel_deleted_at){await releaseServiceLock(db,row.order_id,readOwner);continue;}
    row.panel_id=current.panel_id??null;row.pasarguard_user_id=current.pasarguard_user_id;
    row.pasarguard_username=current.pasarguard_username;
    const username = row.pasarguard_username;
    if (username === null) {await releaseServiceLock(db,row.order_id,readOwner);continue;} // cannot happen (query), but never guess
    try {
      const panel=row.panel_id ? await resolveServicePanel(env,current) : null;
      if (!panel?.ok) { await stampUsageCheck(db,{orderId:row.order_id,kind:'usage90',nowIso}); continue; }
      const read = await clientFor(panel.config,row.pasarguard_user_id).getUserByUsername(username);
      if (!read.ok) {
        if (read.kind === 'not_found') {
          // Genuinely deleted on the panel: terminal, stops the poll loop.
          // Phase 16: the same confirmed observation also reconciles the
          // order row itself to the `panel_deleted` disposition (guarded,
          // exactly-once — concurrent observers collapse).
          await markSkipped(db, { orderId: row.order_id, kind: 'usage90', nowIso });
          await markPanelDeleted(db, {
            orderId: row.order_id,
            panelUsername: username,
            via: 'system:notice-sweep',
          });
          result.skipped += 1;
        } else {
          // Transient (network/5xx/auth): back off, retry a later run.
          await stampUsageCheck(db, { orderId: row.order_id, nowIso });
        }
        continue;
      }
      if (read.data === null || read.data.status === 'expired') {
        // Gone or lifetime-expired: terminal. 'disabled'/'on_hold' are NOT —
        // an admin block can lift, and the eligibility window (service still
        // un-expired + 60-min backoff) already bounds that polling anyway.
        await markSkipped(db, { orderId: row.order_id, kind: 'usage90', nowIso });
        result.skipped += 1;
        continue;
      }
      const decision = usageNoticeDecision(read.data.usedTraffic, read.data.dataLimit);
      if (decision.kind !== 'due') {
        // 'not_yet' and 'not_evaluable' (unlimited/unknown) rest in backoff;
        // never an error, never an attempt.
        await stampUsageCheck(db, { orderId: row.order_id, nowIso });
        continue;
      }
      await ensurePending(db, row.order_id, 'usage90');
      if (!(await claimNotice(db, { orderId: row.order_id, kind: 'usage90', nowIso }))) {
        continue;
      }
      const ui = uiFor(row.language);
      const text = ui.t.usageNotice(
        noticeServiceName(row.selections, ui.t.noticeServiceFallback),
        ui.f.digits(decision.percent),
        ui.f.digits(decision.remainingGb),
      );
      const outcome = await sendAndBook(db, api, row, 'usage90', nowIso, text);
      if (outcome === 'sent') {
        result.usageSent += 1;
      } else {
        result.sendFailed += 1;
        console.error(`service_notice_send_failed orderId=${row.order_id.slice(0, 32)}`);
      }
    } catch {
      console.error(`service_notice_row_failed orderId=${row.order_id.slice(0, 32)}`);
    } finally {await releaseServiceLock(db,row.order_id,readOwner);}
  }

  /* Trial legs keep independent budgets and notice claims. Their fresh remote
   * snapshot is shared ONLY inside one service lease in this sweep. */
  let trialUsageCandidates: NoticeCandidate[] = [], exhaustedCandidates: NoticeCandidate[] = [];
  try { trialUsageCandidates = await listFreeTestUsageCandidates(db,nowIso,FREE_TEST_USAGE_CHECK_LIMIT); }
  catch { console.error('service_notice_freetest_usage_query_failed'); }
  try { exhaustedCandidates = await listFreeTestExhaustedCandidates(db,nowIso,FREE_TEST_EXHAUSTED_CHECK_LIMIT); }
  catch { console.error('service_notice_freetest_exhausted_query_failed'); }
  const trials = new Map<string,{row:NoticeCandidate;kinds:('free_test_usage90'|'free_test_exhausted')[]}>();
  for (const [rows,kind] of [[trialUsageCandidates,'free_test_usage90'],[exhaustedCandidates,'free_test_exhausted']] as const) {
    for (const row of rows) {
      const entry = trials.get(row.order_id) ?? {row,kinds:[]};
      entry.kinds.push(kind); trials.set(row.order_id,entry);
    }
  }
  for (const {row,kinds} of trials.values()) {
    const owner=crypto.randomUUID();
    if (!await acquireServiceLock(db,row.order_id,owner)) continue;
    try {
      const current=await getOrderById(db,row.order_id);
      if (!current || current.panel_deleted_at || !current.pasarguard_username) continue;
      row.panel_id=current.panel_id??null; row.pasarguard_user_id=current.pasarguard_user_id;
      row.pasarguard_username=current.pasarguard_username;
      const panel=current.panel_id ? await resolveServicePanel(env,current) : null;
      const read=panel?.ok ? await clientFor(panel.config,current.pasarguard_user_id).getUserByUsername(current.pasarguard_username) : null;
      // Nothing carrying this observation survives the finally/lease boundary.
      for (const kind of kinds) {
        if (!read || !read.ok) {
          if (read && !read.ok && read.kind==='not_found') {
            await markSkipped(db,{orderId:row.order_id,kind,nowIso}); result.skipped++;
          } else await stampUsageCheck(db,{orderId:row.order_id,kind,nowIso});
          continue;
        }
        if (!read.data || read.data.status==='expired') {
          await markSkipped(db,{orderId:row.order_id,kind,nowIso}); result.skipped++; continue;
        }
        const decision=kind==='free_test_usage90' ? usageNoticeDecision(read.data.usedTraffic,read.data.dataLimit)
          : freeTestExhaustedDue(read.data.usedTraffic,read.data.dataLimit);
        if (decision.kind!=='due') { await stampUsageCheck(db,{orderId:row.order_id,kind,nowIso}); continue; }
        await ensurePending(db,row.order_id,kind);
        if (!await claimNotice(db,{orderId:row.order_id,kind,nowIso})) continue;
        const ui=uiFor(row.language),name=noticeServiceName(row.selections,ui.t.noticeServiceFallback);
        const usage=usageNoticeDecision(read.data.usedTraffic,read.data.dataLimit);
        const text=kind==='free_test_usage90' && usage.kind==='due'
          ? ui.t.freeTestUsageNotice(name,ui.f.digits(usage.percent),ui.f.digits(usage.remainingMb))
          : ui.t.freeTestExhaustedNotice(name);
        const outcome=await sendAndBook(db,api,row,kind,nowIso,text);
        if (outcome==='sent') {
          if (kind==='free_test_usage90') result.freeTestUsageSent++; else result.freeTestExhaustedSent++;
        } else { result.sendFailed++; console.error(`service_notice_send_failed orderId=${row.order_id.slice(0,32)}`); }
      }
      if (read && !read.ok && read.kind==='not_found') await markPanelDeleted(db,{
        orderId:row.order_id,panelUsername:current.pasarguard_username,via:'system:notice-sweep',
      });
    } catch { console.error(`service_notice_row_failed orderId=${row.order_id.slice(0,32)}`); }
    finally { await releaseServiceLock(db,row.order_id,owner); }
  }
  return result;
}
