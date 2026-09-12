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
  pasarguard_username: string | null;
  pasarguard_user_id: string | null;
  subscription_url: string | null;
  service_created_at: string | null;
  provision_attempts: number;
  failure_reason: string | null;
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

/* ———— Phase 5: guarded provisioning transitions ————
 * Same discipline as the review transitions: one snapshot read for
 * diagnostics, then a SINGLE conditional UPDATE whose affected-row count
 * decides the winner. Concurrent claims/replays cannot double-run.
 */

export type ProvisionClaimOutcome =
  | { ok: true; order: OrderRow }
  | { ok: false; error: 'not_found' | 'state_changed' | 'attempts_exhausted' };

/** approved → provisioning (claims an attempt); failed → provisioning (admin retry). */
export async function claimOrderForProvisioning(
  db: D1Database,
  opts: { orderId: string; fromState: 'approved' | 'failed'; maxAttempts: number },
): Promise<ProvisionClaimOutcome> {
  const before = await getOrderById(db, opts.orderId);
  if (!before) return { ok: false, error: 'not_found' };
  if (before.state !== opts.fromState) return { ok: false, error: 'state_changed' };
  if (before.provision_attempts >= opts.maxAttempts) {
    return { ok: false, error: 'attempts_exhausted' };
  }

  const updated = await db
    .prepare(
      `UPDATE orders
          SET state = 'provisioning',
              provision_attempts = provision_attempts + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND state = ?2 AND provision_attempts < ?3`,
    )
    .bind(opts.orderId, opts.fromState, opts.maxAttempts)
    .run();
  if (changeCount(updated) === 0) {
    const fresh = await getOrderById(db, opts.orderId);
    if (!fresh) return { ok: false, error: 'not_found' };
    return {
      ok: false,
      error:
        fresh.provision_attempts >= opts.maxAttempts && fresh.state === opts.fromState
          ? 'attempts_exhausted'
          : 'state_changed',
    };
  }

  await db
    .prepare(
      `INSERT INTO order_events (order_id, actor, action, from_state, to_state, data)
       VALUES (?1, 'system', 'provision_started', ?2, 'provisioning', ?3)`,
    )
    .bind(opts.orderId, opts.fromState, JSON.stringify({ attempt: before.provision_attempts + 1 }))
    .run();

  const after = await getOrderById(db, opts.orderId);
  if (!after || after.state !== 'provisioning') return { ok: false, error: 'state_changed' };
  return { ok: true, order: after };
}

export type UsernameClaimOutcome =
  | { ok: true; order: OrderRow; assignedNow: boolean }
  | { ok: false; error: 'not_found' | 'state_changed' | 'username_taken' };

/**
 * Reserve the deterministic panel username on THIS order before any external
 * write. UNIQUE(pasarguard_username) makes the claim atomic across orders:
 * a violation means the name belongs elsewhere and provisioning must stop.
 */
export async function claimOrderUsername(
  db: D1Database,
  opts: { orderId: string; username: string },
): Promise<UsernameClaimOutcome> {
  try {
    const updated = await db
      .prepare(
        `UPDATE orders
            SET pasarguard_username = ?2,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?1 AND pasarguard_username IS NULL AND state = 'provisioning'`,
      )
      .bind(opts.orderId, opts.username)
      .run();
    if (changeCount(updated) > 0) {
      const after = await getOrderById(db, opts.orderId);
      if (!after || after.state !== 'provisioning') return { ok: false, error: 'state_changed' };
      return { ok: true, order: after, assignedNow: true };
    }
  } catch {
    return { ok: false, error: 'username_taken' }; // UNIQUE(id): claimed by another row
  }
  const current = await getOrderById(db, opts.orderId);
  if (!current) return { ok: false, error: 'not_found' };
  if (current.pasarguard_username !== null && current.state === 'provisioning') {
    return { ok: true, order: current, assignedNow: false }; // our earlier attempt already claimed it
  }
  return { ok: false, error: 'state_changed' };
}

export type ProvisionFinalizeOutcome =
  | { ok: true; order: OrderRow }
  | { ok: false; error: 'not_found' | 'state_changed' | 'identity_conflict' };

/** provisioning → completed. A UNIQUE clash on pasarguard_user_id is a hard stop. */
export async function completeProvisionedOrder(
  db: D1Database,
  opts: { orderId: string; pasarguardUserId: string | null; subscriptionUrl: string | null },
): Promise<ProvisionFinalizeOutcome> {
  try {
    const updated = await db
      .prepare(
        `UPDATE orders
            SET state = 'completed',
                pasarguard_user_id = COALESCE(?2, pasarguard_user_id),
                subscription_url = COALESCE(?3, subscription_url),
                service_created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                failure_reason = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?1 AND state = 'provisioning'`,
      )
      .bind(opts.orderId, opts.pasarguardUserId, opts.subscriptionUrl)
      .run();
    if (changeCount(updated) === 0) {
      const fresh = await getOrderById(db, opts.orderId);
      return fresh ? { ok: false, error: 'state_changed' } : { ok: false, error: 'not_found' };
    }
  } catch {
    return { ok: false, error: 'identity_conflict' }; // user id already linked to another order
  }

  await db
    .prepare(
      `INSERT INTO order_events (order_id, actor, action, from_state, to_state, data)
       VALUES (?1, 'system', 'provision_succeeded', 'provisioning', 'completed', ?2)`,
    )
    .bind(
      opts.orderId,
      JSON.stringify({
        pasarguard_user_id: opts.pasarguardUserId,
        subscription_url: opts.subscriptionUrl,
      }),
    )
    .run();

  const after = await getOrderById(db, opts.orderId);
  if (!after) return { ok: false, error: 'not_found' };
  return { ok: true, order: after };
}

export type ProvisionFailOutcome =
  | { ok: true; order: OrderRow }
  | { ok: false; error: 'not_found' | 'state_changed' };

/** provisioning → failed; the reason is sanitized upstream, capped here. */
export async function failProvisionedOrder(
  db: D1Database,
  opts: { orderId: string; reason: string },
): Promise<ProvisionFailOutcome> {
  const updated = await db
    .prepare(
      `UPDATE orders
          SET state = 'failed',
              failure_reason = ?2,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND state = 'provisioning'`,
    )
    .bind(opts.orderId, opts.reason.slice(0, 300))
    .run();
  if (changeCount(updated) === 0) {
    const fresh = await getOrderById(db, opts.orderId);
    return fresh ? { ok: false, error: 'state_changed' } : { ok: false, error: 'not_found' };
  }

  await db
    .prepare(
      `INSERT INTO order_events (order_id, actor, action, from_state, to_state, data)
       VALUES (?1, 'system', 'provision_failed', 'provisioning', 'failed', ?2)`,
    )
    .bind(opts.orderId, JSON.stringify({ reason: opts.reason.slice(0, 300) }))
    .run();

  const after = await getOrderById(db, opts.orderId);
  if (!after) return { ok: false, error: 'not_found' };
  return { ok: true, order: after };
}

/** failed orders, newest failures first — the admin retry queue. */
export async function listOrdersFailed(
  db: D1Database,
  limit: number,
): Promise<OrderRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM orders WHERE state = 'failed' ORDER BY updated_at DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<OrderRow>();
  return result.results;
}
