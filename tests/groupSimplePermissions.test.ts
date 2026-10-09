/** Pinned 5.4.1 permission-specific list fixtures; no live panel calls. */
import {test,beforeEach,afterEach} from 'node:test';import assert from 'node:assert/strict';import {runInNewContext} from 'node:vm';
import {freshDb,makeD1Shim,ADMIN,USER} from './helpers.ts';import {panelFormDom} from './panelFormDom.ts';import {syncConfiguredPanels} from '../src/panels/bindings.ts';import {testPanel,panelCallback,panelAdminRoute} from '../src/panels/admin.ts';import {resolvePanel,selection,provisioningForPanel} from '../src/panels/registry.ts';import {uiFor} from '../src/telegram/i18n.ts';import type {Env,UpdateContext} from '../src/types.ts';
const ORIGIN='https://panel.mrapanel.shop:8000',OTHER='https://other-groups.example.com',WEB='https://bot-groups.example.com',KEY='SYNTHETIC-MRA-GROUP-KEY',OTHERKEY='SYNTHETIC-OTHER-GROUP-KEY';
let raw:ReturnType<typeof freshDb>,env:Env,ctx:UpdateContext,real:typeof fetch,messages:{text:string;kb:any}[],calls:{origin:string;path:string;method:string}[];
let failStage:string,failStatus:number,malformed:boolean,groups:{id:number;name:string;is_disabled?:unknown}[],otherGroups:{id:number;name:string;is_disabled?:unknown}[],badGroup:unknown;
function set(k:string,v:unknown){(env as unknown as Record<string,unknown>)[k]=v;}
beforeEach(async()=>{raw=freshDb();const db=makeD1Shim(raw) as unknown as D1Database;env={DB:db,TELEGRAM_BOT_TOKEN:'SYNTHETIC-BOT-TOKEN',TELEGRAM_WEBHOOK_SECRET:'SYNTHETIC-WEBHOOK',ADMIN_CHAT_ID:String(ADMIN.id),PANEL_ADMIN_ORIGIN:WEB,PANEL_ENCRYPTION_KEY:btoa('g'.repeat(32)),PASARGUARD_PANEL_URL:'https://legacy.example.com',PASARGUARD_API_KEY:'SYNTHETIC-LEGACY',PANEL_COUNT:'1'};
 set('PANEL_1_NAME','MraPanel');set('PANEL_1_URL','https://panel.MraPanel.shop:8000');set('PANEL_1_API_KEY',KEY);groups=[{id:17,name:'Mra group one',is_disabled:false},{id:18,name:'گروه دوم',is_disabled:false}];otherGroups=[{id:23,name:'Other group',is_disabled:false}];messages=[];calls=[];failStage='';failStatus=0;malformed=false;badGroup=undefined;real=fetch;
 const api={sendMessage:async(_chat:number,text:string,kb:any)=>{messages.push({text,kb});},answerCallbackQuery:async()=>{},editMessageText:async()=>{}};ctx={env,db,api,actor:{id:ADMIN.id},chatId:ADMIN.id,customerId:1,isAdmin:true,ui:uiFor('en')} as unknown as UpdateContext;
 globalThis.fetch=async(input,init)=>{const u=new URL(String(input));if(u.origin==='https://cloudflare-dns.com'){assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).get('x-api-key'),null);return Response.json(u.searchParams.get('type')==='A'?{Status:0,Answer:[{type:1,data:'176.120.17.222'}]}:{Status:0});}
  assert.ok([ORIGIN,OTHER].includes(u.origin),'no implicit other panel');assert.equal(new Headers(init?.headers).get('x-api-key'),u.origin===ORIGIN?KEY:OTHERKEY);assert.equal(new Headers(init?.headers).get('authorization'),null);assert.equal(init?.redirect,'manual');assert.equal(init?.method??'GET','GET','configuration test never creates/updates remote users');calls.push({origin:u.origin,path:u.pathname+u.search,method:init?.method??'GET'});
  const stage=u.pathname==='/api/admin'?'admin':(u.pathname==='/api/groups'||u.pathname==='/api/groups/simple')?'list':'group';if(stage===failStage)return Response.json({detail:KEY},{status:failStatus});
  if(stage==='admin')return Response.json({username:'operator',status:'active',role:{is_owner:true}});
  const source=u.origin===ORIGIN?groups:otherGroups;if(stage==='list'){if(malformed)return Response.json({groups:[{id:'17',name:KEY}],total:1});const offset=Number(u.searchParams.get('offset')),limit=Number(u.searchParams.get('limit'));assert.equal(limit,100);return Response.json({groups:source.slice(offset,offset+limit).map(g=>({...g,inbound_tags:['fixture-only'],total_users:0})),total:source.length});}
  if(badGroup!==undefined)return Response.json(badGroup);const found=source.find(g=>g.id===Number(u.pathname.split('/').at(-1)));return found?Response.json({...found,inbound_tags:[],total_users:0}):Response.json({detail:'Group not found'},{status:404});
 };await syncConfiguredPanels(env);
});afterEach(()=>{globalThis.fetch=real;raw.close();});
async function signed(actor=ADMIN.id){const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:actor})});const sign=async(key:Uint8Array,text:string)=>new Uint8Array(await crypto.subtle.sign('HMAC',await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']),new TextEncoder().encode(text)));const key=await sign(new TextEncoder().encode('WebAppData'),env.TELEGRAM_BOT_TOKEN),data=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');p.set('hash',[...await sign(key,data)].map(n=>n.toString(16).padStart(2,'0')).join(''));return p.toString();}
function latestForm(){return messages.flatMap(m=>m.kb?.inline_keyboard??[]).flat().filter(b=>b.web_app).at(-1)?.web_app.url as string;}
async function open(id='cf_1'){await panelCallback(ctx,'pnl:edit:'+id,'test');return latestForm();}
async function post(url:string,action:string,extra:any={}){return panelAdminRoute(new Request(WEB+'/admin/panels/'+action,{method:'POST',headers:{origin:WEB,'content-type':'application/json'},body:JSON.stringify({nonce:new URL(url).searchParams.get('nonce'),initData:await signed(),...extra})}),env);}
async function browser(url:string){const html=await(await panelAdminRoute(new Request(url),env)).text(),script=/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!,dom=panelFormDom(),initData=await signed();await runInNewContext(script,{document:dom.document,URL,setTimeout:dom.setTimeout,clearTimeout:dom.clearTimeout,window:{Telegram:{WebApp:{initData,ready:()=>{}}}},fetch:async(path:string,init:RequestInit)=>panelAdminRoute(new Request(WEB+path,{...init,headers:{origin:WEB,'content-type':'application/json'}}),env)});return {...dom,html};}
async function save(url:string,ids:number[],id='cf_1'){const p=raw.prepare('SELECT origin FROM panels WHERE id=?').get(id)!;return post(url,'configure',{name:id==='cf_1'?'MraPanel':'Other',url:p.origin,apiKey:'',groups:ids});}

