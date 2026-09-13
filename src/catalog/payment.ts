/**
 * Payment instructions: a versioned JSON document in the `settings` table
 * (seeded by 0004). Like the catalog, nothing here is hardcoded and a
 * malformed document degrades safely — payment info must never render
 * half-parse garbage to a customer about to transfer money.
 */

export const PAYMENT_SCHEMA = 1;

export interface PaymentInfo {
  holder: string;
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

/**
 * Phase 8C: the seller card is a secret, sourced ONLY from the
 * PAYMENT_CARD_NUMBER env binding (`wrangler secret put PAYMENT_CARD_NUMBER`)
 * — never from source, D1, or Git. Whitespace from secret pasting is
 * trimmed; a missing/invalid value fails CLOSED (the caller shows the
 * existing paymentInfoUnavailable notice). The value is never logged.
 */
export function paymentCardFromEnv(env: { PAYMENT_CARD_NUMBER?: string }): string | null {
  const value = (env.PAYMENT_CARD_NUMBER ?? '').trim();
  if (value === '') return null;
  return CARD_PATTERN.test(value) ? value : null;
}

export function parsePaymentInfo(doc: unknown): PaymentInfoResult {
  const record = asRecord(doc);
  if (!record || record['schema'] !== PAYMENT_SCHEMA) {
    return { ok: false, error: 'payment_info:schema' };
  }
  const holder = boundedString(record['holder'], 1, 100);
  const instructions = boundedString(record['instructions'], 1, 800);
  let iban: string | null = null;
  if (record['iban'] !== null && record['iban'] !== undefined) {
    iban = boundedString(record['iban'], 15, 34, IBAN_PATTERN);
    if (iban === null) return { ok: false, error: 'payment_info:iban' };
  }
  if (holder === null || instructions === null) {
    return { ok: false, error: 'payment_info:fields' };
  }
  // Phase 8C: `card_number` in the doc is IGNORED (a stray/placeholder key
  // never invalidates the document). The seller card comes ONLY from the
  // PAYMENT_CARD_NUMBER Worker secret — `paymentCardFromEnv` above.
  return { ok: true, info: { holder, iban, instructions } };
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
