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

async function verify(url:string,ids:unknown){return post(url,'groups',{url:ORIGIN,apiKey:'',verifyIds:ids});}
test('simple-list discovery followed by supported detail reads can verify selected IDs and save securely',async()=>{
 simpleOnly();const b=await browser(await open());assert.equal(b.get('verify-groups').hidden,false);b.checkboxes()[0].checked=true;b.checkboxes()[0].onchange();assert.equal(b.get('save').disabled,true);
 await b.get('verify-groups').onclick();assert.equal(b.get('group-state').textContent,ctx.ui.t.panelGroupsStatusVerified);assert.equal(b.get('save').disabled,false);
 assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[]','verification alone persists no configuration');
 await b.get('f').onsubmit({preventDefault(){}});assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[17]');assert.equal(await testPanel(env,'cf_1'),'ok');
 assert.ok(calls.every(c=>c.method==='GET'));assert.equal(calls.filter(c=>c.path==='/api/group/17').length,3,'button, save, Test each independently verify');
});
test('status endpoint returns only matching IDs/boolean disabled values and keeps the save nonce',async()=>{
 simpleOnly();const url=await open(),r=await verify(url,[17,18]);assert.equal(r.status,200);assert.deepEqual(await r.json(),{statuses:[{id:17,disabled:false},{id:18,disabled:false}]});
 assert.equal(raw.prepare('SELECT COUNT(*) n FROM panel_admin_sessions WHERE nonce=?').get(new URL(url).searchParams.get('nonce'))!.n,1);assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[]');
 assert.ok(calls.every(c=>/^\/api\/group\/\d+$/.test(c.path)&&c.method==='GET'));
});
for(const locale of ['en','fa'] as const)test('current simple-only permission denies official status read accurately and cannot save '+locale,async()=>{
 ctx.ui=uiFor(locale);simpleOnly({details:403});const b=await browser(await open());b.checkboxes()[0].checked=true;b.checkboxes()[0].onchange();await b.get('verify-groups').onclick();
 assert.equal(b.get('group-state').textContent,ctx.ui.t.panelGroupsDetailsPermission);assert.equal(b.get('save').disabled,true);assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[]');
 assert.ok(!b.get('group-state').textContent.includes(KEY));assert.ok(calls.every(c=>c.method==='GET'));assert.ok(!calls.some(c=>c.path.includes('template')));
});
for(const ids of [[],[0],[-1],[17.5],['17'],[17,17],Array.from({length:51},(_,i)=>i+1),null,{}])test('status selection validation rejects without any upstream request '+JSON.stringify(ids),async()=>{
 const r=await verify(await open(),ids);assert.equal(r.status,400);assert.deepEqual(await r.json(),{code:'groups_invalid_configuration'});assert.equal(calls.length,0);
});
for(const body of [{id:'17',is_disabled:false},{id:18,is_disabled:false},{id:17},{id:17,is_disabled:'false'}])test('status read rejects missing, coerced or substituted identity/status '+JSON.stringify(body),async()=>{
 badGroup=body;const r=await verify(await open(),[17]);assert.equal(r.status,502);assert.deepEqual(await r.json(),{code:'group_response_unexpected'});assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[]');
});
test('disabled status is shown and cannot be saved as an enabled group',async()=>{
 groups[0]!.is_disabled=true;simpleOnly();const b=await browser(await open());b.checkboxes()[0].checked=true;b.checkboxes()[0].onchange();await b.get('verify-groups').onclick();
 assert.equal(b.checkboxes()[0].disabled,true);assert.equal(b.checkboxes()[0].checked,false);assert.equal(b.get('save').disabled,true);assert.equal(b.get('group-state').textContent,ctx.ui.t.panelGroupsDisabledError);
});
test('saving rechecks group status after the read-only preview and rejects changed disabled status',async()=>{
 simpleOnly();const b=await browser(await open());b.checkboxes()[0].checked=true;b.checkboxes()[0].onchange();await b.get('verify-groups').onclick();assert.equal(b.get('save').disabled,false);
 groups[0]!.is_disabled=true;await b.get('f').onsubmit({preventDefault(){}});assert.equal(b.get('status').textContent,ctx.ui.t.panelGroupsDisabledError);assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[]');
});
test('status proofs do not survive form reopening or a new discovery run',async()=>{
 simpleOnly();let b=await browser(await open());b.checkboxes()[0].checked=true;b.checkboxes()[0].onchange();await b.get('verify-groups').onclick();assert.equal(b.get('save').disabled,false);
 await b.get('load-groups').onclick();assert.equal(b.get('save').disabled,true);b=await browser(await open());assert.equal(b.get('save').disabled,true);
});
test('one selected group proof cannot authorize another unverified selection',async()=>{
 simpleOnly();const b=await browser(await open());b.checkboxes()[0].checked=true;b.checkboxes()[0].onchange();await b.get('verify-groups').onclick();assert.equal(b.get('save').disabled,false);
 b.checkboxes()[1].checked=true;b.checkboxes()[1].onchange();assert.equal(b.get('save').disabled,true);await b.get('verify-groups').onclick();assert.equal(b.get('save').disabled,false);
});
test('status verification failure returns no partially verified selection',async()=>{
 const existing=fetch;globalThis.fetch=async(input,init)=>new URL(String(input)).pathname==='/api/group/18'?Response.json({detail:KEY},{status:403}):existing(input,init);
 const r=await verify(await open(),[17,18]);assert.equal(r.status,403);assert.deepEqual(await r.json(),{code:'group_details_permission_denied'});
});
test('unauthorized, stale, wrong-owner and missing-token status requests fail before outbound access',async()=>{
 const url=await open();const good=await signed();for(const initData of ['',await signed(USER.id),good.replace('hash=','hash=00')])assert.equal((await post(url,'groups',{initData,url:ORIGIN,apiKey:'',verifyIds:[17]})).status,403);
 raw.prepare('UPDATE panel_admin_sessions SET expires_at=0 WHERE nonce=?').run(new URL(url).searchParams.get('nonce'));assert.equal((await verify(url,[17])).status,403);
 for(const value of [undefined,'','   ']){env.TELEGRAM_BOT_TOKEN=value as string;assert.equal((await post(url,'groups',{initData:good,url:ORIGIN,apiKey:'',verifyIds:[17]})).status,403);}assert.equal(calls.length,0);
});
for(const changed of ['revision','nonce'])test('status response cannot be published after concurrent '+changed+' change',async()=>{
 const url=await open(),existing=fetch;globalThis.fetch=async(input,init)=>{const r=await existing(input,init);if(new URL(String(input)).pathname==='/api/group/17'){if(changed==='revision')raw.exec("UPDATE panels SET revision=revision+1 WHERE id='cf_1'");else raw.prepare('DELETE FROM panel_admin_sessions WHERE nonce=?').run(new URL(url).searchParams.get('nonce'));}return r;};
 const r=await verify(url,[17]);assert.equal(r.status,409);assert.deepEqual(await r.json(),{code:'session_changed'});
});
test('managed status request cannot substitute a different origin or API key',async()=>{
 const url=await open();for(const extra of [{url:OTHER},{apiKey:OTHERKEY}])assert.equal((await post(url,'groups',{url:ORIGIN,apiKey:'',verifyIds:[17],...extra})).status,409);assert.equal(calls.length,0);
});
test('unverified status test prevents enablement and selection through forged admin callbacks',async()=>{
 simpleOnly({details:403});await panelCallback(ctx,'pnl:test:cf_1','fixture');assert.equal(raw.prepare("SELECT last_test FROM panels WHERE id='cf_1'").get()!.last_test,'groups_status_unverified');
 for(const action of ['toggle','select']){await panelCallback(ctx,'pnl:'+action+':cf_1','fixture');const token=raw.prepare('SELECT nonce FROM panel_admin_sessions WHERE action=?').get(action)!.nonce;await panelCallback(ctx,'pnl:confirm:'+token,'fixture');}
 assert.equal(raw.prepare("SELECT enabled_new FROM panels WHERE id='cf_1'").get()!.enabled_new,0);assert.equal((await selection(env.DB)).panel_id,'legacy');
});
test('stale in-flight status response cannot authorize changed selected IDs',async()=>{
 simpleOnly();const b=await browser(await open());b.checkboxes()[0].checked=true;b.checkboxes()[0].onchange();const existing=fetch;let release!:(v?:unknown)=>void,entered!:(v?:unknown)=>void;const wait=new Promise(r=>release=r),start=new Promise(r=>entered=r);
 globalThis.fetch=async(input,init)=>{if(new URL(String(input)).pathname==='/api/group/17'){entered();await wait;}return existing(input,init);};
 const verifying=b.get('verify-groups').onclick();await start;b.checkboxes()[1].checked=true;b.checkboxes()[1].onchange();release();await verifying;assert.equal(b.get('save').disabled,true);
});
for(const status of [401,404,500])test('official status endpoint failure '+status+' is accurately mapped with no fallback',async()=>{
 simpleOnly({details:status});const r=await verify(await open(),[17]);assert.equal(r.status,status===401?401:502);assert.deepEqual(await r.json(),{code:status===401?'key_rejected':status===404?'group_not_found':'status_verification_failed'});assert.equal(calls.length,1);assert.equal(calls[0]!.path,'/api/group/17');
});

test('a failed fresh verification invalidates the previously verified selected status',async()=>{
 simpleOnly();const b=await browser(await open());b.checkboxes()[0].checked=true;b.checkboxes()[0].onchange();await b.get('verify-groups').onclick();assert.equal(b.get('save').disabled,false);
 failStage='group';failStatus=403;await b.get('verify-groups').onclick();assert.equal(b.get('save').disabled,true);assert.equal(b.get('group-state').textContent,ctx.ui.t.panelGroupsDetailsPermission);assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[]');
});
