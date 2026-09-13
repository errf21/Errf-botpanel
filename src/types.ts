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

/** Conversation state-machine states — must match the migration CHECK list. */
export const CONVERSATION_STATES = [
  'IDLE',
  'BUYING',
  'WAITING_CONFIG_NAME',
  'WAITING_VOLUME',
  'WAITING_DURATION',
  'WAITING_DEVICE_LIMIT',
  'WAITING_ORDER_CONFIRMATION',
  'WAITING_PAYMENT_RECEIPT',
  'WAITING_RENEWAL_DURATION',
  'WAITING_RENEWAL_CONFIRMATION',
  'WAITING_SUPPORT_MESSAGE',
  'WAITING_ANNOUNCE_TEXT',
  'WAITING_ANNOUNCE_CONFIRM',
] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];

/** JSON payload attached to a conversation state (draft selections, etc.). */
export interface StateData {
  config_name?: string;
  volume_gb?: number;
  duration_days?: number;
  device_count?: number;
  /** ULID minted when the confirmation step appears = order idempotency key. */
  order_token?: string;
  /** Set only after a durable order row exists. */
  order_id?: string;
  /** Phase 6: purchase order (service) a renewal draft extends. */
  renews_order_id?: string;
  /** Phase 7: 'full' pays the whole order from the wallet, 'partial' credits it. */
  wallet_use?: 'full' | 'partial';
  /** Phase 7: announcement id awaiting the admin's final confirm tap. */
  announcement_id?: string;
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
  /** Phase 4: payment receipts arrive as photos/documents (caption = reference). */
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
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
  sendPhoto(
    chatId: number,
    fileId: string,
    caption: string,
    buttons?: TelegramInlineKeyboardMarkup,
  ): Promise<unknown>;
  sendDocument(
    chatId: number,
    fileId: string,
    caption: string,
    buttons?: TelegramInlineKeyboardMarkup,
  ): Promise<unknown>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    buttons?: TelegramInlineKeyboardMarkup,
  ): Promise<unknown>;
  /** Media messages can only have their caption+buttons replaced. */
  editMessageCaption(
    chatId: number,
    messageId: number,
    caption: string,
    buttons?: TelegramInlineKeyboardMarkup,
  ): Promise<boolean>;
  answerCallbackQuery(id: string, text?: string, showAlert?: boolean): Promise<void>;
  /** Phase 7: bot identity for invite deep links; optional in harnesses. */
  getMe?(): Promise<Record<string, unknown> | null>;
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
  /** ADMIN_CHAT_ID env OR customers.is_admin — computed once per update. */
  isAdmin: boolean;
  /**
   * Phase 5: defers provisioning past the webhook ACK (Cloudflare
   * ExecutionContext.waitUntil). Absent in tests/harnesses → inline await.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Phase 7: referral code carried by THIS update's first-ever `/start`,
   * when the sender has no customer row yet (set by the dispatcher).
   */
  pendingReferralCode?: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}
