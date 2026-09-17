/**
 * Phase 9: service notification schedules. Exactly one row per
 * (service order, kind) — the composite PK IS the once-per-service promise.
 * Every state change is a single guarded statement: D1/SQLite linearizes
 * writes, so overlapping cron runs, replays and stale invocations produce
 * exactly one claim winner per notice, and terminal rows (sent/skipped/failed)
 * leave the candidate set forever — no notification loops for expired,
 * deleted or unrecoverable services.
 *
 * Phase 15 splits the audience WITHOUT touching the paid mechanics: paid
 * services keep the 'usage90' + 'expiring' set (both candidate queries and
 * both fused claims exclude claimed test orders via NOT EXISTS on
 * free_test_claims — the claims table is the authority, never the JSON
 * snapshot); a free-test service gets instead exactly one
 * 'free_test_expiring' notice inside the 2-hour window before expiry.
 * Phase 15b adds two further test-only kinds ('free_test_usage90' at >=90%
 * of the live panel quota, 'free_test_exhausted' at used >= limit), each
 * with its own isolated candidate query, fused-claim branch and per-run
 * budget — the paid pools are never shared, starved or re-gated.
 *
 * Claim uses a LEASE (30 min) instead of 8C's fire-and-forget stage bump:
 * a notice that never gets sent is worse than the (self-healing, one-shot)
 * worst-case duplicate, so `sent` is only ever written AFTER Telegram
 * confirmed the delivery, and a crashed holder's claim becomes re-claimable
 * once the lease goes stale. `attempts` only counts won claims whose Telegram
 * send failed — capped, then terminal 'failed'.
 */
import type { NoticeKind } from '../types.ts';

export const USAGE_THRESHOLD_RATIO = 0.9;
export const EXPIRY_NOTICE_DAYS = 3;
/** Phase 15: the free test's single, dedicated expiry notice window. */
export const FREE_TEST_NOTICE_HOURS = 2;
/** Phase 15b: catch-up grace after test expiry (missed-window safety). */
export const FREE_TEST_EXPIRY_GRACE_MINUTES = 30;
/** Expiry candidates per run (pure D1 gating — no panel reads). */
export const EXPIRY_SWEEP_LIMIT = 25;
/** Panel reads per run: bounds wall-clock/panel load hard. */
export const USAGE_CHECK_LIMIT = 8;
/** Phase 15b: per-run panel-read budgets for the two isolated test legs. */
export const FREE_TEST_USAGE_CHECK_LIMIT = 8;
export const FREE_TEST_EXHAUSTED_CHECK_LIMIT = 8;
export const NOTICE_MAX_ATTEMPTS = 4;
/** A 'sending' claim is only abandoned after this many minutes. */
export const NOTICE_STALE_MINUTES = 30;
/** Do not re-poll the panel for one service more often than this. */
export const USAGE_BACKOFF_MINUTES = 60;

export interface NoticeCandidate {
  order_id: string;
  customer_id: number;
  telegram_user_id: string;
  /** Phase 10: explicit language choice of the recipient (NULL = Persian). */
  language: string | null;
  /** Local expiry of record (0006) — never null for expiry candidates. */
  service_expires_at: string | null;
  pasarguard_username: string | null;
  /** Immutable selections snapshot (config name for the notice copy). */
  selections: string;
}

/**
 * Eligibility is FUSED into the claim so the candidate list is only a
 * pre-filter: a renewal that lands between listing and claiming can make the
 * service ineligible and the claim then simply loses (0 changes) — it can
 * never notice a service out of its window or a non-completed one.
 * `?6` is the clock, `?7` the window length in days; a trailing +1 minute
 * keeps julianday float noise from delaying a due notice.
 *
 * PAID legs (usage90/expiring) carry NOT EXISTS free_test_claims: the test
 * audience is structurally removed from them, both at list AND at claim.
 * The test legs carry the mirrored EXISTS and their own windows/budgets.
 * 'free_test_expiring' additionally carries a 30-minute post-expiry grace
 * (list + claim + handler gate) so a missed 5-minute sweep inside the
 * narrow 2h window still catches up once instead of going silent forever.
 */
