/**
 * Support tickets (Phase 7): one open ('open' | 'answered') ticket per
 * customer, enforced by a partial UNIQUE index — the DB, not the UI, decides.
 * Messages are append-only; `delivered` records best-effort admin/customer
 * pushes so the /tickets queue can re-push anything that failed.
 */
import { newOrderId } from '../lib/security.ts';

export const SUPPORT_BODY_MAX = 2000;
export const TICKET_SUBJECT_MAX = 80;

export interface TicketRow {
  id: string;
  customer_id: number;
  state: string;
  subject: string;
  created_at: string;
  updated_at: string;
}

export interface TicketMessageRow {
  id: string;
  ticket_id: string;
  sender: string;
  body: string;
  file_id: string | null;
  file_kind: string | null;
  delivered: number;
  created_at: string;
}

export type TicketCreateOutcome =
  | { ok: true; ticket: TicketRow; message: TicketMessageRow }
  | { ok: false; reason: 'already_open' | 'invalid' };

/** Subject = first line-ish summary of the opening message (sanitized). */
export function ticketSubject(body: string): string {
  const line = body.replace(/[\r\n]+/g, ' ').trim();
  return line.slice(0, TICKET_SUBJECT_MAX);
}

/** Open/answered ticket for a customer (their current conversation). */
export async function findLiveTicket(
  db: D1Database,
  customerId: number,
): Promise<TicketRow | null> {
  return db
    .prepare(
      `SELECT * FROM support_tickets
        WHERE customer_id = ?1 AND state IN ('open', 'answered')
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(customerId)
    .first<TicketRow>();
}

/** Create a ticket with its opening customer message — race-safe: the
 *  partial UNIQUE index rejects a second live ticket with one INSERT. */
export async function createTicket(
  db: D1Database,
  opts: { customerId: number; body: string },
): Promise<TicketCreateOutcome> {
  const body = opts.body.trim();
  if (body.length === 0 || body.length > SUPPORT_BODY_MAX) return { ok: false, reason: 'invalid' };
  const ticketId = newOrderId();
  const messageId = newOrderId();
  // The UNIQUE index can reject the insert; callers must handle the throw.
  await db.batch([
    db
      .prepare(
        `INSERT INTO support_tickets (id, customer_id, state, subject)
         VALUES (?1, ?2, 'open', ?3)`,
      )
      .bind(ticketId, opts.customerId, ticketSubject(body)),
    db
      .prepare(
        `INSERT INTO support_messages (id, ticket_id, sender, body)
         VALUES (?1, ?2, 'customer', ?3)`,
      )
      .bind(messageId, ticketId, body),
  ]);
  const ticket = await getTicketById(db, ticketId);
  const message = await getTicketMessageById(db, messageId);
  if (!ticket || !message) return { ok: false, reason: 'invalid' };
  return { ok: true, ticket, message };
}

export async function getTicketById(db: D1Database, ticketId: string): Promise<TicketRow | null> {
  return db.prepare('SELECT * FROM support_tickets WHERE id = ?1').bind(ticketId).first<TicketRow>();
}

export async function getTicketMessageById(
  db: D1Database,
  messageId: string,
): Promise<TicketMessageRow | null> {
  return db
    .prepare('SELECT * FROM support_messages WHERE id = ?1')
    .bind(messageId)
    .first<TicketMessageRow>();
}

/** Append one message to a LIVE ticket (customer follow-up or admin reply).
 *  State transitions (open/answered/closed) are the caller's decision and go
 *  through setTicketState — this only books the message + touches updated_at. */
export async function appendTicketMessage(
  db: D1Database,
  opts: {
    ticketId: string;
    sender: string;
    body: string;
    fileId?: string | null;
    fileKind?: 'photo' | 'document' | null;
    delivered?: boolean;
  },
): Promise<TicketMessageRow | null> {
  const body = opts.body.trim();
  if (body.length === 0 || body.length > SUPPORT_BODY_MAX) return null;
  const messageId = newOrderId();
  await db.batch([
    db
      .prepare(
        `INSERT INTO support_messages (id, ticket_id, sender, body, file_id, file_kind, delivered)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        messageId,
        opts.ticketId,
        opts.sender,
        body,
        opts.fileId ?? null,
        opts.fileKind ?? null,
        opts.delivered === false ? 0 : 1,
      ),
    db
      .prepare(
        `UPDATE support_tickets
            SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?1 AND state IN ('open', 'answered')`,
      )
      .bind(opts.ticketId),
  ]);
  return getTicketMessageById(db, messageId);
}

/** Mark states with a single guarded UPDATE each (double taps converge). */
export async function setTicketState(
  db: D1Database,
  opts: { ticketId: string; from: readonly string[]; to: 'open' | 'answered' | 'closed' },
): Promise<boolean> {
  const placeholders = opts.from.map(() => '?').join(',');
  const updated = await db
    .prepare(
      `UPDATE support_tickets
          SET state = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND state IN (${placeholders})`,
    )
    .bind(opts.ticketId, opts.to, ...opts.from)
    .run();
  return ((updated as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0) === 1;
}

export interface TicketQueueRow extends TicketRow {
  telegram_user_id: string;
  telegram_username: string | null;
  first_name: string | null;
  messages: number;
}

/** Admin queue: live tickets (`open` = awaiting staff), oldest first. */
export async function listLiveTickets(
  db: D1Database,
  limit: number,
): Promise<TicketQueueRow[]> {
  const result = await db
    .prepare(
      `SELECT t.*, c.telegram_user_id, c.telegram_username, c.first_name,
              (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS messages
         FROM support_tickets t
         JOIN customers c ON c.id = t.customer_id
         WHERE t.state IN ('open', 'answered')
         ORDER BY t.updated_at ASC
         LIMIT ?1`,
    )
    .bind(limit)
    .all<TicketQueueRow>();
  return result.results;
}

/** Last customer message body (admin reply target + display). */
export async function lastCustomerMessage(
  db: D1Database,
  ticketId: string,
): Promise<TicketMessageRow | null> {
  return db
    .prepare(
      `SELECT * FROM support_messages
        WHERE ticket_id = ?1 AND sender = 'customer'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(ticketId)
    .first<TicketMessageRow>();
}
