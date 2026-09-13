/**
 * Announcements (Phase 7): a durable publish job. Fan-out is chunked —
 * every webhook/waitUntil pass claims at most ANNOUNCE_CHUNK recipients with
 * one guarded UPDATE (pending → sending), sends them, and books the result.
 * The UNIQUE PK on deliveries makes "already received" structural: resumes,
 * replays and a second admin tapping [continue] can never double-send.
 * A crash between claim and book leaves rows in 'sending'; the next pass
 * re-adopts them (Telegram dedupe on identical text is irrelevant — worst
 * case one user sees the notice twice, which self-heals on retry; rows never
 * stay stuck).
 */
import { newOrderId } from '../lib/security.ts';
import type { TelegramApiLike } from '../types.ts';

export const ANNOUNCE_CHUNK = 20;
export const ANNOUNCE_BODY_MAX = 4000;
export const ANNOUNCE_LIST_LIMIT = 100;

export interface AnnouncementRow {
  id: string;
  body: string;
  created_by: string;
  state: string;
  total_estimate: number;
  sent_count: number;
  created_at: string;
  updated_at: string;
}

export interface AnnounceAggregate {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  stuck: number;
}

/** Snapshot + progress row for confirmation/rendering. */
export async function getAnnouncement(
  db: D1Database,
  announcementId: string,
): Promise<AnnouncementRow | null> {
  return db
    .prepare('SELECT * FROM announcements WHERE id = ?1')
    .bind(announcementId)
    .first<AnnouncementRow>();
}

