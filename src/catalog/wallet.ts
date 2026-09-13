/**
 * Wallet policy: a versioned JSON document in the `settings` table (seeded
 * by 0007). Same degrade-safe contract as catalog/payment/renewal — a
 * malformed document NEVER crashes an update and never invents defaults;
 * callers treat it as "wallet is not available right now" (enabled=false).
 *
 * Knobs:
 *  - enabled: kill switch for spending, display, grants and debits.
 *  - maxCreditIrt / maxDebitIrt: hard per-operation caps for admin
 *    grant/debit so a mistyped command can never mint absurd balances.
 */

export const WALLET_SCHEMA = 1;
const MAX_MONEY = 1_000_000_000_000; // 10^12 IRT — safe-integer headroom

export interface WalletConfig {
  enabled: boolean;
  maxCreditIrt: number;
  maxDebitIrt: number;
}

export type WalletResult =
  | { ok: true; config: WalletConfig }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

export function parseWalletConfig(doc: unknown): WalletResult {
  const record = asRecord(doc);
  if (!record || record['schema'] !== WALLET_SCHEMA) {
    return { ok: false, error: 'wallet:schema' };
  }
  if (typeof record['enabled'] !== 'boolean') {
    return { ok: false, error: 'wallet:enabled' };
  }
  const maxCredit = asInt(record['max_credit_irt'], 1, MAX_MONEY);
  const maxDebit = asInt(record['max_debit_irt'], 1, MAX_MONEY);
  if (maxCredit === null || maxDebit === null) {
    return { ok: false, error: 'wallet:caps' };
  }
  return { ok: true, config: { enabled: record['enabled'], maxCreditIrt: maxCredit, maxDebitIrt: maxDebit } };
}

export async function loadWalletConfig(db: D1Database): Promise<WalletResult> {
  let raw: string | undefined;
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'wallet'`)
      .bind()
      .first<{ value: string }>();
    raw = row?.value;
  } catch {
    return { ok: false, error: 'wallet:unavailable' };
  }
  if (raw === undefined) return { ok: false, error: 'wallet:missing' };
  try {
    return parseWalletConfig(JSON.parse(raw));
  } catch {
    return { ok: false, error: 'wallet:json' };
  }
}
