/**
 * Pending ADMIN actions (0004 table): "tap Reject → type a reason" needs a
 * tiny server-side pending marker. One per admin (PK = telegram user id),
 * short-lived, consumed/validated lazily.
 */
export const ADMIN_ACTION_TTL_MS = 15 * 60 * 1000;

export interface AdminActionRow {
  admin_user_id: string;
  order_id: string;
  action: 'reject';
}

export async function setPendingAdminAction(
  db: D1Database,
  adminUserId: number,
  orderId: string,
): Promise<void> {
  const expires = new Date(Date.now() + ADMIN_ACTION_TTL_MS).toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO admin_actions (admin_user_id, order_id, action, expires_at)
       VALUES (?1, ?2, 'reject', ?3)`,
    )
    .bind(String(adminUserId), orderId, expires)
    .run();
}

/** Returns the unexpired pending action, if any. Expired rows are swept. */
export async function getPendingAdminAction(
  db: D1Database,
  adminUserId: number,
): Promise<AdminActionRow | null> {
  const row = await db
    .prepare(
      `SELECT admin_user_id, order_id, action FROM admin_actions
        WHERE admin_user_id = ?1 AND expires_at > ?2`,
    )
    .bind(String(adminUserId), new Date().toISOString())
    .first<AdminActionRow>();
  if (!row) {
    await clearPendingAdminAction(db, adminUserId);
    return null;
  }
  return row;
}

export async function clearPendingAdminAction(
  db: D1Database,
  adminUserId: number,
): Promise<void> {
  await db
    .prepare('DELETE FROM admin_actions WHERE admin_user_id = ?1')
    .bind(String(adminUserId))
    .run();
}
