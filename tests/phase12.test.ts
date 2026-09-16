/**
 * Phase 12 e2e: admin pricing management over the real dispatcher + SQLite.
 * Covers: admin gating (command / callbacks / forged payloads), the full
 * arm → type value → staged (server-side) → confirm → guarded apply flow,
 * garbage-keeps-arming semantics, TTL expiry, cross-admin CAS conflict,
 * the settings_audit trail, and — the mandatory one — pricing edits NEVER
 * touching already-created orders (purchase and renewal), while a fresh
 * draft re-prices at the new values. Existing ladder/checkout behavior on
 * the same DB proves purchase and renewal flows stay intact end to end.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  TEST_CARD,
  USER,
  callbackUpdateAs,
  freshDb,
  makeD1Shim,
  makeFetchStub,
  messageUpdate,
  messageUpdateAs,
} from './helpers.ts';
import { loadCatalog } from '../src/catalog/catalog.ts';
import { calculatePrice, calculateRenewalPrice } from '../src/catalog/pricing.ts';

const stub = makeFetchStub();
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const env = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  ADMIN_CHAT_ID: String(ADMIN.id),
  PAYMENT_CARD_NUMBER: TEST_CARD,
} as unknown as Parameters<typeof processTelegramUpdate>[1];

const dispatch = (update: unknown) => processTelegramUpdate(update, env);

let counter = 12000;
const nextId = () => ++counter;

function pricingDocRaw(): string {
  return (
    sqlite.prepare("SELECT value FROM settings WHERE key = 'pricing'").get() as { value: string }
  ).value;
}
interface PricingDocShape {
  price_per_gb: number;
  base_product: { price: number };
  duration_prices: Record<string, number>;
  user_prices: Record<string, number>;
}
function pricingJson(): PricingDocShape {
  return JSON.parse(pricingDocRaw()) as PricingDocShape;
}
function sendTexts(chatId: number): string[] {
  return stub.sent
    .filter((s) => s.method === 'sendMessage' && Number(s.payload['chat_id']) === chatId)
    .map((s) => String(s.payload['text'] ?? ''));
}
function lastKeyboard(chatId: number): Record<string, unknown> {
  const msg = [...stub.sent]
    .reverse()
    .find((s) => s.method === 'sendMessage' && Number(s.payload['chat_id']) === chatId);
  return (msg?.payload['reply_markup'] ?? {}) as Record<string, unknown>;
}
function keyboardButtons(kb: Record<string, unknown>): string[] {
  const rows = (kb['inline_keyboard'] ?? []) as Array<Array<{ callback_data?: string }>>;
  return rows.flat().map((b) => b.callback_data ?? '');
}
function armingFor(adminId: number): { action: string; target_id: string | null; expires_at: string } | undefined {
  return sqlite
    .prepare('SELECT action, target_id, expires_at FROM admin_actions WHERE admin_user_id = ?1')
    .get(String(adminId)) as never;
}
function auditRows(): Array<Record<string, unknown>> {
  return sqlite.prepare('SELECT * FROM settings_audit ORDER BY id').all() as never;
}
function toasts(): string[] {
  return stub.sent
    .filter((s) => s.method === 'answerCallbackQuery')
    .map((s) => String(s.payload['text'] ?? ''));
}

/* ============================ authorization ============================ */

test('customer /pricing is denied and forges nothing (no arming, no writes)', async () => {
  await dispatch(messageUpdate('/start', nextId()));
  stub.reset();
  await dispatch(messageUpdate('/pricing', nextId()));
  assert.ok(sendTexts(USER.id).some((t) => t.includes('در دسترس شما نیست')));
  assert.equal(armingFor(USER.id), undefined);
  const before = pricingDocRaw();
  await dispatch(callbackUpdateAs('prc:menu', nextId(), USER));
  await dispatch(callbackUpdateAs('prc:ok', nextId(), USER));
  await dispatch(callbackUpdateAs('prc:e_base', nextId(), USER));
  await dispatch(callbackUpdateAs('prc:evil', nextId(), USER)); // fails the strict parser
  await dispatch(callbackUpdateAs('prc:e/../x', nextId(), USER)); // fails the wire pattern
  assert.ok(toasts().length >= 3);
  assert.equal(pricingDocRaw(), before);
  assert.equal(auditRows().length, 0);
  assert.equal(armingFor(USER.id), undefined);
});

