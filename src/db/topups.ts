/**
 * Phase 17: customer wallet top-up repository — isolated from orders.
 *
 * A top-up affects ONLY:
 *   wallet_topups + wallet_entries(kind='topup_credit') + customers.balance_irt
 *
 * It never creates orders/order_events, never provisions, never pays
 * referrals, never schedules reminders. Money moves ONLY through
 * creditTopupOnce(), which is a credit-direction twin of
 * payOrderWithWallet(): one D1 batch, NOT EXISTS guards in BOTH statements,
 * a partial UNIQUE backstop (idx_wallet_topup_once), and ledger-truth
 * reconciliation — so duplicate approvals converge instead of double-credit.
 * applyWalletMutation() is deliberately NOT used here (separate UPDATE +
 * INSERT, no exactly-once key for top-ups).
 */
import { newOrderId } from '../lib/security.ts';
import { getBalance } from './wallet.ts';

export const MAX_TOPUP_AMOUNT = 1_000_000_000_000;

export type TopupState =
  | 'await_amount'
  | 'await_receipt'
  | 'pending_review'
  | 'approved'
  | 'rejected';

export interface TopupRow {
  id: string;
  customer_id: number;
  amount_irt: number;
  state: TopupState;
  credit_status: 'uncredited'|'credited'|'blocked'|'review_required';
  credit_error: string|null;
  receipt_file_id: string | null;
  receipt_kind: string | null;
  payment_reference: string | null;
  idempotency_key: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reject_reason: string | null;
  created_at: string;
  updated_at: string;
}

function changeCount(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | null)?.meta;
  return typeof meta?.changes === 'number' ? meta.changes : 0;
}

/**
 * Create (or reuse on idempotency-key hit) a top-up request.
 * The row is born 'await_receipt': the amount is already validated by the
 * caller, so the only remaining customer step is the receipt upload.
 * Returns the row and whether THIS call created it.
 */
export async function createTopupRequest(
  db: D1Database,
  opts: { customerId: number; amountIrt: number; idempotencyKey: string },
): Promise<{ topup: TopupRow; created: boolean }> {
  const existing = await db
    .prepare('SELECT * FROM wallet_topups WHERE idempotency_key = ?1')
    .bind(opts.idempotencyKey)
    .first<TopupRow>();
  if (existing) return { topup: existing, created: false };
  const id = newOrderId();
  try {
    await db
      .prepare(
        `INSERT INTO wallet_topups (id, customer_id, amount_irt, state, idempotency_key)
         VALUES (?1, ?2, ?3, 'await_receipt', ?4)`,
      )
      .bind(id, opts.customerId, opts.amountIrt, opts.idempotencyKey)
      .run();
  } catch {
    const winner = await db
      .prepare('SELECT * FROM wallet_topups WHERE idempotency_key = ?1')
      .bind(opts.idempotencyKey)
      .first<TopupRow>();
    if (winner) return { topup: winner, created: false };
    throw new Error('topup_create_failed');
  }
  const created = await db
    .prepare('SELECT * FROM wallet_topups WHERE id = ?1')
    .bind(id)
    .first<TopupRow>();
  if (!created) throw new Error('topup_create_unconfirmed');
  return { topup: created, created: true };
}

export async function getTopupById(
  db: D1Database,
  topupId: string,
): Promise<TopupRow | null> {
  return db
    .prepare('SELECT * FROM wallet_topups WHERE id = ?1')
    .bind(topupId)
    .first<TopupRow>();
}

export async function findTopupByIdempotencyKey(
  db: D1Database,
  key: string,
): Promise<TopupRow | null> {
  return db
    .prepare('SELECT * FROM wallet_topups WHERE idempotency_key = ?1')
    .bind(key)
    .first<TopupRow>();
}

export type TopupReceiptOutcome =
  | { ok: true; topup: TopupRow; replaced: boolean }
  | { ok: false; error: 'not_found' | 'owner_mismatch' | 'invalid_state' | 'state_changed' };

/**
 * First receipt OR replacement while pending_review: stores file id +
 * optional reference and (re-)enters pending_review. Guarded UPDATE on the
 * snapshot-read state makes concurrent uploads converge.
 */
export async function submitTopupReceipt(
  db: D1Database,
  opts: {
    topupId: string;
    customerId: number;
    receiptFileId: string;
    receiptKind: 'photo' | 'document';
    paymentReference: string | null;
  },
): Promise<TopupReceiptOutcome> {
  const before = await getTopupById(db, opts.topupId);
  if (!before) return { ok: false, error: 'not_found' };
  if (before.customer_id !== opts.customerId) return { ok: false, error: 'owner_mismatch' };
  if (before.state !== 'await_receipt' && before.state !== 'pending_review') {
    return { ok: false, error: 'invalid_state' };
  }
  const updated = await db
    .prepare(
      `UPDATE wallet_topups
          SET state = 'pending_review',
              receipt_file_id = ?2,
              receipt_kind = ?3,
              payment_reference = COALESCE(?4, payment_reference),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND customer_id = ?5 AND state = ?6`,
    )
    .bind(
      opts.topupId,
      opts.receiptFileId,
      opts.receiptKind,
      opts.paymentReference,
      opts.customerId,
      before.state,
    )
    .run();
  if (changeCount(updated) === 0) return { ok: false, error: 'state_changed' };
  const after = await getTopupById(db, opts.topupId);
  if (!after || after.state !== 'pending_review') return { ok: false, error: 'state_changed' };
  return { ok: true, topup: after, replaced: before.state === 'pending_review' };
}

export type TopupTransitionOutcome =
  | { ok: true; topup: TopupRow }
  | { ok: false; error: 'not_found' | 'already_reviewed' };