function simpleOnly(options:{status?:number;data?:unknown;details?:number}={}) {
 const existing=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const u=new URL(String(input));
  if(u.origin!==ORIGIN || (!u.pathname.startsWith('/api/groups') && !(options.details&&u.pathname.startsWith('/api/group/'))))return existing(input,init);
  assert.equal(new Headers(init?.headers).get('x-api-key'),KEY);
  assert.equal(new Headers(init?.headers).get('authorization'),null);
  assert.equal(init?.redirect,'manual');assert.equal(init?.method,'GET');
  calls.push({origin:u.origin,path:u.pathname+u.search,method:'GET'});
  if(u.pathname==='/api/groups')return Response.json({detail:'Full list denied: '+KEY},{status:403});
  if(u.pathname.startsWith('/api/group/'))return Response.json({detail:KEY},{status:options.details});
  assert.equal(u.pathname,'/api/groups/simple');assert.equal(u.searchParams.get('limit'),'100');
  if(options.status)return Response.json({detail:KEY},{status:options.status});
  const offset=Number(u.searchParams.get('offset'));
  return Response.json(options.data??{groups:groups.slice(offset,offset+100).map(g=>({id:g.id,name:g.name})),total:groups.length});
 };
}
test('full-list 403 uses documented simple endpoint, same key/origin and actual numeric IDs',async()=>{
 simpleOnly();const r=await post(await open(),'groups',{url:ORIGIN,apiKey:''});assert.equal(r.status,200);
 assert.deepEqual(await r.json(),{groups:[{id:17,name:'Mra group one',statusVerified:false},{id:18,name:'گروه دوم',statusVerified:false}]});
 assert.deepEqual(calls.map(c=>c.path),['/api/groups?offset=0&limit=100','/api/groups/simple?offset=0&limit=100']);assert.ok(calls.every(c=>c.method==='GET'&&c.origin===ORIGIN));
});
test('simple-only Test reports missing status capability, not a successful full permission test',async()=>{
 simpleOnly();assert.equal(await testPanel(env,'cf_1'),'groups_status_unverified');await panelCallback(ctx,'pnl:test:cf_1','fixture');
 assert.ok(messages.at(-1)!.text.includes(ctx.ui.t.panelGroupsStatusUnverified));assert.ok(latestForm());assert.ok(!messages.at(-1)!.text.includes(KEY));
 assert.equal((await selection(env.DB)).panel_id,'legacy');assert.equal(raw.prepare("SELECT enabled_new FROM panels WHERE id='cf_1'").get()!.enabled_new,0);
});
for(const locale of ['en','fa'] as const)test('simple-only form displays actual groups with honest status warning and blocks unverified save '+locale,async()=>{
 ctx.ui=uiFor(locale);simpleOnly();const b=await browser(await open());assert.deepEqual(b.names(),['Mra group one','گروه دوم']);
 b.get('select-all').checked=true;b.get('select-all').onchange();assert.ok(b.checkboxes().every(c=>c.checked));
 assert.equal(b.get('group-count').textContent,ctx.ui.t.panelGroupsCountMany.replace('{count}','2'));assert.equal(b.get('group-state').textContent,ctx.ui.t.panelGroupsStatusUnverified);assert.equal(b.get('save').disabled,true);
 await b.get('f').onsubmit({preventDefault(){}});assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[]');
});
test('direct save cannot bypass full detail validation with IDs from the simple endpoint',async()=>{
 raw.exec("UPDATE panels SET group_ids='[17]' WHERE id='cf_1'");simpleOnly({details:403});const url=await open();const r=await save(url,[18]);assert.equal(r.status,422);
 assert.equal((await r.json() as any).code,'group_details_permission_denied');assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[17]');
 assert.equal((await save(url,[17])).status,403,'save nonce is still one-use');assert.equal(await testPanel(env,'cf_1'),'group_read_permission_403');
});
test('simple-only discovery preserves saved numeric selections across reopening and synchronization',async()=>{
 raw.exec("UPDATE panels SET group_ids='[18]' WHERE id='cf_1'");simpleOnly();let b=await browser(await open());assert.deepEqual(b.checkboxes().map(c=>[Number(c.value),c.checked]),[[17,false],[18,true]]);
 await syncConfiguredPanels(env);b=await browser(await open());assert.deepEqual(b.checkboxes().map(c=>[Number(c.value),c.checked]),[[17,false],[18,true]]);assert.equal(b.get('save').disabled,true);
});
test('simple-list pagination obtains all 205 real group IDs without partial success or fabricated status',async()=>{
 groups=Array.from({length:205},(_,i)=>({id:i+1,name:'Simple group '+(i+1),is_disabled:i===3}));simpleOnly();const r=await post(await open(),'groups',{url:ORIGIN,apiKey:''});assert.equal(r.status,200);
 const body=await r.json() as any;assert.equal(body.groups.length,205);assert.ok(body.groups.every(g=>g.statusVerified===false&&g.disabled===undefined));
 assert.deepEqual(calls.map(c=>c.path),['/api/groups?offset=0&limit=100','/api/groups/simple?offset=0&limit=100','/api/groups/simple?offset=100&limit=100','/api/groups/simple?offset=200&limit=100']);
});
for(const status of [401,403,404,500])test('simple endpoint failure '+status+' is correctly classified and not reported as missing IDs',async()=>{
 simpleOnly({status});const result=await testPanel(env,'cf_1');assert.equal(result,{401:'group_discovery_auth_401',403:'group_discovery_permission_403',404:'group_discovery_not_found_404',500:'group_discovery_server_500'}[status]);
 const r=await post(await open(),'groups',{url:ORIGIN,apiKey:''});assert.equal(r.status,status===401?401:status===403?403:502);assert.equal((await r.json() as any).code,{401:'key_rejected',403:'permission_denied',404:'unsupported_api',500:'discovery_failed'}[status]);
 assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[]');
});
for(const data of [{groups:[{id:'17',name:'Bad'}],total:1},{groups:[{id:0,name:'Bad'}],total:1},{groups:[{id:17,name:'One'},{id:17,name:'Duplicate'}],total:2},{groups:[],total:1},{groups:[],total:1001}])test('simple parser rejects invalid IDs, duplicates and incomplete/oversized lists '+JSON.stringify(data),async()=>{
 simpleOnly({data});const r=await post(await open(),'groups',{url:ORIGIN,apiKey:''});assert.equal(r.status,502);assert.deepEqual(await r.json(),{code:'discovery_failed'});
});
test('a simple group name cannot reflect the API key in browser output',async()=>{
 simpleOnly({data:{groups:[{id:17,name:KEY}],total:1}});const r=await post(await open(),'groups',{url:ORIGIN,apiKey:''});assert.equal(r.status,502);assert.ok(!(await r.text()).includes(KEY));
});
test('simple list containing a disabled group never certifies that it is enabled',async()=>{
 groups[0]!.is_disabled=true;simpleOnly();const b=await browser(await open());assert.equal(b.get('save').disabled,true);assert.equal(b.get('group-state').textContent,ctx.ui.t.panelGroupsStatusUnverified);
});
test('simple endpoint is never requested on auth, malformed-response or unrelated full-list failures',async()=>{
 for(const status of [401,404,500]){calls=[];failStage='list';failStatus=status;await testPanel(env,'cf_1');assert.equal(calls.length,2,'admin then full list only');assert.ok(!calls.some(c=>c.path.startsWith('/api/groups/simple')));}
 failStage='';malformed=true;calls=[];await testPanel(env,'cf_1');assert.ok(!calls.some(c=>c.path.startsWith('/api/groups/simple')));
});
test('unauthorized discovery cannot invoke either list endpoint or change group selections',async()=>{
 simpleOnly();const url=await open();for(const initData of ['',await signed(USER.id)])assert.equal((await post(url,'groups',{initData,url:ORIGIN,apiKey:''})).status,403);
 assert.equal(calls.length,0);assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[]');
});
test('a second panel with full access remains independently usable when the first has simple-only access',async()=>{
 set('PANEL_COUNT','2');set('PANEL_2_URL',OTHER);set('PANEL_2_API_KEY',OTHERKEY);await syncConfiguredPanels(env);simpleOnly({details:403});
 assert.equal((await save(await open('cf_2'),[23],'cf_2')).status,200);assert.equal(await testPanel(env,'cf_2'),'ok');assert.equal(await testPanel(env,'cf_1'),'groups_status_unverified');
 const p=await resolvePanel(env,'cf_2');assert.ok(p.ok);assert.deepEqual(provisioningForPanel(p.row,{} as any).groupIds,[23]);assert.equal((await selection(env.DB)).panel_id,'legacy');
});

test('account permission failure is not mislabeled as a group endpoint rejection',async()=>{failStage='admin';failStatus=403;await panelCallback(ctx,'pnl:test:cf_1','fixture');assert.ok(messages.at(-1)!.text.includes(ctx.ui.t.panelGroupsAccountPermission));assert.ok(!calls.some(c=>c.path.startsWith('/api/groups')));});
