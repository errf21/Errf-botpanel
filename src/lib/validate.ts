/**
 * Telegram payload validation. NEVER trust callback data or user ids blindly.
 */
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from '../types.ts';

const CALLBACK_DATA_PATTERN = /^[a-z]{2,6}:[a-z0-9][a-z0-9_]{0,23}$/;

export function isValidCallbackData(data: unknown): data is string {
  return typeof data === 'string' && CALLBACK_DATA_PATTERN.test(data);
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
