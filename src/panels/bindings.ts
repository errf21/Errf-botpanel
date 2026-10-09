/** Explicit Cloudflare binding declarations. Never enumerate env or serialize secrets. */
import type { Env } from '../types.ts';
import type { PanelRow } from './registry.ts';
import { panelInputOrigin, nonce } from './security.ts';
export const MAX_PANELS = 100;
const MAX_CONFIGURED = MAX_PANELS - 1;
interface Entry {
    id: string;
    name: string;
    origin: string | null;
    keyBinding: string;
    groups: number[];
    error: string | null;
    fingerprint: string | null;
}
interface Declarations {
    present: boolean;
    entries: Entry[];
    issues: string[];
}
function binding(env: Env, name: string): unknown { return (env as unknown as Record<string, unknown>)[name]; }
function validKey(value: unknown): value is string { return typeof value === 'string' && value.length >= 1 && value.length <= 4096 && !/[^\x21-\x7e]/.test(value); }
function groupIds(value: unknown): number[] { try {
    const ids = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(ids) && ids.length <= 50 && ids.every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000) && new Set(ids).size === ids.length ? ids : [];
}
catch {
    return [];
} }
async function fingerprint(env: Env, origin: string, bindingName: string, key: string): Promise<string | null> { if (typeof env.TELEGRAM_BOT_TOKEN !== 'string' || !env.TELEGRAM_BOT_TOKEN.trim())
    return null; const signing = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TELEGRAM_BOT_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); const bytes = await crypto.subtle.sign('HMAC', signing, new TextEncoder().encode(JSON.stringify(['errf-panel-binding-v1', origin, bindingName, key]))); return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join(''); }
export async function configuredPanels(env: Env): Promise<Declarations> {
    const indexed = env.PANEL_COUNT !== undefined, manifest = env.PANEL_MANIFEST !== undefined, shards = env.PANEL_MANIFEST_COUNT !== undefined;
    const present = indexed || manifest || shards;
    if (!present)
        return { present: false, entries: [], issues: [] };
    if (Number(indexed) + Number(manifest) + Number(shards) !== 1)
        return { present: true, entries: [], issues: ['binding_modes_conflict'] };
    const raw: Record<string, unknown>[] = [], issues: string[] = [];
    if (indexed) {
        const n = Number(env.PANEL_COUNT);
        if (!/^\d{1,2}$/.test(String(env.PANEL_COUNT)) || !Number.isSafeInteger(n) || n < 0 || n > MAX_CONFIGURED)
            return { present: true, entries: [], issues: ['binding_count_invalid'] };
        for (let i = 1; i <= n; i++)
            raw.push({ id: `cf_${i}`, name: binding(env, `PANEL_${i}_NAME`), url: binding(env, `PANEL_${i}_URL`), apiKeyBinding: `PANEL_${i}_API_KEY`, groupIds: binding(env, `PANEL_${i}_GROUP_IDS`) });
    }
    else {
        const n = shards ? Number(env.PANEL_MANIFEST_COUNT) : 1;
        if (!Number.isSafeInteger(n) || n < 1 || n > 20)
            return { present: true, entries: [], issues: ['binding_manifest_count_invalid'] };
        for (let i = 1; i <= n; i++) {
            const text = shards ? binding(env, `PANEL_MANIFEST_${i}`) : env.PANEL_MANIFEST;
            try {
                if (typeof text !== 'string' || new TextEncoder().encode(text).length > 5120)
                    throw Error();
                const list = JSON.parse(text);
                if (!Array.isArray(list) || list.some(v => !v || typeof v !== 'object' || Array.isArray(v)))
                    throw Error();
                raw.push(...list);
            }
            catch {
                issues.push(`binding_manifest_${i}_invalid`);
            }
        }
        if (raw.length > MAX_CONFIGURED)
            return { present: true, entries: [], issues: ['binding_manifest_capacity'] };
    }
    const entries: Entry[] = [], ids = new Map<string, Entry>();
    for (let i = 0; i < raw.length; i++) {
        const r = raw[i]!, validId = typeof r.id === 'string' && /^cf_[a-z0-9_-]{1,29}$/.test(r.id);
        let id = validId ? r.id as string : `cf_invalid_${i + 1}`;
        const keyBinding = typeof r.apiKeyBinding === 'string' && /^PANEL_[A-Z0-9_]{1,48}_API_KEY$/.test(r.apiKeyBinding) ? r.apiKeyBinding : 'PANEL_INVALID_API_KEY';
        const key = binding(env, keyBinding);
        let origin = typeof r.url === 'string' ? panelInputOrigin(r.url) : null;
        if (validKey(key) && origin?.includes(key))
            origin = null;
        let error = !validId ? 'binding_id_invalid' : keyBinding === 'PANEL_INVALID_API_KEY' ? 'binding_reference_invalid' : !origin ? 'binding_origin_invalid' : !validKey(key) ? 'binding_key_missing_or_invalid' : null;
        let name = typeof r.name === 'string' && r.name.trim() && r.name.length <= 64 && !/[\x00-\x1f\x7f]/.test(r.name) ? r.name.trim() : id;
        if (validKey(key) && (name.includes(key) || id === key)) {
            if (id === key)
                id = `cf_invalid_${i + 1}`;
            name = `Cloudflare panel ${i + 1}`;
            error = 'binding_label_invalid';
        }
        const e: Entry = { id, name, origin, keyBinding, groups: groupIds(r.groupIds), error, fingerprint: !error && origin && validKey(key) ? await fingerprint(env, origin, keyBinding, key) : null };
        if (!e.error && !e.fingerprint)
            e.error = 'binding_fingerprint_unavailable';
        const old = ids.get(id);
        if (old) {
            old.error = 'binding_id_duplicate';
            issues.push('binding_id_duplicate');
            continue;
        }
        ids.set(id, e);
        entries.push(e);
    }
    // Deterministic ownership of duplicates, independent of manifest order.
    const origins = new Set<string>(), references = new Set<string>();
    for (const e of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
        if (e.error)
            continue;
        if (origins.has(e.origin!)) {
            e.error = 'binding_duplicate_origin';
            continue;
        }
        if (references.has(e.keyBinding)) {
            e.error = 'binding_duplicate_reference';
            continue;
        }
        origins.add(e.origin!);
        references.add(e.keyBinding);
    }
    return { present, entries, issues };
}
/** A registered immutable identity takes precedence over a later duplicate.
 * A changed host/reference, missing key, or duplicate ID is never excused. */
