/**
 * Webhook update dedupe (Telegram redelivers on slow/failed responses).
 * The UNIQUE update_id insert is the guard; replay loses the race and is skipped.
 */
const DEDUPE_RETENTION_HOURS = 48;

export class UpdateClaimUnavailable extends Error { constructor(){super('update_claim_unavailable');this.name='UpdateClaimUnavailable';} }

export type DedupeOutcome = 'fresh' | 'replay';

export async function claimUpdate(
  db: D1Database,
  updateId: number,
  options: { prune?: boolean } = {},
): Promise<DedupeOutcome> {
  try {
    // Direct callers retain cleanup semantics; dispatch uses the bounded cron sweep.
    if (options.prune !== false) await cleanupExpiredUpdates(db);
    const result=await db.prepare('INSERT INTO update_dedupe(update_id) VALUES(?1) ON CONFLICT(update_id) DO NOTHING')
      .bind(updateId).run();
    if((result as {success?:boolean}).success===false)throw new Error('update_claim_unavailable');
    if(result.meta?.changes===1)return 'fresh';
    if(result.meta?.changes===0)return 'replay';
    throw new Error('update_claim_unverified');
  } catch { throw new UpdateClaimUnavailable(); }

}

/** Bounded maintenance; never deletes claims inside the 48-hour replay horizon. */
export async function cleanupExpiredUpdates(db: D1Database, now = Date.now()): Promise<void> {
  const result = await db.prepare(`DELETE FROM update_dedupe WHERE update_id IN
    (SELECT update_id FROM update_dedupe WHERE received_at < ?1 ORDER BY received_at LIMIT 1000)`)
    .bind(new Date(now-DEDUPE_RETENTION_HOURS*3_600_000).toISOString()).run();
  if ((result as {success?:boolean}).success === false) throw new UpdateClaimUnavailable();
}

/** Free a claim so a legitimately failed update could be redelivered. */
export async function releaseUpdate(
  db: D1Database,
  updateId: number,
): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM update_dedupe WHERE update_id = ?1')
      .bind(updateId)
      .run();
  } catch {
    // best effort only
  }
}
