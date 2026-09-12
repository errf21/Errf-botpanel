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

/** Conversation state-machine states — must match the 0002 migration CHECK list. */
export const CONVERSATION_STATES = [
  'IDLE',
  'BUYING',
  'WAITING_CONFIG_NAME',
  'WAITING_VOLUME',
  'WAITING_DURATION',
  'WAITING_DEVICE_LIMIT',
  'WAITING_ORDER_CONFIRMATION',
  'WAITING_PAYMENT_RECEIPT',
] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];

/** JSON payload attached to a conversation state (draft selections, etc.). */
export interface StateData {
  config_name?: string;
  [key: string]: unknown;
}

/**
 * Minimal typed view over Telegram Bot API objects.
 * Full handlers arrive in Phase 2; only what the skeleton needs today.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat?: { id: number; type?: string };
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  data?: string;
  message?: { message_id?: number; chat?: { id?: number } };
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

/** Structural subset of TelegramApi that handlers need (avoids import cycles). */
export interface TelegramApiLike {
  sendMessage(
    chatId: number,
    text: string,
    buttons?: TelegramInlineKeyboardMarkup,
  ): Promise<unknown>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    buttons?: TelegramInlineKeyboardMarkup,
  ): Promise<unknown>;
  answerCallbackQuery(id: string, text?: string, showAlert?: boolean): Promise<void>;
}

/** Per-update context assembled by the webhook dispatcher. */
export interface UpdateContext {
  env: Env;
  db: D1Database;
  api: TelegramApiLike;
  /** The human acting on this update (already validated + registered). */
  actor: TelegramUser;
  chatId: number;
  /** Internal customers.id — resolved before any handler runs. */
  customerId: number;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}
