/** Admin-authorized, durable migration. Orders and financial ledgers are never created or rewritten. */
import type { Env } from '../types.ts';
import type { PanelUser } from '../pasarguard/client.ts';
import { PasarGuardClient, resolveSubscriptionUrl } from '../pasarguard/client.ts';
import { getOrderById } from '../db/orders.ts';
import { resolvePanel, acquireServiceLock, releaseServiceLock, provisioningForPanel } from '../panels/registry.ts';
import { loadProvisioningConfig } from '../catalog/provisioning.ts';
import { isPanelAdmin, nonce } from '../panels/security.ts';
import { newOrderId } from '../lib/security.ts';
export interface Entitlement {
 source:'fresh'|'saved'|'manual'; observedAt:number; confirmedMethod?:string;
 quota:number|null; used:number|null; remaining:number; expire:number; hwid:number;
}
export interface Migration {
 id:string; service_id:string; customer_id:number; operator:string; source_migration_id:string|null;
 source_panel_id:string; source_origin:string; source_user_id:string; source_username:string; source_url:string|null;
 destination_panel_id:string; destination_origin:string; destination_revision:number; destination_username:string;
 destination_user_id:string|null; destination_url:string|null; destination_config:string;
 abort_requested:number; state:'review'|'creating'|'verified'|'activating'|'cleanup_pending'|'completed'|'cancelled';
 entitlement:string|null; confirmed_by:string|null; confirmed_at:string|null; confirmation_token:string;
 review_expires_at:number; create_attempts:number; revoke_attempts:number; error:string|null;
 source_revoked_at:string|null; created_at:string; updated_at:string;
 blocked_count:number; next_recovery_at:number; last_recovery_at:number;
}
function authorize(env:Env,actor:number):void { if(!isPanelAdmin(env,actor)) throw Error('migration_not_authorized'); }
async function row(env:Env,id:string):Promise<Migration> {
 const m=await env.DB.prepare('SELECT * FROM service_migrations WHERE id=?1').bind(id).first<Migration>();
 if(!m)throw Error('migration_not_found');return m;
}
export async function migrationStatus(env:Env,id:string,actor:number):Promise<Migration>{authorize(env,actor);return row(env,id);}
async function event(env:Env,m:Migration,actor:number,action:string,data:unknown={}):Promise<void>{
 await env.DB.prepare('INSERT INTO service_migration_events(migration_id,actor,action,data) VALUES(?1,?2,?3,?4)')
  .bind(m.id,String(actor),action,JSON.stringify(data)).run();
}
async function state(env:Env,m:Migration,actor:number,next:Migration['state'],error:string|null=null):Promise<Migration>{
 const now=Date.now(),same=m.state===next&&m.error===error;
 const count=error ? (same ? (m.blocked_count??0)+1 : 1) : 0;
 // One immediate reconciliation remains possible. Repeated identical blocks
 // then back off durably; manual retries deliberately bypass the due gate.
 const due=error&&count>=2 ? now+Math.min(3600000,60000*2**Math.min(6,count-2)) : 0;
 await env.DB.batch([
  env.DB.prepare(`INSERT INTO service_migration_events(migration_id,actor,action,data)
   SELECT id,?2,?3,?4 FROM service_migrations WHERE id=?1 AND state=?5
   AND (state<>?6 OR error IS NOT ?7)`)
   .bind(m.id,String(actor),error?'blocked':next,JSON.stringify({from:m.state,code:error}),m.state,next,error),
  env.DB.prepare(`UPDATE service_migrations SET state=?2,error=?3,blocked_count=?5,next_recovery_at=?6,last_recovery_at=?7,
   updated_at=CASE WHEN state<>?2 OR error IS NOT ?3 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE updated_at END
   WHERE id=?1 AND state=?4`)
   .bind(m.id,next,error,m.state,count,due,now),
 ]);return row(env,m.id);
}
function entitlement(values:{quota:number|null;used:number|null;expire:number|null;hwid:number|null},source:Entitlement['source'],at:number):Entitlement|null {
 const remaining=values.quota!==null&&values.used!==null&&Number.isSafeInteger(values.quota)&&values.quota>0&&Number.isSafeInteger(values.used)&&values.used>=0&&values.used<=values.quota ? values.quota-values.used : null;
 if(remaining===null||!Number.isSafeInteger(remaining)||remaining<=0||!values.expire||!Number.isSafeInteger(values.expire)||values.expire<=Date.now()/1000||values.expire>4000000000||!values.hwid||!Number.isSafeInteger(values.hwid)||values.hwid>10000||values.hwid<1)return null;
 return {source,observedAt:at,quota:values.quota,used:values.used,remaining,expire:values.expire,hwid:values.hwid};
}
async function client(env:Env,panel:string,id?:string,expectedOrigin?:string):Promise<PasarGuardClient|null>{
 const p=await resolvePanel(env,panel);return p.ok && (!expectedOrigin||p.config.baseUrl===expectedOrigin) ? new PasarGuardClient({...p.config,stableIdentity:true,expectedUserId:id}) : null;
}
/** Upstream User-not-found also masks OWN-scope invisibility. A 404 alone
 * cannot prove deletion; require a freshly verified owner/all-user read scope. */