test('a NON-admin free-text never reaches a pricing arming of another user', async () => {
  // arm as ADMIN, then a random customer sends a number: it must NOT apply.
  await dispatch(messageUpdateAs(ADMIN, '/pricing', nextId()));
  await dispatch(callbackUpdateAs('prc:e_gb', nextId(), ADMIN, ADMIN.id));
  assert.equal(armingFor(ADMIN.id)?.action, 'pricing');
  const before = pricingDocRaw();

  const random = { id: 424242424, first_name: 'R', username: 'rnd', language_code: 'fa' };
  await dispatch(messageUpdateAs(random, '/start', nextId()));
  await dispatch(messageUpdateAs(random, '999999999', nextId()));
  // that value is a plain IDLE text → idle hint; pricing doc untouched.
  assert.equal(pricingDocRaw(), before);
  assert.ok(armingFor(ADMIN.id), 'the admins arming survives foreign input');
  await dispatch(callbackUpdateAs('prc:no', nextId(), ADMIN, ADMIN.id));
});

/* ============================ view ============================ */

test('/pricing renders the live document with dynamic field buttons', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/pricing', nextId()));
  const texts = sendTexts(ADMIN.id);
  const view = texts.at(-1) ?? '';
  assert.ok(view.includes('مدیریت قیمت‌ها'), 'header');
  assert.ok(view.includes('محصول پایه'), 'base line');
  assert.ok(view.includes('45,000'), 'base price formatted');
  const buttons = keyboardButtons(lastKeyboard(ADMIN.id));
  assert.ok(buttons.some((b) => b === 'prc:e_base'));
  assert.ok(buttons.some((b) => b === 'prc:e_gb'));
  assert.ok(buttons.some((b) => b === 'prc:e_d2'));
  assert.ok(buttons.some((b) => b === 'prc:e_d3'));
  // user buttons follow the LIVE user_prices keys (seed covers 1..10)
  assert.ok(buttons.some((b) => b === 'prc:e_u1'));
  assert.ok(buttons.some((b) => b === 'prc:e_u10'));
  assert.ok(buttons.includes('prc:menu'), 'refresh button');
  assert.ok(buttons.includes('act:cancel'), 'cancel button');
});

/* ============================ full edit flow ============================ */

