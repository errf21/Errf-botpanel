/**
 * Free-test claims: the once-EVER wall (migration 0014). `customer_id` is the
 * PK, so "one test per user for life" is enforced by the database, never by
 * UI state or memory. Claiming follows the project's exactly-once discipline
 * (dedupe / referral_rewards): mint the order id BEFORE any write, attempt a
 * single INSERT — a constraint violation is not an error, it is "claimed".
 *
 * The stored `order_id` doubles as the recovery anchor: if the claim INSERT
 * wins but the order INSERT then fails (crash, DB error), the next tap finds
 * the claim row, (re)builds the order under the SAME id, and provisioning's
 * own guards keep the rest convergent. The order id is also the checkout
 * idempotency key, so a rebuild can never double-create.
 */
import { newOrderId } from '../lib/security.ts';
import { getOrderById, insertOrderWithEvent } from './orders.ts';

export type FreeTestClaimOutcome =
  /** THIS call owns the claim: create the order with `orderId`, exactly once. */
  | { kind: 'won'; orderId: string }
  /** A claim exists (this or an earlier tap) — it carries the order id. */
  | { kind: 'claimed'; orderId: string }
  /** A real DB failure: nothing was written, safe to retry later. */
  | { kind: 'error' };

/** Attempt the once-ever claim. Never throws; zero writes when not 'won'. */
export async function claimFreeTest(
  db: D1Database,
  customerId: number,
): Promise<FreeTestClaimOutcome> {
  const orderId = newOrderId();
  try {
    await db
      .prepare('INSERT INTO free_test_claims (customer_id, order_id) VALUES (?1, ?2)')
      .bind(customerId, orderId)
      .run();
    return { kind: 'won', orderId };
  } catch {
    // PK violation ⇒ claimed before (also covers the lost race between two
    // concurrent taps). Anything else still degrades to a plain error read.
  }
  const existing = await getFreeTestClaim(db, customerId);
  if (existing === null) return { kind: 'error' };
  return { kind: 'claimed', orderId: existing.orderId };
}

export interface FreeTestClaim {
  orderId: string;
  createdAt: string;
}

export async function getFreeTestClaim(
  db: D1Database,
  customerId: number,
): Promise<FreeTestClaim | null> {
  const row = await db
    .prepare('SELECT order_id, created_at FROM free_test_claims WHERE customer_id = ?1')
    .bind(customerId)
    .first<{ order_id: string; created_at: string }>();
  if (!row) return null;
  return { orderId: row.order_id, createdAt: row.created_at };
}

/**
 * Release a claim THIS execution minted and whose order insert verifiably
 * failed: guarded on both ids, so a late release can never delete a claim
 * another tap wrote in the meantime (that would un-cap the once-ever wall).
 */
export async function releaseFreeTestClaim(
  db: D1Database,
  customerId: number,
  orderId: string,
): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM free_test_claims WHERE customer_id = ?1 AND order_id = ?2')
      .bind(customerId, orderId)
      .run();
  } catch {
    // best effort only — the recovery path on the next tap covers a miss
  }
}

/** DB-authoritative "is this order the free test?" (renewal gate, notices). */
export async function isFreeTestOrder(db: D1Database, orderId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS hit FROM free_test_claims WHERE order_id = ?1')
    .bind(orderId)
    .first<{ hit: number }>();
  return row !== null;
}

/**
 * Create the test order after a WON (or recovered) claim. Born 'approved'
 * like a wallet-paid order — no receipt, no admin queue — verified_by ties
 * it to the free-test program. Same atomic (order + audit event) batch.
 *
 * RACE CONTRACT: a PK collision is NOT an error — the claim row's order id
 * is shared by every concurrent tap for this customer, so the collision IS
 * the join-up: a lost insert 'exists' (the counterpart won and its claim
 * survives), a real DB failure is 'error', nothing follows either way.
 */
export type FreeTestOrderInsert =
  | { kind: 'created' }
  | { kind: 'exists' }
  | { kind: 'error' };

export async function insertFreeTestOrder(
  db: D1Database,
  opts: { orderId: string; customerId: number; selections: string },
): Promise<FreeTestOrderInsert> {
  try {
    await insertOrderWithEvent(db, {
      id: opts.orderId,
      customerId: opts.customerId,
      selections: opts.selections,
      amount: 0,
      currency: 'IRT',
      idempotencyKey: opts.orderId, // == claim anchor: rebuilds can never dupe
      initialState: 'approved',
      verifiedBy: 'free_test',
      initialEvent: 'order_created_free_test',
    });
    return { kind: 'created' };
  } catch (error) {
    // Atomic batch rolled back on failure; the id read tells the two apart.
    const existing = await getOrderById(db, opts.orderId);
    if (existing !== null && existing.customer_id === opts.customerId) {
      return { kind: 'exists' };
    }
    const name = error instanceof Error ? error.name : 'unknown';
    console.error(`free_test_order_insert_failed error=${name.slice(0, 40)}`);
    return { kind: 'error' };
  }
}
