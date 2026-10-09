/** Version-pinned synthetic wire contracts. Not a live-panel compatibility claim. */
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {extractPanelUser,PasarGuardClient} from '../src/pasarguard/client.ts';
const fixture=JSON.parse(readFileSync(new URL('../docs/evidence/pasarguard-5.4.1-contract.json',import.meta.url),'utf8'));
test('5.4.1 UserResponse parses ISO expiry, numeric stable ID and real numeric group IDs',()=>{
 const u=extractPanelUser(fixture.user_response)!;assert.equal(fixture.tag,'v5.4.1');assert.equal(u.id,'201');assert.equal(u.expire,1893456000);assert.equal(u.dataLimit,7000000000);assert.equal(u.usedTraffic,0);assert.equal(u.hwidLimit,3);assert.deepEqual(u.groupIds,[71]);assert.ok(!u.migrationRestrictions?.length);
});
for(const ids of [undefined,[],['71'],[0],[71,71]])test(`5.4.1 invalid/absent group IDs ${JSON.stringify(ids)} stay unverified`,()=>{assert.equal(extractPanelUser({...fixture.user_response,group_ids:ids})!.groupIds,null);});
test('5.4.1 group envelope and stable-ID CRUD use verified paths and API-key header, never bearer login',async()=>{
 const real=globalThis.fetch,calls:{method:string;path:string}[]=[],key='SYNTHETIC-541-KEY';
 globalThis.fetch=async(input,init)=>{const u=new URL(String(input)),method=init?.method??'GET';calls.push({method,path:u.pathname});assert.equal(new Headers(init?.headers).get('x-api-key'),key);assert.equal(new Headers(init?.headers).get('authorization'),null);assert.equal(init?.redirect,'manual');
  if(u.pathname==='/api/groups')return Response.json(fixture.groups_response);if(u.pathname==='/api/group/71')return Response.json(fixture.groups_response.groups[0]);if(method==='DELETE')return new Response(null,{status:204});return Response.json(fixture.user_response);
 };
 try{const c=new PasarGuardClient({baseUrl:'https://fixture-541.example.com',apiKey:key,stableIdentity:true,expectedUserId:'201'});assert.deepEqual((await c.listGroups()).ok,true);assert.ok((await c.getGroup(71)).ok);assert.ok((await c.getUserById('201')).ok);assert.ok((await c.modifyUserByUsername('mgfixtureuser',{status:'disabled',expire:1893456000,data_limit:7000000000,hwid_limit:3})).ok);assert.ok((await c.deleteUserByUsername('mgfixtureuser')).ok);assert.deepEqual(calls.map(c=>[c.method,c.path]),[['GET','/api/groups'],['GET','/api/group/71'],['GET','/api/user/by-id/201'],['PUT','/api/user/by-id/201'],['DELETE','/api/user/by-id/201']]);}finally{globalThis.fetch=real;}
});
