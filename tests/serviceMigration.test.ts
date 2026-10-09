import { test,beforeEach,afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb,makeD1Shim,ADMIN,USER,callbackUpdateAs } from './helpers.ts';
import { encrypt } from '../src/panels/security.ts';
import { newOrderId } from '../src/lib/security.ts';
import { proposeMigration,confirmMigration as confirmOnce,advanceMigration as advanceOnce,revokeSource,manualEntitlement,migrationStatus,cancelMigration,recoverServiceMigrations as recoverOnce } from '../src/migrations/service.ts';
import { getOrderById,insertOrderWithEvent,markPanelDeleted } from '../src/db/orders.ts';
import { provisionOrder,deletePanelService,GB_BYTES } from '../src/provision/provision.ts';
import { resolvePanel,clientFor,acquireServiceLock,releaseServiceLock } from '../src/panels/registry.ts';
import { processTelegramUpdate } from '../src/dispatch.ts';
import { runServiceNotificationSweep } from '../src/handlers/serviceNotifications.ts';
import { recoverPanelOperations } from '../src/panels/recovery.ts';
import { migrationCommand,migrationCallback,deliverMigrationNotices } from '../src/handlers/serviceMigration.ts';
import { FA_UI, EN_UI, uiFor } from '../src/telegram/i18n.ts';
import type { Env,UpdateContext } from '../src/types.ts';
import type { Migration } from '../src/migrations/service.ts';
let raw:DatabaseSync,db:D1Database,env:Env,real:typeof fetch,service:string,expiry:number;
let sourceDown:boolean,destDown:boolean,unknownCreate:boolean,hideDestination:boolean,deleteUncertain:boolean,proxySource404:boolean;
let maliciousIdentity:boolean,maliciousUrl:boolean,swapAtDelete:boolean,unknownDelete:boolean,restrictedReadScope:boolean;
let users:Map<string,Record<string,any>>[],calls:{n:number;method:string;path:string;body:any}[],seq:number[],messages:{chat:number;text:string;buttons:any}[];
const origins=['https://migration-source.example.com','https://migration-dest.example.com','https://migration-third.example.com'];
const keys=['SYNTHETIC-MIGRATION-SOURCE','SYNTHETIC-MIGRATION-DEST','SYNTHETIC-MIGRATION-THIRD'];
const api={sendMessage:async(chat:number,text:string,buttons?:any)=>{messages.push({chat,text,buttons});return {message_id:1};},answerCallbackQuery:async()=>{},editMessageText:async()=>{}} as unknown as UpdateContext['api'];
function context(actor=ADMIN):UpdateContext{return {env,db,api,actor,chatId:actor.id,customerId:actor===ADMIN?3:1,isAdmin:actor===ADMIN,ui:FA_UI} as UpdateContext;}
beforeEach(async()=>{
 raw=freshDb();db=makeD1Shim(raw) as unknown as D1Database;
 env={DB:db,ADMIN_CHAT_ID:String(ADMIN.id),TELEGRAM_BOT_TOKEN:'SYNTHETIC-BOT',TELEGRAM_WEBHOOK_SECRET:'SYNTHETIC-WEBHOOK',PASARGUARD_PANEL_URL:origins[0],PASARGUARD_API_KEY:keys[0],PANEL_ENCRYPTION_KEY:btoa('m'.repeat(32))};
 raw.prepare('INSERT INTO customers(id,telegram_user_id,balance_irt) VALUES(1,?,500),(2,?,700),(3,?,0)').run(String(USER.id),String(USER.id+1),String(ADMIN.id));
 for(let n=1;n<3;n++){const id=n===1?'dest':'third',cipher=await encrypt(env,`panel:${id}:1:${origins[n]}:credentials`,{apiKey:keys[n]});raw.prepare("INSERT INTO panels(id,name,origin,credentials,group_ids,enabled_new,last_test) VALUES(?,?,?,?,?,1,'ok')").run(id,id,origins[n]!,cipher,JSON.stringify([70+n]));}
 service=newOrderId();expiry=Math.floor(Date.now()/1000)+20*86400;
 const name=`pg${service.toLowerCase()}`;
 raw.prepare("INSERT INTO orders(id,customer_id,state,selections,amount,currency,panel_id,pasarguard_username,pasarguard_user_id,subscription_url,service_expires_at,service_created_at,receipt_file_id,payment_reference) VALUES(?,1,'completed',?,100,'IRT','legacy',?,'101',?,?,?,'receipt-kept','payment-kept')")
  .run(service,JSON.stringify({volume_gb:10,duration_days:30,device_count:3,config_name:'Original'}),name,origins[0]+'/sub/original',new Date(expiry*1000).toISOString(),new Date().toISOString());
 raw.prepare("INSERT INTO wallet_entries(id,customer_id,delta_irt,kind,order_id,actor,balance_after) VALUES('entry',1,-100,'order_payment',?,'customer',500)").run(service);
 raw.prepare("INSERT INTO order_events(order_id,actor,action,data) VALUES(?,'system','history_kept','{\"usage\":123}')").run(service);
 raw.prepare("UPDATE settings SET value=? WHERE key='repurchase'").run(JSON.stringify({schema:1,enabled:true,near_expiry_days:7}));
 users=[new Map(),new Map(),new Map()];users[0]!.set(name,{id:'101',username:name,note:`telbot:${service}`,status:'active',data_limit:10*GB_BYTES,used_traffic:3*GB_BYTES,expire:expiry,hwid_limit:3,subscription_url:'/sub/original'});
 calls=[];seq=[101,200,300];messages=[];sourceDown=destDown=unknownCreate=hideDestination=deleteUncertain=proxySource404=maliciousIdentity=maliciousUrl=swapAtDelete=unknownDelete=restrictedReadScope=false;real=fetch;
 globalThis.fetch=(async(input,init)=>{
  const u=new URL(String(input)),method=init?.method??'GET';
  if(u.origin==='https://cloudflare-dns.com')return Response.json({Status:0,Answer:[{type:1,data:'8.8.8.8'}]});
  if(u.origin==='https://api.telegram.org'){const b=JSON.parse(String(init?.body));if(u.pathname.endsWith('/sendMessage'))messages.push({chat:b.chat_id,text:b.text,buttons:b.reply_markup});return Response.json({ok:true,result:{message_id:1}});}
  const n=origins.indexOf(u.origin);assert.ok(n>=0,'no unintended panel fallback');assert.equal(new Headers(init?.headers).get('x-api-key'),keys[n]);assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).get('authorization'),null);
  const body=init?.body?JSON.parse(String(init.body)):null;calls.push({n,method,path:u.pathname,body});
  if(n===0&&sourceDown)return Response.json({detail:keys[0]},{status:401});
  if(n===0&&proxySource404)return new Response('Proxy route missing',{status:404});
  if(n===1&&destDown)return Response.json({detail:keys[1]},{status:503});
  if(u.pathname.startsWith('/api/group/')){const id=Number(u.pathname.split('/').at(-1));return Response.json({id,name:`Group ${id}`,is_disabled:false,inbound_tags:['fixture']});}
  if(u.pathname==='/api/admin')return Response.json({username:'synthetic-operator',status:'active',role:{is_owner:!restrictedReadScope,permissions:{users:{read:{scope:restrictedReadScope?1:2}}}}});
  if(u.pathname==='/api/user'&&method==='POST'){
   const migration=raw.prepare('SELECT * FROM service_migrations WHERE destination_username=?').get(body.username);
   if(migration){assert.equal(migration.state,'creating');assert.ok(Number(migration.create_attempts)>0);assert.equal(migration.destination_panel_id,['legacy','dest','third'][n]);assert.ok(migration.confirmed_by);}
   else {const order=raw.prepare('SELECT panel_id FROM orders WHERE pasarguard_username=?').get(body.username);assert.ok(order);assert.equal(order.panel_id,n===1?'dest':n===2?'third':'legacy');}
   if(users[n]!.has(body.username))return Response.json({detail:'User already exists'},{status:409});
   // Model the actual source contract: on_hold + absolute expiry is rejected.
   assert.equal(body.status,'active');assert.ok(body.expire>0);
   const v={...body,id:String(++seq[n]!),used_traffic:0,subscription_url:`/sub/${body.username}`};users[n]!.set(body.username,v);
   if(unknownCreate){unknownCreate=false;hideDestination=true;throw new Error('Synthetic timeout after committed create');}
   return Response.json(v);
  }
  if(n===1&&hideDestination&&method==='GET')return Response.json({detail:'unavailable'},{status:503});
  const byId=u.pathname.startsWith('/api/user/by-id/');
  const name=byId?null:decodeURIComponent(u.pathname.slice('/api/user/by-username/'.length).replace(/\/reset$/,''));
  let v=byId?[...users[n]!.values()].find(v=>v.id===u.pathname.split('/')[4]):users[n]!.get(name!);
  if(n===0&&method==='DELETE'&&swapAtDelete&&v){const oldname=v.username;users[n]!.delete(oldname);users[n]!.set(oldname,{...v,id:'999'});swapAtDelete=false;v=byId?[...users[n]!.values()].find(v=>v.id===u.pathname.split('/')[4]):users[n]!.get(oldname);}
  if(!v)return Response.json({detail:'User not found'},{status:404});
  if(method==='DELETE'){if(deleteUncertain)return Response.json({detail:'denied'},{status:403});users[n]!.delete(v.username);if(unknownDelete){unknownDelete=false;throw Error('Synthetic timeout after delete');}return new Response(null,{status:204});}
  if(method==='PUT'){Object.assign(v,body);if(body.status==='active')v.subscription_url=`/sub/${v.username}/activated`;}
  if(method==='POST'&&u.pathname.endsWith('/reset')){v.used_traffic=0;v.subscription_url=`/sub/${v.username}/rotated`;}
  if(n===1&&maliciousIdentity&&method==='GET')return Response.json({...v,id:'900'});
  return Response.json({...v,subscription_url:maliciousUrl&&n===1?'https://key:secret@unintended.example.com/sub':v.subscription_url});
 }) as typeof fetch;
});
afterEach(()=>{globalThis.fetch=real;raw.close();});
/** Model separate Worker invocations at the durable verified checkpoint. */
async function advanceMigration(...args:Parameters<typeof advanceOnce>){let m=await advanceOnce(...args);if(m.state==='verified')m=await advanceOnce(...args);return m;}
async function confirmMigration(...args:Parameters<typeof confirmOnce>){let m=await confirmOnce(...args);if(m.state==='verified')m=await advanceOnce(args[0],m.id,args[1],false);return m;}
async function recoverServiceMigrations(...args:Parameters<typeof recoverOnce>){await recoverOnce(...args);await recoverOnce(...args);}
async function propose(dest='dest'){return proposeMigration(env,ADMIN.id,service,1,dest);}
async function migrate(){const m=await propose();return confirmMigration(env,ADMIN.id,m.confirmation_token);}
function original(){return users[0]!.values().next().value!;}
async function refreshSource(){const p=await resolvePanel(env,'legacy');assert.ok(p.ok);if(p.ok)await clientFor(p.config,'101').getUserById('101');}
function interrupt(predicate:(sql:string,values:any[])=>boolean):()=>void{
 const base=env.DB,sqls=new WeakMap<object,{sql:string;values:any[]}>();
 env.DB={...base,prepare(sql:string){const stmt=base.prepare(sql),bind=stmt.bind.bind(stmt),meta={sql,values:[] as any[]};sqls.set(stmt,meta);stmt.bind=(...v:any[])=>{meta.values=v;return bind(...v);};return stmt;},async batch(statements:D1PreparedStatement[]){const out=await base.batch(statements);if(statements.some(s=>{const m=sqls.get(s);return m&&predicate(m.sql,m.values);}))throw Error('Synthetic worker interruption after committed phase');return out;}} as D1Database;db=env.DB;
 return()=>{env.DB=base;db=base;};
}
function financialSnapshot(){return JSON.stringify(['orders','customers','wallet_entries','wallet_topups','referral_rewards','order_events'].map(t=>raw.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));}

