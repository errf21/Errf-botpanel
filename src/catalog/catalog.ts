/**
 * Catalog: loads and validates the JSON configuration documents stored in the
 * D1 `settings` table (seeded by 0003). Nothing about the product catalog is
 * hardcoded in handlers; admins enable/disable/reorder options by editing
 * these rows. Any malformed/incompatible document degrades to a safe,
 * descriptive error instead of a crash or a silent default.
 */

export const CATALOG_SCHEMA = 1;

export type StepKind = 'volume' | 'duration' | 'device';

export interface VolumePreset {
  gb: number;
  enabled: boolean;
}
export interface DurationPreset {
  days: number;
  enabled: boolean;
}
export interface DevicePreset {
  count: number;
  enabled: boolean;
}

export interface VolumeCatalog {
  minGb: number;
  maxGb: number;
  allowCustom: boolean;
  presets: VolumePreset[];
}
export interface DurationCatalog {
  minDays: number;
  maxDays: number;
  allowCustom: boolean;
  presets: DurationPreset[];
}
export interface DeviceCatalog {
  minCount: number;
  maxCount: number;
  allowCustom: boolean;
  presets: DevicePreset[];
}
export interface PricingConfig {
  currency: string;
  gbRate: number;
  monthRate: number;
  deviceRate: number;
  daysPerMonth: number;
}

export interface Catalog {
  volume: VolumeCatalog;
  duration: DurationCatalog;
  device: DeviceCatalog;
  pricing: PricingConfig;
}

export type CatalogResult =
  | { ok: true; catalog: Catalog }
  | { ok: false; error: string };

/** Hard sanity caps so a runaway config can never produce absurd keyboards. */
const MAX_PRESETS = 20;
const MAX_VALUE = 1_000_000_000;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function schemaChecked(doc: unknown, key: string):
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; error: string } {
  const record = asRecord(doc);
  if (!record || record['schema'] !== CATALOG_SCHEMA) {
    return { ok: false, error: `${key}:schema` };
  }
  return { ok: true, record };
}

function presetList<T>(
  value: unknown,
  field: string,
  build: (num: number, enabled: boolean) => T,
): T[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PRESETS) {
    return null;
  }
  const seen = new Set<number>();
  const out: T[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) return null;
    const num = asInt(record[field], 1, MAX_VALUE);
    if (num === null || seen.has(num)) return null;
    seen.add(num);
    out.push(build(num, record['enabled'] !== false));
  }
  return out;
}

export function parseVolume(doc: unknown):
  | { ok: true; value: VolumeCatalog }
  | { ok: false; error: string } {
  const checked = schemaChecked(doc, 'volume_options');
  if (!checked.ok) return checked;
  const min = asInt(checked.record['min_gb'], 1, MAX_VALUE);
  const max = asInt(checked.record['max_gb'], 1, MAX_VALUE);
  const presets = presetList(
    checked.record['presets'],
    'gb',
    (gb, enabled) => ({ gb, enabled }),
  );
  if (min === null || max === null || max < min || !presets) {
    return { ok: false, error: 'volume_options:fields' };
  }
  return {
    ok: true,
    value: {
      minGb: min,
      maxGb: max,
      allowCustom: checked.record['allow_custom'] === true,
      presets,
    },
  };
}

export function parseDuration(doc: unknown):
  | { ok: true; value: DurationCatalog }
  | { ok: false; error: string } {
  const checked = schemaChecked(doc, 'duration_options');
  if (!checked.ok) return checked;
  const min = asInt(checked.record['min_days'], 1, MAX_VALUE);
  const max = asInt(checked.record['max_days'], 1, MAX_VALUE);
  const presets = presetList(
    checked.record['presets'],
    'days',
    (days, enabled) => ({ days, enabled }),
  );
  if (min === null || max === null || max < min || !presets) {
    return { ok: false, error: 'duration_options:fields' };
  }
  return {
    ok: true,
    value: {
      minDays: min,
      maxDays: max,
      allowCustom: checked.record['allow_custom'] === true,
      presets,
    },
  };
}

export function parseDevices(doc: unknown):
  | { ok: true; value: DeviceCatalog }
  | { ok: false; error: string } {
  const checked = schemaChecked(doc, 'device_options');
  if (!checked.ok) return checked;
  const min = asInt(checked.record['min_count'], 1, 1000);
  const max = asInt(checked.record['max_count'], 1, 1000);
  const presets = presetList(
    checked.record['presets'],
    'count',
    (count, enabled) => ({ count, enabled }),
  );
  if (min === null || max === null || max < min || !presets) {
    return { ok: false, error: 'device_options:fields' };
  }
  return {
    ok: true,
    value: {
      minCount: min,
      maxCount: max,
      allowCustom: checked.record['allow_custom'] === true,
      presets,
    },
  };
}

