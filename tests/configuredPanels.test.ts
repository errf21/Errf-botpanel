/** Real handlers/provisioner with independent offline PasarGuard panels; SQLite D1 shim. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, makeD1Shim, ADMIN, USER } from './helpers.ts';
import { configuredPanels, syncConfiguredPanels } from '../src/panels/bindings.ts';
import { resolvePanel, clientFor, selection } from '../src/panels/registry.ts';
import { panelCallback, showPanels, panelAdminRoute } from '../src/panels/admin.ts';
import { panelInputOrigin, panelOrigin } from '../src/panels/security.ts';
import { insertOrderWithEvent, getOrderById } from '../src/db/orders.ts';
import { provisionOrder, deletePanelService } from '../src/provision/provision.ts';
import { recoverPanelOperations } from '../src/panels/recovery.ts';
import { processTelegramUpdate } from '../src/dispatch.ts';
import { runServiceNotificationSweep } from '../src/handlers/serviceNotifications.ts';
import { callbackUpdateAs } from './helpers.ts';
import { newOrderId } from '../src/lib/security.ts';
import { uiFor } from '../src/telegram/i18n.ts';
import type { Env, UpdateContext } from '../src/types.ts';
let raw: ReturnType<typeof freshDb>, env: Env, real: typeof fetch, ctx: UpdateContext;
let calls: {
    origin: string;
    path: string;
    method: string;
}[], messages: string[], forms: string[], blocked: boolean, failPanel: string | null, crashCreate: boolean, switchOnCreate: boolean;
let users: Map<string, any>[];
const origins = Array.from({ length: 10 }, (_, n) => `https://cf${n + 1}.example.com`), keys = origins.map((_, n) => `SYNTHETIC-CONFIGURED-KEY-${n + 1}`), WEB = 'https://bot.example.com';
function set(name: string, value: unknown) { (env as unknown as Record<string, unknown>)[name] = value; }
function indexed(n: number) { set('PANEL_COUNT', String(n)); for (let i = 1; i <= n; i++) {
    set(`PANEL_${i}_URL`, origins[i - 1]);
    set(`PANEL_${i}_API_KEY`, keys[i - 1]);
    set(`PANEL_${i}_NAME`, `Configured ${i}`);
    set(`PANEL_${i}_GROUP_IDS`, JSON.stringify([i]));
} }
beforeEach(() => {
    raw = freshDb();
    const db = makeD1Shim(raw) as unknown as D1Database;
    env = { DB: db, TELEGRAM_BOT_TOKEN: 'SYNTHETIC-BOT-TOKEN', ADMIN_CHAT_ID: String(ADMIN.id), PANEL_ADMIN_ORIGIN: WEB, PASARGUARD_PANEL_URL: 'https://legacy.example.com', PASARGUARD_API_KEY: 'SYNTHETIC-LEGACY-KEY', PANEL_ENCRYPTION_KEY: btoa('z'.repeat(32)) };
    raw.prepare('INSERT INTO customers(telegram_user_id) VALUES(?)').run(String(USER.id));
    indexed(3);
    calls = [];
    messages = [];
    forms = [];
    users = origins.map(() => new Map());
    blocked = false;
    failPanel = null;
    crashCreate = switchOnCreate = false;
    real = fetch;
    const api = { sendMessage: async (_chat: number, text: string, kb: any) => { messages.push(text); if (kb?.inline_keyboard?.[0]?.[0]?.web_app)
            forms.push(kb.inline_keyboard[0][0].web_app.url); }, answerCallbackQuery: async (_id: string, text: string) => { if (text)
            messages.push(text); }, editMessageText: async () => { } };
    ctx = { env, db, api, actor: { id: ADMIN.id }, chatId: ADMIN.id, customerId: 1, isAdmin: true, ui: uiFor('en') } as unknown as UpdateContext;
    globalThis.fetch = (async (input, init) => {
        const u = new URL(String(input)), method = init?.method ?? 'GET';
        if (u.origin === 'https://api.telegram.org')
            return Response.json({ ok: true, result: { message_id: 1 } });
        if (u.origin === 'https://cloudflare-dns.com')
            return Response.json({ Status: 0, Answer: [{ type: 1, data: blocked ? '127.0.0.1' : '8.8.8.8' }] });
        const n = origins.indexOf(u.origin);
        assert.ok(n >= 0, 'No fallback or unintended destination');
        assert.equal(new Headers(init?.headers).get('x-api-key'), keys[n]);
        assert.equal(new Headers(init?.headers).get('authorization'), null);
        assert.equal(init?.redirect, 'manual');
        calls.push({ origin: u.origin, path: u.pathname, method });
        if (failPanel === u.origin)
            return Response.json({ detail: keys[n] }, { status: 401 });
        if (u.pathname === '/api/admin')
            return Response.json({ username: 'operator', status: 'active', role: { is_owner: true } });
        if (u.pathname === '/api/groups')
            return Response.json({ groups: [{ id: n + 1, name: `Actual ${n + 1}` }], total: 1 });
        if (u.pathname.startsWith('/api/group/'))
            return Response.json({ id: Number(u.pathname.split('/').at(-1)), is_disabled: false });
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        if (u.pathname === '/api/user' && method === 'POST') {
            const row = raw.prepare('SELECT * FROM orders WHERE pasarguard_username=?').get(body.username)!;
            assert.equal(row.panel_id, `cf_${n + 1}`);
            assert.ok(row.panel_provision_config);
            assert.deepEqual(body.group_ids, [n + 1]);
            if (switchOnCreate) {
                switchOnCreate = false;
                raw.exec("UPDATE panel_selection SET panel_id='cf_3',revision=revision+1");
            }
            const user = { ...body, id: 101 + users[n]!.size, used_traffic: 0, subscription_url: `/sub/${body.username}` };
            users[n]!.set(body.username, user);
            if (crashCreate) {
                crashCreate = false;
                throw Error('Synthetic unknown creation outcome');
            }
            return Response.json(user);
        }
        const username = u.pathname.startsWith('/api/user/by-username/') ? decodeURIComponent(u.pathname.slice('/api/user/by-username/'.length).replace(/\/reset$/, '')) : null;
        const user = username ? users[n]!.get(username) : [...users[n]!.values()].find(v => String(v.id) === u.pathname.split('/')[4]);
        if (!user)
            return Response.json({ detail: 'User not found' }, { status: 404 });
        if (method === 'DELETE') {
            users[n]!.delete(user.username);
            return new Response(null, { status: 204 });
        }
        if (method === 'PUT')
            Object.assign(user, body);
        if (method === 'POST' && u.pathname.endsWith('/reset')) {
            user.used_traffic = 0;
            user.subscription_url += '/rotated';
        }
        return Response.json(user);
    }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = real; raw.close(); });
async function action(name: string, id: string) { await panelCallback(ctx, `pnl:${name}:${id}`, 'test'); if (['toggle', 'select', 'delete'].includes(name)) {
    const s = raw.prepare('SELECT nonce FROM panel_admin_sessions WHERE actor=? AND action=? ORDER BY expires_at DESC LIMIT 1').get(String(ADMIN.id), name);
    if (s)
        await panelCallback(ctx, 'pnl:confirm:' + s.nonce, 'test');
} }
async function ready() { await syncConfiguredPanels(env); for (let n = 1; n <= 3; n++) {
    await action('test', `cf_${n}`);
    await action('toggle', `cf_${n}`);
} }
async function purchase() { const id = newOrderId(); await insertOrderWithEvent(env.DB, { id, customerId: 1, selections: JSON.stringify({ volume_gb: 10, duration_days: 30, device_count: 1, config_name: 'Configured' }), amount: 100, currency: 'IRT', idempotencyKey: newOrderId(), initialState: 'approved' }); return id; }
async function run(id: string, retry = false) { return provisionOrder({ env, db: env.DB, api: ctx.api }, { orderId: id, retry }); }
async function signed(actor = ADMIN.id) { const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: actor }) }), sign = async (key: Uint8Array, text: string) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(text))); const secret = await sign(new TextEncoder().encode('WebAppData'), env.TELEGRAM_BOT_TOKEN); const data = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n'); p.set('hash', [...await sign(secret, data)].map(x => x.toString(16).padStart(2, '0')).join('')); return p.toString(); }
async function form() { await action('edit', 'cf_1'); return new URL(forms.at(-1)!).searchParams.get('nonce')!; }
async function post(path: string, token: string, extra: any = {}) { return panelAdminRoute(new Request(WEB + '/admin/panels/' + path, { method: 'POST', headers: { origin: WEB, 'content-type': 'application/json' }, body: JSON.stringify({ nonce: token, initData: await signed(), url: origins[0], apiKey: '', name: 'Renamed', groups: [1], ...extra }) }), env); }
for (const n of [2, 3, 10])
    test(`register ${n} bindings without source edits; never store secrets or reset selection`, async () => { indexed(n); assert.deepEqual(await syncConfiguredPanels(env), []); assert.equal(raw.prepare('SELECT COUNT(*) n FROM panels').get()!.n, n + 1); assert.equal((await selection(env.DB)).panel_id, 'legacy'); assert.equal(calls.length, 0); const rows = raw.prepare('SELECT * FROM panels').all(); for (const r of rows.filter(r => r.id !== 'legacy')) {
        assert.equal(r.credentials, null);
        assert.equal(r.enabled_new, 0);
        assert.ok(r.binding_fingerprint);
    } for (const key of keys)
        assert.ok(!JSON.stringify(rows).includes(key)); });
test('repeat sync preserves configured names/groups, enabled state, selection and audit history', async () => { await ready(); await action('select', 'cf_2'); raw.exec("UPDATE panels SET name='Telegram name',group_ids='[7]' WHERE id='cf_1'"); const before = JSON.stringify(raw.prepare('SELECT * FROM panels').all()), sel = await selection(env.DB), audit = raw.prepare('SELECT COUNT(*) n FROM panel_audit').get()!.n; await syncConfiguredPanels(env); assert.equal(JSON.stringify(raw.prepare('SELECT * FROM panels').all()), before); assert.deepEqual(await selection(env.DB), sel); assert.equal(raw.prepare('SELECT COUNT(*) n FROM panel_audit').get()!.n, audit); indexed(4); await syncConfiguredPanels(env); assert.deepEqual(await selection(env.DB), sel); assert.equal(raw.prepare("SELECT name FROM panels WHERE id='cf_1'").get()!.name, 'Telegram name'); });
test('concurrent initialization creates one registry row and register audit per panel', async () => { await Promise.all([syncConfiguredPanels(env), syncConfiguredPanels(env)]); assert.equal(raw.prepare('SELECT COUNT(*) n FROM panels').get()!.n, 4); assert.equal(raw.prepare("SELECT COUNT(*) n FROM panel_audit WHERE action='binding_register'").get()!.n, 3); });
for (const value of [undefined, '', 'has spaces in secret', 'nonascii-کلید', 'control\nkey'])
    test(`invalid secret ${String(value)} quarantines one panel only`, async () => { set('PANEL_2_API_KEY', value); await syncConfiguredPanels(env); assert.equal((await resolvePanel(env, 'cf_2')).ok, false); assert.equal((await resolvePanel(env, 'cf_1')).ok, true); assert.equal((await selection(env.DB)).panel_id, 'legacy'); });
for (const url of ['http://unsafe.example.com', 'https://127.0.0.1', 'https://localhost', 'https://cf2.example.com:444', 'https://u:p@cf2.example.com', 'https://cf2.example.com/?key=unsafe'])
    test(`invalid binding destination rejects ${url}`, async () => { set('PANEL_2_URL', url); await syncConfiguredPanels(env); assert.equal((await resolvePanel(env, 'cf_2')).ok, false); assert.equal((await resolvePanel(env, 'cf_1')).ok, true); assert.equal(calls.length, 0); });
test('duplicate origins and legacy aliases are rejected without breaking the unique owner', async () => { set('PANEL_2_URL', origins[0]); set('PANEL_3_URL', env.PASARGUARD_PANEL_URL); const issues = await syncConfiguredPanels(env); assert.ok(issues.includes('binding_duplicate_origin')); assert.ok(issues.includes('binding_duplicate_legacy')); assert.equal((await resolvePanel(env, 'cf_1')).ok, true); assert.equal((await resolvePanel(env, 'cf_2')).ok, false); assert.equal((await resolvePanel(env, 'cf_3')).ok, false); const before = JSON.stringify(raw.prepare('SELECT * FROM panels').all()); await syncConfiguredPanels(env); assert.equal(JSON.stringify(raw.prepare('SELECT * FROM panels').all()), before); });
test('manifest and sharded manifest use explicit secret references and stable named IDs', async () => { set('PANEL_COUNT', undefined); const entries = origins.slice(0, 3).map((url, i) => ({ id: `cf_named${i + 1}`, name: `Named ${i + 1}`, url, apiKeyBinding: `PANEL_${i + 1}_API_KEY`, groupIds: [i + 1] })); set('PANEL_MANIFEST', JSON.stringify(entries)); await syncConfiguredPanels(env); assert.equal((await resolvePanel(env, 'cf_named3')).ok, true); set('PANEL_MANIFEST', undefined); set('PANEL_MANIFEST_COUNT', '2'); set('PANEL_MANIFEST_1', JSON.stringify(entries.slice(0, 2))); set('PANEL_MANIFEST_2', JSON.stringify(entries.slice(2))); const before = JSON.stringify(raw.prepare('SELECT * FROM panels').all()); await syncConfiguredPanels(env); assert.equal(JSON.stringify(raw.prepare('SELECT * FROM panels').all()), before); });
test('ambiguous modes, excessive count, invalid/oversized manifests fail closed', async () => { set('PANEL_MANIFEST', '[]'); assert.deepEqual((await configuredPanels(env)).issues, ['binding_modes_conflict']); set('PANEL_MANIFEST', undefined); set('PANEL_COUNT', '100'); assert.deepEqual((await configuredPanels(env)).issues, ['binding_count_invalid']); set('PANEL_COUNT', undefined); for (const value of ['{}', 'not json', ' '.repeat(5121)]) {
    set('PANEL_MANIFEST', value);
    assert.deepEqual((await configuredPanels(env)).issues, ['binding_manifest_1_invalid']);
} });
test('missing bot authentication secret cannot create a usable managed credential', async () => { env.TELEGRAM_BOT_TOKEN = ' '; await syncConfiguredPanels(env); assert.equal((await resolvePanel(env, 'cf_1')).ok, false); assert.equal(raw.prepare("SELECT binding_fingerprint FROM panels WHERE id='cf_1'").get()!.binding_fingerprint, null); });
test('URL slot reuse never sends the replacement key to the historic host', async () => { await ready(); await action('select', 'cf_1'); set('PANEL_1_URL', origins[4]); set('PANEL_1_API_KEY', keys[4]); await syncConfiguredPanels(env); assert.equal(raw.prepare("SELECT origin FROM panels WHERE id='cf_1'").get()!.origin, origins[0]); assert.equal((await resolvePanel(env, 'cf_1')).ok, false); assert.equal((await selection(env.DB)).panel_id, 'cf_1'); assert.equal(raw.prepare("SELECT enabled_new FROM panels WHERE id='cf_1'").get()!.enabled_new, 0); });
test('secret rotation requires explicit re-test/re-enable without changing selection', async () => { await ready(); await action('select', 'cf_2'); set('PANEL_2_API_KEY', 'SYNTHETIC-ROTATED-KEY'); assert.equal((await resolvePanel(env, 'cf_2')).ok, false); await syncConfiguredPanels(env); assert.equal((await resolvePanel(env, 'cf_2')).ok, true); assert.equal(raw.prepare("SELECT enabled_new FROM panels WHERE id='cf_2'").get()!.enabled_new, 0); assert.equal((await selection(env.DB)).panel_id, 'cf_2'); });
test('declaration removal retains history and selected ID, blocks access and does not fallback', async () => { await ready(); await action('select', 'cf_3'); const id = await purchase(); assert.equal((await run(id)).ok, true); indexed(2); await syncConfiguredPanels(env); assert.equal((await selection(env.DB)).panel_id, 'cf_3'); assert.equal((await resolvePanel(env, 'cf_3')).ok, false); assert.equal((await getOrderById(env.DB, id))!.panel_id, 'cf_3'); assert.ok(raw.prepare("SELECT id FROM panels WHERE id='cf_3'").get()); });
test('three selected panels create independent users with same external IDs and owned URLs', async () => { await ready(); const services = []; for (let n = 1; n <= 3; n++) {
    await action('select', `cf_${n}`);
    const id = await purchase();
    assert.equal((await run(id)).ok, true);
    const row = (await getOrderById(env.DB, id))!;
    assert.equal(row.panel_id, `cf_${n}`);
    assert.ok(row.subscription_url!.startsWith(origins[n - 1]!));
    services.push(row);
} await action('select', 'cf_1'); for (const s of services) {
    const r = await resolvePanel(env, s.panel_id!);
    assert.ok(r.ok);
    const response = await clientFor(r.config, s.pasarguard_user_id).getUserByUsername(s.pasarguard_username!);
    assert.ok(response.ok);
    assert.equal(s.pasarguard_user_id, '101');
} assert.equal(raw.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 3); });
test('default switch during creation cannot move the persisted purchase or URL', async () => { await ready(); await action('select', 'cf_1'); switchOnCreate = true; const id = await purchase(); assert.equal((await run(id)).ok, true); const s = (await getOrderById(env.DB, id))!; assert.equal(s.panel_id, 'cf_1'); assert.equal((await selection(env.DB)).panel_id, 'cf_3'); assert.ok(s.subscription_url!.startsWith(origins[0]!)); assert.equal(users[0]!.size, 1); assert.equal(users[2]!.size, 0); });
test('unknown create outcome reconciles on assigned panel after switch without duplicate creation', async () => { await ready(); await action('select', 'cf_2'); crashCreate = true; const id = await purchase(); await run(id); assert.equal((await getOrderById(env.DB, id))!.panel_id, 'cf_2'); await action('select', 'cf_3'); await run(id, true); assert.equal((await getOrderById(env.DB, id))!.state, 'completed'); assert.equal(calls.filter(c => c.method === 'POST' && c.path === '/api/user').length, 1); assert.equal(users[1]!.size, 1); assert.equal(users[2]!.size, 0); });
test('unavailable selected panel fails safely; other configured panels remain operational', async () => { await ready(); await action('select', 'cf_2'); failPanel = origins[1]!; const id = await purchase(); assert.equal((await run(id)).ok, false); assert.ok(calls.filter(c => c.path.startsWith('/api/user')).every(c => c.origin === origins[1])); await action('select', 'cf_3'); const next = await purchase(); assert.equal((await run(next)).ok, true); assert.equal((await getOrderById(env.DB, id))!.panel_id, 'cf_2'); });
test('disabled panel remains usable for existing deletion but cannot receive new purchases', async () => { await ready(); await action('select', 'cf_1'); const id = await purchase(); await run(id); const s = (await getOrderById(env.DB, id))!; assert.equal(s.state, 'completed'); await action('toggle', 'cf_1'); const next = await purchase(); assert.equal((await run(next)).ok, false); await action('select', 'cf_3'); await deletePanelService(env, s.pasarguard_username!, s); assert.equal(users[0]!.size, 0); assert.equal(users[2]!.size, 0); });
test('declared panel cannot be deleted, and unauthorised callbacks cannot sync or select', async () => { await syncConfiguredPanels(env); await action('delete', 'cf_1'); assert.ok(raw.prepare("SELECT id FROM panels WHERE id='cf_1'").get()); indexed(4); const untrusted = { ...ctx, actor: { id: USER.id }, chatId: USER.id }; for (const a of ['test', 'select', 'toggle', 'edit', 'delete'])
    await panelCallback(untrusted, `pnl:${a}:cf_1`, 'attack'); await showPanels(untrusted); assert.equal(raw.prepare("SELECT id FROM panels WHERE id='cf_4'").get(), undefined); assert.equal((await selection(env.DB)).panel_id, 'legacy'); assert.ok(!messages.join('\n').includes(keys[0]!)); });
test('managed Mini App metadata requires fresh owned authentication and never returns secrets', async () => { await syncConfiguredPanels(env); const token = await form(); const shell = await panelAdminRoute(new Request(WEB + '/admin/panels?nonce=' + token), env); assert.equal(shell.headers.get('x-errf-panel-ui'), 'cloudflare-bindings-v1'); const text = await shell.text(); assert.ok(!text.includes(origins[0]!)); assert.ok(!text.includes(keys[0]!)); for (const initData of ['', await signed(USER.id)])
    assert.equal((await post('metadata', token, { initData })).status, 403); const good = await post('metadata', token); assert.equal(good.status, 200); const metadata = await good.json() as any; assert.equal(metadata.managed, true); assert.equal(metadata.url, origins[0]); assert.equal(metadata.hasApiKey, true); assert.ok(!JSON.stringify(metadata).includes(keys[0]!)); });
test('managed visual groups discover/save real IDs; URL and secret stay Worker-owned', async () => { await syncConfiguredPanels(env); let token = await form(); const res = await post('groups', token); assert.equal(res.status, 200); assert.deepEqual(await res.json(), { groups: [{ id: 1, name: 'Actual 1' }] }); assert.equal((await post('configure', token)).status, 200); const r = raw.prepare("SELECT * FROM panels WHERE id='cf_1'").get()!; assert.equal(r.name, 'Renamed'); assert.equal(r.group_ids, '[1]'); assert.equal(r.credentials, null); assert.equal((await resolvePanel(env, 'cf_1')).ok, true); for (const extra of [{ url: origins[1] }, { apiKey: keys[0] }]) {
    token = await form();
    assert.equal((await post('configure', token, extra)).status, 409);
} token = await form(); assert.equal((await post('configure', token, { name: keys[0] })).status, 400); assert.ok(!JSON.stringify(raw.prepare('SELECT * FROM panels').all()).includes(keys[0]!)); });
test('dashboard normalization is distinct from syntax, DNS and permission failures', async () => { assert.equal(panelInputOrigin('https://panel.MraPanel.shop:8000/dashboard/#/login'), 'https://panel.mrapanel.shop:8000'); assert.equal(panelOrigin('https://panel.mrapanel.shop:8000'), 'https://panel.mrapanel.shop:8000'); assert.equal(panelInputOrigin('https://panel.mrapanel.shop:444'), null); set('PANEL_1_URL', origins[0] + '/dashboard/#/login'); await syncConfiguredPanels(env); assert.equal((await resolvePanel(env, 'cf_1')).ok, true); const token = await form(); blocked = true; const res = await post('groups', token); assert.equal(res.status, 502); assert.deepEqual(await res.json(), { code: 'destination_check_failed' }); assert.equal(calls.length, 0); blocked = false; failPanel = origins[0]!; assert.deepEqual(await (await post('groups', token)).json(), { code: 'key_rejected' }); });
test('renewal, repurchase/reset, status/URL callbacks and notifications use original managed panel', async () => {
    await ready();
    await action('select', 'cf_1');
    const id = await purchase();
    assert.equal((await run(id)).ok, true);
    await action('select', 'cf_3');
    calls = [];
    await processTelegramUpdate(callbackUpdateAs('svc:ref:' + id, 920000, USER), env);
    assert.ok(calls.length);
    assert.ok(calls.every(c => c.origin === origins[0]));
    const renewal = newOrderId();
    await insertOrderWithEvent(env.DB, { id: renewal, customerId: 1, kind: 'renewal', renewsOrderId: id, selections: JSON.stringify({ duration_days: 2, renews_order_id: id }), amount: 10, currency: 'IRT', idempotencyKey: newOrderId(), initialState: 'approved' });
    calls = [];
    assert.equal((await run(renewal)).ok, true);
    assert.ok(calls.every(c => c.origin === origins[0]));
    raw.prepare("UPDATE settings SET value=? WHERE key='repurchase'").run(JSON.stringify({ schema: 1, enabled: true, near_expiry_days: 7 }));
    const rep = newOrderId();
    await insertOrderWithEvent(env.DB, { id: rep, customerId: 1, kind: 'renewal', renewsOrderId: id, repurchaseMode: 'custom', selections: JSON.stringify({ kind: 'repurchase', mode: 'custom', volume_gb: 20, duration_days: 60, device_count: 2, repurchases_order_id: id, renews_order_id: id }), amount: 200, currency: 'IRT', idempotencyKey: newOrderId(), initialState: 'approved' });
    calls = [];
    assert.equal((await run(rep)).ok, true);
    assert.ok(calls.some(c => c.method === 'POST' && c.path.endsWith('/reset')));
    assert.ok(calls.every(c => c.origin === origins[0]));
    assert.ok((await getOrderById(env.DB, id))!.subscription_url!.startsWith(origins[0]!));
    calls = [];
    await runServiceNotificationSweep(env);
    assert.ok(calls.length);
    assert.ok(calls.every(c => c.origin === origins[0]));
});
test('free-trial provisioning selects managed destination and persists assignment before requests', async () => { await ready(); await action('select', 'cf_2'); const id = newOrderId(); await insertOrderWithEvent(env.DB, { id, customerId: 1, selections: JSON.stringify({ free_test: true, volume_mb: 100, duration_days: 1, device_count: 1 }), amount: 0, currency: 'IRT', idempotencyKey: newOrderId(), initialState: 'approved' }); assert.equal((await run(id)).ok, true); assert.equal((await getOrderById(env.DB, id))!.panel_id, 'cf_2'); assert.ok(calls.filter(c => c.path.startsWith('/api/user')).every(c => c.origin === origins[1])); });
test('scheduled approved recovery retains persisted managed assignment after default switch', async () => { await ready(); await action('select', 'cf_1'); const id = await purchase(); crashCreate = true; await run(id); await action('select', 'cf_3'); raw.prepare("UPDATE orders SET state='approved' WHERE id=?").run(id); calls = []; await recoverPanelOperations(env); assert.equal((await getOrderById(env.DB, id))!.state, 'completed'); assert.equal((await getOrderById(env.DB, id))!.panel_id, 'cf_1'); assert.ok(calls.every(c => c.origin === origins[0])); assert.equal(users[0]!.size, 1); assert.equal(users[2]!.size, 0); });
test('registry collision cannot take over encrypted/dynamic panels or duplicate their origin', async () => { raw.prepare("INSERT INTO panels(id,name,origin,credentials,group_ids) VALUES('cf_1','Existing dynamic',?,'opaque-ciphertext','[1]')").run(origins[0]); const issues = await syncConfiguredPanels(env); assert.ok(issues.includes('binding_id_collision')); assert.equal(raw.prepare("SELECT credentials FROM panels WHERE id='cf_1'").get()!.credentials, 'opaque-ciphertext'); assert.equal(raw.prepare("SELECT credential_binding FROM panels WHERE id='cf_1'").get()!.credential_binding, null); });
test('invalid groups require secure visual editing; no unverified group fallback or enabling', async () => { set('PANEL_1_GROUP_IDS', '[1,"2"]'); await syncConfiguredPanels(env); await action('test', 'cf_1'); assert.equal(raw.prepare("SELECT last_test FROM panels WHERE id='cf_1'").get()!.last_test, 'groups_missing'); await action('toggle', 'cf_1'); assert.equal(raw.prepare("SELECT enabled_new FROM panels WHERE id='cf_1'").get()!.enabled_new, 0); const token = await form(); assert.equal((await post('configure', token)).status, 200); await action('toggle', 'cf_1'); assert.equal(raw.prepare("SELECT enabled_new FROM panels WHERE id='cf_1'").get()!.enabled_new, 1); });
test('capacity guard rejects additional managed row without altering valid panels or selection', async () => { await syncConfiguredPanels(env); for (let i = 0; i < 96; i++)
    raw.prepare('INSERT INTO panels(id,name) VALUES(?,?)').run('existing_' + i, 'Existing ' + i); indexed(4); assert.ok((await syncConfiguredPanels(env)).includes('binding_registry_capacity_or_conflict')); assert.equal(raw.prepare('SELECT COUNT(*) n FROM panels').get()!.n, 100); assert.equal((await resolvePanel(env, 'cf_1')).ok, true); assert.equal((await selection(env.DB)).panel_id, 'legacy'); });
test('credential-bearing labels are rejected/redacted before registry and Telegram output', async () => { set('PANEL_1_NAME', 'Do not display ' + keys[0]); await syncConfiguredPanels(env); await showPanels(ctx); assert.ok(!messages.join('\n').includes(keys[0]!)); assert.ok(!JSON.stringify(raw.prepare('SELECT * FROM panels').all()).includes(keys[0]!)); });
test('secret change supersedes armed selection; no stale confirmation enables or selects it', async () => { await ready(); await panelCallback(ctx, 'pnl:select:cf_1', 'test'); const session = raw.prepare("SELECT nonce FROM panel_admin_sessions WHERE action='select'").get()!; set('PANEL_1_API_KEY', 'SYNTHETIC-ROTATED-KEY'); await panelCallback(ctx, 'pnl:confirm:' + session.nonce, 'test'); assert.equal((await selection(env.DB)).panel_id, 'legacy'); assert.equal(raw.prepare("SELECT enabled_new FROM panels WHERE id='cf_1'").get()!.enabled_new, 0); assert.equal(raw.prepare('SELECT nonce FROM panel_admin_sessions WHERE nonce=?').get(session.nonce), undefined); });
test('managed browser form keeps Worker URL read-only and key hidden while discovering real groups in both languages', async () => { const { runInNewContext } = await import('node:vm'), { panelFormDom } = await import('./panelFormDom.ts'); await syncConfiguredPanels(env); for (const locale of ['fa', 'en'] as const) {
    ctx.ui = uiFor(locale);
    const token = await form(), shell = await panelAdminRoute(new Request(WEB + '/admin/panels?nonce=' + token + '&lang=' + locale), env), html = await shell.text(), script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!, dom = panelFormDom();
    const initData = await signed();
    await runInNewContext(script, { document: dom.document, URL, setTimeout: dom.setTimeout, clearTimeout: dom.clearTimeout, window: { Telegram: { WebApp: { initData, ready: () => { } } } }, fetch: async (path: string, options: RequestInit) => panelAdminRoute(new Request(WEB + path, { ...options, headers: { origin: WEB, 'content-type': 'application/json' } }), env) });
    assert.equal(dom.get('url').disabled, true);
    assert.equal(dom.get('key').disabled, true);
    assert.equal(dom.get('key-row').hidden, true);
    assert.equal(dom.get('key').value, '');
    assert.equal(dom.get('intro').textContent, ctx.ui.t.panelFormManagedIntro);
    assert.deepEqual(dom.names(), ['Actual 1']);
    assert.equal(dom.get('save').disabled, false);
    assert.ok(html.includes('dir="' + (locale === 'fa' ? 'rtl' : 'ltr') + '"'));
    assert.ok(!html.includes(keys[0]!));
} });

test('a newly declared duplicate cannot disable an existing owner with a later-sorting ID',async()=>{await ready();await action('select','cf_2');const before=raw.prepare("SELECT revision,binding_fingerprint,enabled_new FROM panels WHERE id='cf_2'").get();indexed(10);set('PANEL_10_URL',origins[1]);await syncConfiguredPanels(env);assert.deepEqual(raw.prepare("SELECT revision,binding_fingerprint,enabled_new FROM panels WHERE id='cf_2'").get(),before);assert.equal((await resolvePanel(env,'cf_2')).ok,true);assert.equal((await resolvePanel(env,'cf_10')).ok,false);assert.equal((await selection(env.DB)).panel_id,'cf_2');});
