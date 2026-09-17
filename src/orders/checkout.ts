/**
 * Checkout: the ONLY place pricing is allowed to produce an order.
 * Idempotent by design — the same draft token can never create two rows,
 * even under a race or a webhook replay that bypassed update dedupe.
 */
import { newOrderId } from '../lib/security.ts';
import {
  findOrderByIdempotencyKey,
  insertOrderWithEvent,
  type NewOrderFields,
  type OrderRow,
} from '../db/orders.ts';
import { catalogLimits, type PriceBreakdown, type RenewalBreakdown } from '../catalog/pricing.ts';
import { isSalesStopped } from '../catalog/sales.ts';
import type { Catalog } from '../catalog/catalog.ts';

export interface CheckoutDraft {
  customerId: number;
  orderToken: string; // ULID generated at confirmation-step entry
  configName: string;
  catalog: Catalog;
  breakdown: PriceBreakdown;
}

/**
 * Phase 7: pure wallet planning — decide the applied credit and the exit
 * state BEFORE any write, from server-side numbers only (fresh balance,
 * snapshotted total). `full` ⇒ the order is born 'approved' (no receipt, no
 * admin queue); `partial` ⇒ remainder via the existing payment pipeline.
 */
export interface WalletPlan {
  mode: 'full' | 'partial';
  creditIrt: number;
  remainderIrt: number;
}

export function planWalletPayment(
  totalIrt: number,
  balanceIrt: number,
  mode: 'full' | 'partial',
): WalletPlan | null {
  if (!Number.isSafeInteger(totalIrt) || totalIrt < 1) return null;
  if (!Number.isSafeInteger(balanceIrt) || balanceIrt < 0) return null;
  if (mode === 'full') {
    if (balanceIrt < totalIrt) return null;
    return { mode: 'full', creditIrt: totalIrt, remainderIrt: 0 };
  }
  const credit = Math.min(balanceIrt, totalIrt - 1); // remainder always ≥ 1
  if (credit < 1) return null;
  return { mode: 'partial', creditIrt: credit, remainderIrt: totalIrt - credit };
}

export type CheckoutResult =
  | { ok: true; order: OrderRow; created: boolean }
  | { ok: false; error: string };

/** Snapshot stored in orders.selections (additive wallet fields, schema 1). */
export function buildSelectionSnapshot(
  draft: CheckoutDraft,
  wallet?: WalletPlan,
): string {
  return JSON.stringify({
    schema: 1,
    config_name: draft.configName,
    volume_gb: draft.breakdown.volume_gb,
    duration_days: draft.breakdown.duration_days,
    device_count: draft.breakdown.device_count,
    price: draft.breakdown,
    limits: catalogLimits(draft.catalog),
    ...(wallet ? { wallet: { mode: wallet.mode, credit_irt: wallet.creditIrt } } : {}),
  });
}

export async function checkoutOrder(
  db: D1Database,
  draft: CheckoutDraft,
  wallet?: WalletPlan,
): Promise<CheckoutResult> {
  // Phase 13 backstop: checkout is the ONLY place pricing produces an order,
  // so this guard makes the sales stop structurally unbypassable even if a
  // future entry point forgets its own gate. Callers already treat a failed
  // checkout as "no order" and refund claimed wallet credit on a confirmed
  // miss, so a stop landing mid-race can never keep customer money.
  if (await isSalesStopped(db)) return { ok: false, error: 'sales_stopped' };
  const preExisting = await findOrderByIdempotencyKey(db, draft.orderToken);
  if (preExisting) return { ok: true, order: preExisting, created: false };

  const order: NewOrderFields = {
    id: newOrderId(),
    customerId: draft.customerId,
    selections: buildSelectionSnapshot(draft, wallet),
    amount: wallet ? wallet.remainderIrt : draft.breakdown.total,
    currency: draft.breakdown.currency,
    idempotencyKey: draft.orderToken,
    ...(wallet?.mode === 'full'
      ? { initialState: 'approved' as const, verifiedBy: 'wallet' }
      : {}),
  };

  try {
    await insertOrderWithEvent(db, order);
  } catch (error) {
    // UNIQUE(idempotency_key) race: another execution won — never double-create.
    const raceWinner = await findOrderByIdempotencyKey(db, draft.orderToken);
    if (raceWinner) return { ok: true, order: raceWinner, created: false };
    const name = error instanceof Error ? error.name : 'unknown';
    return { ok: false, error: `insert_failed:${name}`.slice(0, 80) };
  }

  const created = await findOrderByIdempotencyKey(db, draft.orderToken);
  if (!created) return { ok: false, error: 'insert_unconfirmed' };
  return { ok: true, order: created, created: true };
}

