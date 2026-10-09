import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { freshDb, makeD1Shim, ADMIN, USER, callbackUpdateAs, messageUpdateAs } from './helpers.ts';
import { encrypt, decrypt, verifyInitData, nonce, panelOrigin, publicAddress, publicDestination } from '../src/panels/security.ts';
import { getPanel, resolvePanel, clientFor, selection } from '../src/panels/registry.ts';
import { panelAdminRoute, showPanels, testPanel } from '../src/panels/admin.ts';
import { insertOrderWithEvent, getOrderById } from '../src/db/orders.ts';
import { newOrderId } from '../src/lib/security.ts';
import { provisionOrder, deletePanelService, GB_BYTES } from '../src/provision/provision.ts';
import { runServiceNotificationSweep } from '../src/handlers/serviceNotifications.ts';
import { recoverPanelOperations } from '../src/panels/recovery.ts';
import { processTelegramUpdate } from '../src/dispatch.ts';
import { uiFor } from '../src/telegram/i18n.ts';
import { PasarGuardClient } from '../src/pasarguard/client.ts';
import type { Env, UpdateContext } from '../src/types.ts';
const A = 'https://existing.example.com', B = 'https://second.example.com', C='https://third.example.com', D='https://fourth.example.com', WEB = 'https://bot.example.com';
const DYNAMIC_KEY = 'SYNTHETIC-DYNAMIC-KEY-not-production', TOKEN_KEY = btoa('x'.repeat(32));
let sqlite: DatabaseSync, db: D1Database, env: Env, real: typeof fetch;
let calls: {
    origin: string;
    path: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}[], sent: Record<string, unknown>[];
let users: Map<string, Record<string, unknown>>[], update: number, apiFailure: number, rejectOnce: boolean, ambiguousCreate: boolean, proxy404: boolean, delayRequest: number;
const api = { sendMessage: async (chatId: number, text: string, kb?: unknown) => { sent.push({ chat_id: chatId, text, reply_markup: kb }); }, answerCallbackQuery: async () => { }, editMessageText: async () => { } };
beforeEach(async () => {
    sqlite = freshDb();
    db = makeD1Shim(sqlite) as unknown as D1Database;
    env = {
        DB: db, TELEGRAM_BOT_TOKEN: 'SYNTHETIC-BOT', TELEGRAM_WEBHOOK_SECRET: 'SYNTHETIC-WEBHOOK', ADMIN_CHAT_ID: String(ADMIN.id),
        PASARGUARD_PANEL_URL: A, PASARGUARD_API_KEY: 'SYNTHETIC-LEGACY-KEY', PANEL_ENCRYPTION_KEY: TOKEN_KEY,
        PANEL_ADMIN_ORIGIN: WEB
    };
    sqlite.prepare('INSERT INTO customers(telegram_user_id,first_name) VALUES (?,?)').run(String(USER.id), 'User');
    calls = [];
    sent = [];
    users = [new Map(),new Map(),new Map(),new Map()];
    update = 100000;
    apiFailure = 0;
    rejectOnce = false;
    ambiguousCreate = false;
    proxy404 = false;
    delayRequest = 0;
    real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const headers = Object.fromEntries(new Headers(init?.headers));
        const body = String(init?.body ?? '');
        if (url.origin === 'https://api.telegram.org') {
            sent.push(JSON.parse(body));
            return Response.json({ ok: true, result: {} });
        }
        if(url.origin==='https://cloudflare-dns.com') return Response.json({Status:0,Answer:[{type:1,data:'8.8.8.8'}]});
        assert.ok([A,B,C,D].includes(url.origin), 'unexpected network destination');
        calls.push({ origin: url.origin, path: url.pathname, method, headers, body });
        assert.equal(init?.redirect, 'manual');
        const n=[A,B,C,D].indexOf(url.origin);
        assert.equal(headers['x-api-key'],n===0 ? env.PASARGUARD_API_KEY : n===1 ? DYNAMIC_KEY : `SYNTHETIC-KEY-${n}`);
        assert.equal(headers.authorization,undefined);
        if(n>0 && delayRequest) await new Promise(r=>setTimeout(r,delayRequest));
        if(n>0 && apiFailure) return Response.json({detail:`secret ${DYNAMIC_KEY}`},{status:apiFailure});
        if(rejectOnce) {rejectOnce=false;return Response.json({detail:'rejected'},{status:401});}
        if (url.pathname === '/api/admin')
            return Response.json({ username: 'bot-user', status: 'active', role: { is_owner: false, permissions: { users: { create: true, read: { scope: 1 }, update: { scope: 1 }, reset_usage: true, delete: { scope: 1 } } } } });
        if (url.pathname.startsWith('/api/group/'))
            return Response.json({ id: Number(url.pathname.split('/').at(-1)), name: 'Group' });
        if (url.pathname === '/api/user' && method === 'POST') {
            const payload = JSON.parse(body);
            if (users[n]!.has(payload.username))
                return Response.json({ detail: 'already exists' }, { status: 409 });
            const user = { ...payload, id: String(100 + users[n]!.size), used_traffic: 0, subscription_url: `/sub/${payload.username}` };
            users[n]!.set(payload.username, user);
            if (ambiguousCreate) {
                ambiguousCreate = false;
                throw new Error(`SYNTHETIC transport ${DYNAMIC_KEY}`);
            }
            return Response.json(user);
        }
        const username = decodeURIComponent(url.pathname.slice('/api/user/by-username/'.length).replace(/\/reset$/, ''));
        const user = url.pathname.startsWith('/api/user/by-id/') ? Array.from(users[n]!.values()).find(v=>v.id===url.pathname.split('/')[4]) : users[n]!.get(username);
        if (!user)
            return proxy404 ? new Response('proxy missing', { status: 404 }) : Response.json({ detail: 'User not found' }, { status: 404 });
        if (method === 'DELETE') {
            users[n]!.delete(user.username as string);
            return new Response(null, { status: 204 });
        }
        if (method === 'POST' && url.pathname.endsWith('/reset')) {
            user.used_traffic = 0;
            user.subscription_url = `/sub/${user.username}/reset`;
        }
        if (method === 'PUT')
            Object.assign(user, JSON.parse(body));
        return Response.json({ ...user });
    }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = real; sqlite.close(); });