function eligibilitySql(kind: NoticeKind): string {
  if (kind === 'expiring') {
    return `EXISTS (
         SELECT 1 FROM orders o
          WHERE o.id = service_notifications.order_id
            AND o.kind = 'purchase' AND o.state = 'completed'
            AND o.service_expires_at IS NOT NULL
            AND julianday(o.service_expires_at) > julianday(?6)
            AND julianday(o.service_expires_at)
                <= julianday(?6) + ?7 + 1.0 / 1440.0
            AND NOT EXISTS (
              SELECT 1 FROM free_test_claims f
               WHERE f.order_id = service_notifications.order_id
            )
       )`;
  }
  if (kind === 'free_test_expiring') {
    return `EXISTS (
         SELECT 1 FROM orders o
          WHERE o.id = service_notifications.order_id
            AND o.kind = 'purchase' AND o.state = 'completed'
            AND o.service_expires_at IS NOT NULL
            AND julianday(o.service_expires_at) > julianday(?6) - ?8 / 1440.0
            AND julianday(o.service_expires_at)
                <= julianday(?6) + ?7 + 1.0 / 1440.0
            AND EXISTS (
              SELECT 1 FROM free_test_claims f
               WHERE f.order_id = service_notifications.order_id
            )
       )`;
  }
  if (kind === 'free_test_usage90' || kind === 'free_test_exhausted') {
    return `EXISTS (
         SELECT 1 FROM orders o
          WHERE o.id = service_notifications.order_id
            AND o.kind = 'purchase' AND o.state = 'completed'
            AND o.pasarguard_username IS NOT NULL
            AND (o.service_expires_at IS NULL
                 OR julianday(o.service_expires_at) > julianday(?6))
            AND EXISTS (
              SELECT 1 FROM free_test_claims f
               WHERE f.order_id = service_notifications.order_id
            )
       )`;
  }
  // usage90
  return `EXISTS (
         SELECT 1 FROM orders o
          WHERE o.id = service_notifications.order_id
            AND o.kind = 'purchase' AND o.state = 'completed'
            AND o.pasarguard_username IS NOT NULL
            AND (o.service_expires_at IS NULL
                 OR julianday(o.service_expires_at) > julianday(?6))
            AND NOT EXISTS (
              SELECT 1 FROM free_test_claims f
               WHERE f.order_id = service_notifications.order_id
            )
       )`;
}

/**
 * Completed purchases whose ONE-TIME expiry notice is not settled yet.
 * Due window: now < expiry <= now + 3d (the 2-day line never matters: the
 * single notice fires on the first sweep that finds the service inside the
 * window — 3d OR 2d, whichever check reaches first, and never a second one).
 * A 1-minute SQL slack keeps float noise from delaying; handler gating is exact.
 * Phase 15: claimed test orders are excluded here (and at the fused claim) —
 * the free test has its own dedicated notice, never the paid expiry set.
 */
export async function listExpiryCandidates(
  db: D1Database,
  nowIso: string,
  limit: number,
): Promise<NoticeCandidate[]> {
  const result = await db
    .prepare(
      `SELECT o.id AS order_id, o.customer_id, c.telegram_user_id, c.language,
              o.service_expires_at, o.pasarguard_username, o.selections
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
        WHERE o.kind = 'purchase'
          AND o.state = 'completed'
          AND o.panel_deleted_at IS NULL
          AND o.service_expires_at IS NOT NULL
          AND julianday(o.service_expires_at) > julianday(?1)
          AND julianday(o.service_expires_at)
              <= julianday(?1) + ?2 + 1.0 / 1440.0
          AND NOT EXISTS (
            SELECT 1 FROM free_test_claims f WHERE f.order_id = o.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM service_notifications sn
             WHERE sn.order_id = o.id AND sn.kind = 'expiring'
               AND ( sn.status IN ('sent','skipped','failed')
                  OR (sn.status = 'sending'
                      AND julianday(sn.updated_at) > julianday(?1) - ?4 / 1440.0) )
          )
        ORDER BY o.service_expires_at ASC
        LIMIT ?3`,
    )
    .bind(nowIso, EXPIRY_NOTICE_DAYS, limit, NOTICE_STALE_MINUTES)
    .all<NoticeCandidate>();
  return result.results;
}

