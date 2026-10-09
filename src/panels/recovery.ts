import type { Env } from '../types.ts';
import { bookRepurchaseOnService, getOrderById } from '../db/orders.ts';
import { acquireServiceLock, releaseServiceLock } from './registry.ts';
import { provisionOrder } from '../provision/provision.ts';
import { TelegramApi } from '../telegram/api.ts';
/** Durable, bounded recovery; no automatic retry of failed/uncertain writes.
 * Abandoned provisioning becomes visible in /failed with its panel/targets intact.
 * Approved orders stranded before scheduling are picked up using the same claim.
 */
export async function recoverPanelOperations(env: Env): Promise<void> {
    const cutoff = new Date(Date.now() - 900000).toISOString();
    await env.DB.prepare(`UPDATE orders SET state='failed',failure_reason='interrupted_verify_before_retry',
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE state='provisioning' AND updated_at<?1 AND panel_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM panel_service_locks l WHERE l.service_id=COALESCE(orders.renews_order_id,orders.id) AND l.expires_at>?2)`)
        .bind(cutoff, Date.now()).run();
    // Repurchases must be booked even when the target expiry already matches:
    // reset may rotate the URL and the new paid cycle must re-arm its notices.
    const repairPredicate = `o.kind='renewal' AND o.state='completed' AND s.state='completed' AND s.panel_deleted_at IS NULL
      AND o.panel_id=s.panel_id
      AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id=s.id
        AND (e.action IN ('service_extended','service_repurchased') OR (e.action='service_booking_recovered' AND o.repurchase_mode IS NULL))
        AND (json_extract(e.data,'$.renewal_order_id')=o.id OR json_extract(e.data,'$.repurchase_order_id')=o.id OR json_extract(e.data,'$.operation')=o.id))
      AND NOT EXISTS(SELECT 1 FROM orders newer WHERE newer.renews_order_id=s.id AND newer.state='completed'
        AND (newer.updated_at>o.updated_at OR (newer.updated_at=o.updated_at AND newer.id>o.id)))
      AND COALESCE(o.repurchase_target_unix,o.renew_target_unix) IS NOT NULL
      AND (o.repurchase_mode IS NOT NULL OR s.service_expires_at IS NULL
        OR datetime(s.service_expires_at)<datetime(o.renew_target_unix,'unixepoch'))`;
    const repair = await env.DB.prepare(`SELECT o.id,o.renews_order_id FROM orders o JOIN effective_orders s ON s.id=o.renews_order_id
      WHERE ${repairPredicate} ORDER BY o.updated_at LIMIT 5`).all<{id:string;renews_order_id:string}>();
    for (const candidate of repair.results) {
        const owner = crypto.randomUUID();
        if (!await acquireServiceLock(env.DB, candidate.renews_order_id, owner)) continue;
        try {
            // Re-evaluate after acquiring the same lease as provisioning/deletion.
            // A stale scan cannot overwrite a newer completed service operation.
            const row = await env.DB.prepare(`SELECT o.* FROM orders o JOIN effective_orders s ON s.id=o.renews_order_id
              WHERE o.id=?1 AND ${repairPredicate}`).bind(candidate.id).first<import('../db/orders.ts').OrderRow>();
            if (!row) continue;
            const expiry = row.repurchase_target_unix ?? row.renew_target_unix;
            const expiresIso = new Date(expiry! * 1000).toISOString();
            if (row.repurchase_mode) {
                // Older implementations retained this value only in the event.
                const event = row.subscription_url ? null : await env.DB.prepare(`SELECT json_extract(data,'$.subscription_url') AS url
                  FROM order_events WHERE order_id=?1 AND action='repurchase_succeeded' ORDER BY id DESC LIMIT 1`)
                  .bind(row.id).first<{url:string|null}>();
                await bookRepurchaseOnService(env.DB, { serviceOrderId: candidate.renews_order_id,
                  repurchaseOrderId: row.id, expiresIso, subscriptionUrl: row.subscription_url ?? event?.url ?? null });
            } else {
                await env.DB.batch([
                    env.DB.prepare(`UPDATE active_service_resources SET expires_at=CASE WHEN expires_at<?2 THEN ?2 ELSE expires_at END WHERE service_id=?1 AND panel_id=?3`)
                      .bind(row.renews_order_id, expiresIso, row.panel_id??null),
                    env.DB.prepare(`UPDATE orders SET service_expires_at=CASE WHEN service_expires_at IS NULL OR service_expires_at<?2 THEN ?2 ELSE service_expires_at END
                      WHERE id=?1 AND panel_id=?3 AND panel_deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM active_service_resources WHERE service_id=?1)`)
                        .bind(row.renews_order_id, expiresIso, row.panel_id ?? null),
                    env.DB.prepare(`INSERT INTO order_events(order_id,actor,action,data) SELECT ?1,'system','service_booking_recovered',?2
                      WHERE NOT EXISTS(SELECT 1 FROM order_events WHERE order_id=?1 AND action='service_booking_recovered' AND data=?2)`)
                        .bind(row.renews_order_id, JSON.stringify({ operation: row.id })),
                ]);
            }
        } finally { await releaseServiceLock(env.DB, candidate.renews_order_id, owner); }
    }
    // Scan more than the write budget and rotate unchanged/unclaimable rows.
    // One unavailable panel must not permanently starve healthy-panel orders.
    const approved = await env.DB.prepare(`SELECT id,updated_at,provision_attempts FROM orders
      WHERE state='approved' AND panel_deleted_at IS NULL ORDER BY updated_at,id LIMIT 20`)
        .all<{id:string;updated_at:string;provision_attempts:number}>();
    let attempts = 0;
    for (const row of approved.results) {
        await provisionOrder({ env, db: env.DB, api: new TelegramApi(env.TELEGRAM_BOT_TOKEN) }, { orderId: row.id });
        const after = await getOrderById(env.DB, row.id);
        if (after && after.provision_attempts > row.provision_attempts) attempts++;
        else if (after?.state === 'approved') {
            await env.DB.prepare(`UPDATE orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE id=?1 AND state='approved' AND updated_at=?2 AND provision_attempts=?3`)
              .bind(row.id,row.updated_at,row.provision_attempts).run();
        }
        if (attempts >= 2) break;
    }
}
