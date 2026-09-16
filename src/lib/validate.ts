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

/**
 * Phase 7: ticket callbacks carry a full ULID ticket id — like `adm:`/`svc:`,
 * stale buttons can only ever address the ticket they were minted for (the
 * handler also checks the ticket is still live before acting).
 */
const TICKET_CALLBACK_PATTERN = /^tsk:(rp|cl|vw):[0-9A-HJKMNP-TV-Z]{28}$/;

/** Phase 7: announcement job control carries the announcement id (ULID). */
const ANNOUNCE_CALLBACK_PATTERN = /^ann:(go|ct):[0-9A-HJKMNP-TV-Z]{28}$/;

/**
 * Phase 16: the admin panel-service delete needs an EXPLICIT confirmation —
 * the `pdel:` namespace carries the target order id so a stale/forged tap can
 * only ever address the service its confirmation card was minted for.
 */
const PANEL_DELETE_CALLBACK_PATTERN = /^pdel:(ok|no):[0-9A-HJKMNP-TV-Z]{28}$/;

/* ———— Phase 17: customer wallet top-up admin review ————
 * `tup:` carries the wallet_topups id (ULID, same 28-char shape as orders).
 * Produced ONLY by topupReviewKeyboard(), consumed ONLY by
 * parseTopupCallback(); every tap re-checks admin + top-up state server-side.
 */
const TOPUP_CALLBACK_PATTERN = /^tup:(ok|no):[0-9A-HJKMNP-TV-Z]{28}$/;

export function isValidCallbackData(data: unknown): data is string {
  return (
    typeof data === 'string' &&
    (CALLBACK_DATA_PATTERN.test(data) ||
      ADMIN_CALLBACK_PATTERN.test(data) ||
      SERVICE_CALLBACK_PATTERN.test(data) ||
      TICKET_CALLBACK_PATTERN.test(data) ||
      ANNOUNCE_CALLBACK_PATTERN.test(data) ||
      PANEL_DELETE_CALLBACK_PATTERN.test(data) ||
      TOPUP_CALLBACK_PATTERN.test(data))
  );
}

/**
 * Phase 12: pricing-management callbacks live in the `prc:` namespace. The
 * generic pattern above ALREADY admits their shape (short payloads), but they
 * get their OWN strict parser so nothing unforeseen can ever reach the
 * pricing handler — actions are a fixed vocabulary and edit tokens are plain
 * field identifiers ('base', 'gb', 'd2', 'u10'…).
 */
const PRICING_EDIT_PATTERN = /^prc:e_([a-z][a-z0-9]{0,19})$/;

export type PricingCallback =
  | { action: 'menu' | 'ok' | 'no' }
  | { action: 'edit'; token: string };

export function parsePricingCallback(data: string): PricingCallback | null {
  if (data === 'prc:menu') return { action: 'menu' };
  if (data === 'prc:ok') return { action: 'ok' };
  if (data === 'prc:no') return { action: 'no' };
  const match = PRICING_EDIT_PATTERN.exec(data);
  const token = match?.[1];
  return token ? { action: 'edit', token } : null;
}

/**
 * Phase 13: the sales stop switch lives in the `sal:` namespace. The generic
 * pattern already admits the shape, but the handler consumes ONLY this fixed
 * vocabulary — nothing else can ever reach the sales surface.
 */
const SALES_CALLBACK_PATTERN = /^sal:(view|stop|start)$/;

export type SalesAction = 'view' | 'stop' | 'start';

/** Parses ONLY data that already matched SALES_CALLBACK_PATTERN. */
export function parseSalesCallback(data: string): SalesAction | null {
  const match = SALES_CALLBACK_PATTERN.exec(data);
  return match ? (match[1] as SalesAction) : null;
}

/**
 * Admin pricing value entry: Persian/Arabic digits + separators are accepted
 * (same normalization family as parsePositiveInt), but pricing must reach the
 * 1e9 config cap, so the digit ceiling is 12 — the safe-integer bound check
 * happens against PricingConfig's own MAX_VALUE afterwards. A minus sign
 * never parses: duration/user entries allow 0, nothing allows negatives.
 */
const PERSIAN_DIGITS_ALL = /[۰-۹]/g;
const ARABIC_DIGITS_ALL = /[٠-٩]/g;

