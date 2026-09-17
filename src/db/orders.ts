/**
 * Order repository. Creation happens through `db.batch()` — one atomic D1
 * transaction for (order row + audit event), so orders and their audit trail
 * can never diverge.
 */
import { newOrderId } from '../lib/security.ts';
import { ensureSchedule } from './paymentReminders.ts';
export interface OrderRow {
  id: string;
  customer_id: number;
  state: string;
  kind: string;
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
  service_expires_at: string | null;
  renews_order_id: string | null;
  renew_target_unix: number | null;
  /** Claimed absolute panel quota target (bytes) for volume add-ons; null = none. */
  renew_target_data_limit_bytes: number | null;
  provision_attempts: number;
  failure_reason: string | null;
  created_at: string;
  /**
   * Panel-service terminal state (Phase 16 admin delete + reconciliation):
   * non-null `panel_deleted_at` IS the `panel_deleted` disposition — the
   * panel service is gone, the order/payment history stays untouched, and no
   * active-service surface may ever claim this row again.
   */
  panel_deleted_at: string | null;
  /** 'admin:<telegram_id>' when an admin deleted it, 'system' on reconcile. */
  panel_deleted_by: string | null;
}

export interface NewOrderFields {
  id: string;
  customerId: number;
  selections: string; // JSON snapshot, built by checkout
  amount: number;
  currency: string;
  idempotencyKey: string;
  /** Phase 6: 'purchase' (default) or 'renewal'. */
  kind?: 'purchase' | 'renewal';
  /** Phase 6: service (purchase order) a renewal extends. */
  renewsOrderId?: string | null;
  /** Phase 7: wallet-funded orders are born 'approved' (no receipt, no queue). */
  initialState?: 'pending_payment' | 'approved';
  /** Phase 7: 'wallet' when the order was paid from the balance. */
  verifiedBy?: string | null;
  /** Phase 15: audit-event override for born-approved non-wallet orders. */
  initialEvent?: string;
}

