/**
 * Phase 8C: payment reminder schedules. One row per order that has ever
 * submitted a receipt; the cron sweep advances `reminded_stage` through the
 * 15/30/45-minute ladder (cap 3). Every write is a single guarded statement —
 * the same claim discipline the whole codebase relies on: D1/SQLite
 * linearizes writes, so overlapping cron runs, replays and review races each
 * produce exactly one winner and can never double-send or resurrect a stage.
 */

export const REMINDER_STAGE_MINUTES = 15;
export const REMINDER_MAX_STAGE = 3;
export const REMINDER_SWEEP_LIMIT = 25;

export interface ReminderCandidate {
  order_id: string;
  /** Anchor t0: first successful receipt submission (row creation time). */
  created_at: string;
  reminded_stage: number;
  customer_id: number;
  telegram_user_id: string;
}

/**
 * Exactly one schedule per order, anchored at FIRST submission. Called from
 * the winning UPDATE in `submitOrderReceipt`; replacements lose this insert
 * to the PK by design and keep the original t0 (schedule is preserved).
 */
export async function ensureSchedule(db: D1Database, orderId: string): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO payment_reminders (order_id) VALUES (?1)`,
    )
    .bind(orderId)
    .run();
}

/**
 * Orders still in `awaiting_review` whose NEXT stage (reminded_stage+1, max 3)
 * is due. The SQL carries a 1-minute inclusion slack (float-safe pre-filter);
 * `dueStageFor` in the sweep handler applies the EXACT monotone wall-clock
 * gate, so a reminder can never fire early even if this filter says maybe.
 * Oldest anchors first, bounded per run.
 */
export async function listDueCandidates(
  db: D1Database,
  nowIso: string,
  limit: number,
): Promise<ReminderCandidate[]> {
  const result = await db
    .prepare(
      `SELECT p.order_id, p.created_at, p.reminded_stage, o.customer_id, c.telegram_user_id
         FROM payment_reminders p
         JOIN orders o ON o.id = p.order_id
         JOIN customers c ON c.id = o.customer_id
        WHERE o.state = 'awaiting_review'
          AND p.reminded_stage < ?3
          AND (julianday(?1) - julianday(p.created_at)) * 1440.0
              >= ?2 * (p.reminded_stage + 1) - 1.0
        ORDER BY p.created_at ASC
        LIMIT ?4`,
    )
    .bind(
      nowIso,
      REMINDER_STAGE_MINUTES,
      REMINDER_MAX_STAGE,
      limit,
    )
    .all<ReminderCandidate>();
  return result.results;
}

/**
 * The single atomic claim for one stage: equality guard + eligibility fused
 * into one UPDATE, so a lost race (overlapping run, or an approval that
 * committed first) simply returns false and nothing is sent. Claim-then-send
 * = at-most-once per stage: a crash after a won claim loses one nudge, which
 * is strictly better than a duplicate.
 */
export async function claimStage(
  db: D1Database,
  orderId: string,
  expectedStage: number,
  targetStage: number,
): Promise<boolean> {
  const updated = await db
    .prepare(
      `UPDATE payment_reminders
          SET reminded_stage = ?2,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE order_id = ?1
          AND reminded_stage = ?3
          AND (SELECT state FROM orders WHERE id = ?1) = 'awaiting_review'`,
    )
    .bind(orderId, targetStage, expectedStage)
    .run();
  const meta = (updated as { meta?: { changes?: number } } | null)?.meta;
  return (typeof meta?.changes === 'number' ? meta.changes : 0) > 0;
}

/** Elapsed whole minutes since the anchor (display only, never gating). */
export function elapsedMinutes(anchorIso: string, nowMs: number): number {
  const anchor = Date.parse(anchorIso);
  if (!Number.isFinite(anchor)) return 0;
  return Math.max(0, Math.floor((nowMs - anchor) / 60_000));
}
