/**
 * Telegram payload validation. NEVER trust callback data or user ids blindly.
 */
import type {
  TelegramCallbackQuery,
  TelegramDocument,
  TelegramMessage,
  TelegramUpdate,
} from '../types.ts';

const CALLBACK_DATA_PATTERN = /^[a-z]{2,6}:[a-z0-9][a-z0-9_]{0,23}$/;

/**
 * Admin action callbacks embed a full order id (Crockford base32, exactly the
 * 28 chars newOrderId mints: 12-char time + 16-char random). Kept as a
 * SEPARATE strict pattern; nothing else in the system may contain uppercase.
 */
const ORDER_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{28}$/;
const ADMIN_CALLBACK_PATTERN = /^adm:(ok|no|skip|rt):[0-9A-HJKMNP-TV-Z]{28}$/;

/**
 * Phase 6: service callbacks embed a full 28-char order id too, so they get
 * their OWN strict pattern (the generic one caps payloads at 24 chars).
 */
const SERVICE_CALLBACK_PATTERN = /^svc:(det|ref|rnw):[0-9A-HJKMNP-TV-Z]{28}$/;

export function isValidCallbackData(data: unknown): data is string {
  return (
    typeof data === 'string' &&
    (CALLBACK_DATA_PATTERN.test(data) ||
      ADMIN_CALLBACK_PATTERN.test(data) ||
      SERVICE_CALLBACK_PATTERN.test(data))
  );
}

export type AdminAction = 'ok' | 'no' | 'skip' | 'rt';

export interface AdminCallback {
  action: AdminAction;
  orderId: string;
}

/** Parses ONLY data that already matched ADMIN_CALLBACK_PATTERN. */
export function parseAdminCallback(data: string): AdminCallback | null {
  if (!ADMIN_CALLBACK_PATTERN.test(data)) return null;
  const [, action, orderId] = /^adm:(\w+):(.+)$/.exec(data) ?? [];
  if (!orderId || !ORDER_ID_PATTERN.test(orderId)) return null;
  if (action !== 'ok' && action !== 'no' && action !== 'skip' && action !== 'rt') return null;
  return { action, orderId };
}

export type ServiceAction = 'det' | 'ref' | 'rnw';

export interface ServiceCallback {
  action: ServiceAction;
  orderId: string;
}

/** Parses ONLY data that already matched SERVICE_CALLBACK_PATTERN (Phase 6). */
export function parseServiceCallback(data: string): ServiceCallback | null {
  if (!SERVICE_CALLBACK_PATTERN.test(data)) return null;
  const [, action, orderId] = /^svc:(\w+):(.+)$/.exec(data) ?? [];
  if (!orderId || !ORDER_ID_PATTERN.test(orderId)) return null;
  if (action !== 'det' && action !== 'ref' && action !== 'rnw') return null;
  return { action, orderId };
}

export function isValidOrderId(value: unknown): value is string {
  return typeof value === 'string' && ORDER_ID_PATTERN.test(value);
}

/** Telegram file ids are base64url-ish strings; bound the size, nothing more. */
const TELEGRAM_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export function isValidFileId(value: unknown): value is string {
  return typeof value === 'string' && TELEGRAM_FILE_ID_PATTERN.test(value);
}

/** Free-text payment reference (receipt caption): visible chars, capped. */
export function sanitizePaymentReference(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (text.length === 0 || text.length > 128) return null;
  return text;
}

/** Rejection reason typed by an admin: visible chars, capped at 200. */
export function sanitizeRejectionReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (text.length === 0 || text.length > 200) return null;
  return text;
}

export interface ReceiptMedia {
  kind: 'photo' | 'document';
  fileId: string;
  /** Sanitized caption — a payment reference if present, else absent. */
  reference?: string;
}

/**
 * Extracts a receipt from an incoming message: documents are taken as-is,
 * photos resolve to the LARGEST rendition (Telegram sends them smallest-first).
 * Anything malformed degrades to null — a forged/oversized file_id never
 * reaches the DB.
 */
export function extractReceiptMedia(message: TelegramMessage | undefined): ReceiptMedia | null {
  if (!message) return null;
  const reference = sanitizePaymentReference(message.caption) ?? undefined;

  const document: TelegramDocument | undefined = message.document;
  if (document) {
    if (!isValidFileId(document.file_id)) return null;
    return { kind: 'document', fileId: document.file_id, reference };
  }

  const sizes = message.photo;
  if (Array.isArray(sizes) && sizes.length > 0) {
    const largest = sizes[sizes.length - 1];
    if (!largest || !isValidFileId(largest.file_id)) return null;
    return { kind: 'photo', fileId: largest.file_id, reference };
  }
  return null;
}

/** Callback option value: at most 8 digits → bounded integer, no overflow games. */
export function parseCallbackValue(value: string): number | 'custom' | null {
  if (value === 'custom') return 'custom';
  if (!/^[0-9]{1,8}$/.test(value)) return null;
  const num = Number(value);
  return Number.isSafeInteger(num) && num >= 0 ? num : null;
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Normalizes Persian/Arabic-Indic digits + separators, then requires pure 1–8 digits. */
export function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim().replace(/\s+/gu, '').replace(/[٬,]/g, '');
  text = text.replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)));
  text = text.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
  if (!/^[0-9]{1,8}$/.test(text)) return null;
  const num = Number(text);
  return Number.isSafeInteger(num) && num >= 0 ? num : null;
}

export function isValidTelegramUserId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

/** Loose structural check — we only dispatch on what we understand. */
export function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { update_id?: unknown };
  return typeof candidate.update_id === 'number' && Number.isSafeInteger(candidate.update_id);
}

export function messageText(
  message: TelegramMessage | undefined,
): string | null {
  if (message?.text && typeof message.text === 'string') return message.text;
  return null;
}

export interface ParsedCommand {
  name: string;
  args: string[];
}

export function parseCommand(text: string): ParsedCommand | null {
  if (!text.startsWith('/')) return null;
  const parts = text.trim().split(/\s+/);
  const [raw = '', ...args] = parts;
  const [name = '', mention] = raw.slice(1).split('@');
  if (!/^[a-z._]{2,32}$/.test(name.toLowerCase())) return null;
  void mention; // addressed commands (/start@BotName) are handled the same
  return { name: name.toLowerCase(), args };
}

/** Config names: 1–64 visible chars, no control chars, no leading slash. */
export function sanitizeConfigName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > 64) return null;
  if (name.startsWith('/')) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export interface CallbackTarget {
  callbackQueryId: string;
  messageId: number | null;
  messageChatId: number | null;
}

export function extractCallbackTarget(cb: TelegramCallbackQuery): CallbackTarget | null {
  const id = cb.id;
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  return {
    callbackQueryId: id,
    messageId: cb.message?.message_id ?? null,
    messageChatId: cb.message?.chat?.id ?? null,
  };
}