export async function insertOrderWithEvent(
  db: D1Database,
  order: NewOrderFields,
): Promise<void> {
  const initial = order.initialState ?? 'pending_payment';
  const createdEvent =
    order.initialEvent ?? (initial === 'approved' ? 'order_created_wallet_paid' : 'order_created');
  await db.batch([
    db
      .prepare(
        `INSERT INTO orders (id, customer_id, state, kind, selections, amount, currency, idempotency_key, renews_order_id, verified_by, verified_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CASE WHEN ?3 = 'approved' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END)`,
      )
      .bind(
        order.id,
        order.customerId,
        initial,
        order.kind ?? 'purchase',
        order.selections,
        order.amount,
        order.currency,
        order.idempotencyKey,
        order.renewsOrderId ?? null,
        order.verifiedBy ?? null,
      ),
    db
      .prepare(
        `INSERT INTO order_events (order_id, actor, action, to_state, data)
         VALUES (?1, 'customer', ?2, ?3, ?4)`,
      )
      .bind(order.id, createdEvent, initial, JSON.stringify({ idempotency_key: order.idempotencyKey })),
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

  // Phase 8C: exactly one reminder schedule per order. The first winning
  // submission anchors t0 at row creation; a replacement loses this insert
  // to the PK and provably keeps the ORIGINAL schedule (stage never resets).
  await ensureSchedule(db, opts.orderId);

  const after = await getOrderById(db, opts.orderId);
  if (!after || after.state !== 'awaiting_review') return { ok: false, error: 'state_changed' };
  return { ok: true, order: after, replaced: before.state === 'awaiting_review' };
}

export type AdminTransitionOutcome =
  | { ok: true; order: OrderRow }
  | { ok: false; error: 'not_found' | 'already_reviewed' };

/**
 * approve / reject — both ONLY from awaiting_review; the single guarded
 * UPDATE claims the transition (double taps lose the race), then the audit
 * trail and — on a winning reject WITH wallet credit — the refund statements
 * (customer balance + ledger row) run in one atomic batch. Refund is bound
 * to the winning claim, so exactly-once holds.
 */
async function guardedAdminTransition(
  db: D1Database,
  orderId: string,
  toState: 'approved' | 'rejected',
  action: 'payment_approved' | 'payment_rejected',
  adminTag: string,
  reason: string | null,
  refund?: { customerId: number; amountIrt: number },
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

  const statements: Parameters<D1Database['batch']>[0] = [
    db
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
      ),
  ];
  if (refund && toState === 'rejected' && refund.amountIrt > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE customers
              SET balance_irt = balance_irt + ?2,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?1 AND balance_irt + ?2 >= 0`,
        )
        .bind(refund.customerId, refund.amountIrt),
      db
        .prepare(
          `INSERT INTO wallet_entries (id, customer_id, delta_irt, kind, order_id, actor, balance_after)
           SELECT ?1, ?2, ?3, 'order_refund', ?4, ?5, c.balance_irt
             FROM customers c WHERE c.id = ?2`,
        )
        .bind(
          newOrderId(),
          refund.customerId,
          refund.amountIrt,
          orderId,
          `admin:${adminTag}`,
        ),
    );
  }
  await db.batch(statements);

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
  refund?: { customerId: number; amountIrt: number },
): Promise<AdminTransitionOutcome> {
  return guardedAdminTransition(db, orderId, 'rejected', 'payment_rejected', adminTag, reason, refund);
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
        WHERE id = ?1 AND state = ?2 AND provision_attempts < ?3
          AND panel_deleted_at IS NULL`,
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
  if (!after) return { ok: false, error: 'not_found' };
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
  opts: {
    orderId: string;
    pasarguardUserId: string | null;
    subscriptionUrl: string | null;
    /** Phase 6: local expiry stamp for freshly provisioned purchases. */
    serviceExpiresAt?: string | null;
  },
): Promise<ProvisionFinalizeOutcome> {
  try {
    const updated = await db
      .prepare(
        `UPDATE orders
            SET state = 'completed',
                pasarguard_user_id = COALESCE(?2, pasarguard_user_id),
                subscription_url = COALESCE(?3, subscription_url),
                service_created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                service_expires_at = COALESCE(?4, service_expires_at),
                failure_reason = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?1 AND state = 'provisioning'`,
      )
      .bind(opts.orderId, opts.pasarguardUserId, opts.subscriptionUrl, opts.serviceExpiresAt ?? null)
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

/**
 * provisioning → completed for a RENEWAL order. Deliberately does NOT touch
 * pasarguard_user_id / subscription_url / service_created_at: those belong to
 * the service (purchase) order and one service links exactly one owner row
 * (UNIQUE guard from 0001). The extension effect is booked onto the SERVICE
 * row via bookRenewalOnService.
 */
export async function completeRenewedOrder(
  db: D1Database,
  opts: { orderId: string; targetUnix: number | null; quotaBytes?: number | null },
): Promise<ProvisionFinalizeOutcome> {
  const updated = await db
    .prepare(
      `UPDATE orders
          SET state = 'completed',
              failure_reason = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND state = 'provisioning' AND kind = 'renewal'`,
    )
    .bind(opts.orderId)
    .run();
  if (changeCount(updated) === 0) {
    const fresh = await getOrderById(db, opts.orderId);
    return fresh ? { ok: false, error: 'state_changed' } : { ok: false, error: 'not_found' };
  }
  await db
    .prepare(
      `INSERT INTO order_events (order_id, actor, action, from_state, to_state, data)
       VALUES (?1, 'system', 'renewal_succeeded', 'provisioning', 'completed', ?2)`,
    )
    .bind(opts.orderId, JSON.stringify({ new_target_unix: opts.targetUnix, new_quota_bytes: opts.quotaBytes ?? null }))
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

/** failed orders, newest failures first — the admin retry queue.
 *  Panel-deleted failures are terminal dispositions, never retryable. */
export async function listOrdersFailed(
  db: D1Database,
  limit: number,
): Promise<OrderRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM orders WHERE state = 'failed' AND panel_deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<OrderRow>();
  return result.results;
}

/* —— Phase 6: services + renewals ————————————————————————————————
 * A "service" IS a completed purchase order (no separate table): renewal
 * orders link back via renews_order_id. All reads here are strictly scoped
 * by customer_id; handlers must never render a row fetched without it.
 */

/** States of a renewal order that still "occupy" the service (one at a time). */
export const ACTIVE_RENEWAL_STATES =
  "('pending_payment','awaiting_review','approved','provisioning')";

export interface ServiceRow extends OrderRow {
  applied_renewals: number;
  active_renewals: number;
}

const SERVICE_AGGREGATES = `(
   SELECT COUNT(*) FROM orders r
    WHERE r.renews_order_id = o.id AND r.kind = 'renewal' AND r.state = 'completed'
  ) AS applied_renewals,
  (
   SELECT COUNT(*) FROM orders r
    WHERE r.renews_order_id = o.id AND r.kind = 'renewal'
      AND r.state IN ${ACTIVE_RENEWAL_STATES}
  ) AS active_renewals`;

/** The customer's services: every completed purchase order. A
 *  panel-deleted row is terminal — listed nowhere, renewable via no path,
 *  but its order/payment/audit history stays fully intact. */
export async function listServicesForCustomer(
  db: D1Database,
  customerId: number,
  limit: number,
): Promise<ServiceRow[]> {
  const result = await db
    .prepare(
      `SELECT o.*, ${SERVICE_AGGREGATES}
         FROM orders o
        WHERE o.customer_id = ?1 AND o.kind = 'purchase' AND o.state = 'completed'
          AND o.panel_deleted_at IS NULL
        ORDER BY o.service_created_at DESC, o.created_at DESC
        LIMIT ?2`,
    )
    .bind(customerId, limit)
    .all<ServiceRow>();
  return result.results;
}

/** One owned completed-purchase service row, aggregates included.
 *  `panel_deleted_at IS NULL` makes every service-facing surface (detail,
 *  refresh, renewal entry) refuse a deleted service with one choke point. */
export async function getOwnedService(
  db: D1Database,
  customerId: number,
  orderId: string,
): Promise<ServiceRow | null> {
  return db
    .prepare(
      `SELECT o.*, ${SERVICE_AGGREGATES}
         FROM orders o
        WHERE o.id = ?1 AND o.customer_id = ?2 AND o.kind = 'purchase' AND o.state = 'completed'
          AND o.panel_deleted_at IS NULL`,
    )
    .bind(orderId, customerId)
    .first<ServiceRow>();
}

/** In-flight renewal for a service (blocks starting a second one). */
export async function findActiveRenewalForService(
  db: D1Database,
  serviceOrderId: string,
): Promise<OrderRow | null> {
  return db
    .prepare(
      `SELECT * FROM orders
        WHERE renews_order_id = ?1 AND kind = 'renewal' AND state IN ${ACTIVE_RENEWAL_STATES}
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(serviceOrderId)
    .first<OrderRow>();
}

export type RenewalTargetClaimOutcome =
  | { ok: true; targetUnix: number | null }
  | { ok: false; error: 'not_found' | 'state_changed' };

/**
 * Claim the ABSOLUTE renewal target on the order BEFORE the panel PUT, the
 * same "claim then act" discipline as the username in Phase 5: replays and
 * parallel claims converge on one stored target, so a retry can extend at
 * most once. Returns the stored target (null only when the row vanished).
 */
export async function claimRenewalTarget(
  db: D1Database,
  opts: { orderId: string; targetUnix: number },
): Promise<RenewalTargetClaimOutcome> {
  const updated = await db
    .prepare(
      `UPDATE orders
          SET renew_target_unix = ?2,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND kind = 'renewal' AND state = 'provisioning' AND renew_target_unix IS NULL`,
    )
    .bind(opts.orderId, opts.targetUnix)
    .run();
  if (changeCount(updated) > 0) return { ok: true, targetUnix: opts.targetUnix };
  const fresh = await getOrderById(db, opts.orderId);
  if (!fresh) return { ok: false, error: 'not_found' };
  if (fresh.state !== 'provisioning') return { ok: false, error: 'state_changed' };
  return { ok: true, targetUnix: fresh.renew_target_unix }; // someone (an earlier attempt) won — adopt
}

export type RenewalQuotaClaimOutcome =
  | { ok: true; quotaBytes: number | null }
  | { ok: false; error: 'not_found' | 'state_changed' };

/**
 * Claim the ABSOLUTE panel quota target (bytes) BEFORE the panel PUT — the
 * quota twin of `claimRenewalTarget`. Retries adopt the stored target instead
 * of adding the delta again, so a volume increase applies at most once.
 */
export async function claimRenewalQuotaTarget(
  db: D1Database,
  opts: { orderId: string; quotaBytes: number },
): Promise<RenewalQuotaClaimOutcome> {
  let updated: unknown;
  try {
    updated = await db
      .prepare(
        `UPDATE orders
            SET renew_target_data_limit_bytes = ?2,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?1 AND kind = 'renewal' AND state = 'provisioning' AND renew_target_data_limit_bytes IS NULL`,
      )
      .bind(opts.orderId, opts.quotaBytes)
      .run();
  } catch {
    // Column missing on databases predating the 0018 migration: surface as a
    // state error so provisioning fails closed instead of double-adding.
    return { ok: false, error: 'state_changed' };
  }
  if (changeCount(updated) > 0) return { ok: true, quotaBytes: opts.quotaBytes };
  let fresh: OrderRow | null = null;
  try {
    fresh = await getOrderById(db, opts.orderId);
  } catch {
    return { ok: false, error: 'not_found' };
  }
  if (!fresh) return { ok: false, error: 'not_found' };
  if (fresh.state !== 'provisioning') return { ok: false, error: 'state_changed' };
  return { ok: true, quotaBytes: fresh.renew_target_data_limit_bytes ?? null };
}

/**
 * Book a completed renewal on its service row: extend the local expiry
 * FORWARD only (a late/parallel bookkeeping write can never shorten it) and
 * attach a `service_extended` audit event pointing at the renewal order.
 */
export async function bookRenewalOnService(
  db: D1Database,
  opts: { serviceOrderId: string; renewalOrderId: string; expiresIso: string },
): Promise<boolean> {
  const updated = await db
    .prepare(
      `UPDATE orders
          SET service_expires_at = ?2,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND kind = 'purchase' AND state = 'completed'
          AND (service_expires_at IS NULL OR service_expires_at < ?2)`,
    )
    .bind(opts.serviceOrderId, opts.expiresIso)
    .run();
  if (changeCount(updated) === 0) {
    const current = await getOrderById(db, opts.serviceOrderId);
    if (!current) return false;
    if (current.service_expires_at !== null && current.service_expires_at >= opts.expiresIso) {
      return true; // already extended to at least this point — converge
    }
    return false;
  }
  await db
    .prepare(
      `INSERT INTO order_events (order_id, actor, action, data)
       VALUES (?1, 'system', 'service_extended', ?2)`,
    )
    .bind(
      opts.serviceOrderId,
      JSON.stringify({ renewal_order_id: opts.renewalOrderId, expires_at: opts.expiresIso }),
    )
    .run();
  return true;
}

/* —— Phase 16: panel-service deletion (admin command + reconciliation) ———
 * The panel is the service's real home; D1 keeps history forever. A deletion
 * is therefore NEVER destructive to orders: it stamps the terminal
 * `panel_deleted` disposition (panel_deleted_at/by + one audit event) on the
 * completed purchase row after the panel reported the user gone. Every
 * service-facing query (list/own/sweep/failed/claim) excludes stamped rows,
 * so a deleted service can never be treated active, renewed, retried or
 * re-provisioned again. Panel-deleted services whose D1 row is NOT yet
 * stamped get reconciled by whoever observes the not-found state.
 */

/** The purchase order a panel username belongs to (admin tooling lookup). */
export async function getOrderByPanelUsername(
  db: D1Database,
  username: string,
): Promise<OrderRow | null> {
  return db
    .prepare('SELECT * FROM orders WHERE pasarguard_username = ?1')
    .bind(username)
    .first<OrderRow>();
}

export type PanelMarkOutcome =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'already_deleted' };

/**
 * Claim the local `panel_deleted` bookkeeping for a provisioned purchase
 * (completed service, or a FAILED row that still holds a claimed panel
 * username) whose panel user is confirmed gone-or-absent. Exactly-once by the
 * guarded UPDATE: concurrent reconciles (admin tap + refresh tap + sweep)
 * collapse into one stamp + one audit event; a replay returns already_deleted
 * so callers stay idempotent. Anything else is refused — pending/awaiting/
 * rejected/cancelled rows have no live service to delete.
 */
export async function markPanelDeleted(
  db: D1Database,
  opts: { orderId: string; panelUsername: string; via: string },
): Promise<PanelMarkOutcome> {
  const updated = await db
    .prepare(
      `UPDATE orders
          SET panel_deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              panel_deleted_by = ?3,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND kind = 'purchase' AND pasarguard_username IS NOT NULL
          AND state IN ('completed', 'failed')
          AND panel_deleted_at IS NULL`,
    )
    .bind(opts.orderId, opts.panelUsername, opts.via.slice(0, 64))
    .run();
  if (changeCount(updated) > 0) {
    await db
      .prepare(
        `INSERT INTO order_events (order_id, actor, action, data)
         VALUES (?1, ?2, 'service_panel_deleted', ?3)`,
      )
      .bind(opts.orderId, opts.via.slice(0, 64), JSON.stringify({ username: opts.panelUsername }))
      .run();
    return { ok: true };
  }
  const current = await getOrderById(db, opts.orderId);
  if (current === null) return { ok: false, error: 'not_found' };
  return { ok: false, error: 'already_deleted' };
}

/**
 * Reconciliation primitive (Phase 16): every PASSIVE observer that witnessed a
 * confirmed panel 404 for a linked completed service (customer live refresh,
 * usage notification sweep) books the same terminal disposition with a
 * 'system:<observer>' actor. It never calls the panel — proving the deletion
 * is the caller's job; idempotent through markPanelDeleted's guarded UPDATE.
 */
export async function reconcilePanelGone(
  db: D1Database,
  order: OrderRow,
  observer: 'svc-refresh' | 'notice-sweep',
): Promise<boolean> {
  const username = order.pasarguard_username;
  if (username === null || order.panel_deleted_at !== null || order.kind !== 'purchase') {
    return false;
  }
  const marked = await markPanelDeleted(db, {
    orderId: order.id,
    panelUsername: username,
    via: `system:${observer}`,
  });
  return marked.ok;
}
