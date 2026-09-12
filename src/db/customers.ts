import type { TelegramUser } from '../types.ts';

/**
 * Customer repository. Telegram user id (as string) is the external identity;
 * nothing beyond the already-stored fields is ever written.
 */
export interface CustomerRecord {
  id: number;
  telegram_user_id: string;
  telegram_username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
  is_admin: number;
  created_at: string;
  updated_at: string;
}

/**
 * Idempotent upsert keyed on UNIQUE(telegram_user_id).
 * Safe under repeated /start and concurrent webhook retries —
 * always ends with exactly one row; returns its integer id.
 */
export async function upsertCustomer(
  db: D1Database,
  user: TelegramUser,
): Promise<number> {
  const telegramUserId = String(user.id);
  await db
    .prepare(
      `INSERT INTO customers (telegram_user_id, telegram_username, first_name, last_name, language_code)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         telegram_username = excluded.telegram_username,
         first_name        = excluded.first_name,
         last_name         = excluded.last_name,
         language_code     = excluded.language_code,
         updated_at        = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(
      telegramUserId,
      user.username ?? null,
      user.first_name ?? null,
      user.last_name ?? null,
      user.language_code ?? null,
    )
    .run();

  const row = await db
    .prepare('SELECT id FROM customers WHERE telegram_user_id = ?1')
    .bind(telegramUserId)
    .first<{ id: number }>();
  if (!row) throw new Error('customer_load_failed');
  return row.id;
}

export async function getCustomer(
  db: D1Database,
  telegramUserId: number,
): Promise<CustomerRecord | null> {
  return db
    .prepare(
      `SELECT id, telegram_user_id, telegram_username, first_name, last_name,
              language_code, is_admin, created_at, updated_at
         FROM customers
        WHERE telegram_user_id = ?1`,
    )
    .bind(String(telegramUserId))
    .first<CustomerRecord>();
}

/** DB-side admin flag. Absent/unregistered users are never admins. */
export async function isAdminUserId(
  db: D1Database,
  telegramUserId: number,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT is_admin FROM customers WHERE telegram_user_id = ?1')
    .bind(String(telegramUserId))
    .first<{ is_admin: number }>();
  return row?.is_admin === 1;
}

export interface CustomerContact {
  telegram_user_id: string;
  first_name: string | null;
}

/** Internal id → contact, for proactive notices (e.g. after admin review). */
export async function getCustomerContact(
  db: D1Database,
  customerId: number,
): Promise<CustomerContact | null> {
  return db
    .prepare('SELECT telegram_user_id, first_name FROM customers WHERE id = ?1')
    .bind(customerId)
    .first<CustomerContact>();
}

