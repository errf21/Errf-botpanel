/** Durable automatic broadcasts. Leases prevent concurrent ACTIVE ownership;
 * Telegram has no idempotency key: crash-after-acceptance remains at-least-once. */
import {newOrderId} from '../lib/security.ts';
import type {TelegramApiLike} from '../types.ts';
import {deliverMessage} from '../telegram/delivery.ts';
import type {MessageDelivery} from '../telegram/delivery.ts';
export const ANNOUNCE_CHUNK=20,ANNOUNCE_BODY_MAX=4000,ANNOUNCE_LIST_LIMIT=100;
export const ANNOUNCE_LEASE_MS=180000,ANNOUNCE_SEED_CHUNK=200,ANNOUNCE_PACING_MS=80;
export interface AnnouncementRow {id:string;body:string;created_by:string;state:string;total_estimate:number;sent_count:number;created_at:string;updated_at:string;
 started_at:string|null;audience_highwater:number|null;audience_cursor:number;audience_seeded:number;recipient_count:number;failed_count:number;active_count:number;}
export interface AnnounceAggregate {total:number;sent:number;failed:number;pending:number;stuck:number;retryable:number;delayed:number;seeding:boolean;}
export interface AnnouncementRuntime {now?:()=>number;sleep?:(ms:number)=>Promise<void>;deadline?:number;}
const clock=(runtime:AnnouncementRuntime)=>runtime.now??Date.now;
const nap=(runtime:AnnouncementRuntime)=>runtime.sleep??((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
export async function getAnnouncement(db:D1Database,id:string):Promise<AnnouncementRow|null>{return db.prepare('SELECT * FROM announcements WHERE id=?1').bind(id).first<AnnouncementRow>();}
export async function countPotentialRecipients(db:D1Database):Promise<number>{return (await db.prepare('SELECT COUNT(*) n FROM customers').first<{n:number}>())?.n??0;}
export async function createAnnouncement(db:D1Database,opts:{body:string;createdBy:string;totalEstimate:number}):Promise<AnnouncementRow|null>{
 const body=opts.body.trim();if(!body||body.length>ANNOUNCE_BODY_MAX)return null;const id=newOrderId();
 await db.prepare("INSERT INTO announcements(id,body,created_by,state,total_estimate) VALUES(?1,?2,?3,'sending',?4)").bind(id,body,opts.createdBy,opts.totalEstimate).run();return getAnnouncement(db,id);
}
/** Confirmation freezes the existing all-registered-customer audience. Drafts
 * are never selected by cron. Existing delivery rows are never discarded. */
export async function startAnnouncement(db:D1Database,id:string):Promise<void>{
 await db.prepare(`UPDATE announcements SET started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  audience_highwater=COALESCE((SELECT MAX(id) FROM customers),0),total_estimate=MAX(recipient_count,(SELECT COUNT(*) FROM customers))
  WHERE id=?1 AND state='sending' AND started_at IS NULL`).bind(id).run();
 // Version-upgraded jobs already have started_at but not a captured boundary.
 await db.prepare(`UPDATE announcements SET audience_highwater=COALESCE((SELECT MAX(id) FROM customers),0),
  total_estimate=MAX(recipient_count,(SELECT COUNT(*) FROM customers))
  WHERE id=?1 AND state='sending' AND started_at IS NOT NULL AND audience_highwater IS NULL`).bind(id).run();
}
/** Bounded keyset seed, no audience-wide rescan on every delivery chunk. */
export async function seedAnnouncementDeliveries(db:D1Database,id:string):Promise<number>{
 const job=await getAnnouncement(db,id);if(!job?.started_at||job.state!=='sending'||job.audience_seeded||job.audience_highwater===null)return 0;
 const last=await db.prepare(`SELECT MAX(id) last FROM (SELECT id FROM customers WHERE id>?1 AND id<=?2 ORDER BY id LIMIT ?3)`)
  .bind(job.audience_cursor,job.audience_highwater,ANNOUNCE_SEED_CHUNK).first<{last:number|null}>();
 const end=last?.last??job.audience_highwater;
 await db.batch([
  db.prepare(`INSERT INTO announcement_deliveries(announcement_id,customer_id,status)
   SELECT ?1,c.id,'pending' FROM customers c WHERE c.id>?2 AND c.id<=?3
    AND EXISTS(SELECT 1 FROM announcements WHERE id=?1 AND state='sending' AND audience_cursor=?2)
   ON CONFLICT(announcement_id,customer_id) DO NOTHING`).bind(id,job.audience_cursor,end),
  db.prepare(`UPDATE announcements SET audience_cursor=?3,audience_seeded=CASE WHEN NOT EXISTS(
   SELECT 1 FROM customers WHERE id>?3 AND id<=audience_highwater) THEN 1 ELSE 0 END,
   updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND audience_cursor=?2 AND state='sending'`)
   .bind(id,job.audience_cursor,end),
 ]);return end-job.audience_cursor; // Progress cursor, not a billed/inserted row count.
}
export async function announcementAggregate(db:D1Database,id:string):Promise<AnnounceAggregate>{
 const row=await db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM announcement_deliveries d WHERE d.announcement_id=a.id AND d.status='pending' AND d.attempts>0) retryable,
  (SELECT COUNT(*) FROM announcement_deliveries d WHERE d.announcement_id=a.id AND d.status='pending' AND d.next_attempt_at>?2) delayed
  FROM announcements a WHERE a.id=?1`).bind(id,Date.now()).first<AnnouncementRow&{retryable:number;delayed:number}>();
 return aggregateRow(row);
}
function aggregateRow(row:(AnnouncementRow&{retryable:number;delayed:number})|null):AnnounceAggregate {
 const total=row?Math.max(row.recipient_count,row.started_at?row.total_estimate:0):0;
 return {total,sent:row?.sent_count??0,failed:row?.failed_count??0,pending:total-(row?.sent_count??0)-(row?.failed_count??0)-(row?.active_count??0),stuck:row?.active_count??0,retryable:row?.retryable??0,delayed:row?.delayed??0,seeding:!!row?.started_at&&!row.audience_seeded};
}
/** One bounded status query, not an N+1 round trip per recent job. */
export async function listRecentAnnouncementProgress(db:D1Database,limit:number):Promise<(AnnouncementRow&{progress:AnnounceAggregate})[]> {
 const rows=await db.prepare(`SELECT a.*,
  (SELECT COUNT(*) FROM announcement_deliveries d WHERE d.announcement_id=a.id AND d.status='pending' AND d.attempts>0) retryable,
  (SELECT COUNT(*) FROM announcement_deliveries d WHERE d.announcement_id=a.id AND d.status='pending' AND d.next_attempt_at>?2) delayed
  FROM announcements a ORDER BY a.created_at DESC LIMIT ?1`).bind(limit,Date.now()).all<AnnouncementRow&{retryable:number;delayed:number}>();
 return rows.results.map(row=>({...row,progress:aggregateRow(row)}));
}

export async function sweepStuckDeliveries(db:D1Database,id:string,now=Date.now()):Promise<number>{
 const result=await db.prepare(`UPDATE announcement_deliveries SET status=CASE WHEN failure_attempts+(attempt_started_at IS NOT NULL)>=3 THEN 'failed' ELSE 'pending' END,
  failure_attempts=failure_attempts+(attempt_started_at IS NOT NULL),attempt_started_at=NULL,
  claim_owner=NULL,lease_until=NULL,next_attempt_at=MAX(next_attempt_at,?2),last_error='delivery_outcome_unknown',updated_at=?2
  WHERE announcement_id=?1 AND status='sending' AND COALESCE(lease_until,0)<=?2`)
  .bind(id,now).run();return result.meta?.changes??0;
}
async function acquireDispatch(db:D1Database,owner:string,now:number):Promise<boolean>{
 const result=await db.prepare(`UPDATE announcement_dispatch SET owner=?1,lease_until=?2 WHERE singleton=1 AND lease_until<=?3 AND pause_until<=?3`)
  .bind(owner,now+ANNOUNCE_LEASE_MS,now).run();return result.meta?.changes===1;
}
export async function bookAnnouncementDelivery(db:D1Database,opts:{announcementId:string;customerId:number;owner:string;delivery:MessageDelivery;now:number}):Promise<void>{
 const d=opts.delivery,failed=d.kind==='permanent',retry=d.kind==='unknown'||d.kind==='retryable';
 const delay=d.kind==='rate_limited'?d.retryAfter*1000:d.kind==='configuration'?600000:retry?60000:0;
 await db.prepare(`UPDATE announcement_deliveries SET status=CASE WHEN ?4='sent' THEN 'sent' WHEN ?5=1 OR (failure_attempts+?6>=3) THEN 'failed' ELSE 'pending' END,
  failure_attempts=failure_attempts+?6,last_error=?7,telegram_message_id=?8,next_attempt_at=?9,claim_owner=NULL,lease_until=NULL,updated_at=?10
  WHERE announcement_id=?1 AND customer_id=?2 AND status='sending' AND claim_owner=?3 AND lease_until>?10`)
  .bind(opts.announcementId,opts.customerId,opts.owner,d.kind,failed?1:0,retry?1:0,d.kind==='sent'?null:d.kind==='rate_limited'?'telegram_rate_limited':d.code,
   d.kind==='sent'?d.messageId:null,opts.now+delay,opts.now).run();
}
/** One bounded automatic unit. A global bot-dispatch lease also bounds
 * aggregate broadcast pacing across jobs/workers; every recipient has its own
 * owner/lease and is booked only by that owner. No active lease is reclaimed. */
export async function runAnnouncementChunk(db:D1Database,api:TelegramApiLike,body:string,id:string,limit:number,runtime:AnnouncementRuntime={}):Promise<number>{
 const now=clock(runtime),sleep=nap(runtime),deadline=runtime.deadline??now()+18000,owner=crypto.randomUUID();
 if(!await acquireDispatch(db,owner,now()))return 0;
 let processed=0;
 try{
  const job=await getAnnouncement(db,id);if(!job?.started_at||job.state!=='sending'||body!==job.body)return 0;
  if(job.audience_highwater===null) await startAnnouncement(db,id);
  await sweepStuckDeliveries(db,id,now());await seedAnnouncementDeliveries(db,id);
  await db.prepare(`UPDATE announcement_deliveries SET status='sending',claim_owner=?2,lease_until=?3,updated_at=?4,attempt_started_at=NULL
   WHERE announcement_id=?1 AND status='pending' AND next_attempt_at<=?4 AND customer_id IN (
    SELECT customer_id FROM announcement_deliveries WHERE announcement_id=?1 AND status='pending' AND next_attempt_at<=?4 ORDER BY customer_id LIMIT ?5)`)
   .bind(id,owner,now()+ANNOUNCE_LEASE_MS,now(),Math.min(ANNOUNCE_CHUNK,Math.max(0,limit))).run();
  const rows=await db.prepare(`SELECT d.customer_id customerId,c.telegram_user_id telegramUserId FROM announcement_deliveries d JOIN customers c ON c.id=d.customer_id
   WHERE d.announcement_id=?1 AND d.status='sending' AND d.claim_owner=?2 ORDER BY d.customer_id`)
   .bind(id,owner).all<{customerId:number;telegramUserId:string}>();
  for(const row of rows.results){
   if(now()+8000>=deadline)break;
   const lease=await db.prepare(`UPDATE announcement_dispatch SET lease_until=?2 WHERE singleton=1 AND owner=?1 AND lease_until>?3 AND pause_until<=?3`)
    .bind(owner,now()+ANNOUNCE_LEASE_MS,now()).run();if(lease.meta?.changes!==1)break;
   const pacing=await db.prepare('SELECT next_send_at FROM announcement_dispatch WHERE singleton=1').first<{next_send_at:number}>();
   const wait=Math.max(0,(pacing?.next_send_at??0)-now());if(now()+wait+8000>=deadline)break;if(wait)await sleep(wait);
   const claim=await db.prepare(`UPDATE announcement_deliveries SET attempts=attempts+1,lease_until=?4,attempt_started_at=?5 WHERE announcement_id=?1 AND customer_id=?2 AND claim_owner=?3 AND status='sending' AND lease_until>?5`)
    .bind(id,row.customerId,owner,now()+ANNOUNCE_LEASE_MS,now()).run();if(claim.meta?.changes!==1)continue;
   const chat=Number(row.telegramUserId);
   const result:MessageDelivery=Number.isSafeInteger(chat)&&chat>0?await deliverMessage(api,chat,body):{kind:'permanent',code:'invalid_recipient'};
   await bookAnnouncementDelivery(db,{announcementId:id,customerId:row.customerId,owner,delivery:result,now:now()});processed++;
   await db.prepare('UPDATE announcement_dispatch SET next_send_at=?2 WHERE singleton=1 AND owner=?1').bind(owner,now()+ANNOUNCE_PACING_MS).run();
   if(result.kind==='rate_limited'||result.kind==='configuration'){
    await db.prepare('UPDATE announcement_dispatch SET pause_until=MAX(pause_until,?2) WHERE singleton=1 AND owner=?1')
     .bind(owner,now()+(result.kind==='rate_limited'?result.retryAfter*1000:600000)).run();break;
   }
  }
  return processed;
 }finally{
  // Unsent claims are released, not counted as failed attempts or sent.
  await db.prepare("UPDATE announcement_deliveries SET status='pending',claim_owner=NULL,lease_until=NULL WHERE announcement_id=?1 AND status='sending' AND claim_owner=?2 AND attempt_started_at IS NULL").bind(id,owner).run();
  await db.prepare('UPDATE announcement_dispatch SET owner=NULL,lease_until=0 WHERE singleton=1 AND owner=?1').bind(owner).run();
  await settleAnnouncement(db,id);
 }
}
export async function settleAnnouncement(db:D1Database,id:string):Promise<AnnouncementRow|null>{
 await db.prepare(`UPDATE announcements SET state='done',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id=?1 AND state='sending' AND started_at IS NOT NULL AND audience_seeded=1 AND active_count=0 AND recipient_count=sent_count+failed_count`)
  .bind(id).run();return getAnnouncement(db,id);
}
export async function listRecentAnnouncements(db:D1Database,limit:number):Promise<AnnouncementRow[]>{return (await db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT ?1').bind(limit).all<AnnouncementRow>()).results;}
