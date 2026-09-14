import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePrice, calculateRenewalPrice, catalogLimits } from '../src/catalog/pricing.ts';
import type { PricingConfig } from '../src/catalog/catalog.ts';

/** Mirrors the 0011 seed shape (placeholders on purpose — values carry no
 *  meaning beyond pinning the EXACT-ENTRY arithmetic below). */
const PRICING: PricingConfig = {
  currency: 'IRT',
  daysPerMonth: 30,
  baseGb: 10,
  baseProductPrice: 45000,
  pricePerGb: 4500,
  durationPrices: { 2: 80000, 3: 110000 },
  userPrices: { 1: 0, 2: 25000, 3: 50000, 5: 60000, 10: 200000 },
};

test('base product (10GB / 1 month / 1 user): total = base price, exactly', () => {
  const result = calculatePrice(PRICING, { volumeGb: 10, durationDays: 30, deviceCount: 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const b = result.breakdown;
  assert.equal(b.extra_gb, 0);
  assert.equal(b.volume_cost, 0);
  assert.equal(b.months, 1);
  assert.equal(b.time_cost, 45000); // 1 month IS the base product price
  assert.equal(b.user_cost, 0);
  assert.equal(b.total, 45000);
});

test('durations are exact admin entries — 2 months is NOT 2 × 1 month', () => {
  const two = calculatePrice(PRICING, { volumeGb: 10, durationDays: 60, deviceCount: 1 });
  assert.equal(two.ok, true);
  if (two.ok) {
    assert.equal(two.breakdown.time_cost, 80000);
    assert.equal(two.breakdown.total, 80000);
    assert.notEqual(two.breakdown.total, 2 * 45000);
    assert.equal(two.breakdown.inputs.duration_key, 2);
  }
  const three = calculatePrice(PRICING, { volumeGb: 10, durationDays: 90, deviceCount: 1 });
  assert.equal(three.ok, true);
  if (three.ok) assert.equal(three.breakdown.total, 110000);
});

test('user counts are exact admin entries — no extra-user multiplier', () => {
  const u2 = calculatePrice(PRICING, { volumeGb: 10, durationDays: 30, deviceCount: 2 });
  assert.equal(u2.ok, true);
  if (u2.ok) assert.equal(u2.breakdown.total, 70000); // 45000 + 25000
  const u3 = calculatePrice(PRICING, { volumeGb: 10, durationDays: 30, deviceCount: 3 });
  assert.equal(u3.ok, true);
  if (u3.ok) assert.equal(u3.breakdown.total, 95000); // 45000 + 50000
});

test('volume component: only GB BEYOND the product base multiply', () => {
  const result = calculatePrice(PRICING, { volumeGb: 50, durationDays: 90, deviceCount: 5 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const b = result.breakdown;
  assert.equal(b.extra_gb, 40);
  assert.equal(b.volume_cost, 180000); // 40 × 4500
  assert.equal(b.time_cost, 110000);
  assert.equal(b.user_cost, 60000);
  assert.equal(b.total, 350000); // 110000 + 180000 + 60000
});

test('custom volume below the base still costs the base (extra is floored)', () => {
  // The LADDER never offers it (acceptVolume enforces min 10); the calculator
  // stays deterministic and never negative if a raw selection ever arrived.
  const result = calculatePrice(PRICING, { volumeGb: 5, durationDays: 30, deviceCount: 1 });
  assert.equal(result.ok, true);
  if (result.ok && result.breakdown.extra_gb === 0) assert.equal(result.breakdown.total, 45000);
});

test('applied inputs are snapshotted (config can change; orders must not)', () => {
  const result = calculatePrice(PRICING, { volumeGb: 12, durationDays: 30, deviceCount: 3 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.breakdown.schema, 2);
  assert.deepEqual(result.breakdown.inputs, {
    base_gb: 10,
    base_product_price: 45000,
    price_per_gb: 4500,
    duration_key: 'base', // 1 month — the base product priced it
    duration_price: 45000,
    user_count: 3,
    user_price: 50000,
    days_per_month: 30,
  });
  assert.equal(result.breakdown.currency, 'IRT');
});

test('unpriced or unmappable choices are refused, never approximated', () => {
  // 45 days: not a whole month with days_per_month 30
  assert.equal(
    calculatePrice(PRICING, { volumeGb: 10, durationDays: 45, deviceCount: 1 }).ok,
    false,
  );
  // 120 days = month 4: no admin entry → config gap, refuse (no fallback!)
  assert.equal(
    calculatePrice(PRICING, { volumeGb: 10, durationDays: 120, deviceCount: 1 }).ok,
    false,
  );
  // user count without an entry
  assert.equal(
    calculatePrice(PRICING, { volumeGb: 10, durationDays: 30, deviceCount: 11 }).ok,
    false,
  );
});

test('hostile selections rejected, never priced', () => {
  const bad: Array<{ volumeGb: number; durationDays: number; deviceCount: number }> = [
    { volumeGb: 0, durationDays: 30, deviceCount: 1 },
    { volumeGb: -10, durationDays: 30, deviceCount: 1 },
    { volumeGb: 10, durationDays: 0, deviceCount: 1 },
    { volumeGb: 10, durationDays: -30, deviceCount: 1 },
    { volumeGb: 10, durationDays: 1.5, deviceCount: 1 },
    { volumeGb: 10, durationDays: 30, deviceCount: 0 },
    { volumeGb: 10.5, durationDays: 30, deviceCount: 1 },
    {
      volumeGb: 10,
      durationDays: 30,
      deviceCount: Number.MAX_SAFE_INTEGER,
    },
  ];
  for (const selection of bad) {
    assert.equal(calculatePrice(PRICING, selection).ok, false, JSON.stringify(selection));
  }
});

test('bounded caps keep every legitimate monster inside safe integers', () => {
  const monster: PricingConfig = {
    ...PRICING,
    baseProductPrice: 1_000_000_000,
    pricePerGb: 1_000_000_000,
    durationPrices: { 2: 1_000_000_000 },
    userPrices: { 1: 1_000_000_000 },
  };
  const result = calculatePrice(monster, {
    volumeGb: 1_000_000,
    durationDays: 60,
    deviceCount: 1,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    // worst legitimate case 3e9 + 999_990 × 1e9 stays exact under 2^53
    assert.ok(Number.isSafeInteger(result.breakdown.total));
    assert.equal(result.breakdown.total, 1_000_000_000 + 999_990_000_000_000 + 1_000_000_000);
  }
  // unrepresentable selections are rejected outright instead of wrapping
  assert.equal(
    calculatePrice(monster, { volumeGb: 1_000_001, durationDays: 60, deviceCount: 1 }).ok,
    false,
  );
});

test('broken pricing config rejected: zero divisor / non-int / negative', () => {
  for (const bad of [
    { ...PRICING, daysPerMonth: 0 },
    { ...PRICING, pricePerGb: 1.5 },
    { ...PRICING, baseProductPrice: -1 },
  ]) {
    assert.equal(
      calculatePrice(bad as PricingConfig, { volumeGb: 10, durationDays: 30, deviceCount: 1 }).ok,
      false,
    );
  }
});

test('zero add-on entries are legal (duration/user 0 = included), base never is', () => {
  const incl: PricingConfig = {
    ...PRICING,
    durationPrices: { 2: 0, 3: 0 },
    userPrices: { 1: 0, 2: 0 },
    baseProductPrice: 10,
    pricePerGb: 10,
  };
  const result = calculatePrice(incl, { volumeGb: 999, durationDays: 60, deviceCount: 2 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.breakdown.total, (999 - 10) * 10 + 0 + 0);
});

/* ———— renewals: the SAME tables, time-only ———— */

test('renewal pricing: 1m renews at the base price; other months exact entries', async () => {
  for (const [days, months, total] of [[30, 1, 45000], [60, 2, 80000], [90, 3, 110000]] as const) {
    const r = calculateRenewalPrice(PRICING, { durationDays: days });
    assert.equal(r.ok, true);
    if (!r.ok) continue;
    assert.equal(r.breakdown.months, months);
    assert.equal(r.breakdown.total, total);
    assert.equal(r.breakdown.time_cost, total);
    assert.equal(r.breakdown.kind, 'renewal');
    assert.equal(r.breakdown.schema, 2);
  }
  const r60 = calculateRenewalPrice(PRICING, { durationDays: 60 });
  assert.equal(r60.ok, true);
  if (r60.ok) {
    assert.deepEqual(r60.breakdown.inputs, {
      base_product_price: 45000,
      duration_key: 2,
      duration_price: 80000,
      days_per_month: 30,
    });
  }
});

test('renewal guards: hostile/unpriced durations refused', () => {
  assert.equal(calculateRenewalPrice(PRICING, { durationDays: 0 }).ok, false);
  assert.equal(calculateRenewalPrice(PRICING, { durationDays: -5 }).ok, false);
  assert.equal(calculateRenewalPrice(PRICING, { durationDays: 1.5 }).ok, false);
  assert.equal(calculateRenewalPrice(PRICING, { durationDays: 45 }).ok, false); // unmappable
  assert.equal(calculateRenewalPrice(PRICING, { durationDays: 120 }).ok, false); // unpriced
});

test('catalogLimits still reads the LADDER, not the pricing doc', () => {
  const limits = catalogLimits({
    volume: { minGb: 10, maxGb: 500 },
    duration: { minDays: 30, maxDays: 90 },
    device: { minCount: 1, maxCount: 10 },
  });
  assert.deepEqual(limits, {
    min_gb: 10,
    max_gb: 500,
    min_devices: 1,
    max_devices: 10,
    min_days: 30,
    max_days: 90,
  });
});
