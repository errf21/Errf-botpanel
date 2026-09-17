/**
 * Phase 21 — /msg admin direct-message relay.
 *
 * Focused, fully offline:
 *  - non-admin: exact cmdAdminOnly denial, zero sends to the target
 *  - usage / not-found / empty-body / self-target handling, zero sends
 *  - numeric + @username (case-insensitive) relay with the 👑 header
 *  - special characters render literally (plain text, no parse_mode)
 *  - send failure (null AND throw) → admin error notice, no crash
 *  - no D1 writes beyond the /start registration rows
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN,
  USER,
  freshDb,
  makeD1Shim,
  makeFetchStub,
  messageUpdateAs,
} from './helpers.ts';

const stub = makeFetchStub();
after(() => stub.restore());

const sqlite = freshDb();
const shim = makeD1Shim(sqlite);
const { processTelegramUpdate } = await import('../src/dispatch.ts');
const env = {
  DB: shim,
  TELEGRAM_BOT_TOKEN: 'TEST',
  TELEGRAM_WEBHOOK_SECRET: 'TEST',
  ADMIN_CHAT_ID: String(ADMIN.id),
} as unknown as Parameters<typeof processTelegramUpdate>[1];

let counter = 61000;
const nextId = () => ++counter;
const dispatch = (update: unknown): Promise<void> => processTelegramUpdate(update, env);

const { fa } = await import('../src/telegram/texts.ts');

const TARGET = { id: 660001, first_name: 'Nima', username: 'nima_user', language_code: 'fa' };

const sentTo = (chatId: number) => stub.sent.filter((s) => Number(s.payload['chat_id']) === chatId);
const textsTo = (chatId: number) =>
  sentTo(chatId).filter((s) => s.method === 'sendMessage').map((s) => String(s.text));
const lastTextTo = (chatId: number): string => textsTo(chatId).at(-1) ?? '';
const payloadsTo = (chatId: number) =>
  sentTo(chatId).filter((s) => s.method === 'sendMessage').map((s) => s.payload);

test('non-admin /msg is denied exactly with zero sends to the target', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(TARGET, '/start', nextId()));
  await dispatch(messageUpdateAs(USER, '/start', nextId()));
  stub.reset(); // drop the /start welcome bubbles; count only /msg traffic below
  await dispatch(messageUpdateAs(USER, `/msg ${TARGET.id} hello`, nextId()));
  assert.ok(textsTo(USER.id).includes(fa.cmdAdminOnly));
  assert.equal(sentTo(TARGET.id).length, 0, 'target receives nothing');
});

test('missing/invalid/unknown/empty targets send nothing', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/start', nextId()));
  const before = sentTo(TARGET.id).length;

  await dispatch(messageUpdateAs(ADMIN, '/msg', nextId()));
  assert.equal(lastTextTo(ADMIN.id), fa.msgUsage);

  await dispatch(messageUpdateAs(ADMIN, '/msg !!! hello', nextId()));
  assert.equal(lastTextTo(ADMIN.id), fa.msgUsage);

  await dispatch(messageUpdateAs(ADMIN, '/msg 999000222 hello', nextId()));
  assert.equal(lastTextTo(ADMIN.id), fa.usersNotFound);

  await dispatch(messageUpdateAs(ADMIN, '/msg @no_such_user_xyz hello', nextId()));
  assert.equal(lastTextTo(ADMIN.id), fa.usersNotFound);

  await dispatch(messageUpdateAs(ADMIN, `/msg ${TARGET.id}`, nextId()));
  assert.equal(lastTextTo(ADMIN.id), fa.msgUsage);

  await dispatch(messageUpdateAs(ADMIN, `/msg ${TARGET.id}   `, nextId()));
  assert.equal(lastTextTo(ADMIN.id), fa.msgUsage);

  assert.equal(sentTo(TARGET.id).length, before, 'no relay on any bad input');
});

test('self-target is refused', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, `/msg ${ADMIN.id} hello self`, nextId()));
  assert.equal(lastTextTo(ADMIN.id), fa.invalidChoice);
  assert.ok(!textsTo(ADMIN.id).some((t) => t.includes('👑 از طرف ادمین')));
});

test('numeric relay delivers the headed message + admin confirmation', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, `/msg ${TARGET.id} Hello Nima, this is support`, nextId()));
  const got = lastTextTo(TARGET.id);
  assert.ok(got.startsWith('👑 از طرف ادمین\n\n'), 'clean system-message header');
  assert.ok(got.includes('Hello Nima, this is support'));
  assert.equal(lastTextTo(ADMIN.id), fa.msgSent);
});

test('@username relay is case-insensitive', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, '/msg @NIMA_USER hi again', nextId()));
  assert.ok(lastTextTo(TARGET.id).includes('hi again'));
  assert.equal(lastTextTo(ADMIN.id), fa.msgSent);
});

test('special characters render literally with no parse_mode', async () => {
  stub.reset();
  await dispatch(messageUpdateAs(ADMIN, `/msg ${TARGET.id} <b>bold</b> & "quotes"`, nextId()));
  const payload = payloadsTo(TARGET.id).at(-1) ?? {};
  assert.equal(payload['parse_mode'], undefined, 'plain text: nothing can break formatting');
  assert.ok(lastTextTo(TARGET.id).includes('<b>bold</b> & "quotes"'), 'delivered verbatim');
});

test('send failure (null and throw) notifies the admin without crashing', async () => {
  const { handleMsgCommand } = await import('../src/handlers/msgAdmin.ts');
  const db = shim as unknown as D1Database;
  for (const failingSend of [
    async () => null,
    async () => {
      throw new Error('transport down');
    },
  ]) {
    const adminNotices: string[] = [];
    const fakeApi = {
      sendMessage: async (chatId: number, text: string) => {
        if (chatId === TARGET.id) return failingSend();
        adminNotices.push(text);
        return true;
      },
    };
    await handleMsgCommand(
      {
        env,
        db,
        api: fakeApi,
        actor: ADMIN,
        chatId: ADMIN.id,
        customerId: 1,
        isAdmin: true,
        ui: { t: fa, f: {} },
      } as unknown as Parameters<typeof handleMsgCommand>[0],
      [String(TARGET.id), 'are', 'you', 'there?'],
    );
    assert.ok(adminNotices.includes(fa.msgSendFailed), 'admin told about the failure');
    assert.ok(!adminNotices.includes(fa.msgSent), 'no false success');
  }
});

test('relay writes nothing to D1', async () => {
  const ordersBefore = (sqlite.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
  const eventsBefore = (sqlite.prepare('SELECT COUNT(*) AS n FROM order_events').get() as { n: number }).n;
  const walletBefore = (sqlite.prepare('SELECT COUNT(*) AS n FROM wallet_entries').get() as { n: number }).n;
  await dispatch(messageUpdateAs(ADMIN, `/msg ${TARGET.id} quiet check`, nextId()));
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n, ordersBefore);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM order_events').get() as { n: number }).n, eventsBefore);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM wallet_entries').get() as { n: number }).n, walletBefore);
});