async function addFixture(id:string,origin:string,key:string,enabled=1): Promise<void> {
    const c=await encrypt(env,`panel:${id}:1:${origin}:credentials`,{apiKey:key});
    sqlite.prepare(`INSERT INTO panels(id,name,origin,auth_type,credentials,revision,enabled_new,group_ids,last_test)
    VALUES (?, ?, ?,'api_key',?,1,?,'[7]','ok')`).run(id,id,origin,c,enabled);
}
async function secondary(enabled=1):Promise<void> {return addFixture('secondary',B,DYNAMIC_KEY,enabled);}
function active(id: string): void { sqlite.prepare('UPDATE panel_selection SET panel_id=?,revision=revision+1').run(id); }
async function purchase(): Promise<string> {
    const id = newOrderId();
    await insertOrderWithEvent(db, { id, customerId: 1, selections: JSON.stringify({ volume_gb: 10, duration_days: 30, device_count: 1, config_name: 'Sample' }), amount: 100, currency: 'IRT', idempotencyKey: newOrderId(), initialState: 'approved' });
    return id;
}
async function run(id: string, retry = false) { return provisionOrder({ env, db, api: api as unknown as UpdateContext['api'] }, { orderId: id, retry }); }
function ctx(actor = ADMIN.id): UpdateContext { return { env, db, api: api as unknown as UpdateContext['api'], actor: { id: actor, first_name: 'Admin' }, chatId: actor, customerId: 1, isAdmin: true, ui: uiFor('en') }; }
async function dispatch(data: string, actor = ADMIN) { await processTelegramUpdate(callbackUpdateAs(data, ++update, actor, actor.id), env); }
function lastButtons(): {
    callback_data?: string;
    web_app?: {
        url: string;
    };
}[] { return (sent.at(-1)?.reply_markup as {
    inline_keyboard: Record<string, unknown>[][];
})?.inline_keyboard.flat() ?? []; }
async function selectByTelegram(id: string) { await dispatch(`pnl:select:${id}`); const confirm = lastButtons().find(v => v.callback_data?.startsWith('pnl:confirm:')); assert.ok(confirm); await dispatch(confirm.callback_data!); }
async function initData(actor = ADMIN.id): Promise<string> {
    const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: actor }), query_id: 'synthetic' });
    const check = Array.from(p.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const hmac = async (k: Uint8Array, s: string) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(s)));
    const key = await hmac(new TextEncoder().encode('WebAppData'), env.TELEGRAM_BOT_TOKEN);
    p.set('hash', Array.from(await hmac(key, check), v => v.toString(16).padStart(2, '0')).join(''));
    return p.toString();
}
test('legacy uses unchanged API key; multiple dynamic panels use their own API keys without login', async () => {
    const first = await purchase();
    assert.equal((await run(first)).ok, true);
    await secondary();
    active('secondary');
    const second = await purchase();
    assert.equal((await run(second)).ok, true);
    assert.equal((await getOrderById(db, first))?.panel_id, 'legacy');
    assert.equal((await getOrderById(db, second))?.panel_id, 'secondary');
    assert.equal((await getOrderById(db, first))?.pasarguard_user_id, '100');
    assert.equal((await getOrderById(db, second))?.pasarguard_user_id, '100');
    assert.deepEqual(JSON.parse(calls.find(v => v.origin === B && v.path === '/api/user')!.body).group_ids, [7]);
    assert.deepEqual(JSON.parse(calls.find(v => v.origin === A && v.path === '/api/user')!.body).group_ids, [24, 25]);
    assert.ok((await getOrderById(db, second))?.subscription_url?.startsWith(B));
});
test('rejected API-key mutation is not replayed automatically', async () => {
    await secondary();
    const p = await resolvePanel(env, 'secondary');
    assert.ok(p.ok);
    if (!p.ok)
        return;
    const client = clientFor(p.config);
    await client.getCurrentAdmin();
    rejectOnce = true;
    const result = await client.createUser({ username: 'synthetic', status: 'active', expire: Math.floor(Date.now() / 1000) + 3600, data_limit: 100, hwid_limit: 1, group_ids: [7], note: 'test' });
    assert.equal(result.ok, false);
    assert.equal(calls.filter(v => v.path === '/api/user').length, 1);
});
test('Telegram explicit selection changes only new orders, with confirmed disable and switch-back', async () => {
    const a = await purchase();
    await run(a);
    await secondary();
    await selectByTelegram('secondary');
    assert.equal((await selection(db)).panel_id, 'secondary');
    const b = await purchase();
    await run(b);
    assert.equal((await getOrderById(db, a))?.panel_id, 'legacy');
    assert.equal((await getOrderById(db, b))?.panel_id, 'secondary');
    await dispatch('pnl:toggle:secondary');
    await dispatch(lastButtons().find(v => v.callback_data?.startsWith('pnl:confirm:'))!.callback_data!);
    const blocked = await purchase();
    calls = [];
    assert.equal((await run(blocked)).ok, false);
    assert.equal(calls.length, 0);
    assert.equal((await getOrderById(db, blocked))?.panel_id, null);
    await selectByTelegram('legacy');
    assert.equal((await selection(db)).panel_id, 'legacy');
    assert.equal((await run(blocked)).ok, true);
});
test('stale concurrent selection confirmations cannot overwrite a newer decision', async () => {
    await secondary();
    await dispatch('pnl:select:secondary');
    const stale = lastButtons()[0]!.callback_data!;
    await selectByTelegram('legacy');
    await dispatch(stale);
    assert.equal((await selection(db)).panel_id, 'legacy');
});
test('uncertain create stays on original panel after switch; retry adopts without duplicate or new expiry', async () => {
    await secondary();
    active('secondary');
    const id = await purchase();
    ambiguousCreate = true;
    assert.equal((await run(id)).ok, false);
    const first = await getOrderById(db, id);
    assert.equal(first?.panel_id, 'secondary');
    assert.equal(users[1]!.size, 1);
    active('legacy');
    assert.equal((await run(id, true)).ok, true);
    assert.equal(users[1]!.size, 1);
    assert.equal(users[0]!.size, 0);
    assert.equal((await getOrderById(db, id))?.create_target_unix, first?.create_target_unix);
    assert.equal(calls.filter(v => v.path === '/api/user').length, 1);
});
test('authentication failure remains pinned and never falls back; logs and persisted errors redact credentials', async () => {
    await secondary();
    active('secondary');
    apiFailure = 401;
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args) => logs.push(args.join(' '));
    try {
        const id = await purchase();
        assert.equal((await run(id)).ok, false);
        active('legacy');
        assert.equal((await run(id, true)).ok, false);
        const row = await getOrderById(db, id);
        assert.equal(row?.panel_id, 'secondary');
        assert.equal(users[0]!.size, 0);
        const rendered = JSON.stringify({ logs, sent, row, audit: sqlite.prepare('SELECT * FROM panel_audit').all() });
        assert.ok(!rendered.includes(DYNAMIC_KEY));
        assert.ok(!rendered.includes('SYNTHETIC-LEGACY-KEY'));
    }
    finally {
        console.error = original;
    }
});
test('renewal, repurchase/reset, live status, deletion and notifications route to original secondary even when disabled', async () => {
    await secondary();
    active('secondary');
    const service = await purchase();
    assert.equal((await run(service)).ok, true);
    active('legacy');
    sqlite.prepare("UPDATE panels SET enabled_new=0 WHERE id='secondary'").run();
    const s = (await getOrderById(db, service))!;
    const username = s.pasarguard_username!;
    const user = users[1]!.get(username)!;
    const renewal = newOrderId();
    await insertOrderWithEvent(db, { id: renewal, customerId: 1, kind: 'renewal', renewsOrderId: service, selections: JSON.stringify({ duration_days: 2, added_volume_gb: 1, renews_order_id: service }), amount: 10, currency: 'IRT', idempotencyKey: newOrderId(), initialState: 'approved' });
    calls = [];
    assert.equal((await run(renewal)).ok, true);
    assert.ok(calls.every(v => v.origin === B));
    assert.equal((await getOrderById(db, renewal))?.panel_id, 'secondary');
    sqlite.prepare("UPDATE settings SET value=? WHERE key='repurchase'").run(JSON.stringify({ schema: 1, enabled: true, near_expiry_days: 7 }));
    const rep = newOrderId();
    await insertOrderWithEvent(db, { id: rep, customerId: 1, kind: 'renewal', repurchaseMode: 'same', renewsOrderId: service, selections: JSON.stringify({ kind: 'repurchase', mode: 'same', volume_gb: 10, duration_days: 30, device_count: 1, repurchases_order_id: service, renews_order_id: service }), amount: 10, currency: 'IRT', idempotencyKey: newOrderId(), initialState: 'approved' });
    calls = [];
    assert.equal((await run(rep)).ok, true);
    assert.ok(calls.some(v => v.path.endsWith('/reset')));
    assert.ok(calls.every(v => v.origin === B));
    assert.ok((await getOrderById(db, service))?.subscription_url?.startsWith(B));
    calls = [];
    await processTelegramUpdate(callbackUpdateAs(`svc:ref:${service}`, ++update, USER), env);
    assert.ok(calls.length);
    assert.ok(calls.every(v => v.origin === B));
    user.used_traffic = 9.5 * GB_BYTES;
    user.data_limit = 10 * GB_BYTES;
    calls = [];
    const notices = await runServiceNotificationSweep(env, Date.now(), api as unknown as UpdateContext['api']);
    assert.equal(notices.usageSent, 1);
    assert.ok(calls.every(v => v.origin === B));
    calls = [];
    assert.equal((await deletePanelService(env, username, s)).ok, true);
    assert.ok(calls.every(v => v.origin === B));
    assert.equal(users[1]!.size, 0);
});
test('auth failure and malformed/proxy 404 never mark a service deleted; stored identity mismatch fails closed', async () => {
    await secondary();
    active('secondary');
    const id = await purchase();
    await run(id);
    const s = (await getOrderById(db, id))!;
    users[1]!.delete(s.pasarguard_username!);
    proxy404 = true;
    await processTelegramUpdate(callbackUpdateAs(`svc:ref:${id}`, ++update, USER), env);
    assert.equal((await getOrderById(db, id))?.panel_deleted_at, null);
    const p = await resolvePanel(env, 'secondary');
    assert.ok(p.ok);
    if (!p.ok)
        return;
    users[1]!.set(s.pasarguard_username!, { id: '999', username: s.pasarguard_username, status: 'active' });
    const result = await clientFor(p.config, s.pasarguard_user_id).getUserByUsername(s.pasarguard_username!);
    assert.ok(!result.ok);
    if (!result.ok)
        assert.equal(result.kind, 'identity');
});
test('unauthorized users and database-only admins cannot configure or select panels', async () => {
    sqlite.prepare('UPDATE customers SET is_admin=1 WHERE telegram_user_id=?').run(String(USER.id));
    await secondary();
    await processTelegramUpdate(messageUpdateAs(USER, '/panels', ++update), env);
    assert.ok(!lastButtons().some(v => v.web_app));
    await dispatch('pnl:select:secondary', USER);
    assert.equal((await selection(db)).panel_id, 'legacy');
    const response = await panelAdminRoute(new Request(`${WEB}/admin/panels/configure`, { method: 'POST', headers: { origin: WEB, 'content-type': 'application/json' }, body: JSON.stringify({ initData: await initData(USER.id) }) }), env);
    assert.equal(response.status, 403);
});
test('authenticated Mini App encrypts credentials, is one-use and rejects tampered initData', async () => {
    assert.equal(await verifyInitData(env, await initData()), ADMIN.id);
    assert.equal(await verifyInitData(env, (await initData()).replace('synthetic', 'tampered')), null);
    await dispatch('pnl:add');
    const url = lastButtons().find(v => v.web_app)!.web_app!.url;
    const token = new URL(url).searchParams.get('nonce')!;
    const body = { nonce: token, initData: await initData(), name: 'Second', url: B, apiKey: DYNAMIC_KEY, groups: [7] };
    const request = () => new Request(`${WEB}/admin/panels/configure`, { method: 'POST', headers: { origin: WEB, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const id = sqlite.prepare('SELECT panel_id FROM panel_admin_sessions WHERE nonce=?').get(token)!.panel_id as string;
    assert.equal((await panelAdminRoute(request(), env)).status, 200);
    const row = (await getPanel(db, id))!;
    assert.ok(!row.credentials!.includes(DYNAMIC_KEY));
    assert.equal(row.enabled_new, 0);
    assert.deepEqual(await decrypt(env, `panel:${id}:1:${B}:credentials`, row.credentials!), { apiKey: DYNAMIC_KEY });
    assert.equal((await panelAdminRoute(request(), env)).status, 403);
    assert.ok(calls.some(c=>c.path==='/api/admin'));
});
test('public origin validation and declared permission/group tests fail closed', async () => {
    await secondary();
    assert.equal(await testPanel(env,'secondary'),'ok');
    for(const url of ['http://second.example.com','https://127.0.0.1','https://localhost','https://second.example.com@evil.com','https://second.example.com/path','https://second.example.com?key=x','https://second.example.com:444'])
        assert.equal(panelOrigin(url),null);
    assert.equal(panelOrigin('https://second.example.com:8000'),'https://second.example.com:8000');
    const original=fetch;
    globalThis.fetch=(async (input,init)=>String(input).endsWith('/api/admin') ? Response.json({username:'bot-user',status:'active',role:{permissions:{users:{read:true}}}}) : original(input,init)) as typeof fetch;
    assert.equal(await testPanel(env,'secondary'),'required_user_permissions_unverified');
});
test('migration preserves dependent records, legacy identity and allows panel-scoped IDs without dropping orders', () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys=ON');
    for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(v => v.endsWith('.sql') && v<'0020').sort())
        raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    raw.exec("INSERT INTO customers(id,telegram_user_id,balance_irt) VALUES(1,'1',77); INSERT INTO orders(id,customer_id,state,selections,amount,pasarguard_username,pasarguard_user_id) VALUES('old',1,'completed','{}',10,'oldname','100'); INSERT INTO order_events(order_id,actor,action) VALUES('old','system','kept'); INSERT INTO service_notifications(order_id,kind,status) VALUES('old','usage90','pending');");
    raw.exec(readFileSync(new URL('../migrations/0020_multi_panel.sql', import.meta.url), 'utf8'));
    const row = raw.prepare("SELECT * FROM orders WHERE id='old'").get()!;
    assert.equal(row.panel_id, 'legacy');
    assert.equal(row.pasarguard_user_id, '100');
    assert.equal(row.legacy_pasarguard_user_id, '100');
    assert.equal(raw.prepare('SELECT balance_irt FROM customers').get()!.balance_irt, 77);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM order_events').get()!.n, 1);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_notifications').get()!.n, 1);
    raw.exec('BEGIN');
    raw.exec(readFileSync(new URL('../migrations/0021_dynamic_api_key_panels.sql',import.meta.url),'utf8'));
    raw.exec('COMMIT');
    raw.exec("INSERT INTO panels(id,name,auth_type) VALUES('secondary','New','api_key'); INSERT INTO orders(id,customer_id,selections,amount,panel_id,pasarguard_user_id) VALUES('new',1,'{}',10,'secondary','100');");
    assert.throws(() => raw.exec("INSERT INTO orders(id,customer_id,selections,amount,panel_id,pasarguard_user_id) VALUES('dup',1,'{}',10,'secondary','100')"));
    assert.throws(() => raw.exec("UPDATE orders SET panel_id='secondary' WHERE id='old'"));
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
    raw.close();
});
test('stale operation recovery preserves assignment and target; retry reconciles on original panel', async () => {
    await secondary();
    active('secondary');
    const id = await purchase();
    ambiguousCreate = true;
    await run(id);
    const target = (await getOrderById(db, id))?.create_target_unix;
    sqlite.prepare("UPDATE orders SET state='provisioning',updated_at='2000-01-01T00:00:00Z' WHERE id=?").run(id);
    active('legacy');
    await recoverPanelOperations(env);
    assert.equal((await getOrderById(db, id))?.state, 'failed');
    assert.equal((await getOrderById(db, id))?.panel_id, 'secondary');
    assert.equal((await run(id, true)).ok, true);
    assert.equal((await getOrderById(db, id))?.create_target_unix, target);
    assert.equal(users[0]!.size, 0);
    assert.equal(users[1]!.size, 1);
});
test('strict malformed GET is parse error, not resource absence', async () => {
    globalThis.fetch = (async () => Response.json({ unexpected: 'payload' })) as typeof fetch;
    const result = await new PasarGuardClient({ baseUrl: A, apiKey: 'SYNTHETIC' }).getUserByUsername('synthetic');
    assert.ok(!result.ok);
    if (!result.ok)
        assert.equal(result.kind, 'parse');
});
test('switch during in-flight provisioning leaves operation pinned before remote write', async () => {
    await secondary();
    active('secondary');
    delayRequest = 80;
    const id = await purchase();
    const work = run(id);
    while (!calls.some(c=>c.origin===B))
        await new Promise(r => setTimeout(r, 2));
    assert.equal((await getOrderById(db, id))?.panel_id, 'secondary');
    active('legacy');
    assert.equal((await work).ok, true);
    assert.equal(users[0]!.size, 0);
    assert.equal(users[1]!.size, 1);
});
test('simultaneous retry claims cannot create a duplicate; group snapshot survives configuration edits', async () => {
    await secondary();
    active('secondary');
    const id = await purchase();
    ambiguousCreate = true;
    await run(id);
    sqlite.prepare("UPDATE panels SET group_ids='[99]' WHERE id='secondary'").run();
    calls = [];
    const outcomes = await Promise.all([run(id, true), run(id, true)]);
    assert.equal(outcomes.filter(v => v.ok).length, 1);
    assert.equal(users[1]!.size, 1);
    assert.equal(calls.filter(v => v.path === '/api/user').length, 0);
    assert.deepEqual(JSON.parse((await getOrderById(db, id))!.panel_provision_config!).groupIds, [7]);
});
test('secondary authentication failure during live refresh/sweep does not record deletion', async () => {
    await secondary();
    active('secondary');
    const id = await purchase();
    await run(id);
    apiFailure = 403;
    active('legacy');
    await processTelegramUpdate(callbackUpdateAs(`svc:ref:${id}`, ++update, USER), env);
    await runServiceNotificationSweep(env, Date.now(), api as unknown as UpdateContext['api']);
    assert.equal((await getOrderById(db, id))?.panel_deleted_at, null);
    assert.ok(calls.every(v => v.origin === B));
});
test('free-test usage notification legs use the assigned API-key panel', async () => {
    await secondary();
    active('secondary');
    const id = newOrderId();
    await insertOrderWithEvent(db, { id, customerId: 1, selections: JSON.stringify({ free_test: true, volume_mb: 100, duration_days: 1, device_count: 1, config_name: 'Trial' }), amount: 0, currency: 'IRT', idempotencyKey: newOrderId(), initialState: 'approved' });
    sqlite.prepare('INSERT INTO free_test_claims(customer_id,order_id) VALUES(1,?)').run(id);
    assert.equal((await run(id)).ok, true);
    active('legacy');
    const s = (await getOrderById(db, id))!;
    const u = users[1]!.get(s.pasarguard_username!)!;
    u.used_traffic = 100000000;
    calls = [];
    await runServiceNotificationSweep(env, Date.now(), api as unknown as UpdateContext['api']);
    assert.equal(calls.length, 1, 'both trial decisions share one same-lease fresh panel read');
    assert.ok(calls.every(v => v.origin === B));
    assert.equal((await getOrderById(db, id))?.panel_deleted_at, null);
});
test('remote error strings and exception messages never reach persisted diagnostics', async () => {
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args) => logs.push(args.join(' '));
    try {
        globalThis.fetch = (async () => Response.json({ detail: `secret ${DYNAMIC_KEY} ${'SYNTHETIC-ERROR-KEY'}` }, { status: 500 })) as typeof fetch;
        const result = await new PasarGuardClient({ baseUrl: A, apiKey: 'SYNTHETIC' }).getUserByUsername('synthetic');
        assert.ok(!result.ok);
        assert.ok(!JSON.stringify({ result, logs }).includes(DYNAMIC_KEY));
        assert.ok(!JSON.stringify({ result, logs }).includes('SYNTHETIC-ERROR-KEY'));
    }
    finally {
        console.error = original;
    }
});
test('encrypted API-key ciphertext cannot be transplanted between panels/revisions', async () => {
    const cipher = await encrypt(env, `panel:secondary:1:${B}:credentials`, { apiKey: DYNAMIC_KEY });
    await assert.rejects(() => decrypt(env, `panel:secondary:2:${B}:credentials`, cipher));
    await assert.rejects(() => decrypt(env, `panel:legacy:1:${B}:credentials`, cipher));
    const bad = JSON.parse(cipher);
    bad.data = bad.data.slice(0, 3) + 'AAAA' + bad.data.slice(7);
    await assert.rejects(() => decrypt(env, `panel:secondary:1:${B}:credentials`, JSON.stringify(bad)));
});

