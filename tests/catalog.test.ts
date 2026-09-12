import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptDevice,
  acceptDuration,
  acceptVolume,
  enabledDeviceCounts,
  enabledDurationDays,
  enabledVolumeGb,
  loadCatalog,
  parseDuration,
  parsePricing,
  parseVolume,
  type Catalog,
} from '../src/catalog/catalog.ts';
import { makeD1Shim, freshDb } from './helpers.ts';
import { loadPaymentInfo, parsePaymentInfo } from '../src/catalog/payment.ts';

const VOLUME_SEED = {
  schema: 1,
  min_gb: 10,
  max_gb: 500,
  allow_custom: true,
  presets: [
    { gb: 10, enabled: true },
    { gb: 30, enabled: false },
    { gb: 50, enabled: true },
  ],
};

const PRICING_SEED = {
  schema: 1,
  currency: 'IRT',
  gb_rate: 12000,
  month_rate: 120000,
  device_rate: 60000,
  days_per_month: 30,
};

test('parseVolume: valid doc, disabled preset, order preserved', () => {
  const result = parseVolume(VOLUME_SEED);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.minGb, 10);
  assert.deepEqual(result.value.presets.map((p) => p.gb), [10, 30, 50]);
  assert.deepEqual(enabledVolumeGb({
    volume: result.value,
    duration: null as never,
    device: null as never,
    pricing: null as never,
  } as Catalog), [10, 50]);
});

test('parseVolume: rejects wrong schema, missing fields, empty presets, dupes', () => {
  for (const bad of [
    {},
    null,
    [],
    'string',
    { ...VOLUME_SEED, schema: 2 },
    { ...VOLUME_SEED, min_gb: 600 }, // min > max
    { ...VOLUME_SEED, presets: [] },
    { ...VOLUME_SEED, presets: [{ gb: 10 }, { gb: 10 }] }, // duplicate
    { ...VOLUME_SEED, presets: Array.from({ length: 50 }, (_, i) => ({ gb: i + 1 })) }, // too many
    { ...VOLUME_SEED, presets: [{ gb: '10' }] },
  ]) {
    assert.equal(parseVolume(bad).ok, false, JSON.stringify(bad)?.slice(0, 40));
  }
});

test('parseDuration + parsePricing: valid and hostile shapes', () => {
  assert.equal(
    parseDuration({ schema: 1, min_days: 5, max_days: 365, allow_custom: true, presets: [{ days: 30 }] }).ok,
    true,
  );
  assert.equal(
    parseDuration({ schema: 1, min_days: 5, max_days: 365, presets: [{ days: -1 }] }).ok,
    false,
  );
  assert.equal(parsePricing(PRICING_SEED).ok, true);
  for (const bad of [
    { ...PRICING_SEED, currency: 'toman' }, // not ISO-like
    { ...PRICING_SEED, gb_rate: 12.5 }, // float rates rejected
    { ...PRICING_SEED, gb_rate: -1 },
    { ...PRICING_SEED, days_per_month: 0 },
    { ...PRICING_SEED, schema: 99 },
  ]) {
    assert.equal(parsePricing(bad).ok, false);
  }
});