export function parsePricing(doc: unknown):
  | { ok: true; value: PricingConfig }
  | { ok: false; error: string } {
  const checked = schemaChecked(doc, 'pricing');
  if (!checked.ok) return checked;
  const currency = checked.record['currency'];
  const gbRate = asInt(checked.record['gb_rate'], 0, MAX_VALUE);
  const monthRate = asInt(checked.record['month_rate'], 0, MAX_VALUE);
  const deviceRate = asInt(checked.record['device_rate'], 0, MAX_VALUE);
  const daysPerMonth = asInt(checked.record['days_per_month'], 1, 365);
  if (
    typeof currency !== 'string' ||
    !CURRENCY_PATTERN.test(currency) ||
    gbRate === null ||
    monthRate === null ||
    deviceRate === null ||
    daysPerMonth === null
  ) {
    return { ok: false, error: 'pricing:fields' };
  }
  return {
    ok: true,
    value: { currency, gbRate, monthRate, deviceRate, daysPerMonth },
  };
}

/** Loads and validates all four config documents in one settings read. */
export async function loadCatalog(db: D1Database): Promise<CatalogResult> {
  let rows: { key: string; value: string }[];
  try {
    const result = await db
      .prepare(
        `SELECT key, value FROM settings
          WHERE key IN ('volume_options','duration_options','device_options','pricing')`,
      )
      .all<{ key: string; value: string }>();
    rows = result.results;
  } catch {
    return { ok: false, error: 'settings_unavailable' };
  }

  const map = new Map(rows.map((row) => [row.key, row.value]));
  const docs: Record<string, unknown> = {};
  for (const key of [
    'volume_options',
    'duration_options',
    'device_options',
    'pricing',
  ] as const) {
    const raw = map.get(key);
    if (raw === undefined) return { ok: false, error: `${key}:missing` };
    try {
      docs[key] = JSON.parse(raw);
    } catch {
      return { ok: false, error: `${key}:json` };
    }
  }

  const volume = parseVolume(docs['volume_options']);
  if (!volume.ok) return volume;
  const duration = parseDuration(docs['duration_options']);
  if (!duration.ok) return duration;
  const device = parseDevices(docs['device_options']);
  if (!device.ok) return device;
  const pricing = parsePricing(docs['pricing']);
  if (!pricing.ok) return pricing;

  return {
    ok: true,
    catalog: {
      volume: volume.value,
      duration: duration.value,
      device: device.value,
      pricing: pricing.value,
    },
  };
}

/* ---------------- choice validation (wire values are NEVER trusted) --------- */

export function enabledVolumeGb(catalog: Catalog): number[] {
  return catalog.volume.presets.filter((p) => p.enabled).map((p) => p.gb);
}
export function enabledDurationDays(catalog: Catalog): number[] {
  return catalog.duration.presets.filter((p) => p.enabled).map((p) => p.days);
}
export function enabledDeviceCounts(catalog: Catalog): number[] {
  return catalog.device.presets.filter((p) => p.enabled).map((p) => p.count);
}

export type ChoiceResult =
  | { ok: true }
  | { ok: false; reason: 'range' | 'preset_disabled' | 'custom_disabled' };

function acceptChoice(
  value: number,
  min: number,
  max: number,
  presets: Array<{ value: number; enabled: boolean }>,
  allowCustom: boolean,
): ChoiceResult {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { ok: false, reason: 'range' };
  }
  const preset = presets.find((p) => p.value === value);
  if (preset !== undefined) {
    return preset.enabled ? { ok: true } : { ok: false, reason: 'preset_disabled' };
  }
  return allowCustom ? { ok: true } : { ok: false, reason: 'custom_disabled' };
}

export function acceptVolume(catalog: Catalog, gb: number): ChoiceResult {
  return acceptChoice(
    gb,
    catalog.volume.minGb,
    catalog.volume.maxGb,
    catalog.volume.presets.map((p) => ({ value: p.gb, enabled: p.enabled })),
    catalog.volume.allowCustom,
  );
}

export function acceptDuration(catalog: Catalog, days: number): ChoiceResult {
  return acceptChoice(
    days,
    catalog.duration.minDays,
    catalog.duration.maxDays,
    catalog.duration.presets.map((p) => ({ value: p.days, enabled: p.enabled })),
    catalog.duration.allowCustom,
  );
}

export function acceptDevice(catalog: Catalog, count: number): ChoiceResult {
  return acceptChoice(
    count,
    catalog.device.minCount,
    catalog.device.maxCount,
    catalog.device.presets.map((p) => ({ value: p.count, enabled: p.enabled })),
    catalog.device.allowCustom,
  );
}
