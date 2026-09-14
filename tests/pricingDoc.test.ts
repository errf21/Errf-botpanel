/**
 * Phase 12 units: the settings-document edit layer (tokens, boundaries,
 * canonical round trip) and the catalog↔pricing coverage invariant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCatalog,
  parsePricing,
  pricingCoverageError,
  type DeviceCatalog,
  type DurationCatalog,
  type PricingConfig,
  type VolumeCatalog,
} from '../src/catalog/catalog.ts';
import {
  applyPricingEdit,
  pricingFields,
  renderPricingDoc,
} from '../src/catalog/pricingDoc.ts';
import { parsePricingAmount, parsePricingCallback, isValidCallbackData } from '../src/lib/validate.ts';
import { freshDb, makeD1Shim } from './helpers.ts';

const PRICING: PricingConfig = {
  currency: 'IRT',
  daysPerMonth: 30,
  baseGb: 10,
  baseProductPrice: 45000,
  pricePerGb: 4500,
  durationPrices: { 2: 80000, 3: 110000 },
  userPrices: { 1: 0, 2: 25000, 3: 50000 },
};

const volume: VolumeCatalog = {
  minGb: 10,
  maxGb: 500,
  allowCustom: true,
  presets: [{ gb: 10, enabled: true }, { gb: 50, enabled: true }],
};
const duration: DurationCatalog = {
  minDays: 30,
  maxDays: 90,
  allowCustom: false,
  presets: [
    { days: 30, enabled: true },
    { days: 60, enabled: true },
    { days: 90, enabled: true },
    { days: 180, enabled: false }, // disabled presets need NO price
  ],
};
const device: DeviceCatalog = {
  minCount: 1,
  maxCount: 3,
  allowCustom: false,
  presets: [{ count: 1, enabled: true }, { count: 3, enabled: true }],
};

test('pricingFields: dynamic list — base, gb, then every duration/user entry', () => {
  const tokens = pricingFields(PRICING).map((f) => `${f.kind}:${f.token}`);
  assert.deepEqual(tokens, [
    'base:base',
    'gb:gb',
    'duration:d2',
    'duration:d3',
    'users:u1',
    'users:u2',
    'users:u3',
  ]);
});

test('applyPricingEdit: edits ANY existing entry, value-only, round-trips parseable', () => {
  const edit = applyPricingEdit(PRICING, 'd3', 120000);
  assert.equal(edit.ok, true);
  if (!edit.ok) return;
  assert.equal(edit.updated.durationPrices[3], 120000);
  const reparsed = parsePricing(JSON.parse(renderPricingDoc(edit.updated)));
  assert.equal(reparsed.ok, true);
  if (reparsed.ok) assert.deepEqual(reparsed.value, edit.updated);
});

test('applyPricingEdit: boundaries per field kind, nothing else changes', () => {
  assert.equal(applyPricingEdit(PRICING, 'base', 0).ok, false); // base positive
  assert.equal(applyPricingEdit(PRICING, 'gb', 0).ok, false); // per-GB positive
  assert.equal(applyPricingEdit(PRICING, 'base', 44000).ok, true);
  const zeroAddOn = applyPricingEdit(PRICING, 'u3', 0);
  assert.equal(zeroAddOn.ok, true);

  const forged = applyPricingEdit(PRICING, 'u77', 5);
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.error, 'field_unknown');
  // no new keys, no renames: editing is value-only
  assert.equal(applyPricingEdit(PRICING, 'daysPerMonth', 31).ok, false);
  assert.equal(applyPricingEdit(PRICING, 'currency', 'Toman'.length).ok, false);
  for (const bad of [-1, 1_000_000_001, 4500.5, Number.NaN, '45000', null]) {
    assert.equal(applyPricingEdit(PRICING, 'base', bad as never).ok, false, String(bad));
  }
});

test('coverage: every reachable purchase choice must carry an admin price', () => {
  assert.equal(pricingCoverageError({ volume, duration, device }, PRICING), null);

  // enabled 6-month preset without a duration_prices["6"] entry
  const longLadder: DurationCatalog = {
    ...duration,
    maxDays: 180,
    presets: [...duration.presets, { days: 180, enabled: true }],
  };
  assert.equal(
    pricingCoverageError({ volume, duration: longLadder, device }, PRICING),
    'pricing:duration_unpriced',
  );
  // custom durations allowed but only whole priced months can exist
  assert.equal(
    pricingCoverageError(
      { volume, duration: { ...duration, allowCustom: true }, device },
      PRICING,
    ) !== null,
    true,
  );
  // a device preset (or the allowed custom range) with no user price
  assert.equal(
    pricingCoverageError(
      { volume, duration, device: { ...device, maxCount: 4, presets: [...device.presets, { count: 4, enabled: true }] } },
      PRICING,
    ),
    'pricing:user_unpriced',
  );
  // custom device counts: EVERY count in the allowed range must be priced
  assert.equal(
    pricingCoverageError(
      { volume, duration, device: { ...device, maxCount: 4, allowCustom: true } },
      PRICING,
    ),
    'pricing:user_unpriced', // range 1..4 but only 1..3 have entries
  );
  assert.equal(
    pricingCoverageError(
      { volume, duration, device: { ...device, maxCount: 4, allowCustom: true } },
      { ...PRICING, userPrices: { 1: 0, 2: 25000, 3: 50000, 4: 60000 } },
    ),
    null, // range fully covered by entries
  );
  // selling less GB than the base product includes is a contradiction
  assert.equal(
    pricingCoverageError({ volume: { ...volume, minGb: 5 }, duration, device }, PRICING),
    'pricing:base_below_min',
  );
  // days not divisible by days_per_month can never name a month entry
  assert.equal(
    pricingCoverageError(
      { volume, duration: { ...duration, minDays: 28, maxDays: 28, presets: [{ days: 28, enabled: true }] }, device },
      { ...PRICING, daysPerMonth: 28 },
    ),
    null, // 28 days = month 1 at the new divisor → the base price covers it
  );
  assert.equal(
    pricingCoverageError(
      { volume, duration: { ...duration, minDays: 25, maxDays: 90, presets: [{ days: 25, enabled: true }, ...duration.presets] }, device },
      PRICING,
    ),
    'pricing:duration_unmapped',
  );
});

test('loadCatalog (real docs, real SQL): coherent seed passes, broken user table fails closed', async () => {
  const sqlite = freshDb();
  const db = makeD1Shim(sqlite) as never;
  assert.equal((await loadCatalog(db)).ok, true);

  // Drop the user price for 6..10 while device allow_custom stays ON (0003/seed
  // keeps it on): exactly the contradictory state coverage must refuse.
  sqlite
    .prepare(`UPDATE settings SET value = json_remove(value, '$.user_prices."6"') WHERE key = 'pricing'`)
    .run();
  const broken = await loadCatalog(db);
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.ok(broken.error.startsWith('pricing:'), broken.error);
});

test('parsePricingAmount: Persian/Arabic digits + separators, safe bound', () => {
  assert.equal(parsePricingAmount('45000'), 45000);
  assert.equal(parsePricingAmount('۴۵٬۰۰۰'), 45000);
  assert.equal(parsePricingAmount('٤٥٬٠٠٠'), 45000);
  assert.equal(parsePricingAmount(' 1,000,000,000 '), 1_000_000_000);
  assert.equal(parsePricingAmount('0'), 0);
  assert.equal(parsePricingAmount('-1000'), null);
  assert.equal(parsePricingAmount('1000.5'), null);
  assert.equal(parsePricingAmount('۴۵هزار'), null);
  assert.equal(parsePricingAmount('1'.repeat(13)), null); // overlong
  assert.equal(parsePricingAmount('9999999999999'), null); // > 1e9
});

test('pricing callbacks: strict tokens; prc:* never leaks to other routers', () => {
  assert.deepEqual(parsePricingCallback('prc:menu'), { action: 'menu' });
  assert.deepEqual(parsePricingCallback('prc:ok'), { action: 'ok' });
  assert.deepEqual(parsePricingCallback('prc:no'), { action: 'no' });
  assert.deepEqual(parsePricingCallback('prc:e_d2'), { action: 'edit', token: 'd2' });
  assert.deepEqual(parsePricingCallback('prc:e_u10'), { action: 'edit', token: 'u10' });
  assert.deepEqual(parsePricingCallback('prc:e_base'), { action: 'edit', token: 'base' });
  for (const bad of [
    'prc:', 'prc:evil', 'prc:ok:45000', 'prc:e_D2', 'prc:e_-1', 'prc:E_BASE',
    'prc:e_', 'prc:menu|rm -rf', 'prc:e_base=5', // values NEVER ride on buttons
  ]) {
    assert.equal(parsePricingCallback(bad), null, bad);
  }
  // every button we generate also passes the general callback gate
  assert.equal(isValidCallbackData('prc:e_u10'), true);
  assert.equal(isValidCallbackData('prc:ok'), true);
});