/** Count of potential recipients at draft time (cosmetic estimate). */
export async function countPotentialRecipients(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM customers')
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createAnnouncement(
  db: D1Database,
  opts: { body: string; createdBy: string; totalEstimate: number },
): Promise<AnnouncementRow | null> {
  const body = opts.body.trim();
  if (body.length === 0 || body.length > ANNOUNCE_BODY_MAX) return null;
  const id = newOrderId();
  await db
    .prepare(
      `INSERT INTO announcements (id, body, created_by, state, total_estimate)
       VALUES (?1, ?2, ?3, 'sending', ?4)`,
    )
    .bind(id, body, opts.createdBy, opts.totalEstimate)
    .run();
  return getAnnouncement(db, id);
}

/** Populate the delivery list once (idempotent: NOT EXISTS insert-select).
 *  Runs at CONFIRM time so a cancelled draft never seeds anything. */
export async function seedAnnouncementDeliveries(
  db: D1Database,
  announcementId: string,
): Promise<number> {
  const inserted = await db
    .prepare(
      `INSERT INTO announcement_deliveries (announcement_id, customer_id, status)
       SELECT ?1, c.id, 'pending' FROM customers c
        WHERE NOT EXISTS (
          SELECT 1 FROM announcement_deliveries d
           WHERE d.announcement_id = ?1 AND d.customer_id = c.id
        )`,
    )
    .bind(announcementId)
    .run();
  return (inserted as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0;
}

export async function announcementAggregate(
  db: D1Database,
  announcementId: string,
): Promise<AnnounceAggregate> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS stuck
       FROM announcement_deliveries WHERE announcement_id = ?1`,
    )
    .bind(announcementId)
    .first<{ total: number; sent: number | null; failed: number | null; pending: number | null; stuck: number | null }>();
  return {
    total: row?.total ?? 0,
    sent: row?.sent ?? 0,
    failed: row?.failed ?? 0,
    pending: row?.pending ?? 0,
    stuck: row?.stuck ?? 0,
  };
}

/** Send up to `limit` pending deliveries and book every outcome immediately.
 *  Failed sends stay retryable ('pending' until an attempts cap, then
 *  'failed'); the continuation button re-enters this function until the
 *  queue drains or hard-fails. Never throws. */
export async function runAnnouncementChunk(
  db: D1Database,
  api: TelegramApiLike,
  body: string,
  announcementId: string,
  limit: number,
): Promise<number> {
  const claimed = await db
    .prepare(
      `UPDATE announcement_deliveries
          SET status = 'sending', attempts = attempts + 1
        WHERE announcement_id = ?1 AND rowid IN (
          SELECT rowid FROM announcement_deliveries
           WHERE announcement_id = ?1 AND status = 'pending'
           ORDER BY customer_id ASC
           LIMIT ?2
        )`,
    )
    .bind(announcementId, limit)
    .run();
  const count = (claimed as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0;
  if (count === 0) return 0;
  const rows = await db
    .prepare(
      `SELECT d.customer_id AS customerId, c.telegram_user_id AS telegramUserId
         FROM announcement_deliveries d
         JOIN customers c ON c.id = d.customer_id
        WHERE d.announcement_id = ?1 AND d.status = 'sending'
        ORDER BY d.customer_id ASC`,
    )
    .bind(announcementId)
    .all<{ customerId: number; telegramUserId: string }>();
  let processed = 0;
  for (const row of rows.results) {
    const chatId = Number(row.telegramUserId);
    let ok = false;
    if (Number.isSafeInteger(chatId) && chatId > 0) {
      try {
        ok = (await api.sendMessage(chatId, body)) !== null;
      } catch {
        ok = false;
      }
    }
    await bookAnnouncementDelivery(db, { announcementId, customerId: row.customerId, ok });
    processed += 1;
  }
  return processed;
}

/** Book one recipient outcome. A transport failure returns the row to
 *  'pending' until the attempts cap (3), then it rests in 'failed' — visible
 *  in /announcements, never retried forever. The status write is itself the
 *  claim guard (`='sending'`), so a double-book can never double-count. */
export async function bookAnnouncementDelivery(
  db: D1Database,
  opts: { announcementId: string; customerId: number; ok: boolean },
): Promise<void> {
  await db
    .prepare(
      `UPDATE announcement_deliveries
          SET status = CASE
                WHEN ?3 = 1 THEN 'sent'
                WHEN attempts >= 3 THEN 'failed'
                ELSE 'pending'
              END
        WHERE announcement_id = ?1 AND customer_id = ?2 AND status = 'sending'`,
    )
    .bind(opts.announcementId, opts.customerId, opts.ok ? 1 : 0)
    .run();
  await db
    .prepare(
      `UPDATE announcements
          SET sent_count = (
              SELECT COUNT(*) FROM announcement_deliveries
               WHERE announcement_id = ?1 AND status = 'sent'
            ),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1`,
    )
    .bind(opts.announcementId)
    .run();
}

/** Release rows a previous pass left mid-flight (crash between claim and
 *  book) so the next chunk can retry them; returns the released count. */
export async function sweepStuckDeliveries(db: D1Database, announcementId: string): Promise<number> {
  const released = await db
    .prepare(
      `UPDATE announcement_deliveries
          SET status = 'pending', attempts = CASE WHEN attempts > 3 THEN 3 ELSE attempts END
        WHERE announcement_id = ?1 AND status = 'sending'`,
    )
    .bind(announcementId)
    .run();
  return (released as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0;
}

/** Flip the job to 'done' exactly when nothing is pending/stuck left. */
export async function settleAnnouncement(
  db: D1Database,
  announcementId: string,
): Promise<AnnouncementRow | null> {
  const pending = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM announcement_deliveries
        WHERE announcement_id = ?1 AND status IN ('pending', 'sending')`,
    )
    .bind(announcementId)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) > 0) return getAnnouncement(db, announcementId);
  await db
    .prepare(
      `UPDATE announcements
          SET state = 'done', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND state = 'sending'`,
    )
    .bind(announcementId)
    .run();
  return getAnnouncement(db, announcementId);
}

export async function listRecentAnnouncements(
  db: D1Database,
  limit: number,
): Promise<AnnouncementRow[]> {
  const result = await db
    .prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT ?1')
    .bind(limit)
    .all<AnnouncementRow>();
  return result.results;
}
