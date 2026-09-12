/**
 * Payment instructions: a versioned JSON document in the `settings` table
 * (seeded by 0004). Like the catalog, nothing here is hardcoded and a
 * malformed document degrades safely — payment info must never render
 * half-parse garbage to a customer about to transfer money.
 */

export const PAYMENT_SCHEMA = 1;

export interface PaymentInfo {
  holder: string;
  cardNumber: string;
  iban: string | null;
  instructions: string;
}

export type PaymentInfoResult =
  | { ok: true; info: PaymentInfo }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, min: number, max: number, pattern?: RegExp): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length < min || text.length > max) return null;
  // control chars out of settings-authored display text
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  if (pattern && !pattern.test(text)) return null;
  return text;
}

const CARD_PATTERN = /^[0-9-]{10,34}$/;
const IBAN_PATTERN = /^[A-Z0-9]{15,34}$/;

export function parsePaymentInfo(doc: unknown): PaymentInfoResult {
  const record = asRecord(doc);
  if (!record || record['schema'] !== PAYMENT_SCHEMA) {
    return { ok: false, error: 'payment_info:schema' };
  }
  const holder = boundedString(record['holder'], 1, 100);
  const card = boundedString(record['card_number'], 10, 34, CARD_PATTERN);
  const instructions = boundedString(record['instructions'], 1, 800);
  let iban: string | null = null;
  if (record['iban'] !== null && record['iban'] !== undefined) {
    iban = boundedString(record['iban'], 15, 34, IBAN_PATTERN);
    if (iban === null) return { ok: false, error: 'payment_info:iban' };
  }
  if (holder === null || card === null || instructions === null) {
    return { ok: false, error: 'payment_info:fields' };
  }
  return { ok: true, info: { holder, cardNumber: card, iban, instructions } };
}

export async function loadPaymentInfo(db: D1Database): Promise<PaymentInfoResult> {
  let raw: string | undefined;
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'payment_info'`)
      .bind()
      .first<{ value: string }>();
    raw = row?.value;
  } catch {
    return { ok: false, error: 'payment_info:unavailable' };
  }
  if (raw === undefined) return { ok: false, error: 'payment_info:missing' };
  try {
    return parsePaymentInfo(JSON.parse(raw));
  } catch {
    return { ok: false, error: 'payment_info:json' };
  }
}