function ownsDuplicate(row:PanelRow|undefined,entry:Entry):boolean {
    return !!row?.credential_binding && !!row.origin && row.origin===entry.origin && row.credential_binding===entry.keyBinding &&
        (entry.error==='binding_duplicate_origin'||entry.error==='binding_duplicate_reference');
}
/** Resolve against the current declarations AND the persisted immutable origin.
 * Reusing a slot for another host can never send its new key to the old host. */
export async function configuredCredential(env: Env, row: PanelRow): Promise<{
    ok: true;
    apiKey: string;
} | {
    ok: false;
    detail: string;
}> {
    const loaded = await configuredPanels(env), entry = loaded.entries.find(e => e.id === row.id);
    if (!entry)
        return { ok: false, detail: loaded.issues[0] ?? 'binding_declaration_missing' };
    if (entry.error && !ownsDuplicate(row,entry))
        return { ok: false, detail: entry.error };
    if (entry.origin !== row.origin || entry.keyBinding !== row.credential_binding)
        return { ok: false, detail: 'binding_identity_changed' };
    if (entry.fingerprint !== row.binding_fingerprint)
        return { ok: false, detail: 'binding_revision_changed' };
    const key = binding(env, entry.keyBinding);
    return validKey(key) ? { ok: true, apiKey: key } : { ok: false, detail: 'binding_key_missing_or_invalid' };
}
function legacyOrigin(env: Env): string | null { try {
    const u = new URL(env.PASARGUARD_PANEL_URL ?? '');
    return u.protocol === 'https:' ? u.origin : null;
}
catch {
    return null;
} }
/** No API writes, auto-enabling, deletions, selection changes or credential copies.
 * Row CAS + D1 batch make concurrent initialization idempotent and auditable. */