test('successful migration verifies entitlement, changes only active resource, and separately confirms source revocation',async()=>{
 const before=financialSnapshot(),m=await migrate();assert.equal(m.state,'cleanup_pending');assert.equal(m.source_revoked_at,null);
 const active=(await getOrderById(db,service))!;assert.equal(active.panel_id,'dest');assert.equal(active.pasarguard_user_id,'201');assert.ok(active.subscription_url!.endsWith('/activated'));assert.equal(active.service_expires_at,new Date(expiry*1000).toISOString());
 assert.equal(financialSnapshot(),before);assert.equal(raw.prepare('SELECT panel_id FROM orders WHERE id=?').get(service)!.panel_id,'legacy');
 const remote=users[1]!.get(m.destination_username)!;assert.equal(remote.data_limit,7*GB_BYTES);assert.equal(remote.used_traffic,0);assert.equal(remote.expire,expiry);assert.equal(remote.hwid_limit,3);assert.deepEqual(remote.group_ids,[71]);assert.ok(users[0]!.size);
 assert.equal((await revokeSource(env,m.id,ADMIN.id)).state,'completed');assert.equal(users[0]!.size,0);assert.equal(financialSnapshot(),before);assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('source unavailable with saved observations requires explicit STALE confirmation and never claims revocation',async()=>{
 await refreshSource();sourceDown=true;const m=await propose();const e=JSON.parse(m.entitlement!);assert.equal(e.source,'saved');assert.equal(e.remaining,7*GB_BYTES);
 const done=await confirmMigration(env,ADMIN.id,m.confirmation_token);assert.equal(done.state,'cleanup_pending');assert.equal(JSON.parse(done.entitlement!).confirmedMethod,'explicit_saved_confirmation');
 const result=await revokeSource(env,m.id,ADMIN.id);assert.equal(result.state,'cleanup_pending');assert.equal(result.source_revoked_at,null);assert.equal(result.error,'source_revocation_unconfirmed');assert.equal(users[0]!.size,1);
});
test('unavailable source without trustworthy data stops until explicit manual review and confirmation',async()=>{
 sourceDown=true;const m=await propose();assert.equal(m.entitlement,null);await assert.rejects(confirmMigration(env,ADMIN.id,m.confirmation_token));assert.equal(users[1]!.size,0);
 const manual=await manualEntitlement(env,ADMIN.id,m.id,2*GB_BYTES,expiry,2);assert.equal(JSON.parse(manual.entitlement!).source,'manual');await assert.rejects(confirmMigration(env,ADMIN.id,m.confirmation_token));
 const done=await confirmMigration(env,ADMIN.id,manual.confirmation_token);assert.equal(done.state,'cleanup_pending');assert.equal(JSON.parse(done.entitlement!).confirmedMethod,'explicit_manual_confirmation');assert.equal(users[1]!.get(done.destination_username)!.data_limit,2*GB_BYTES);
});
test('saved data is fingerprint-scoped, timestamped and can be explicitly confirmed even when very stale',async()=>{
 await refreshSource();raw.prepare('UPDATE service_observations SET observed_at=?').run(Date.now()-86400000);sourceDown=true;
 const m=await propose();assert.equal(JSON.parse(m.entitlement!).source,'saved');assert.ok(Date.now()-JSON.parse(m.entitlement!).observedAt>86000000);
 const result=await confirmMigration(env,ADMIN.id,m.confirmation_token);assert.equal(result.state,'cleanup_pending');
});
test('unknown destination create outcome is reconciled after restart without a duplicate POST',async()=>{
 const m=await propose();unknownCreate=true;const interrupted=await confirmMigration(env,ADMIN.id,m.confirmation_token);assert.equal(interrupted.state,'creating');assert.equal(users[1]!.size,1);assert.equal((await getOrderById(db,service))!.panel_id,'legacy');
 hideDestination=false;await recoverServiceMigrations(env);const done=await migrationStatus(env,m.id,ADMIN.id);assert.equal(done.state,'cleanup_pending');assert.equal(users[1]!.size,1);assert.equal(calls.filter(c=>c.n===1&&c.method==='POST'&&c.path==='/api/user').length,1);
});
test('destination failure retains the original service and explicit retry never falls back',async()=>{
 const m=await propose();destDown=true;const failed=await confirmMigration(env,ADMIN.id,m.confirmation_token);assert.equal(failed.state,'creating');assert.equal((await getOrderById(db,service))!.panel_id,'legacy');assert.equal(users[1]!.size,0);
 destDown=false;const done=await advanceMigration(env,m.id,ADMIN.id,true);assert.equal(done.state,'cleanup_pending');assert.equal(users[2]!.size,0);assert.equal(users[0]!.size,1);
});
test('duplicate confirmations and concurrent runners produce exactly one destination resource',async()=>{
 const m=await propose();const result=await Promise.allSettled([confirmMigration(env,ADMIN.id,m.confirmation_token),confirmMigration(env,ADMIN.id,m.confirmation_token)]);assert.ok(result.some(r=>r.status==='fulfilled'));
 await Promise.all([advanceMigration(env,m.id,ADMIN.id,true),advanceMigration(env,m.id,ADMIN.id,true)]);assert.equal(users[1]!.size,1);assert.equal(calls.filter(c=>c.n===1&&c.method==='POST'&&c.path==='/api/user').length,1);
 assert.equal(raw.prepare("SELECT COUNT(*) n FROM service_migration_events WHERE migration_id=? AND action='confirmed'").get(m.id)!.n,1);
});
test('simultaneous migration proposals are serialized and fenced against a second destination',async()=>{
 const attempts=await Promise.allSettled([propose(),propose('third')]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_migrations').get()!.n,1);assert.equal(users[1]!.size+users[2]!.size,0);
});
for(const phase of ['create_attempt','verified','activating','switched'])test(`worker interruption after committed ${phase} phase is recoverable without duplicate destination creation`,async()=>{
 const m=await propose();const restore=interrupt((sql,values)=>phase==='create_attempt'?sql.includes('create_attempts=create_attempts+1'):phase==='verified'?sql.includes('destination_user_id=?2'):phase==='activating'?sql.includes('SET state=?2')&&values[1]==='activating':sql.includes('INSERT INTO active_service_resources'));
 try{await assert.rejects(confirmMigration(env,ADMIN.id,m.confirmation_token));}finally{restore();}
 await recoverServiceMigrations(env);let done=await migrationStatus(env,m.id,ADMIN.id);
 if(phase==='create_attempt'){assert.equal(done.state,'creating');assert.equal(users[1]!.size,0);done=await advanceMigration(env,m.id,ADMIN.id,true);}
 assert.equal(done.state,'cleanup_pending');assert.equal((await getOrderById(db,service))!.panel_id,'dest');assert.equal(users[1]!.size,1);
 assert.equal(calls.filter(c=>c.n===1&&c.method==='POST'&&c.path==='/api/user').length,1);assert.ok(done.destination_url!.endsWith('/activated'));
});
test('failed or uncertain source deletion stays cleanup_pending and retry reconciles before deleting',async()=>{
 const m=await migrate();deleteUncertain=true;let result=await revokeSource(env,m.id,ADMIN.id);assert.equal(result.state,'cleanup_pending');assert.equal(result.source_revoked_at,null);assert.equal((await getOrderById(db,service))!.panel_id,'dest');
 deleteUncertain=false;result=await revokeSource(env,m.id,ADMIN.id);assert.equal(result.state,'completed');const deletes=calls.filter(c=>c.n===0&&c.method==='DELETE').length;await revokeSource(env,m.id,ADMIN.id);assert.equal(calls.filter(c=>c.n===0&&c.method==='DELETE').length,deletes);
});
test('legacy proxy 404 is not accepted as source revocation evidence',async()=>{
 const m=await migrate();proxySource404=true;const result=await revokeSource(env,m.id,ADMIN.id);assert.equal(result.state,'cleanup_pending');assert.equal(result.source_revoked_at,null);assert.equal(calls.filter(c=>c.n===0&&c.method==='DELETE').length,0);
});
test('legacy source username replacement race cannot delete the unrelated replacement',async()=>{
 const m=await migrate();swapAtDelete=true;const result=await revokeSource(env,m.id,ADMIN.id);assert.equal(result.state,'completed');assert.equal(users[0]!.size,1);assert.equal(original().id,'999');assert.ok(calls.some(c=>c.n===0&&c.method==='DELETE'&&c.path==='/api/user/by-id/101'));
});
test('source rename and username replacement after switching revoke only the captured stable ID',async()=>{
 const m=await migrate(),old=original();users[0]!.delete(old.username);users[0]!.set('renamedsource',{...old,username:'renamedsource'});users[0]!.set(old.username,{...old,id:'999'});
 assert.equal((await revokeSource(env,m.id,ADMIN.id)).state,'completed');assert.equal(users[0]!.size,1);assert.equal(original().id,'999');
});
test('customer mismatch or absent source identity cannot propose a migration',async()=>{
 await assert.rejects(proposeMigration(env,ADMIN.id,service,2,'dest'));raw.prepare('UPDATE orders SET pasarguard_user_id=NULL WHERE id=?').run(service);await assert.rejects(propose());assert.equal(users[1]!.size,0);
});
test('destination identity belonging to another customer is rejected BEFORE a mutation',async()=>{
 raw.prepare("INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,pasarguard_username,pasarguard_user_id) VALUES(?,2,'completed','{}',10,'dest','othercustomer','900')").run(newOrderId());
 const m=await propose();maliciousIdentity=true;const result=await confirmMigration(env,ADMIN.id,m.confirmation_token);assert.equal(result.state,'creating');assert.equal(result.error,'destination_identity_owned_elsewhere');assert.equal(calls.filter(c=>c.n===1&&c.method==='PUT').length,0);assert.equal((await getOrderById(db,service))!.panel_id,'legacy');
});
test('credential-bearing subscription URL cannot be persisted or activate a destination',async()=>{
 const m=await propose();maliciousUrl=true;const result=await confirmMigration(env,ADMIN.id,m.confirmation_token);assert.equal(result.state,'creating');assert.equal(result.destination_url,null);assert.equal((await getOrderById(db,service))!.panel_id,'legacy');
});
test('non-admin users and D1-only administrators cannot call migration actions or forged callbacks',async()=>{
 const m=await propose();await assert.rejects(proposeMigration(env,USER.id,service,1,'third'));await assert.rejects(manualEntitlement(env,USER.id,m.id,1,expiry,1));await assert.rejects(confirmMigration(env,USER.id,m.confirmation_token));await assert.rejects(advanceMigration(env,m.id,USER.id,true));await assert.rejects(revokeSource(env,m.id,USER.id));await assert.rejects(migrationStatus(env,m.id,USER.id));await assert.rejects(cancelMigration(env,USER.id,m.id));
 raw.prepare('UPDATE customers SET is_admin=1 WHERE id=1').run();await processTelegramUpdate(callbackUpdateAs(`sm:c:${m.confirmation_token}`,990001,USER),env);assert.equal(users[1]!.size,0);assert.equal((await migrationStatus(env,m.id,ADMIN.id)).state,'review');
});
test('empty allowlist fails closed; another administrator cannot consume the original confirmation',async()=>{
 const m=await propose();env.PANEL_ADMIN_IDS=String(USER.id);await assert.rejects(confirmMigration(env,USER.id,m.confirmation_token));env.ADMIN_CHAT_ID='';env.PANEL_ADMIN_IDS='';await assert.rejects(advanceMigration(env,m.id,ADMIN.id,true));assert.equal(users[1]!.size,0);
});
test('pending renewal/repurchase operations and existing leases block migration proposals',async()=>{
 assert.equal(await acquireServiceLock(db,service,'another-operation'),true);await assert.rejects(propose());await releaseServiceLock(db,service,'another-operation');
 const r=newOrderId();await insertOrderWithEvent(db,{id:r,customerId:1,kind:'renewal',renewsOrderId:service,selections:'{}',amount:10,currency:'IRT',idempotencyKey:newOrderId()});await assert.rejects(propose());assert.equal(users[1]!.size,0);
});
test('a draft fences mutations and its safe cancellation or automatic expiry releases the fence',async()=>{
 let m=await propose();assert.equal(await acquireServiceLock(db,service,'ordinary-operation'),false);await cancelMigration(env,ADMIN.id,m.id);assert.equal(await acquireServiceLock(db,service,'ordinary-operation'),true);await releaseServiceLock(db,service,'ordinary-operation');
 m=await propose();raw.prepare('UPDATE service_migrations SET review_expires_at=0 WHERE id=?').run(m.id);await recoverServiceMigrations(env);assert.equal((await migrationStatus(env,m.id,ADMIN.id)).state,'cancelled');assert.equal(await acquireServiceLock(db,service,'ordinary-operation'),true);
});
test('expired fresh preview, negative usage, exhausted/unlimited entitlement and malformed manual values fail closed',async()=>{
 original().used_traffic=-1;let m=await propose();assert.equal(m.entitlement,null);await cancelMigration(env,ADMIN.id,m.id);
 original().used_traffic=3*GB_BYTES;m=await propose();const e=JSON.parse(m.entitlement!);e.observedAt=Date.now()-61000;raw.prepare('UPDATE service_migrations SET entitlement=? WHERE id=?').run(JSON.stringify(e),m.id);await assert.rejects(confirmMigration(env,ADMIN.id,m.confirmation_token));await cancelMigration(env,ADMIN.id,m.id);
 original().data_limit=0;m=await propose();assert.equal(m.entitlement,null);await assert.rejects(manualEntitlement(env,ADMIN.id,m.id,0,expiry,3));await assert.rejects(manualEntitlement(env,ADMIN.id,m.id,1,0,3));await assert.rejects(manualEntitlement(env,ADMIN.id,m.id,1,expiry,0));
});
test('fresh source values take precedence over older saved observations',async()=>{
 await refreshSource();original().used_traffic=4*GB_BYTES;const m=await propose();const e=JSON.parse(m.entitlement!);assert.equal(e.source,'fresh');assert.equal(e.remaining,6*GB_BYTES);
});
test('source observation for a different panel/identity is not used as entitlement evidence',async()=>{
 raw.prepare("INSERT INTO service_observations(service_id,panel_id,user_id,username,data,observed_at) VALUES(?,'dest','101',?,'{\"quota\":100,\"used\":1,\"expire\":4000000000,\"hwid\":1,\"status\":\"active\"}',?)").run(service,original().username,Date.now());sourceDown=true;assert.equal((await propose()).entitlement,null);
});
test('destination disabled before confirmation cannot receive a new create request',async()=>{
 const m=await propose();raw.prepare("UPDATE panels SET enabled_new=0 WHERE id='dest'").run();const done=await confirmMigration(env,ADMIN.id,m.confirmation_token);assert.equal(done.state,'creating');assert.equal(users[1]!.size,0);assert.equal(calls.filter(c=>c.n===1&&c.method==='POST').length,0);await cancelMigration(env,ADMIN.id,m.id);assert.equal((await getOrderById(db,service))!.panel_id,'legacy');
});
test('migration history protects destination deletion/origin and original entitlement is immutable once confirmed',async()=>{
 const m=await migrate();assert.throws(()=>raw.prepare("DELETE FROM panels WHERE id='dest'").run());assert.throws(()=>raw.prepare("UPDATE panels SET origin='https://different.example.com' WHERE id='dest'").run());assert.throws(()=>raw.prepare('UPDATE service_migrations SET entitlement=? WHERE id=?').run('{}',m.id));assert.throws(()=>raw.prepare('UPDATE service_migrations SET customer_id=2 WHERE id=?').run(m.id));
});
test('late source deletion observations cannot delete a migrated active service',async()=>{
 const old=(await getOrderById(db,service))!,m=await migrate();const result=await markPanelDeleted(db,{orderId:service,panelUsername:old.pasarguard_username!,via:'stale-observation'});assert.equal(result.ok,false);assert.equal((await getOrderById(db,service))!.panel_deleted_at,null);assert.equal(m.state,'cleanup_pending');
});
test('after migration status, renewal, repurchase/reset, notifications and deletion route to the new active resource',async()=>{
 const m=await migrate();await revokeSource(env,m.id,ADMIN.id);calls=[];
 await processTelegramUpdate(callbackUpdateAs(`svc:ref:${service}`,990100,USER),env);assert.ok(calls.some(c=>c.n===1));assert.ok(calls.every(c=>c.n===1));
 const renew=newOrderId();await insertOrderWithEvent(db,{id:renew,customerId:1,kind:'renewal',renewsOrderId:service,selections:JSON.stringify({duration_days:2,renews_order_id:service}),amount:10,currency:'IRT',idempotencyKey:newOrderId(),initialState:'approved'});calls=[];assert.equal((await provisionOrder({env,db,api},{orderId:renew})).ok,true);assert.ok(calls.every(c=>c.n===1));assert.equal((await getOrderById(db,service))!.service_expires_at,new Date((expiry+2*86400)*1000).toISOString());
 const rep=newOrderId();await insertOrderWithEvent(db,{id:rep,customerId:1,kind:'renewal',renewsOrderId:service,repurchaseMode:'custom',selections:JSON.stringify({kind:'repurchase',mode:'custom',volume_gb:8,duration_days:30,device_count:2,repurchases_order_id:service,renews_order_id:service}),amount:100,currency:'IRT',idempotencyKey:newOrderId(),initialState:'approved'});calls=[];assert.equal((await provisionOrder({env,db,api},{orderId:rep})).ok,true);assert.ok(calls.every(c=>c.n===1));assert.ok((await getOrderById(db,service))!.subscription_url!.endsWith('/rotated'));
 users[1]!.get(m.destination_username)!.used_traffic=7.5*GB_BYTES;calls=[];await runServiceNotificationSweep(env,Date.now(),api);assert.ok(calls.some(c=>c.n===1));assert.ok(calls.every(c=>c.n===1));
 calls=[];const active=(await getOrderById(db,service))!;assert.equal((await deletePanelService(env,active.pasarguard_username!,active)).ok,true);assert.ok(calls.every(c=>c.n===1));
});
test('a second explicit migration preserves root history and records the previous active generation',async()=>{
 const first=await migrate();await revokeSource(env,first.id,ADMIN.id);const second=await propose('third');assert.equal(second.source_panel_id,'dest');assert.equal(second.source_user_id,'201');assert.equal(second.source_migration_id,first.id);const done=await confirmMigration(env,ADMIN.id,second.confirmation_token);assert.equal(done.state,'cleanup_pending');assert.equal((await getOrderById(db,service))!.panel_id,'third');assert.equal(raw.prepare('SELECT panel_id FROM orders WHERE id=?').get(service)!.panel_id,'legacy');assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_migrations').get()!.n,2);
});
test('Telegram selection, confirmation, progress and actor-bound revocation buttons work without new credentials',async()=>{
 await migrationCommand(context(),[String(USER.id)]);const select=messages.at(-1)!.buttons.inline_keyboard[0][0].callback_data;await processTelegramUpdate(callbackUpdateAs(select,991000,ADMIN),env);
 // Real dispatch API uses Telegram fetch; recover the stored actor-bound selection instead of inspecting remote chat.
 const choice=raw.prepare("SELECT nonce FROM migration_admin_choices WHERE action='destination' AND panel_id='dest'").get()!;
 await processTelegramUpdate(callbackUpdateAs(`sm:d:${choice.nonce}`,991001,ADMIN),env);const m=raw.prepare('SELECT * FROM service_migrations').get() as unknown as Migration;assert.equal(m.state,'review');
 await processTelegramUpdate(callbackUpdateAs(`sm:c:${m.confirmation_token}`,991002,ADMIN),env);assert.equal((await migrationStatus(env,m.id,ADMIN.id)).state,'verified');
 await processTelegramUpdate(callbackUpdateAs(`sm:r:${m.id}`,991020,ADMIN),env);assert.equal((await migrationStatus(env,m.id,ADMIN.id)).state,'cleanup_pending');
 await processTelegramUpdate(callbackUpdateAs(`sm:x:${m.id}`,991003,ADMIN),env);const revoke=raw.prepare("SELECT nonce FROM migration_admin_choices WHERE action='revoke'").get()!;
 await processTelegramUpdate(callbackUpdateAs(`sm:k:${revoke.nonce}`,991004,USER),env);assert.equal((await migrationStatus(env,m.id,ADMIN.id)).state,'cleanup_pending');
 await processTelegramUpdate(callbackUpdateAs(`sm:k:${revoke.nonce}`,991005,ADMIN),env);assert.equal((await migrationStatus(env,m.id,ADMIN.id)).state,'completed');
 await processTelegramUpdate(callbackUpdateAs(`sm:k:${revoke.nonce}`,991006,ADMIN),env);assert.equal(calls.filter(c=>c.n===0&&c.method==='DELETE').length,1);
});
test('unconfirmed old cleanup does not prevent a second migration, and archived source cleanup cannot revoke the current resource',async()=>{
 const first=await migrate();sourceDown=true;assert.equal((await revokeSource(env,first.id,ADMIN.id)).state,'cleanup_pending');
 const next=await propose('third');const done=await confirmMigration(env,ADMIN.id,next.confirmation_token);assert.equal(done.state,'cleanup_pending');assert.equal((await getOrderById(db,service))!.panel_id,'third');
 sourceDown=false;assert.equal((await revokeSource(env,first.id,ADMIN.id)).state,'completed');assert.equal((await getOrderById(db,service))!.panel_id,'third');assert.equal(users[2]!.size,1);
});
test('migration fence is rechecked atomically when a normal lock acquisition races draft creation',async()=>{
 const base=env.DB;let injected=false;
 env.DB={...base,prepare(sql:string){const stmt=base.prepare(sql);if(sql.startsWith('INSERT INTO panel_service_locks')&&!injected){const bind=stmt.bind.bind(stmt);stmt.bind=(...v:unknown[])=>{if(v[1]==='normal-racing-owner'){injected=true;const id=newOrderId();raw.prepare(`INSERT INTO service_migrations(id,service_id,customer_id,operator,source_panel_id,source_user_id,source_username,destination_panel_id,destination_revision,destination_username,destination_config,state,confirmation_token,review_expires_at,source_origin,destination_origin)
 VALUES(?,?,1,?,'legacy','101',?,'dest',1,?,'{}','review',?,?,'https://migration-source.example.com','https://migration-dest.example.com')`).run(id,service,String(ADMIN.id),original().username,'mg'+id.toLowerCase(),'a'.repeat(32),Date.now()+300000);}return bind(...v);};}return stmt;}} as D1Database;
 assert.equal(await acquireServiceLock(env.DB,service,'normal-racing-owner'),false);assert.equal(raw.prepare('SELECT COUNT(*) n FROM panel_service_locks').get()!.n,0);
});
test('legacy environment origin changes cannot redirect captured source revocation to another panel',async()=>{
 const m=await migrate();env.PASARGUARD_PANEL_URL=origins[2];env.PASARGUARD_API_KEY=keys[2];calls=[];
 const result=await revokeSource(env,m.id,ADMIN.id);assert.equal(result.state,'cleanup_pending');assert.equal(result.source_revoked_at,null);assert.equal(calls.length,0);
});
test('saved observations from a previous legacy origin are not substituted after operator repointing',async()=>{
 await refreshSource();env.PASARGUARD_PANEL_URL=origins[2];env.PASARGUARD_API_KEY=keys[2];const m=await propose();assert.equal(m.entitlement,null);assert.equal(m.source_origin,origins[2]);
});
test('cross-table external identity constraints prevent assigning a migrated user to another customer',async()=>{
 await migrate();const other=newOrderId();assert.throws(()=>raw.prepare("INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,pasarguard_username,pasarguard_user_id) VALUES(?,2,'completed','{}',10,'dest','othercustomer','201')").run(other));
 raw.prepare("INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,pasarguard_username) VALUES(?,2,'completed','{}',10,'dest','othercustomer')").run(other);
 assert.throws(()=>raw.prepare("UPDATE orders SET pasarguard_user_id='201' WHERE id=?").run(other));
 assert.equal((await getOrderById(db,service))!.customer_id,1);
});
test('unknown source delete outcome is confirmed by stable-ID read-back and never blindly reissued',async()=>{
 const m=await migrate();unknownDelete=true;const done=await revokeSource(env,m.id,ADMIN.id);assert.equal(done.state,'completed');assert.ok(done.source_revoked_at);await revokeSource(env,m.id,ADMIN.id);assert.equal(calls.filter(c=>c.n===0&&c.method==='DELETE').length,1);
});
test('interruption before active-binding transaction recovers the activation-rotated URL and never prematurely switches the original',async()=>{
 const m=await propose(),base=env.DB;env.DB={...base,prepare(sql:string){if(sql.includes('INSERT INTO active_service_resources'))throw Error('Synthetic interruption before cutover');return base.prepare(sql);}} as D1Database;db=env.DB;
 try{await assert.rejects(confirmMigration(env,ADMIN.id,m.confirmation_token));}finally{env.DB=base;db=base;}
 assert.equal((await getOrderById(db,service))!.panel_id,'legacy');assert.equal((await migrationStatus(env,m.id,ADMIN.id)).state,'activating');assert.equal(users[1]!.get(m.destination_username)!.status,'active');
 await recoverServiceMigrations(env);const done=await migrationStatus(env,m.id,ADMIN.id);assert.equal(done.state,'cleanup_pending');assert.ok(done.destination_url!.endsWith('/activated'));assert.equal((await getOrderById(db,service))!.subscription_url,done.destination_url);
});
test('customer notification recovery publishes only a persisted active generation and stamps successful delivery',async()=>{
 const m=await migrate();assert.equal(raw.prepare('SELECT customer_notified_at FROM service_migrations WHERE id=?').get(m.id)!.customer_notified_at,null);
 await deliverMigrationNotices(env);assert.ok(raw.prepare('SELECT customer_notified_at FROM service_migrations WHERE id=?').get(m.id)!.customer_notified_at);
 const before=calls.length;await deliverMigrationNotices(env);assert.equal(calls.length,before);
});
test('migration payloads, observations, UI errors and audit records never contain panel credentials',async()=>{
 const m=await propose();destDown=true;await confirmMigration(env,ADMIN.id,m.confirmation_token);await migrationCommand(context(),['status',m.id]);
 const payload=JSON.stringify(['service_migrations','service_migration_events','service_observations'].map(t=>raw.prepare(`SELECT * FROM ${t}`).all()))+JSON.stringify(messages);
 for(const secret of keys)assert.ok(!payload.includes(secret));assert.ok(!payload.includes(env.PANEL_ENCRYPTION_KEY!));
});
test('migrated repurchase interrupted booking recovers only the active resource and keeps raw source history',async()=>{
 const m=await migrate();await revokeSource(env,m.id,ADMIN.id);const historical=JSON.stringify(raw.prepare('SELECT * FROM orders WHERE id=?').get(service));
 const rep=newOrderId();await insertOrderWithEvent(db,{id:rep,customerId:1,kind:'renewal',renewsOrderId:service,repurchaseMode:'custom',selections:JSON.stringify({kind:'repurchase',mode:'custom',volume_gb:8,duration_days:30,device_count:2,repurchases_order_id:service,renews_order_id:service}),amount:100,currency:'IRT',idempotencyKey:newOrderId(),initialState:'approved'});
 const base=env.DB;env.DB={...base,prepare(sql:string){if(sql.includes('SET service_expires_at = CASE'))throw Error('Synthetic booking interruption');return base.prepare(sql);}} as D1Database;db=env.DB;
 try{await provisionOrder({env,db,api},{orderId:rep});}finally{env.DB=base;db=base;}
 assert.equal((await getOrderById(db,rep))!.state,'completed');await recoverPanelOperations(env);assert.ok((await getOrderById(db,service))!.subscription_url!.endsWith('/rotated'));assert.equal(JSON.stringify(raw.prepare('SELECT * FROM orders WHERE id=?').get(service)),historical);
});
test('renewal retry after a migration stays on the active destination despite default switches',async()=>{
 const m=await migrate();await revokeSource(env,m.id,ADMIN.id);
 const renewal=newOrderId();await insertOrderWithEvent(db,{id:renewal,customerId:1,kind:'renewal',renewsOrderId:service,selections:JSON.stringify({duration_days:2,renews_order_id:service}),amount:10,currency:'IRT',idempotencyKey:newOrderId(),initialState:'approved'});
 destDown=true;await provisionOrder({env,db,api},{orderId:renewal});assert.equal((await getOrderById(db,renewal))!.state,'failed');assert.equal((await getOrderById(db,renewal))!.panel_id,'dest');
 raw.prepare("UPDATE panel_selection SET panel_id='third',revision=revision+1").run();destDown=false;calls=[];assert.equal((await provisionOrder({env,db,api},{orderId:renewal,retry:true})).ok,true);assert.ok(calls.every(c=>c.n===1));
});
test('periodic quotas and scheduled plans outside the product model stop automatic entitlement migration',async()=>{
 original().data_limit_reset_strategy='day';original().next_plan={data_limit:20*GB_BYTES};const m=await propose();assert.equal(m.entitlement,null);await assert.rejects(confirmMigration(env,ADMIN.id,m.confirmation_token));assert.equal(users[1]!.size,0);
 const evidence=JSON.stringify(raw.prepare('SELECT data FROM service_migration_events WHERE migration_id=?').all(m.id));assert.ok(evidence.includes('periodic_quota_reset'));assert.ok(evidence.includes('scheduled_next_plan'));
});
test('a pre-switch migration blocks new lifecycle checkout at the database layer without financial writes',async()=>{
 await propose();const before=financialSnapshot();await assert.rejects(insertOrderWithEvent(db,{id:newOrderId(),customerId:1,kind:'renewal',renewsOrderId:service,selections:'{}',amount:10,currency:'IRT',idempotencyKey:newOrderId()}));assert.equal(financialSnapshot(),before);
});
test('customer wallet repurchase confirmation during migration performs no debit, payment ledger or new order',async()=>{
 raw.prepare('UPDATE customers SET balance_irt=1000000 WHERE id=1').run();
 await processTelegramUpdate(callbackUpdateAs(`svc:rep:${service}`,992000,USER),env);await processTelegramUpdate(callbackUpdateAs('rep:same',992001,USER),env);
 const session=raw.prepare('SELECT state FROM conversation_states WHERE customer_id=1').get();assert.equal(session?.state,'WAITING_REPURCHASE_CONFIRMATION');
 await propose();calls=[];const balances=raw.prepare('SELECT balance_irt FROM customers WHERE id=1').get()!.balance_irt;
 await processTelegramUpdate(callbackUpdateAs('wlt:full',992002,USER),env);
 assert.equal(raw.prepare('SELECT balance_irt FROM customers WHERE id=1').get()!.balance_irt,balances);assert.equal(raw.prepare('SELECT COUNT(*) n FROM wallet_entries').get()!.n,1);assert.equal(raw.prepare('SELECT COUNT(*) n FROM orders').get()!.n,1);assert.equal(calls.length,0);
});
test('verified staging is a durable separate-request checkpoint and is not reported active before cutover',async()=>{
 const m=await propose();const staged=await confirmOnce(env,ADMIN.id,m.confirmation_token);assert.equal(staged.state,'verified');assert.equal((await getOrderById(db,service))!.panel_id,'legacy');assert.equal(users[1]!.get(staged.destination_username)!.status,'disabled');
 const active=await advanceOnce(env,m.id,ADMIN.id,false);assert.equal(active.state,'cleanup_pending');assert.equal((await getOrderById(db,service))!.panel_id,'dest');
});
test('migrating one service does not change the global default for unrelated new paid orders',async()=>{
 raw.prepare("UPDATE panel_selection SET panel_id='third',revision=revision+1").run();await migrate();assert.equal(raw.prepare('SELECT panel_id FROM panel_selection').get()!.panel_id,'third');
 const newService=newOrderId();await insertOrderWithEvent(db,{id:newService,customerId:1,selections:JSON.stringify({volume_gb:10,duration_days:30,device_count:1,config_name:'New paid'}),amount:100,currency:'IRT',idempotencyKey:newOrderId(),initialState:'approved'});calls=[];assert.equal((await provisionOrder({env,db,api},{orderId:newService})).ok,true);assert.ok(calls.every(c=>c.n===2));assert.equal((await getOrderById(db,service))!.panel_id,'dest');
});
test('safe abort after an uncertain create confirms unpublished candidate absence and preserves the source and finances',async()=>{
 const before=financialSnapshot(),m=await propose();unknownCreate=true;await confirmMigration(env,ADMIN.id,m.confirmation_token);hideDestination=false;
 const cancelled=await cancelMigration(env,ADMIN.id,m.id);assert.equal(cancelled.state,'cancelled');assert.equal(users[1]!.size,0);assert.equal((await getOrderById(db,service))!.panel_id,'legacy');assert.equal(users[0]!.size,1);assert.equal(financialSnapshot(),before);
});
test('safe abort of a verified disabled candidate does not touch the original service or claim source revocation',async()=>{
 const m=await propose();const staged=await confirmOnce(env,ADMIN.id,m.confirmation_token);assert.equal(staged.state,'verified');const cancelled=await cancelMigration(env,ADMIN.id,m.id);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.source_revoked_at,null);assert.equal(users[0]!.size,1);assert.equal(users[1]!.size,0);
});
test('unconfirmed abort is durable and prevents recovery from activating the candidate',async()=>{
 const m=await propose();await confirmOnce(env,ADMIN.id,m.confirmation_token);destDown=true;const blocked=await cancelMigration(env,ADMIN.id,m.id);assert.equal(blocked.state,'verified');assert.equal(blocked.abort_requested,1);
 destDown=false;await recoverServiceMigrations(env);await advanceMigration(env,m.id,ADMIN.id);assert.equal((await getOrderById(db,service))!.panel_id,'legacy');assert.equal(users[1]!.get(m.destination_username)!.status,'disabled');assert.throws(()=>raw.prepare('UPDATE service_migrations SET abort_requested=0 WHERE id=?').run(m.id));
 assert.equal((await cancelMigration(env,ADMIN.id,m.id)).state,'cancelled');
});
test('abort cannot delete a published active replacement',async()=>{
 const m=await migrate();await assert.rejects(cancelMigration(env,ADMIN.id,m.id));assert.equal(users[1]!.size,1);assert.equal((await getOrderById(db,service))!.panel_id,'dest');
});
test('fresh entitlement is reverified at confirmation; changed usage is never silently transferred as the previous larger quota',async()=>{
 const m=await propose();original().used_traffic=4*GB_BYTES;await assert.rejects(confirmOnce(env,ADMIN.id,m.confirmation_token),/fresh_preview_changed/);assert.equal(users[1]!.size,0);assert.equal((await migrationStatus(env,m.id,ADMIN.id)).state,'review');
});
test('migration back to legacy keeps stable-ID lifecycle mutations and pins the active origin',async()=>{
 const first=await migrate();await revokeSource(env,first.id,ADMIN.id);const next=await propose('legacy');const done=await confirmMigration(env,ADMIN.id,next.confirmation_token);assert.equal(done.state,'cleanup_pending');const active=(await getOrderById(db,service))!;assert.equal(active.panel_id,'legacy');assert.equal(active.active_migration_id,next.id);
 calls=[];assert.equal((await deletePanelService(env,active.pasarguard_username!,active)).ok,true);assert.ok(calls.some(c=>c.method==='DELETE'&&c.path.startsWith('/api/user/by-id/')));
 env.PASARGUARD_PANEL_URL=origins[2];env.PASARGUARD_API_KEY=keys[2];calls=[];assert.equal((await deletePanelService(env,active.pasarguard_username!,active)).ok,false);assert.equal(calls.length,0);
});
test('source not-found under OWN scope is not proof of revocation; ALL scope can later reconcile absence',async()=>{
 const m=await migrate();restrictedReadScope=true;const blocked=await revokeSource(env,m.id,ADMIN.id);assert.equal(blocked.state,'cleanup_pending');assert.equal(blocked.source_revoked_at,null);assert.equal(blocked.error,'source_absence_scope_unverified');assert.equal(users[0]!.size,0);
 restrictedReadScope=false;assert.equal((await revokeSource(env,m.id,ADMIN.id)).state,'completed');assert.equal(calls.filter(c=>c.n===0&&c.method==='DELETE').length,1);
});
test('an invisible scoped source user cannot be declared revoked or silently deleted',async()=>{
 const m=await migrate(),wrapped=fetch;restrictedReadScope=true;globalThis.fetch=(async(input,init)=>new URL(String(input)).origin===origins[0]&&new URL(String(input)).pathname.startsWith('/api/user/')?Response.json({detail:'User not found'},{status:404}):wrapped(input,init)) as typeof fetch;
 const result=await revokeSource(env,m.id,ADMIN.id);assert.equal(result.state,'cleanup_pending');assert.equal(result.source_revoked_at,null);assert.equal(result.error,'source_absence_scope_unverified');assert.equal(users[0]!.size,1);
});
test('candidate abort cannot claim cleanup from scoped not-found alone',async()=>{
 const m=await propose();await confirmOnce(env,ADMIN.id,m.confirmation_token);restrictedReadScope=true;const blocked=await cancelMigration(env,ADMIN.id,m.id);assert.equal(blocked.state,'verified');assert.equal(blocked.abort_requested,1);assert.equal(blocked.error,'candidate_absence_scope_unverified');
 restrictedReadScope=false;assert.equal((await cancelMigration(env,ADMIN.id,m.id)).state,'cancelled');assert.equal((await getOrderById(db,service))!.panel_id,'legacy');
});

test('OWN-scoped hidden migrated resources cannot be stamped deleted by status or notifications',async()=>{
 const m=await migrate(),wrapped=fetch;restrictedReadScope=true;
 globalThis.fetch=(async(input,init)=>new URL(String(input)).origin===origins[1]&&new URL(String(input)).pathname.startsWith('/api/user/')?Response.json({detail:'User not found'},{status:404}):wrapped(input,init)) as typeof fetch;
 calls=[];await processTelegramUpdate(callbackUpdateAs(`svc:ref:${service}`,993901,USER),env);
 await runServiceNotificationSweep(env,Date.now(),api);
 assert.equal((await getOrderById(db,service))!.panel_deleted_at,null);assert.ok(users[1]!.has(m.destination_username));
 assert.ok(calls.some(c=>c.n===1&&c.path==='/api/admin'));assert.ok(calls.every(c=>c.method!=='DELETE'));
});
test('OWN-scoped hidden migrated resources cannot be deleted or confirmed absent by lifecycle cleanup',async()=>{
 const m=await migrate(),wrapped=fetch;restrictedReadScope=true;
 globalThis.fetch=(async(input,init)=>new URL(String(input)).origin===origins[1]&&new URL(String(input)).pathname.startsWith('/api/user/')?Response.json({detail:'User not found'},{status:404}):wrapped(input,init)) as typeof fetch;
 const active=(await getOrderById(db,service))!;calls=[];
 const result=await deletePanelService(env,active.pasarguard_username!,active);assert.equal(result.ok,false);
 assert.equal((await getOrderById(db,service))!.panel_deleted_at,null);assert.ok(users[1]!.has(m.destination_username));assert.ok(calls.every(c=>c.method!=='DELETE'));
});
test('globally visible certified absence can still mark a genuinely missing migrated resource deleted',async()=>{
 const m=await migrate();users[1]!.delete(m.destination_username);calls=[];
 await processTelegramUpdate(callbackUpdateAs(`svc:ref:${service}`,993902,USER),env);
 assert.notEqual((await getOrderById(db,service))!.panel_deleted_at,null);assert.ok(calls.some(c=>c.n===1&&c.path==='/api/admin'));
});

test('repeated identical migration blocks back off durably, coalesce diagnostics and allow manual recovery',async()=>{
 const draft=await propose();destDown=true;let m=await confirmOnce(env,ADMIN.id,draft.confirmation_token);
 assert.equal(m.state,'creating');assert.equal(m.blocked_count,1);assert.equal(m.next_recovery_at,0);
 const firstEventCount=raw.prepare("SELECT COUNT(*) n FROM service_migration_events WHERE migration_id=? AND action='blocked'").get(m.id)!.n;
 await recoverOnce(env);m=await migrationStatus(env,m.id,ADMIN.id);assert.equal(m.blocked_count,2);assert.ok(m.next_recovery_at>Date.now());
 assert.equal(raw.prepare("SELECT COUNT(*) n FROM service_migration_events WHERE migration_id=? AND action='blocked'").get(m.id)!.n,firstEventCount);
 const at=m.updated_at,callCount=calls.length;await recoverOnce(env);await advanceOnce(env,m.id,ADMIN.id,false,true);assert.equal(calls.length,callCount);assert.equal((await migrationStatus(env,m.id,ADMIN.id)).updated_at,at);
 // Due time survives another Worker instance. A manual retry does not await it.
 destDown=false;m=await advanceOnce(env,m.id,ADMIN.id,true);assert.equal(m.state,'verified');assert.equal(m.blocked_count,0);assert.equal(m.next_recovery_at,0);
 await recoverOnce(env);assert.equal((await migrationStatus(env,m.id,ADMIN.id)).state,'cleanup_pending');assert.equal((await migrationStatus(env,m.id,ADMIN.id)).source_revoked_at,null);
});
test('automatic migration recovery honors persisted due time and retries after expiry',async()=>{
 const draft=await propose();destDown=true;let m=await confirmOnce(env,ADMIN.id,draft.confirmation_token);await recoverOnce(env);m=await migrationStatus(env,m.id,ADMIN.id);
 const count=calls.length;await recoverOnce(env);assert.equal(calls.length,count);
 raw.prepare('UPDATE service_migrations SET next_recovery_at=0 WHERE id=?').run(m.id);await recoverOnce(env);assert.ok(calls.length>count);assert.equal((await migrationStatus(env,m.id,ADMIN.id)).blocked_count,3);
});
test('optimized observation lookup excludes historical source after migration and accepts only current exact identity',async()=>{
 const p=await resolvePanel(env,'legacy');assert.ok(p.ok);if(!p.ok)return;
 const before=raw.prepare('SELECT COUNT(*) n FROM service_observations').get()!.n;await p.config.onVerifiedUser!({id:'101',username:original().username,dataLimit:1000,usedTraffic:10,expire:expiry,hwidLimit:3,status:'active'} as any);
 assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_observations').get()!.n,Number(before)+1);
 const m=await migrate(),count=raw.prepare('SELECT COUNT(*) n FROM service_observations').get()!.n;
 await p.config.onVerifiedUser!({id:'101',username:original().username,dataLimit:1000,usedTraffic:10,expire:expiry,hwidLimit:3,status:'active'} as any);assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_observations').get()!.n,count);
 const dest=await resolvePanel(env,'dest');assert.ok(dest.ok);if(!dest.ok)return;
 await dest.config.onVerifiedUser!({id:m.destination_user_id,username:m.destination_username,dataLimit:1000,usedTraffic:10,expire:expiry,hwidLimit:3,status:'active'} as any);assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_observations').get()!.n,Number(count)+1);
 await dest.config.onVerifiedUser!({id:m.destination_user_id,username:'wrong',dataLimit:1000,usedTraffic:10} as any);await dest.config.onVerifiedUser!({id:'missing',username:'missing',dataLimit:1000,usedTraffic:10} as any);assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_observations').get()!.n,Number(count)+1);
});
test('optimized observation lookup rejects ambiguous base/current identity instead of cross-customer observation',async()=>{
 const m=await migrate(),p=await resolvePanel(env,'dest');assert.ok(p.ok);if(!p.ok)return;
 // Cross-table legacy inconsistencies can evade each individual table's unique index.
 const insert=()=>raw.prepare("INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,pasarguard_user_id,pasarguard_username) VALUES('ambiguous-other-customer',2,'completed','{}',100,'dest',?,?)").run(m.destination_user_id,m.destination_username);
 assert.throws(insert,/active_external_identity_conflict/);
 // Simulate a pre-corrupted/imported isolated database for defense-in-depth
 // lookup testing. Production constraints are not removed or relaxed.
 for(const t of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%active_external_identity_conflict%'").all())raw.exec('DROP TRIGGER "'+t.name+'"');
 insert();
 const count=raw.prepare('SELECT COUNT(*) n FROM service_observations').get()!.n;
 await p.config.onVerifiedUser!({id:m.destination_user_id,username:m.destination_username,dataLimit:1000,usedTraffic:10} as any);
 assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_observations').get()!.n,count);
});

test('revoked operators cannot occupy the recovery limit and starve an authorized due migration',async()=>{
 const draft=await propose();destDown=true;const m=await confirmOnce(env,ADMIN.id,draft.confirmation_token);
 const columns=raw.prepare('PRAGMA table_info(service_migrations)').all().map(v=>String(v.name));
 const template=raw.prepare('SELECT * FROM service_migrations WHERE id=?').get(m.id)!;
 for(let n=0;n<25;n++){
  const sid='revoked-service-'+n,uid=String(1000+n),name='revoked-user-'+n;
  raw.prepare("INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,pasarguard_user_id,pasarguard_username) VALUES(?,2,'completed','{}',100,'legacy',?,?)").run(sid,uid,name);
  const copy={...template,id:'aaa-revoked-'+n,service_id:sid,customer_id:2,operator:'999999999',source_user_id:uid,source_username:name,destination_username:'revoked-dest-'+n,confirmation_token:'revoked-nonce-'+n,last_recovery_at:0,next_recovery_at:0};
  raw.prepare('INSERT INTO service_migrations('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(c=>copy[c as keyof typeof copy]));
 }
 const before=calls.length;await recoverOnce(env);assert.ok(calls.length>before);assert.equal((await migrationStatus(env,m.id,ADMIN.id)).blocked_count,2);
 assert.equal(raw.prepare("SELECT SUM(blocked_count) n FROM service_migrations WHERE operator='999999999'").get()!.n,25,'unauthorized rows retain their prior evidence without being advanced');
});

// Permanent 5.4.1 group and shared-localization regressions.
for(const locale of ['fa','en'] as const){
 test(`migration ${locale} command help, selection and review use shared dictionary and isolated IDs`,async()=>{
  const ctx={...context(),ui:uiFor(locale)},t=ctx.ui.t;
  await migrationCommand(ctx,[]);assert.ok(messages.at(-1)!.text.startsWith(t.migrationUsage.split('{commands}')[0]));
  await migrationCommand(ctx,[String(USER.id)]);const choice=messages.at(-1)!;assert.ok(choice.text.includes(locale==='fa'?'یک سرویس انتخاب کنید':'select a service'));assert.ok(choice.buttons.inline_keyboard[0][0].text.includes(locale==='fa'?'سرویس':'Service'));
  const draft=await propose();await migrationCommand(ctx,['status',draft.id]);const card=messages.at(-1)!;
  assert.ok(card.text.includes(t.migrationFresh));assert.ok(card.text.includes(t.migrationStateReview));assert.ok(card.text.includes('\u2066'+draft.id+'\u2069'));
  assert.ok(card.text.includes(String(7*GB_BYTES)));assert.ok(card.text.includes(new Date(expiry*1000).toISOString()));assert.ok(card.text.includes('71'));
  assert.equal(card.buttons.inline_keyboard[0][0].text,t.migrationConfirmFresh);assert.equal(card.buttons.inline_keyboard.at(-1)[0].text,t.migrationRefresh);
 });
 test(`migration ${locale} dispatch callbacks follow saved operator locale through activation and revocation`,async()=>{
  raw.prepare('UPDATE customers SET language=? WHERE telegram_user_id=?').run(locale,String(ADMIN.id));
  const draft=await propose();await processTelegramUpdate(callbackUpdateAs(`sm:c:${draft.confirmation_token}`,998100,ADMIN),env);
  const staged=messages.at(-1)!;assert.ok(staged.text.includes(uiFor(locale).t.migrationStateVerified));assert.ok(staged.buttons.inline_keyboard.flat().some((b:any)=>b.text===uiFor(locale).t.migrationContinue));
  await processTelegramUpdate(callbackUpdateAs(`sm:r:${draft.id}`,998101,ADMIN),env);assert.ok(messages.at(-1)!.text.includes(uiFor(locale).t.migrationStateCleanupPending));
  await processTelegramUpdate(callbackUpdateAs(`sm:x:${draft.id}`,998102,ADMIN),env);assert.equal(messages.at(-1)!.buttons.inline_keyboard[0][0].text,uiFor(locale).t.migrationConfirmRevoke);assert.ok(messages.at(-1)!.text.includes(locale==='fa'?'حذف فقط':'ONLY source'));
  const token=raw.prepare("SELECT nonce FROM migration_admin_choices WHERE action='revoke'").get()!;
  await processTelegramUpdate(callbackUpdateAs(`sm:k:${token.nonce}`,998103,ADMIN),env);assert.ok(messages.at(-1)!.text.includes(uiFor(locale).t.migrationStateCompleted));
 });
 test(`migration ${locale} stale and manual reviews retain distinct confirmation labels`,async()=>{
  await refreshSource();sourceDown=true;let draft=await propose();const ctx={...context(),ui:uiFor(locale)},t=ctx.ui.t;
  await migrationCommand(ctx,['status',draft.id]);assert.ok(messages.at(-1)!.text.includes(t.migrationSaved));assert.equal(messages.at(-1)!.buttons.inline_keyboard[0][0].text,t.migrationConfirmSaved);
  await migrationCommand(ctx,['manual',draft.id,'1000000',new Date(expiry*1000).toISOString().replace('.000Z','Z'),'2']);assert.ok(messages.at(-1)!.text.includes(t.migrationManual));assert.equal(messages.at(-1)!.buttons.inline_keyboard[0][0].text,t.migrationConfirmManual);
 });
 test(`migration ${locale} authorization, validation and blocked recovery errors are localized and redacted`,async()=>{
  const ctx={...context(),ui:uiFor(locale)},t=ctx.ui.t;
  await migrationCommand({...context(USER),ui:uiFor(locale)},[]);assert.equal(messages.at(-1)!.text,t.migrationDenied);
  await migrationCommand(ctx,['manual',service,'1','not-a-date','1']);assert.ok(messages.at(-1)!.text.includes(t.migrationError_use_explicit_UTC_timestamp));assert.ok(!messages.at(-1)!.text.includes('use_explicit_UTC_timestamp'));
  const draft=await propose();destDown=true;await confirmOnce(env,ADMIN.id,draft.confirmation_token);await migrationCommand(ctx,['status',draft.id]);assert.ok(messages.at(-1)!.text.includes(t.migrationError_destination_groups_unverified));for(const key of keys)assert.ok(!messages.at(-1)!.text.includes(key));
 });
 test(`scheduled migration handoff ${locale} follows customer preference, not operator language`,async()=>{
  raw.prepare('UPDATE customers SET language=? WHERE id=1').run(locale);raw.prepare('UPDATE customers SET language=? WHERE id=3').run(locale==='fa'?'en':'fa');
  const done=await migrate();messages=[];await deliverMigrationNotices(env);const notice=messages.find(v=>v.chat===USER.id)!;
  assert.ok(notice.text.startsWith(uiFor(locale).t.migrationCustomerNotice.split('{url}')[0]));assert.ok(notice.text.includes(done.destination_url!));assert.ok(notice.text.includes('\u2066'+done.destination_url+'\u2069'));
  assert.ok(raw.prepare('SELECT customer_notified_at FROM service_migrations WHERE id=?').get(done.id)!.customer_notified_at);
 });
}
test('destination receives saved numeric group IDs, exact remaining quota, absolute expiry and device limit',async()=>{
 raw.prepare("UPDATE panels SET group_ids='[71,93]' WHERE id='dest'").run();const draft=await propose();await confirmMigration(env,ADMIN.id,draft.confirmation_token);
 const create=calls.find(c=>c.n===1&&c.method==='POST'&&c.path==='/api/user')!;assert.deepEqual(create.body.group_ids,[71,93]);assert.equal(create.body.data_limit,7*GB_BYTES);assert.equal(create.body.expire,expiry);assert.equal(create.body.hwid_limit,3);
});
test('changing panel defaults after review does not substitute different groups in a pending migration',async()=>{
 const draft=await propose();raw.prepare("UPDATE panels SET group_ids='[99]',revision=revision+1 WHERE id='dest'").run();
 // Credential AAD rotates with panel revision, exactly as real secure edits do.
 const cipher=await encrypt(env,`panel:dest:2:${origins[1]}:credentials`,{apiKey:keys[1]});raw.prepare('UPDATE panels SET credentials=? WHERE id=?').run(cipher,'dest');
 await confirmMigration(env,ADMIN.id,draft.confirmation_token);assert.deepEqual(calls.find(c=>c.n===1&&c.method==='POST'&&c.path==='/api/user')!.body.group_ids,[71]);
});
for(const failure of ['missing','permission','disabled','malformed'] as const)test(`migration rejects ${failure} destination group before creation without source loss`,async()=>{
 const draft=await propose(),fetchBefore=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{const u=new URL(String(input));if(u.origin===origins[1]&&u.pathname.startsWith('/api/group/'))return failure==='missing'?Response.json({detail:'Group not found'},{status:404}):failure==='permission'?Response.json({detail:keys[1]},{status:403}):Response.json({id:71,name:'Destination',...(failure==='disabled'?{is_disabled:true}:{})});return fetchBefore(input,init);};
 const done=await confirmOnce(env,ADMIN.id,draft.confirmation_token);assert.equal(done.state,'creating');assert.equal(done.error,failure==='disabled'?'destination_groups_disabled':'destination_groups_unverified');assert.equal(users[1]!.size,0);assert.equal((await getOrderById(db,service))!.panel_id,'legacy');assert.equal(calls.filter(c=>c.n===0&&c.method==='DELETE').length,0);
});
test('empty and duplicate destination defaults cannot open a migration draft',async()=>{
 for(const config of ['[]','[71,71]']){raw.prepare('UPDATE panels SET group_ids=? WHERE id=?').run(config,'dest');await assert.rejects(propose(),/panel_groups_invalid/);}
 assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_migrations').get()!.n,0);assert.equal(users[1]!.size,0);
});
test('destination group read-back mismatch prevents staging and cutover instead of accepting panel substitution',async()=>{
 const draft=await propose(),f=globalThis.fetch;globalThis.fetch=async(input,init)=>{const response=await f(input,init),u=new URL(String(input));if(u.origin===origins[1]&&u.pathname.startsWith('/api/user/')&&init?.method==='GET'&&response.ok)return Response.json({...await response.json() as any,group_ids:[999]});return response;};
 const done=await confirmOnce(env,ADMIN.id,draft.confirmation_token);assert.equal(done.error,'destination_groups_mismatch');assert.equal((await getOrderById(db,service))!.panel_id,'legacy');assert.equal(users[0]!.size,1);
});
test('deleted group after disabled staging blocks activation and remains safely retryable',async()=>{
 const draft=await propose(),staged=await confirmOnce(env,ADMIN.id,draft.confirmation_token);assert.equal(staged.state,'verified');const f=globalThis.fetch;globalThis.fetch=async(input,init)=>String(input).startsWith(origins[1]+'/api/group/')?Response.json({detail:'Group not found'},{status:404}):f(input,init);
 const blocked=await advanceOnce(env,draft.id,ADMIN.id,false);assert.equal(blocked.state,'verified');assert.equal(blocked.error,'destination_groups_unverified');assert.equal((await getOrderById(db,service))!.panel_id,'legacy');assert.equal(users[1]!.get(draft.destination_username)!.status,'disabled');
 globalThis.fetch=f;const done=await advanceOnce(env,draft.id,ADMIN.id,false);assert.equal(done.state,'cleanup_pending');assert.equal(done.source_revoked_at,null);
});
test('activation read-back must retain reviewed groups even when an external actor changes the candidate',async()=>{
 const draft=await propose();await confirmOnce(env,ADMIN.id,draft.confirmation_token);users[1]!.get(draft.destination_username)!.group_ids=[999];const done=await advanceOnce(env,draft.id,ADMIN.id,false);assert.equal(done.error,'destination_groups_mismatch');assert.equal(done.state,'activating');assert.equal((await getOrderById(db,service))!.panel_id,'legacy');assert.equal(users[0]!.size,1);
});
test('absent destination never triggers automatic creation after group validation succeeds',async()=>{
 const draft=await propose();destDown=true;await confirmOnce(env,ADMIN.id,draft.confirmation_token);destDown=false;await recoverOnce(env);assert.equal(users[1]!.size,0);assert.equal((await migrationStatus(env,draft.id,ADMIN.id)).error,'destination_absent_explicit_retry_required');
});
test('migration customer notification defaults to Persian even with an English Telegram language hint',async()=>{
 raw.prepare("UPDATE customers SET language=NULL,language_code='en' WHERE id=1").run();await migrate();messages=[];await deliverMigrationNotices(env);assert.ok(messages.find(m=>m.chat===USER.id)!.text.startsWith(FA_UI.t.migrationCustomerNotice.split('{url}')[0]));
});
for(const locale of ['fa','en'] as const)test(`migration ${locale} callback responses and safe-abort confirmation are localized`,async()=>{
 const answers:string[]=[],ctx={...context(),ui:uiFor(locale),api:{...api,answerCallbackQuery:async(_id:string,text?:string)=>{if(text)answers.push(text);}} as UpdateContext['api']},t=ctx.ui.t;
 await migrationCallback({...ctx,actor:USER,chatId:USER.id},'sm:s:'+service,'deny');assert.equal(answers.at(-1),t.migrationDenied);
 const draft=await propose();await confirmOnce(env,ADMIN.id,draft.confirmation_token);await migrationCallback(ctx,'sm:n:'+draft.id,'abort-review');assert.equal(answers.at(-1),t.migrationChecking);assert.equal(messages.at(-1)!.text,t.migrationAbortPrompt);assert.equal(messages.at(-1)!.buttons.inline_keyboard[0][0].text,t.migrationConfirmAbort);
 const token=raw.prepare("SELECT nonce FROM migration_admin_choices WHERE action='abort'").get()!;await migrationCallback(ctx,'sm:a:'+token.nonce,'abort-confirm');assert.ok(messages.at(-1)!.text.includes(t.migrationStateCancelled));assert.equal((await getOrderById(db,service))!.panel_id,'legacy');assert.equal(users[0]!.size,1);assert.equal(users[1]!.size,0);
});
test('slow destination group validation is bounded and cannot proceed to remote creation after its deadline',async()=>{
 const draft=await propose(),f=globalThis.fetch,clock=Date.now;let now=clock();
 Date.now=()=>now;globalThis.fetch=async(input,init)=>{const response=await f(input,init);if(String(input).startsWith(origins[1]+'/api/group/'))now+=30001;return response;};
 try{const done=await confirmOnce(env,ADMIN.id,draft.confirmation_token);assert.equal(done.state,'creating');assert.equal(done.error,'destination_groups_unverified');assert.equal(users[1]!.size,0);assert.equal((await getOrderById(db,service))!.panel_id,'legacy');assert.equal(users[0]!.size,1);}finally{Date.now=clock;globalThis.fetch=f;}
});
