/**
 * Webhook update dedupe (Telegram redelivers on slow/failed responses).
 * The UNIQUE update_id insert is the guard; replay loses the race and is skipped.
 */
const DEDUPE_RETENTION_HOURS = 48;

export type DedupeOutcome = 'fresh' | 'replay';

export async function claimUpdate(
  db: D1Database,
  updateId: number,
): Promise<DedupeOutcome> {
  await db
    .prepare(
      'DELETE FROM update_dedupe WHERE received_at < ?1',
    )
    .bind(new Date(Date.now() - DEDUPE_RETENTION_HOURS * 3_600_000).toISOString())
    .run();

  try {
    await db
      .prepare('INSERT INTO update_dedupe (update_id) VALUES (?1)')
      .bind(updateId)
      .run();
    return 'fresh';
  } catch {
    return 'replay'; // constraint violation ⇒ already handled
  }
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