/**
 * Phase 15: the free test's dedicated leg — completed CLAIMED orders whose
 * expiry falls inside the next 2 hours (plus a 30-minute post-expiry grace
 * so one missed 5-minute sweep cannot lose the notice forever), without a
 * settled 'free_test_expiring' notice. Mirror image of the paid expiry
 * query (same lease/staleness semantics, EXISTS on free_test_claims instead
 * of NOT EXISTS); pure D1 gating, the panel is never read for this send.
 */
export async function listFreeTestExpiryCandidates(
  db: D1Database,
  nowIso: string,
  limit: number,
): Promise<NoticeCandidate[]> {
  const result = await db
    .prepare(
      `SELECT o.id AS order_id, o.customer_id, c.telegram_user_id, c.language,
              o.service_expires_at, o.pasarguard_username, o.selections
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
        WHERE o.kind = 'purchase'
          AND o.state = 'completed'
          AND o.panel_deleted_at IS NULL
          AND o.service_expires_at IS NOT NULL
          AND julianday(o.service_expires_at) > julianday(?1) - ?5 / 1440.0
          AND julianday(o.service_expires_at)
              <= julianday(?1) + ?2 / 24.0 + 1.0 / 1440.0
          AND EXISTS (
            SELECT 1 FROM free_test_claims f WHERE f.order_id = o.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM service_notifications sn
             WHERE sn.order_id = o.id AND sn.kind = 'free_test_expiring'
               AND ( sn.status IN ('sent','skipped','failed')
                  OR (sn.status = 'sending'
                      AND julianday(sn.updated_at) > julianday(?1) - ?4 / 1440.0) )
          )
        ORDER BY o.service_expires_at ASC
        LIMIT ?3`,
    )
    .bind(nowIso, FREE_TEST_NOTICE_HOURS, limit, NOTICE_STALE_MINUTES, FREE_TEST_EXPIRY_GRACE_MINUTES)
    .all<NoticeCandidate>();
  return result.results;
}

/**
 * Completed, panel-addressed services still due for at least one usage poll:
 * no settled row, no fresh (non-stale) 'sending' lease owned by a
 * concurrent/stuck run, and not polled within the backoff window. Soonest
 * expiring first, id as the deterministic tiebreaker.
 * Phase 15: claimed test orders never take usage polls (their panel budget
 * is 100 MB for a day — the test gets the dedicated expiry notice instead).
 */
export async function listUsageCandidates(
  db: D1Database,
  nowIso: string,
  limit: number,
): Promise<NoticeCandidate[]> {
  const result = await db
    .prepare(
      `SELECT o.id AS order_id, o.customer_id, c.telegram_user_id, c.language,
              o.service_expires_at, o.pasarguard_username, o.selections
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
        WHERE o.kind = 'purchase'
          AND o.state = 'completed'
          AND o.panel_deleted_at IS NULL
          AND o.pasarguard_username IS NOT NULL
          AND (o.service_expires_at IS NULL
               OR julianday(o.service_expires_at) > julianday(?1))
          AND NOT EXISTS (
            SELECT 1 FROM free_test_claims f WHERE f.order_id = o.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM service_notifications sn
             WHERE sn.order_id = o.id AND sn.kind = 'usage90'
               AND ( sn.status IN ('sent','skipped','failed')
                  OR (sn.status = 'sending'
                      AND julianday(sn.updated_at) > julianday(?1) - ?2 / 1440.0)
                  OR (sn.status = 'pending'
                      AND sn.last_checked_at IS NOT NULL
                      AND julianday(sn.last_checked_at) > julianday(?1) - ?3 / 1440.0) )
          )
        ORDER BY (o.service_expires_at IS NULL) ASC, o.service_expires_at ASC, o.id ASC
        LIMIT ?4`,
    )
    .bind(nowIso, NOTICE_STALE_MINUTES, USAGE_BACKOFF_MINUTES, limit)
    .all<NoticeCandidate>();
  return result.results;
}

