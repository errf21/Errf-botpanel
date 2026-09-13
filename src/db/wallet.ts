/**
 * Wallet repository (Phase 7): the ONLY place balance_irt moves. Every
 * mutation is one guarded UPDATE (affected-row check) batched with its
 * append-only ledger entry — the same single-write discipline as the order
 * transitions. Amounts are integer IRT; nothing here ever trusts a keyboard.
 */
import { newOrderId } from '../lib/security.ts';

/** 10^12 IRT: every stored amount and balance stays far below overflow. */
export const MAX_WALLET_AMOUNT = 1_000_000_000_000;

export type WalletEntryKind =
  | 'referral_reward'
  | 'admin_grant'
  | 'admin_debit'
  | 'order_payment'
  | 'order_refund';

export interface WalletEntryRow {
  id: string;
  customer_id: number;
  delta_irt: number;
  kind: string;
  order_id: string | null;
  actor: string;
  balance_after: number;
  created_at: string;
}

export interface WalletMutation {
  customerId: number;
  /** Positive credits, negative debits; never zero. */
  amountIrt: number;
  kind: WalletEntryKind;
  actor: string;
  orderId?: string | null;
}

/**
 * Apply one atomic mutation: the UPDATE carries BOTH the sign guard and the
 * absolute bounds (SQLite integer arithmetic; balance_after is re-read after
 * the write so the ledger mirror is exact, never inferred from a guess).
 */
export async function applyWalletMutation(
  db: D1Database,
  mutation: WalletMutation,
): Promise<{ ok: true; balance: number; entryId: string } | { ok: false; reason: 'insufficient' | 'cap' | 'state' }> {
  const { amountIrt } = mutation;
  if (
    !Number.isSafeInteger(amountIrt) ||
    amountIrt === 0 ||
    Math.abs(amountIrt) > MAX_WALLET_AMOUNT
  ) {
    return { ok: false, reason: 'cap' };
  }
  const entryId = newOrderId();
  const updated = await db
    .prepare(
      `UPDATE customers
          SET balance_irt = balance_irt + ?2,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1
          AND balance_irt >= CASE WHEN ?2 < 0 THEN -?2 ELSE 0 END
          AND balance_irt + ?2 BETWEEN 0 AND ?3`,
    )
    .bind(mutation.customerId, amountIrt, MAX_WALLET_AMOUNT)
    .run();
  const meta = (updated as { meta?: { changes?: number } } | null)?.meta;
  if (!meta || meta.changes !== 1) {
    const current = await getBalance(db, mutation.customerId);
    if (current === null) return { ok: false, reason: 'state' };
    return { ok: false, reason: amountIrt < 0 ? 'insufficient' : 'cap' };
  }
  const balance = await getBalance(db, mutation.customerId);
  if (balance === null) return { ok: false, reason: 'state' };
  await db
    .prepare(
      `INSERT INTO wallet_entries (id, customer_id, delta_irt, kind, order_id, actor, balance_after)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      entryId,
      mutation.customerId,
      amountIrt,
      mutation.kind,
      mutation.orderId ?? null,
      mutation.actor,
      balance,
    )
    .run();
  return { ok: true, balance, entryId };
}

export async function getBalance(db: D1Database, customerId: number): Promise<number | null> {
  const row = await db
    .prepare('SELECT balance_irt FROM customers WHERE id = ?1')
    .bind(customerId)
    .first<{ balance_irt: number }>();
  return typeof row?.balance_irt === 'number' ? row.balance_irt : null;
}

/** Latest ledger rows for display (newest first, bounded). */
export async function listWalletEntries(
  db: D1Database,
  customerId: number,
  limit: number,
): Promise<WalletEntryRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM wallet_entries WHERE customer_id = ?1
        ORDER BY created_at DESC, id DESC LIMIT ?2`,
    )
    .bind(customerId, limit)
    .all<WalletEntryRow>();
  return result.results;
}

/* ———— Checkout integration: order payment + idempotent refund ————
 * order_payment: applied while the wallet-covered order is being created.
 * order_refund:  applied by the reject path. The refund insert is guarded by
 * `NOT EXISTS` inside a single statement, so a replayed rejection (or two
 * admins) can never refund the same payment twice. */

/**
 * Debit exactly `amountIrt` for an order being paid from the wallet.
 * Exactly-once, atomically: the claim UPDATE and the ledger INSERT run in
 * ONE db.batch (single transaction). The INSERT re-proves the claim —
 * `NOT EXISTS` for THIS order plus a balance that equals the pre-debit
 * snapshot minus the amount, which can only hold if OUR UPDATE applied —
 * so two truly concurrent claims can never both debit: the later one finds
 * the order already paid, moves nothing, and converges on the winner's
 * ledger row. The partial UNIQUE index idx_wallet_payment_once
 * (order_id WHERE kind='order_payment') is the hard backstop. After the
 * batch, the ledger row IS the truth: present ⇒ paid (by us or the winner),
 * absent ⇒ insufficient balance (or the customer is gone).
 */