export async function syncConfiguredPanels(env: Env): Promise<string[]> {
    const loaded = await configuredPanels(env);
    if (!loaded.present)
        return [];
    const rows = await env.DB.prepare('SELECT * FROM panels').all<PanelRow>(), byId = new Map(rows.results.map(r => [r.id, r]));
    const issues = [...loaded.issues], legacy = legacyOrigin(env);
    for (const e of loaded.entries) {
        const old = byId.get(e.id);
        if (old && !old.credential_binding) {
            issues.push('binding_id_collision');
            continue;
        }
        let error = ownsDuplicate(old,e) ? null : e.error;
        if (e.origin === legacy && e.origin)
            error = 'binding_duplicate_legacy';
        if (!error && e.origin && rows.results.some(p => p.id !== e.id && p.origin === e.origin))
            error = 'binding_duplicate_registry_origin';
        if (!error && rows.results.some(p=>p.id!==e.id&&!!p.origin&&p.credential_binding===e.keyBinding))
            error='binding_duplicate_registered_reference';
        if (old?.origin && e.origin && old.origin !== e.origin)
            error = 'binding_identity_changed';
        const origin = old?.origin ?? (error?.startsWith('binding_duplicate') ? null : e.origin), status = error ?? 'not_tested', digest = error ? null : e.fingerprint;
        if (old && old.origin === origin && old.credential_binding === e.keyBinding && old.binding_fingerprint === digest && (!error || old.last_test === error))
            continue;
        const token = nonce();
        try {
            if (!old) {
                await env.DB.batch([
                    env.DB.prepare(`INSERT INTO panels(id,name,origin,credential_binding,binding_fingerprint,group_ids,last_change,last_test)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE (SELECT COUNT(*) FROM panels)<?9
      AND (?3 IS NULL OR NOT EXISTS(SELECT 1 FROM panels WHERE origin=?3)) ON CONFLICT(id) DO NOTHING`)
                        .bind(e.id, e.name, error && error.startsWith('binding_duplicate') ? null : origin, e.keyBinding, digest, JSON.stringify(e.groups), token, status, MAX_PANELS),
                    env.DB.prepare("INSERT INTO panel_audit(actor,panel_id,action,result) SELECT 'system',id,'binding_register',?2 FROM panels WHERE id=?1 AND last_change=?3").bind(e.id, status, token),
                ]);
            }
            else {
                // Seed names/groups only on INSERT. Never overwrite Mini App
                // selections on restart, absent GROUP_IDS, or secret rotation.
                await env.DB.batch([
                    env.DB.prepare(`UPDATE panels SET origin=?1,credential_binding=?2,binding_fingerprint=?3,revision=revision+1,enabled_new=0,last_change=?4,last_test=?5,last_test_at=NULL
      WHERE id=?6 AND revision=?7 AND credential_binding IS NOT NULL`).bind(origin, e.keyBinding, digest, token, status, e.id, old.revision),
                    env.DB.prepare("INSERT INTO panel_audit(actor,panel_id,action,result) SELECT 'system',id,'binding_sync',?2 FROM panels WHERE id=?1 AND last_change=?3").bind(e.id, status, token),
                ]);
            }
            if (!old && !await env.DB.prepare('SELECT id FROM panels WHERE id=?1').bind(e.id).first())
                issues.push('binding_registry_capacity_or_conflict');
            if (error)
                issues.push(error);
        }
        catch {
            issues.push('binding_sync_failed');
        }
    }
    // Declared removal retires, never deletes, a managed panel or resets selection.
    for (const old of rows.results) {
        if (!old.credential_binding || loaded.entries.some(e => e.id === old.id) || (!old.enabled_new && old.last_test === 'binding_declaration_missing'))
            continue;
        const token = nonce();
        await env.DB.batch([
            env.DB.prepare("UPDATE panels SET enabled_new=0,revision=revision+1,last_test='binding_declaration_missing',last_test_at=NULL,last_change=?1 WHERE id=?2 AND revision=?3").bind(token, old.id, old.revision),
            env.DB.prepare("INSERT INTO panel_audit(actor,panel_id,action,result) SELECT 'system',id,'binding_retired','binding_declaration_missing' FROM panels WHERE id=?1 AND last_change=?2").bind(old.id, token),
        ]);
    }
    return issues;
}