async function absenceVisibleToPrincipal(c:PasarGuardClient):Promise<boolean>{
 return c.canVerifyAbsence();
}
/** The reviewed panel defaults are immutable for this operation. Recheck actual
 * 5.4.1 group resources before writes; never substitute a newer default. */
async function groupsValid(c:PasarGuardClient,policy:unknown):Promise<string|null>{
 const ids=(policy as {groupIds?:unknown}|null)?.groupIds;
 if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(id=>!Number.isSafeInteger(id)||id<1||id>1000000)||new Set(ids).size!==ids.length)return 'panel_groups_invalid';
 const deadline=Date.now()+30000;
 for(const id of ids){
  const remaining=deadline-Date.now();if(remaining<=0)return 'destination_groups_unverified';
  const found=await c.getGroup(id,remaining);
  if(Date.now()>=deadline)return 'destination_groups_unverified';
  if(!found.ok||!found.data||found.data.id!==id||typeof found.data.is_disabled!=='boolean')return 'destination_groups_unverified';
  if(found.data.is_disabled)return 'destination_groups_disabled';
 }
 return null;
}
function sameGroups(m:Migration,u:PanelUser):boolean{
 const ids=JSON.parse(m.destination_config).groupIds as number[];
 return Array.isArray(u.groupIds)&&u.groupIds.length===ids.length&&ids.every(id=>u.groupIds!.includes(id));
}
async function idle(env:Env,service:string):Promise<boolean>{
 return !await env.DB.prepare(`SELECT id FROM orders WHERE renews_order_id=?1
  AND (state IN ('pending_payment','awaiting_review','approved','provisioning') OR
    (state='failed' AND (provision_attempts>0 OR renew_target_unix IS NOT NULL OR repurchase_target_unix IS NOT NULL))) LIMIT 1`).bind(service).first();
}
/** Read-only source preview under the service lease. A draft fences new mutations until confirmed/cancelled/expired. */
export async function proposeMigration(env:Env,actor:number,serviceId:string,customerId:number,destination:string):Promise<Migration>{
 authorize(env,actor);const owner=crypto.randomUUID();
 if(!await acquireServiceLock(env.DB,serviceId,owner))throw Error('service_busy');
 try {
  const s=await getOrderById(env.DB,serviceId);
  if(!s||s.customer_id!==customerId||s.kind!=='purchase'||s.state!=='completed'||s.panel_deleted_at||!s.panel_id||!s.pasarguard_user_id||!s.pasarguard_username)throw Error('service_owner_or_identity_invalid');
  if(!await idle(env,serviceId))throw Error('pending_service_operation');
  const p=await resolvePanel(env,destination),config=await loadProvisioningConfig(env.DB);
  if(destination===s.panel_id||!p.ok||!p.row.enabled_new||!config.ok||!config.config.enabled||(destination!=='legacy'&&p.row.last_test!=='ok'))throw Error('destination_not_ready');
  const policy=provisioningForPanel(p.row,config.config);
  const groupError=await groupsValid(new PasarGuardClient(p.config),policy);
  if(groupError)throw Error(groupError);
  const active=await env.DB.prepare('SELECT migration_id FROM active_service_resources WHERE service_id=?1').bind(serviceId).first<{migration_id:string}>();
  const sourcePanel=await resolvePanel(env,s.panel_id);
  const cached=await env.DB.prepare(`SELECT origin FROM service_observations WHERE service_id=?1 AND panel_id=?2 AND user_id=?3 AND username=?4
    AND origin IS NOT NULL ORDER BY observed_at DESC,id DESC LIMIT 1`).bind(serviceId,s.panel_id,s.pasarguard_user_id,s.pasarguard_username).first<{origin:string}>();
  let sourceOrigin=sourcePanel.ok?sourcePanel.config.baseUrl:cached?.origin;
  if(!sourceOrigin && s.panel_id==='legacy'){try{const u=new URL(env.PASARGUARD_PANEL_URL??'');if(u.protocol==='https:'&&!u.username&&!u.password)sourceOrigin=u.origin;}catch{}}
  if(!sourceOrigin)throw Error('source_origin_unavailable');
  let chosen:Entitlement|null=null;const source=await client(env,s.panel_id,s.pasarguard_user_id,sourceOrigin);
  const read=source?await source.getUserById(s.pasarguard_user_id):null;
  if(read?.ok && read.data && read.data.username===s.pasarguard_username && ['active','on_hold'].includes(read.data.status??'')){
   if(!read.data.migrationRestrictions?.length)
   chosen=entitlement({quota:read.data.dataLimit,used:read.data.usedTraffic,expire:read.data.expire,hwid:read.data.hwidLimit},'fresh',Date.now());
  } else {
   const saved=await env.DB.prepare(`SELECT data,observed_at FROM service_observations WHERE service_id=?1 AND panel_id=?2 AND user_id=?3 AND username=?4 AND origin=?5 ORDER BY observed_at DESC,id DESC LIMIT 1`)
    .bind(serviceId,s.panel_id,s.pasarguard_user_id,s.pasarguard_username,sourceOrigin).first<{data:string;observed_at:number}>();
   if(saved){const v=JSON.parse(saved.data);if(['active','on_hold'].includes(v.status??'')&&!v.migrationRestrictions?.length)chosen=entitlement(v,'saved',saved.observed_at);}
  }
  const id=newOrderId(),token=nonce();
  await env.DB.batch([
   env.DB.prepare(`INSERT INTO service_migrations(id,service_id,customer_id,operator,source_migration_id,source_panel_id,source_user_id,source_username,source_url,
    destination_panel_id,destination_revision,destination_username,destination_config,state,entitlement,confirmation_token,review_expires_at,source_origin,destination_origin)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'review',?14,?15,?16,?17,?18)`)
    .bind(id,serviceId,customerId,String(actor),active?.migration_id??null,s.panel_id,s.pasarguard_user_id,s.pasarguard_username,s.subscription_url,
     destination,p.row.revision,`mg${id.toLowerCase()}`,JSON.stringify(policy),chosen?JSON.stringify(chosen):null,token,Date.now()+300000,sourceOrigin,p.config.baseUrl),
   env.DB.prepare("INSERT INTO service_migration_events(migration_id,actor,action,data) VALUES(?1,?2,'review',?3)")
    .bind(id,String(actor),JSON.stringify({entitlement:chosen,sourceIdentity:s.pasarguard_user_id,unsupportedFeatures:read?.ok?read.data?.migrationRestrictions??[]:[]})),
  ]);return row(env,id);
 }finally{await releaseServiceLock(env.DB,serviceId,owner);}
}
export async function manualEntitlement(env:Env,actor:number,id:string,remaining:number,expire:number,hwid:number):Promise<Migration>{
 authorize(env,actor);const m=await row(env,id);
 if(m.operator!==String(actor)||m.state!=='review'||!Number.isSafeInteger(remaining)||remaining<1||remaining>Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(expire)||expire<=Date.now()/1000||expire>4000000000||!Number.isSafeInteger(hwid)||hwid<1||hwid>10000)throw Error('manual_entitlement_invalid');
 const e:Entitlement={source:'manual',observedAt:Date.now(),quota:null,used:null,remaining,expire,hwid};
 await env.DB.prepare(`UPDATE service_migrations SET entitlement=?2,confirmation_token=?3,review_expires_at=?4 WHERE id=?1 AND state='review' AND operator=?5`)
  .bind(id,JSON.stringify(e),nonce(),Date.now()+300000,String(actor)).run();await event(env,m,actor,'manual_review',{entitlement:e});return row(env,id);
}
/** Explicit abort before cutover: reconcile only the unpublished destination.
 * A durable abort flag prevents cron/retries from activating during cleanup. */
