/**
 * Sales stop switch (Phase 13): a versioned JSON document in the `settings`
 * table (seeded by 0013). Semantics are a TEMPORARY COMMERCIAL STOP of
 * service provisioning — new purchases AND renewals, i.e. every path that
 * creates or extends a paid service. Existing-service functionality (detail,
 * refresh, subscription pages, payment/approval of orders that predate the
 * stop) is deliberately NOT gated.
 *
 * The state lives ONLY in D1: the worker has no cache, so a toggle is
 * immediately visible to every request and survives restarts/redeploys.
 *
 * FAIL DIRECTION — the opposite of the purchase catalog (which fails closed):
 * a missing row, invalid JSON, a wrong schema or a DB read error all mean
 * sales ENABLED. Only an explicit `"stopped": true` blocks anything, so a
 * config glitch can never accidentally halt the business. Malformed state is
 * surfaced once in the admin /sales view instead (the toggle repairs it).
 */

export const SALES_SCHEMA = 1;

export interface SalesConfig {
  stopped: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Strict parse: valid ONLY with the exact schema and a boolean `stopped`. */
export function parseSalesConfig(doc: unknown): SalesConfig | null {
  const record = asRecord(doc);
  if (!record || record['schema'] !== SALES_SCHEMA) return null;
  if (typeof record['stopped'] !== 'boolean') return null;
  return { stopped: record['stopped'] };
}

export interface SalesState {
  config: SalesConfig;
  /** Present only when the row exists but cannot be trusted (admin view hint). */
  malformed: boolean;
}

/**
 * Fail-open loader: ONLY `{"schema":1,"stopped":true}` stops sales.
 * Never throws — a broken settings read is "enabled", and even the
 * malformed-document case is reported for ADMIN DISPLAY but still resolves
 * to enabled until an admin toggle writes a clean document.
 */
export async function loadSalesState(db: D1Database): Promise<SalesState> {
  let raw: string | undefined;
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'sales'`)
      .bind()
      .first<{ value: string }>();
    raw = row?.value;
  } catch {
    return { config: { stopped: false }, malformed: false };
  }
  if (raw === undefined) return { config: { stopped: false }, malformed: false };
  try {
    const parsed = parseSalesConfig(JSON.parse(raw));
    if (parsed !== null) return { config: parsed, malformed: false };
  } catch {
    /* fall through: fail-open with a display hint */
  }
  return { config: { stopped: false }, malformed: true };
}

/** The gate every commercial-creation path asks. Never throws. */
export async function isSalesStopped(db: D1Database): Promise<boolean> {
  return (await loadSalesState(db)).config.stopped;
}
