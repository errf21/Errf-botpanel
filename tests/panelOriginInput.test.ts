import {test} from 'node:test';import assert from 'node:assert/strict';import {panelOrigin,panelInputOrigin,publicDestination} from '../src/panels/security.ts';
const origin='https://panel.mrapanel.shop:8000';
test('existing 4e9c269 port support is retained; dashboard normalization does not loosen stored-origin validation',()=>{
 assert.equal(panelOrigin(origin),origin);assert.equal(panelOrigin('https://panel.MraPanel.shop:8000/dashboard/#/login'),null);
 assert.equal(panelInputOrigin('https://panel.MraPanel.shop:8000/dashboard/#/login'),origin);assert.equal(panelInputOrigin(origin),origin);assert.equal(panelInputOrigin('https://panel.mrapanel.shop:444'),null);
 assert.equal(panelOrigin(origin+'/dashboard'),null);assert.equal(panelInputOrigin('https://panel.MraPanel.shop:443/dashboard/#/login'),'https://panel.mrapanel.shop');
});
for(const url of ['http://panel.mrapanel.shop:8000/dashboard','https://panel.mrapanel.shop:444/dashboard','https://panel.mrapanel.shop:8001','https://name:password@panel.mrapanel.shop:8000/dashboard','https://panel.mrapanel.shop:8000/dashboard?token=secret#/login','https://127.0.0.1:8000/dashboard','https://[::1]:8000/dashboard','https://localhost:8000/dashboard','https://private.internal:8000/dashboard','https://panel.\nmrapanel.shop:8000/dashboard','//panel.mrapanel.shop:8000/dashboard'])test('input normalization rejects unsafe value '+url.replace(/\n/g,'\\n'),()=>assert.equal(panelInputOrigin(url),null));
test('normalized nonstandard-port origin still requires public A AND AAAA destinations',async()=>{
 const real=globalThis.fetch;let privateAddress=false;globalThis.fetch=async input=>{const u=new URL(String(input));assert.equal(u.origin,'https://cloudflare-dns.com');assert.equal(u.searchParams.get('name'),'panel.mrapanel.shop');return Response.json({Status:0,Answer:u.searchParams.get('type')==='AAAA'?[{type:28,data:privateAddress?'::1':'2606:4700:4700::1111'}]:[{type:1,data:'8.8.8.8'}]});};
 try{assert.equal(await publicDestination(origin),true);privateAddress=true;assert.equal(await publicDestination(origin),false);assert.equal(await publicDestination(origin+'/dashboard/#/login'),false);}finally{globalThis.fetch=real;}
});