test('credential replacement is encrypted and validated but cannot repoint assigned panel origin', async () => {
    await secondary();
    active('secondary');
    const id = await purchase();
    assert.equal((await run(id)).ok, true);
    await dispatch('pnl:edit:secondary');
    const token = new URL(lastButtons().find(b=>b.web_app)!.web_app!.url).searchParams.get('nonce')!;
    const request = (url:string) => new Request(`${WEB}/admin/panels/configure`, {
        method:'POST', headers:{origin:WEB,'content-type':'application/json'},
        body:JSON.stringify({nonce:token,initData:signed,name:'Second renamed',url,apiKey:DYNAMIC_KEY,groups:[99]}),
    });
    const signed = await initData();
    assert.equal((await panelAdminRoute(request(B), env)).status, 200);
    const row = (await getPanel(db,'secondary'))!;
    assert.equal(row.revision, 2);
    assert.equal(row.last_test, 'ok');
    const p = await resolvePanel(env, 'secondary');
    assert.ok(p.ok);
    if (p.ok) assert.equal((await clientFor(p.config).getCurrentAdmin()).ok, true);
    assert.equal((await getOrderById(db,id))?.panel_id, 'secondary');
    assert.deepEqual(JSON.parse((await getOrderById(db,id))!.panel_provision_config!).groupIds,[7]);
    await dispatch('pnl:edit:secondary');
    const nextToken = new URL(lastButtons().find(b=>b.web_app)!.web_app!.url).searchParams.get('nonce')!;
    const change = new Request(`${WEB}/admin/panels/configure`, {method:'POST',headers:{origin:WEB,'content-type':'application/json'},body:JSON.stringify({nonce:nextToken,initData:signed,name:'Repoint',url:'https://third.example.com',apiKey:DYNAMIC_KEY,groups:[7]})});
    assert.equal((await panelAdminRoute(change,env)).status,409);
    assert.equal((await getPanel(db,'secondary'))!.origin,B);
});