test('acceptVolume: min 10 enforced, presets, custom rule, disabled preset exact', () => {
  const vol = parseVolume(VOLUME_SEED);
  assert.equal(vol.ok, true);
  if (!vol.ok) return;
  const catalog = {
    volume: vol.value,
    duration: { minDays: 1, maxDays: 999, allowCustom: true, presets: [{ days: 30, enabled: true }] },
    device: { minCount: 1, maxCount: 9, allowCustom: true, presets: [{ count: 1, enabled: true }] },
    pricing: PRICING_SEED,
  } as Catalog;

  assert.deepEqual(acceptVolume(catalog, 9), { ok: false, reason: 'range' }); // below MIN!
  assert.equal(acceptVolume(catalog, 10).ok, true);
  assert.equal(acceptVolume(catalog, 500).ok, true);
  assert.deepEqual(acceptVolume(catalog, 501), { ok: false, reason: 'range' });
  assert.deepEqual(acceptVolume(catalog, 30), { ok: false, reason: 'preset_disabled' });
  assert.equal(acceptVolume(catalog, 77).ok, true); // allowed custom
  assert.deepEqual(acceptVolume(catalog, 12.5), { ok: false, reason: 'range' });
  assert.deepEqual(acceptVolume(catalog, Number.MAX_SAFE_INTEGER), { ok: false, reason: 'range' });

  const noCustom = structuredClone(catalog);
  noCustom.volume.allowCustom = false;
  assert.deepEqual(acceptVolume(noCustom, 77), { ok: false, reason: 'custom_disabled' });
  assert.equal(acceptVolume(noCustom, 10).ok, true);

  assert.equal(acceptDuration(catalog, 30).ok, true);
  assert.equal(acceptDevice(catalog, 9999).ok, false); // out of any sensible bound? device max 9 → range
});

test('loadCatalog: reads all four settings rows from D1 (real SQL via shim)', async () => {
  const sqlite = freshDb(); // applies 0001+0002+0003 (0003 seeds real JSON docs)
  const db = makeD1Shim(sqlite) as never;
  const result = await loadCatalog(db);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.catalog.volume.minGb, 10);
  // Phase 6: duration seed = whole months (30/60/90), no 180/365 anymore.
  assert.deepEqual(enabledDurationDays(result.catalog), [30, 60, 90]);
  assert.equal(result.catalog.duration.allowCustom, false);
  assert.deepEqual(enabledDeviceCounts(result.catalog), [1, 3, 5]);
  assert.equal(result.catalog.pricing.currency, 'IRT');
  assert.equal(result.catalog.pricing.gbRate, 12000);
});

test('loadCatalog: degrades safely when config is broken', async () => {
  const sqlite = freshDb();
  // NOTE: settings.value has a json_valid CHECK — non-JSON cannot even be
  // written to D1. The catalog parser still degrades safely for valid-JSON
  // garbage / wrong schema (the realistic corruption path):
  sqlite.prepare("UPDATE settings SET value = '{\"garbage\": true}' WHERE key = 'pricing'").run();
  const broken = await loadCatalog(makeD1Shim(sqlite) as never);
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.ok(broken.error.startsWith('pricing'));

  sqlite.prepare("UPDATE settings SET value = '{\"schema\": 999}' WHERE key = 'pricing'").run();
  const partial = await loadCatalog(makeD1Shim(sqlite) as never);
  assert.equal(partial.ok, false);
});

// ————— Phase 4: payment_info document —————

test('loadPaymentInfo: seeded doc validates with iban null', async () => {
  const shim = makeD1Shim(freshDb());
  const result = await loadPaymentInfo(shim as unknown as Parameters<typeof loadPaymentInfo>[0]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.info.cardNumber, /^\d{16}$/);
    assert.equal(result.info.iban, null);
    assert.ok(result.info.holder.length > 0);
  }
});

test('parsePaymentInfo: rejects malformed/hostile docs', () => {
  assert.equal(parsePaymentInfo({ schema: 2, holder: 'a', card_number: '1234567890', instructions: 'x' }).ok, false);
  assert.equal(parsePaymentInfo({ schema: 1, holder: '', card_number: '1234567890', instructions: 'x' }).ok, false);
  assert.equal(parsePaymentInfo({ schema: 1, holder: 'a', card_number: 'rm -rf', instructions: 'x' }).ok, false);
  assert.equal(parsePaymentInfo({ schema: 1, holder: 'a', card_number: '1234567890', instructions: 'x', iban: 'bad iban!' }).ok, false);
  assert.equal(parsePaymentInfo('string').ok, false);
  assert.equal(
    parsePaymentInfo({ schema: 1, holder: 'a', card_number: '1234567890', instructions: 'x', iban: 'IR000000000000000000000000' }).ok,
    true,
  );
});
