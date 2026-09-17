/**
 * Order repository. Creation happens through `db.batch()` — one atomic D1
 * transaction for (order row + audit event), so orders and their audit trail
 * can never diverge.
 */
import { newOrderId } from '../lib/security.ts';
import { ensureSchedule } from './paymentReminders.ts';
import type { CustomerRecord } from './customers.ts';
import { countCustomers, listCustomersPage } from './customers.ts';
import type { UsersFilter } from '../lib/validate.ts';
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
  /**
   * Phase 18 repurchase: 'same' = original specs, 'custom' = selected finals,
   * NULL = purchase or historical renewal. Repurchase rows reuse
   * kind='renewal' (the kind CHECK is frozen — see migration 0019) and are
   * distinguished by this column plus snapshot.kind='repurchase'.
   */
  repurchase_mode: string | null;
  /** Claimed ABSOLUTE final panel quota target (bytes) for a repurchase. */
  repurchase_target_quota_bytes: number | null;
  /** Claimed ABSOLUTE fresh expiry target (unix seconds) for a repurchase. */
  repurchase_target_unix: number | null;
  /** Claimed final HWID/device limit for a repurchase. */
  repurchase_target_hwid: number | null;
  /** 1 once POST .../by-username/{u}/reset was issued for this repurchase. */
  repurchase_reset_done: number | null;
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
  /**
   * Phase 18: 'same' | 'custom' marks a REPURCHASE row (stored with
   * kind='renewal' — see OrderRow.repurchase_mode). Undefined/null =
   * historical renewal or purchase.
   */
  repurchaseMode?: 'same' | 'custom' | null;
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
  const initialState = order.initialState ?? 'pending_payment';
  const createdEvent =
    order.initialEvent ?? (initialState === 'approved' ? 'order_created_wallet_paid' : 'order_created');
  // Phase 18: the repurchase_mode column exists only on databases at/after
  // migration 0019. Legacy purchase/renewal inserts keep the EXACT pre-0019
  // shape so they work on old and new schemas alike; repurchase inserts (new
  // feature, kill-switched until 0019 lands) fail closed on old schemas.
  const orderInsert =
    order.repurchaseMode === undefined || order.repurchaseMode === null
      ? db
          .prepare(
            `INSERT INTO orders (id, customer_id, state, kind, selections, amount, currency, idempotency_key, renews_order_id, verified_by, verified_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CASE WHEN ?3 = 'approved' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END)`,
          )
          .bind(
            order.id,
            order.customerId,
            initialState,
            order.kind ?? 'purchase',
            order.selections,
            order.amount,
            order.currency,
            order.idempotencyKey,
            order.renewsOrderId ?? null,
            order.verifiedBy ?? null,
          )
      : db
          .prepare(
            `INSERT INTO orders (id, customer_id, state, kind, selections, amount, currency, idempotency_key, renews_order_id, repurchase_mode, verified_by, verified_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CASE WHEN ?3 = 'approved' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END)`,
          )
          .bind(
            order.id,
            order.customerId,
            initialState,
            order.kind ?? 'purchase',
            order.selections,
            order.amount,
            order.currency,
            order.idempotencyKey,
            order.renewsOrderId ?? null,
            order.repurchaseMode,
            order.verifiedBy ?? null,
          );
  await db.batch([
    orderInsert,
    db
      .prepare(
        `INSERT INTO order_events (order_id, actor, action, to_state, data)
         VALUES (?1, 'customer', ?2, ?3, ?4)`,
      )
      .bind(order.id, createdEvent, initialState, JSON.stringify({ idempotency_key: order.idempotencyKey })),
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

/* ———— Phase 20: /users admin dashboard (migration-free reads) ————
 * Admin-scoped browsing of ANOTHER user's services/orders. Every query below
 * stays scoped by customer_id (resolved server-side from the verified
 * telegram id) and bounded by LIMIT/OFFSET. Snapshot/D1 only — never a
 * PasarGuard call. Unlike the customer surfaces, the admin service history
 * deliberately INCLUDES panel_deleted rows (flagged by the caller via
 * panel_deleted_at) so deletion stays visible instead of hidden. */

/** Paginated full order history for one user, newest-first (admin view). */
export async function listOrdersForCustomerAdmin(
  db: D1Database,
  customerId: number,
  limit: number,
  offset: number,
): Promise<OrderRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM orders WHERE customer_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3`,
    )
    .bind(customerId, limit, offset)
    .all<OrderRow>();
  return result.results;
}

/** Total order rows for one user (orders pagination page count). */
export async function countOrdersForCustomer(
  db: D1Database,
  customerId: number,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS total FROM orders WHERE customer_id = ?1')
    .bind(customerId)
    .first<{ total: number }>();
  return typeof row?.total === 'number' ? row.total : 0;
}

/** Paginated service history for one user (admin view, includes panel-deleted). */
export async function listServicesForCustomerAdmin(
  db: D1Database,
  customerId: number,
  limit: number,
  offset: number,
): Promise<ServiceRow[]> {
  const result = await db
    .prepare(
      `SELECT o.*, ${SERVICE_AGGREGATES}
         FROM orders o
        WHERE o.customer_id = ?1 AND o.kind = 'purchase' AND o.state = 'completed'
        ORDER BY o.service_created_at DESC, o.created_at DESC, o.id DESC
        LIMIT ?2 OFFSET ?3`,
    )
    .bind(customerId, limit, offset)
    .all<ServiceRow>();
  return result.results;
}

/** Total service rows for one user, including panel-deleted (admin view). */
export async function countServicesForCustomerAdmin(
  db: D1Database,
  customerId: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM orders
        WHERE customer_id = ?1 AND kind = 'purchase' AND state = 'completed'`,
    )
    .bind(customerId)
    .first<{ total: number }>();
  return typeof row?.total === 'number' ? row.total : 0;
}