test('username 404 with surviving external ID is a rename, not deletion', async () => {
    await secondary();
    active('secondary');
    const id = await purchase();
    await run(id);
    const service = (await getOrderById(db,id))!;
    const record = users[1]!.get(service.pasarguard_username!)!;
    users[1]!.delete(service.pasarguard_username!);
    record.username = 'renameduser';
    users[1]!.set('renameduser',record);
    await processTelegramUpdate(callbackUpdateAs(`svc:ref:${id}`,++update,USER),env);
    assert.equal((await getOrderById(db,id))?.panel_deleted_at,null);
    const deleted = await deletePanelService(env,service.pasarguard_username!,service);
    assert.equal(deleted.ok,false);
    assert.equal(calls.filter(call=>call.method==='DELETE').length,0);
});

async function openConfiguration(id?:string): Promise<{id:string;token:string;url:string}> {
    await dispatch(id ? `pnl:edit:${id}` : 'pnl:add');
    const url=lastButtons().find(b=>b.web_app)!.web_app!.url;
    const token=new URL(url).searchParams.get('nonce')!;
    const session=sqlite.prepare('SELECT panel_id FROM panel_admin_sessions WHERE nonce=?').get(token)!;
    return {id:session.panel_id as string,token,url};
}
async function saveConfiguration(session:{token:string},url:string,key:string,name='Panel',groups=[7]):Promise<Response> {
    return panelAdminRoute(new Request(`${WEB}/admin/panels/configure`,{
        method:'POST',headers:{origin:WEB,'content-type':'application/json'},
        body:JSON.stringify({nonce:session.token,initData:await initData(),name,url,apiKey:key,groups}),
    }),env);
}
async function confirmAction(action:string,id:string) {
    await dispatch(`pnl:${action}:${id}`);
    const button=lastButtons().find(b=>b.callback_data?.startsWith('pnl:confirm:'));
    assert.ok(button);await dispatch(button.callback_data!);
}
test('Telegram adds three dynamic API-key panels without per-panel bindings, then switches across four destinations',async()=>{
    const b=await openConfiguration();assert.equal((await saveConfiguration(b,B,DYNAMIC_KEY,'Germany')).status,200);
    const c=await openConfiguration();assert.equal((await saveConfiguration(c,C,'SYNTHETIC-KEY-2','Netherlands')).status,200);
    const d=await openConfiguration();assert.equal((await saveConfiguration(d,D,'SYNTHETIC-KEY-3','Finland')).status,200);
    assert.equal(new Set([b.id,c.id,d.id,'legacy']).size,4);
    const services:{order:string;panel:string}[]=[];
    for(const panel of [b.id,c.id,d.id,'legacy',c.id]) {
        if(panel!=='legacy' && !(await getPanel(db,panel))!.enabled_new) await confirmAction('toggle',panel);
        await selectByTelegram(panel);
        // Selection is re-read from persistent D1 by a fresh request/client.
        assert.equal((await selection(db)).panel_id,panel);
        const order=await purchase();assert.equal((await run(order)).ok,true);
        services.push({order,panel});
    }
    for(const s of services) assert.equal((await getOrderById(db,s.order))?.panel_id,s.panel);
    assert.equal(users[0]!.size,1);assert.equal(users[1]!.size,1);assert.equal(users[2]!.size,2);assert.equal(users[3]!.size,1);
    assert.ok(!calls.some(c=>c.path.includes('/token')));
    for(const panel of [b.id,c.id,d.id]) {
        const row=(await getPanel(db,panel))!;
        assert.equal(row.auth_type,'api_key');assert.equal(row.last_test,'ok');
        assert.ok(!row.credentials!.includes('SYNTHETIC'));
    }
    await showPanels(ctx());
    const text=JSON.stringify(sent);
    assert.ok(!text.includes(DYNAMIC_KEY));assert.ok(!text.includes('SYNTHETIC-KEY-2'));
});
test('new configuration rejects bad API keys, missing permissions and group access BEFORE persistence',async()=>{
    apiFailure=401;
    let session=await openConfiguration();
    assert.equal((await saveConfiguration(session,B,DYNAMIC_KEY)).status,422);
    assert.equal(await getPanel(db,session.id),null);
    apiFailure=0;
    const original=fetch;
    globalThis.fetch=(async(input,init)=>String(input).endsWith('/api/admin') ? Response.json({username:'x',status:'active',role:{permissions:{users:{read:true}}}}) : original(input,init)) as typeof fetch;
    session=await openConfiguration();assert.equal((await saveConfiguration(session,B,DYNAMIC_KEY)).status,422);
    assert.equal(await getPanel(db,session.id),null);
    globalThis.fetch=(async(input,init)=>String(input).includes('/api/group/') ? Response.json({detail:'forbidden'},{status:403}) : original(input,init)) as typeof fetch;
    session=await openConfiguration();assert.equal((await saveConfiguration(session,B,DYNAMIC_KEY)).status,422);
    assert.equal(await getPanel(db,session.id),null);
});
test('editing may retain the encrypted key and change name/groups; origin is mutable ONLY without associations',async()=>{
    await secondary();
    const session=await openConfiguration('secondary');
    assert.equal((await saveConfiguration(session,B,'','Renamed',[7,8])).status,200);
    const row=(await getPanel(db,'secondary'))!;
    assert.equal(row.name,'Renamed');assert.equal(row.revision,2);
    assert.deepEqual(await decrypt(env,`panel:secondary:2:${B}:credentials`,row.credentials!),{apiKey:DYNAMIC_KEY});
    const next=await openConfiguration('secondary');
    assert.equal((await saveConfiguration(next,C,'SYNTHETIC-KEY-2','Moved')).status,200);
    assert.equal((await getPanel(db,'secondary'))!.origin,C);
    active('secondary');const id=await purchase();assert.equal((await run(id)).ok,true);
    const blocked=await openConfiguration('secondary');assert.equal((await saveConfiguration(blocked,B,DYNAMIC_KEY)).status,409);
    assert.throws(()=>sqlite.prepare('UPDATE panels SET origin=? WHERE id=?').run(B,'secondary'));
});
test('a failed key edit preserves the prior ciphertext and working configuration',async()=>{
    await secondary();const before=(await getPanel(db,'secondary'))!;
    apiFailure=403;
    const session=await openConfiguration('secondary');assert.equal((await saveConfiguration(session,B,DYNAMIC_KEY)).status,422);
    const after=(await getPanel(db,'secondary'))!;
    assert.equal(after.credentials,before.credentials);assert.equal(after.revision,before.revision);
});
test('duplicate panel origins are rejected; same numeric external ID is valid on DIFFERENT panels',async()=>{
    await secondary();
    const session=await openConfiguration();assert.equal((await saveConfiguration(session,B,DYNAMIC_KEY)).status,409);
    const alias=await openConfiguration();assert.equal((await saveConfiguration(alias,A,'SYNTHETIC-LEGACY-KEY')).status,409);
    await addFixture('third',C,'SYNTHETIC-KEY-2');
    for(const panel of ['legacy','secondary','third']) {active(panel);const id=await purchase();assert.equal((await run(id)).ok,true);assert.equal((await getOrderById(db,id))!.pasarguard_user_id,'100');}
});
test('safe deletion requires no assigned orders/history and not the selected panel; legacy is permanent',async()=>{
    await secondary();await confirmAction('delete','secondary');assert.equal(await getPanel(db,'secondary'),null);
    await secondary();active('secondary');await confirmAction('delete','secondary');assert.ok(await getPanel(db,'secondary'));
    active('legacy');const order=await purchase();sqlite.prepare("UPDATE orders SET panel_id='secondary' WHERE id=?").run(order);
    await confirmAction('delete','secondary');assert.ok(await getPanel(db,'secondary'));
    assert.throws(()=>sqlite.exec("DELETE FROM panels WHERE id='secondary'"));
    assert.throws(()=>sqlite.exec("DELETE FROM panels WHERE id='legacy'"));
    await dispatch('pnl:delete:legacy');assert.ok(await getPanel(db,'legacy'));
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM panel_audit WHERE action='delete' AND result='ok'").get()!.n,1);
});
test('association created after delete confirmation blocks deletion atomically',async()=>{
    await secondary();await dispatch('pnl:delete:secondary');const token=lastButtons()[0]!.callback_data!;
    const order=await purchase();sqlite.prepare("UPDATE orders SET panel_id='secondary' WHERE id=?").run(order);
    await dispatch(token);assert.ok(await getPanel(db,'secondary'));assert.ok(await getOrderById(db,order));
});
test('disabling an unavailable panel is allowed; assigned retries remain pinned and unassigned new orders stop',async()=>{
    await secondary();active('secondary');const id=await purchase();apiFailure=401;
    assert.equal((await run(id)).ok,false);
    await confirmAction('toggle','secondary');assert.equal((await getPanel(db,'secondary'))!.enabled_new,0);
    const newer=await purchase();calls=[];assert.equal((await run(newer)).ok,false);assert.equal(calls.length,0);
    await selectByTelegram('legacy');assert.equal((await run(id,true)).ok,false);
    assert.equal((await getOrderById(db,id))?.panel_id,'secondary');assert.equal(users[0]!.size,0);
});
test('DNS preflight rejects private/reserved/mixed destinations BEFORE sending a key',async()=>{
    for(const value of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','198.18.0.1','192.0.2.1','203.0.113.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00::1','2000::1::2','999.1.1.1']) assert.equal(publicAddress(value),false,value);
    for(const value of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(publicAddress(value),true,value);
    await secondary();const original=fetch;
    globalThis.fetch=(async(input,init)=>new URL(String(input)).origin==='https://cloudflare-dns.com' ? Response.json({Status:0,Answer:[{type:1,data:'8.8.8.8'},{type:1,data:'10.0.0.1'}]}) : original(input,init)) as typeof fetch;
    assert.equal(await publicDestination(B),false);
    const p=await resolvePanel(env,'secondary');assert.ok(p.ok);
    if(p.ok) {const r=await clientFor(p.config).getCurrentAdmin();assert.equal(r.ok,false);if(!r.ok) assert.equal(r.kind,'bad_url');}
    assert.equal(calls.length,0);
    const session=await openConfiguration();assert.equal((await saveConfiguration(session,C,'SYNTHETIC-KEY-2')).status,422);assert.equal(calls.length,0);
});
test('redirects are never followed and transport errors never leak keys',async()=>{
    await secondary();const original=fetch;
    globalThis.fetch=(async(input,init)=>{
        if(new URL(String(input)).origin===B) {assert.equal(init?.redirect,'manual');throw new Error(`unsafe redirect ${DYNAMIC_KEY}`);}
        return original(input,init);
    }) as typeof fetch;
    const logs:string[]=[],log=console.error;console.error=(...a)=>logs.push(a.join(' '));
    try {const session=await openConfiguration('secondary');const r=await saveConfiguration(session,B,DYNAMIC_KEY);assert.equal(r.status,422);assert.ok(!JSON.stringify({logs,sent,body:await r.text()}).includes(DYNAMIC_KEY));}
    finally {console.error=log;}
});
test('list is paginated and does not assume panel count or show decrypted keys',async()=>{
    for(let i=0;i<12;i++) sqlite.prepare("INSERT INTO panels(id,name,origin) VALUES(?,?,?)").run(`panel${i}`,`Name${i}`,`https://panel${i}.example.com`);
    await showPanels(ctx());assert.ok(String(sent.at(-1)!.text).includes('Page 1/3'));
    assert.ok(lastButtons().some(b=>b.callback_data==='pnl:list:1'));
    await dispatch('pnl:list:2');assert.ok(String(sent.at(-1)!.text).includes('Page 3/3'));
    assert.ok(lastButtons().some(b=>b.callback_data==='pnl:list:1'));
});
test('100-panel limit is enforced even by a configuration session issued before the limit was reached',async()=>{
    const session=await openConfiguration();
    for(let i=0;i<99;i++) sqlite.prepare('INSERT INTO panels(id,name,origin) VALUES(?,?,?)').run(`panel${i}`,`Name${i}`,`https://panel${i}.example.com`);
    assert.equal((await saveConfiguration(session,B,DYNAMIC_KEY)).status,409);assert.equal(await getPanel(db,session.id),null);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM panels').get()!.n,100);
});
test('another administrator cannot consume an actor-bound form or confirmation',async()=>{
    await secondary();env.PANEL_ADMIN_IDS=String(USER.id);
    const form=await openConfiguration('secondary');
    const response=await panelAdminRoute(new Request(`${WEB}/admin/panels/configure`,{method:'POST',headers:{origin:WEB,'content-type':'application/json'},body:JSON.stringify({nonce:form.token,initData:await initData(USER.id),name:'Stolen',url:B,apiKey:DYNAMIC_KEY,groups:[7]})}),env);
    assert.equal(response.status,403);
    await dispatch('pnl:select:secondary');const token=lastButtons()[0]!.callback_data!;
    await dispatch(token,USER);assert.equal((await selection(db)).panel_id,'legacy');
    await dispatch(token);assert.equal((await selection(db)).panel_id,'secondary');
});
test('changing encrypted-row origin without re-encryption fails authentication rather than leaking the key',async()=>{
    await secondary();sqlite.prepare("UPDATE panels SET origin=? WHERE id='secondary'").run(C);
    assert.equal((await resolvePanel(env,'secondary')).ok,false);assert.equal(calls.length,0);
});
test('legacy rename through Telegram leaves original Worker URL/API key intact',async()=>{
    const before=await resolvePanel(env,'legacy');assert.ok(before.ok);
    const session=await openConfiguration('legacy');
    assert.equal((await saveConfiguration(session,C,'IGNORED-KEY','My legacy')).status,200);
    assert.equal((await getPanel(db,'legacy'))!.name,'My legacy');
    assert.equal(env.PASARGUARD_PANEL_URL,A);assert.equal(env.PASARGUARD_API_KEY,'SYNTHETIC-LEGACY-KEY');
    const id=await purchase();assert.equal((await run(id)).ok,true);assert.ok(calls.every(c=>c.origin===A));
});
test('0021 preserves a deployed 0020 secondary service and removes obsolete secrets without reassignment',()=>{
    const raw=new DatabaseSync(':memory:');raw.exec('PRAGMA foreign_keys=ON');
    for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(v=>v.endsWith('.sql')&&v<'0021').sort()) raw.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
    raw.exec("INSERT INTO customers(id,telegram_user_id,balance_irt) VALUES(1,'88',123); INSERT INTO panels(id,name,origin,auth_type,credentials,enabled_new,group_ids,token_ciphertext,token_lease,login_safe) VALUES('secondary','Keep','https://second.example.com','password','encrypted-old-password',1,'[7]','encrypted-token','lease',1); UPDATE panel_selection SET panel_id='secondary'; INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,pasarguard_user_id,pasarguard_username) VALUES('kept',1,'completed','{}',10,'secondary','100','oldname'); INSERT INTO order_events(order_id,actor,action) VALUES('kept','system','kept'); INSERT INTO service_notifications(order_id,kind,status) VALUES('kept','usage90','pending');");
    raw.exec('BEGIN');raw.exec(readFileSync(new URL('../migrations/0021_dynamic_api_key_panels.sql',import.meta.url),'utf8'));raw.exec('COMMIT');
    const p=raw.prepare("SELECT * FROM panels WHERE id='secondary'").get()!;
    assert.equal(p.id,'secondary');assert.equal(p.credentials,null);assert.equal(p.enabled_new,0);assert.equal(p.auth_type,'api_key');assert.equal(p.last_test,'api_key_required');
    assert.equal(raw.prepare("SELECT panel_id FROM orders WHERE id='kept'").get()!.panel_id,'secondary');
    assert.equal(raw.prepare('SELECT panel_id FROM panel_selection').get()!.panel_id,'legacy');
    assert.equal(raw.prepare('SELECT balance_irt FROM customers').get()!.balance_irt,123);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM order_events').get()!.n,1);assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_notifications').get()!.n,1);
    assert.ok(!raw.prepare('PRAGMA table_info(panels)').all().some(c=>['token_ciphertext','login_safe','token_lease'].includes(c.name as string)));
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);raw.close();
});
test('unauthorized callbacks cannot add, edit, test, select, disable or delete panels',async()=>{
    await secondary();const before=JSON.stringify(sqlite.prepare('SELECT * FROM panels ORDER BY id').all());
    for(const action of ['pnl:add','pnl:list:0','pnl:edit:secondary','pnl:test:secondary','pnl:select:secondary','pnl:toggle:secondary','pnl:delete:secondary']) await dispatch(action,USER);
    assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM panels ORDER BY id').all()),before);
    assert.equal(calls.length,0);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM panel_admin_sessions').get()!.n,0);
    assert.equal((await selection(db)).panel_id,'legacy');
});
test('admin payment approval and duplicate Telegram delivery use the newly selected third panel once',async()=>{
    await secondary();await addFixture('third',C,'SYNTHETIC-KEY-2');
    active('secondary');const id=await purchase();sqlite.prepare("UPDATE orders SET state='awaiting_review',receipt_file_id='receipt-kept',payment_reference='reference-kept' WHERE id=?").run(id);
    await selectByTelegram('third');await dispatch(`adm:ok:${id}`);
    const row=(await getOrderById(db,id))!;assert.equal(row.state,'completed');assert.equal(row.panel_id,'third');assert.equal(row.receipt_file_id,'receipt-kept');assert.equal(row.payment_reference,'reference-kept');
    await dispatch(`adm:ok:${id}`);assert.equal(calls.filter(c=>c.method==='POST'&&c.path==='/api/user').length,1);
    assert.equal(users[1]!.size,0);assert.equal(users[2]!.size,1);
});
test('actual Telegram free-trial creation and approved-order cron recovery use selected arbitrary panel',async()=>{
    await addFixture('third',C,'SYNTHETIC-KEY-2');await selectByTelegram('third');
    await dispatch('tst:claim',USER);
    const trial=sqlite.prepare("SELECT o.* FROM orders o JOIN free_test_claims f ON f.order_id=o.id").get()!;
    assert.ok(trial);assert.equal(trial.panel_id,'third');assert.equal(trial.state,'completed');
    const approved=await purchase();await recoverPanelOperations(env);
    assert.equal((await getOrderById(db,approved))?.state,'completed');assert.equal((await getOrderById(db,approved))?.panel_id,'third');
    assert.equal(users[0]!.size,0);assert.equal(users[2]!.size,2);
});
test('0021 retains customer, payment, wallet, referral, trial and operation-lock records byte-for-byte',()=>{
    const raw=new DatabaseSync(':memory:');raw.exec('PRAGMA foreign_keys=ON');
    for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(v=>v.endsWith('.sql')&&v<'0021').sort())raw.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
    raw.exec(`INSERT INTO customers(id,telegram_user_id,balance_irt) VALUES(1,'1',500),(2,'2',300);
      INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,pasarguard_user_id,legacy_pasarguard_user_id,pasarguard_username,receipt_file_id,payment_reference) VALUES('paid',1,'completed','{}',100,'legacy','77','77','paidname','receipt','payment');
      INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,create_target_unix,provision_claim) VALUES('pending',2,'provisioning','{}',50,'legacy',2000000000,'claim');
      INSERT INTO wallet_entries(id,customer_id,delta_irt,kind,order_id,actor,balance_after) VALUES('entry',1,-100,'order_payment','paid','customer',500);
      INSERT INTO wallet_topups(id,customer_id,amount_irt,state,idempotency_key,receipt_file_id) VALUES('topup',1,50000,'approved','topup-key','topup-receipt');
      INSERT INTO referral_rewards(referred_customer_id,referrer_customer_id,order_id,amount_irt) VALUES(2,1,'paid',10);
      INSERT INTO free_test_claims(customer_id,order_id) VALUES(2,'paid');
      INSERT INTO order_events(order_id,actor,action) VALUES('paid','system','kept');
      INSERT INTO service_notifications(order_id,kind,status) VALUES('paid','usage90','pending');
      INSERT INTO panel_service_locks(service_id,owner,expires_at) VALUES('pending','lock',9999999999999);`);
    const tables=['customers','orders','wallet_entries','wallet_topups','referral_rewards','free_test_claims','order_events','service_notifications','panel_service_locks','settings'];
    const before=tables.map(t=>JSON.stringify(raw.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
    raw.exec('BEGIN');raw.exec(readFileSync(new URL('../migrations/0021_dynamic_api_key_panels.sql',import.meta.url),'utf8'));raw.exec('COMMIT');
    tables.forEach((t,i)=>assert.equal(JSON.stringify(raw.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()),before[i],t));
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);raw.close();
});
test('0021 integrity guard rejects inconsistent historical FK data and rolls back the registry upgrade',()=>{
    const raw=new DatabaseSync(':memory:');
    for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(v=>v.endsWith('.sql')&&v<'0021').sort())raw.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
    raw.exec("PRAGMA foreign_keys=OFF; INSERT INTO orders(id,customer_id,selections,amount,panel_id) VALUES('orphan',999,'{}',1,'legacy'); PRAGMA foreign_keys=ON;");
    const before=JSON.stringify(raw.prepare('SELECT * FROM panels').all());
    raw.exec('BEGIN');assert.throws(()=>raw.exec(readFileSync(new URL('../migrations/0021_dynamic_api_key_panels.sql',import.meta.url),'utf8')));raw.exec('ROLLBACK');
    assert.equal(JSON.stringify(raw.prepare('SELECT * FROM panels').all()),before);
    assert.ok(raw.prepare('PRAGMA table_info(panels)').all().some(c=>c.name==='token_ciphertext'));
    assert.equal(raw.prepare("SELECT panel_id FROM orders WHERE id='orphan'").get()!.panel_id,'legacy');raw.close();
});

