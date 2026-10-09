/** Real workerd fetch semantics, isolated outbound fixture; no live panel/API key. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('real workerd DNS + panel client supports IPv4-only and rejects redirects before following them',async()=>{
 const {build}=require('esbuild'),{Miniflare,convertV4MiniflareOptions}=require('miniflare');
 const built=await build({stdin:{contents:`import {publicDestination} from './src/panels/security.ts';import {PasarGuardClient} from './src/pasarguard/client.ts';export default{async fetch(){const origin='https://panel.mrapanel.shop:8000';const client=new PasarGuardClient({baseUrl:origin,apiKey:'SYNTHETIC-WORKER-DNS-KEY',panelId:'cf_1',validateDestination:()=>publicDestination(origin)});return Response.json(await client.getCurrentAdmin());}};`,resolveDir:process.cwd(),sourcefile:'runtime-panel-dns.ts'},bundle:true,format:'esm',platform:'browser',write:false,target:'es2022'});
 let scenario='ok';const events:{host:string;type:string|null;hasKey:boolean}[]=[];
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],script:built.outputFiles[0].text,outboundService:async(request:Request)=>{
  const u=new URL(request.url),key=request.headers.get('x-api-key');events.push({host:u.origin,type:u.searchParams.get('type'),hasKey:key!==null});
  if(u.origin==='https://cloudflare-dns.com'){assert.equal(key,null);assert.equal(request.headers.get('accept'),'application/dns-json');assert.equal(u.searchParams.get('name'),'panel.mrapanel.shop');if(scenario==='dns_redirect')return Response.redirect('https://never-follow.example.com/dns',302);if(scenario==='dns_http_error')return new Response(null,{status:503});if(scenario==='malformed')return Response.json({Status:0,Answer:null});return Response.json(u.searchParams.get('type')==='A'?{Status:0,Answer:[{type:1,data:scenario==='private'?'127.0.0.1':'176.120.17.222'}]}:{Status:0});}
  assert.equal(u.origin,'https://panel.mrapanel.shop:8000');assert.equal(key,'SYNTHETIC-WORKER-DNS-KEY');if(scenario==='panel_redirect')return Response.redirect('https://never-follow.example.com/api/admin',307);return Response.json({username:'operator',status:'active',role:{is_owner:true}});
 }}));
 try{
  let response=await mf.dispatchFetch('https://local-test.example/');let result=await response.json() as any;assert.equal(result.ok,true);assert.equal(events.length,3);assert.equal(events.filter(e=>e.hasKey).length,1);
  for(scenario of ['dns_redirect','dns_http_error','private','malformed']){events.length=0;result=await(await mf.dispatchFetch('https://local-test.example/')).json();assert.deepEqual(result,{ok:false,kind:'bad_url',status:0,detail:'destination_not_public'});assert.equal(events.filter(e=>e.hasKey).length,0);assert.ok(events.every(e=>e.host==='https://cloudflare-dns.com'));}
  scenario='panel_redirect';events.length=0;result=await(await mf.dispatchFetch('https://local-test.example/')).json();assert.deepEqual(result,{ok:false,kind:'rejected',status:307,detail:'redirect_rejected'});assert.equal(events.length,3);assert.ok(!events.some(e=>e.host==='https://never-follow.example.com'));assert.ok(!JSON.stringify(result).includes('SYNTHETIC-WORKER-DNS-KEY'));
 }finally{await mf.dispose();}
});
