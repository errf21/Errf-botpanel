/**
 * Phase 3 e2e: the real dispatcher over real SQLite migrations (0001-0003,
 * catalog seeded) with a fetch stub - full purchase through durable order
 * creation, idempotency, stale input, replay protection, snapshot immutability.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  callbackUpdate,
  freshDb,
  makeD1Shim,
  makeFetchStub,
  messageUpdate,
} from './helpers.ts';
import { checkoutOrder, type CheckoutDraft } from '../src/orders/checkout.ts';
import { loadCatalog } from '../src/catalog/catalog.ts';
import { calculatePrice } from '../src/catalog/pricing.ts';

const stub = makeFetchStub();
after(() => stub.restore());

const { processTelegramUpdate } = await import('../src/dispatch.ts');
const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const env = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
} as unknown as Parameters<typeof processTelegramUpdate>[1];

const dispatch = (update: unknown): Promise<void> =>
  processTelegramUpdate(update, env);

function session(): { state: string; data: Record<string, unknown> } {
  const row = sqlite
    .prepare(
      `SELECT s.state, s.data FROM conversation_states s
         JOIN customers c ON c.id = s.customer_id
        WHERE c.telegram_user_id = '987654321'`,
    )
    .get() as { state: string; data: string } | undefined;
  return row
    ? { state: row.state, data: JSON.parse(row.data) as Record<string, unknown> }
    : { state: 'IDLE', data: {} };
}

function allOrders(): Array<Record<string, unknown>> {
  return sqlite.prepare('SELECT * FROM orders').all() as Array<Record<string, unknown>>;
}

test('full purchase: start → buy → name → custom 12GB → 30d → devices → confirm', async () => {
  await dispatch(messageUpdate('/start', 101));
  await dispatch(callbackUpdate('menu:buy', 102));
  assert.equal(session().state, 'WAITING_CONFIG_NAME');

  // name accepted + volume step rendered with real preset buttons
  stub.reset();
  await dispatch(messageUpdate('  north valley signal  ', 103));
  assert.equal(session().state, 'WAITING_VOLUME');
  assert.equal(session().data['config_name'], 'north valley signal');
  const volKb = stub.sendCalls()[1]?.payload['reply_markup'] as {
    inline_keyboard: { callback_data: string }[][];
  };
  assert.ok(volKb.inline_keyboard.flat().some((b) => b.callback_data === 'vol:10'));

  // custom below the 10 GB minimum → rejected with helpful range message
  stub.reset();
  await dispatch(messageUpdate('۵', 104)); // Persian 5
  assert.equal(session().state, 'WAITING_VOLUME');
  // Phase 8B: flow-specific rejection — the volume step answers in «حجم».
  assert.ok(String(stub.sendCalls()[0]?.text).includes('حجم'));

  // custom 12 GB (not a preset) → accepted via allow_custom
  stub.reset();
  await dispatch(messageUpdate('۱۲', 105)); // Persian 12
  assert.equal(session().state, 'WAITING_DURATION');
  assert.equal(session().data['volume_gb'], 12);

  // stale button from a previous step → toast only, state untouched
  stub.reset();
  await dispatch(callbackUpdate('vol:30', 106));
  assert.equal(session().state, 'WAITING_DURATION');
  assert.ok(stub.sent.some((s) => s.method === 'answerCallbackQuery'));

  // preset duration
  await dispatch(callbackUpdate('dur:30', 107));
  assert.equal(session().state, 'WAITING_DEVICE_LIMIT');
  assert.equal(session().data['duration_days'], 30);

  // custom button just hints; value arrives via text
  await dispatch(callbackUpdate('dev:custom', 108));
  assert.equal(session().state, 'WAITING_DEVICE_LIMIT');
  await dispatch(messageUpdate('3', 109));
  assert.equal(session().state, 'WAITING_ORDER_CONFIRMATION');
  const token = session().data['order_token'];
  assert.equal(typeof token, 'string');
  assert.equal(session().data['device_count'], 3);

  // summary: name, 12 GB, 30 days, 3 devices, toman price, token displayed
  const summary = stub.sendCalls().at(-1);
  const summaryText = String(summary?.text);
  assert.ok(summaryText.includes('north valley signal'));
  assert.ok(summaryText.includes('تومان'));
  assert.ok(summaryText.includes(String(token)));

  // back one step: draft + token preserved, still zero orders
  await dispatch(callbackUpdate('step:back', 110));
  assert.equal(session().state, 'WAITING_DEVICE_LIMIT');
  assert.equal(session().data['order_token'], token);
  assert.equal(allOrders().length, 0);

  // re-choose: token identical, price base(45000) + 2 extra GB*4500 + users-3(50000) = 104000
  await dispatch(callbackUpdate('dev:3', 111));
  assert.equal(session().state, 'WAITING_ORDER_CONFIRMATION');
  assert.equal(session().data['order_token'], token);

  // confirm → durable order, payment-waiting state
  await dispatch(callbackUpdate('ord:confirm', 112));
  assert.equal(session().state, 'WAITING_PAYMENT_RECEIPT');
  assert.equal(typeof session().data['order_id'], 'string');
  const [order] = allOrders();
  assert.equal(order?.['state'], 'pending_payment');
  assert.equal(order?.['amount'], 104000);
  assert.equal(order?.['currency'], 'IRT');
  assert.equal(order?.['idempotency_key'], token);
  const snapshot = JSON.parse(String(order?.['selections'])) as Record<string, unknown>;
  assert.equal(snapshot['config_name'], 'north valley signal');
  assert.equal(snapshot['volume_gb'], 12);
  const price = snapshot['price'] as Record<string, unknown>;
  assert.equal(price['schema'], 2);
  assert.deepEqual(price['inputs'], {
    base_gb: 10,
    base_product_price: 45000,
    price_per_gb: 4500,
    duration_key: 'base',
    duration_price: 45000,
    user_count: 3,
    user_price: 50000,
    days_per_month: 30,
  });
  const eventCount = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM order_events WHERE action = 'order_created'")
      .get() as { n: number }
  ).n;
  assert.equal(eventCount, 1);
});

test('replay of the confirm update creates nothing new; re-confirm is a no-op', async () => {
  const before = allOrders().length;
  stub.reset();
  await dispatch(callbackUpdate('ord:confirm', 112)); // exact replay (same update_id)
  assert.equal(stub.sent.length, 0, 'dedupe suppressed');
  await dispatch(callbackUpdate('ord:confirm', 113)); // fresh update, state is post-confirm
  assert.equal(allOrders().length, before, 'no duplicate order');
});

test('priced order is immutable when catalog changes afterwards', () => {
  sqlite
    .prepare("UPDATE settings SET value = json_set(value, '$.price_per_gb', 999999) WHERE key = 'pricing'")
    .run();
  const [order] = allOrders();
  assert.equal(order?.['amount'], 104000);
  const snapshot = JSON.parse(String(order?.['selections'])) as { price: { inputs: { price_per_gb: number } } };
  assert.equal(snapshot.price.inputs.price_per_gb, 4500); // stored snapshot, untouched
});

test('checkout is idempotent at the repository layer (same token → same row)', async () => {
  const loaded = await loadCatalog(shim as unknown as D1DatabaseStub);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const computed = calculatePrice(loaded.catalog.pricing, {
    volumeGb: 10,
    durationDays: 30,
    deviceCount: 1,
  });
  assert.equal(computed.ok, true);
  if (!computed.ok) return;
  const draft: CheckoutDraft = {
    customerId: 1,
    orderToken: 'MANUAL-TOKEN-1',
    configName: 'manual',
    catalog: loaded.catalog,
    breakdown: computed.breakdown,
  };
  const first = await checkoutOrder(shim as unknown as D1DatabaseStub, draft);
  const second = await checkoutOrder(shim as unknown as D1DatabaseStub, draft);
  assert.equal(first.ok && first.created, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(second.created, false);
    assert.equal(second.order.id, first.order.id);
  }
});

type D1DatabaseStub = Parameters<typeof checkoutOrder>[0];

test('cancel aborts remaining draft; created order survives', async () => {
  const ordersBefore = allOrders().length;
  stub.reset();
  await dispatch(callbackUpdate('act:cancel', 114));
  assert.equal(session().state, 'IDLE');
  assert.equal(allOrders().length, ordersBefore); // durable, untouched by conversation cancel
});

test('malformed updates and invalid users are inert', async () => {
  const ordersBefore = allOrders().length;
  await dispatch({ update_id: 999998 }); // no content at all
  await dispatch({
    update_id: 999999,
    message: { message_id: 1, from: { id: 0 }, chat: { id: 0 }, text: 'x' },
  }); // invalid user id
  await dispatch(callbackUpdate('VOL:10', 1000000)); // uppercase namespace
  assert.equal(allOrders().length, ordersBefore);
});
