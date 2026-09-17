import type { Env, TelegramUser } from '../types.ts';
import type { Locale } from '../telegram/i18n.ts';

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
  /** Phase 10: explicit in-bot choice ('fa' | 'en'); NULL = never chosen. */
  language: string | null;
  is_admin: number;
  created_at: string;
  updated_at: string;
}

/** Identity + locale after upsert — Phase 10 feeds the dispatcher's Ui. */
export interface CustomerIdentity {
  id: number;
  language: string | null;
}

/**
 * Idempotent upsert keyed on UNIQUE(telegram_user_id).
 * Safe under repeated /start and concurrent webhook retries —
 * always ends with exactly one row; returns its integer id. First-ever
 * detection is `customerExists()` at the rare referral call site.
 * Phase 10: `language` is written ONLY by `setCustomerLanguage` — the upsert
 * never touches it, so a Telegram profile update can't wipe an explicit
 * choice, and the stored Telegram `language_code` hint is display-only.
 */
export async function upsertCustomer(
  db: D1Database,
  user: TelegramUser,
): Promise<CustomerIdentity> {
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
    .prepare('SELECT id, language FROM customers WHERE telegram_user_id = ?1')
    .bind(telegramUserId)
    .first<{ id: number; language: string | null }>();
  if (!row) throw new Error('customer_load_failed');
  return { id: row.id, language: row.language };
}

/**
 * Phase 10: the ONLY write path for the explicit language preference, keyed
 * on the verified actor's Telegram id (never on user-authored content).
 */
export async function setCustomerLanguage(
  db: D1Database,
  telegramUserId: number,
  locale: Locale,
): Promise<void> {
  await db
    .prepare(
      `UPDATE customers
          SET language = ?2,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE telegram_user_id = ?1`,
    )
    .bind(String(telegramUserId), locale)
    .run();
}

/** True when this telegram id already has a row (first-ever-seen probe).
 *  Only consulted for `/start ref_...` payloads — not the hot path. */
export async function customerExists(
  db: D1Database,
  telegramUserId: number,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS hit FROM customers WHERE telegram_user_id = ?1')
    .bind(String(telegramUserId))
    .first<{ hit: number }>();
  return row !== null;
}

export async function getCustomer(
  db: D1Database,
  telegramUserId: number,
): Promise<CustomerRecord | null> {
  return db
    .prepare(
      `SELECT id, telegram_user_id, telegram_username, first_name, last_name,
              language_code, language, is_admin, created_at, updated_at
         FROM customers
        WHERE telegram_user_id = ?1`,
    )
    .bind(String(telegramUserId))
    .first<CustomerRecord>();
}

/**
 * Phase 17: username lookup for admin /credit @username. Telegram usernames
 * are case-insensitive; the stored value is refreshed on every upsert, so a
 * user who never interacted (or has no username) simply yields null — the
 * caller treats that as zero-mutation, exactly like an unknown numeric id.
 * Numeric identity stays canonical: callers resolve to the customer row and
 * then use its internal id / telegram_user_id for all money movement.
 */
export async function getCustomerByUsername(
  db: D1Database,
  username: string,
): Promise<CustomerRecord | null> {
  const name = username.trim().replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{5,32}$/.test(name)) return null;
  return db
    .prepare(
      `SELECT id, telegram_user_id, telegram_username, first_name, last_name,
              language_code, language, is_admin, created_at, updated_at
         FROM customers
        WHERE telegram_username = ?1 COLLATE NOCASE LIMIT 1`,
    )
    .bind(name)
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
  /** Phase 10: explicit language choice for proactive-notice routing. */
  language: string | null;
}

/** Internal id → contact, for proactive notices (e.g. after admin review). */
export async function getCustomerContact(
  db: D1Database,
  customerId: number,
): Promise<CustomerContact | null> {
  return db
    .prepare('SELECT telegram_user_id, first_name, language FROM customers WHERE id = ?1')
    .bind(customerId)
    .first<CustomerContact>();
}

/* ———— Phase 20: /users admin dashboard (migration-free reads) ————
 * Paginated customer browsing for the admin-only /users surface. Snapshot
 * reads only: safe columns, newest-first, bounded LIMIT/OFFSET. No secrets
 * live in `customers`, but the column list stays explicit so future columns
 * can never leak by accident. */

/** Total customer rows (dashboard S0 overview + list page count). */
export async function countCustomers(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM customers')
    .first<{ total: number }>();
  return typeof row?.total === 'number' ? row.total : 0;
}

/** One page of customers, newest-first. `limit`/`offset` are clamped by callers. */
export async function listCustomersPage(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<Array<CustomerRecord & { balance_irt: number }>> {
  const result = await db
    .prepare(
      `SELECT id, telegram_user_id, telegram_username, first_name, last_name,
              language_code, language, is_admin, created_at, updated_at, balance_irt
         FROM customers
        ORDER BY created_at DESC, id DESC
        LIMIT ?1 OFFSET ?2`,
    )
    .bind(limit, offset)
    .all<CustomerRecord & { balance_irt: number }>();
  return result.results;
}

/** Chat ids that receive admin traffic: env admin + every is_admin row. */
export async function resolveAdminChatIds(env: Env, db: D1Database): Promise<number[]> {
  const ids = new Set<number>();
  const configured = env.ADMIN_CHAT_ID?.trim() ?? '';
  if (/^[0-9]{1,20}$/.test(configured)) {
    const num = Number(configured);
    if (Number.isSafeInteger(num) && num > 0) ids.add(num);
  }
  try {
    const rows = await db
      .prepare('SELECT telegram_user_id FROM customers WHERE is_admin = 1')
      .all<{ telegram_user_id: string }>();
    for (const row of rows.results) {
      const num = Number(row.telegram_user_id);
      if (Number.isSafeInteger(num) && num > 0) ids.add(num);
    }
  } catch {
    // DB failure degrades to env-only targeting, never crashes the update.
  }
  return [...ids];
}

