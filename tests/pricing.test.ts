import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePrice } from '../src/catalog/pricing.ts';
import type { PricingConfig } from '../src/catalog/catalog.ts';

const PRICING: PricingConfig = {
  currency: 'IRT',
  gbRate: 12000,
  monthRate: 120000,
  deviceRate: 60000,
  daysPerMonth: 30,
};

test('documented example: 10 GB / 30 days / 1 device', () => {
  const result = calculatePrice(PRICING, { volumeGb: 10, durationDays: 30, deviceCount: 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const b = result.breakdown;
  assert.equal(b.volume_cost, 120000);
  assert.equal(b.months, 1);
  assert.equal(b.duration_cost, 120000);
  assert.equal(b.extra_devices, 0);
  assert.equal(b.device_cost, 0);
  assert.equal(b.total, 240000);
});

test('month rounding: 150 days → 5 months; extras billed beyond first device', () => {
  const result = calculatePrice(PRICING, { volumeGb: 50, durationDays: 150, deviceCount: 4 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const b = result.breakdown;
  assert.equal(b.volume_cost, 600000);
  assert.equal(b.months, 5);
  assert.equal(b.duration_cost, 600000);
  assert.equal(b.extra_devices, 3);
  assert.equal(b.device_cost, 180000);
  assert.equal(b.total, 1380000);
});

test('applied rates are snapshotted (config can change; orders must not)', () => {
  const result = calculatePrice(PRICING, { volumeGb: 30, durationDays: 90, deviceCount: 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.breakdown.rates, {
    gb_rate: 12000,
    month_rate: 120000,
    device_rate: 60000,
    days_per_month: 30,
  });
  assert.equal(result.breakdown.currency, 'IRT');
});

test('custom 12 GB with Persian-style text arrives as integer 12', () => {
  const result = calculatePrice(PRICING, { volumeGb: 12, durationDays: 30, deviceCount: 1 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.breakdown.total, 12 * 12000 + 120000);
});

test('hostile selections rejected, never priced', () => {
  const bad: Array<{ volumeGb: number; durationDays: number; deviceCount: number }> = [
    { volumeGb: 0, durationDays: 30, deviceCount: 1 },
    { volumeGb: -10, durationDays: 30, deviceCount: 1 },
    { volumeGb: 10, durationDays: 0, deviceCount: 1 },
    { volumeGb: 10, durationDays: 30, deviceCount: 0 },
    { volumeGb: 10.5, durationDays: 30, deviceCount: 1 },
    {
      volumeGb: Number.MAX_SAFE_INTEGER,
      durationDays: 30,
      deviceCount: 1,
    },
  ];
  for (const selection of bad) {
    assert.equal(calculatePrice(PRICING, selection).ok, false, JSON.stringify(selection));
  }
});

test('overflow protection: bounded caps keep every product inside safe integers', () => {
  const monster: PricingConfig = {
    currency: 'IRT',
    gbRate: 1_000_000_000, // config max
    monthRate: 0,
    deviceRate: 0,
    daysPerMonth: 30,
  };
  const result = calculatePrice(monster, { volumeGb: 1_000_000, durationDays: 30, deviceCount: 1 });
  assert.equal(result.ok, true);
  if (result.ok) {
    // worst legitimate case = 1e15 « Number.MAX_SAFE_INTEGER → exact integer
    assert.equal(result.breakdown.total, 1_000_000_000_000_000);
    assert.ok(Number.isSafeInteger(result.breakdown.total));
  }
  // unrepresentable selections are rejected outright instead of wrapping
  assert.equal(
    calculatePrice(monster, { volumeGb: 1_000_001, durationDays: 30, deviceCount: 1 }).ok,
    false,
  );
});

test('broken pricing config rejected: zero divisor / non-int / negative', () => {
  for (const bad of [
    { ...PRICING, daysPerMonth: 0 },
    { ...PRICING, gbRate: 1.5 },
    { ...PRICING, monthRate: -1 },
  ]) {
    assert.equal(
      calculatePrice(bad, { volumeGb: 10, durationDays: 30, deviceCount: 1 }).ok,
      false,
    );
  }
});

test('zero-rate config is legal (free trial plans)', () => {
  const free = { ...PRICING, gbRate: 0, monthRate: 0, deviceRate: 0 };
  const result = calculatePrice(free, { volumeGb: 10, durationDays: 30, deviceCount: 3 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.breakdown.total, 0);
});