/**
 * approve / reject — both ONLY from pending_review. The single guarded UPDATE
 * claims the transition (double taps lose the race); the money movement for
 * approval happens AFTER the claim via creditTopupOnce(), keyed to the
 * top-up id, so a second approval converges on the existing ledger row.
 */
export async function guardedTopupTransition(
  db: D1Database,
  topupId: string,
  toState: 'approved' | 'rejected',
  adminTag: string,
  reason: string | null,
): Promise<TopupTransitionOutcome> {
  const before = await getTopupById(db, topupId);
  if (!before) return { ok: false, error: 'not_found' };
  if (before.state !== 'pending_review') return { ok: false, error: 'already_reviewed' };
  const updated = await db
    .prepare(
      `UPDATE wallet_topups
          SET state = ?2,
              reviewed_by = ?3,
              reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              reject_reason = COALESCE(?4, reject_reason),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND state = 'pending_review'`,
    )
    .bind(topupId, toState, adminTag, reason)
    .run();
  if (changeCount(updated) === 0) return { ok: false, error: 'already_reviewed' };
  const after = await getTopupById(db, topupId);
  return after ? { ok: true, topup: after } : { ok: false, error: 'not_found' };
}

/** Approval is a durable decision, not proof of wallet credit. This atomic
 * batch records ledger, actual credit and credit_status together. Cap rejection
 * leaves no credit ledger; blocked/uncredited approvals are explicitly retryable.
 * Pre-0024 approvals require financial review, never speculative re-crediting. */
export async function creditTopupOnce(db:D1Database,opts:{customerId:number;topupId:string;amountIrt:number;actor:string}):Promise<{ok:true;balance:number}|{ok:false;reason:'cap'|'state'}>{
 if(!Number.isSafeInteger(opts.amountIrt)||opts.amountIrt<=0||opts.amountIrt>MAX_TOPUP_AMOUNT)return {ok:false,reason:'cap'};
 const ledger=newOrderId();let failed=false;
 try{await db.batch([
  db.prepare(`INSERT INTO wallet_entries(id,customer_id,delta_irt,kind,order_id,actor,balance_after)
   SELECT ?1,c.id,?2,'topup_credit',?3,?4,c.balance_irt+?2 FROM customers c JOIN wallet_topups t ON t.customer_id=c.id
   WHERE c.id=?5 AND t.id=?3 AND t.state='approved' AND t.amount_irt=?2 AND t.credit_status IN ('uncredited','blocked')
   AND c.balance_irt+?2 BETWEEN 0 AND ?6 AND NOT EXISTS(SELECT 1 FROM wallet_entries WHERE order_id=?3 AND kind='topup_credit')`)
   .bind(ledger,opts.amountIrt,opts.topupId,opts.actor,opts.customerId,MAX_TOPUP_AMOUNT),
  db.prepare(`UPDATE customers SET balance_irt=balance_irt+?2,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id=?1 AND EXISTS(SELECT 1 FROM wallet_entries WHERE id=?3 AND customer_id=?1)`)
   .bind(opts.customerId,opts.amountIrt,ledger),
  db.prepare(`UPDATE wallet_topups SET credit_status='credited',credit_error=NULL WHERE id=?1
   AND EXISTS(SELECT 1 FROM wallet_entries WHERE id=?2 AND customer_id=?3)`)
   .bind(opts.topupId,ledger,opts.customerId),
  db.prepare(`UPDATE wallet_topups SET credit_status='blocked',credit_error='balance_cap' WHERE id=?1 AND customer_id=?2
   AND state='approved' AND amount_irt=?3 AND credit_status IN ('uncredited','blocked')
   AND NOT EXISTS(SELECT 1 FROM wallet_entries WHERE order_id=?1 AND kind='topup_credit')
   AND EXISTS(SELECT 1 FROM customers WHERE id=?2 AND balance_irt+?3>?4)`)
   .bind(opts.topupId,opts.customerId,opts.amountIrt,MAX_TOPUP_AMOUNT),
 ]);}catch{failed=true;}
 const credited=await db.prepare(`SELECT w.balance_after,w.customer_id,w.delta_irt,t.credit_status FROM wallet_entries w
  JOIN wallet_topups t ON t.id=w.order_id WHERE w.order_id=?1 AND w.kind='topup_credit'`).bind(opts.topupId)
  .first<{balance_after:number;customer_id:number;delta_irt:number;credit_status:string}>();
 if(credited)return credited.customer_id===opts.customerId&&credited.delta_irt===opts.amountIrt&&credited.credit_status==='credited'?{ok:true,balance:credited.balance_after}:{ok:false,reason:'state'};
 if(failed)return {ok:false,reason:'state'};
 const t=await getTopupById(db,opts.topupId);
 return {ok:false,reason:t?.customer_id===opts.customerId&&t.credit_status==='blocked'?'cap':'state'};
}

export interface TopupQueueRow extends TopupRow {
  telegram_user_id: string;
  telegram_username: string | null;
}

/** Oldest-first pending queue for the admin recovery view. */
export async function listPendingTopups(
  db: D1Database,
  limit: number,
): Promise<TopupQueueRow[]> {
  const result = await db
    .prepare(
      `SELECT w.*, c.telegram_user_id, c.telegram_username
         FROM wallet_topups w
         JOIN customers c ON c.id = w.customer_id
        WHERE w.state = 'pending_review' OR (w.state='approved' AND w.credit_status IN ('uncredited','blocked'))
        ORDER BY w.created_at ASC LIMIT ?1`,
    )
    .bind(limit)
    .all<TopupQueueRow>();
  return result.results;
}
