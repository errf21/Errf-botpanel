/**
 * Shared types for the telbotv2 worker.
 */

/** Worker bindings: secrets come from `.dev.vars` / `wrangler secret put`. */
export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Used from Phase 5 onward. Never log or expose it. */
  PASARGUARD_API_KEY?: string;
  PASARGUARD_PANEL_URL?: string;
  ADMIN_CHAT_ID?: string;
}

/** Order lifecycle. One enum per phase, kept strict on the DB side too. */
export const ORDER_STATES = [
  'pending_payment',
  'awaiting_review',
  'approved',
  'provisioning',
  'completed',
  'rejected',
  'failed',
  'cancelled',
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

/**
 * Minimal typed view over Telegram Bot API objects.
 * Full handlers arrive in Phase 2; only what the skeleton needs today.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: unknown;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat?: { id: number; type?: string };
  text?: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}
