/**
 * Pure integer price calculation. No floating-point money, ever.
 *
 *   total = volume_gb * gb_rate
 *         + ceil(duration_days / days_per_month) * month_rate
 *         + max(0, device_count - 1) * device_rate
 *
 * The applied rates are returned inside the breakdown so orders persist a
 * complete price snapshot (config may change later; orders must not).
 */
import type { PricingConfig } from './catalog.ts';

export interface PriceSelection {
  volumeGb: number;
  durationDays: number;
  deviceCount: number;
}

export interface PriceBreakdown {
  schema: 1;
  currency: string;
  rates: {
    gb_rate: number;
    month_rate: number;
    device_rate: number;
    days_per_month: number;
  };
  volume_gb: number;
  volume_cost: number;
  duration_days: number;
  months: number;
  duration_cost: number;
  device_count: number;
  extra_devices: number;
  device_cost: number;
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

export function calculatePrice(
  pricing: PricingConfig,
  selection: PriceSelection,
): PriceResult {
  if (
    !safeInt(pricing.gbRate, 1_000_000_000) ||
    !safeInt(pricing.monthRate, 1_000_000_000) ||
    !safeInt(pricing.deviceRate, 1_000_000_000) ||
    !safeInt(pricing.daysPerMonth, 365) ||
    pricing.daysPerMonth < 1
  ) {
    return { ok: false, error: 'pricing_config' };
  }
  if (
    !safeInt(selection.volumeGb, 1_000_000) ||
    !safeInt(selection.durationDays, 1_000_000) ||
    !safeInt(selection.deviceCount, 100_000) ||
    selection.volumeGb < 1 ||
    selection.durationDays < 1 ||
    selection.deviceCount < 1
  ) {
    return { ok: false, error: 'selection_range' };
  }

  const volumeCost = product(selection.volumeGb, pricing.gbRate);
  const months = Math.ceil(selection.durationDays / pricing.daysPerMonth);
  if (!safeInt(months, 100_000)) return { ok: false, error: 'range' };
  const durationCost = product(months, pricing.monthRate);
  const extraDevices = Math.max(0, selection.deviceCount - 1);
  const deviceCost = product(extraDevices, pricing.deviceRate);
  if (volumeCost === null || durationCost === null || deviceCost === null) {
    return { ok: false, error: 'overflow' };
  }
  const total = volumeCost + durationCost + deviceCost;
  if (!Number.isSafeInteger(total)) return { ok: false, error: 'overflow' };

  return {
    ok: true,
    breakdown: {
      schema: 1,
      currency: pricing.currency,
      rates: {
        gb_rate: pricing.gbRate,
        month_rate: pricing.monthRate,
        device_rate: pricing.deviceRate,
        days_per_month: pricing.daysPerMonth,
      },
      volume_gb: selection.volumeGb,
      volume_cost: volumeCost,
      duration_days: selection.durationDays,
      months,
      duration_cost: durationCost,
      device_count: selection.deviceCount,
      extra_devices: extraDevices,
      device_cost: deviceCost,
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
  min_days: number;
  max_days: number;
  min_devices: number;
  max_devices: number;
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
