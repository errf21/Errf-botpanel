/**
 * Phase 10 unit tests: the localization boundary itself.
 * No DB, no network — contract, resolution, formatting and routing safety.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fa } from '../src/telegram/texts.ts';
import type { Texts } from '../src/telegram/texts.ts';
import { en } from '../src/telegram/texts.en.ts';
import { DEFAULT_LOCALE, EN_UI, FA_UI, resolveLocale, uiFor } from '../src/telegram/i18n.ts';
import {
  CB,
  MAIN_MENU_ENTRIES,
  mainMenuEntries,
  matchStepText,
  menuCallbackForText,
  routeCallback,
} from '../src/telegram/menu.ts';
import { isValidCallbackData } from '../src/lib/validate.ts';

const PERSIAN = /[\u0600-\u06FF\u200C\u200D]/;
/** Leaves that are LOCALE-FIXED (same text in both bundles, on purpose). */
const LOCALE_FIXED_KEYS = new Set([
  'menuLanguage',
  'langOptionFa',
  // Phase 11: brand labels on the guide's official-link buttons.
  'guideBtnPlay',
  'guideBtnStore',
  'guideBtnGithub',
  'guideBtnReleases',
]);

/* ———— structural contract ———— */

test('en mirrors fa EXACTLY: same keys, same value kinds', () => {
  const faKeys = Object.keys(fa).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, faKeys, 'English bundle must mirror the Persian key set');
  for (const key of faKeys) {
    const faValue = (fa as Record<string, unknown>)[key];
    const enValue = (en as Record<string, unknown>)[key];
    assert.equal(
      typeof enValue,
      typeof faValue,
      `key "${key}" must be the same kind in both bundles`,
    );
  }
});

test('English copy is actually English (locale-fixed selector buttons excepted)', () => {
  (Object.keys(en) as (keyof Texts)[]).forEach((key) => {
    if (LOCALE_FIXED_KEYS.has(key)) return;
    const value = (en as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      assert.equal(PERSIAN.test(value), false, `en.${key} must not contain Persian text`);
    }
  });
});

test('locale-fixed selector values are byte-identical across bundles', () => {
  for (const key of LOCALE_FIXED_KEYS) {
    assert.equal(
      (en as Record<string, unknown>)[key],
      (fa as Record<string, unknown>)[key],
      `${key} must be the same constant in both locales`,
    );
  }
});

test('English leaves used in HTML bubbles carry no raw markup specials', () => {
  // Values inside these keys' interpolations are escaped at the call site;
  // the (en) static text itself must never introduce < > (Telegram HTML).
  const htmlKeys = [
    'paymentInstructionsHeader', 'paymentHolder', 'paymentCard', 'paymentIban',
    'paymentAmountLine', 'paymentReceiptPrompt', 'paymentCopyHint', 'copyHint',
    'svcLink', 'svcOpenPage', 'svcPageNote', 'svcRemaining',
  ] as const;
  for (const key of htmlKeys) {
    const value = (en as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      assert.equal(/[<>]/.test(value), false, `en.${key} must stay markup-free`);
    }
  }
});

/* ———— bundle mapper behavior (moved switches) ———— */

test('orderStatus: every lifecycle state maps in BOTH bundles, unknown passes raw', () => {
  const states = [
    'pending_payment', 'awaiting_review', 'approved', 'provisioning',
    'completed', 'rejected', 'failed', 'cancelled',
  ];
  for (const t of [fa, en]) {
    for (const s of states) {
      assert.notEqual(t.orderStatus(s), s, `${s} must map`);
      assert.ok(t.orderStatus(s).length > 0);
    }
    assert.equal(t.orderStatus('future_state'), 'future_state', 'raw fallback preserved');
  }
});

test('panelStatus/walletKind: known values map, hostile values are capped raw', () => {
  assert.equal(fa.panelStatus('limited'), fa.svcPanelLimited);
  assert.equal(en.panelStatus('limited'), en.svcPanelLimited);
  assert.equal(en.panelStatus('x'.repeat(40)), 'x'.repeat(24));
  assert.equal(fa.walletKind('referral_reward'), fa.walletKindReferralReward);
  assert.equal(en.walletKind('order_refund'), en.walletKindOrderRefund);
  assert.equal(en.walletKind('weird_kind'), 'weird_kind', 'unknown kind passes raw (capped)');
});

test('fa bundle methods reproduce the pre-Phase-10 exports byte-for-byte', async () => {
  const texts = await import('../src/telegram/texts.ts');
  assert.equal(fa.reactionDevices(3), texts.deviceReaction(3));
  assert.equal(fa.reactionVolume(30), texts.volumeReaction(30));
  assert.equal(fa.reactionDevices(1), null);
  assert.equal(fa.reactionVolume(20), null);
});

test('en reactions are native, never null-flooded, and Persian-free', () => {
  assert.equal(en.reactionDevices(1), null);
  assert.match(String(en.reactionDevices(2)), /\S/);
  assert.equal(PERSIAN.test(String(en.reactionDevices(9))), false);
  assert.equal(en.reactionVolume(10), null);
  assert.equal(en.reactionVolume(20), null, 'same generosity threshold as fa');
  assert.ok(en.reactionVolume(30));
});

