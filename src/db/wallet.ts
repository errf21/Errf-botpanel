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
  /** Stable intent key: required for retries of the same administrative action. */
  operationKey?: string;
}

/** Ledger claim and balance effect share a single D1 transaction. A supplied
 * stable intent key makes retries converge; identity/amount substitution fails
 * closed. Callers without a key explicitly create a new distinct intent. */
export async function applyWalletMutation(
  db:D1Database, mutation:WalletMutation,
):Promise<{ok:true;balance:number;entryId:string}|{ok:false;reason:'insufficient'|'cap'|'state'}>{
 const {amountIrt}=mutation;
 if(!Number.isSafeInteger(amountIrt)||amountIrt===0||Math.abs(amountIrt)>MAX_WALLET_AMOUNT)return {ok:false,reason:'cap'};
 const entryId=newOrderId(),key=mutation.operationKey??`intent:${entryId}`;
 if(!key||key.length>200)return {ok:false,reason:'state'};
 let failed=false;
 try{await db.batch([
  db.prepare(`INSERT INTO wallet_entries(id,customer_id,delta_irt,kind,order_id,actor,balance_after,operation_key)
   SELECT ?1,id,?2,?3,?4,?5,balance_irt+?2,?6 FROM customers WHERE id=?7
   AND balance_irt>=CASE WHEN ?2<0 THEN -?2 ELSE 0 END AND balance_irt+?2 BETWEEN 0 AND ?8
   AND NOT EXISTS(SELECT 1 FROM wallet_entries WHERE operation_key=?6)`)
   .bind(entryId,amountIrt,mutation.kind,mutation.orderId??null,mutation.actor,key,mutation.customerId,MAX_WALLET_AMOUNT),
  db.prepare(`UPDATE customers SET balance_irt=balance_irt+?2,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id=?1 AND EXISTS(SELECT 1 FROM wallet_entries WHERE id=?3 AND customer_id=?1)`)
   .bind(mutation.customerId,amountIrt,entryId),
 ]);}catch{failed=true;}
 const paid=await db.prepare('SELECT id,customer_id,delta_irt,kind,actor,order_id,balance_after FROM wallet_entries WHERE operation_key=?1')
  .bind(key).first<{id:string;customer_id:number;delta_irt:number;kind:string;actor:string;order_id:string|null;balance_after:number}>();
 if(paid){if(paid.customer_id!==mutation.customerId||paid.delta_irt!==amountIrt||paid.kind!==mutation.kind||paid.actor!==mutation.actor||paid.order_id!==(mutation.orderId??null))return {ok:false,reason:'state'};
  return {ok:true,balance:paid.balance_after,entryId:paid.id};}
 if(failed)return {ok:false,reason:'state'};
 const balance=await getBalance(db,mutation.customerId);
 return {ok:false,reason:balance===null?'state':amountIrt<0?'insufficient':'cap'};
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
 * Ledger claim and balance effect are one D1 transaction; a stable payment
 * token survives the order-link handoff. Different orders never rely on a
 * balance read performed outside that transaction. Retries converge on the
 * same owner/amount claim; refunded or substituted claims fail closed.
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
  const ledgerId = newOrderId();let writeFailed=false;
  try {
    // The ledger INSERT is the claim. Both its balance snapshot and the debit
    // execute in the same transaction, not against a pre-transaction balance.
    await db.batch([
      db.prepare(`INSERT INTO wallet_entries(id,customer_id,delta_irt,kind,order_id,actor,balance_after,payment_token)
        SELECT ?1,c.id,-?2,'order_payment',?3,?4,c.balance_irt-?2,?3 FROM customers c
        WHERE c.id=?5 AND c.balance_irt>=?2
          AND NOT EXISTS(SELECT 1 FROM wallet_entries WHERE kind='order_payment' AND (payment_token=?3 OR order_id=?3))`)
        .bind(ledgerId,opts.amountIrt,opts.orderId,opts.actor,opts.customerId),
      db.prepare(`UPDATE customers SET balance_irt=balance_irt-?2,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=?1 AND EXISTS(SELECT 1 FROM wallet_entries WHERE id=?3 AND customer_id=?1 AND kind='order_payment')`)
        .bind(opts.customerId,opts.amountIrt,ledgerId),
    ]);
  } catch { writeFailed=true;console.error(`wallet_ledger_insert_failed orderId=${opts.orderId.slice(0,32)}`); }
  const paid=await db.prepare(`SELECT customer_id,delta_irt,balance_after,order_id FROM wallet_entries
    WHERE kind='order_payment' AND (payment_token=?1 OR order_id=?1) LIMIT 1`).bind(opts.orderId)
    .first<{customer_id:number;delta_irt:number;balance_after:number;order_id:string}>();
  if(paid){
    if(paid.customer_id!==opts.customerId||paid.delta_irt!==-opts.amountIrt)return {ok:false,reason:'state'};
    if(await db.prepare("SELECT 1 FROM wallet_entries WHERE kind='order_refund' AND order_id=?1").bind(paid.order_id).first())return {ok:false,reason:'state'};
    return {ok:true,balance:paid.balance_after};
  }
  if(writeFailed)return {ok:false,reason:'state'};
  const balance = await getBalance(db, opts.customerId);
  if (balance === null) return { ok: false, reason: 'state' };
  return { ok: false, reason: 'insufficient' };
}

