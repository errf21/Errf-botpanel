/** Additive 0025 preserves every existing table/column and all historical references. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const dir = new URL('../migrations/', import.meta.url), upgrade = readFileSync(new URL('0025_cloudflare_panel_bindings.sql', dir), 'utf8');
function baseline() {
    const c = new DatabaseSync(':memory:');
    c.exec('PRAGMA foreign_keys=ON');
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql') && f < '0025').sort()) {
        c.exec('BEGIN');
        c.exec(readFileSync(new URL(f, dir), 'utf8'));
        c.exec('COMMIT');
    }
    c.exec(`INSERT INTO customers(id,telegram_user_id,balance_irt) VALUES(1,'1',500),(2,'2',700);
 INSERT INTO panels(id,name,origin,credentials,enabled_new,group_ids) VALUES('multi','Multi','https://multi.example.com','opaque-existing-ciphertext',1,'[7]');
 INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,pasarguard_username,pasarguard_user_id,legacy_pasarguard_user_id,receipt_file_id,payment_reference) VALUES('legacy',1,'completed','{}',100,'legacy','legacyname','100','100','receipt-kept','payment-kept');
 INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,pasarguard_username,pasarguard_user_id) VALUES('multi-order',2,'completed','{}',50,'multi','multiname','100');
 INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,create_target_unix,provision_claim,provision_attempts,panel_provision_config) VALUES('pending',1,'provisioning','{}',30,'multi',2000000000,'claim-kept',2,'{"groupIds":[7]}');
 INSERT INTO wallet_entries(id,customer_id,delta_irt,kind,order_id,actor,balance_after) VALUES('wallet',1,-100,'order_payment','legacy','customer',500);
 INSERT INTO wallet_topups(id,customer_id,amount_irt,state,idempotency_key,receipt_file_id) VALUES('topup',1,50000,'approved','topup-token','topup-receipt');
 INSERT INTO referral_rewards(referred_customer_id,referrer_customer_id,order_id,amount_irt) VALUES(2,1,'legacy',10);
 INSERT INTO order_events(order_id,actor,action,data) VALUES('legacy','system','usage_history','{"used":123}');
 INSERT INTO service_notifications(order_id,kind,status) VALUES('legacy','usage90','sent');
 INSERT INTO panel_service_locks(service_id,owner,expires_at) VALUES('pending','lock-kept',9999999999999);
 UPDATE panel_selection SET panel_id='multi',revision=3;`);
    return c;
}
function snapshot(c: DatabaseSync) { const out: Record<string, {
    columns: string;
    rows: string;
}> = {}; for (const r of c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    const name = String(r.name), columns = c.prepare('PRAGMA table_info("' + name + '")').all().filter(r => !['credential_binding', 'binding_fingerprint'].includes(String(r.name))).map(r => '"' + r.name + '"').join(',');
    out[name] = { columns, rows: JSON.stringify(c.prepare('SELECT ' + columns + ' FROM "' + name + '" ORDER BY 1').all()) };
} return out; }
test('0025 upgrade preserves all 29 application tables, finances, ciphertext and pending identity', () => { const c = baseline(); try {
    const before = snapshot(c);
    assert.equal(Object.keys(before).length, 29);
    c.exec('BEGIN');
    c.exec(upgrade);
    c.exec('COMMIT');
    assert.deepEqual(snapshot(c), before);
    assert.deepEqual(c.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(c.prepare("SELECT credential_binding FROM panels WHERE id='multi'").get()!.credential_binding, null);
    assert.equal(c.prepare("SELECT panel_id FROM panel_selection").get()!.panel_id, 'multi');
    assert.equal(c.prepare("SELECT provision_claim FROM orders WHERE id='pending'").get()!.provision_claim, 'claim-kept');
}
finally {
    c.close();
} });
test('0025 rollback is safe before activation; raw repeat fails safely rather than resetting state', () => { const c = baseline(); try {
    const before = snapshot(c);
    c.exec('BEGIN');
    c.exec(upgrade);
    c.exec('ROLLBACK');
    assert.deepEqual(snapshot(c), before);
    assert.ok(!c.prepare('PRAGMA table_info(panels)').all().some(r => r.name === 'credential_binding'));
    c.exec('BEGIN');
    c.exec(upgrade);
    c.exec('COMMIT');
    c.exec('BEGIN');
    assert.throws(() => c.exec(upgrade), /duplicate column/);
    c.exec('ROLLBACK');
    assert.deepEqual(snapshot(c), before);
    assert.deepEqual(c.prepare('PRAGMA foreign_key_check').all(), []);
}
finally {
    c.close();
} });
