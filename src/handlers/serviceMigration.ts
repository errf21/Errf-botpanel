import {uiFor} from '../telegram/i18n.ts';
import type {Ui} from '../telegram/i18n.ts';
import type {Texts} from '../telegram/texts.ts';
import {deliverMessage} from '../telegram/delivery.ts';
/** No new HTTP surface or credential-entry form. Signed Telegram webhook + strict panel-admin allowlist. */
import type { UpdateContext,Env } from '../types.ts';
import { isPanelAdmin, nonce } from '../panels/security.ts';
import { getOrderById } from '../db/orders.ts';
import { isValidOrderId } from '../lib/validate.ts';
import { migrationStatus,proposeMigration,manualEntitlement,confirmMigration,cancelMigration,advanceMigration,revokeSource } from '../migrations/service.ts';
import type { Migration,Entitlement } from '../migrations/service.ts';
/** Plain-text technical values are bidi-isolated; callbacks/storage remain untouched. */
function value(v:unknown):string{return `\u2066${String(v)}\u2069`;}
function message(template:string,values:Record<string,unknown>):string{return template.replace(/\{(\w+)\}/g,(_,key)=>String(values[key]??''));}
const errorKeys = new Set(["migration_not_authorized", "migration_not_found", "service_busy", "service_owner_or_identity_invalid", "pending_service_operation", "destination_not_ready", "manual_entitlement_invalid", "cannot_cancel_remote_migration", "expired_or_incomplete_review", "entitlement_expired", "fresh_preview_expired_cancel_and_review_again", "fresh_preview_changed_cancel_and_review_again", "source_origin_unavailable", "use_explicit_UTC_timestamp", "customer_not_found", "service_invalid", "invalid_migration_action", "invalid_service_id", "expired_or_used_choice", "invalid_migration_id", "source_not_ready_for_revocation", "source_or_pending_operation_changed", "entitlement_expired_requires_review", "destination_configuration_unavailable", "destination_origin_changed", "destination_absent_explicit_retry_required", "destination_creation_unverified", "destination_identity_owned_elsewhere", "destination_staging_disable_unverified", "destination_url_unverified", "activation_identity_unverified", "activation_unverified", "active_url_unverified", "source_is_current_active_resource", "source_unavailable_revocation_unconfirmed", "source_revocation_unconfirmed", "source_absence_scope_unverified", "candidate_cleanup_unconfirmed", "candidate_identity_unverified", "candidate_absence_scope_unverified", "review_expired", "panel_groups_invalid", "destination_groups_unverified", "destination_groups_disabled", "destination_groups_mismatch"]);
function reason(ui:Ui,code:string):string{return errorKeys.has(code)?ui.t[('migrationError_'+code) as keyof Texts] as string:ui.t.migrationInterrupted;}
function stage(ui:Ui,state:Migration['state']):string{const keys={review:'migrationStateReview',creating:'migrationStateCreating',verified:'migrationStateVerified',activating:'migrationStateActivating',cleanup_pending:'migrationStateCleanupPending',completed:'migrationStateCompleted',cancelled:'migrationStateCancelled'} as const;return ui.t[keys[state]];}
function authorized(ctx:UpdateContext):boolean{return ctx.chatId===ctx.actor.id&&isPanelAdmin(ctx.env,ctx.actor.id);}
async function deny(ctx:UpdateContext):Promise<void>{await ctx.api.sendMessage(ctx.chatId,ctx.ui.t.migrationDenied);}
async function card(ctx:UpdateContext,m:Migration):Promise<void>{
 const {t,f}=ctx.ui,e=m.entitlement?JSON.parse(m.entitlement) as Entitlement:null;
 const customer=await ctx.db.prepare('SELECT telegram_user_id,telegram_username FROM customers WHERE id=?1').bind(m.customer_id).first<{telegram_user_id:string;telegram_username:string|null}>();
 const names=await ctx.db.prepare('SELECT id,name FROM panels WHERE id IN (?1,?2)').bind(m.source_panel_id,m.destination_panel_id).all<{id:string;name:string}>();
 const name=(id:string)=>names.results.find(p=>p.id===id)?.name??id;
 const active=await getOrderById(ctx.db,m.service_id);
 const lines=[message(t.migrationHeader,{id:value(m.id)}),
  message(t.migrationCustomerLine,{telegram:value(customer?.telegram_user_id??t.migrationUnknown),username:customer?.telegram_username?value('@'+customer.telegram_username):'',customer:value(f.digits(m.customer_id)),service:value(m.service_id)}),
  message(t.migrationSourceLine,{name:value(name(m.source_panel_id)),id:value(m.source_panel_id)}),
  message(t.migrationDestinationLine,{name:value(name(m.destination_panel_id)),id:value(m.destination_panel_id)}),
  message(t.migrationGroupsLine,{groups:value(JSON.parse(m.destination_config).groupIds?.join(', ')??t.migrationUnknown)}),t.migrationModelWarning,
  message(t.migrationStageLine,{stage:stage(ctx.ui,m.state)})+(m.abort_requested?' — '+t.migrationAbortRequested:''),
  ...(m.error?[message(t.migrationBlockedLine,{reason:reason(ctx.ui,m.error)})]:[]),
  message(t.migrationActiveLine,{panel:value(active?.panel_id??t.migrationUnknown),user:value(active?.pasarguard_user_id??t.migrationUnknown)}),
  m.source_revoked_at?message(t.migrationRevokedLine,{date:value(f.dateTime(m.source_revoked_at))}):t.migrationNotRevoked];
 if(e)lines.push(message(t.migrationEvidenceLine,{source:e.source==='fresh'?t.migrationFresh:e.source==='saved'?t.migrationSaved:t.migrationManual,date:value(f.dateTime(new Date(e.observedAt).toISOString()))}),
  message(t.migrationRemainingLine,{bytes:value(f.digits(e.remaining)),expiry:value(new Date(e.expire*1000).toISOString()),devices:value(f.digits(e.hwid))}),
  message(t.migrationQuotaLine,{quota:value(e.quota===null?t.migrationUnknown:f.digits(e.quota)),used:value(e.used===null?t.migrationUnknown:f.digits(e.used))}),t.migrationSnapshotWarning);
 else lines.push(t.migrationNoEntitlement);
 const buttons:{text:string;callback_data:string}[][]=[];
 if(m.state==='review'){
  if(e)buttons.push([{text:e.source==='fresh'?t.migrationConfirmFresh:e.source==='saved'?t.migrationConfirmSaved:t.migrationConfirmManual,callback_data:`sm:c:${m.confirmation_token}`}]);
  buttons.push([{text:t.migrationCancelDraft,callback_data:`sm:n:${m.id}`}]);
  lines.push(message(t.migrationManualHelp,{command:value(message(t.migrationManualCommand,{id:m.id}))}));
 }
 if(['creating','verified','activating'].includes(m.state))buttons.push([{text:t.migrationAbortReview,callback_data:`sm:n:${m.id}`}]);
 if(['creating','verified','activating'].includes(m.state))buttons.push([{text:m.abort_requested?t.migrationRetryAbort:m.state==='verified'?t.migrationContinue:t.migrationRetry,callback_data:`sm:r:${m.id}`}]);
 if(m.state==='cleanup_pending')buttons.push([{text:t.migrationReviewRevoke,callback_data:`sm:x:${m.id}`}]);
 buttons.push([{text:t.migrationRefresh,callback_data:`sm:v:${m.id}`}]);
 await ctx.api.sendMessage(ctx.chatId,lines.join('\n'),{inline_keyboard:buttons});
}
async function notifyCustomer(ctx:Pick<UpdateContext,'env'|'db'|'api'>,m:Migration):Promise<void>{
 if(!['cleanup_pending','completed'].includes(m.state))return;
 const owner=`migration:${m.id}:${crypto.randomUUID()}`;
 const {acquireServiceLock,releaseServiceLock}=await import('../panels/registry.ts');
 if(!await acquireServiceLock(ctx.db,m.service_id,owner))return;
 try{
  const target=await ctx.db.prepare(`SELECT c.telegram_user_id,c.language,r.subscription_url FROM active_service_resources r
   JOIN orders o ON o.id=r.service_id JOIN customers c ON c.id=o.customer_id JOIN service_migrations m ON m.id=r.migration_id
   WHERE r.migration_id=?1 AND m.customer_notified_at IS NULL`).bind(m.id).first<{telegram_user_id:string;language:string|null;subscription_url:string}>();
  if(!target)return;
  const delivery=await deliverMessage(ctx.api,Number(target.telegram_user_id),message(uiFor(target.language).t.migrationCustomerNotice,{url:value(target.subscription_url)}));
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
  .bind(token,String(ctx.actor.id),s.id,s.customer_id,p.id,Date.now()+300000).run();buttons.push([{text:message(ctx.ui.t.migrationDestinationButton,{name:value(p.name)}),callback_data:`sm:d:${token}`}]);}
 await ctx.api.sendMessage(ctx.chatId,message(ctx.ui.t.migrationDestinationHelp,{customer:value(ctx.ui.f.digits(s.customer_id)),service:value(s.id),panel:value(s.panel_id),command:value(`/migrate panels ${s.id} ${page+1}`)})+(panels.results.length?'':'\n'+ctx.ui.t.migrationNoDestinations),{inline_keyboard:buttons});
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
   await ctx.api.sendMessage(ctx.chatId,message(ctx.ui.t.migrationSelectService,{id:value(args[0]),command:value(ctx.ui.t.migrationPanelsCommand)})+(services.results.length?'':'\n'+ctx.ui.t.migrationNoServices),{inline_keyboard:services.results.map(s=>[{text:message(ctx.ui.t.migrationServiceButton,{service:value(s.id),panel:value(s.panel_id)}),callback_data:`sm:s:${s.id}`}])});return;
  }
  const recent=await ctx.db.prepare('SELECT id,state FROM service_migrations ORDER BY updated_at DESC LIMIT 10').all<{id:string;state:string}>();
  await ctx.api.sendMessage(ctx.chatId,message(ctx.ui.t.migrationUsage,{commands:value(ctx.ui.t.migrationUsageCommands)}),{inline_keyboard:recent.results.map(m=>[{text:`${value(m.id)} — ${stage(ctx.ui,m.state as Migration['state'])}`,callback_data:`sm:v:${m.id}`}])});
 }catch(error){await ctx.api.sendMessage(ctx.chatId,safeFailure(ctx.ui,error));}
}
function safeFailure(ui:Ui,error:unknown):string{
 const code=error instanceof Error?error.message:'';
 return errorKeys.has(code)?message(ui.t.migrationStopped,{reason:reason(ui,code)}):ui.t.migrationInterrupted;
}
export async function migrationCallback(ctx:UpdateContext,data:string,callbackId:string):Promise<void>{
 if(!authorized(ctx)){await ctx.api.answerCallbackQuery(callbackId,ctx.ui.t.migrationDenied,true);return;}
 await ctx.api.answerCallbackQuery(callbackId,ctx.ui.t.migrationChecking);
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
   await ctx.api.sendMessage(ctx.chatId,message(ctx.ui.t.migrationRevokePrompt,{user:value(m.source_user_id),panel:value(m.source_panel_id)}),{inline_keyboard:[[{text:ctx.ui.t.migrationConfirmRevoke,callback_data:`sm:k:${token}`}]]});return;
  }
  if(action==='n'){
   if(m.state==='review')m=await cancelMigration(ctx.env,ctx.actor.id,id);
   else {
    if(!['creating','verified','activating'].includes(m.state))throw Error('cannot_cancel_remote_migration');
    const token=nonce();await ctx.db.prepare("INSERT INTO migration_admin_choices(nonce,actor,action,service_id,customer_id,migration_id,expires_at) VALUES(?1,?2,'abort',?3,?4,?5,?6)")
      .bind(token,String(ctx.actor.id),m.service_id,m.customer_id,m.id,Date.now()+300000).run();
    await ctx.api.sendMessage(ctx.chatId,ctx.ui.t.migrationAbortPrompt,{inline_keyboard:[[{text:ctx.ui.t.migrationConfirmAbort,callback_data:`sm:a:${token}`}]]});return;
   }
  }
  if(action==='r')m=m.abort_requested?await cancelMigration(ctx.env,ctx.actor.id,id):await advanceMigration(ctx.env,id,ctx.actor.id,true);
  await notifyCustomer(ctx,m).catch(()=>{});await card(ctx,m);
 }catch(error){await ctx.api.sendMessage(ctx.chatId,safeFailure(ctx.ui,error));}
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
