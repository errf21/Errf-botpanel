import {panelFormDom} from './panelFormDom.ts';
/** Permanent regressions for the two reproduced Mini App authorization gaps.
 * Synthetic credentials, in-memory D1, mocked network; no production access. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, makeD1Shim, ADMIN, USER } from './helpers.ts';
import { encrypt, nonce, verifyInitData } from '../src/panels/security.ts';
import { panelCallback } from '../src/panels/admin.ts';
import { uiFor } from '../src/telegram/i18n.ts';
import worker from '../src/index.ts';
import type { Env, UpdateContext } from '../src/types.ts';

const WEB='https://auth-bot.example.com', PANEL='https://auth-panel.example.com', NEW_PANEL='https://new.example.com';
const KEY='SYNTHETIC-AUTH-API-KEY', NAME='Private audit panel name';
let sqlite:DatabaseSync, db:D1Database, env:Env, originalFetch:typeof fetch;
let sent:{text:string;reply_markup?:{inline_keyboard:{web_app?:{url:string}}[][]}}[], panelCalls:string[];
const execution={waitUntil:()=>{}} as unknown as ExecutionContext;
beforeEach(async()=>{
    sqlite=freshDb();db=makeD1Shim(sqlite) as unknown as D1Database;
    env={DB:db,TELEGRAM_BOT_TOKEN:'SYNTHETIC-PRIVATE-BOT-TOKEN',TELEGRAM_WEBHOOK_SECRET:'SYNTHETIC-WEBHOOK',
        ADMIN_CHAT_ID:String(ADMIN.id),PANEL_ADMIN_ORIGIN:WEB,PANEL_ENCRYPTION_KEY:btoa('x'.repeat(32)),
        PASARGUARD_PANEL_URL:'https://legacy.example.com',PASARGUARD_API_KEY:'SYNTHETIC-LEGACY-API-KEY'};
    sqlite.prepare('INSERT INTO customers(telegram_user_id,is_admin) VALUES(?,1)').run(String(USER.id));
    const cipher=await encrypt(env,`panel:authpanel:1:${PANEL}:credentials`,{apiKey:KEY});
    sqlite.prepare("INSERT INTO panels(id,name,origin,credentials,group_ids,last_test) VALUES('authpanel',?,?,?,'[17,18]','ok')").run(NAME,PANEL,cipher);
    sent=[];panelCalls=[];originalFetch=globalThis.fetch;
    globalThis.fetch=(async(input,init)=>{
        const u=new URL(String(input));
        if(u.origin==='https://cloudflare-dns.com') return Response.json({Status:0,Answer:[{type:1,data:'8.8.8.8'}]});
        assert.ok([PANEL,NEW_PANEL].includes(u.origin),'Unexpected network call');
        assert.equal(init?.method,'GET','Metadata/configuration tests must never mutate panel users');
        assert.equal(new Headers(init?.headers).get('x-api-key'),KEY);panelCalls.push(u.pathname);
        if(u.pathname==='/api/groups')return Response.json({groups:[{id:17,name:'First group'},{id:18,name:'Second group'}],total:2});
        return Response.json(u.pathname==='/api/admin' ? {username:'bot',status:'active',role:{is_owner:true}} : {id:Number(u.pathname.split('/').at(-1))});
    }) as typeof fetch;
});
afterEach(()=>{globalThis.fetch=originalFetch;sqlite.close();});
async function signed(actor=ADMIN.id,secret=env.TELEGRAM_BOT_TOKEN,at=Math.floor(Date.now()/1000)):Promise<string>{
    const p=new URLSearchParams({auth_date:String(at),user:JSON.stringify({id:actor}),query_id:'synthetic-auth-regression'});
    const text=Array.from(p.entries()).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
    const hmac=async(key:Uint8Array,value:string)=>new Uint8Array(await crypto.subtle.sign('HMAC',await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']),new TextEncoder().encode(value)));
    const key=await hmac(new TextEncoder().encode('WebAppData'),secret);
    p.set('hash',Array.from(await hmac(key,text),v=>v.toString(16).padStart(2,'0')).join(''));return p.toString();
}
async function open(id='authpanel'):Promise<{url:string;token:string}> {
    const api={sendMessage:async(_chat:number,text:string,reply_markup?:unknown)=>{sent.push({text,reply_markup} as typeof sent[number]);},answerCallbackQuery:async()=>{}};
    const ctx={env,db,api,actor:{id:ADMIN.id},chatId:ADMIN.id,customerId:1,isAdmin:false,ui:uiFor('en')} as unknown as UpdateContext;
    await panelCallback(ctx,id==='add' ? 'pnl:add' : `pnl:edit:${id}`,'mock-callback');
    const url=sent.at(-1)!.reply_markup!.inline_keyboard[0]![0]!.web_app!.url;
    return {url,token:new URL(url).searchParams.get('nonce')!};
}
function call(request:Request):Promise<Response>{return worker.fetch(request,env,execution);}
function post(path:'metadata'|'configure'|'groups',body:unknown,origin=WEB):Promise<Response>{
    return call(new Request(`${WEB}/admin/panels/${path}`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}));
}
async function metadata(session:{token:string},initData?:string):Promise<Response>{
    return post('metadata',{nonce:session.token,initData:initData??await signed()});
}
async function configure(session:{token:string},initData?:string):Promise<Response>{
    return post('configure',{nonce:session.token,initData:initData??await signed(),name:'Authorized edit',url:PANEL,apiKey:'',groups:[17,18]});
}

test('unauthenticated GET with a valid administrator form URL returns ONLY a generic shell',async()=>{
    const f=await open();
    for(const url of [f.url,`${f.url}&initData=${encodeURIComponent(await signed(USER.id))}`]){
        const r=await call(new Request(url));assert.equal(r.status,200);
        const html=await r.text();
        for(const value of [NAME,PANEL,'17,18',KEY,env.PANEL_ENCRYPTION_KEY!])assert.ok(!html.includes(value),value);
        assert.ok(html.includes('/admin/panels/metadata'));assert.ok(html.includes('disabled hidden'));
    }
    const direct=await call(new Request(`${WEB}/admin/panels/metadata?nonce=${f.token}`));
    assert.equal(direct.status,403);assert.ok(!(await direct.text()).includes(NAME));
    assert.equal(panelCalls.length,0);
});
test('an unauthorized signed Telegram user or D1-only admin cannot retrieve metadata',async()=>{
    const f=await open();const r=await metadata(f,await signed(USER.id));assert.equal(r.status,403);
    const body=await r.text();assert.ok(!body.includes(NAME));assert.ok(!body.includes(PANEL));assert.ok(!body.includes(KEY));assert.equal(panelCalls.length,0);
});
test('authorized metadata is an explicit non-secret DTO and does not consume the configure nonce',async()=>{
    const f=await open();const p=sqlite.prepare("SELECT credentials FROM panels WHERE id='authpanel'").get()!;
    for(let i=0;i<2;i++){
        const r=await metadata(f);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
        const text=await r.text();assert.deepEqual(JSON.parse(text),{name:NAME,url:PANEL,groups:[17,18],legacy:false,hasApiKey:true});
        for(const value of [KEY,p.credentials as string,env.PANEL_ENCRYPTION_KEY!])assert.ok(!text.includes(value));
    }
    assert.ok(sqlite.prepare('SELECT nonce FROM panel_admin_sessions WHERE nonce=?').get(f.token));assert.equal(panelCalls.length,0);
});
test('metadata rejects unsigned, forged, altered, stale, future and duplicate-field initData',async()=>{
    const f=await open(),now=Math.floor(Date.now()/1000);
    const altered=new URLSearchParams(await signed(USER.id));altered.set('user',JSON.stringify({id:ADMIN.id}));
    const good=await signed();
    for(const data of ['',`user=${encodeURIComponent(JSON.stringify({id:ADMIN.id}))}&auth_date=${now}&hash=${'0'.repeat(64)}`,altered.toString(),await signed(ADMIN.id,env.TELEGRAM_BOT_TOKEN,now-601),await signed(ADMIN.id,env.TELEGRAM_BOT_TOKEN,now+120),good+'&user='+encodeURIComponent(JSON.stringify({id:ADMIN.id}))]){
        assert.equal((await metadata(f,data)).status,403);
    }
    assert.equal((await post('metadata',{nonce:f.token,userId:ADMIN.id})).status,403);assert.equal(panelCalls.length,0);
});
test('metadata independently enforces session ownership even for another allowlisted administrator',async()=>{
    const f=await open();env.PANEL_ADMIN_IDS=String(USER.id);
    assert.equal(await verifyInitData(env,await signed(USER.id)),USER.id);
    assert.equal((await metadata(f,await signed(USER.id))).status,403);
    assert.equal((await configure(f,await signed(USER.id))).status,403);
    assert.equal((await metadata(f)).status,200);
});
test('metadata rejects missing, expired or wrong-action sessions and stale panel revisions',async()=>{
    assert.equal((await metadata({token:nonce()})).status,403);
    const expired=await open();sqlite.prepare('UPDATE panel_admin_sessions SET expires_at=0 WHERE nonce=?').run(expired.token);assert.equal((await metadata(expired)).status,403);
    const wrong=await open();sqlite.prepare("UPDATE panel_admin_sessions SET action='toggle' WHERE nonce=?").run(wrong.token);assert.equal((await metadata(wrong)).status,403);
    const stale=await open();sqlite.prepare("UPDATE panels SET revision=revision+1 WHERE id='authpanel'").run();const r=await metadata(stale);assert.equal(r.status,409);assert.ok(!(await r.text()).includes(NAME));
});
test('current allowlist revocation or a completely empty allowlist rejects metadata and configure',async()=>{
    const f=await open(),auth=await signed();env.ADMIN_CHAT_ID='';env.PANEL_ADMIN_IDS='';
    assert.equal((await metadata(f,auth)).status,403);assert.equal((await configure(f,auth)).status,403);
    delete env.ADMIN_CHAT_ID;delete env.PANEL_ADMIN_IDS;
    assert.equal((await metadata(f,auth)).status,403);assert.equal((await configure(f,auth)).status,403);
});
test('metadata Origin, endpoint origin and JSON gates do not substitute for signature authentication',async()=>{
    const f=await open(),body={nonce:f.token,initData:await signed()};
    for(const foreign of ['https://attacker.example.com','','null'])assert.equal((await post('metadata',body,foreign)).status,403);
    assert.equal((await call(new Request(`${WEB}/admin/panels/metadata`,{method:'POST',body:JSON.stringify(body)}))).status,403);
    assert.equal((await post('metadata',{nonce:f.token,initData:await signed(USER.id)},WEB)).status,403);
    assert.equal((await call(new Request(`https://wrong.example.com/admin/panels/metadata`,{method:'POST',headers:{origin:WEB,'content-type':'application/json'},body:JSON.stringify(body)}))).status,403);
});
test('missing, empty and whitespace-only bot tokens reject initData before using any fallback key',async()=>{
    const good=await signed();
    for(const token of [undefined,'',' ','\t\r\n']){
        if(token===undefined)delete (env as Partial<Env>).TELEGRAM_BOT_TOKEN;else env.TELEGRAM_BOT_TOKEN=token;
        assert.equal(await verifyInitData(env,good),null);
        assert.equal(await verifyInitData(env,await signed(ADMIN.id,token??'')),null);
    }
});
test('forged admin requests with a valid outstanding session fail closed on EVERY sensitive Mini App endpoint without a bot token',async()=>{
    const original=env.TELEGRAM_BOT_TOKEN;
    for(const token of [undefined,'',' ','\t\r\n']){
        env.TELEGRAM_BOT_TOKEN=original;const f=await open('legacy');
        const before=JSON.stringify(sqlite.prepare('SELECT * FROM panels ORDER BY id').all());
        if(token===undefined)delete (env as Partial<Env>).TELEGRAM_BOT_TOKEN;else env.TELEGRAM_BOT_TOKEN=token;
        const forged=await signed(ADMIN.id,token??'');
        for(const endpoint of ['metadata','configure','groups'] as const){
            assert.equal((await post(endpoint,{nonce:f.token,initData:forged,name:'Forged rename'})).status,403);
        }
        assert.equal(JSON.stringify(sqlite.prepare('SELECT * FROM panels ORDER BY id').all()),before);
        assert.ok(sqlite.prepare('SELECT nonce FROM panel_admin_sessions WHERE nonce=?').get(f.token));
    }
    assert.equal(panelCalls.length,0);
});
test('valid secret and signed authorized requests preserve editing, encryption and hidden API keys',async()=>{
    const f=await open();assert.equal((await metadata(f)).status,200);
    assert.equal((await configure(f)).status,200);
    const row=sqlite.prepare("SELECT * FROM panels WHERE id='authpanel'").get()!;
    assert.equal(row.name,'Authorized edit');assert.equal(row.revision,2);assert.ok(!(row.credentials as string).includes(KEY));
    assert.deepEqual(panelCalls,['/api/admin','/api/group/17','/api/group/18']);
    assert.equal((await metadata(f)).status,403);assert.equal((await configure(f)).status,403);
});
test('concurrent duplicate submissions consume exactly one nonce after authenticated metadata loading',async()=>{
    const f=await open('legacy'),auth=await signed();assert.equal((await metadata(f,auth)).status,200);
    const results=await Promise.all([configure(f,auth),configure(f,auth)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,403]);
    assert.equal(sqlite.prepare("SELECT revision FROM panels WHERE id='legacy'").get()!.revision,2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM panel_audit WHERE action='rename'").get()!.n,1);
    assert.equal((await metadata(f,auth)).status,403);assert.equal((await configure(f,auth)).status,403);
});
test('new-panel metadata loading leaves the successful add/configure workflow intact',async()=>{
    const f=await open('add'),r=await metadata(f);assert.equal(r.status,200);
    assert.deepEqual(await r.json(),{name:'',url:'',groups:[],legacy:false,hasApiKey:false});
    const id=sqlite.prepare('SELECT panel_id FROM panel_admin_sessions WHERE nonce=?').get(f.token)!.panel_id as string;
    const res=await post('configure',{nonce:f.token,initData:await signed(),name:'Added',url:NEW_PANEL,apiKey:KEY,groups:[17]});
    assert.equal(res.status,200);
    const row=sqlite.prepare('SELECT * FROM panels WHERE id=?').get(id)!;
    assert.equal(row.name,'Added');assert.equal(row.origin,NEW_PANEL);assert.equal(row.enabled_new,0);assert.equal(row.last_test,'ok');assert.ok(!(row.credentials as string).includes(KEY));
    assert.equal(sqlite.prepare("SELECT name FROM panels WHERE id='authpanel'").get()!.name,NAME);
});
test('generic form frontend authenticates before prefill and keeps stored keys out of the browser',async()=>{
    const f=await open();const html=await (await call(new Request(f.url))).text();
    const script=/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const dom=panelFormDom(),get=dom.get;
    const auth=await signed();const uiCalls:string[]=[];
    const browserFetch=async(path:string,init:RequestInit)=>{uiCalls.push(path);return call(new Request(WEB+path,{...init,headers:{...(init.headers as Record<string,string>),origin:WEB}}));};
    await runInNewContext(script,{document:dom.document,URL,setTimeout:dom.setTimeout,clearTimeout:dom.clearTimeout,window:{Telegram:{WebApp:{initData:auth,ready:()=>{}}}},fetch:browserFetch});
    assert.deepEqual(uiCalls,['/admin/panels/metadata','/admin/panels/groups']);assert.equal(get('name').value,NAME);assert.equal(get('url').value,PANEL);assert.deepEqual(dom.checkboxes().filter((v:any)=>v.checked).map((v:any)=>Number(v.value)),[17,18]);assert.equal(get('select-all').checked,true);assert.equal(get('save').disabled,false);
    assert.equal(get('key').value,'');assert.equal(get('key').required,false);assert.equal(get('fields').hidden,false);assert.equal(get('fields').disabled,false);
    await (get('f').onsubmit as (e:{preventDefault():void})=>Promise<void>)({preventDefault:()=>{}});
    assert.deepEqual(uiCalls,['/admin/panels/metadata','/admin/panels/groups','/admin/panels/configure']);assert.equal(get('key').value,'');assert.equal(get('fields').disabled,true);
});
test('frontend never enables or prefills an unauthorized borrowed-link form',async()=>{
    const f=await open();const html=await (await call(new Request(f.url))).text();const script=/<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const dom=panelFormDom(),get=dom.get;
    await runInNewContext(script,{document:dom.document,URL,setTimeout:dom.setTimeout,clearTimeout:dom.clearTimeout,window:{Telegram:{WebApp:{initData:await signed(USER.id),ready:()=>{}}}},fetch:async(path:string,init:RequestInit)=>call(new Request(WEB+path,{...init,headers:{...(init.headers as Record<string,string>),origin:WEB}}))});
    assert.equal(get('fields').disabled,true);assert.equal(get('fields').hidden,true);assert.equal(get('name').value,'');assert.equal(get('url').value,'');assert.equal(get('key').value,'');assert.equal(panelCalls.length,0);
});