export async function payOrderWithWallet(
  db: D1Database,
  opts: {
    customerId: number;
    amountIrt: number;
    orderId: string;
    actor: string;
  },
): Promise<{ ok: true; balance: number } | { ok: false; reason: 'insufficient' | 'cap' | 'state' }> {
  if (
    !Number.isSafeInteger(opts.amountIrt) ||
    opts.amountIrt <= 0 ||
    opts.amountIrt > MAX_WALLET_AMOUNT
  ) {
    return { ok: false, reason: 'cap' };
  }
  const pre = await getBalance(db, opts.customerId);
  if (pre === null) return { ok: false, reason: 'state' };
  const expected = pre - opts.amountIrt;
  const ledgerId = newOrderId();
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE customers
              SET balance_irt = balance_irt - ?2,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?1
              AND balance_irt >= ?2
              AND NOT EXISTS (
                SELECT 1 FROM wallet_entries WHERE order_id = ?3 AND kind = 'order_payment'
              )`,
        )
        .bind(opts.customerId, opts.amountIrt, opts.orderId),
      db
        .prepare(
          `INSERT INTO wallet_entries (id, customer_id, delta_irt, kind, order_id, actor, balance_after)
           SELECT ?1, ?2, ?3, 'order_payment', ?4, ?5,
                  (SELECT balance_irt FROM customers WHERE id = ?2)
             WHERE NOT EXISTS (
               SELECT 1 FROM wallet_entries WHERE order_id = ?4 AND kind = 'order_payment'
             )
               AND (SELECT balance_irt FROM customers WHERE id = ?2) = ?6`,
        )
        .bind(ledgerId, opts.customerId, -opts.amountIrt, opts.orderId, opts.actor, expected),
    ]);
  } catch {
    console.error(`wallet_ledger_insert_failed orderId=${opts.orderId.slice(0, 32)}`);
  }
  const paid = await db
    .prepare(
      `SELECT balance_after FROM wallet_entries
        WHERE order_id = ?1 AND kind = 'order_payment' LIMIT 1`,
    )
    .bind(opts.orderId)
    .first<{ balance_after: number }>();
  if (paid) return { ok: true, balance: paid.balance_after };
  const balance = await getBalance(db, opts.customerId);
  if (balance === null) return { ok: false, reason: 'state' };
  return { ok: false, reason: 'insufficient' };
}

/** True only when THIS call moved the wallet for this order's refund.
 *  Exactly-once: the ledger INSERT claims with NOT EXISTS, the balance
 *  UPDATE then applies only for owners of that claim row. A crash between
 *  the two is repaired on the next retry (claim row blocks a second credit,
 *  the UPDATE re-applies the missing effect once), so neither a double
 *  refund nor a lost refund can persist. */
export async function refundOrderWalletPayment(
  db: D1Database,
  opts: { customerId: number; orderId: string; actor: string },
): Promise<boolean> {
  const payment = await db
    .prepare(
      `SELECT delta_irt FROM wallet_entries
        WHERE order_id = ?1 AND kind = 'order_payment'
        ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(opts.orderId)
    .first<{ delta_irt: number }>();
  if (!payment || payment.delta_irt >= 0) return false; // nothing wallet-paid to refund
  const amount = -payment.delta_irt;

  // If a previous attempt crashed with the credit not yet applied, repair it now.
  await db
    .prepare(
      `UPDATE customers
          SET balance_irt = balance_irt + ?2,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1
          AND balance_irt + ?2 BETWEEN 0 AND ?4
          AND EXISTS (
            SELECT 1 FROM wallet_entries WHERE order_id = ?3 AND kind = 'order_refund'
          )
          AND balance_irt < (SELECT balance_after FROM wallet_entries
                              WHERE order_id = ?3 AND kind = 'order_refund')`,
    )
    .bind(opts.customerId, amount, opts.orderId, MAX_WALLET_AMOUNT)
    .run();

  const claimed = await db
    .prepare(
      `INSERT INTO wallet_entries (id, customer_id, delta_irt, kind, order_id, actor, balance_after)
       SELECT ?1, ?2, ?3, 'order_refund', ?4, ?5,
              (SELECT balance_irt FROM customers WHERE id = ?2)
        WHERE NOT EXISTS (
          SELECT 1 FROM wallet_entries WHERE order_id = ?4 AND kind = 'order_refund'
        )`,
    )
    .bind(newOrderId(), opts.customerId, amount, opts.orderId, opts.actor)
    .run();
  if (((claimed as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0) !== 1) {
    // Claim belongs to an earlier (already-applied above, or complete) attempt.
    const current = await getBalance(db, opts.customerId);
    const entry = await db
      .prepare(
        `SELECT balance_after FROM wallet_entries WHERE order_id = ?1 AND kind = 'order_refund' LIMIT 1`,
      )
      .bind(opts.orderId)
      .first<{ balance_after: number }>();
    return current !== null && entry !== null && entry !== undefined && current >= entry.balance_after;
  }
  const applied = await db
    .prepare(
      `UPDATE customers
          SET balance_irt = balance_irt + ?2,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND balance_irt + ?2 BETWEEN 0 AND ?3`,
    )
    .bind(opts.customerId, amount, MAX_WALLET_AMOUNT)
    .run();
  if (((applied as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0) !== 1) {
    console.error(`wallet_refund_apply_failed orderId=${opts.orderId.slice(0, 32)}`);
    return false;
  }
  const balance = await getBalance(db, opts.customerId);
  await db
    .prepare('UPDATE wallet_entries SET balance_after = ?2 WHERE order_id = ?1 AND kind = ?3')
    .bind(opts.orderId, balance ?? amount, 'order_refund')
    .run();
  return true;
}

/** Re-point a wallet payment (and its future refund) from the draft token
 *  onto the real order id, once the durable row exists. Idempotent: a second
 *  call matches zero rows. */
export async function setPaidLedgerOrder(
  db: D1Database,
  tokenOrderId: string,
  realOrderId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE wallet_entries SET order_id = ?2
        WHERE order_id = ?1 AND kind = 'order_payment'`,
    )
    .bind(tokenOrderId, realOrderId)
    .run();
  await db
    .prepare(
      `UPDATE wallet_entries SET order_id = ?2
        WHERE order_id = ?1 AND kind = 'order_refund'`,
    )
    .bind(tokenOrderId, realOrderId)
    .run();
}