/* ———— resolution ———— */

test('resolveLocale: ONLY explicit "en" selects English; everything else is fa', () => {
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(resolveLocale('fa'), 'fa');
  assert.equal(resolveLocale(null), DEFAULT_LOCALE, 'no explicit choice → Persian');
  assert.equal(resolveLocale(undefined), 'fa');
  assert.equal(resolveLocale('de'), 'fa', 'no Telegram-hint auto-detection, ever');
  assert.equal(resolveLocale('EN'), 'fa', 'values are stored lowercase; junk never switches');
  assert.equal(resolveLocale('english'), 'fa');
});

test('uiFor returns the registry singletons', () => {
  assert.equal(uiFor('en'), EN_UI);
  assert.equal(uiFor(null), FA_UI);
  assert.equal(uiFor('anything'), FA_UI);
  assert.equal(FA_UI.t, fa);
  assert.equal(EN_UI.t, en);
});

/* ———— formatters ———— */

test('money: fa keeps formatPrice byte-for-byte; en groups ASCII with words', async () => {
  const { formatPrice } = await import('../src/telegram/texts.ts');
  assert.equal(FA_UI.f.price(12500000, 'IRT'), formatPrice(12500000, 'IRT'));
  assert.equal(EN_UI.f.price(12500000, 'IRT'), '12,500,000 Toman');
  assert.equal(EN_UI.f.price(500, 'IRR'), '500 Rials');
  assert.equal(EN_UI.f.price(7, 'SAT'), '7 SAT', 'unknown currency passes the word raw');
});

test('dates: fa keeps raw ISO (ASCII digits), en is ISO + UTC label', () => {
  const iso = '2026-09-14T08:30:00.000Z';
  assert.equal(FA_UI.f.date(iso), iso.slice(0, 10));
  assert.equal(EN_UI.f.date(iso), '2026-09-14');
  assert.equal(EN_UI.f.dateTime(iso), '2026-09-14 08:30 UTC');
  assert.equal(FA_UI.f.dateTime(iso), `${iso.slice(0, 10)} ${iso.slice(11, 16)}`);
});

test('duration/volume/device labels: fa byte-compatible, en pluralized', () => {
  assert.equal(FA_UI.f.duration(30), '1 ماه');
  assert.equal(FA_UI.f.duration(90), '3 ماه');
  assert.equal(FA_UI.f.duration(45), '45 روز');
  assert.equal(EN_UI.f.duration(30), '1 month');
  assert.equal(EN_UI.f.duration(90), '3 months');
  assert.equal(EN_UI.f.duration(45), '45 days');
  assert.equal(FA_UI.f.volumeOption(10), '10 گیگ');
  assert.equal(EN_UI.f.volumeOption(10), '10 GB');
  assert.equal(FA_UI.f.deviceOption(2), '2 دستگاه');
  assert.equal(EN_UI.f.deviceOption(1), '1 device');
  assert.equal(EN_UI.f.deviceOption(4), '4 devices');
});

test('remainingUntil mirrors the Phase 9 fa shapes and gives English its own', () => {
  const base = Date.UTC(2026, 0, 1, 12);
  const isoIn = (ms: number) => new Date(base + ms).toISOString();
  const digits = (v: number | string) => FA_UI.f.digits(v);
  assert.equal(
    FA_UI.f.remainingUntil(isoIn(86_400_000 + 3_600_000), base),
    `${digits(1)} روز و ${digits(1)} ساعت`,
  );
  assert.equal(FA_UI.f.remainingUntil(isoIn(40_000), base), 'کمتر از یک ساعت');
  assert.equal(EN_UI.f.remainingUntil(isoIn(86_400_000 + 3_600_000), base), '1 day 1 hour');
  assert.equal(EN_UI.f.remainingUntil(isoIn(2 * 86_400_000), base), '2 days');
  assert.equal(EN_UI.f.remainingUntil(isoIn(5 * 3_600_000), base), '5 hours');
  assert.equal(EN_UI.f.remainingUntil(isoIn(-86_400_000), base), 'under an hour');
});

/* ———— cross-locale keyboard routing ———— */

test('menuCallbackForText resolves labels from BOTH locales to the same callbacks', () => {
  assert.equal(menuCallbackForText('🛒 خرید سرویس'), CB.MENU_BUY);
  assert.equal(menuCallbackForText('🛒 Buy a service'), CB.MENU_BUY);
  assert.equal(menuCallbackForText('🤝 دعوت از دوستان'), CB.MENU_INVITE);
  assert.equal(menuCallbackForText('🤝 Invite friends'), CB.MENU_INVITE);
  assert.equal(menuCallbackForText('🌐 زبان / Language'), CB.MENU_LANGUAGE);
  assert.equal(menuCallbackForText('not a button'), null);
});