/** Refund claim and balance effect are atomic. Repeated refunds cannot infer
 * missing effects from a lower balance caused by an unrelated later payment.
 * Optional orphan guard is checked INSIDE the refund transaction. */
export async function refundOrderWalletPayment(
  db: D1Database,
  opts: { customerId: number; orderId: string; actor: string; onlyIfUnlinkedBefore?: string },
): Promise<boolean> {
  const payment=await db.prepare("SELECT customer_id,delta_irt FROM wallet_entries WHERE order_id=?1 AND kind='order_payment' LIMIT 1")
    .bind(opts.orderId).first<{customer_id:number;delta_irt:number}>();
  if(!payment||payment.customer_id!==opts.customerId||payment.delta_irt>=0)return false;
  const amount=-payment.delta_irt,claim=newOrderId();
  await db.batch([
    db.prepare(`INSERT INTO wallet_entries(id,customer_id,delta_irt,kind,order_id,actor,balance_after)
      SELECT ?1,c.id,?2,'order_refund',?3,?4,c.balance_irt+?2 FROM customers c WHERE c.id=?5
      AND c.balance_irt+?2 BETWEEN 0 AND ?6
      AND NOT EXISTS(SELECT 1 FROM wallet_entries WHERE order_id=?3 AND kind='order_refund')
      AND (?7 IS NULL OR (NOT EXISTS(SELECT 1 FROM orders WHERE id=?3 OR idempotency_key=?3)
        AND EXISTS(SELECT 1 FROM wallet_entries WHERE kind='order_payment' AND order_id=?3 AND payment_token=?3 AND created_at<?7)))`)
      .bind(claim,amount,opts.orderId,opts.actor,opts.customerId,MAX_WALLET_AMOUNT,opts.onlyIfUnlinkedBefore??null),
    db.prepare(`UPDATE customers SET balance_irt=balance_irt+?2,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?1 AND EXISTS(SELECT 1 FROM wallet_entries WHERE id=?3 AND kind='order_refund' AND customer_id=?1)`)
      .bind(opts.customerId,amount,claim),
  ]);
  return !!await db.prepare("SELECT 1 FROM wallet_entries WHERE order_id=?1 AND kind='order_refund' AND customer_id=?2")
    .bind(opts.orderId,opts.customerId).first();

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

/** Interrupted pre-order checkout is a durable payment reservation, not a lost
 * debit. Refund only a confirmed missing order after 15 minutes; late funded
 * insertion fails the SQL refund guard. Never infer absence on a DB error. */
export async function recoverUnlinkedWalletPayments(db:D1Database,now=Date.now()):Promise<void>{
 const cutoff=new Date(now-900000).toISOString();
 const rows=await db.prepare(`SELECT customer_id,order_id FROM wallet_entries w WHERE kind='order_payment'
  AND payment_token=order_id AND created_at<?1 AND NOT EXISTS(SELECT 1 FROM orders WHERE id=w.order_id OR idempotency_key=w.payment_token)
  AND NOT EXISTS(SELECT 1 FROM wallet_entries r WHERE r.order_id=w.order_id AND r.kind='order_refund') ORDER BY created_at,id LIMIT 2`)
  .bind(cutoff).all<{customer_id:number;order_id:string}>();
 for(const row of rows.results)await refundOrderWalletPayment(db,{customerId:row.customer_id,orderId:row.order_id,actor:'system:wallet-checkout-recovery',onlyIfUnlinkedBefore:cutoff});
}
