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
import { catalogLimits, type PriceBreakdown } from '../catalog/pricing.ts';
import type { Catalog } from '../catalog/catalog.ts';

export interface CheckoutDraft {
  customerId: number;
  orderToken: string; // ULID generated at confirmation-step entry
  configName: string;
  catalog: Catalog;
  breakdown: PriceBreakdown;
}

export type CheckoutResult =
  | { ok: true; order: OrderRow; created: boolean }
  | { ok: false; error: string };

export function buildSelectionSnapshot(
  draft: CheckoutDraft,
): string {
  return JSON.stringify({
    schema: 1,
    config_name: draft.configName,
    volume_gb: draft.breakdown.volume_gb,
    duration_days: draft.breakdown.duration_days,
    device_count: draft.breakdown.device_count,
    price: draft.breakdown,
    limits: catalogLimits(draft.catalog),
  });
}

export async function checkoutOrder(
  db: D1Database,
  draft: CheckoutDraft,
): Promise<CheckoutResult> {
  const preExisting = await findOrderByIdempotencyKey(db, draft.orderToken);
  if (preExisting) return { ok: true, order: preExisting, created: false };

  const order: NewOrderFields = {
    id: newOrderId(),
    customerId: draft.customerId,
    selections: buildSelectionSnapshot(draft),
    amount: draft.breakdown.total,
    currency: draft.breakdown.currency,
    idempotencyKey: draft.orderToken,
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
