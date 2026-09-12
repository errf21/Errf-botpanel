/**
 * Order repository. Creation happens through `db.batch()` — one atomic D1
 * transaction for (order row + audit event), so orders and their audit trail
 * can never diverge.
 */
export interface OrderRow {
  id: string;
  customer_id: number;
  state: string;
  selections: string;
  amount: number;
  currency: string;
  idempotency_key: string | null;
  receipt_file_id: string | null;
  payment_reference: string | null;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface NewOrderFields {
  id: string;
  customerId: number;
  selections: string; // JSON snapshot, built by checkout
  amount: number;
  currency: string;
  idempotencyKey: string;
}

export async function insertOrderWithEvent(
  db: D1Database,
  order: NewOrderFields,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO orders (id, customer_id, state, selections, amount, currency, idempotency_key)
         VALUES (?1, ?2, 'pending_payment', ?3, ?4, ?5, ?6)`,
      )
      .bind(
        order.id,
        order.customerId,
        order.selections,
        order.amount,
        order.currency,
        order.idempotencyKey,
      ),
    db
      .prepare(
        `INSERT INTO order_events (order_id, actor, action, to_state, data)
         VALUES (?1, 'customer', 'order_created', 'pending_payment', ?2)`,
      )
      .bind(order.id, JSON.stringify({ idempotency_key: order.idempotencyKey })),
  ]);
}

export async function findOrderByIdempotencyKey(
  db: D1Database,
  key: string,
): Promise<OrderRow | null> {
  return db
    .prepare('SELECT * FROM orders WHERE idempotency_key = ?1')
    .bind(key)
    .first<OrderRow>();
}

export async function getOrderById(
  db: D1Database,
  orderId: string,
): Promise<OrderRow | null> {
  return db.prepare('SELECT * FROM orders WHERE id = ?1').bind(orderId).first<OrderRow>();
}

/** D1 and the test shim both report affected rows through `meta.changes`. */
function changeCount(result: unknown): number {
  const meta = (result as { meta?: { changes?: number } } | null)?.meta;
  return typeof meta?.changes === 'number' ? meta.changes : 0;
}

export type ReceiptOutcome =
  | { ok: true; order: OrderRow; replaced: boolean }
  | { ok: false; error: 'not_found' | 'owner_mismatch' | 'state_changed' | 'invalid_state' };

/**
 * First receipt OR a replacement (self-loop while awaiting_review):
 * stores file id + optional reference and (re-)enters awaiting_review.
 * The guarded UPDATE on the snapshot-read `fromState` makes concurrent
 * edits converge instead of clobbering.
 */
export async function submitOrderReceipt(
  db: D1Database,
  opts: {
    orderId: string;
    customerId: number;
    receiptFileId: string;
    paymentReference: string | null;
  },
): Promise<ReceiptOutcome> {
  const before = await getOrderById(db, opts.orderId);
  if (!before) return { ok: false, error: 'not_found' };
  if (before.customer_id !== opts.customerId) return { ok: false, error: 'owner_mismatch' };
  if (before.state !== 'pending_payment' && before.state !== 'awaiting_review') {
    return { ok: false, error: 'invalid_state' };
  }

  const updated = await db
    .prepare(
      `UPDATE orders
          SET state = 'awaiting_review',
              receipt_file_id = ?2,
              payment_reference = COALESCE(?3, payment_reference),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND customer_id = ?4 AND state = ?5`,
    )
    .bind(opts.orderId, opts.receiptFileId, opts.paymentReference, opts.customerId, before.state)
    .run();
  if (changeCount(updated) === 0) return { ok: false, error: 'state_changed' };

  await db
    .prepare(
      `INSERT INTO order_events (order_id, actor, action, from_state, to_state, data)
       VALUES (?1, 'customer', ?2, ?3, 'awaiting_review', ?4)`,
    )
    .bind(
      opts.orderId,
      before.state === 'awaiting_review' ? 'receipt_replaced' : 'receipt_uploaded',
      before.state,
      JSON.stringify({
        receipt_file_id: opts.receiptFileId,
        payment_reference: opts.paymentReference ?? null,
      }),
    )
    .run();

  const after = await getOrderById(db, opts.orderId);
  if (!after || after.state !== 'awaiting_review') return { ok: false, error: 'state_changed' };
  return { ok: true, order: after, replaced: before.state === 'awaiting_review' };
}

export type AdminTransitionOutcome =
  | { ok: true; order: OrderRow }
  | { ok: false; error: 'not_found' | 'already_reviewed' };

/** approve / reject — both ONLY from awaiting_review; double-taps lose the guard. */
async function guardedAdminTransition(
  db: D1Database,
  orderId: string,
  toState: 'approved' | 'rejected',
  action: 'payment_approved' | 'payment_rejected',
  adminTag: string,
  reason: string | null,
): Promise<AdminTransitionOutcome> {
  const before = await getOrderById(db, orderId);
  if (!before) return { ok: false, error: 'not_found' };
  if (before.state !== 'awaiting_review') return { ok: false, error: 'already_reviewed' };

  const updated = await db
    .prepare(
      `UPDATE orders
          SET state = ?2,
              verified_by = ?3,
              verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              failure_reason = COALESCE(?4, failure_reason),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND state = 'awaiting_review'`,
    )
    .bind(orderId, toState, adminTag, reason)
    .run();
  if (changeCount(updated) === 0) return { ok: false, error: 'already_reviewed' };

  await db
    .prepare(
      `INSERT INTO order_events (order_id, actor, action, from_state, to_state, data)
       VALUES (?1, ?2, ?3, 'awaiting_review', ?4, ?5)`,
    )
    .bind(
      orderId,
      `admin:${adminTag}`,
      action,
      toState,
      reason === null ? JSON.stringify({ via: 'admin' }) : JSON.stringify({ reason }),
    )
    .run();

  const after = await getOrderById(db, orderId);
  return after ? { ok: true, order: after } : { ok: false, error: 'not_found' };
}

export function approveOrderByAdmin(
  db: D1Database,
  orderId: string,
  adminTag: string,
): Promise<AdminTransitionOutcome> {
  return guardedAdminTransition(db, orderId, 'approved', 'payment_approved', adminTag, null);
}

export function rejectOrderByAdmin(
  db: D1Database,
  orderId: string,
  adminTag: string,
  reason: string | null,
): Promise<AdminTransitionOutcome> {
  return guardedAdminTransition(db, orderId, 'rejected', 'payment_rejected', adminTag, reason);
}

export interface QueueRow extends OrderRow {
  telegram_user_id: string;
  telegram_username: string | null;
  receipt_uploaded_at: string | null;
}

/** awaiting_review orders, oldest receipts first (FIFO), bounded. */
export async function listOrdersAwaitingReview(
  db: D1Database,
  limit: number,
): Promise<QueueRow[]> {
  const result = await db
    .prepare(
      `SELECT o.*, c.telegram_user_id, c.telegram_username,
              (SELECT MAX(e.created_at) FROM order_events e
                WHERE e.order_id = o.id AND e.action IN ('receipt_uploaded','receipt_replaced')
              ) AS receipt_uploaded_at
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
        WHERE o.state = 'awaiting_review'
        ORDER BY o.updated_at ASC
        LIMIT ?1`,
    )
    .bind(limit)
    .all<QueueRow>();
  return result.results;
}

export async function listRecentOrdersForCustomer(
  db: D1Database,
  customerId: number,
  limit: number,
): Promise<OrderRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM orders WHERE customer_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
    )
    .bind(customerId, limit)
    .all<OrderRow>();
  return result.results;
}
