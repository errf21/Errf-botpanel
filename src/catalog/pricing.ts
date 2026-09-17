/**
 * Pure integer price calculation. No floating-point money, ever.
 *
 * Phase 12 model — every value is an EXACT admin-defined number:
 *
 *   total = time + volume + users
 *     time   = months === 1 ? base_product.price : duration_prices[months]
 *     volume = max(0, volume_gb - base_product.gb) * price_per_gb
 *     users  = user_prices[device_count]
 *
 * There are intentionally NO multipliers and NO months*rate arithmetic for
 * duration or users: the bot only multiplies where the business says so (GB
 * beyond the base) and otherwise looks the admin's number up verbatim.
 *
 * The applied inputs are returned inside the breakdown so orders persist a
 * complete price snapshot (config may change later; orders must not).
 */
import type { PricingConfig } from './catalog.ts';

export interface PriceSelection {
  volumeGb: number;
  durationDays: number;
  deviceCount: number;
}

/** The exact inputs behind one calculation — persisted in the order snapshot. */
export interface PriceInputs {
  base_gb: number;
  base_product_price: number;
  price_per_gb: number;
  /** 'base' for 1 month; otherwise the duration_prices key that was used. */
  duration_key: 'base' | number;
  duration_price: number;
  user_count: number;
  user_price: number;
  days_per_month: number;
}

export interface PriceBreakdown {
  schema: 2;
  currency: string;
  inputs: PriceInputs;
  volume_gb: number;
  extra_gb: number;
  volume_cost: number;
  duration_days: number;
  months: number;
  /** The time component (base price for 1 month, else the duration entry). */
  time_cost: number;
  device_count: number;
  user_cost: number;
  total: number;
}

export type PriceResult =
  | { ok: true; breakdown: PriceBreakdown }
  | { ok: false; error: string };

function product(a: number, b: number): number | null {
  const result = a * b;
  return Number.isSafeInteger(result) ? result : null;
}

