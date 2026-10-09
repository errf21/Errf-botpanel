import {configuredCredential,MAX_PANELS} from './bindings.ts';
export {MAX_PANELS};
import type { Env } from '../types.ts';
import type { ProvisioningConfig } from '../catalog/provisioning.ts';
import { loadPanelConfig, PasarGuardClient } from '../pasarguard/client.ts';
import type { PanelConfig } from '../pasarguard/client.ts';
import { panelOrigin, decrypt, publicDestination } from './security.ts';
export type PanelId = string;

export interface PanelRow {
    id: PanelId;
    name: string;
    origin: string | null;
    auth_type: 'api_key';
    credentials: string | null;
    credential_binding?: string | null;
    binding_fingerprint?: string | null;
    revision: number;
    enabled_new: number;
    group_ids: string | null;
    last_test: string | null;
    last_test_at: string | null;
}
export interface Selection {
    panel_id: PanelId;
    revision: number;
}
export async function getPanel(db: D1Database, id: string): Promise<PanelRow | null> {
    return db.prepare('SELECT * FROM panels WHERE id=?1').bind(id).first<PanelRow>();
}
export async function selection(db: D1Database): Promise<Selection> {
    const row = await db.prepare('SELECT panel_id,revision FROM panel_selection WHERE singleton=1').first<Selection>();
    if (!row)
        throw new Error('panel_selection_missing');
    return row;
}
export async function resolvePanel(env: Env, id: string): Promise<{
    ok: true;
    config: PanelConfig;
    row: PanelRow;
} | {
    ok: false;
    kind: 'not_configured' | 'bad_url';
    detail: string;
}> {
    const row = await getPanel(env.DB, id);
    if (!row)
        return { ok: false, kind: 'not_configured', detail: 'panel_missing' };
    if (id === 'legacy') {
        const loaded = loadPanelConfig(env);
        return loaded.ok ? { ok: true, config: { ...loaded.config, panelId: 'legacy', onVerifiedUser: observationWriter(env.DB,id,loaded.config.baseUrl) }, row } : loaded;
    }
    const origin = row.origin && panelOrigin(row.origin);
    if (!origin)
        return { ok: false, kind: 'bad_url', detail: 'panel_origin_invalid' };
    if(row.credential_binding){
        const loaded=await configuredCredential(env,row);
        if(!loaded.ok)return {ok:false,kind:'not_configured',detail:loaded.detail};
        return {ok:true,row,config:{baseUrl:origin,apiKey:loaded.apiKey,panelId:row.id,onVerifiedUser:observationWriter(env.DB,id,origin),validateDestination:()=>publicDestination(origin)}};
    }
    if (!row.credentials) return {ok:false,kind:'not_configured',detail:'panel_api_key_missing'};
    try {
        const credentials = await decrypt<{apiKey:string}>(env, `panel:${row.id}:${row.revision}:${origin}:credentials`, row.credentials);
        if (!validApiKey(credentials.apiKey)) return {ok:false,kind:'not_configured',detail:'panel_api_key_invalid'};
        return {ok:true,row,config:{baseUrl:origin,apiKey:credentials.apiKey,panelId:row.id,onVerifiedUser:observationWriter(env.DB,id,origin),validateDestination:()=>publicDestination(origin)}};
    } catch { return {ok:false,kind:'not_configured',detail:'panel_credentials_unavailable'}; }

}
export function provisioningForPanel(row: PanelRow, shared: ProvisioningConfig): ProvisioningConfig {
    if (row.id === 'legacy')
        return shared;
    let groups: unknown;
    try {
        groups = JSON.parse(row.group_ids ?? 'null');
    }
    catch {
        throw new Error('panel_groups_invalid');
    }
    if (!Array.isArray(groups) || !groups.length || groups.length > 50 || groups.some(v => !Number.isSafeInteger(v) || v < 1 || v > 1000000))
        throw new Error('panel_groups_invalid');
    return { ...shared, groupIds: groups as number[] };
}
export function clientFor(config: PanelConfig, externalId?: string | null): PasarGuardClient {
    return new PasarGuardClient({ ...config, expectedUserId: externalId ?? undefined });
}
export async function audit(db: D1Database, actor: number | string, id: string, action: string, result: string): Promise<void> {
    // Inputs are internal codes, never raw upstream bodies or user-authored credentials.
    await db.prepare('INSERT INTO panel_audit(actor,panel_id,action,result) VALUES (?1,?2,?3,?4)')
        .bind(String(actor), id, action, result).run();
}
export async function acquireServiceLock(db: D1Database, service: string, owner: string): Promise<boolean> {
    const now = Date.now();
    // A durable pre-switch migration is a fence even between worker requests.
    // Migration runners use an explicit owner prefix and still take this lease.
    const blocked = await db.prepare(`SELECT id FROM service_migrations WHERE service_id=?1
      AND state IN ('review','creating','verified','activating')`).bind(service).first<{id:string}>();
    if (blocked && !owner.startsWith(`migration:${blocked.id}:`)) return false;
    await db.prepare(`INSERT INTO panel_service_locks(service_id,owner,expires_at) SELECT ?1,?2,?3
    WHERE NOT EXISTS(SELECT 1 FROM service_migrations WHERE service_id=?1 AND state IN ('review','creating','verified','activating')
      AND substr(?2,1,length('migration:'||id||':'))<>('migration:'||id||':'))
    ON CONFLICT(service_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
    WHERE panel_service_locks.expires_at < ?4
      AND NOT EXISTS(SELECT 1 FROM service_migrations WHERE service_id=?1 AND state IN ('review','creating','verified','activating')
        AND substr(?2,1,length('migration:'||id||':'))<>('migration:'||id||':'))`).bind(service, owner, now + 900000, now).run();
    const row = await db.prepare('SELECT owner FROM panel_service_locks WHERE service_id=?1').bind(service).first<{
        owner: string;
    }>();
    return row?.owner === owner;
}
export async function releaseServiceLock(db: D1Database, service: string, owner: string): Promise<void> {
    await db.prepare('DELETE FROM panel_service_locks WHERE service_id=?1 AND owner=?2').bind(service, owner).run();
}

