/** Bounded expiry of authorization-only tokens. Business/recovery evidence is
 * deliberately excluded. Expired sessions cannot authorize any operation. */
export async function cleanupExpiredAdminTokens(db:D1Database,now=Date.now()):Promise<void>{
 const grace=10*60*1000;
 await db.batch([
  db.prepare(`DELETE FROM panel_admin_sessions WHERE nonce IN
   (SELECT nonce FROM panel_admin_sessions WHERE expires_at<?1 ORDER BY expires_at LIMIT 200)`)
   .bind(now-grace),
  db.prepare(`DELETE FROM migration_admin_choices WHERE nonce IN
   (SELECT nonce FROM migration_admin_choices WHERE expires_at<?1 ORDER BY expires_at LIMIT 200)`)
   .bind(now-grace),
  db.prepare(`DELETE FROM admin_actions WHERE admin_user_id IN
   (SELECT admin_user_id FROM admin_actions WHERE expires_at<?1 ORDER BY expires_at LIMIT 200)`)
   .bind(new Date(now-15*60*1000).toISOString()),
 ]);
}
