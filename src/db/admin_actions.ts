/**
 * Pending ADMIN actions (0004 table, extended by 0007/0011): short-lived
 * "tap button → type the next message" markers. One per admin (PK = telegram
 * user id) so a second arming replaces the first — same rule as Phase 4.
 *  - reject:            order_id set
 *  - support_reply:     order_id NULL, target_id = ticket id
 *  - wallet_grant/debit: order_id NULL, target_id = target telegram user id
 *  - pricing (P12):     order_id NULL, target_id = edit token (see db/pricing.ts)
 *  - topup_reject (P17): order_id NULL, target_id = wallet_topups id
 */
export const ADMIN_ACTION_TTL_MS = 15 * 60 * 1000;

export type AdminActionKind =
  | 'reject'
  | 'support_reply'
  | 'wallet_grant'
  | 'wallet_debit'
  | 'pricing'
  | 'topup_reject';

export interface AdminActionRow {
  admin_user_id: string;
  order_id: string | null;
  action: AdminActionKind;
  target_id: string | null;
}

export async function setPendingAdminAction(
  db: D1Database,
  adminUserId: number,
  orderId: string,
): Promise<void> {
  const expires = new Date(Date.now() + ADMIN_ACTION_TTL_MS).toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO admin_actions (admin_user_id, order_id, action, target_id, expires_at)
       VALUES (?1, ?2, 'reject', NULL, ?3)`,
    )
    .bind(String(adminUserId), orderId, expires)
    .run();
}

export async function setPendingAdminTicketReply(
  db: D1Database,
  adminUserId: number,
  ticketId: string,
): Promise<void> {
  const expires = new Date(Date.now() + ADMIN_ACTION_TTL_MS).toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO admin_actions (admin_user_id, order_id, action, target_id, expires_at)
       VALUES (?1, NULL, 'support_reply', ?2, ?3)`,
    )
    .bind(String(adminUserId), ticketId, expires)
    .run();
}

export async function setPendingAdminWalletAction(
  db: D1Database,
  adminUserId: number,
  action: 'wallet_grant' | 'wallet_debit',
  targetTelegramId: number,
): Promise<void> {
  const expires = new Date(Date.now() + ADMIN_ACTION_TTL_MS).toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO admin_actions (admin_user_id, order_id, action, target_id, expires_at)
       VALUES (?1, NULL, ?2, ?3, ?4)`,
    )
    .bind(String(adminUserId), action, String(targetTelegramId), expires)
    .run();
}

/** Phase 17: arm a top-up rejection (reason typed next; order_id stays NULL). */
export async function setPendingTopupReject(
  db: D1Database,
  adminUserId: number,
  topupId: string,
): Promise<void> {
  const expires = new Date(Date.now() + ADMIN_ACTION_TTL_MS).toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO admin_actions (admin_user_id, order_id, action, target_id, expires_at)
       VALUES (?1, NULL, 'topup_reject', ?2, ?3)`,
    )
    .bind(String(adminUserId), topupId, expires)
    .run();
}

/** Returns the unexpired pending action, if any. Expired rows are swept. */
export async function getPendingAdminAction(
  db: D1Database,
  adminUserId: number,
): Promise<Omit<AdminActionRow, 'admin_user_id'> | null> {
  const now=new Date().toISOString();
  const row=await db.prepare(`SELECT order_id,action,target_id,expires_at FROM admin_actions WHERE admin_user_id=?1`)
    .bind(String(adminUserId)).first<Omit<AdminActionRow,'admin_user_id'>&{expires_at:string}>();
  if (!row) return null; // A miss must not delete a concurrently armed action.
  if (row.expires_at<=now) {
    await db.prepare('DELETE FROM admin_actions WHERE admin_user_id=?1 AND expires_at<=?2')
      .bind(String(adminUserId),now).run();
    return null;
  }
  const {expires_at,...action}=row;
  return action;
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
