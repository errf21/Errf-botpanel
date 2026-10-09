/** Permanent additive-upgrade/rollback evidence. Fixtures are not production exports. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
const dir=new URL('../migrations/',import.meta.url),upgrade=readFileSync(new URL('0022_service_migrations.sql',dir),'utf8');
const tables=['customers','orders','wallet_entries','wallet_topups','referral_rewards','free_test_claims','order_events','service_notifications','settings','panels','panel_selection','panel_service_locks','panel_audit','panel_admin_sessions'];
function baseline(){
 const c=new DatabaseSync(':memory:');c.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')&&f<'0022').sort()){c.exec('BEGIN');c.exec(readFileSync(new URL(file,dir),'utf8'));c.exec('COMMIT');}
 c.exec(`INSERT INTO customers(id,telegram_user_id,balance_irt) VALUES(1,'1',500),(2,'2',700);
 INSERT INTO panels(id,name,origin,auth_type,enabled_new,group_ids) VALUES('multi','Multi','https://multi.example.com','api_key',0,'[7]');
 INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,pasarguard_username,pasarguard_user_id,legacy_pasarguard_user_id,receipt_file_id,payment_reference)
 VALUES('legacy',1,'completed','{}',100,'legacy','legacyname','100','100','receipt-kept','payment-kept');
 INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,pasarguard_username,pasarguard_user_id) VALUES('multi-order',2,'completed','{}',50,'multi','multiname','100');
 INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,create_target_unix,provision_claim,provision_attempts) VALUES('pending',1,'provisioning','{}',30,'legacy',2000000000,'claim-kept',2);
 INSERT INTO wallet_entries(id,customer_id,delta_irt,kind,order_id,actor,balance_after) VALUES('wallet',1,-100,'order_payment','legacy','customer',500);
 INSERT INTO wallet_topups(id,customer_id,amount_irt,state,idempotency_key,receipt_file_id) VALUES('topup',1,50000,'approved','topup-token','topup-receipt');
 INSERT INTO referral_rewards(referred_customer_id,referrer_customer_id,order_id,amount_irt) VALUES(2,1,'legacy',10);
 INSERT INTO free_test_claims(customer_id,order_id) VALUES(2,'multi-order');
 INSERT INTO order_events(order_id,actor,action,data) VALUES('legacy','system','usage_history','{"used":123}');
 INSERT INTO service_notifications(order_id,kind,status) VALUES('legacy','usage90','sent');
 INSERT INTO panel_service_locks(service_id,owner,expires_at) VALUES('pending','lock-kept',9999999999999);`);
 return c;
}
function snapshot(c:DatabaseSync){return tables.map(t=>JSON.stringify(c.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));}
test('0022 upgrade preserves all seeded legacy/multi-panel, financial, usage and pending-operation tables byte-for-byte',()=>{
 const c=baseline(),before=snapshot(c);try{c.exec('BEGIN');c.exec(upgrade);c.exec('COMMIT');assert.deepEqual(snapshot(c),before);assert.deepEqual(c.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(c.prepare('SELECT COUNT(*) n FROM service_migrations').get()!.n,0);}finally{c.close();}
});
test('0022 transactional rollback leaves the baseline usable; raw repeat fails safely and does not rewrite data',()=>{
 const c=baseline(),before=snapshot(c);try{c.exec('BEGIN');c.exec(upgrade);c.exec('ROLLBACK');assert.deepEqual(snapshot(c),before);assert.equal(c.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='effective_orders'").get()!.n,0);
 c.exec('BEGIN');c.exec(upgrade);c.exec('COMMIT');c.exec('BEGIN');assert.throws(()=>c.exec(upgrade));c.exec('ROLLBACK');assert.deepEqual(snapshot(c),before);assert.deepEqual(c.prepare('PRAGMA foreign_key_check').all(),[]);}finally{c.close();}
});
test('0022 effective view retains every original identity and pending assignment before any migration is activated',()=>{
 const c=baseline();try{c.exec('BEGIN');c.exec(upgrade);c.exec('COMMIT');const columns=c.prepare('PRAGMA table_info(orders)').all().map(v=>'"'+v.name+'"').join(',');assert.deepEqual(c.prepare('SELECT '+columns+' FROM effective_orders ORDER BY id').all(),c.prepare('SELECT * FROM orders ORDER BY id').all());
 assert.deepEqual({...c.prepare("SELECT panel_id,pasarguard_user_id FROM effective_orders WHERE id='legacy'").get()},{panel_id:'legacy',pasarguard_user_id:'100'});assert.equal(c.prepare("SELECT panel_id FROM effective_orders WHERE id='multi-order'").get()!.panel_id,'multi');assert.equal(c.prepare("SELECT provision_claim FROM effective_orders WHERE id='pending'").get()!.provision_claim,'claim-kept');}finally{c.close();}
});