/**
 * Phase 15b: free-test usage polls — completed CLAIMED, panel-addressed
 * test orders still due for at least one usage poll for `kind`. Isolated
 * per-kind candidate set (own PK rows, own backoff/lease tracking) with an
 * independent per-run budget, so the paid usage90 pool is never shared or
 * starved. Unexpired services only (same guard as the paid usage leg).
 */
function freeTestUsageCandidatesSql(kind: NoticeKind): string {
  void kind;
  return `SELECT o.id AS order_id, o.customer_id, c.telegram_user_id, c.language,
              o.service_expires_at, o.pasarguard_username, o.selections
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
        WHERE o.kind = 'purchase'
          AND o.state = 'completed'
          AND o.panel_deleted_at IS NULL
          AND o.pasarguard_username IS NOT NULL
          AND (o.service_expires_at IS NULL
               OR julianday(o.service_expires_at) > julianday(?1))
          AND EXISTS (
            SELECT 1 FROM free_test_claims f WHERE f.order_id = o.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM service_notifications sn
             WHERE sn.order_id = o.id AND sn.kind = ?5
               AND ( sn.status IN ('sent','skipped','failed')
                  OR (sn.status = 'sending'
                      AND julianday(sn.updated_at) > julianday(?1) - ?2 / 1440.0)
                  OR (sn.status = 'pending'
                      AND sn.last_checked_at IS NOT NULL
                      AND julianday(sn.last_checked_at) > julianday(?1) - ?3 / 1440.0) )
          )
        ORDER BY (o.service_expires_at IS NULL) ASC, o.service_expires_at ASC, o.id ASC
        LIMIT ?4`;
}

export async function listFreeTestUsageCandidates(
  db: D1Database,
  nowIso: string,
  limit: number,
): Promise<NoticeCandidate[]> {
  const result = await db
    .prepare(freeTestUsageCandidatesSql('free_test_usage90'))
    .bind(nowIso, NOTICE_STALE_MINUTES, USAGE_BACKOFF_MINUTES, limit, 'free_test_usage90')
    .all<NoticeCandidate>();
  return result.results;
}

export async function listFreeTestExhaustedCandidates(
  db: D1Database,
  nowIso: string,
  limit: number,
): Promise<NoticeCandidate[]> {
  const result = await db
    .prepare(freeTestUsageCandidatesSql('free_test_exhausted'))
    .bind(nowIso, NOTICE_STALE_MINUTES, USAGE_BACKOFF_MINUTES, limit, 'free_test_exhausted')
    .all<NoticeCandidate>();
  return result.results;
}

/** Birth of a schedule row: never overwrites anything (PK = promise). */
export async function ensurePending(
  db: D1Database,
  orderId: string,
  kind: NoticeKind,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO service_notifications (order_id, kind) VALUES (?1, ?2)`,
    )
    .bind(orderId, kind)
    .run();
}

/**
 * The single atomic lease claim (pending-or-stale-sending -> sending).
 * ?1 = nowIso (fresh lease stamp + staleness clock + eligibility clock via
 * ?6), ?2 attempts cap, ?3 stale minutes, ?4 order, ?5 kind, ?7 expiring
 * window days, ?8 free-test expiry grace minutes. changes>0 means THIS run
 * owns the one send for this notice.
 */
export async function claimNotice(
  db: D1Database,
  opts: { orderId: string; kind: NoticeKind; nowIso: string },
): Promise<boolean> {
  const updated = await db
    .prepare(
      `UPDATE service_notifications
          SET status = 'sending', updated_at = ?1
        WHERE order_id = ?4 AND kind = ?5
          AND attempts < ?2
          AND ( status = 'pending'
                OR (status = 'sending'
                    AND julianday(updated_at)
                        <= julianday(?1) - ?3 / 1440.0) )
          AND ${eligibilitySql(opts.kind)}`,
    )
    .bind(
      opts.nowIso,
      NOTICE_MAX_ATTEMPTS,
      NOTICE_STALE_MINUTES,
      opts.orderId,
      opts.kind,
      opts.nowIso,
      ...(opts.kind === 'expiring'
        ? [EXPIRY_NOTICE_DAYS]
        : opts.kind === 'free_test_expiring'
          ? [FREE_TEST_NOTICE_HOURS / 24, FREE_TEST_EXPIRY_GRACE_MINUTES]
          : []),
    )
    .run();
  return changeCount(updated) > 0;
}

/** Book one DELIVERED notice. Guarded by the claim (`='sending'`). */
export async function bookSent(
  db: D1Database,
  opts: { orderId: string; kind: NoticeKind; nowIso: string },
): Promise<boolean> {
  const updated = await db
    .prepare(
      `UPDATE service_notifications
          SET status = 'sent', updated_at = ?3
        WHERE order_id = ?1 AND kind = ?2 AND status = 'sending'`,
    )
    .bind(opts.orderId, opts.kind, opts.nowIso)
    .run();
  return changeCount(updated) > 0;
}

/**
 * The claim was won but Telegram refused: return to 'pending' and retry next
 * run; after NOTICE_MAX_ATTEMPTS won-but-undelivered claims the notice rests
 * terminal ('failed') — visible, never looped. Guarded by 'sending'.
 */
export async function releaseFailedSend(
  db: D1Database,
  opts: { orderId: string; kind: NoticeKind; nowIso: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE service_notifications
          SET status = CASE WHEN attempts + 1 >= ?3 THEN 'failed' ELSE 'pending' END,
              attempts = attempts + 1,
              updated_at = ?4
        WHERE order_id = ?1 AND kind = ?2 AND status = 'sending'`,
    )
    .bind(opts.orderId, opts.kind, NOTICE_MAX_ATTEMPTS, opts.nowIso)
    .run();
}

