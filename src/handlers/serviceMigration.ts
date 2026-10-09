import {deliverMessage} from '../telegram/delivery.ts';
/** No new HTTP surface or credential-entry form. Signed Telegram webhook + strict panel-admin allowlist. */
import type { UpdateContext,Env } from '../types.ts';
import { isPanelAdmin, nonce } from '../panels/security.ts';
import { getOrderById } from '../db/orders.ts';
import { isValidOrderId } from '../lib/validate.ts';
import { migrationStatus,proposeMigration,manualEntitlement,confirmMigration,cancelMigration,advanceMigration,revokeSource } from '../migrations/service.ts';
import type { Migration,Entitlement } from '../migrations/service.ts';
function authorized(ctx:UpdateContext):boolean{return ctx.chatId===ctx.actor.id&&isPanelAdmin(ctx.env,ctx.actor.id);}
async function deny(ctx:UpdateContext):Promise<void>{await ctx.api.sendMessage(ctx.chatId,'Migration requires an explicitly authorized administrator in private chat.');}
async function card(ctx:UpdateContext,m:Migration):Promise<void>{
 const e=m.entitlement?JSON.parse(m.entitlement) as Entitlement:null;
 const customer=await ctx.db.prepare('SELECT telegram_user_id,telegram_username FROM customers WHERE id=?1').bind(m.customer_id).first<{telegram_user_id:string;telegram_username:string|null}>();
 const names=await ctx.db.prepare('SELECT id,name FROM panels WHERE id IN (?1,?2)').bind(m.source_panel_id,m.destination_panel_id).all<{id:string;name:string}>();
 const name=(id:string)=>names.results.find(p=>p.id===id)?.name??id;
 const active=await getOrderById(ctx.db,m.service_id);
 const lines=[`Migration ${m.id}`,`Customer: Telegram ${customer?.telegram_user_id??'unknown'} ${customer?.telegram_username?'@'+customer.telegram_username:''} (internal ${m.customer_id}); service: ${m.service_id}`,
  `Source: ${name(m.source_panel_id)} (${m.source_panel_id})`, `Destination: ${name(m.destination_panel_id)} (${m.destination_panel_id})`,
  `Destination groups: ${JSON.parse(m.destination_config).groupIds?.join(',')??'unavailable'}. Fixed finite quota/expiry/device model; custom proxy, reset and next-plan settings are not cloned.`,
  `Stage: ${m.state}${m.abort_requested?' — ABORT REQUESTED':''}${m.error?`; blocked: ${m.error}`:''}`,`Active in bot: ${active?.panel_id??'unknown'} / ${active?.pasarguard_user_id??'unknown'}`,
  `Source revocation: ${m.source_revoked_at?'API absence confirmed at '+m.source_revoked_at:'NOT CONFIRMED — old subscription may still be usable'}`];
 if(e)lines.push(`Entitlement: ${e.source==='fresh'?'verified fresh':e.source==='saved'?'STALE saved':'MANUAL administrator values'}; observed/entered ${new Date(e.observedAt).toISOString()}`,
  `Remaining: ${e.remaining} bytes; absolute expiry: ${new Date(e.expire*1000).toISOString()}; devices: ${e.hwid}`,
  `Quota/usage evidence: ${e.quota??'unknown'} / ${e.used??'unknown'} bytes`,
  'Migration uses this timestamped snapshot. Traffic consumed afterward is not atomically transferable across panels. Review any entitlement uncertainty before confirming.');
 else lines.push('No complete trustworthy finite entitlement. STOP until administrator review. Use explicit manual remaining values only if justified.');
 const buttons:{text:string;callback_data:string}[][]=[];
 if(m.state==='review'){
  if(e)buttons.push([{text:`Confirm ${e.source==='fresh'?'verified':'STALE / MANUAL'} entitlement and migrate`,callback_data:`sm:c:${m.confirmation_token}`}]);
  buttons.push([{text:'Cancel draft (no remote changes)',callback_data:`sm:n:${m.id}`}]);
  lines.push(`Manual confirmation explicitly accepts fixed remaining values, not automatic cloning of unsupported source features.
Manual review: /migrate manual ${m.id} <remaining_bytes> <YYYY-MM-DDTHH:mm:ssZ> <devices>`);
 }
 if(['creating','verified','activating'].includes(m.state))buttons.push([{text:'Review abort; preserve original source',callback_data:`sm:n:${m.id}`}]);
 if(['creating','verified','activating'].includes(m.state))buttons.push([{text:m.abort_requested?'Retry abort cleanup':m.state==='verified'?'Continue verified activation':'Retry — reconcile first',callback_data:`sm:r:${m.id}`}]);
 if(m.state==='cleanup_pending')buttons.push([{text:'Review source revocation',callback_data:`sm:x:${m.id}`}]);
 buttons.push([{text:'Refresh progress',callback_data:`sm:v:${m.id}`}]);
 await ctx.api.sendMessage(ctx.chatId,lines.join('\n'),{inline_keyboard:buttons});
}
async function notifyCustomer(ctx:Pick<UpdateContext,'env'|'db'|'api'>,m:Migration):Promise<void>{
 if(!['cleanup_pending','completed'].includes(m.state))return;
 const owner=`migration:${m.id}:${crypto.randomUUID()}`;
 const {acquireServiceLock,releaseServiceLock}=await import('../panels/registry.ts');
 if(!await acquireServiceLock(ctx.db,m.service_id,owner))return;
 try{
  const target=await ctx.db.prepare(`SELECT c.telegram_user_id,r.subscription_url FROM active_service_resources r
   JOIN orders o ON o.id=r.service_id JOIN customers c ON c.id=o.customer_id JOIN service_migrations m ON m.id=r.migration_id
   WHERE r.migration_id=?1 AND m.customer_notified_at IS NULL`).bind(m.id).first<{telegram_user_id:string;subscription_url:string}>();
  if(!target)return;
  const delivery=await deliverMessage(ctx.api,Number(target.telegram_user_id),`Your service has been moved by an administrator. Use the new subscription URL:\n${target.subscription_url}`);
  if(delivery.kind!=='sent')return;
  await ctx.db.prepare("UPDATE service_migrations SET customer_notified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1").bind(m.id).run();
 }finally{await releaseServiceLock(ctx.db,m.service_id,owner);}
}
async function destinations(ctx:UpdateContext,service:string,page=0):Promise<void>{
 const s=await getOrderById(ctx.db,service);if(!s||s.kind!=='purchase'||s.state!=='completed'||s.panel_deleted_at)throw Error('service_invalid');
 const panels=await ctx.db.prepare("SELECT id,name FROM panels WHERE enabled_new=1 AND id<>?1 AND (id='legacy' OR last_test='ok') ORDER BY name,id LIMIT 5 OFFSET ?2")
  .bind(s.panel_id??'',page*5).all<{id:string;name:string}>();
 await ctx.db.prepare('DELETE FROM migration_admin_choices WHERE expires_at<?1').bind(Date.now()).run();
 const buttons=[];
 for(const p of panels.results){const token=nonce();await ctx.db.prepare("INSERT INTO migration_admin_choices(nonce,actor,action,service_id,customer_id,panel_id,expires_at) VALUES(?1,?2,'destination',?3,?4,?5,?6)")
  .bind(token,String(ctx.actor.id),s.id,s.customer_id,p.id,Date.now()+300000).run();buttons.push([{text:`Migrate to ${p.name}`,callback_data:`sm:d:${token}`}]);}
 await ctx.api.sendMessage(ctx.chatId,`Customer ${s.customer_id}, service ${s.id}\nCurrent panel ${s.panel_id}. Choose enabled destination; no remote changes yet.\nMore panels: /migrate panels ${s.id} ${page+1}`,{inline_keyboard:buttons});
}
export async function migrationCommand(ctx:UpdateContext,args:string[]):Promise<void>{
 if(!authorized(ctx)){await deny(ctx);return;}
 try{
  if(args[0]==='manual'&&args.length===5&&isValidOrderId(args[1]!)){
   // Explicit UTC timestamp; no timezone guessing or rounding of byte entitlement.
   if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(args[3]!) || !Number.isFinite(Date.parse(args[3]!)) || new Date(args[3]!).toISOString().replace('.000Z','Z')!==args[3])throw Error('use_explicit_UTC_timestamp');
   await card(ctx,await manualEntitlement(ctx.env,ctx.actor.id,args[1]!,Number(args[2]),Date.parse(args[3]!)/1000,Number(args[4])));return;
  }
  if(args[0]==='status'&&isValidOrderId(args[1])){const m=await migrationStatus(ctx.env,args[1]!,ctx.actor.id);await notifyCustomer(ctx,m).catch(()=>{});await card(ctx,m);return;}
  if(args[0]==='panels'&&isValidOrderId(args[1])&&/^\d{1,3}$/.test(args[2]??'0')){await destinations(ctx,args[1]!,Number(args[2]??0));return;}
  if(args.length===1&&/^\d{1,16}$/.test(args[0]!)){
   const c=await ctx.db.prepare('SELECT id FROM customers WHERE telegram_user_id=?1').bind(args[0]!).first<{id:number}>();if(!c)throw Error('customer_not_found');
   const services=await ctx.db.prepare("SELECT id,panel_id FROM effective_orders WHERE customer_id=?1 AND kind='purchase' AND state='completed' AND panel_deleted_at IS NULL ORDER BY created_at DESC LIMIT 10").bind(c.id).all<{id:string;panel_id:string}>();
   await ctx.api.sendMessage(ctx.chatId,`Customer ${args[0]}: select service (latest 10). /migrate panels <service-id> also accepts a known historical service ID.`,{inline_keyboard:services.results.map(s=>[{text:`${s.id} — ${s.panel_id}`,callback_data:`sm:s:${s.id}`}])});return;
  }
  const recent=await ctx.db.prepare('SELECT id,state FROM service_migrations ORDER BY updated_at DESC LIMIT 10').all<{id:string;state:string}>();
  await ctx.api.sendMessage(ctx.chatId,'Usage: /migrate <customer Telegram ID>\n/migrate status <migration ID>\n/migrate panels <service ID> [page]\nNo charges or new orders are created.',{inline_keyboard:recent.results.map(m=>[{text:`${m.id} — ${m.state}`,callback_data:`sm:v:${m.id}`}])});
 }catch(error){await ctx.api.sendMessage(ctx.chatId,safeFailure(error));}
}
function safeFailure(error:unknown):string{
 const msg=error instanceof Error?error.message:'';
 const codes=new Set(['migration_not_authorized','migration_not_found','service_busy','service_owner_or_identity_invalid','pending_service_operation',
  'destination_not_ready','manual_entitlement_invalid','cannot_cancel_remote_migration','expired_or_incomplete_review','entitlement_expired',
  'fresh_preview_expired_cancel_and_review_again','fresh_preview_changed_cancel_and_review_again','source_origin_unavailable','use_explicit_UTC_timestamp','customer_not_found','service_invalid','invalid_migration_action',
  'invalid_service_id','expired_or_used_choice','invalid_migration_id','source_not_ready_for_revocation']);
 return codes.has(msg)?`Migration stopped: ${msg}. Original financial/history records are unchanged.`:'Migration stopped or interrupted. Open /migrate to inspect durable progress; retry reconciles first. No raw error or credentials are displayed.';
}
export async function migrationCallback(ctx:UpdateContext,data:string,callbackId:string):Promise<void>{
 if(!authorized(ctx)){await ctx.api.answerCallbackQuery(callbackId,'Not authorized.',true);return;}
 await ctx.api.answerCallbackQuery(callbackId,'Checking migration…');
 try{
  const match=/^sm:([sdcnvrxka]):([0-9A-HJKMNP-TV-Z]{28}|[a-f0-9]{32})$/.exec(data);if(!match)throw Error('invalid_migration_action');
  const action=match[1]!,id=match[2]!;
  if(action==='s'){if(!isValidOrderId(id))throw Error('invalid_service_id');await destinations(ctx,id);return;}
  if(action==='d'||action==='k'||action==='a'){
   const token=await ctx.db.prepare('DELETE FROM migration_admin_choices WHERE nonce=?1 AND actor=?2 AND action=?3 AND expires_at>?4 RETURNING *')
    .bind(id,String(ctx.actor.id),action==='d'?'destination':action==='k'?'revoke':'abort',Date.now()).first<{service_id:string;customer_id:number;panel_id:string;migration_id:string}>();
   if(!token)throw Error('expired_or_used_choice');
   const m=action==='d'?await proposeMigration(ctx.env,ctx.actor.id,token.service_id,token.customer_id,token.panel_id):action==='k'?await revokeSource(ctx.env,token.migration_id,ctx.actor.id):await cancelMigration(ctx.env,ctx.actor.id,token.migration_id);
   await notifyCustomer(ctx,m).catch(()=>{});await card(ctx,m);return;
  }
  if(action==='c'){const m=await confirmMigration(ctx.env,ctx.actor.id,id);await notifyCustomer(ctx,m).catch(()=>{});await card(ctx,m);return;}
  if(!isValidOrderId(id))throw Error('invalid_migration_id');
  let m=await migrationStatus(ctx.env,id,ctx.actor.id);
  if(action==='x'){
   if(m.state!=='cleanup_pending')throw Error('source_not_ready_for_revocation');
   const token=nonce();await ctx.db.prepare("INSERT INTO migration_admin_choices(nonce,actor,action,service_id,customer_id,migration_id,expires_at) VALUES(?1,?2,'revoke',?3,?4,?5,?6)")
    .bind(token,String(ctx.actor.id),m.service_id,m.customer_id,m.id,Date.now()+300000).run();
   await ctx.api.sendMessage(ctx.chatId,`Destination is active. Confirm deletion of ONLY source user ID ${m.source_user_id} on panel ${m.source_panel_id}? A failed/uncertain operation will remain unconfirmed.`,{inline_keyboard:[[{text:'Confirm source revocation',callback_data:`sm:k:${token}`}]]});return;
  }
  if(action==='n'){
   if(m.state==='review')m=await cancelMigration(ctx.env,ctx.actor.id,id);
   else {
    if(!['creating','verified','activating'].includes(m.state))throw Error('cannot_cancel_remote_migration');
    const token=nonce();await ctx.db.prepare("INSERT INTO migration_admin_choices(nonce,actor,action,service_id,customer_id,migration_id,expires_at) VALUES(?1,?2,'abort',?3,?4,?5,?6)")
      .bind(token,String(ctx.actor.id),m.service_id,m.customer_id,m.id,Date.now()+300000).run();
    await ctx.api.sendMessage(ctx.chatId,'Confirm abort BEFORE cutover? Only the unpublished destination will be reconciled/deleted. Original service and all financial history remain unchanged. Unknown cleanup stays pending; recovery will not activate an aborting migration.',{inline_keyboard:[[{text:'Confirm safe abort',callback_data:`sm:a:${token}`}]]});return;
   }
  }
  if(action==='r')m=m.abort_requested?await cancelMigration(ctx.env,ctx.actor.id,id):await advanceMigration(ctx.env,id,ctx.actor.id,true);
  await notifyCustomer(ctx,m).catch(()=>{});await card(ctx,m);
 }catch(error){await ctx.api.sendMessage(ctx.chatId,safeFailure(error));}
}

/** At-least-once customer handoff; only the CURRENT active generation is sent.
 * A crash after Telegram accepted but before the stamp can duplicate a notice,
 * never a service or charge. Future cron runs retry failed deliveries. */
export async function deliverMigrationNotices(env:Env):Promise<void>{
 const {TelegramApi}=await import('../telegram/api.ts');
 const pending=await env.DB.prepare(`SELECT m.* FROM service_migrations m JOIN active_service_resources r ON r.migration_id=m.id
  WHERE m.state IN ('cleanup_pending','completed') AND m.customer_notified_at IS NULL ORDER BY m.updated_at LIMIT 2`).all<Migration>();
 for(const m of pending.results){try{await notifyCustomer({env,db:env.DB,api:new TelegramApi(env.TELEGRAM_BOT_TOKEN)},m);}catch{console.error('service_migration_notice_failed');}}
}