export function parsePricingAmount(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim().replace(/\s+/gu, '').replace(/[٬,]/g, '');
  text = text.replace(PERSIAN_DIGITS_ALL, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  text = text.replace(ARABIC_DIGITS_ALL, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (!/^[0-9]{1,12}$/.test(text)) return null;
  const num = Number(text);
  return Number.isSafeInteger(num) ? num : null;
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

export type TicketAction = 'rp' | 'cl' | 'vw';

export interface TicketCallback {
  action: TicketAction;
  ticketId: string;
}

/** Parses ONLY data that already matched TICKET_CALLBACK_PATTERN (Phase 7). */
export function parseTicketCallback(data: string): TicketCallback | null {
  if (!TICKET_CALLBACK_PATTERN.test(data)) return null;
  const [, action, ticketId] = /^tsk:(\w+):(.+)$/.exec(data) ?? [];
  if (!ticketId || !ORDER_ID_PATTERN.test(ticketId)) return null;
  if (action !== 'rp' && action !== 'cl' && action !== 'vw') return null;
  return { action, ticketId };
}

export type AnnounceAction = 'go' | 'ct';

export interface AnnounceCallback {
  action: AnnounceAction;
  announcementId: string;
}

/** Parses ONLY data that already matched ANNOUNCE_CALLBACK_PATTERN (Phase 7). */
export function parseAnnounceCallback(data: string): AnnounceCallback | null {
  if (!ANNOUNCE_CALLBACK_PATTERN.test(data)) return null;
  const [, action, id] = /^ann:(\w+):(.+)$/.exec(data) ?? [];
  if (!id || !ORDER_ID_PATTERN.test(id)) return null;
  if (action !== 'go' && action !== 'ct') return null;
  return { action, announcementId: id };
}

/* ———— Phase 16: admin panel-service delete (explicit confirm) ———— */

export type PanelDeleteAction = 'ok' | 'no';

export interface PanelDeleteCallback {
  action: PanelDeleteAction;
  orderId: string;
}

/** Parses ONLY data that already matched PANEL_DELETE_CALLBACK_PATTERN. */
export function parsePanelDeleteCallback(data: string): PanelDeleteCallback | null {
  if (!PANEL_DELETE_CALLBACK_PATTERN.test(data)) return null;
  const [, action, orderId] = /^pdel:(\w+):(.+)$/.exec(data) ?? [];
  if (!orderId || !ORDER_ID_PATTERN.test(orderId)) return null;
  if (action !== 'ok' && action !== 'no') return null;
  return { action, orderId };
}

/* ———— Phase 17: wallet top-up review + amount parsing ———— */

export type TopupReviewAction = 'ok' | 'no';

export interface TopupCallback {
  action: TopupReviewAction;
  topupId: string;
}

/** Parses ONLY data that already matched TOPUP_CALLBACK_PATTERN. */
export function parseTopupCallback(data: string): TopupCallback | null {
  if (!TOPUP_CALLBACK_PATTERN.test(data)) return null;
  const [, action, topupId] = /^tup:(\w+):(.+)$/.exec(data) ?? [];
  if (!topupId || !ORDER_ID_PATTERN.test(topupId)) return null;
  if (action !== 'ok' && action !== 'no') return null;
  return { action, topupId };
}

/** Minimum customer top-up: 45,000 Toman, same IRT unit as the wallet. */
export const MIN_TOPUP_IRT = 45_000;

/**
 * Customer top-up amount: whole Toman number, Persian/Arabic digits and
 * thousands separators accepted (same normalization family as
 * parsePricingAmount/parsePositiveInt). Range is enforced by the CALLER
 * against MIN_TOPUP_IRT..maxCreditIrt; this parser only guarantees a
 * positive safe integer within the wallet's absolute bound.
 */
export function parseTopupAmount(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  // Explicit sign or decimal input is never a top-up amount (checked on the
  // raw text BEFORE separator stripping — a [+-.] class would also match ',').
  const trimmed = raw.trim();
  if (/^[+-]/.test(trimmed)) return null;
  if (trimmed.includes('.')) return null;
  let text = trimmed.replace(/\s+/gu, '').replace(/[٬,]/g, '');
  text = text.replace(PERSIAN_DIGITS_ALL, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  text = text.replace(ARABIC_DIGITS_ALL, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (!/^[0-9]{1,13}$/.test(text)) return null;
  const num = Number(text);
  if (!Number.isSafeInteger(num) || num <= 0) return null;
  if (num > 1_000_000_000_000) return null;
  return num;
}

/**
 * Admin /credit target that may be a numeric Telegram id or a @username.
 * Returns the stripped username (without '@') or null. Numeric ids keep
 * flowing through parsePositiveId-equivalent handling at the call site.
 */
export function parseUsernameTarget(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text.startsWith('@')) text = text.slice(1);
  text = text.trim();
  if (!/^[A-Za-z0-9_]{5,32}$/.test(text)) return null;
  return text;
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

/** Support message body (customer or admin): newlines kept, caps enforced. */
export function sanitizeSupportBody(raw: unknown, max = 2000): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (text.length === 0 || text.length > max) return null;
  return text;
}

/** Admin grant/debit argument: "+ <digits>" / "- <digits>" style amounts, IRT. */
export function parseWalletAmount(raw: string): { sign: 1 | -1; amount: number } | null {
  const match = /^([+-]?)[\s]*([0-9\u06F0-\u06F9\u0660-\u0669]{1,13})$/.exec(raw.trim());
  if (!match) return null;
  const amount = parsePositiveInt(match[2] ?? '');
  if (amount === null || amount <= 0) return null;
  return { sign: match[1] === '-' ? -1 : 1, amount };
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
