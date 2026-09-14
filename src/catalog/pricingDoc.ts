/**
 * Phase 12: the admin-side of the pricing document — pure functions, no DB,
 * no Telegram. A field token is the ONLY thing that crosses the UI/DB seam
 * ('base', 'gb', 'd<months>', 'u<count>'); the bot can never invent, rename or
 * drop entries — it edits values that already live in the settings document.
 * Every staged edit is re-validated against the FULL parser (round trip
 * render → parsePricing) before it may touch the database.
 */
import {
  parsePricing,
  PRICING_SCHEMA,
  type PricingConfig,
} from './catalog.ts';

export const PRICING_FIELD_BOUND = 1; // base price / per-GB: positive
export const PRICING_FIELD_OPEN = 0; // duration/user entries: 0 is legal
export const PRICING_MAX_VALUE = 1_000_000_000;

export type PricingFieldKind = 'base' | 'gb' | 'duration' | 'users';

/** One editable leaf of the live document, in display order. */
export interface PricingFieldView {
  token: string;
  kind: PricingFieldKind;
  /** Month count for duration fields, user count for users fields. */
  index: number | null;
  value: number;
}

function ascendingKeys(table: Record<number, number>): number[] {
  return Object.keys(table)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n))
    .sort((a, b) => a - b);
}

/** The dynamic field list rendered straight from the live config. */
export function pricingFields(pricing: PricingConfig): PricingFieldView[] {
  const fields: PricingFieldView[] = [
    { token: 'base', kind: 'base', index: null, value: pricing.baseProductPrice },
    { token: 'gb', kind: 'gb', index: null, value: pricing.pricePerGb },
  ];
  for (const months of ascendingKeys(pricing.durationPrices)) {
    fields.push({ token: `d${months}`, kind: 'duration', index: months, value: pricing.durationPrices[months]! });
  }
  for (const count of ascendingKeys(pricing.userPrices)) {
    fields.push({ token: `u${count}`, kind: 'users', index: count, value: pricing.userPrices[count]! });
  }
  return fields;
}

export type FieldError =
  | 'field_unknown' // forged or stale token (no longer present in the doc)
  | 'value_invalid'; // outside the field's own integer bounds

const fieldMinimumFor = (kind: PricingFieldKind): number =>
  kind === 'base' || kind === 'gb' ? PRICING_FIELD_BOUND : PRICING_FIELD_OPEN;

/** Validate a (token, value) pair against the CURRENT parsed config. */
export function applyPricingEdit(
  pricing: PricingConfig,
  token: string,
  value: unknown,
): { ok: true; updated: PricingConfig } | { ok: false; error: FieldError } {
  const amount = value;
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    amount > PRICING_MAX_VALUE
  ) {
    return { ok: false, error: 'value_invalid' };
  }
  const field = pricingFields(pricing).find((candidate) => candidate.token === token);
  if (!field) return { ok: false, error: 'field_unknown' };
  if (amount < fieldMinimumFor(field.kind)) {
    return { ok: false, error: 'value_invalid' };
  }

  const updated: PricingConfig = {
    ...pricing,
    durationPrices: { ...pricing.durationPrices },
    userPrices: { ...pricing.userPrices },
  };
  switch (field.kind) {
    case 'base':
      updated.baseProductPrice = amount;
      break;
    case 'gb':
      updated.pricePerGb = amount;
      break;
    case 'duration':
      updated.durationPrices[field.index!] = amount;
      break;
    case 'users':
      updated.userPrices[field.index!] = amount;
      break;
  }

  // Round trip through the real document parser: what applies must be exactly
  // what a cold boot would load (canonical form, no private-object drift).
  const parsed = parsePricing(JSON.parse(renderPricingDoc(updated)));
  if (!parsed.ok) return { ok: false, error: 'value_invalid' };
  return { ok: true, updated };
}

/** Canonical settings-row JSON for a config (sorted map keys, schema 2). */
export function renderPricingDoc(pricing: PricingConfig): string {
  const duration: Record<string, number> = {};
  for (const months of ascendingKeys(pricing.durationPrices)) {
    duration[String(months)] = pricing.durationPrices[months]!;
  }
  const users: Record<string, number> = {};
  for (const count of ascendingKeys(pricing.userPrices)) {
    users[String(count)] = pricing.userPrices[count]!;
  }
  return JSON.stringify({
    schema: PRICING_SCHEMA,
    currency: pricing.currency,
    days_per_month: pricing.daysPerMonth,
    base_product: { gb: pricing.baseGb, users: 1, months: 1, price: pricing.baseProductPrice },
    price_per_gb: pricing.pricePerGb,
    duration_prices: duration,
    user_prices: users,
  });
}