export async function cancelMigration(env:Env,actor:number,id:string):Promise<Migration>{
 authorize(env,actor);let m=await row(env,id);
 if(m.state==='cancelled')return m;
 if(!['review','creating','verified','activating'].includes(m.state)||(m.state==='review'&&m.operator!==String(actor)))throw Error('cannot_cancel_remote_migration');
 const owner=`migration:${m.id}:${crypto.randomUUID()}`;if(!await acquireServiceLock(env.DB,m.service_id,owner))throw Error('service_busy');
 try{
  m=await row(env,id);if(!['review','creating','verified','activating'].includes(m.state))throw Error('cannot_cancel_remote_migration');
  const source=await getOrderById(env.DB,m.service_id);
  if(!source||source.customer_id!==m.customer_id||source.panel_id!==m.source_panel_id||source.pasarguard_user_id!==m.source_user_id)throw Error('cannot_cancel_remote_migration');
  if(m.state==='review'||(m.state==='creating'&&m.create_attempts===0))return state(env,m,actor,'cancelled');
  await env.DB.batch([
   env.DB.prepare('UPDATE service_migrations SET abort_requested=1 WHERE id=?1').bind(m.id),
   env.DB.prepare("INSERT INTO service_migration_events(migration_id,actor,action,data) VALUES(?1,?2,'abort_requested','{}')").bind(m.id,String(actor)),
  ]);m=await row(env,id);
  const c=await client(env,m.destination_panel_id,m.destination_user_id??undefined,m.destination_origin);
  if(!c)return state(env,m,actor,m.state,'candidate_cleanup_unconfirmed');
  let found=m.destination_user_id?await c.getUserById(m.destination_user_id):await c.getUserByUsername(m.destination_username);
  if(found.ok&&found.data){
   const u=found.data;
   if(!u.id||u.note!==`migration:${m.id}:${m.service_id}:${m.customer_id}`||
    await env.DB.prepare('SELECT id FROM effective_orders WHERE panel_id=?1 AND pasarguard_user_id=?2 AND id<>?3').bind(m.destination_panel_id,u.id,m.service_id).first())return state(env,m,actor,m.state,'candidate_identity_unverified');
   await env.DB.batch([
    env.DB.prepare('UPDATE service_migrations SET destination_user_id=COALESCE(destination_user_id,?2) WHERE id=?1').bind(m.id,u.id),
    env.DB.prepare("INSERT INTO service_migration_events(migration_id,actor,action,data) VALUES(?1,?2,'candidate_cleanup_attempt','{}')").bind(m.id,String(actor)),
   ]);
   const bound=c.withExpectedUserId(u.id);await bound.deleteUserByUsername(m.destination_username);found=await bound.getUserById(u.id);
  }
  if(found.ok||found.kind!=='not_found')return state(env,m,actor,m.state,'candidate_cleanup_unconfirmed');
  if(!await absenceVisibleToPrincipal(c))return state(env,m,actor,m.state,'candidate_absence_scope_unverified');
  return state(env,m,actor,'cancelled');
 }finally{await releaseServiceLock(env.DB,m.service_id,owner);}
}
export async function confirmMigration(env:Env,actor:number,token:string):Promise<Migration>{
 authorize(env,actor);const m=await env.DB.prepare("SELECT * FROM service_migrations WHERE confirmation_token=?1 AND operator=?2 AND state='review' AND review_expires_at>?3")
  .bind(token,String(actor),Date.now()).first<Migration>();if(!m?.entitlement)throw Error('expired_or_incomplete_review');
 const e=JSON.parse(m.entitlement) as Entitlement;if(e.expire<=Date.now()/1000)throw Error('entitlement_expired');
 // A fresh preview expires quickly; require another source preview, never silently replace agreed values.
 if(e.source==='fresh'&&Date.now()-e.observedAt>60000)throw Error('fresh_preview_expired_cancel_and_review_again');
 if(e.source==='fresh'){
  const source=await client(env,m.source_panel_id,m.source_user_id,m.source_origin);
  const read=source?await source.getUserById(m.source_user_id):null;
  const latest=read?.ok&&read.data&&read.data.username===m.source_username&&!read.data.migrationRestrictions?.length&&['active','on_hold'].includes(read.data.status??'')
    ? entitlement({quota:read.data.dataLimit,used:read.data.usedTraffic,expire:read.data.expire,hwid:read.data.hwidLimit},'fresh',Date.now()):null;
  if(!latest||latest.remaining!==e.remaining||latest.expire!==e.expire||latest.hwid!==e.hwid)throw Error('fresh_preview_changed_cancel_and_review_again');
  e.observedAt=latest.observedAt;e.quota=latest.quota;e.used=latest.used;
 }
 e.confirmedMethod=e.source==='fresh'?'explicit_fresh_confirmation':`explicit_${e.source}_confirmation`;
 await env.DB.batch([
  env.DB.prepare(`UPDATE service_migrations SET state='creating',entitlement=?2,confirmed_by=?3,confirmed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
   updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND state='review' AND confirmation_token=?4 AND operator=?3 AND review_expires_at>?5`)
   .bind(m.id,JSON.stringify(e),String(actor),token,Date.now()),
  env.DB.prepare(`INSERT INTO service_migration_events(migration_id,actor,action,data) SELECT id,?2,'confirmed',?3 FROM service_migrations WHERE id=?1 AND state='creating' AND confirmed_by=?2`)
   .bind(m.id,String(actor),JSON.stringify({entitlement:e})),
 ]);
 return advanceMigration(env,m.id,actor,true);
}
function safeUrl(base:string,value:string|null):string|null {
 const resolved=resolveSubscriptionUrl(base,value);if(!resolved)return null;
 try{const u=new URL(resolved);return u.protocol==='https:'&&!u.username&&!u.password&&resolved.length<512 ? resolved : null;}catch{return null;}
}
function verifyDestination(m:Migration,u:PanelUser,e:Entitlement,creation:boolean):boolean{
 return u.id!==null&&u.username===m.destination_username&&u.note===`migration:${m.id}:${m.service_id}:${m.customer_id}`&&
  u.dataLimit===e.remaining&&u.expire===e.expire&&u.hwidLimit===e.hwid&&
  sameGroups(m,u)&&(creation ? u.usedTraffic===0&&u.status==='disabled' : u.status==='active');
}
/** Retry is explicit; recovery may reconcile a previous create but never blindly reissue it. */
export async function advanceMigration(env:Env,id:string,actor:number,allowCreate=false,automatic=false):Promise<Migration>{
 authorize(env,actor);let m=await row(env,id);if(automatic && m.next_recovery_at>Date.now())return m;if(m.abort_requested||!['creating','verified','activating'].includes(m.state))return m;
 const owner=`migration:${m.id}:${crypto.randomUUID()}`;
 if(!await acquireServiceLock(env.DB,m.service_id,owner))return m;
 try{
  m=await row(env,id);if(automatic && m.next_recovery_at>Date.now())return m;if(m.abort_requested||!['creating','verified','activating'].includes(m.state))return m;
  const s=await getOrderById(env.DB,m.service_id),e=JSON.parse(m.entitlement!) as Entitlement;
  if(!s||s.customer_id!==m.customer_id||s.panel_id!==m.source_panel_id||s.pasarguard_user_id!==m.source_user_id||s.pasarguard_username!==m.source_username||s.panel_deleted_at||!await idle(env,m.service_id))return state(env,m,actor,m.state,'source_or_pending_operation_changed');
  if(e.expire<=Date.now()/1000)return state(env,m,actor,m.state,'entitlement_expired_requires_review');
  const resolved=await resolvePanel(env,m.destination_panel_id);if(!resolved.ok)return state(env,m,actor,m.state,'destination_configuration_unavailable');
  if(resolved.config.baseUrl!==m.destination_origin)return state(env,m,actor,m.state,'destination_origin_changed');
  let c=new PasarGuardClient({...resolved.config,stableIdentity:true,expectedUserId:m.destination_user_id??undefined});
  const groupError=await groupsValid(c,JSON.parse(m.destination_config));
  if(groupError)return state(env,m,actor,m.state,groupError);
  let remote=await c.getUserByUsername(m.destination_username);
  if(m.state==='creating'){
   if(!remote.ok&&remote.kind==='not_found'){
    if(!allowCreate||m.create_attempts>=3||!resolved.row.enabled_new)return state(env,m,actor,m.state,'destination_absent_explicit_retry_required');
    await env.DB.batch([
     env.DB.prepare("UPDATE service_migrations SET create_attempts=create_attempts+1,error=NULL WHERE id=?1 AND state='creating'").bind(m.id),
     env.DB.prepare("INSERT INTO service_migration_events(migration_id,actor,action,data) VALUES(?1,?2,'create_attempt','{}')").bind(m.id,String(actor)),
    ]);
    const policy=JSON.parse(m.destination_config);
    // Attempt identity and entitlement were persisted BEFORE first remote write.
    await c.createUser({username:m.destination_username,status:'active',data_limit:e.remaining,expire:e.expire,hwid_limit:e.hwid,
     group_ids:policy.groupIds,note:`migration:${m.id}:${m.service_id}:${m.customer_id}`});
    // Always reconcile, including timeout/409/invalid-envelope outcomes. Never trust POST alone.
    remote=await c.getUserByUsername(m.destination_username);
   }
   if(remote.ok&&remote.data&&!sameGroups(m,remote.data))return state(env,m,actor,m.state,'destination_groups_mismatch');
   if(!remote.ok||!remote.data||!['active','disabled'].includes(remote.data.status??'')||!verifyDestination(m,{...remote.data,status:'disabled'},e,true))return state(env,m,actor,m.state,'destination_creation_unverified');
   if(await env.DB.prepare('SELECT id FROM effective_orders WHERE panel_id=?1 AND pasarguard_user_id=?2 AND id<>?3').bind(m.destination_panel_id,remote.data.id,m.service_id).first())return state(env,m,actor,m.state,'destination_identity_owned_elsewhere');
   // Official UserCreate rejects disabled and on_hold + absolute expiry.
   // Create with absolute expiry, then verify a stable-ID disable before staging.
   if(remote.data.status==='active'){
    c=c.withExpectedUserId(remote.data.id!);
    await c.modifyUserByUsername(m.destination_username,{status:'disabled',expire:e.expire,data_limit:e.remaining,hwid_limit:e.hwid});
    remote=await c.getUserById(remote.data.id!);
   }
   if(!remote.ok||!remote.data||!verifyDestination(m,remote.data,e,true))return state(env,m,actor,m.state,'destination_staging_disable_unverified');
   const sub=safeUrl(resolved.config.baseUrl,remote.data.subscriptionUrl);if(!sub||!sub.startsWith('https://'))return state(env,m,actor,m.state,'destination_url_unverified');
   await env.DB.batch([
    env.DB.prepare("UPDATE service_migrations SET destination_user_id=?2,destination_url=?3,state='verified',error=NULL,blocked_count=0,next_recovery_at=0 WHERE id=?1 AND state='creating'").bind(m.id,remote.data.id,sub),
    env.DB.prepare("INSERT INTO service_migration_events(migration_id,actor,action,data) VALUES(?1,?2,'verified',?3)").bind(m.id,String(actor),JSON.stringify({userId:remote.data.id})),
   ]);m=await row(env,id);
   // Checkpoint between provisioning/staging and activation. Next admin retry or
   // cron invocation resumes, bounding work per Worker execution.
   return m;
  }
  if(m.state==='verified')m=await state(env,m,actor,'activating');
  if(m.state==='activating'){
   c=new PasarGuardClient({...resolved.config,stableIdentity:true,expectedUserId:m.destination_user_id!});
   let live=await c.getUserById(m.destination_user_id!);
   if(!live.ok||!live.data||live.data.username!==m.destination_username||live.data.note!==`migration:${m.id}:${m.service_id}:${m.customer_id}`)return state(env,m,actor,m.state,'activation_identity_unverified');
   if(!sameGroups(m,live.data))return state(env,m,actor,m.state,'destination_groups_mismatch');
   if(live.data.status==='disabled'){
    await c.modifyUserByUsername(m.destination_username,{status:'active',data_limit:e.remaining,expire:e.expire,hwid_limit:e.hwid});
    live=await c.getUserById(m.destination_user_id!);
   }
   if(!live.ok||!live.data||!verifyDestination(m,live.data,e,false))return state(env,m,actor,m.state,'activation_unverified');
   const url=safeUrl(resolved.config.baseUrl,live.data.subscriptionUrl);
   if(!url||!url.startsWith('https://'))return state(env,m,actor,m.state,'active_url_unverified');
   // One atomic switch, conditioned on the captured original active generation.
   await env.DB.batch([
    env.DB.prepare("UPDATE service_migrations SET destination_url=?2 WHERE id=?1 AND state='activating'").bind(m.id,url),
    env.DB.prepare(`INSERT INTO active_service_resources(service_id,migration_id,panel_id,user_id,username,subscription_url,expires_at,provision_config)
     SELECT service_id,id,destination_panel_id,destination_user_id,destination_username,destination_url,?2,destination_config
      FROM service_migrations m WHERE id=?1 AND state='activating'
      AND EXISTS(SELECT 1 FROM effective_orders s WHERE s.id=m.service_id AND s.customer_id=m.customer_id AND s.panel_id=m.source_panel_id
        AND s.pasarguard_user_id=m.source_user_id AND s.pasarguard_username=m.source_username AND s.panel_deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM effective_orders other WHERE other.panel_id=m.destination_panel_id AND other.pasarguard_user_id=m.destination_user_id AND other.id<>m.service_id)
      ON CONFLICT(service_id) DO UPDATE SET migration_id=excluded.migration_id,panel_id=excluded.panel_id,user_id=excluded.user_id,username=excluded.username,
       subscription_url=excluded.subscription_url,expires_at=excluded.expires_at,provision_config=excluded.provision_config
      WHERE active_service_resources.migration_id IS (SELECT source_migration_id FROM service_migrations WHERE id=?1)`)
     .bind(m.id,new Date(e.expire*1000).toISOString()),
    env.DB.prepare("UPDATE service_migrations SET state='cleanup_pending',error=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND state='activating' AND EXISTS(SELECT 1 FROM active_service_resources WHERE migration_id=?1)").bind(m.id),
    env.DB.prepare("INSERT INTO service_migration_events(migration_id,actor,action,data) SELECT id,?2,'active_switched','{}' FROM service_migrations WHERE id=?1 AND state='cleanup_pending'").bind(m.id,String(actor)),
   ]);m=await row(env,id);
  }
  return m;
 }finally{await releaseServiceLock(env.DB,m.service_id,owner);}
}
/** Separate destructive confirmation. No cron automatically deletes source users. */
export async function revokeSource(env:Env,id:string,actor:number):Promise<Migration>{
 authorize(env,actor);let m=await row(env,id);if(m.state!=='cleanup_pending')return m;
 const owner=`migration:${m.id}:${crypto.randomUUID()}`;if(!await acquireServiceLock(env.DB,m.service_id,owner))return m;
 try{
  m=await row(env,id);if(m.state!=='cleanup_pending')return m;
  const active=await env.DB.prepare('SELECT panel_id,user_id FROM active_service_resources WHERE service_id=?1').bind(m.service_id).first<{panel_id:string;user_id:string}>();
  if(!active || (active.panel_id===m.source_panel_id&&active.user_id===m.source_user_id))return state(env,m,actor,m.state,'source_is_current_active_resource');
  const c=await client(env,m.source_panel_id,m.source_user_id,m.source_origin);if(!c)return state(env,m,actor,m.state,'source_unavailable_revocation_unconfirmed');
  let found=await c.getUserById(m.source_user_id);
  if(found.ok&&found.data){
   await env.DB.batch([env.DB.prepare('UPDATE service_migrations SET revoke_attempts=revoke_attempts+1 WHERE id=?1').bind(m.id),
    env.DB.prepare("INSERT INTO service_migration_events(migration_id,actor,action,data) VALUES(?1,?2,'revocation_attempt','{}')").bind(m.id,String(actor))]);
   await c.deleteUserByUsername(m.source_username);
   found=await c.getUserById(m.source_user_id);
  }
  if(found.ok||found.kind!=='not_found')return state(env,m,actor,m.state,'source_revocation_unconfirmed');
  if(!await absenceVisibleToPrincipal(c))return state(env,m,actor,m.state,'source_absence_scope_unverified');
  await env.DB.batch([
   env.DB.prepare("UPDATE service_migrations SET state='completed',error=NULL,source_revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND state='cleanup_pending'").bind(m.id),
   env.DB.prepare("INSERT INTO service_migration_events(migration_id,actor,action,data) VALUES(?1,?2,'source_absence_confirmed','{}')").bind(m.id,String(actor)),
  ]);return row(env,id);
 }finally{await releaseServiceLock(env.DB,m.service_id,owner);}
}
export async function recoverServiceMigrations(env:Env):Promise<void>{
 const now=Date.now();await env.DB.batch([
  env.DB.prepare(`INSERT INTO service_migration_events(migration_id,actor,action,data) SELECT id,'system','review_expired','{}'
   FROM service_migrations WHERE state='review' AND review_expires_at<?1`).bind(now),
  env.DB.prepare("UPDATE service_migrations SET state='cancelled',error='review_expired' WHERE state='review' AND review_expires_at<?1").bind(now),
 ]);
 const authorized=[...new Set([env.ADMIN_CHAT_ID??'',...(env.PANEL_ADMIN_IDS??'').split(',')]
  .map(v=>Number(v.trim())).filter(v=>isPanelAdmin(env,v)).map(String))];
 if (!authorized.length) return;
 // Exclude revoked operators before LIMIT, so unauthorized stale work cannot
 // starve due migrations. Every execution still independently authorizes.
 const pending=await env.DB.prepare(`SELECT id,operator FROM service_migrations
  WHERE state IN ('creating','verified','activating') AND abort_requested=0 AND next_recovery_at<=?1
  AND operator IN (${authorized.map((_,i)=>'?'+(i+2)).join(',')})
  ORDER BY next_recovery_at,last_recovery_at,id LIMIT 2`).bind(now,...authorized).all<{id:string;operator:string}>();
 for(const m of pending.results) await advanceMigration(env,m.id,Number(m.operator),false,true);
}