export function validApiKey(value: unknown): value is string {
    return typeof value === 'string' && value.length >= 1 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

/** Append-only observations of verified active identities; never guess unknown usage. */
function observationWriter(db: D1Database, panelId: string, origin: string): (user: import('../pasarguard/client.ts').PanelUser) => Promise<void> {
    return async user => {
        if (!user.id || !user.username) return;
        await db.prepare(`INSERT INTO service_observations(service_id,panel_id,user_id,username,data,observed_at,origin)
          WITH identities AS (
            SELECT o.id FROM orders o
            WHERE o.kind='purchase' AND o.state='completed' AND o.panel_deleted_at IS NULL
              AND o.panel_id=?1 AND o.pasarguard_user_id=?2 AND o.pasarguard_username=?3
              AND NOT EXISTS(SELECT 1 FROM active_service_resources r WHERE r.service_id=o.id)
            UNION ALL
            SELECT o.id FROM active_service_resources r JOIN orders o ON o.id=r.service_id
            WHERE o.kind='purchase' AND o.state='completed' AND o.panel_deleted_at IS NULL
              AND r.panel_id=?1 AND r.user_id=?2 AND r.username=?3
          ) SELECT id,?1,?2,?3,?4,?5,?6 FROM identities WHERE (SELECT COUNT(*) FROM identities)=1`)
          .bind(panelId,user.id,user.username,JSON.stringify({quota:user.dataLimit,used:user.usedTraffic,
            expire:user.expire,hwid:user.hwidLimit,status:user.status,migrationRestrictions:user.migrationRestrictions??[]}),Date.now(),origin).run();
    };
}

/** Migrated services always retain origin-pinned stable-ID safety, including
 * destinations that use legacy environment credentials. Non-migrated legacy
 * services keep their pre-existing endpoint behavior. */
export async function resolveServicePanel(env:Env,service:{panel_id?:string|null;active_migration_id?:string|null}):ReturnType<typeof resolvePanel>{
 if(!service.panel_id)return {ok:false,kind:'not_configured',detail:'service_panel_missing'};
 const result=await resolvePanel(env,service.panel_id);
 if(!result.ok||!service.active_migration_id)return result;
 const migration=await env.DB.prepare('SELECT destination_origin FROM service_migrations WHERE id=?1').bind(service.active_migration_id).first<{destination_origin:string}>();
 if(!migration||result.config.baseUrl!==migration.destination_origin)return {ok:false,kind:'bad_url',detail:'active_service_origin_changed'};
 return {...result,config:{...result.config,stableIdentity:true,requireGlobalAbsence:true}};
}