test('matchStepText resolves back/auto/skip in BOTH locales', () => {
  assert.equal(matchStepText('🔙 بازگشت به منو'), 'back');
  assert.equal(matchStepText('🔙 Back to menu'), 'back');
  assert.equal(matchStepText('🎲 انتخاب خودکار'), 'auto');
  assert.equal(matchStepText('🎲 Auto-pick'), 'auto');
  assert.equal(matchStepText('❌ ثبت رد بدون دلیل'), 'skip');
  assert.equal(matchStepText('❌ Reject without reason'), 'skip');
  assert.equal(matchStepText('hello'), null);
});

test('NO text-routed label collides across locales (one text never means two buttons)', () => {
  // Scope: every label that can arrive as TEXT (reply keyboards) — the union
  // routing table must be a function label→ONE target.
  const targets = new Map<string, string>();
  const put = (label: string, target: string) => {
    const prev = targets.get(label);
    if (prev !== undefined) {
      assert.equal(prev, target, `label "${label}" routes to both "${prev}" and "${target}"`);
    }
    targets.set(label, target);
  };
  for (const t of [FA_UI.t, EN_UI.t]) {
    const callbacks = [
      CB.MENU_BUY, CB.MENU_SERVICES, CB.MENU_ORDERS, CB.MENU_ACCOUNT,
      CB.MENU_WALLET, CB.MENU_INVITE, CB.MENU_SUPPORT, CB.MENU_TICKET,
      CB.MENU_GUIDE, CB.MENU_LANGUAGE,
    ] as const;
    const labels = [
      t.menuBuy, t.menuServices, t.menuOrders, t.menuAccount,
      t.menuWallet, t.menuInvite, t.menuSupport, t.menuTicket, t.menuGuide, t.menuLanguage,
    ];
    labels.forEach((label, i) => put(label, callbacks[i] ?? 'menu'));
    put(t.backToMenu, 'back');
    put(t.btnAutoPick, 'auto');
    put(t.btnSkipReject, 'skip');
  }
});

test('menu keyboard carries 10 entries: unstyled ticket+guide, locale-fixed selector last', () => {
  assert.equal(MAIN_MENU_ENTRIES.length, 10);
  // Support and Create-ticket are SEPARATE unstyled buttons (support never
  // opens the ladder; the ticket button never reads as it).
  assert.equal(MAIN_MENU_ENTRIES[6]?.callback, CB.MENU_SUPPORT);
  assert.equal(MAIN_MENU_ENTRIES[6]?.style, undefined);
  assert.equal(MAIN_MENU_ENTRIES[7]?.callback, CB.MENU_TICKET);
  assert.equal(MAIN_MENU_ENTRIES[7]?.style, undefined);
  // guide sits directly before the language button and stays unstyled.
  assert.equal(MAIN_MENU_ENTRIES[8]?.callback, CB.MENU_GUIDE);
  assert.equal(MAIN_MENU_ENTRIES[8]?.label, '📚 راهنمای اتصال');
  assert.equal(MAIN_MENU_ENTRIES[8]?.style, undefined);
  assert.equal(MAIN_MENU_ENTRIES[9]?.callback, CB.MENU_LANGUAGE);
  assert.equal(MAIN_MENU_ENTRIES[9]?.label, '🌐 زبان / Language');
  assert.equal(MAIN_MENU_ENTRIES[9]?.style, undefined);
  assert.equal(MAIN_MENU_ENTRIES.filter((e) => e.style !== undefined).length, 3);
});

/* ———— styled trio: locale can never move a colour ———— */

test('styled trio danger/primary/success is identical in fa and en', () => {
  const map = (t: Texts) => new Map(mainMenuEntries(t).map((e) => [e.callback, e.style]));
  const faStyles = map(FA_UI.t);
  const enStyles = map(EN_UI.t);
  assert.equal(faStyles.get(CB.MENU_BUY), 'danger');
  assert.equal(faStyles.get(CB.MENU_SERVICES), 'primary');
  assert.equal(faStyles.get(CB.MENU_WALLET), 'success');
  assert.deepEqual([...faStyles.entries()], [...enStyles.entries()], 'no per-locale style drift');
  assert.equal(
    new Set([faStyles.get(CB.MENU_BUY), faStyles.get(CB.MENU_SERVICES), faStyles.get(CB.MENU_WALLET)]).size,
    3,
    'three DISTINCT styles, no duplicate',
  );
  for (const [callback, style] of faStyles) {
    const styled = callback === CB.MENU_BUY || callback === CB.MENU_SERVICES || callback === CB.MENU_WALLET;
    assert.equal(style !== undefined, styled, `${callback} styling is exactly the trio`);
  }
});

test('lang callbacks pass the wire validator and the static allowlist', () => {
  for (const data of [CB.LANG_FA, CB.LANG_EN, CB.MENU_LANGUAGE]) {
    assert.equal(isValidCallbackData(data), true, data);
    assert.deepEqual(routeCallback(data), { kind: 'known', callback: data });
  }
  assert.equal(isValidCallbackData('lang:xx'), true, 'shape-valid…');
  assert.equal(routeCallback('lang:xx').kind, 'invalid', '…but not on the allowlist');
});