/** Snapshot for a wallet-funded order that raced: applied credit if any. */
export function walletCreditFromSnapshot(order: OrderRow): number | null {
  try {
    const raw: unknown = JSON.parse(order.selections);
    const wallet =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)['wallet']
        : undefined;
    if (typeof wallet === 'object' && wallet !== null && !Array.isArray(wallet)) {
      const credit = (wallet as Record<string, unknown>)['credit_irt'];
      if (typeof credit === 'number' && Number.isSafeInteger(credit) && credit >= 0) {
        return credit;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Snapshot written to a renewal order's `selections` column. */
export function buildRenewalSnapshot(
  draft: RenewalCheckoutDraft,
  serviceConfigName: string,
  wallet?: WalletPlan,
): string {
  return JSON.stringify({
    schema: 1,
    kind: 'renewal',
    renews_order_id: draft.serviceOrderId,
    config_name: serviceConfigName,
    duration_days: draft.breakdown.duration_days,
    added_volume_gb: draft.breakdown.added_volume_gb,
    price: draft.breakdown,
    limits: catalogLimits(draft.catalog),
    ...(wallet ? { wallet: { mode: wallet.mode, credit_irt: wallet.creditIrt } } : {}),
  });
}

/**
 * Renewal sibling of checkoutOrder: IDENTICAL idempotency guarantees (token
 * → partial UNIQUE index → race-winner re-read), only the snapshot, kind and
 * service linkage differ. The service row itself is touched ONLY after the
 * panel extension succeeds (provisioning books it), never here.
 */
export async function checkoutRenewalOrder(
  db: D1Database,
  draft: RenewalCheckoutDraft,
  serviceConfigName: string,
  wallet?: WalletPlan,
): Promise<CheckoutResult> {
  // Phase 13: renewals EXTEND a paid service, so the commercial stop covers
  // them too — same unbypassable backstop discipline as checkoutOrder.
  if (await isSalesStopped(db)) return { ok: false, error: 'sales_stopped' };
  const preExisting = await findOrderByIdempotencyKey(db, draft.orderToken);
  if (preExisting) return { ok: true, order: preExisting, created: false };

  const order: NewOrderFields = {
    id: newOrderId(),
    customerId: draft.customerId,
    selections: buildRenewalSnapshot(draft, serviceConfigName, wallet),
    amount: wallet ? wallet.remainderIrt : draft.breakdown.total,
    currency: draft.breakdown.currency,
    idempotencyKey: draft.orderToken,
    kind: 'renewal',
    renewsOrderId: draft.serviceOrderId,
    ...(wallet?.mode === 'full'
      ? { initialState: 'approved' as const, verifiedBy: 'wallet' }
      : {}),
  };

  try {
    await insertOrderWithEvent(db, order);
  } catch (error) {
    const raceWinner = await findOrderByIdempotencyKey(db, draft.orderToken);
    if (raceWinner) return { ok: true, order: raceWinner, created: false };
    const name = error instanceof Error ? error.name : 'unknown';
    return { ok: false, error: `insert_failed:${name}`.slice(0, 80) };
  }

  const created = await findOrderByIdempotencyKey(db, draft.orderToken);
  if (!created) return { ok: false, error: 'insert_unconfirmed' };
  return { ok: true, order: created, created: true };
}

export interface RenewalCheckoutDraft {
  customerId: number;
  orderToken: string;
  catalog: Catalog;
  breakdown: RenewalBreakdown;
  /** The completed purchase order (service) being extended. */
  serviceOrderId: string;
}

/**
 * Phase 18 repurchase draft. The breakdown is a NORMAL purchase breakdown
 * (calculatePrice) over the FINAL specs — original specs for mode 'same',
 * user-selected finals for mode 'custom'. The service row itself is touched
 * ONLY after the panel reconfiguration succeeds (provisioning books it).
 */
export interface RepurchaseCheckoutDraft {
  customerId: number;
  orderToken: string;
  catalog: Catalog;
  breakdown: PriceBreakdown;
  /** The completed purchase order (service) being reconfigured. */
  serviceOrderId: string;
  mode: 'same' | 'custom';
}

/** Snapshot written to a repurchase order's `selections` column. Immutable
 *  once the order exists: provisioning reads ONLY this snapshot (plus the
 *  claimed D1 targets), so later UI/catalog changes cannot alter the finals.
 */
export function buildRepurchaseSnapshot(
  draft: RepurchaseCheckoutDraft,
  serviceConfigName: string,
  wallet?: WalletPlan,
): string {
  return JSON.stringify({
    schema: 1,
    kind: 'repurchase',
    mode: draft.mode,
    repurchases_order_id: draft.serviceOrderId,
    renews_order_id: draft.serviceOrderId,
    config_name: serviceConfigName,
    volume_gb: draft.breakdown.volume_gb,
    duration_days: draft.breakdown.duration_days,
    device_count: draft.breakdown.device_count,
    price: draft.breakdown,
    limits: catalogLimits(draft.catalog),
    ...(wallet ? { wallet: { mode: wallet.mode, credit_irt: wallet.creditIrt } } : {}),
  });
}

/**
 * Repurchase sibling of checkoutOrder/checkoutRenewalOrder: IDENTICAL
 * idempotency guarantees (token → partial UNIQUE index → race-winner
 * re-read). Stored with kind='renewal' + repurchase_mode (the kind CHECK is
 * frozen — see migration 0019); the snapshot kind 'repurchase' + mode is the
 * product identity. Sales-stop backstop is unbypassable, same as the others.
 */
export async function checkoutRepurchaseOrder(
  db: D1Database,
  draft: RepurchaseCheckoutDraft,
  serviceConfigName: string,
  wallet?: WalletPlan,
): Promise<CheckoutResult> {
  // Phase 18: a repurchase RECONFIGURES a paid service, so the commercial
  // stop covers it too — same unbypassable backstop discipline.
  if (await isSalesStopped(db)) return { ok: false, error: 'sales_stopped' };
  const preExisting = await findOrderByIdempotencyKey(db, draft.orderToken);
  if (preExisting) return { ok: true, order: preExisting, created: false };

  const order: NewOrderFields = {
    id: newOrderId(),
    customerId: draft.customerId,
    selections: buildRepurchaseSnapshot(draft, serviceConfigName, wallet),
    amount: wallet ? wallet.remainderIrt : draft.breakdown.total,
    currency: draft.breakdown.currency,
    idempotencyKey: draft.orderToken,
    kind: 'renewal',
    renewsOrderId: draft.serviceOrderId,
    repurchaseMode: draft.mode,
    ...(wallet?.mode === 'full'
      ? { initialState: 'approved' as const, verifiedBy: 'wallet' }
      : {}),
  };

  try {
    await insertOrderWithEvent(db, order);
  } catch (error) {
    const raceWinner = await findOrderByIdempotencyKey(db, draft.orderToken);
    if (raceWinner) return { ok: true, order: raceWinner, created: false };
    const name = error instanceof Error ? error.name : 'unknown';
    return { ok: false, error: `insert_failed:${name}`.slice(0, 80) };
  }

  const created = await findOrderByIdempotencyKey(db, draft.orderToken);
  if (!created) return { ok: false, error: 'insert_unconfirmed' };
  return { ok: true, order: created, created: true };
}