function safeInt(value: unknown, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

/**
 * Shared volume-price component: the purchase rate for GB beyond the base.
 * `calculatePrice` uses it as `extraGb = max(0, volumeGb - baseGb)`; renewal
 * add-ons call it directly with the ADDED gb (an add-on is 100% extra — the
 * service already owns its base). Same `product()` overflow semantics, same
 * `usableConfig` gate, so purchase and renewal can never drift apart.
 */
export function volumeExtraCost(
  pricing: PricingConfig,
  extraGb: number,
): { ok: true; cost: number } | { ok: false; error: string } {
  if (!usableConfig(pricing)) {
    return { ok: false, error: 'pricing_config' };
  }
  if (!safeInt(extraGb, 1_000_000)) {
    return { ok: false, error: 'selection_range' };
  }
  const cost = product(extraGb, pricing.pricePerGb);
  if (cost === null) return { ok: false, error: 'overflow' };
  return { ok: true, cost };
}

/** Validate a whole live config against the calculator's own boundaries. */
function usableConfig(pricing: PricingConfig): boolean {
  return (
    safeInt(pricing.baseGb, 1_000_000_000) &&
    pricing.baseGb >= 1 &&
    safeInt(pricing.baseProductPrice, 1_000_000_000) &&
    pricing.baseProductPrice >= 1 &&
    safeInt(pricing.pricePerGb, 1_000_000_000) &&
    pricing.pricePerGb >= 1 &&
    safeInt(pricing.daysPerMonth, 365) &&
    pricing.daysPerMonth >= 1
  );
}

/**
 * Resolve the TIME component for a month count: 1 month is the base product
 * price itself; every other supported count is its exact table entry. An
 * unpriced month count is a contradictory config, never a silent default.
 */
export function durationEntry(
  pricing: PricingConfig,
  durationDays: number,
): { ok: true; months: number; key: 'base' | number; price: number } | { ok: false; error: string } {
  if (!safeInt(durationDays, 1_000_000) || durationDays < 1) {
    return { ok: false, error: 'selection_range' };
  }
  if (durationDays % pricing.daysPerMonth !== 0) {
    return { ok: false, error: 'duration_unmapped' };
  }
  const months = durationDays / pricing.daysPerMonth;
  if (months === 1) {
    return { ok: true, months, key: 'base', price: pricing.baseProductPrice };
  }
  const price = pricing.durationPrices[months];
  if (price === undefined || !Number.isSafeInteger(price)) {
    return { ok: false, error: 'duration_unpriced' };
  }
  return { ok: true, months, key: months, price };
}

export function calculatePrice(
  pricing: PricingConfig,
  selection: PriceSelection,
): PriceResult {
  if (!usableConfig(pricing)) {
    return { ok: false, error: 'pricing_config' };
  }
  if (
    !safeInt(selection.volumeGb, 1_000_000) ||
    !safeInt(selection.deviceCount, 100_000) ||
    selection.volumeGb < 1 ||
    selection.deviceCount < 1
  ) {
    return { ok: false, error: 'selection_range' };
  }

  const time = durationEntry(pricing, selection.durationDays);
  if (!time.ok) return { ok: false, error: time.error };

  const userPrice = pricing.userPrices[selection.deviceCount];
  if (userPrice === undefined || !Number.isSafeInteger(userPrice)) {
    return { ok: false, error: 'user_unpriced' };
  }

  const extraGb = Math.max(0, selection.volumeGb - pricing.baseGb);
  const volume = volumeExtraCost(pricing, extraGb);
  if (!volume.ok) return { ok: false, error: volume.error };
  const volumeCost = volume.cost;
  const total = time.price + volumeCost + userPrice;
  if (!Number.isSafeInteger(total)) return { ok: false, error: 'overflow' };

  return {
    ok: true,
    breakdown: {
      schema: 2,
      currency: pricing.currency,
      inputs: {
        base_gb: pricing.baseGb,
        base_product_price: pricing.baseProductPrice,
        price_per_gb: pricing.pricePerGb,
        duration_key: time.key,
        duration_price: time.price,
        user_count: selection.deviceCount,
        user_price: userPrice,
        days_per_month: pricing.daysPerMonth,
      },
      volume_gb: selection.volumeGb,
      extra_gb: extraGb,
      volume_cost: volumeCost,
      duration_days: selection.durationDays,
      months: time.months,
      time_cost: time.price,
      device_count: selection.deviceCount,
      user_cost: userPrice,
      total,
    },
  };
}

export function catalogLimits(catalog: {
  volume: { minGb: number; maxGb: number };
  duration: { minDays: number; maxDays: number };
  device: { minCount: number; maxCount: number };
}): {
  min_gb: number;
  max_gb: number;
  min_devices: number;
  max_devices: number;
  min_days: number;
  max_days: number;
} {
  return {
    min_gb: catalog.volume.minGb,
    max_gb: catalog.volume.maxGb,
    min_days: catalog.duration.minDays,
    max_days: catalog.duration.maxDays,
    min_devices: catalog.device.minCount,
    max_devices: catalog.device.maxCount,
  };
}

/* ———— Phase 6 + 12: renewals, extended with additive volume ————
 * A renewal extends the SAME service by additional months and/or additional
 * GB. The TIME component reuses `durationEntry` exactly like a purchase (1
 * month renews at the base product price); the VOLUME component reuses the
 * shared `volumeExtraCost` purchase rate applied to the ADDED gb (an add-on
 * is 100% extra — the service already owns its base, so no base deduction).
 * `durationDays == 0` means "no time extension", `addedVolumeGb == 0` means
 * "no volume increase"; both zero is rejected by the caller ladder (and here
 * as a degraded backstop). Snapshotted exactly like a purchase so a later
 * price edit cannot retroactively change a placed renewal.
 */
export interface RenewalBreakdown {
  schema: 2;
  kind: 'renewal';
  currency: string;
  inputs: {
    base_product_price: number;
    base_gb: number;
    price_per_gb: number;
    duration_key: 'base' | number | 'none';
    duration_price: number;
    days_per_month: number;
  };
  /** Days being added (0 = no time extension). */
  duration_days: number;
  months: number;
  time_cost: number;
  /** Added GB (0 = no volume increase). */
  added_volume_gb: number;
  volume_cost: number;
  total: number;
}

export function calculateRenewalPrice(
  pricing: PricingConfig,
  selection: { durationDays: number; addedVolumeGb?: number },
): { ok: true; breakdown: RenewalBreakdown } | { ok: false; error: string } {
  if (!usableConfig(pricing)) {
    return { ok: false, error: 'pricing_config' };
  }
  const addedGb = selection.addedVolumeGb ?? 0;
  if (!safeInt(selection.durationDays, 1_000_000) || !safeInt(addedGb, 1_000_000)) {
    return { ok: false, error: 'selection_range' };
  }
  if (selection.durationDays === 0 && addedGb === 0) {
    return { ok: false, error: 'selection_range' };
  }
  let months = 0;
  let timeKey: 'base' | number | 'none' = 'none';
  let timePrice = 0;
  if (selection.durationDays > 0) {
    const time = durationEntry(pricing, selection.durationDays);
    if (!time.ok) return { ok: false, error: time.error };
    months = time.months;
    timeKey = time.key;
    timePrice = time.price;
  }
  const volume = volumeExtraCost(pricing, addedGb);
  if (!volume.ok) return { ok: false, error: volume.error };
  const total = timePrice + volume.cost;
  if (!Number.isSafeInteger(total) || total < 1) return { ok: false, error: 'overflow' };
  return {
    ok: true,
    breakdown: {
      schema: 2,
      kind: 'renewal',
      currency: pricing.currency,
      inputs: {
        base_product_price: pricing.baseProductPrice,
        base_gb: pricing.baseGb,
        price_per_gb: pricing.pricePerGb,
        duration_key: timeKey,
        duration_price: timePrice,
        days_per_month: pricing.daysPerMonth,
      },
      duration_days: selection.durationDays,
      months,
      time_cost: timePrice,
      added_volume_gb: addedGb,
      volume_cost: volume.cost,
      total,
    },
  };
}
