/** Executed inside the installed Cloudflare workerd runtime, with local D1. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshDb } from './helpers.ts';
const require = createRequire(import.meta.url);
test('actual workerd resolves declared bindings and performs idempotent D1 sync without selection reset', async () => {
    const { build } = require('esbuild'), { Miniflare, convertV4MiniflareOptions } = require('miniflare');
    const built = await build({ stdin: { contents: `import {syncConfiguredPanels} from './src/panels/bindings.ts';import {resolvePanel,selection} from './src/panels/registry.ts';export default {async fetch(req,env){const issues=await syncConfiguredPanels(env);const r=await resolvePanel(env,'cf_3');return Response.json({issues,selected:await selection(env.DB),valid:r.ok&&r.config.apiKey===env.PANEL_3_API_KEY,origin:r.ok?r.config.baseUrl:null});}};`, resolveDir: process.cwd(), sourcefile: 'runtime-fixture.ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-09-01', script: built.outputFiles[0].text, d1Databases: { DB: 'configured-panels-local' }, bindings: { TELEGRAM_BOT_TOKEN: 'SYNTHETIC-RUNTIME-BOT', PASARGUARD_PANEL_URL: 'https://legacy.example.com', PANEL_COUNT: '3', PANEL_1_URL: 'https://runtime1.example.com', PANEL_1_API_KEY: 'SYNTHETIC-RUNTIME-KEY-1', PANEL_2_URL: 'https://runtime2.example.com', PANEL_2_API_KEY: 'SYNTHETIC-RUNTIME-KEY-2', PANEL_3_URL: 'https://runtime3.example.com:8000/dashboard/#/login', PANEL_3_API_KEY: 'SYNTHETIC-RUNTIME-KEY-3' } }));
    try {
        const db = await mf.getD1Database('DB'), raw = freshDb();
        try {
            for (const name of ['panels', 'panel_audit', 'panel_selection']) {
                const row = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)!;
                await db.prepare(String(row.sql)).run();
            }
        }
        finally {
            raw.close();
        }
        await db.prepare("INSERT INTO panels(id,name,enabled_new) VALUES('legacy','Legacy',1)").run();
        await db.prepare("INSERT INTO panel_selection(singleton,panel_id) VALUES(1,'legacy')").run();
        const both = await Promise.all([mf.dispatchFetch('https://local.example.com'), mf.dispatchFetch('https://local.example.com')]);
        for (const response of both) {
            assert.equal(response.status, 200);
            const value = await response.json();
            assert.deepEqual(value.issues, []);
            assert.equal(value.valid, true);
            assert.equal(value.origin, 'https://runtime3.example.com:8000');
            assert.equal(value.selected.panel_id, 'legacy');
        }
        assert.equal((await db.prepare('SELECT COUNT(*) n FROM panels').first()).n, 4);
        assert.equal((await db.prepare("SELECT COUNT(*) n FROM panel_audit WHERE action='binding_register'").first()).n, 3);
        await db.prepare("UPDATE panels SET enabled_new=1,last_test='ok' WHERE id='cf_3'").run();
        await db.prepare("UPDATE panel_selection SET panel_id='cf_3',revision=revision+1").run();
        const again = await (await mf.dispatchFetch('https://local.example.com')).json();
        assert.equal(again.selected.panel_id, 'cf_3');
        assert.equal((await db.prepare("SELECT enabled_new FROM panels WHERE id='cf_3'").first()).enabled_new, 1);
        assert.equal((await db.prepare("SELECT COUNT(*) n FROM panel_audit WHERE action='binding_register'").first()).n, 3);
        const rows = JSON.stringify(await db.prepare('SELECT * FROM panels').all());
        assert.ok(!rows.includes('SYNTHETIC-RUNTIME-KEY'));
        assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
    }
    finally {
        await mf.dispose();
    }
});
