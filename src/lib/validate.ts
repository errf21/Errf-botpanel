/**
 * Telegram payload validation. NEVER trust callback data or user ids blindly.
 */
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from '../types.ts';

const CALLBACK_DATA_PATTERN = /^[a-z]{2,6}:[a-z][a-z0-9_]{1,24}$/;

export function isValidCallbackData(data: unknown): data is string {
  return typeof data === 'string' && CALLBACK_DATA_PATTERN.test(data);
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