/** Active (panel-alive) service count for one user (dashboard profile line). */
export async function countActiveServicesForCustomer(
  db: D1Database,
  customerId: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM orders
        WHERE customer_id = ?1 AND kind = 'purchase' AND state = 'completed'
          AND panel_deleted_at IS NULL`,
    )
    .bind(customerId)
    .first<{ total: number }>();
  return typeof row?.total === 'number' ? row.total : 0;
}

/** Dashboard S0 overview counts: total services + alive services (bounded scans). */
export async function countAllServices(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM orders WHERE kind = 'purchase' AND state = 'completed'`,
    )
    .first<{ total: number }>();
  return typeof row?.total === 'number' ? row.total : 0;
}

/** Dashboard S0 overview: alive services only. */
export async function countAliveServices(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM orders
        WHERE kind = 'purchase' AND state = 'completed' AND panel_deleted_at IS NULL`,
    )
    .first<{ total: number }>();
  return typeof row?.total === 'number' ? row.total : 0;
}

/** Dashboard S0 overview: active repurchase locks (capped, fail-closed pre-0019). */
export async function countActiveRepurchases(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS total FROM orders
          WHERE kind = 'renewal' AND repurchase_mode IS NOT NULL
            AND state IN ${ACTIVE_REPURCHASE_STATES}`,
      )
      .first<{ total: number }>();
    return typeof row?.total === 'number' ? row.total : 0;
  } catch {
    return 0;
  }
}

