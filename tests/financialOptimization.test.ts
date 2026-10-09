/** Actual SQLite transactions and injected SQL failures; no production calls. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freshDb,makeD1Shim} from './helpers.ts';
import {applyWalletMutation,MAX_WALLET_AMOUNT} from '../src/db/wallet.ts';
import {maybePayReferralReward} from '../src/db/referrals.ts';
import {creditTopupOnce} from '../src/db/topups.ts';
import {claimUpdate,cleanupExpiredUpdates,UpdateClaimUnavailable} from '../src/db/dedupe.ts';
import {upsertCustomer} from '../src/db/customers.ts';
import {resolveIsAdmin} from '../src/admin.ts';
import {isPanelAdmin} from '../src/panels/security.ts';
const config={enabled:true,maxRewardsPerReferrer:10} as any;
function fixture(balance=100){const raw=freshDb();raw.exec(`INSERT INTO customers(id,telegram_user_id,balance_irt) VALUES(1,'101',${balance}),(2,'102',0);UPDATE customers SET referred_by=1 WHERE id=2;`);return {raw,db:makeD1Shim(raw) as unknown as D1Database};}
function topup(raw:any,id='top',amount=45000){raw.prepare("INSERT INTO wallet_topups(id,customer_id,amount_irt,state,idempotency_key) VALUES(?,1,?,'approved',?)").run(id,amount,id);}
const mutation={customerId:1,amountIrt:50,kind:'admin_grant' as const,actor:'admin:9',operationKey:'admin-intent'};
for(const stage of ['ledger','balance'])test(`admin wallet ${stage} failure rolls back both sides and same intent retries safely`,async()=>{
 const {raw,db}=fixture();try{
  raw.exec(stage==='ledger'?"CREATE TRIGGER injected BEFORE INSERT ON wallet_entries BEGIN SELECT RAISE(ABORT,'synthetic'); END":"CREATE TRIGGER injected BEFORE UPDATE OF balance_irt ON customers BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  assert.deepEqual(await applyWalletMutation(db,mutation),{ok:false,reason:'state'});
  assert.equal(raw.prepare('SELECT balance_irt n FROM customers WHERE id=1').get()!.n,100);assert.equal(raw.prepare('SELECT COUNT(*) n FROM wallet_entries').get()!.n,0);
  raw.exec('DROP TRIGGER injected');assert.ok((await applyWalletMutation(db,mutation)).ok);assert.ok((await applyWalletMutation(db,mutation)).ok);
  assert.equal(raw.prepare('SELECT balance_irt n FROM customers WHERE id=1').get()!.n,150);assert.equal(raw.prepare('SELECT COUNT(*) n FROM wallet_entries').get()!.n,1);
 }finally{raw.close();}
});
test('administrative intent cannot be substituted across customer, amount or actor',async()=>{const {raw,db}=fixture();try{assert.ok((await applyWalletMutation(db,mutation)).ok);for(const change of [{customerId:2},{amountIrt:51},{actor:'admin:10'}])assert.deepEqual(await applyWalletMutation(db,{...mutation,...change}),{ok:false,reason:'state'});assert.equal(raw.prepare('SELECT COUNT(*) n FROM wallet_entries').get()!.n,1);}finally{raw.close();}});
for(const stage of ['ledger','anchor','balance'])test(`referral ${stage} failure rolls back ledger, anchor and credit`,async()=>{
 const {raw,db}=fixture();try{
  const target=stage==='ledger'?'INSERT ON wallet_entries':stage==='anchor'?'INSERT ON referral_rewards':'UPDATE OF balance_irt ON customers';raw.exec(`CREATE TRIGGER injected BEFORE ${target} BEGIN SELECT RAISE(ABORT,'synthetic'); END`);
  const opts={refereeCustomerId:2,orderId:'order',rewardIrt:10,config};assert.equal(await maybePayReferralReward(db,opts),null);
  assert.equal(raw.prepare('SELECT balance_irt n FROM customers WHERE id=1').get()!.n,100);for(const t of ['wallet_entries','referral_rewards'])assert.equal(raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get()!.n,0);
  raw.exec('DROP TRIGGER injected');assert.deepEqual(await maybePayReferralReward(db,opts),{referrerCustomerId:1,amountIrt:10});assert.equal(await maybePayReferralReward(db,opts),null);
  assert.equal(raw.prepare('SELECT balance_irt n FROM customers WHERE id=1').get()!.n,110);assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{raw.close();}
});
test('historical referral anchor without ledger is not rewarded again',async()=>{const {raw,db}=fixture();try{raw.exec("INSERT INTO referral_rewards(referred_customer_id,referrer_customer_id,order_id,amount_irt) VALUES(2,1,'old',10)");assert.equal(await maybePayReferralReward(db,{refereeCustomerId:2,orderId:'new',rewardIrt:10,config}),null);assert.equal(raw.prepare('SELECT balance_irt n FROM customers WHERE id=1').get()!.n,100);}finally{raw.close();}});
for(const balance of [MAX_WALLET_AMOUNT-45001,MAX_WALLET_AMOUNT-45000,MAX_WALLET_AMOUNT-44999,MAX_WALLET_AMOUNT])test(`topup boundary ${balance} records only actual applied credit`,async()=>{
 const {raw,db}=fixture(balance);try{topup(raw);const opts={customerId:1,topupId:'top',amountIrt:45000,actor:'admin'};const fits=balance+45000<=MAX_WALLET_AMOUNT;
  for(let n=0;n<2;n++)assert.equal((await creditTopupOnce(db,opts)).ok,fits);
  assert.equal(raw.prepare('SELECT balance_irt n FROM customers WHERE id=1').get()!.n,balance+(fits?45000:0));assert.equal(raw.prepare('SELECT COUNT(*) n FROM wallet_entries').get()!.n,fits?1:0);
  assert.equal(raw.prepare('SELECT credit_status n FROM wallet_topups').get()!.n,fits?'credited':'blocked');
  if(!fits){raw.prepare('UPDATE customers SET balance_irt=? WHERE id=1').run(100);assert.ok((await creditTopupOnce(db,opts)).ok);assert.equal(raw.prepare('SELECT balance_irt n FROM customers WHERE id=1').get()!.n,45100);}
 }finally{raw.close();}
});
for(const stage of ['ledger','balance','status'])test(`topup ${stage} failure stays uncredited and recoverable`,async()=>{const {raw,db}=fixture();try{topup(raw);const target=stage==='ledger'?'INSERT ON wallet_entries':stage==='balance'?'UPDATE OF balance_irt ON customers':'UPDATE OF credit_status ON wallet_topups';raw.exec(`CREATE TRIGGER injected BEFORE ${target} BEGIN SELECT RAISE(ABORT,'synthetic'); END`);const opts={customerId:1,topupId:'top',amountIrt:45000,actor:'admin'};assert.deepEqual(await creditTopupOnce(db,opts),{ok:false,reason:'state'});assert.equal(raw.prepare('SELECT balance_irt n FROM customers WHERE id=1').get()!.n,100);assert.equal(raw.prepare('SELECT COUNT(*) n FROM wallet_entries').get()!.n,0);assert.equal(raw.prepare('SELECT credit_status n FROM wallet_topups').get()!.n,'uncredited');raw.exec('DROP TRIGGER injected');assert.ok((await creditTopupOnce(db,opts)).ok);}finally{raw.close();}});
test('topup ownership/amount substitution and untrusted historical credits fail closed',async()=>{const {raw,db}=fixture();try{topup(raw);assert.equal((await creditTopupOnce(db,{customerId:2,topupId:'top',amountIrt:45000,actor:'admin'})).ok,false);assert.equal((await creditTopupOnce(db,{customerId:1,topupId:'top',amountIrt:45001,actor:'admin'})).ok,false);raw.exec("UPDATE wallet_topups SET credit_status='review_required'");assert.equal((await creditTopupOnce(db,{customerId:1,topupId:'top',amountIrt:45000,actor:'admin'})).ok,false);assert.equal(raw.prepare('SELECT COUNT(*) n FROM wallet_entries').get()!.n,0);}finally{raw.close();}});
test('dedupe hot path does not DELETE; insert operational failures remain errors',async()=>{const {raw,db}=fixture();try{const queries:string[]=[];const wrapped={...db,prepare(sql:string){queries.push(sql);return db.prepare(sql);}} as D1Database;assert.equal(await claimUpdate(wrapped,1,{prune:false}),'fresh');assert.equal(await claimUpdate(wrapped,1,{prune:false}),'replay');assert.ok(!queries.some(q=>q.startsWith('DELETE')));raw.exec("CREATE TRIGGER injected BEFORE INSERT ON update_dedupe BEGIN SELECT RAISE(ABORT,'synthetic'); END");await assert.rejects(()=>claimUpdate(wrapped,2,{prune:false}),UpdateClaimUnavailable);}finally{raw.close();}});
test('scheduled dedupe pruning is bounded and preserves exact 48-hour boundary',async()=>{const {raw,db}=fixture();try{const now=Date.now(),cutoff=new Date(now-48*3600000).toISOString();for(let n=0;n<1002;n++)raw.prepare('INSERT INTO update_dedupe(update_id,received_at) VALUES(?,?)').run(n,new Date(now-49*3600000).toISOString());raw.prepare('INSERT INTO update_dedupe(update_id,received_at) VALUES(9999,?)').run(cutoff);await cleanupExpiredUpdates(db,now);assert.equal(raw.prepare('SELECT COUNT(*) n FROM update_dedupe').get()!.n,3);await cleanupExpiredUpdates(db,now);assert.equal(raw.prepare('SELECT COUNT(*) n FROM update_dedupe').get()!.n,1);assert.equal(await claimUpdate(db,9999,{prune:false}),'replay');}finally{raw.close();}});
test('same-request general-admin identity reuse cannot grant panel admin privileges',async()=>{const {raw,db}=fixture();try{raw.exec('UPDATE customers SET is_admin=1 WHERE id=1');const identity=await upsertCustomer(db,{id:101,first_name:'Test'});const env={DB:db,ADMIN_CHAT_ID:'999',PANEL_ADMIN_IDS:'999'} as any;assert.equal(identity.is_admin,1);assert.equal(await resolveIsAdmin(env,db,101,identity.is_admin),true);assert.equal(isPanelAdmin(env,101),false);raw.exec('UPDATE customers SET is_admin=0 WHERE id=1');const fresh=await upsertCustomer(db,{id:101,first_name:'Test'});assert.equal(await resolveIsAdmin(env,db,101,fresh.is_admin),false);}finally{raw.close();}});

test('old Telegram transport logs only bounded method/code, never upstream secret descriptions',async()=>{
 const {TelegramApi}=await import('../src/telegram/api.ts');const original=fetch,log=console.error,logs:string[]=[];
 try{console.error=(...v)=>logs.push(v.join(' '));globalThis.fetch=async()=>Response.json({ok:false,error_code:'LEAK-SECRET',description:'LEAK-SECRET'}, {status:503});assert.equal(await new TelegramApi('SYNTHETIC').sendMessage(1,'safe'),null);assert.deepEqual(logs,['telegram_api_error method=sendMessage code=503']);globalThis.fetch=async()=>Response.json({ok:false,error_code:400,description:{password:'LEAK-SECRET'}},{status:400});assert.equal(await new TelegramApi('SYNTHETIC').editMessageText(1,1,'safe'),false);assert.ok(logs.every(v=>!v.includes('SECRET')));}finally{globalThis.fetch=original;console.error=log;}
});
test('expired-token maintenance preserves current and grace-period sessions and all business tables',async()=>{
 const {cleanupExpiredAdminTokens}=await import('../src/db/maintenance.ts');const {raw,db}=fixture();try{
 raw.exec("INSERT INTO orders(id,customer_id,selections,amount) VALUES('unused',1,'{}',0)");
 const now=Date.now();for(const [id,expires]of [['old',now-700000],['grace',now-1],['active',now+300000]] as const){raw.prepare("INSERT INTO panel_admin_sessions(nonce,actor,action,panel_id,panel_revision,selection_revision,enabled_new,expires_at) VALUES(?,'9','configure','legacy',1,1,1,?)").run(id,expires);raw.prepare("INSERT INTO migration_admin_choices(nonce,actor,action,service_id,customer_id,panel_id,expires_at) VALUES(?,'9','destination','unused',1,'legacy',?)").run(id,expires);}
 for(const [id,expiry]of [['old',now-1000000],['grace',now-1],['active',now+1000000]] as const)raw.prepare("INSERT INTO admin_actions(admin_user_id,action,target_id,expires_at) VALUES(?,'wallet_grant','101',?)").run(id,new Date(expiry).toISOString());
 const before=raw.prepare('SELECT * FROM customers ORDER BY id').all();await cleanupExpiredAdminTokens(db,now);for(const t of ['panel_admin_sessions','migration_admin_choices','admin_actions'])assert.equal(raw.prepare(`SELECT COUNT(*) n FROM ${t}`).get()!.n,2);assert.deepEqual(raw.prepare('SELECT * FROM customers ORDER BY id').all(),before);
 }finally{raw.close();}
});
test('pending admin-action miss uses one SELECT and cannot delete a newly armed action',async()=>{
 const {getPendingAdminAction}=await import('../src/db/admin_actions.ts');const {raw,db}=fixture();try{const q:string[]=[];const wrapped={...db,prepare(sql:string){q.push(sql);return db.prepare(sql);}} as D1Database;assert.equal(await getPendingAdminAction(wrapped,9),null);assert.equal(q.length,1);assert.ok(!q.some(v=>v.startsWith('DELETE')));}finally{raw.close();}
});
test('set-based announcement progress equals independent aggregates without N+1 statements',async()=>{
 const {createAnnouncement,startAnnouncement,listRecentAnnouncementProgress,announcementAggregate}=await import('../src/db/announcements.ts');const {raw,db}=fixture();try{for(let n=0;n<5;n++){const a=await createAnnouncement(db,{body:'synthetic'+n,createdBy:'admin:9',totalEstimate:2});assert.ok(a);await startAnnouncement(db,a!.id);}let statements=0;const wrapped={...db,prepare(sql:string){statements++;return db.prepare(sql);}} as D1Database;const rows=await listRecentAnnouncementProgress(wrapped,5);assert.equal(statements,1);assert.equal(rows.length,5);for(const r of rows)assert.deepEqual(r.progress,await announcementAggregate(db,r.id));}finally{raw.close();}
});

test('expired administrative-action cleanup rechecks expiry after concurrent rearming',async()=>{
 const {getPendingAdminAction}=await import('../src/db/admin_actions.ts');const {raw,db}=fixture();try{
 raw.prepare("INSERT INTO admin_actions(admin_user_id,action,target_id,expires_at) VALUES('9','wallet_grant','101',?)").run(new Date(Date.now()-1000).toISOString());
 const wrapped={...db,prepare(sql:string){const s=db.prepare(sql);if(sql.startsWith('SELECT order_id,action,target_id,expires_at')){const f=s.first.bind(s);s.first=(async()=>{const row=await f();raw.prepare('UPDATE admin_actions SET expires_at=? WHERE admin_user_id=?').run(new Date(Date.now()+600000).toISOString(),'9');return row;}) as typeof s.first;}return s;}} as D1Database;
 assert.equal(await getPendingAdminAction(wrapped,9),null);assert.equal(raw.prepare('SELECT COUNT(*) n FROM admin_actions').get()!.n,1);assert.ok(await getPendingAdminAction(db,9));
 }finally{raw.close();}
});
test('financial batches reconcile uncertain committed responses instead of applying twice',async()=>{
 const {raw,db}=fixture();try{const uncertain={...db,async batch(s:D1PreparedStatement[]){await db.batch(s);throw Error('synthetic response lost after commit');}} as D1Database;
 assert.ok((await applyWalletMutation(uncertain,mutation)).ok);assert.ok((await applyWalletMutation(db,mutation)).ok);assert.equal(raw.prepare('SELECT balance_irt n FROM customers WHERE id=1').get()!.n,150);
 assert.deepEqual(await maybePayReferralReward(uncertain,{refereeCustomerId:2,orderId:'reward',rewardIrt:10,config}),{referrerCustomerId:1,amountIrt:10});assert.equal(await maybePayReferralReward(db,{refereeCustomerId:2,orderId:'reward',rewardIrt:10,config}),null);
 topup(raw);const opts={customerId:1,topupId:'top',amountIrt:45000,actor:'admin'};assert.ok((await creditTopupOnce(uncertain,opts)).ok);assert.ok((await creditTopupOnce(db,opts)).ok);assert.equal(raw.prepare('SELECT COUNT(*) n FROM wallet_entries').get()!.n,3);assert.equal(raw.prepare('SELECT balance_irt n FROM customers WHERE id=1').get()!.n,45160);
 }finally{raw.close();}
});
