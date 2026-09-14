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
/**
 * Phase 12 pricing model (settings doc schema 2):
 *
 *   total = time + volume + users
 *     time   = months == 1 ? baseProductPrice : durationPrices[months]
 *     volume = max(0, volume_gb - baseGb) * pricePerGb
 *     users  = userPrices[device_count]
 *
 * Every duration/user entry is an EXACT admin-defined number — no multipliers,
 * no months*rate arithmetic anywhere. dayPerMonth is purely the days<->months
 * unit bridge for the (day-based) catalog; it has no pricing meaning.
 */
export interface PricingConfig {
  currency: string;
  daysPerMonth: number;
  baseGb: number;
  baseProductPrice: number;
  pricePerGb: number;
  /** month count (2..12) -> exact price for that whole duration. */
  durationPrices: Record<number, number>;
  /** user count (1..1000) -> exact price for that count. */
  userPrices: Record<number, number>;
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

/** Phase 12: the pricing document lives on its own schema version. */
export const PRICING_SCHEMA = 2;
const MAX_DURATION_KEYS = 24;
const MAX_USER_KEYS = 1000;
const MAX_MONTHS = 12;

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

function parseIntKeyedTable(
  value: unknown,
  minKey: number,
  maxKey: number,
  maxEntries: number,
): Record<number, number> | null {
  const record = asRecord(value);
  if (!record) return null;
  const entries = Object.entries(record);
  // An EMPTY table is legal (a ladder selling only the 1-month base prices
  // nothing else); loadCatalog's coverage pass ties tables to the ladder.
  if (entries.length > maxEntries) return null;
  const out: Record<number, number> = {};
  for (const [rawKey, rawValue] of entries) {
    if (!/^[0-9]{1,4}$/.test(rawKey)) return null;
    const key = Number(rawKey);
    if (!Number.isSafeInteger(key) || key < minKey || key > maxKey) return null;
    const price = asInt(rawValue, 0, MAX_VALUE);
    if (price === null) return null;
    out[key] = price;
  }
  return out;
}

export function parsePricing(doc: unknown):
  | { ok: true; value: PricingConfig }
  | { ok: false; error: string } {
  const record = asRecord(doc);
  if (!record || record['schema'] !== PRICING_SCHEMA) {
    return { ok: false, error: 'pricing:schema' };
  }
  const currency = record['currency'];
  const daysPerMonth = asInt(record['days_per_month'], 1, 365);
  const base = asRecord(record['base_product']);
  const baseGb = base === null ? null : asInt(base['gb'], 1, 1_000_000_000);
  const baseProductPrice = base === null ? null : asInt(base['price'], 1, MAX_VALUE);
  const pricePerGb = asInt(record['price_per_gb'], 1, MAX_VALUE);
  // base_product.users/months are DECLARATIONS: the model defines the base as
  // "10GB + 1 user + 1 month"; the pricing rule hard-wires 1 user and 1 month
  // to base_product.price, so any other declaration is contradictory config.
  if (
    base === null ||
    asInt(base['users'], 1, MAX_VALUE) !== 1 ||
    asInt(base['months'], 1, MAX_VALUE) !== 1
  ) {
    return { ok: false, error: 'pricing:base_product' };
  }
  const durationPrices = parseIntKeyedTable(
    record['duration_prices'],
    2, // months == 1 IS base_product.price — a "1" entry would be a conflict
    MAX_MONTHS,
    MAX_DURATION_KEYS,
  );
  const userPrices = parseIntKeyedTable(record['user_prices'], 1, 1000, MAX_USER_KEYS);
  if (
    typeof currency !== 'string' ||
    !CURRENCY_PATTERN.test(currency) ||
    daysPerMonth === null ||
    baseGb === null ||
    baseProductPrice === null ||
    pricePerGb === null ||
    !durationPrices ||
    !userPrices
  ) {
    return { ok: false, error: 'pricing:fields' };
  }
  return {
    ok: true,
    value: {
      currency,
      daysPerMonth,
      baseGb,
      baseProductPrice,
      pricePerGb,
      durationPrices,
      userPrices,
    },
  };
}

/**
 * Cross-document coverage: every choice the LADDER can hand to the purchase
 * or renewal flow must be priced, or the config is contradictory and the
 * whole catalog degrades fail-closed (purchases must never die mid-ladder
 * on an unpriced tap). Returns a descriptive error code, or null when ok.
 */
export function pricingCoverageError(
  catalog: Omit<Catalog, 'pricing'>,
  pricing: PricingConfig,
): string | null {
  // Volume: nothing sold BELOW what the base price already includes.
  if (catalog.volume.minGb < pricing.baseGb) return 'pricing:base_below_min';

  const pricedMonths = new Set<number>(Object.keys(pricing.durationPrices).map(Number));
  const priceDurationDay = (days: number): string | null => {
    if (days % pricing.daysPerMonth !== 0) return 'pricing:duration_unmapped';
    const months = days / pricing.daysPerMonth;
    if (months === 1) return null; // covered by base_product.price
    if (months > MAX_MONTHS) return 'pricing:duration_unmapped';
    return pricedMonths.has(months) ? null : 'pricing:duration_unpriced';
  };
  for (const preset of catalog.duration.presets) {
    if (!preset.enabled) continue;
    const error = priceDurationDay(preset.days);
    if (error !== null) return error;
  }
  if (catalog.duration.maxDays - catalog.duration.minDays > 500) {
    return 'pricing:coverage_range';
  }
  if (catalog.duration.allowCustom) {
    for (let days = catalog.duration.minDays; days <= catalog.duration.maxDays; days += 1) {
      const error = priceDurationDay(days);
      if (error !== null) return error;
    }
  }

  const pricedUsers = new Set<number>(Object.keys(pricing.userPrices).map(Number));
  for (const preset of catalog.device.presets) {
    if (preset.enabled && !pricedUsers.has(preset.count)) return 'pricing:user_unpriced';
  }
  if (catalog.device.allowCustom) {
    if (catalog.device.maxCount - catalog.device.minCount > 50) return 'pricing:coverage_range';
    for (let count = catalog.device.minCount; count <= catalog.device.maxCount; count += 1) {
      if (!pricedUsers.has(count)) return 'pricing:user_unpriced';
    }
  }
  return null;
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

  // Phase 12: a priced ladder or nothing — every reachable choice must map to
  // an admin-defined number BEFORE any customer is allowed into the flow.
  const coverage = pricingCoverageError(
    { volume: volume.value, duration: duration.value, device: device.value },
    pricing.value,
  );
  if (coverage !== null) return { ok: false, error: coverage };

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