test('edit flow: arm → type (Persian digits) → staged → confirm → applied + audited + order immutability', async () => {
  // 0) create a priced order FIRST with the CURRENT config, for immutability.
  await dispatch(messageUpdate('/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), USER));
  await dispatch(messageUpdate('  north valley signal  ', nextId()));
  const loaded0 = await loadCatalog(shim);
  assert.equal(loaded0.ok, true);
  if (!loaded0.ok) return;
  const expected0 = calculatePrice(loaded0.catalog.pricing, {
    volumeGb: 10,
    durationDays: 30,
    deviceCount: 1,
  });
  assert.equal(expected0.ok, true);
  await dispatch(callbackUpdateAs('vol:10', nextId(), USER));
  await dispatch(callbackUpdateAs('dur:30', nextId(), USER));
  await dispatch(callbackUpdateAs('dev:1', nextId(), USER));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  const order = sqlite.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 1').get() as
    | { id: string; amount: number; selections: string }
    | undefined;
  assert.ok(order);
  const frozenSnapshot = order!.selections;
  const frozenAmount = order!.amount;

  // 1) enter + arm the per-GB field
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/pricing', nextId()));
  await dispatch(callbackUpdateAs('prc:e_gb', nextId(), ADMIN, ADMIN.id));
  const prompt = sendTexts(ADMIN.id).at(-1) ?? '';
  assert.ok(prompt.includes('هر گیگ'), 'field named in the prompt');
  assert.ok(prompt.includes('4,500'), 'current value shown');

  // 2) garbage keeps the arming alive and applies nothing
  const beforeDoc = pricingDocRaw();
  await dispatch(messageUpdateAs(ADMIN, '۴هزاروپانصد', nextId()));
  assert.equal(armingFor(ADMIN.id)?.target_id, 'gb', 'plain arming survives garbage');
  assert.equal(pricingDocRaw(), beforeDoc);

  // 3) valid value = stage ONLY (never applies on text alone)
  await dispatch(messageUpdateAs(ADMIN, '۵۰۰۰', nextId()));
  assert.ok(String(armingFor(ADMIN.id)?.target_id).startsWith('gb=5000:'), 'value + doc fingerprint staged server-side');
  assert.equal(pricingDocRaw(), beforeDoc, 'no write before confirm');
  const stagedText = sendTexts(ADMIN.id).at(-1) ?? '';
  assert.ok(stagedText.includes('5,000'), 'staged value shown');
  assert.ok(keyboardButtons(lastKeyboard(ADMIN.id)).includes('prc:ok'));

  // 4) confirm → guarded apply + audit + cleared arming
  await dispatch(callbackUpdateAs('prc:ok', nextId(), ADMIN, ADMIN.id));
  assert.equal(pricingJson().price_per_gb, 5000);
  assert.equal(armingFor(ADMIN.id), undefined, 'arming consumed');
  const audit = auditRows();
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.['key'], 'pricing');
  assert.equal(audit[0]?.['actor'], `admin:${ADMIN.id}`);
  assert.equal(audit[0]?.['action'], 'gb');
  assert.equal(JSON.parse(String(audit[0]?.['old_value'])).price_per_gb, 4500);
  assert.equal(JSON.parse(String(audit[0]?.['new_value'])).price_per_gb, 5000);
  assert.equal(
    (sqlite.prepare("SELECT updated_by FROM settings WHERE key = 'pricing'").get() as { updated_by: string })
      .updated_by,
    `admin:${ADMIN.id}`,
  );
  // re-render shows the new value
  assert.ok(sendTexts(ADMIN.id).at(-1)?.includes('5,000'), 'view refreshed');

  // 5) the earlier created order is UNTOUCHED (amount + snapshot immutable)
  const after = sqlite
    .prepare('SELECT amount, selections FROM orders WHERE id = ?1')
    .get(order!.id) as { amount: number; selections: string };
  assert.equal(after.amount, frozenAmount, 'order total frozen');
  assert.equal(after.selections, frozenSnapshot, 'price snapshot byte-identical');

  // 6) a FRESH customer draft now pays the new rate
  const other = { id: 987654999, first_name: 'N', username: 'newp', language_code: 'fa' };
  await dispatch(messageUpdateAs(other, '/start', nextId()));
  await dispatch(callbackUpdateAs('menu:buy', nextId(), other));
  await dispatch(messageUpdateAs(other, '  south ridge radio  ', nextId()));
  await dispatch(callbackUpdateAs('vol:50', nextId(), other));
  await dispatch(callbackUpdateAs('dur:30', nextId(), other));
  await dispatch(callbackUpdateAs('dev:1', nextId(), other));
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), other));
  const fresh = sqlite.prepare('SELECT amount FROM orders ORDER BY created_at DESC LIMIT 1').get() as {
    amount: number;
  };
  // 45000 base + 40 extra GB × 5000 + u1(0) = 245000 (40×4500 ⇒ 180000 would mean the old rate: 225000)
  assert.equal(fresh.amount, 245000);
  assert.notEqual(fresh.amount, frozenAmount);

  // 7) renewals follow the same live table: edit d2 → 90000; old order frozen
  const svc = sqlite.prepare('SELECT id FROM orders WHERE id = ?1').get(order!.id) as { id: string };
  sqlite.prepare("UPDATE orders SET state = 'completed' WHERE id = ?1").run(svc.id);
  await dispatch(messageUpdate('/start', nextId())); // reset session to IDLE
  await dispatch(callbackUpdateAs(`svc:rnw:${svc.id}`, nextId(), USER));
  await dispatch(callbackUpdateAs('dur:60', nextId(), USER, USER.id));
  const renewSummary = sendTexts(USER.id).at(-1) ?? '';
  assert.ok(renewSummary.includes('80,000'), 'renewal priced at the live 2-month entry');
  await dispatch(callbackUpdateAs('prc:e_d2', nextId(), ADMIN, ADMIN.id));
  await dispatch(messageUpdateAs(ADMIN, '۹۰۰۰۰', nextId()));
  await dispatch(callbackUpdateAs('prc:ok', nextId(), ADMIN, ADMIN.id));
  assert.equal(pricingJson().duration_prices['2'], 90000);
  const firstRenewal = sqlite.prepare("SELECT id, amount FROM orders WHERE kind='renewal'").get() as
    | { id: string; amount: number }
    | undefined;
  assert.equal(firstRenewal, undefined, 'no renewal row was confirmed yet');
  await dispatch(callbackUpdateAs('ord:confirm', nextId(), USER));
  const renewed = sqlite
    .prepare("SELECT amount FROM orders WHERE kind = 'renewal' ORDER BY created_at DESC LIMIT 1")
    .get() as { amount: number };
  assert.equal(renewed.amount, 90000, 'fresh re-confirmation priced AFTER the edit');
  assert.equal(order!.amount, frozenAmount, 'the ORIGINAL purchase still 45000-basis');
  assert.equal(
    (sqlite.prepare('SELECT selections FROM orders WHERE id = ?1').get(svc.id) as { selections: string })
      .selections,
    frozenSnapshot,
  );
});

/* ============================ stale / cancel ============================ */

test('prc:no cancels the edit, nothing applies', async () => {
  const before = pricingDocRaw();
  const auditBefore = auditRows().length;
  await dispatch(messageUpdateAs(ADMIN, '/pricing', nextId()));
  await dispatch(callbackUpdateAs('prc:e_base', nextId(), ADMIN, ADMIN.id));
  await dispatch(messageUpdateAs(ADMIN, '60000', nextId()));
  await dispatch(callbackUpdateAs('prc:no', nextId(), ADMIN, ADMIN.id));
  assert.equal(pricingDocRaw(), before);
  assert.equal(armingFor(ADMIN.id), undefined);
  assert.equal(auditRows().length, auditBefore, 'no new audit rows');
});