/** Active repurchase locks for ONE user (admin per-user repurchase view). */
export async function listActiveRepurchasesForCustomer(
  db: D1Database,
  customerId: number,
  limit: number,
): Promise<QueueRow[]> {
  try {
    const result = await db
      .prepare(
        `SELECT o.*, c.telegram_user_id, c.telegram_username,
                (SELECT MAX(e.created_at) FROM order_events e
                  WHERE e.order_id = o.id AND e.action IN ('receipt_uploaded','receipt_replaced')
                ) AS receipt_uploaded_at
           FROM orders o
           JOIN customers c ON c.id = o.customer_id
          WHERE o.customer_id = ?1 AND o.kind = 'renewal' AND o.repurchase_mode IS NOT NULL
            AND o.state IN ${ACTIVE_REPURCHASE_STATES}
          ORDER BY o.created_at DESC
          LIMIT ?2`,
      )
      .bind(customerId, limit)
      .all<QueueRow>();
    return result.results;
  } catch {
    return [];
  }
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

/* —— Phase 18: repurchase (same-user reset/reconfigure) ———————————————
 * A repurchase row reconfigures an EXISTING service: it reuses kind='renewal'
 * (the kind CHECK is frozen — see migration 0019) and is distinguished by
 * repurchase_mode ('same' | 'custom') plus snapshot.kind='repurchase'.
 * Targets are ABSOLUTE finals (quota bytes, expiry unix, hwid cap) claimed
 * BEFORE any panel mutation; retries adopt the stored values. The reset flag
 * records that POST .../reset was issued; the panel GET (used_traffic == 0)
 * is the authoritative proof. All helpers fail closed on pre-0019 schemas
 * (missing columns → state_changed/null) so legacy databases never half-run
 * a repurchase.
 */

/** States of a repurchase order that still "occupy" the service (one at a time). */
export const ACTIVE_REPURCHASE_STATES =
  "('pending_payment','awaiting_review','approved','provisioning')";

/**
 * Repurchase admin/customer cancellation allow-list. `provisioning` is NEVER
 * cancellable (blind cancel forbidden); `completed`/`rejected`/`cancelled`
 * are terminal and converge as idempotent/no-op. `failed` is included ONLY
 * to release stale/edge-case rows — the cancel path performs ZERO panel
 * mutations, so a failed row with provisioning signals still refuses.
 */
export const CANCELLABLE_REPURCHASE_STATES: readonly string[] = [
  'pending_payment',
  'awaiting_review',
  'approved',
  'failed',
];

/** True when the state alone is eligible for repurchase cancellation. */
export function isRepurchaseCancellableState(state: string): boolean {
  return CANCELLABLE_REPURCHASE_STATES.includes(state);
}

/**
 * True when repurchase provisioning has started or a PasarGuard mutation may
 * already have happened: any claimed absolute target, the reset flag, a
 * provisioning attempt, or the `provisioning` state itself. Cancel must
 * refuse when this is true — use retry/adopt recovery instead.
 */
export function isRepurchaseProvisioningStarted(order: OrderRow): boolean {
  if (order.state === 'provisioning') return true;
  if (
    order.repurchase_target_quota_bytes !== null ||
    order.repurchase_target_unix !== null ||
    order.repurchase_target_hwid !== null
  ) {
    return true;
  }
  if (typeof order.repurchase_reset_done === 'number' && order.repurchase_reset_done === 1) {
    return true;
  }
  if (order.provision_attempts > 0) return true;
  return false;
}

/** Active (lock-holding) repurchases with customer contact, newest last. */
export async function listActiveRepurchases(
  db: D1Database,
  limit: number,
): Promise<QueueRow[]> {
  try {
    const result = await db
      .prepare(
        `SELECT o.*, c.telegram_user_id, c.telegram_username,
                (SELECT MAX(e.created_at) FROM order_events e
                  WHERE e.order_id = o.id AND e.action IN ('receipt_uploaded','receipt_replaced')
                ) AS receipt_uploaded_at
           FROM orders o
           JOIN customers c ON c.id = o.customer_id
          WHERE o.kind = 'renewal' AND o.repurchase_mode IS NOT NULL
            AND o.state IN ${ACTIVE_REPURCHASE_STATES}
          ORDER BY o.created_at DESC
          LIMIT ?1`,
      )
      .bind(limit)
      .all<QueueRow>();
    return result.results;
  } catch {
    return []; // pre-0019 schema: repurchases cannot exist
  }
}

export type RepurchaseCancelOutcome =
  | { ok: true; order: OrderRow; alreadyCancelled: boolean; fromState: string }
  | {
      ok: false;
      error: 'not_found' | 'not_repurchasable' | 'provisioning_started' | 'state_changed';
    };

/**
 * Safe repurchase cancellation: repurchase rows in a cancellable pre-provision
 * state → `cancelled`. Guarded single UPDATE claims the transition (double
 * taps/retries collapse into `alreadyCancelled`), then one audit event is
 * appended. Performs ZERO PasarGuard calls — provisioning-started rows
 * refuse with `provisioning_started`. History rows stay in D1 forever.
 */
export async function cancelRepurchaseOrder(
  db: D1Database,
  opts: { orderId: string; actorTag: string; reason: string | null },
): Promise<RepurchaseCancelOutcome> {
  const before = await getOrderById(db, opts.orderId);
  if (!before) return { ok: false, error: 'not_found' };
  if (before.kind !== 'renewal' || before.repurchase_mode === null) {
    return { ok: false, error: 'not_repurchasable' };
  }
  if (before.state === 'cancelled') {
    return { ok: true, order: before, alreadyCancelled: true, fromState: 'cancelled' };
  }
  // Provisioning itself is never cancellable — report it as such (not a
  // generic state change) so the UI can explain the recovery path.
  if (before.state === 'provisioning') {
    return { ok: false, error: 'provisioning_started' };
  }
  if (!isRepurchaseCancellableState(before.state)) {
    return { ok: false, error: 'state_changed' };
  }
  if (isRepurchaseProvisioningStarted(before)) {
    return { ok: false, error: 'provisioning_started' };
  }

  const reason = opts.reason === null ? null : opts.reason.slice(0, 200);
  let updated: unknown;
  try {
    updated = await db
      .prepare(
        `UPDATE orders
            SET state = 'cancelled',
                verified_by = ?3,
                verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                failure_reason = COALESCE(?4, failure_reason),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?1 AND kind = 'renewal' AND repurchase_mode IS NOT NULL
            AND state IN ('pending_payment','awaiting_review','approved','failed')
            AND repurchase_target_quota_bytes IS NULL
            AND repurchase_target_unix IS NULL
            AND repurchase_target_hwid IS NULL
            AND repurchase_reset_done = 0`,
      )
      .bind(opts.orderId, before.state, opts.actorTag.slice(0, 64), reason)
      .run();
  } catch {
    return { ok: false, error: 'state_changed' };
  }
  if (changeCount(updated) === 0) {
    const fresh = await getOrderById(db, opts.orderId);
    if (!fresh) return { ok: false, error: 'not_found' };
    if (fresh.state === 'cancelled') {
      return { ok: true, order: fresh, alreadyCancelled: true, fromState: before.state };
    }
    if (fresh.kind !== 'renewal' || fresh.repurchase_mode === null) {
      return { ok: false, error: 'not_repurchasable' };
    }
    if (isRepurchaseProvisioningStarted(fresh) || fresh.state === 'provisioning') {
      return { ok: false, error: 'provisioning_started' };
    }
    return { ok: false, error: 'state_changed' };
  }

  await db
    .prepare(
      `INSERT INTO order_events (order_id, actor, action, from_state, to_state, data)
       VALUES (?1, ?2, 'repurchase_cancelled', ?3, 'cancelled', ?4)`,
    )
    .bind(
      opts.orderId,
      opts.actorTag.slice(0, 64),
      before.state,
      reason === null
        ? JSON.stringify({ via: 'repurchase_cancel' })
        : JSON.stringify({ reason }),
    )
    .run();

  const after = await getOrderById(db, opts.orderId);
  if (!after) return { ok: false, error: 'not_found' };
  return { ok: true, order: after, alreadyCancelled: false, fromState: before.state };
}

/** In-flight repurchase for a service (blocks starting a second one). */
export async function findActiveRepurchaseForService(
  db: D1Database,
  serviceOrderId: string,
): Promise<OrderRow | null> {
  try {
    return await db
      .prepare(
        `SELECT * FROM orders
          WHERE renews_order_id = ?1 AND kind = 'renewal' AND repurchase_mode IS NOT NULL
            AND state IN ${ACTIVE_REPURCHASE_STATES}
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(serviceOrderId)
      .first<OrderRow>();
  } catch {
    return null; // pre-0019 schema: repurchases cannot exist — nothing active
  }
}

export type RepurchaseClaimOutcome =
  | { ok: true; value: number }
  | { ok: false; error: 'not_found' | 'state_changed' };

/**
 * Claim one ABSOLUTE repurchase target on the order BEFORE the panel write.
 * First writer wins; losers adopt the stored value so retries converge and
 * can never stack quota/expiry/hwids or double-reset.
 */
async function claimRepurchaseColumn(
  db: D1Database,
  opts: { orderId: string; column: string; value: number },
): Promise<RepurchaseClaimOutcome> {
  const allowed = new Set([
    'repurchase_target_quota_bytes',
    'repurchase_target_unix',
    'repurchase_target_hwid',
  ]);
  if (!allowed.has(opts.column)) return { ok: false, error: 'state_changed' };
  let updated: unknown;
  try {
    updated = await db
      .prepare(
        `UPDATE orders
            SET ${opts.column} = ?2,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?1 AND kind = 'renewal' AND repurchase_mode IS NOT NULL
            AND state = 'provisioning' AND ${opts.column} IS NULL`,
      )
      .bind(opts.orderId, opts.value)
      .run();
  } catch {
    // Column missing on databases predating the 0019 migration: fail closed.
    return { ok: false, error: 'state_changed' };
  }
  if (changeCount(updated) > 0) return { ok: true, value: opts.value };
  let fresh: OrderRow | null = null;
  try {
    fresh = await getOrderById(db, opts.orderId);
  } catch {
    return { ok: false, error: 'not_found' };
  }
  if (!fresh) return { ok: false, error: 'not_found' };
  if (fresh.state !== 'provisioning') return { ok: false, error: 'state_changed' };
  const stored = (fresh as unknown as Record<string, unknown>)[opts.column];
  return typeof stored === 'number' && Number.isSafeInteger(stored)
    ? { ok: true, value: stored }
    : { ok: false, error: 'state_changed' };
}

export function claimRepurchaseQuotaTarget(
  db: D1Database,
  opts: { orderId: string; quotaBytes: number },
): Promise<RepurchaseClaimOutcome> {
  return claimRepurchaseColumn(db, { ...opts, column: 'repurchase_target_quota_bytes', value: opts.quotaBytes });
}

export function claimRepurchaseExpiryTarget(
  db: D1Database,
  opts: { orderId: string; targetUnix: number },
): Promise<RepurchaseClaimOutcome> {
  return claimRepurchaseColumn(db, { ...opts, column: 'repurchase_target_unix', value: opts.targetUnix });
}

export function claimRepurchaseHwidTarget(
  db: D1Database,
  opts: { orderId: string; hwid: number },
): Promise<RepurchaseClaimOutcome> {
  return claimRepurchaseColumn(db, { ...opts, column: 'repurchase_target_hwid', value: opts.hwid });
}

export function claimRepurchaseReset(
  db: D1Database,
  opts: { orderId: string },
): Promise<{ ok: true; issued: boolean } | { ok: false; error: 'not_found' | 'state_changed' }> {
  return (async () => {
    // The flag defaults to 0 (migration 0019), so the claim is a 0 → 1 flip —
    // not an IS NULL claim like the absolute targets above. The winner issues
    // exactly one POST .../reset; losers adopt and verify via GET instead.
    let updated: unknown;
    try {
      updated = await db
        .prepare(
          `UPDATE orders
              SET repurchase_reset_done = 1,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?1 AND kind = 'renewal' AND repurchase_mode IS NOT NULL
              AND state = 'provisioning' AND repurchase_reset_done = 0`,
        )
        .bind(opts.orderId)
        .run();
    } catch {
      // Column missing on databases predating the 0019 migration: fail closed.
      return { ok: false, error: 'state_changed' } as const;
    }
    if (changeCount(updated) > 0) return { ok: true, issued: true } as const;
    const fresh = await getOrderById(db, opts.orderId);
    if (!fresh) return { ok: false, error: 'not_found' } as const;
    if (fresh.state !== 'provisioning') return { ok: false, error: 'state_changed' } as const;
    return fresh.repurchase_reset_done === 1
      ? ({ ok: true, issued: false } as const)
      : ({ ok: false, error: 'state_changed' } as const);
  })();
}

/**
 * provisioning → completed for a REPURCHASE order. Deliberately does NOT
 * touch pasarguard_username / pasarguard_user_id: those belong to the service
 * (purchase) order and one service links exactly one owner row (UNIQUE guard
 * from 0001 — writing the same user id here would collide). The CURRENT
 * subscription URL (which may rotate on reset) IS refreshed, since the URL
 * is not identity. The fresh expiry is booked onto the SERVICE row via
 * bookRepurchaseOnService.
 */
export async function completeRepurchasedOrder(
  db: D1Database,
  opts: {
    orderId: string;
    targetUnix: number;
    quotaBytes: number;
    hwid: number;
    /** Current subscription URL (audit event only — never a column write). */
    subscriptionUrl: string | null;
  },
): Promise<ProvisionFinalizeOutcome> {
  let updated: unknown;
  try {
    updated = await db
      .prepare(
        `UPDATE orders
            SET state = 'completed',
                failure_reason = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?1 AND state = 'provisioning' AND kind = 'renewal' AND repurchase_mode IS NOT NULL`,
      )
      .bind(opts.orderId)
      .run();
  } catch {
    return { ok: false, error: 'state_changed' };
  }
  if (changeCount(updated) === 0) {
    const fresh = await getOrderById(db, opts.orderId);
    return fresh ? { ok: false, error: 'state_changed' } : { ok: false, error: 'not_found' };
  }
  await db
    .prepare(
      `INSERT INTO order_events (order_id, actor, action, from_state, to_state, data)
       VALUES (?1, 'system', 'repurchase_succeeded', 'provisioning', 'completed', ?2)`,
    )
    .bind(
      opts.orderId,
      JSON.stringify({
        new_target_unix: opts.targetUnix,
        new_quota_bytes: opts.quotaBytes,
        new_hwid: opts.hwid,
        subscription_url: opts.subscriptionUrl,
      }),
    )
    .run();
  const after = await getOrderById(db, opts.orderId);
  if (!after) return { ok: false, error: 'not_found' };
  return { ok: true, order: after };
}

/**
 * Book a completed repurchase on its service row: refresh the local expiry
 * (forward-only — a late/parallel write can never shorten it), refresh the
 * CURRENT subscription URL (it may rotate on reset; URL is not identity),
 * and attach a `service_repurchased` audit event pointing at the repurchase
 * order. The service row keeps its username/user history untouched.
 */
export async function bookRepurchaseOnService(
  db: D1Database,
  opts: {
    serviceOrderId: string;
    repurchaseOrderId: string;
    expiresIso: string;
    subscriptionUrl: string | null;
  },
): Promise<boolean> {
  const current = await getOrderById(db, opts.serviceOrderId);
  if (!current || current.kind !== 'purchase') return false;
  const updated = await db
    .prepare(
      `UPDATE orders
          SET service_expires_at = CASE
                WHEN service_expires_at IS NULL OR service_expires_at < ?2 THEN ?2
                ELSE service_expires_at
              END,
              subscription_url = COALESCE(?3, subscription_url),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND kind = 'purchase' AND state = 'completed'`,
    )
    .bind(opts.serviceOrderId, opts.expiresIso, opts.subscriptionUrl)
    .run();
  if (changeCount(updated) === 0) return current.service_expires_at !== null;
  await db
    .prepare(
      `INSERT INTO order_events (order_id, actor, action, data)
       VALUES (?1, 'system', 'service_repurchased', ?2)`,
    )
    .bind(
      opts.serviceOrderId,
      JSON.stringify({
        repurchase_order_id: opts.repurchaseOrderId,
        expires_at: opts.expiresIso,
        subscription_url: opts.subscriptionUrl,
      }),
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

/* ———— Phase 22: /users filter submenu (migration-free, SELECT-only) ————
 * Customer filtering for the admin-only /users surface. Every predicate below
 * reuses the EXISTING order-state meanings (no new states): `pending_payment`
 * is pre-receipt, `awaiting_review` is post-receipt/pre-decision
 * (`submitOrderReceipt`), `failed` matches `listOrdersFailed` (panel-deleted
 * failures excluded there and here), and the active-service shape mirrors
 * `effectiveExpiryIso` (booked `service_expires_at` first, else
 * `service_created_at + duration_days` from the snapshot). Snapshot/D1 only —
 * never a PasarGuard call. One row per customer structurally (selection is
 * FROM customers with an EXISTS probe; counts use COUNT(DISTINCT)). */
const USERS_FILTER_NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/** Order-row predicate on alias `o` for one filter (no customer correlation). */
function usersFilterOrderPredicate(filter: Exclude<UsersFilter, 'all'>): string {
  switch (filter) {
    case 'active':
      return (
        `o.kind = 'purchase' AND o.state = 'completed' AND o.panel_deleted_at IS NULL` +
        ` AND json_extract(o.selections, '$.free_test') IS NOT true` +
        ` AND (o.service_expires_at > ${USERS_FILTER_NOW}` +
        ` OR (o.service_expires_at IS NULL AND (o.service_created_at IS NULL` +
        ` OR CAST(json_extract(o.selections, '$.duration_days') AS INTEGER) IS NULL` +
        ` OR datetime(o.service_created_at, '+' || CAST(json_extract(o.selections, '$.duration_days') AS INTEGER) || ' days') > ${USERS_FILTER_NOW})))`
      );
    case 'paywait':
      return `o.state = 'pending_payment'`;
    case 'review':
      return `o.state = 'awaiting_review'`;
    case 'failed':
      return `o.state = 'failed' AND o.panel_deleted_at IS NULL`;
    case 'deleted':
      return `o.kind = 'purchase' AND o.state = 'completed' AND o.panel_deleted_at IS NOT NULL`;
  }
}

/** Customers matching one filter (DISTINCT count, efficient, no full loads). */
export async function countCustomersByFilter(db: D1Database, filter: UsersFilter): Promise<number> {
  if (filter === 'all') return countCustomers(db);
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT o.customer_id) AS total FROM orders o WHERE ${usersFilterOrderPredicate(filter)}`,
    )
    .first<{ total: number }>();
  return typeof row?.total === 'number' ? row.total : 0;
}

/** One page of customers matching one filter, newest-first (same row shape as listCustomersPage). */
export async function listCustomersPageByFilter(
  db: D1Database,
  filter: UsersFilter,
  limit: number,
  offset: number,
): Promise<Array<CustomerRecord & { balance_irt: number }>> {
  if (filter === 'all') return listCustomersPage(db, limit, offset);
  const result = await db
    .prepare(
      `SELECT c.id, c.telegram_user_id, c.telegram_username, c.first_name, c.last_name,
              c.language_code, c.language, c.is_admin, c.created_at, c.updated_at, c.balance_irt
         FROM customers c
        WHERE EXISTS (SELECT 1 FROM orders o
                       WHERE o.customer_id = c.id AND ${usersFilterOrderPredicate(filter)})
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ?1 OFFSET ?2`,
    )
    .bind(limit, offset)
    .all<CustomerRecord & { balance_irt: number }>();
  return result.results;
}
