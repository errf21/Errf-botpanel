/** Pinned 5.4.1 permission-specific list fixtures; no live panel calls. */
import worker from '../src/index.ts';
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
async function post(url:string,action:string,extra:any={}){return worker.fetch(new Request(WEB+'/admin/panels/'+action,{method:'POST',headers:{origin:WEB,'content-type':'application/json'},body:JSON.stringify({nonce:new URL(url).searchParams.get('nonce'),initData:await signed(),...extra})}),env,{} as ExecutionContext);}
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

function wire(options:{detail?:number;full?:number;rows?:any[];body?:unknown;text?:string;timeout?:boolean}={}){
 const original=fetch;
 globalThis.fetch=async(input,init)=>{
  const u=new URL(String(input));if(u.origin!==ORIGIN||(!u.pathname.startsWith('/api/group/17')&&u.pathname!=='/api/groups'))return original(input,init);
  assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).get('x-api-key'),KEY);assert.equal(new Headers(init?.headers).get('authorization'),null);
  assert.equal(u.href,ORIGIN+u.pathname+u.search);assert.ok(!u.href.includes('/api/api/'));calls.push({origin:u.origin,path:u.pathname+u.search,method:'GET'});
  if(u.pathname==='/api/group/17'){
   if(options.timeout)throw new DOMException(KEY,'TimeoutError');
   if(options.text!==undefined)return new Response(options.text,{status:options.detail??200});
   if(options.detail&&options.detail!==200)return Response.json({detail:KEY},{status:options.detail});
   return Response.json(options.body??{id:17,is_disabled:false});
  }
  if(options.full&&options.full!==200)return Response.json({detail:KEY},{status:options.full});
  const rows=options.rows??[{id:17,name:'Actual group',is_disabled:false}],offset=Number(u.searchParams.get('offset'));assert.equal(u.searchParams.get('limit'),'100');
  return Response.json({groups:rows.slice(offset,offset+100),total:rows.length});
 };
}
async function evidence(ids:unknown=[17]){return post(await open(),'groups',{url:ORIGIN,apiKey:'',verifyIds:ids,diagnostics:true});}
test('actual Worker route identifies BOTH status permission denials, not a missing Cloudflare secret',async()=>{
 wire({detail:403,full:403});const r=await evidence();assert.equal(r.status,403);assert.deepEqual(await r.json(),{code:'group_details_permission_denied',diagnostic:{category:'permission',reason:'status_read_denied',httpStatus:403,attempts:[{method:'GET',endpoint:'/api/group/17',httpStatus:403,category:'permission'},{method:'GET',endpoint:'/api/groups?offset=0&limit=100',httpStatus:403,category:'permission'}]}});
 assert.ok(calls.every(c=>c.method==='GET'));assert.ok(!calls.some(c=>c.path.includes('/simple')));assert.equal((await selection(env.DB)).panel_id,'legacy');
});
for(const detail of [403,404])test('documented authorized full list verifies status after detail HTTP '+detail+' and save uses the SAME proof path',async()=>{
 wire({detail,full:200});const url=await open(),r=await post(url,'groups',{url:ORIGIN,apiKey:'',verifyIds:[17],diagnostics:true});assert.equal(r.status,200);assert.deepEqual(await r.json(),{statuses:[{id:17,disabled:false}]});
 assert.equal((await save(url,[17])).status,200);assert.equal(await testPanel(env,'cf_1'),'ok');assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[17]');assert.equal((await selection(env.DB)).panel_id,'legacy');
});
test('full-list status fallback rejects a disabled group without enabling or overwriting the panel',async()=>{
 wire({detail:403,rows:[{id:17,name:'Disabled actual group',is_disabled:true}]});const url=await open();assert.deepEqual(await(await post(url,'groups',{url:ORIGIN,apiKey:'',verifyIds:[17]})).json(),{statuses:[{id:17,disabled:true}]});
 assert.equal((await save(url,[17])).status,422);assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='cf_1'").get()!.group_ids,'[]');assert.equal(raw.prepare("SELECT enabled_new FROM panels WHERE id='cf_1'").get()!.enabled_new,0);
});
for(const is_disabled of [undefined,'false',0])test('full list with missing/malformed status never certifies enabled '+String(is_disabled),async()=>{
 wire({detail:403,rows:[{id:17,name:'Group status unknown',...(is_disabled===undefined?{}:{is_disabled})}]});const r=await evidence();assert.equal(r.status,502);const body=await r.json() as any;assert.equal(body.code,'group_response_unexpected');assert.equal(body.diagnostic.category,'parse');assert.equal(body.diagnostic.httpStatus,200);assert.equal(body.diagnostic.attempts.at(-1).category,'parse');
});
test('detail 404 and authorized full-list absence report actual 404/200 evidence without claiming deletion',async()=>{
 wire({detail:404,rows:[]});const r=await evidence();assert.equal(r.status,502);const b=await r.json() as any;assert.equal(b.code,'group_not_found');assert.equal(b.diagnostic.reason,'requested_group_not_in_authorized_list');assert.deepEqual(b.diagnostic.attempts.map(a=>a.httpStatus),[404,200]);assert.equal(b.diagnostic.httpStatus,200);
});
test('both status routes returning 404 are API availability evidence, not proof of deleted group',async()=>{
 wire({detail:404,full:404});const r=await evidence();const b=await r.json() as any;assert.equal(r.status,502);assert.equal(b.code,'status_api_unavailable');assert.equal(b.diagnostic.reason,'status_api_unavailable');assert.deepEqual(b.diagnostic.attempts.map(a=>a.httpStatus),[404,404]);
});
test('full status pagination verifies later-page numeric IDs and never truncates to first page',async()=>{
 wire({detail:403,rows:Array.from({length:205},(_,i)=>({id:i+1,name:'Actual group '+(i+1),is_disabled:false}))});const r=await evidence([17,205]);assert.equal(r.status,200);assert.deepEqual(await r.json(),{statuses:[{id:17,disabled:false},{id:205,disabled:false}]});
 assert.deepEqual(calls.map(c=>c.path),['/api/group/17','/api/groups?offset=0&limit=100','/api/groups?offset=100&limit=100','/api/groups?offset=200&limit=100']);
});
for(const status of [401,500])test('detail failure '+status+' reports the true HTTP/category and does NOT try alternative routes',async()=>{
 wire({detail:status});const r=await evidence(),b=await r.json() as any;assert.equal(b.diagnostic.httpStatus,status);assert.equal(b.diagnostic.category,status===401?'auth':'server');assert.equal(b.diagnostic.attempts.length,1);assert.equal(calls.length,1);assert.ok(!JSON.stringify(b).includes(KEY));
});
test('a timeout records no HTTP response and cannot be mistaken for permission denial',async()=>{
 wire({timeout:true});const r=await evidence(),b=await r.json() as any;assert.equal(b.code,'status_verification_failed');assert.equal(b.diagnostic.category,'timeout');assert.equal(b.diagnostic.httpStatus,null);assert.deepEqual(b.diagnostic.attempts,[{method:'GET',endpoint:'/api/group/17',httpStatus:null,category:'timeout'}]);assert.equal(calls.length,1);
});
for(const body of [{id:999,is_disabled:false},{id:'17',is_disabled:false},{id:17}])test('wrong/missing exact status schema records actual HTTP 200 with no fallback '+JSON.stringify(body),async()=>{
 wire({body});const r=await evidence(),b=await r.json() as any;assert.equal(b.diagnostic.category,'parse');assert.equal(b.diagnostic.httpStatus,200);assert.equal(b.diagnostic.attempts.length,1);assert.equal(calls.length,1);
});
test('malformed JSON retains actual upstream HTTP 200 instead of fabricated HTTP 0',async()=>{
 wire({text:'not JSON'});const b=await(await evidence()).json() as any;assert.equal(b.diagnostic.httpStatus,200);assert.equal(b.diagnostic.category,'parse');
});
test('normalized HTTPS port-8000 Cloudflare URL produces exactly ONE api prefix for discovery and status',async()=>{
 set('PANEL_1_URL','https://panel.MraPanel.shop:8000/dashboard/#/login');await syncConfiguredPanels(env);const url=await open();assert.equal((await post(url,'groups',{url:ORIGIN,apiKey:''})).status,200);assert.equal((await post(url,'groups',{url:ORIGIN,apiKey:'',verifyIds:[17],diagnostics:true})).status,200);
 assert.deepEqual(calls.map(c=>c.path),['/api/groups?offset=0&limit=100','/api/group/17']);assert.ok(calls.every(c=>c.origin===ORIGIN));
});
test('missing configured key is a distinct pre-request configuration failure, not status_unverified',async()=>{
 set('PANEL_1_API_KEY',undefined);const r=await evidence();assert.equal(r.status,400);assert.deepEqual(await r.json(),{code:'managed_configuration_unavailable'});assert.equal(calls.length,0);
});
test('new UI sends selected numeric IDs and displays sanitized exact failed requests in both languages',async()=>{
 for(const locale of ['en','fa'] as const){ctx.ui=uiFor(locale);simpleOnly({details:403});const b=await browser(await open());b.checkboxes()[0].checked=true;b.checkboxes()[0].onchange();await b.get('verify-groups').onclick();assert.equal(b.get('save').disabled,true);assert.equal(b.get('group-diagnostic').hidden,false);assert.ok(b.get('group-diagnostic').textContent.includes('GET /api/group/17 — HTTP 403 — permission'));assert.ok(b.get('group-diagnostic').textContent.includes('GET /api/groups?offset=0&limit=100 — HTTP 403 — permission'));assert.ok(!b.get('group-diagnostic').textContent.includes(KEY));assert.equal(b.get('group-state').textContent,ctx.ui.t.panelGroupsDetailsPermission);}
});
test('generic unauthenticated form exposes only the new non-secret version marker, no panel configuration',async()=>{
 const r=await worker.fetch(new Request(WEB+'/admin/panels?nonce='+'a'.repeat(32)),env,{} as ExecutionContext),html=await r.text();assert.equal(r.headers.get('x-errf-group-status-ui'),'status-evidence-v1');assert.ok(html.includes('name="errf-group-status-version" content="status-evidence-v1"'));assert.ok(!html.includes(KEY));assert.ok(!html.includes(ORIGIN));
});
test('unsigned/unauthorized direct Worker requests cannot retrieve request evidence or status',async()=>{
 const url=await open();for(const initData of ['',await signed(USER.id)]){const r=await post(url,'groups',{initData,url:ORIGIN,apiKey:'',verifyIds:[17],diagnostics:true});assert.equal(r.status,403);assert.ok(!(await r.text()).includes('attempts'));}assert.equal(calls.length,0);
});

test('timeout while reading a GET body preserves received HTTP 200 and timeout category',async()=>{
 const original=fetch;globalThis.fetch=async(input,init)=>new URL(String(input)).pathname==='/api/group/17'?new Response(new ReadableStream({start(controller){controller.error(new DOMException(KEY,'TimeoutError'));}}),{status:200}):original(input,init);
 const r=await evidence(),b=await r.json() as any;assert.equal(b.diagnostic.category,'timeout');assert.equal(b.diagnostic.httpStatus,200);assert.deepEqual(b.diagnostic.attempts,[{method:'GET',endpoint:'/api/group/17',httpStatus:200,category:'timeout'}]);assert.ok(!JSON.stringify(b).includes(KEY));
});
