/** Actual Worker endpoints/client plus offline browser-script state tests. */
import {test,beforeEach,afterEach} from 'node:test';import assert from 'node:assert/strict';import {runInNewContext} from 'node:vm';
import {freshDb,makeD1Shim,ADMIN,USER} from './helpers.ts';import {panelFormDom} from './panelFormDom.ts';
import {proposeMigration,confirmMigration,advanceMigration} from '../src/migrations/service.ts';import {newOrderId} from '../src/lib/security.ts';import {getOrderById} from '../src/db/orders.ts';
import {encrypt,decrypt,nonce} from '../src/panels/security.ts';import {panelCallback} from '../src/panels/admin.ts';import worker from '../src/index.ts';import {uiFor} from '../src/telegram/i18n.ts';import {PasarGuardClient} from '../src/pasarguard/client.ts';import type {Env,UpdateContext} from '../src/types.ts';
const WEB='https://bot-groups.example.com',PANEL='https://panel-groups.example.com',OTHER='https://other-groups.example.com',KEY='SYNTHETIC-GROUP-API-KEY';
let raw:ReturnType<typeof freshDb>,db:D1Database,env:Env,real:typeof fetch,forms:string[],calls:{url:URL;method:string;key:string|null}[],groupData:{id:number;name:string}[],failure:number,malformed:boolean,changeRevision:boolean,dnsPrivate:boolean;
beforeEach(async()=>{
 raw=freshDb();db=makeD1Shim(raw) as unknown as D1Database;env={DB:db,TELEGRAM_BOT_TOKEN:'SYNTHETIC-BOT',TELEGRAM_WEBHOOK_SECRET:'SYNTHETIC-WEBHOOK',ADMIN_CHAT_ID:String(ADMIN.id),PANEL_ADMIN_ORIGIN:WEB,PANEL_ENCRYPTION_KEY:btoa('g'.repeat(32)),PASARGUARD_PANEL_URL:'https://legacy-groups.example.com',PASARGUARD_API_KEY:'SYNTHETIC-LEGACY'};
 raw.prepare('INSERT INTO customers(telegram_user_id,is_admin,language) VALUES(?,1,?)').run(String(USER.id),'fa');const cipher=await encrypt(env,`panel:group-panel:1:${PANEL}:credentials`,{apiKey:KEY});raw.prepare("INSERT INTO panels(id,name,origin,credentials,group_ids,last_test) VALUES('group-panel','Private panel',?,?,'[17,18]','ok')").run(PANEL,cipher);
 forms=[];calls=[];groupData=[{id:17,name:'Germany group'},{id:18,name:'Netherlands group'},{id:23,name:'گروه فنلاند'}];failure=0;malformed=changeRevision=dnsPrivate=false;real=fetch;
 globalThis.fetch=(async(input,init)=>{
  const url=new URL(String(input));if(url.origin==='https://cloudflare-dns.com')return Response.json({Status:0,Answer:[{type:1,data:dnsPrivate?'127.0.0.1':'8.8.8.8'}]});
  assert.ok([PANEL,OTHER].includes(url.origin),'no unintended panel');const key=new Headers(init?.headers).get('x-api-key');calls.push({url,method:init?.method??'GET',key});assert.equal(init?.redirect,'manual');assert.equal(key,KEY);assert.equal(new Headers(init?.headers).get('authorization'),null);
  if(failure)return Response.json({detail:KEY},{status:failure});if(url.pathname==='/api/groups'){
   if(changeRevision)raw.exec("UPDATE panels SET revision=revision+1 WHERE id='group-panel'");
   if(malformed)return Response.json({groups:[{id:'17',name:KEY}],total:1});const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??100);return Response.json({groups:groupData.slice(offset,offset+limit),total:groupData.length});
  }
  if(url.pathname==='/api/admin')return Response.json({username:'operator',status:'active',role:{is_owner:true}});
  if(url.pathname.startsWith('/api/group/')){const id=Number(url.pathname.split('/').at(-1)),g=groupData.find(g=>g.id===id);return g?Response.json({...g,is_disabled:false}):Response.json({detail:'not found'},{status:404});}
  throw Error('Unexpected path '+url.pathname);
 }) as typeof fetch;
});afterEach(()=>{globalThis.fetch=real;raw.close();});
async function signed(actor=ADMIN.id,at=Math.floor(Date.now()/1000),secret=env.TELEGRAM_BOT_TOKEN){const p=new URLSearchParams({auth_date:String(at),user:JSON.stringify({id:actor}),query_id:'synthetic'});const text=[...p.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');const hmac=async(k:Uint8Array,v:string)=>new Uint8Array(await crypto.subtle.sign('HMAC',await crypto.subtle.importKey('raw',k,{name:'HMAC',hash:'SHA-256'},false,['sign']),new TextEncoder().encode(v)));const secretKey=await hmac(new TextEncoder().encode('WebAppData'),secret);p.set('hash',[...await hmac(secretKey,text)].map(v=>v.toString(16).padStart(2,'0')).join(''));return p.toString();}
async function open(id='group-panel',locale:'fa'|'en'='en'){
 const api={sendMessage:async(_chat:number,_text:string,kb:any)=>{forms.push(kb.inline_keyboard[0][0].web_app.url);},answerCallbackQuery:async()=>{}};
 await panelCallback({env,db,api,actor:{id:ADMIN.id},chatId:ADMIN.id,customerId:1,isAdmin:true,ui:uiFor(locale)} as unknown as UpdateContext,id==='add'?'pnl:add':'pnl:edit:'+id,'synthetic');const url=forms.at(-1)!;assert.ok(url);return {url,token:new URL(url).searchParams.get('nonce')!};
}
async function request(path:string,body:any,origin=WEB){return worker.fetch(new Request(WEB+'/admin/panels/'+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}),env,{} as ExecutionContext);}
async function discover(f:{token:string},extra:any={}){return request('groups',{nonce:f.token,initData:await signed(),url:PANEL,apiKey:'',...extra});}
async function browser(id='group-panel',locale:'fa'|'en'='en'){
 const form=await open(id,locale),html=await(await worker.fetch(new Request(form.url),env,{} as ExecutionContext)).text(),script=/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!,dom=panelFormDom(),requests:{path:string;body:any}[]=[];
 const initData=await signed();await runInNewContext(script,{document:dom.document,URL,setTimeout:dom.setTimeout,clearTimeout:dom.clearTimeout,window:{Telegram:{WebApp:{initData,ready:()=>{}}}},fetch:async(path:string,options:RequestInit)=>{const body=JSON.parse(String(options.body));requests.push({path,body});return request(path.split('/').at(-1)!,body);}});
 return {...dom,form,html,requests};
}
test('authenticated discovery returns actual names/IDs only and retains nonce/stored ciphertext',async()=>{const f=await open(),before=raw.prepare("SELECT credentials FROM panels WHERE id='group-panel'").get()!.credentials;const res=await discover(f);assert.equal(res.status,200);const text=await res.text();assert.deepEqual(JSON.parse(text),{groups:groupData});assert.ok(!text.includes(KEY));assert.ok(!text.includes(String(before)));assert.equal(raw.prepare('SELECT COUNT(*) n FROM panel_admin_sessions WHERE nonce=?').get(f.token)!.n,1);assert.equal(calls[0]!.url.pathname,'/api/groups');assert.equal(calls[0]!.url.search,'?offset=0&limit=100');assert.ok(calls.every(c=>c.method==='GET'));});
test('new-panel discovery uses only submitted origin/key, does not persist credentials before save',async()=>{const f=await open('add'),res=await discover(f,{url:OTHER,apiKey:KEY});assert.equal(res.status,200);assert.ok(calls.every(c=>c.url.origin===OTHER));assert.equal(raw.prepare('SELECT COUNT(*) n FROM panels').get()!.n,2);assert.ok(!JSON.stringify(raw.prepare('SELECT * FROM panel_admin_sessions').all()).includes(KEY));});
test('complete paginated group discovery never truncates to first page',async()=>{groupData=Array.from({length:205},(_,n)=>({id:n+1,name:'Actual group '+(n+1)}));const f=await open(),res=await discover(f);assert.equal(res.status,200);assert.deepEqual((await res.json() as any).groups,groupData);assert.deepEqual(calls.map(c=>Number(c.url.searchParams.get('offset'))),[0,100,200]);});
for(const status of [401,403,500,404])test(`group discovery ${status} is classified, redacted and does not use another panel`,async()=>{failure=status;const f=await open(),res=await discover(f);assert.equal(res.status,status===401?401:status===403?403:502);const text=await res.text();assert.ok(!text.includes(KEY));assert.equal(JSON.parse(text).code,{401:'key_rejected',403:'permission_denied',500:'discovery_failed',404:'unsupported_api'}[status]);assert.equal(calls.length,1);assert.equal(calls[0]!.url.origin,PANEL);});
test('invalid/malformed/duplicate/incomplete lists fail instead of inventing IDs or partial success',async()=>{const f=await open();malformed=true;assert.equal((await discover(f)).status,502);malformed=false;groupData=[{id:17,name:'One'},{id:17,name:'Duplicate'}];assert.equal((await discover(f)).status,502);groupData=[{id:0,name:'Invalid'}];assert.equal((await discover(f)).status,502);});
test('upstream cannot reflect API key as a group name in responses',async()=>{groupData=[{id:17,name:KEY}];const f=await open(),res=await discover(f);assert.equal(res.status,502);assert.ok(!(await res.text()).includes(KEY));});
test('discovery rejects unsigned, unauthorized, stale, owner-substituted and missing-token requests before any network',async()=>{
 const f=await open(),auth=await signed();for(const data of ['',await signed(USER.id),await signed(ADMIN.id,Math.floor(Date.now()/1000)-600),auth.replace(/hash=([a-f0-9])/,(_match,digit)=>'hash='+(digit==='0'?'1':'0'))])assert.equal((await discover(f,{initData:data})).status,403);
 env.PANEL_ADMIN_IDS=String(USER.id);assert.equal((await discover(f,{initData:await signed(USER.id)})).status,403);env.PANEL_ADMIN_IDS='';
 for(const value of [undefined,'','   ']){env.TELEGRAM_BOT_TOKEN=value as string;assert.equal((await discover(f,{initData:auth})).status,403);}assert.equal(calls.length,0);
});
test('empty current allowlist, Origin mismatch, expired nonce and revision changes fail closed',async()=>{const f=await open(),auth=await signed();env.ADMIN_CHAT_ID='';assert.equal((await discover(f,{initData:auth})).status,403);env.ADMIN_CHAT_ID=String(ADMIN.id);assert.equal((await request('groups',{nonce:f.token,initData:auth,url:PANEL,apiKey:''},'https://attacker.example.com')).status,403);raw.prepare('UPDATE panel_admin_sessions SET expires_at=0 WHERE nonce=?').run(f.token);assert.equal((await discover(f)).status,403);assert.equal(calls.length,0);const g=await open();changeRevision=true;assert.equal((await discover(g)).status,409);});
test('HTTPS/SSRF/redirect protection and origin-bound retained keys are enforced',async()=>{const f=await open();for(const url of ['http://panel.example.com','https://127.0.0.1','https://localhost','https://u:p@panel.example.com','https://panel.example.com/?token=unsafe'])assert.equal((await discover(f,{url,apiKey:KEY})).status,400);assert.equal(calls.length,0);assert.equal((await discover(f,{url:OTHER,apiKey:''})).status,400);assert.equal(calls.length,0);dnsPrivate=true;assert.equal((await discover(f)).status,502);assert.equal(calls.length,0);});
test('editing renders real groups and preselects only existing available numeric IDs',async()=>{const b=await browser();assert.deepEqual(b.names(),groupData.map(g=>g.name));assert.deepEqual(b.checkboxes().map(c=>[Number(c.value),c.checked]),[[17,true],[18,true],[23,false]]);assert.equal(b.get('select-all').indeterminate,true);assert.equal(b.get('group-count').textContent,'2 groups selected');assert.equal(b.get('save').disabled,false);assert.equal(b.get('key').value,'');assert.ok(!b.html.includes(KEY));assert.ok(!b.html.includes('comma-separated'));});
test('individual and select-all/deselect-all actions update tri-state, count and save gating',async()=>{const b=await browser();const c=b.checkboxes()[0];c.checked=false;c.onchange();assert.equal(b.get('group-count').textContent,'1 group selected');assert.equal(b.get('select-all').indeterminate,true);b.get('select-all').checked=true;b.get('select-all').onchange();assert.ok(b.checkboxes().every(c=>c.checked));assert.equal(b.get('select-all').indeterminate,false);assert.equal(b.get('group-count').textContent,'3 groups selected');b.get('select-all').checked=false;b.get('select-all').onchange();assert.ok(b.checkboxes().every(c=>!c.checked));assert.equal(b.get('group-count').textContent,'0 groups selected');assert.equal(b.get('save').disabled,true);});
test('save transmits actual selected numeric IDs, not group names or All, and retains encrypted key',async()=>{const b=await browser();b.checkboxes()[2].checked=true;b.checkboxes()[2].onchange();b.checkboxes()[1].checked=false;b.checkboxes()[1].onchange();await b.get('f').onsubmit({preventDefault(){}});const save=b.requests.find(r=>r.path.endsWith('/configure'))!;assert.deepEqual(save.body.groups,[17,23]);assert.equal(save.body.apiKey,'');assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='group-panel'").get()!.group_ids,'[17,23]');assert.ok(!String(raw.prepare("SELECT credentials FROM panels WHERE id='group-panel'").get()!.credentials).includes(KEY));assert.equal(b.get('fields').disabled,true);});
test('new panel automatically loads on valid origin/key input and never echoes the typed key',async()=>{const b=await browser('add');assert.equal(b.get('save').disabled,true);b.get('name').value='Added';b.get('url').value=OTHER;b.get('url').oninput();b.get('key').value=KEY;b.get('key').oninput();await b.flush();assert.deepEqual(b.names(),groupData.map(g=>g.name));assert.ok(b.checkboxes().every(c=>!c.checked));b.checkboxes()[2].checked=true;b.checkboxes()[2].onchange();await b.get('f').onsubmit({preventDefault(){}});const save=b.requests.find(r=>r.path.endsWith('/configure'))!;assert.deepEqual(save.body.groups,[23]);assert.equal(b.get('key').value,'');const row=raw.prepare('SELECT * FROM panels WHERE origin=?').get(OTHER)!;assert.equal(row.group_ids,'[23]');assert.ok(!String(row.credentials).includes(KEY));});
test('empty, permission and failure states keep saving disabled and provide a working retry',async()=>{groupData=[];let b=await browser();assert.equal(b.get('group-state').textContent,'No groups are available. Check the account access or panel groups.');assert.equal(b.get('save').disabled,true);assert.equal(b.get('group-controls').hidden,true);failure=403;b=await browser();assert.ok(b.get('group-state').textContent.includes('cannot read groups'));assert.equal(b.get('group-retry').hidden,false);assert.equal(b.get('save').disabled,true);failure=0;groupData=[{id:17,name:'Recovered group'}];await b.get('group-retry').onclick();assert.deepEqual(b.names(),['Recovered group']);assert.equal(b.get('save').disabled,false);});
test('Persian/English selected language, RTL and every selector state use existing bundles',async()=>{for(const locale of ['fa','en'] as const){const b=await browser('group-panel',locale),t=uiFor(locale).t;assert.ok(b.html.includes('lang="'+locale+'"'));assert.ok(b.html.includes('dir="'+(locale==='fa'?'rtl':'ltr')+'"'));assert.ok(b.html.includes(t.panelGroupsSelectAll));assert.equal(b.get('group-count').textContent,t.panelGroupsCountMany.replace('{count}','2'));failure=403;await b.get('group-retry').onclick();assert.equal(b.get('group-state').textContent,t.panelGroupsPermission);failure=0;}});
test('unavailable saved groups are warned about, never silently replaced by arbitrary IDs',async()=>{groupData=[{id:17,name:'Only available'}];const b=await browser();assert.equal(b.get('group-warning').hidden,false);assert.ok(b.get('group-warning').textContent.includes('previously selected groups'));assert.deepEqual(b.checkboxes().filter(c=>c.checked).map(c=>Number(c.value)),[17]);});
test('Select all selects every available row; existing 50-group save limit is explicit',async()=>{groupData=Array.from({length:51},(_,n)=>({id:n+1,name:'Group '+(n+1)}));const b=await browser();b.get('select-all').checked=true;b.get('select-all').onchange();assert.equal(b.checkboxes().filter(c=>c.checked).length,51);assert.equal(b.get('group-count').textContent,'51 groups selected');assert.equal(b.get('save').disabled,true);assert.ok(b.get('group-warning').textContent.includes('maximum of 50'));});

test('list client refuses partial, changed-total, duplicate-page and oversized discovery results',async()=>{
 const f=await open();
 for(const scenario of ['partial','changed','duplicate','oversized']){
  let page=0;globalThis.fetch=(async(input)=>{const url=new URL(String(input));if(url.origin==='https://cloudflare-dns.com')return Response.json({Status:0,Answer:[{type:1,data:'8.8.8.8'}]});page++;
   if(scenario==='partial')return Response.json({groups:[],total:1});
   if(scenario==='oversized')return Response.json({groups:[],total:1001});
   return Response.json({groups:page===1?Array.from({length:100},(_,n)=>({id:n+1,name:'Group '+(n+1)})):[{id:scenario==='duplicate'?1:101,name:'Last group'}],total:page===2&&scenario==='changed'?102:101});
  }) as typeof fetch;
  const res=await discover(f);assert.equal(res.status,502);assert.deepEqual(await res.json(),{code:'discovery_failed'});
 }
});
test('changing credentials/origin while discovery is pending cannot enable stale selections',async()=>{
 const f=await open(),html=await(await worker.fetch(new Request(f.url),env,{} as ExecutionContext)).text(),script=/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!,dom=panelFormDom();
 let release!:(r:Response)=>void,entered!:(v?:unknown)=>void;const waiting=new Promise(r=>entered=r),response=new Promise<Response>(r=>release=r);
 const load=runInNewContext(script,{document:dom.document,URL,setTimeout:dom.setTimeout,clearTimeout:dom.clearTimeout,window:{Telegram:{WebApp:{initData:await signed(),ready:()=>{}}}},fetch:async(path:string)=>{if(path.endsWith('/metadata'))return Response.json({name:'Existing',url:PANEL,groups:[17,18],hasApiKey:true,legacy:false});entered();return response;}});
 await waiting;dom.get('url').value=OTHER;dom.get('url').oninput();release(Response.json({groups:groupData}));await load;
 assert.equal(dom.get('save').disabled,true);assert.equal(dom.get('group-controls').hidden,true);assert.deepEqual(dom.names(),[]);
});
test('group names are rendered as text, never executable markup',async()=>{
 groupData=[{id:17,name:'<img src=x onerror=alert(1)>'}];const b=await browser();assert.deepEqual(b.names(),[groupData[0]!.name]);assert.equal(b.get('group-list').children[0].children[1].textContent,groupData[0]!.name);
});
test('editing an unassigned panel cannot send retained key to another hostname at save time',async()=>{
 const f=await open(),res=await request('configure',{nonce:f.token,initData:await signed(),name:'Origin change',url:OTHER,apiKey:'',groups:[17]});assert.equal(res.status,400);assert.equal(calls.length,0);assert.equal(raw.prepare("SELECT origin FROM panels WHERE id='group-panel'").get()!.origin,PANEL);
});

test('visual selector saved IDs are the same IDs used and verified by cross-panel migration',async()=>{
 const b=await browser();b.checkboxes()[2].checked=true;b.checkboxes()[2].onchange();b.checkboxes()[1].checked=false;b.checkboxes()[1].onchange();await b.get('f').onsubmit({preventDefault(){}});
 assert.equal(raw.prepare("SELECT group_ids FROM panels WHERE id='group-panel'").get()!.group_ids,'[17,23]');raw.prepare("UPDATE panels SET enabled_new=1 WHERE id='group-panel'").run();
 const sid=newOrderId(),name='pg'+sid.toLowerCase(),expire=Math.floor(Date.now()/1000)+86400;
 raw.prepare("INSERT INTO orders(id,customer_id,state,selections,amount,panel_id,pasarguard_user_id,pasarguard_username,subscription_url) VALUES(?,1,'completed','{}',100,'legacy','111',?,'https://legacy-groups.example.com/sub/old')").run(sid,name);
 const before=JSON.stringify(['customers','orders','wallet_entries','wallet_topups','referral_rewards'].map(t=>raw.prepare('SELECT * FROM '+t+' ORDER BY 1').all()));
 const f=globalThis.fetch;let destination:any=null,created:any=null;
 globalThis.fetch=async(input,init)=>{const u=new URL(String(input)),method=init?.method??'GET';
  if(u.origin==='https://legacy-groups.example.com')return Response.json({id:111,username:name,note:'original',data_limit:10000,used_traffic:2000,expire:new Date(expire*1000).toISOString(),hwid_limit:2,status:'active',group_ids:[7],subscription_url:'/sub/old'});
  if(u.origin===PANEL&&u.pathname.startsWith('/api/user')){
   assert.equal(new Headers(init?.headers).get('x-api-key'),KEY);
   if(method==='POST'){created=JSON.parse(String(init?.body));destination={...created,id:222,used_traffic:0,subscription_url:'/sub/replacement'};return Response.json(destination);}
   if(!destination)return Response.json({detail:'User not found'},{status:404});
   if(method==='PUT')Object.assign(destination,JSON.parse(String(init?.body)));return Response.json(destination);
  }return f(input,init);
 };
 const draft=await proposeMigration(env,ADMIN.id,sid,1,'group-panel');assert.deepEqual(JSON.parse(draft.destination_config).groupIds,[17,23]);
 const staged=await confirmMigration(env,ADMIN.id,draft.confirmation_token);assert.equal(staged.state,'verified');assert.deepEqual(created.group_ids,[17,23]);assert.equal(created.data_limit,8000);assert.equal(created.expire,expire);assert.equal(created.hwid_limit,2);
 const done=await advanceMigration(env,draft.id,ADMIN.id,false);assert.equal(done.state,'cleanup_pending');assert.equal((await getOrderById(db,sid))!.panel_id,'group-panel');assert.equal(done.source_revoked_at,null);
 assert.equal(JSON.stringify(['customers','orders','wallet_entries','wallet_topups','referral_rewards'].map(t=>raw.prepare('SELECT * FROM '+t+' ORDER BY 1').all())),before);
});
test('secure panel save rejects a disabled selected group without replacing encrypted configuration',async()=>{
 const f=await open(),before=raw.prepare("SELECT credentials,group_ids FROM panels WHERE id='group-panel'").get()!,fetchBefore=globalThis.fetch;
 globalThis.fetch=async(input,init)=>String(input).startsWith(PANEL+'/api/group/')?Response.json({id:17,name:'Disabled',is_disabled:true}):fetchBefore(input,init);
 const response=await request('configure',{nonce:f.token,initData:await signed(),name:'Rejected',url:PANEL,apiKey:'',groups:[17]});assert.equal(response.status,422);assert.deepEqual(raw.prepare("SELECT credentials,group_ids FROM panels WHERE id='group-panel'").get(),before);
});

test('pasted port-8000 dashboard URL is normalized by Worker and form before storing or calling APIs',async()=>{
 const expected='https://panel.mrapanel.shop:8000',pasted='https://panel.MraPanel.shop:8000/dashboard/#/login',f=globalThis.fetch,targets:string[]=[];
 globalThis.fetch=async(input,init)=>{const u=new URL(String(input));if(u.origin===expected){targets.push(u.toString());assert.equal(init?.redirect,'manual');return f(OTHER+u.pathname+u.search,init);}return f(input,init);};
 const b=await browser('add');b.get('name').value='Port 8000';b.get('url').value=pasted;b.get('url').oninput();b.get('key').value=KEY;b.get('key').oninput();await b.flush();
 assert.equal(b.requests.find(r=>r.path.endsWith('/groups'))!.body.url,pasted);assert.equal(b.get('url').value,expected);assert.equal(b.get('save').disabled,true);
 b.checkboxes()[2].checked=true;b.checkboxes()[2].onchange();await b.get('f').onsubmit({preventDefault(){}});
 assert.equal(b.requests.find(r=>r.path.endsWith('/configure'))!.body.url,expected);assert.ok(targets.length>=3);assert.ok(targets.every(v=>v.startsWith(expected+'/api/')&&!v.includes('dashboard')&&!v.includes('#')));
 const row=raw.prepare('SELECT id,revision,origin,credentials,group_ids FROM panels WHERE name=?').get('Port 8000')!;assert.equal(row.origin,expected);assert.equal(row.group_ids,'[23]');assert.ok(!String(row.credentials).includes(KEY));assert.equal((await decrypt<{apiKey:string}>(env,`panel:${row.id}:${row.revision}:${expected}:credentials`,String(row.credentials))).apiKey,KEY);
 const encryptionKey=env.PANEL_ENCRYPTION_KEY,edit=await browser(String(row.id));edit.get('url').value=pasted;edit.get('url').oninput();await edit.flush();assert.equal(edit.get('url').value,expected);assert.equal(edit.get('key').value,'');assert.equal(edit.get('save').disabled,false);await edit.get('f').onsubmit({preventDefault(){}});assert.equal(env.PANEL_ENCRYPTION_KEY,encryptionKey);assert.ok(targets.every(v=>v.startsWith(expected+'/api/')));
});
test('direct authenticated configure normalizes dashboard origin without trusting frontend normalization',async()=>{
 const expected='https://panel.mrapanel.shop:8000',f=globalThis.fetch;globalThis.fetch=async(input,init)=>{const u=new URL(String(input));return u.origin===expected?f(OTHER+u.pathname+u.search,init):f(input,init);};
 const form=await open('add'),res=await request('configure',{nonce:form.token,initData:await signed(),name:'Direct port 8000',url:'https://panel.MraPanel.shop:8000/dashboard/#/login',apiKey:KEY,groups:[17]});assert.equal(res.status,200);assert.equal(raw.prepare('SELECT origin FROM panels WHERE name=?').get('Direct port 8000')!.origin,expected);
});
test('invalid port or credential/query dashboard URL cannot trigger group discovery or save network requests',async()=>{
 for(const url of ['https://panel.mrapanel.shop:444/dashboard/#/login','https://name:password@panel.mrapanel.shop:8000/dashboard','https://panel.mrapanel.shop:8000/dashboard?key=unsafe']){
  const form=await open('add');assert.equal((await discover(form,{url,apiKey:KEY})).status,400);assert.equal((await request('configure',{nonce:form.token,initData:await signed(),name:'Unsafe',url,apiKey:KEY,groups:[17]})).status,400);
 }
 assert.equal(calls.length,0);assert.equal(raw.prepare('SELECT COUNT(*) n FROM panels').get()!.n,2);
});