test('confirm without a staged arming is inert (stale/replay/forged)', async () => {
  const before = pricingDocRaw();
  const auditBefore = auditRows().length;
  stub.reset();
  await dispatch(callbackUpdateAs('prc:ok', nextId(), ADMIN, ADMIN.id)); // no pending at all
  assert.ok(toasts().some((t) => t.includes('منقضی')));
  await dispatch(callbackUpdateAs('prc:no', nextId(), ADMIN, ADMIN.id));
  assert.equal(pricingDocRaw(), before);
  assert.equal(auditRows().length, auditBefore, 'inert confirms audit nothing');
});

test('expired arming consumes nothing and applies nothing', async () => {
  await dispatch(messageUpdateAs(ADMIN, '/pricing', nextId()));
  await dispatch(callbackUpdateAs('prc:e_d3', nextId(), ADMIN, ADMIN.id));
  await dispatch(messageUpdateAs(ADMIN, '123456', nextId()));
  assert.ok(String(armingFor(ADMIN.id)?.target_id).startsWith('d3=123456:'));
  const auditBeforeExpired = auditRows().length;
  sqlite
    .prepare("UPDATE admin_actions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE admin_user_id = ?1")
    .run(String(ADMIN.id));
  stub.reset();
  await dispatch(callbackUpdateAs('prc:ok', nextId(), ADMIN, ADMIN.id));
  assert.ok(toasts().some((t) => t.includes('منقضی')));
  assert.equal(pricingJson().duration_prices['3'], 110000, 'expired staged value never applied');
  assert.equal(auditRows().length, auditBeforeExpired, 'expired confirms audit nothing');
});

test('cross-admin race: loser confirms against a moved document → conflict, no write', async () => {
  // admin armed+staged 'base=70000' in this test's flow…
  await dispatch(messageUpdateAs(ADMIN, '/pricing', nextId()));
  await dispatch(callbackUpdateAs('prc:e_base', nextId(), ADMIN, ADMIN.id));
  await dispatch(messageUpdateAs(ADMIN, '۷۰۰۰۰', nextId()));
  // …meanwhile another admin edits a DIFFERENT field directly (newer doc):
  const auditBeforeRace = auditRows().length;
  sqlite
    .prepare(
      `UPDATE settings
          SET value = json_set(value, '$.duration_prices."3"', 111000)
        WHERE key = 'pricing'`,
    )
    .run();
  const movedBefore = pricingDocRaw();
  stub.reset();
  await dispatch(callbackUpdateAs('prc:ok', nextId(), ADMIN, ADMIN.id));
  assert.ok(toasts().some((t) => t.includes('مدیر دیگری')));
  // the winner's document survived untouched by the loser…
  assert.equal(pricingDocRaw(), movedBefore);
  assert.equal(pricingJson().base_product.price, 45000, 'loser edit NOT applied');
  assert.equal(pricingJson().duration_prices['3'], 111000, 'winners unrelated edit survives');
  assert.equal(auditRows().length, auditBeforeRace, 'conflicted confirms audit nothing');
  assert.equal(armingFor(ADMIN.id), undefined, 'loser arming cleared on conflict');
});

test('stale field token after a ladder doc swap: edit tap → refused, arm-only tap too', async () => {
  // Forge an edit token that does not exist in the live document:
  const before = pricingDocRaw();
  await dispatch(callbackUpdateAs('prc:e_u777', nextId(), ADMIN, ADMIN.id));
  assert.ok(toasts().some((t) => t.includes('دیگر')));
  assert.equal(armingFor(ADMIN.id), undefined);
  await dispatch(messageUpdateAs(ADMIN, '500', nextId())); // no arming → idle path text
  assert.equal(pricingDocRaw(), before);
});

/* ============ calculator still coherent with the live (edited) doc ============ */

test('after all edits, loadCatalog stays coherent and tables drive fresh pricing', async () => {
  const loaded = await loadCatalog(shim);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const p = loaded.catalog.pricing;
  assert.equal(p.pricePerGb, 5000);
  assert.equal(p.durationPrices[2], 90000);
  assert.equal(p.durationPrices[3], 111000);
  assert.equal(p.userPrices[1], 0);
  const oneMonth = calculatePrice(p, { volumeGb: 10, durationDays: 30, deviceCount: 1 });
  assert.equal(oneMonth.ok && oneMonth.breakdown.total, 45000);
  const twoMonths = calculatePrice(p, { volumeGb: 10, durationDays: 60, deviceCount: 1 });
  assert.equal(twoMonths.ok && twoMonths.breakdown.total, 90000);
  const renew = calculateRenewalPrice(p, { durationDays: 60 });
  assert.equal(renew.ok && renew.breakdown.total, 90000);
});