/**
 * Terminal "nothing to ever notify about" (panel answered: service is gone or
 * dead). Seeded as skipped when no row exists yet; a pending row flips. A
 * 'sending' row owned by a concurrent run is NEVER touched — that run's own
 * book/release settles it.
 */
export async function markSkipped(
  db: D1Database,
  opts: { orderId: string; kind: NoticeKind; nowIso: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO service_notifications (order_id, kind, status, updated_at)
       VALUES (?1, ?2, 'skipped', ?3)`,
    )
    .bind(opts.orderId, opts.kind, opts.nowIso)
    .run();
  await db
    .prepare(
      `UPDATE service_notifications
          SET status = 'skipped', updated_at = ?3
        WHERE order_id = ?1 AND kind = ?2 AND status = 'pending'`,
    )
    .bind(opts.orderId, opts.kind, opts.nowIso)
    .run();
}

/**
 * Panel said "not yet due" (or the plan is unlimited / usage unknown): the
 * service stays eligible but rests in the backoff window. Attempts are NOT
 * touched — a not-yet answer is not a failure. `kind` defaults to the paid
 * 'usage90' so existing call sites stay byte-identical; the isolated test
 * legs pass their own kind.
 */
export async function stampUsageCheck(
  db: D1Database,
  opts: { orderId: string; nowIso: string; kind?: NoticeKind },
): Promise<void> {
  const kind = opts.kind ?? 'usage90';
  await ensurePending(db, opts.orderId, kind);
  await db
    .prepare(
      `UPDATE service_notifications
          SET last_checked_at = ?2, updated_at = ?2
        WHERE order_id = ?1 AND kind = ?3 AND status = 'pending'`,
    )
    .bind(opts.orderId, opts.nowIso, kind)
    .run();
}

function changeCount(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | null)?.meta;
  return typeof meta?.changes === 'number' ? meta.changes : 0;
}

/**
 * Phase 18: a successful paid repurchase starts a FRESH service lifecycle on
 * the SAME service row. Re-arm exactly the paid legs so usage90 can notify
 * again once and expiring can notify again once. Free-test rows, other
 * services, budgets, gates and leases are untouched — deleting the settled
 * rows simply makes the existing candidate queries eligible again. Called
 * ONLY from the single-winning repurchase finalize path (complete + book
 * already done), so concurrent sweeps cannot interleave a half-armed state:
 * the worst case is one extra future notice, never a lost one.
 */
export async function rearmPaidNoticesForRepurchase(
  db: D1Database,
  serviceOrderId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM service_notifications
        WHERE order_id = ?1 AND kind IN ('usage90', 'expiring')`,
    )
    .bind(serviceOrderId)
    .run();
}
