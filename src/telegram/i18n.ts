/**
 * Phase 10: the ONE localization boundary.
 *
 * A `Ui` bundles the locale, its text (`Texts`) and its formatters (`Fmt`).
 * Handlers and keyboards receive a `Ui` and never branch on language — the
 * only language switch in the codebase is `uiFor()` below.
 *
 * Resolution rule (Phase 10 decision): Persian is the default for EVERYONE.
 * English activates only through an explicit in-bot selection persisted in
 * `customers.language`. Telegram's `language_code` is stored for display on
 * the Account screen and NEVER selects a language.
 */
import { fa, durationLabelFa, formatPrice } from './texts.ts';
import type { Texts } from './texts.ts';
import { en } from './texts.en.ts';

export type Locale = 'fa' | 'en';

export const DEFAULT_LOCALE: Locale = 'fa';

/** Explicit choice wins; anything else (NULL, junk) is Persian. */
export function resolveLocale(language: unknown): Locale {
  return language === 'en' ? 'en' : 'fa';
}

export interface Fmt {
  /** Locale digits for a whole/decimal number or numeric string (display only). */
  digits(value: number | string): string;
  /** Money with thousands grouping + currency word. */
  price(amount: number, currency: string): string;
  /** Date-only display from an ISO string (repo displays UTC). */
  date(iso: string): string;
  /** Date + HH:MM display from an ISO string. */
  dateTime(iso: string): string;
  /** Duration days → «X ماه» / "2 months" (whole months read as months). */
  duration(days: number, daysPerMonth?: number): string;
  /** Volume option button label (fa keeps today's ASCII digits + گیگ). */
  volumeOption(gb: number): string;
  /** Device option button label (en pluralizes: "1 device"). */
  deviceOption(count: number): string;
  /** Whole-days phrase for notice bodies ("3 روز" / "3 days"). */
  dayCount(days: number): string;
  /** Time-left phrase for the expiry notice (bounded by the 3-day window). */
  remainingUntil(expiresIso: string, nowMs: number): string;
}

const fmtFa: Fmt = {
  digits: (v) => String(v),
  price: (amount, currency) => formatPrice(amount, currency),
  // Display-only, locale-neutral digits (user ruling: no Persian digits in UI).
  date: (iso) => iso.slice(0, 10),
  dateTime: (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`,
  duration: (days, perMonth) => durationLabelFa(days, perMonth),
  volumeOption: (gb) => `${gb} گیگ`,
  deviceOption: (count) => `${count} دستگاه`,
  dayCount: (days) => `${days} روز`,
  remainingUntil: (expiresIso, nowMs) => {
    const diff = Date.parse(expiresIso) - nowMs;
    const totalHours = Math.max(0, Math.floor(diff / 3_600_000));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    if (days > 0 && hours > 0) return `${days} روز و ${hours} ساعت`;
    if (days > 0) return `${days} روز`;
    if (hours > 0) return `${hours} ساعت`;
    return 'کمتر از یک ساعت';
  },
};

const enPlural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

const fmtEn: Fmt = {
  digits: (v) => String(v),
  price: (amount, currency) => {
    const word = currency === 'IRT' ? 'Toman' : currency === 'IRR' ? 'Rials' : currency;
    return `${amount.toLocaleString('en-US')} ${word}`;
  },
  date: (iso) => iso.slice(0, 10),
  dateTime: (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`,
  duration: (days, daysPerMonth = 30) => {
    const months = daysPerMonth > 0 ? days / daysPerMonth : NaN;
    if (Number.isSafeInteger(months) && months >= 1) return enPlural(months, 'month', 'months');
    return enPlural(days, 'day', 'days');
  },
  volumeOption: (gb) => `${gb} GB`,
  deviceOption: (count) => enPlural(count, 'device', 'devices'),
  dayCount: (days) => enPlural(days, 'day', 'days'),
  remainingUntil: (expiresIso, nowMs) => {
    const diff = Date.parse(expiresIso) - nowMs;
    const totalHours = Math.max(0, Math.floor(diff / 3_600_000));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    if (days > 0 && hours > 0) return `${enPlural(days, 'day', 'days')} ${enPlural(hours, 'hour', 'hours')}`;
    if (days > 0) return enPlural(days, 'day', 'days');
    if (hours > 0) return enPlural(hours, 'hour', 'hours');
    return 'under an hour';
  },
};

export interface Ui {
  locale: Locale;
  t: Texts;
  f: Fmt;
}

const UI: Record<Locale, Ui> = {
  fa: { locale: 'fa', t: fa as Texts, f: fmtFa },
  en: { locale: 'en', t: en, f: fmtEn },
};

// `fa as Texts` is the type-only widening for the registry above.

/** The Persian bundle — default everywhere, and the ONLY locale the admin
 *  operational surface ever renders in (operator decision, Phase 10). */
export const FA_UI: Ui = UI.fa;
/** The English bundle — reachable ONLY through an explicit user choice. */
export const EN_UI: Ui = UI.en;

/** The (near-)only language branch in the codebase. */
export function uiFor(language: unknown): Ui {
  return UI[resolveLocale(language)];
}

/** The bot's own language name for the Account screen. */
export function localeName(ui: Ui): string {
  return ui.locale === 'en' ? ui.t.accountLanguageEn : ui.t.accountLanguageFa;
}
