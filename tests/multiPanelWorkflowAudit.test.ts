/** Workflow audit regressions: isolated D1 and three independent mock panels. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, makeD1Shim, ADMIN, USER, callbackUpdateAs } from './helpers.ts';
import { encrypt } from '../src/panels/security.ts';
import { acquireServiceLock, releaseServiceLock, clientFor, resolvePanel } from '../src/panels/registry.ts';
import { recoverPanelOperations } from '../src/panels/recovery.ts';
import { provisionOrder, deletePanelService, GB_BYTES } from '../src/provision/provision.ts';
import { insertOrderWithEvent, getOrderById } from '../src/db/orders.ts';
import { processTelegramUpdate } from '../src/dispatch.ts';
import { runServiceNotificationSweep } from '../src/handlers/serviceNotifications.ts';
import { newOrderId } from '../src/lib/security.ts';
import type { Env, UpdateContext } from '../src/types.ts';
const origins=['https://audit-legacy.example.com','https://audit-blue.example.com','https://audit-green.example.com'];
const keys=['SYNTHETIC-AUDIT-LEGACY','SYNTHETIC-AUDIT-BLUE','SYNTHETIC-AUDIT-GREEN'];
const ids=['legacy','blue','green'];
let raw:DatabaseSync,db:D1Database,env:Env,real:typeof fetch;
let users:Map<string,Record<string,unknown>>[],calls:{panel:number;path:string;method:string;body:Record<string,unknown>|null}[];
let update:number,badRepairEnvelope:boolean,missingCreateExpiry:boolean,swapMutation:string|null;
const api={sendMessage:async()=>{},answerCallbackQuery:async()=>{},editMessageText:async()=>{}} as unknown as UpdateContext['api'];
beforeEach(async()=>{
 raw=freshDb();db=makeD1Shim(raw) as unknown as D1Database;
 env={DB:db,ADMIN_CHAT_ID:String(ADMIN.id),TELEGRAM_BOT_TOKEN:'SYNTHETIC-BOT',TELEGRAM_WEBHOOK_SECRET:'SYNTHETIC-WEBHOOK',PASARGUARD_PANEL_URL:origins[0],PASARGUARD_API_KEY:keys[0],PANEL_ENCRYPTION_KEY:btoa('x'.repeat(32))};
 raw.prepare('INSERT INTO customers(telegram_user_id) VALUES(?)').run(String(USER.id));
 for(let n=1;n<3;n++){
  const cipher=await encrypt(env,`panel:${ids[n]}:1:${origins[n]}:credentials`,{apiKey:keys[n]});
  raw.prepare("INSERT INTO panels(id,name,origin,credentials,group_ids,enabled_new,last_test) VALUES(?,?,?,?,?,1,'ok')").run(ids[n]!,ids[n]!,origins[n]!,cipher,JSON.stringify([70+n]));
 }
 raw.prepare("UPDATE settings SET value=? WHERE key='repurchase'").run(JSON.stringify({schema:1,enabled:true,near_expiry_days:7}));
 users=[new Map(),new Map(),new Map()];calls=[];update=800000;badRepairEnvelope=false;missingCreateExpiry=false;swapMutation=null;real=fetch;
 globalThis.fetch=(async(input,init)=>{
  const u=new URL(String(input)),method=init?.method??'GET';
  if(u.origin==='https://api.telegram.org')return Response.json({ok:true,result:{}});
  if(u.origin==='https://cloudflare-dns.com')return Response.json({Status:0,Answer:[{type:1,data:'8.8.8.8'}]});
  const n=origins.indexOf(u.origin);assert.ok(n>=0,'Unintended destination');
  assert.equal(new Headers(init?.headers).get('x-api-key'),keys[n]);assert.equal(new Headers(init?.headers).get('authorization'),null);assert.equal(init?.redirect,'manual');
  const body=init?.body?JSON.parse(String(init.body)):null;calls.push({panel:n,path:u.pathname,method,body});
  // Assert ownership BEFORE every remote user request (including initial lookup).
  if(u.pathname.startsWith('/api/user')){
   const username=body?.username ?? (u.pathname.startsWith('/api/user/by-username/')?decodeURIComponent(u.pathname.slice('/api/user/by-username/'.length).replace(/\/reset$/,'')):null);
   if(username){const o=raw.prepare('SELECT panel_id FROM orders WHERE pasarguard_username=?').get(username);assert.ok(o);assert.equal(o.panel_id,ids[n]);}
  }
  if(u.pathname==='/api/user'&&method==='POST'){
   const user={...body,id:String((n+1)*100+users[n]!.size+1),used_traffic:0,subscription_url:`/sub/${body.username}`};
   if(missingCreateExpiry)user.expire=null;
   users[n]!.set(body.username,user);return Response.json(user);
  }
  let username=u.pathname.startsWith('/api/user/by-username/')?decodeURIComponent(u.pathname.slice('/api/user/by-username/'.length).replace(/\/reset$/,'')):null;
  let user=username?users[n]!.get(username):[...users[n]!.values()].find(v=>String(v.id)===u.pathname.split('/')[4]);
  if(user && swapMutation===method && method!=='GET'){
   swapMutation=null;const name=user.username as string;
   users[n]!.set(name,{...user,id:'999',expire:100,used_traffic:123,subscription_url:'/sub/replacement'});
   user=username?users[n]!.get(username):[...users[n]!.values()].find(v=>String(v.id)===u.pathname.split('/')[4]);
  }
  if(!user)return Response.json({detail:'User not found'},{status:404});
  username=user.username as string;
  if(method==='DELETE'){users[n]!.delete(username);return new Response(null,{status:204});}
  if(method==='POST'&&u.pathname.endsWith('/reset')){user.used_traffic=0;user.subscription_url=`/sub/${username}/rotated`;}
  if(method==='PUT'){
   Object.assign(user,body);
   if(badRepairEnvelope)return Response.json({...user,id:'999',username:'unrelated',subscription_url:'/sub/unrelated'});
  }
  return Response.json({...user});
 }) as typeof fetch;
});
afterEach(()=>{globalThis.fetch=real;raw.close();});
function select(id:string){raw.prepare('UPDATE panel_selection SET panel_id=?,revision=revision+1').run(id);}
async function purchase(){const id=newOrderId();await insertOrderWithEvent(db,{id,customerId:1,selections:JSON.stringify({volume_gb:10,duration_days:30,device_count:1,config_name:'Audit'}),amount:100,currency:'IRT',idempotencyKey:newOrderId(),initialState:'approved'});return id;}
async function run(id:string,retry=false){return provisionOrder({env,db,api},{orderId:id,retry});}
async function repurchase(service:string){const id=newOrderId();await insertOrderWithEvent(db,{id,customerId:1,kind:'renewal',renewsOrderId:service,repurchaseMode:'custom',selections:JSON.stringify({kind:'repurchase',mode:'custom',volume_gb:20,duration_days:60,device_count:2,repurchases_order_id:service,renews_order_id:service}),amount:200,currency:'IRT',idempotencyKey:newOrderId(),initialState:'approved'});return id;}
function crashBeforeBooking():()=>void {
 const base=env.DB;
 env.DB={...base,prepare(sql:string){if(sql.includes('SET service_expires_at = CASE'))throw new Error('Synthetic interruption before service booking');return base.prepare(sql);}} as D1Database;
 // Provisioning deps must use the same instrumented database.
 db=env.DB;return ()=>{env.DB=base;db=base;};
}
test('expiry repair must not adopt a different response identity or subscription URL',async()=>{
 select('blue');missingCreateExpiry=true;badRepairEnvelope=true;
 const id=await purchase();const result=await run(id);
 assert.equal(result.ok,true);const order=(await getOrderById(db,id))!;
 assert.equal(order.pasarguard_user_id,'201');assert.ok(!order.subscription_url!.includes('unrelated'));
});
test('unavailable older approved orders must not starve healthy-panel recovery',async()=>{
 raw.prepare("UPDATE panels SET credentials=NULL WHERE id='blue'").run();
 for(let i=0;i<2;i++){const id=await purchase();raw.prepare("UPDATE orders SET panel_id='blue',updated_at='2000-01-01T00:00:00Z' WHERE id=?").run(id);}
 select('green');const ready=await purchase();await recoverPanelOperations(env);
 assert.equal((await getOrderById(db,ready))?.state,'completed');assert.equal((await getOrderById(db,ready))?.panel_id,'green');
 assert.equal(users[1]!.size,0);assert.equal(users[2]!.size,1);
});
test('completed repurchase recovery restores rotated URL and rearms paid notices after interrupted booking',async()=>{
 select('blue');const service=await purchase();await run(service);
 raw.prepare("INSERT INTO service_notifications(order_id,kind,status) VALUES(?,'usage90','sent'),(?,'expiring','sent')").run(service,service);
 const order=await repurchase(service);const restore=crashBeforeBooking();try{await run(order);}finally{restore();}
 assert.equal((await getOrderById(db,order))?.state,'completed');
 select('green');await recoverPanelOperations(env);
 const record=(await getOrderById(db,service))!;
 assert.equal(record.panel_id,'blue');assert.ok(record.subscription_url!.endsWith('/rotated'));
 assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_notifications WHERE order_id=?').get(service)!.n,0);
 const count=calls.length;await recoverPanelOperations(env);assert.equal(calls.length,count);
});
test('recovery must honor an active service-mutation lease before booking a completed operation',async()=>{
 select('blue');const service=await purchase();await run(service);const prior=(await getOrderById(db,service))!.service_expires_at;
 const order=await repurchase(service);const restore=crashBeforeBooking();try{await run(order);}finally{restore();}
 assert.equal(await acquireServiceLock(db,service,'other-operation'),true);
 await recoverPanelOperations(env);assert.equal((await getOrderById(db,service))!.service_expires_at,prior);
 await releaseServiceLock(db,service,'other-operation');await recoverPanelOperations(env);
 assert.ok((await getOrderById(db,service))!.subscription_url!.endsWith('/rotated'));
});
for(const method of ['PUT','POST','DELETE'])test(`dynamic ${method} must target stored ID, not a replacement username between precheck and write`,async()=>{
 select('blue');const service=await purchase();await run(service);const s=(await getOrderById(db,service))!;
 if(method==='DELETE'){swapMutation=method;await deletePanelService(env,s.pasarguard_username!,s);}
 else if(method==='POST'){const r=await repurchase(service);swapMutation=method;await run(r);}
 else {const r=newOrderId();await insertOrderWithEvent(db,{id:r,customerId:1,kind:'renewal',renewsOrderId:service,selections:JSON.stringify({duration_days:2,renews_order_id:service}),amount:10,currency:'IRT',idempotencyKey:newOrderId(),initialState:'approved'});swapMutation=method;await run(r);}
 const replacement=users[1]!.get(s.pasarguard_username!);assert.ok(replacement,'Replacement must not be deleted');
 assert.equal(replacement.id,'999');assert.equal(replacement.expire,100);assert.equal(replacement.used_traffic,123);
});
test('three panels with distinct external IDs retain lifecycle routing after default switches',async()=>{
 const services:string[]=[];
 for(const panel of ids){select(panel);const s=await purchase();assert.equal((await run(s)).ok,true);services.push(s);}
 for(let n=0;n<3;n++){
  select(ids[(n+1)%3]!);const service=(await getOrderById(db,services[n]!))!;
  assert.equal(service.panel_id,ids[n]);assert.equal(service.pasarguard_user_id,String((n+1)*100+1));
  calls=[];await processTelegramUpdate(callbackUpdateAs(`svc:ref:${service.id}`,++update,USER),env);assert.ok(calls.length);assert.ok(calls.every(c=>c.panel===n));
  const rep=await repurchase(service.id);calls=[];assert.equal((await run(rep)).ok,true);assert.ok(calls.every(c=>c.panel===n));assert.ok((await getOrderById(db,service.id))!.subscription_url!.startsWith(origins[n]!));
 }
});
test('bounded approved recovery rotates more than twenty blocked rows and caps remote claims at two',async()=>{
 raw.prepare("UPDATE panels SET credentials=NULL WHERE id='blue'").run();
 for(let i=0;i<21;i++){const id=await purchase();raw.prepare("UPDATE orders SET panel_id='blue',updated_at='2000-01-01T00:00:00Z' WHERE id=?").run(id);}
 select('green');const healthy=await Promise.all([purchase(),purchase(),purchase()]);
 await recoverPanelOperations(env);assert.equal(users[2]!.size,0);
 await recoverPanelOperations(env);assert.equal(users[2]!.size,2);
 await recoverPanelOperations(env);assert.equal(users[2]!.size,3);
 for(const id of healthy)assert.equal((await getOrderById(db,id))?.panel_id,'green');
 assert.equal(users[1]!.size,0);
});
test('historical event-only repurchase URL is recovered once without clearing subsequent notices',async()=>{
 select('blue');const service=await purchase();await run(service);
 const order=await repurchase(service);const restore=crashBeforeBooking();try{await run(order);}finally{restore();}
 raw.prepare('UPDATE orders SET subscription_url=NULL WHERE id=?').run(order);
 raw.prepare("INSERT INTO order_events(order_id,actor,action,data) VALUES(?,'system','service_booking_recovered',?)").run(service,JSON.stringify({operation:order}));
 await recoverPanelOperations(env);assert.ok((await getOrderById(db,service))!.subscription_url!.endsWith('/rotated'));
 raw.prepare("INSERT INTO service_notifications(order_id,kind,status) VALUES(?,'usage90','sent')").run(service);
 const priorCalls=calls.length;await recoverPanelOperations(env);
 assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_notifications WHERE order_id=?').get(service)!.n,1);
 assert.equal(calls.length,priorCalls);
});
test('recovery does not book a superseded operation or replace a newer subscription URL',async()=>{
 select('blue');const service=await purchase();await run(service);
 const old=await repurchase(service);const restore=crashBeforeBooking();try{await run(old);}finally{restore();}
 raw.prepare("UPDATE orders SET updated_at='2000-01-01T00:00:00Z' WHERE id=?").run(old);
 const next=await repurchase(service);await run(next);
 raw.prepare("UPDATE orders SET subscription_url='https://audit-blue.example.com/sub/newer-kept' WHERE id=?").run(service);
 await recoverPanelOperations(env);assert.ok((await getOrderById(db,service))!.subscription_url!.endsWith('/newer-kept'));
 assert.equal(raw.prepare("SELECT COUNT(*) n FROM order_events WHERE action='service_repurchased' AND json_extract(data,'$.repurchase_order_id')=?").get(old)!.n,0);
});
test('all three panels retain renewal, notifications and deletion ownership while non-default and disabled',async()=>{
 const services:string[]=[];for(const panel of ids){select(panel);const s=await purchase();await run(s);services.push(s);}
 for(let n=0;n<3;n++){
  select(ids[(n+1)%3]!);raw.prepare('UPDATE panels SET enabled_new=0 WHERE id=?').run(ids[n]!);
  const service=(await getOrderById(db,services[n]!))!;
  const renewal=newOrderId();await insertOrderWithEvent(db,{id:renewal,customerId:1,kind:'renewal',renewsOrderId:service.id,selections:JSON.stringify({duration_days:2,renews_order_id:service.id}),amount:10,currency:'IRT',idempotencyKey:newOrderId(),initialState:'approved'});
  calls=[];assert.equal((await run(renewal)).ok,true);assert.ok(calls.length);assert.ok(calls.every(c=>c.panel===n));
  users[n]!.get(service.pasarguard_username!)!.used_traffic=9.5*GB_BYTES;
 }
 calls=[];await runServiceNotificationSweep(env,Date.now(),api);
 for(let n=0;n<3;n++)assert.ok(calls.some(c=>c.panel===n&&c.method==='GET'));
 for(let n=0;n<3;n++){
  select(ids[(n+1)%3]!);const service=(await getOrderById(db,services[n]!))!;calls=[];
  assert.equal((await deletePanelService(env,service.pasarguard_username!,service)).ok,true);
  assert.ok(calls.length);assert.ok(calls.every(c=>c.panel===n));assert.equal(users[n]!.size,0);
 }
});
test('repurchase booking failure rolls back URL, expiry and notice rearming together and releases the recovery lease',async()=>{
 select('blue');const service=await purchase();await run(service);
 const prior=(await getOrderById(db,service))!;
 raw.prepare("INSERT INTO service_notifications(order_id,kind,status) VALUES(?,'usage90','sent')").run(service);
 const order=await repurchase(service);const restore=crashBeforeBooking();try{await run(order);}finally{restore();}
 raw.exec("CREATE TRIGGER synthetic_booking_failure BEFORE INSERT ON order_events WHEN NEW.action='service_repurchased' BEGIN SELECT RAISE(ABORT,'synthetic_booking_failure'); END;");
 await assert.rejects(recoverPanelOperations(env));
 const unchanged=(await getOrderById(db,service))!;
 assert.equal(unchanged.service_expires_at,prior.service_expires_at);assert.equal(unchanged.subscription_url,prior.subscription_url);
 assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_notifications WHERE order_id=?').get(service)!.n,1);
 assert.equal(raw.prepare('SELECT COUNT(*) n FROM panel_service_locks WHERE service_id=?').get(service)!.n,0);
 raw.exec('DROP TRIGGER synthetic_booking_failure');await recoverPanelOperations(env);
 assert.ok((await getOrderById(db,service))!.subscription_url!.endsWith('/rotated'));
 assert.equal(raw.prepare('SELECT COUNT(*) n FROM service_notifications WHERE order_id=?').get(service)!.n,0);
});
