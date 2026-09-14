/**
 * Phase 12: database side of admin pricing edits.
 *
 *  - The live document lives in `settings['pricing']` (schema 2, 0011).
 *  - Arming (which field / which staged value) reuses `admin_actions` with
 *    action = 'pricing': one pending edit per admin, 15-min TTL, INSERT OR
 *    REPLACE — the exact model proven by reject/support/wallet arming.
 *    target_id = '<token>' while a value is awaited,
 *    target_id = '<token>=<amount>' once staged for confirmation.
 *  - Applying is a guarded compare-and-swap UPDATE (two admins, one winner —
 *    the loser's staged value was computed against a stale document) followed
 *    by an append-only `settings_audit` row (0011) holding both FULL documents.
 */
import { ADMIN_ACTION_TTL_MS } from './admin_actions.ts';

const PRICING_KEY = 'pricing';

export interface PricingSettingsRow {
  value: string;
  updated_by: string | null;
  updated_at: string;
}

export async function getPricingSettingsRow(
  db: D1Database,
): Promise<PricingSettingsRow | null> {
  return db
    .prepare(
      `SELECT value, updated_by, updated_at FROM settings WHERE key = ?1`,
    )
    .bind(PRICING_KEY)
    .first<PricingSettingsRow>();
}

/** Arm (or re-stage) the admin's single pending pricing edit. */
export async function setPendingAdminPricingAction(
  db: D1Database,
  adminUserId: number,
  targetId: string,
): Promise<void> {
  const expires = new Date(Date.now() + ADMIN_ACTION_TTL_MS).toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO admin_actions (admin_user_id, order_id, action, target_id, expires_at)
       VALUES (?1, NULL, 'pricing', ?2, ?3)`,
    )
    .bind(String(adminUserId), targetId, expires)
    .run();
}

/** '<token>=<amount>:<hash>' → staged pair; '<token>' → awaiting a value. */
export function parsePricingTarget(
  targetId: string | null,
): { token: string; amount: number | null; docHash: string | null } | null {
  if (targetId === null) return null;
  const match = /^([a-z]+[0-9]{0,4})(?:=([0-9]{1,12})(?::([0-9a-z]{1,8}))?)?$/.exec(targetId);
  if (!match) return null;
  const token = match[1] ?? '';
  if (token === '') return null;
  if (match[2] === undefined) return { token, amount: null, docHash: null };
  const amount = Number(match[2]);
  if (!Number.isSafeInteger(amount)) return null;
  return { token, amount, docHash: match[3] ?? null };
}

export function pricingArmTarget(token: string): string {
  return token;
}

export function pricingStagedTarget(token: string, amount: number, docHash: string): string {
  return `${token}=${amount}:${docHash}`;
}

/**
 * djb2 over the raw settings JSON, base36. The staged arming carries the
 * fingerprint of the document the admin typed AGAINST: if another admin wins
 * the race before confirmation, the hashes differ and we fail with a clear
 * "changed under you" message instead of quietly stomping the newer edit.
 * (The compare-and-swap UPDATE below is the same-tick backstop.)
 */
export function pricingDocHash(json: string): string {
  let hash = 5381;
  for (let i = 0; i < json.length; i += 1) {
    hash = (Math.imul(hash, 33) + json.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export type PricingApplyResult = 'applied' | 'conflict' | 'missing';

/**
 * Compare-and-swap the document. Returns 'applied' ONLY when the row still
 * held exactly `oldJson`; 'conflict' leaves the winner's document untouched.
 * The audit insert follows the verified swap (settings.updated_by records the
 * last editor even if a rare second write fails; audit rows are append-only).
 */
export async function applyPricingEditCas(
  db: D1Database,
  args: {
    oldJson: string;
    newJson: string;
    adminUserId: number;
    fieldToken: string;
  },
): Promise<PricingApplyResult> {
  const actor = `admin:${String(args.adminUserId)}`;
  const now = new Date().toISOString();
  const swapped = await db
    .prepare(
      `UPDATE settings
          SET value = ?2, updated_by = ?3, updated_at = ?4
        WHERE key = ?1 AND value = ?5`,
    )
    .bind(PRICING_KEY, args.newJson, actor, now, args.oldJson)
    .run();
  const changes = swapped?.meta?.changes ?? 0;
  if (changes === 0) {
    const still = await getPricingSettingsRow(db);
    if (still === null) return 'missing';
    return 'conflict';
  }
  await db
    .prepare(
      `INSERT INTO settings_audit (key, actor, action, old_value, new_value)
       VALUES ('pricing', ?1, ?2, ?3, ?4)`,
    )
    .bind(actor, args.fieldToken, args.oldJson, args.newJson)
    .run();
  return 'applied';
}