test('assigned provisioning retry never loads mutable default-panel selection',async()=>{
 await secondary();active('secondary');const id=await purchase();apiFailure=503;assert.equal((await run(id)).ok,false);
 assert.equal((await getOrderById(db,id))!.panel_id,'secondary');active('legacy');apiFailure=0;calls=[];
 const base=db,queries:string[]=[];db={...base,prepare(sql:string){queries.push(sql);return base.prepare(sql);}} as D1Database;env.DB=db;
 assert.equal((await run(id,true)).ok,true);assert.ok(calls.length>0);assert.ok(calls.every(c=>c.origin===B));
 assert.equal(queries.filter(q=>q.startsWith('SELECT panel_id,revision FROM panel_selection')).length,0);
});
test('unassigned provisioning reads fresh default revision and post-claim helper uses exactly two validated reads',async()=>{
 const id=await purchase();let selects=0;const base=db,wrapped={...base,prepare(sql:string){if(sql.startsWith('SELECT * FROM effective_orders WHERE id'))selects++;return base.prepare(sql);}} as D1Database;
 const {claimOrderForProvisioning}=await import('../src/db/orders.ts');const claim=await claimOrderForProvisioning(wrapped,{orderId:id,fromState:'approved',maxAttempts:3,panelId:'legacy',panelRevision:1,selectionRevision:1});
 assert.ok(claim.ok);assert.equal(selects,2);if(claim.ok){assert.ok(claim.order.provision_claim);assert.equal(claim.order.state,'provisioning');assert.equal(claim.order.panel_id,'legacy');}
});
test('trial polling reuses data only in one held lease and obtains a fresh read on later eligible sweep',async()=>{
 const id=await purchase();sqlite.prepare("INSERT INTO free_test_claims(customer_id,order_id) VALUES(1,?)").run(id);assert.equal((await run(id)).ok,true);
 const {acquireServiceLock,releaseServiceLock}=await import('../src/panels/registry.ts');assert.ok(await acquireServiceLock(db,id,'other-operator'));calls=[];
 await runServiceNotificationSweep(env,Date.now(),api as unknown as UpdateContext['api']);assert.equal(calls.length,0);await releaseServiceLock(db,id,'other-operator');
 await runServiceNotificationSweep(env,Date.now(),api as unknown as UpdateContext['api']);assert.equal(calls.filter(c=>c.method==='GET').length,1);
 calls=[];await runServiceNotificationSweep(env,Date.now()+61*60000,api as unknown as UpdateContext['api']);assert.equal(calls.filter(c=>c.method==='GET').length,1,'no observation reused after lease release');
});
