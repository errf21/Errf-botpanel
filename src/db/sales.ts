/**
 * Phase 13: database side of the sales stop switch.
 *
 *  - The live document lives in `settings['sales']` (schema 1, 0013).
 *  - Toggling is a guarded compare-and-swap UPDATE (two admins, one winner —
 *    the loser computed against a stale document) followed by an append-only
 *    `settings_audit` row (0011) holding both FULL documents, exactly the
 *    model proven by the pricing edits (src/db/pricing.ts).
 *  - Actor is `admin:<telegram_user_id>` (verified sender only), action is
 *    'stop' | 'start' — replayable from the audit chain.
 */
import { SALES_SCHEMA } from '../catalog/sales.ts';

const SALES_KEY = 'sales';

export interface SalesSettingsRow {
  value: string;
  updated_by: string | null;
  updated_at: string;
}

export async function getSalesSettingsRow(
  db: D1Database,
): Promise<SalesSettingsRow | null> {
  return db
    .prepare(`SELECT value, updated_by, updated_at FROM settings WHERE key = ?1`)
    .bind(SALES_KEY)
    .first<SalesSettingsRow>();
}

/** Canonical document JSON — the ONLY shape this writer ever produces. */
export function salesDoc(stopped: boolean): string {
  return JSON.stringify({ schema: SALES_SCHEMA, stopped });
}

export async function ensureSalesRow(db: D1Database): Promise<void> {
  await db
    .prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)`)
    .bind(SALES_KEY, salesDoc(false))
    .run();
}

export type SalesApplyResult = 'applied' | 'conflict' | 'missing';

/**
 * CAS the switch. Returns 'applied' only when the row still held exactly
 * `oldJson`; 'conflict' leaves the winner's document untouched; 'missing'
 * means the seed row vanished (the caller re-reads and retries the toggle).
 */
export async function applySalesToggleCas(
  db: D1Database,
  args: {
    oldJson: string;
    newJson: string;
    adminUserId: number;
    action: 'stop' | 'start';
  },
): Promise<SalesApplyResult> {
  const actor = `admin:${String(args.adminUserId)}`;
  const now = new Date().toISOString();
  const swapped = await db
    .prepare(
      `UPDATE settings
          SET value = ?2, updated_by = ?3, updated_at = ?4
        WHERE key = ?1 AND value = ?5`,
    )
    .bind(SALES_KEY, args.newJson, actor, now, args.oldJson)
    .run();
  const changes = swapped?.meta?.changes ?? 0;
  if (changes === 0) {
    const still = await getSalesSettingsRow(db);
    if (still === null) return 'missing';
    return 'conflict';
  }
  await db
    .prepare(
      `INSERT INTO settings_audit (key, actor, action, old_value, new_value)
       VALUES ('sales', ?1, ?2, ?3, ?4)`,
    )
    .bind(actor, args.action, args.oldJson, args.newJson)
    .run();
  return 'applied';
}
