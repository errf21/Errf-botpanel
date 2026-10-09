import { renderPanelForm } from './form.ts';
import { resolveLocale } from '../telegram/i18n.ts';
import type { Env, UpdateContext, TelegramInlineKeyboardMarkup } from '../types.ts';
import { getPanel, selection, resolvePanel, clientFor, audit, MAX_PANELS, validApiKey } from './registry.ts';
import type { PanelRow } from './registry.ts';
import { encrypt, decrypt, isPanelAdmin, nonce, panelOrigin, panelInputOrigin, verifyInitData, publicDestination } from './security.ts';
import { limitedText } from './http.ts';
import type { PanelConfig } from '../pasarguard/client.ts';
interface Session {
    nonce: string; actor: string; action: string; panel_id: string;
    panel_revision: number; selection_revision: number; enabled_new: number; expires_at: number;
}
const privateAdmin = (ctx: UpdateContext) => ctx.chatId === ctx.actor.id && isPanelAdmin(ctx.env, ctx.actor.id);
const PAGE_SIZE = 5;
async function arm(env: Env, actor: number, action: string, id: string): Promise<string> {
    const p = await getPanel(env.DB, id);
    const sel = await selection(env.DB);
    const token = nonce();
    await env.DB.prepare('DELETE FROM panel_admin_sessions WHERE expires_at<?1').bind(Date.now()).run();
    await env.DB.prepare('INSERT INTO panel_admin_sessions VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
        .bind(token, String(actor), action, id, p?.revision ?? 0, sel.revision, p?.enabled_new ?? 0, Date.now() + 300000).run();
    return token;
}
async function consume(env: Env, actor: number, token: string, action: string): Promise<Session | null> {
    if (!/^[a-f0-9]{32}$/.test(token)) return null;
    return env.DB.prepare('DELETE FROM panel_admin_sessions WHERE nonce=?1 AND actor=?2 AND action=?3 AND expires_at>?4 RETURNING *')
        .bind(token, String(actor), action, Date.now()).first<Session>();
}
function adminOrigin(env: Env): string | null {
    return panelOrigin(env.PANEL_ADMIN_ORIGIN ?? '');
}
async function formButton(ctx: UpdateContext, id: string, text: string): Promise<void> {
    const origin = adminOrigin(ctx.env);
    if (!origin) { await ctx.api.sendMessage(ctx.chatId, 'Secure form unavailable: configure PANEL_ADMIN_ORIGIN once.'); return; }
    const token = await arm(ctx.env, ctx.actor.id, 'configure', id);
    await ctx.api.sendMessage(ctx.chatId, 'Open the secure Telegram form. Do not send API keys in chat.', {
        inline_keyboard: [[{ text, web_app: { url: `${origin}/admin/panels?nonce=${token}&lang=${ctx.ui.locale}` } }]],
    });
}
export async function showPanels(ctx: UpdateContext, page = 0): Promise<void> {
    if (!privateAdmin(ctx)) {
        await audit(ctx.db, ctx.actor.id, '', 'unauthorized', 'denied');
        await ctx.api.sendMessage(ctx.chatId, 'Panel management is restricted to Cloudflare-authorized administrators in private chat.');
        return;
    }
    const sel = await selection(ctx.db);
    const count = await ctx.db.prepare('SELECT COUNT(*) AS n FROM panels').first<{n:number}>();
    const pages = Math.max(1,Math.ceil((count?.n ?? 0)/PAGE_SIZE));
    page = Math.min(Math.max(0,page),pages-1);
    const rows = await ctx.db.prepare("SELECT * FROM panels ORDER BY CASE WHEN id='legacy' THEN 0 ELSE 1 END,name,id LIMIT ?1 OFFSET ?2")
        .bind(PAGE_SIZE,page*PAGE_SIZE).all<PanelRow>();
    const selected = await getPanel(ctx.db,sel.panel_id);
    const buttons: TelegramInlineKeyboardMarkup = {inline_keyboard:[]};
    const lines = ['PasarGuard panels', `Selected for NEW services: ${selected?.name ?? sel.panel_id} (${sel.panel_id})`, `Page ${page+1}/${pages}; ${count?.n ?? 0}/${MAX_PANELS} panels`];
    for (const p of rows.results) {
        const resolved = await resolvePanel(ctx.env,p.id);
        lines.push(`${p.id}: ${p.name}${sel.panel_id===p.id ? ' — SELECTED' : ''}\nNew orders: ${p.enabled_new ? 'enabled' : 'disabled'}; configuration: ${resolved.ok ? 'ready' : resolved.detail}\nAPI key: ${p.id==='legacy' ? 'Worker secret (hidden)' : p.credentials ? 'encrypted (hidden)' : 'required'}\nLast connection/permission test: ${p.last_test ?? 'not tested'}${p.last_test_at ? ` at ${p.last_test_at}` : ''}`);
        buttons.inline_keyboard.push([{text:`Test ${p.name}`,callback_data:`pnl:test:${p.id}`},{text:`Select ${p.name}`,callback_data:`pnl:select:${p.id}`}]);
        buttons.inline_keyboard.push([{text:`${p.enabled_new ? 'Disable' : 'Enable'} new orders`,callback_data:`pnl:toggle:${p.id}`},{text:`Edit ${p.name}`,callback_data:`pnl:edit:${p.id}`}]);
        if (p.id!=='legacy') buttons.inline_keyboard.push([{text:`Delete ${p.name}`,callback_data:`pnl:delete:${p.id}`}]);
    }
    buttons.inline_keyboard.push([{text:'Add API-key panel securely',callback_data:'pnl:add'}]);
    const nav: {text:string;callback_data:string}[] = [];
    if(page>0) nav.push({text:'Previous',callback_data:`pnl:list:${page-1}`});
    if(page+1<pages) nav.push({text:'Next',callback_data:`pnl:list:${page+1}`});
    if(nav.length) buttons.inline_keyboard.push(nav);
    lines.push('Existing services and assigned retries stay on their original panels. No automatic fallback. Test results are snapshots, not continuous health monitoring.');
    await ctx.api.sendMessage(ctx.chatId,lines.join('\n\n'),buttons);
}
/** Read-only verification before storing a submitted key. No user writes. */
async function verifyConfiguration(config: PanelConfig, groups: number[] | null): Promise<string> {
    const client = clientFor(config);
    const who = await client.getCurrentAdmin();
    if (!who.ok) return `test_${who.kind}_${who.status}`;
    const data = who.data;
    if (!data || typeof data.username!=='string' || data.status!=='active') return 'account_unavailable';
    const role = data.role as {is_owner?:boolean;permissions?:{users?:Record<string,unknown>}} | undefined;
    const permits = (value:unknown) => value===true || (typeof value==='object' && value!==null && [1,2].includes(Number((value as {scope?:unknown}).scope)));
    if(role?.is_owner!==true && !['create','read','update','reset_usage','delete'].every(k=>permits(role?.permissions?.users?.[k]))) return 'required_user_permissions_unverified';
    if(groups) {
        if(!groups.length) return 'groups_missing';
        for (const group of groups) {
            const read = await client.getGroup(group);
            if(!read.ok || Number(read.data?.id)!==group || read.data?.is_disabled===true) return 'group_access_unverified';
        }
    }
    return 'ok';
}
export async function testPanel(env:Env,id:string): Promise<string> {
    const panel = await resolvePanel(env,id);
    if(!panel.ok) return panel.detail;
    const groups = id==='legacy' ? null : JSON.parse(panel.row.group_ids ?? '[]') as number[];
    return verifyConfiguration(panel.config,groups);
}
export async function panelCallback(ctx: UpdateContext,data:string,callbackId:string): Promise<void> {
    if(!privateAdmin(ctx)) {
        await audit(ctx.db,ctx.actor.id,'','unauthorized','denied');
        await ctx.api.answerCallbackQuery(callbackId,'Not authorized.',true); return;
    }
    const list = /^pnl:list:([0-9]{1,3})$/.exec(data);
    if(list) { await ctx.api.answerCallbackQuery(callbackId); await showPanels(ctx,Number(list[1])); return; }
    if(data==='pnl:add') {
        await ctx.api.answerCallbackQuery(callbackId);
        const count = await ctx.db.prepare('SELECT COUNT(*) n FROM panels').first<{n:number}>();
        if((count?.n ?? 0)>=MAX_PANELS) {await ctx.api.sendMessage(ctx.chatId,`Panel limit (${MAX_PANELS}) reached.`);return;}
        await formButton(ctx,nonce(),'Add API-key panel'); return;
    }
    const match = /^pnl:(test|select|toggle|edit|delete):([a-z0-9_-]{1,32})$/.exec(data);
    if(match) {
        const action=match[1]!,id=match[2]!;
        const p = await getPanel(ctx.db,id);
        if(!p) {await ctx.api.answerCallbackQuery(callbackId,'Panel not configured.',true);return;}
        if(action==='edit') {await ctx.api.answerCallbackQuery(callbackId);await formButton(ctx,id,`Edit ${p.name}`);return;}
        if(action==='test') {
            await ctx.api.answerCallbackQuery(callbackId,'Testing API key and declared permissions…');
            let result:string;
            try {result=await testPanel(ctx.env,id);} catch {result='test_unavailable';}
            await ctx.db.prepare("UPDATE panels SET last_test=?1,last_test_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2 AND revision=?3")
                .bind(result,id,p.revision).run();
            await audit(ctx.db,ctx.actor.id,id,'test',result);
            await ctx.api.sendMessage(ctx.chatId,`Panel ${p.name}: ${result}. Read-only test; declared permissions and groups, not live mutation proof.`);return;
        }
        if(action==='delete' && id==='legacy') {await ctx.api.answerCallbackQuery(callbackId,'Legacy panel cannot be deleted.',true);return;}
        const token=await arm(ctx.env,ctx.actor.id,action,id);
        await ctx.api.answerCallbackQuery(callbackId);
        await ctx.api.sendMessage(ctx.chatId,action==='select' ? `Use ${p.name} for NEW services? Existing services and assigned orders remain unchanged.` :
            action==='delete' ? `Delete ${p.name}? Only unselected panels with NO assigned orders (including history/pending orders) can be deleted. No reassignment is performed.` :
            `${p.enabled_new ? 'Disable' : 'Enable'} ${p.name} for NEW services? Existing-service management remains available.`,{
            inline_keyboard:[[{text:'Confirm',callback_data:`pnl:confirm:${token}`},{text:'Cancel',callback_data:`pnl:cancel:${token}`}]],
        });return;
    }
    const confirm=/^pnl:(confirm|cancel):([a-f0-9]{32})$/.exec(data);
    if(!confirm) {await ctx.api.answerCallbackQuery(callbackId,'Invalid panel action.',true);return;}
    const token=confirm[2]!;
    const peek=await ctx.db.prepare('SELECT * FROM panel_admin_sessions WHERE nonce=?1 AND actor=?2 AND expires_at>?3').bind(token,String(ctx.actor.id),Date.now()).first<Session>();
    if(!peek || !['select','toggle','delete'].includes(peek.action)) {await ctx.api.answerCallbackQuery(callbackId,'Expired or already used confirmation.',true);return;}
    const session=await consume(ctx.env,ctx.actor.id,token,peek.action);
    if(!session) {await ctx.api.answerCallbackQuery(callbackId,'Already handled.',true);return;}
    if(confirm[1]==='cancel') {await ctx.api.answerCallbackQuery(callbackId,'Cancelled.');return;}
    const p=await getPanel(ctx.db,session.panel_id);
    if(!p || p.revision!==session.panel_revision || p.enabled_new!==session.enabled_new) {await ctx.api.answerCallbackQuery(callbackId,'Configuration changed; review again.',true);return;}
    if(session.action==='delete') {
        // Guard and audit in one serialized D1 transaction; FK + trigger also
        // block concurrent assignment. Never delete a historical association.
        const guard="id=?2 AND id<>'legacy' AND revision=?3 AND NOT EXISTS(SELECT 1 FROM orders WHERE panel_id=panels.id) AND NOT EXISTS(SELECT 1 FROM panel_selection WHERE panel_id=panels.id) AND NOT EXISTS(SELECT 1 FROM service_migrations WHERE source_panel_id=panels.id OR destination_panel_id=panels.id) AND NOT EXISTS(SELECT 1 FROM service_observations WHERE panel_id=panels.id)";
        await ctx.db.batch([
            ctx.db.prepare(`INSERT INTO panel_audit(actor,panel_id,action,result) SELECT ?1,id,'delete','ok' FROM panels WHERE ${guard}`).bind(String(ctx.actor.id),p.id,p.revision),
            ctx.db.prepare(`DELETE FROM panels WHERE ${guard.replaceAll('?2','?1').replaceAll('?3','?2')}`).bind(p.id,p.revision),
        ]);
        const remains=await getPanel(ctx.db,p.id);
        await ctx.api.answerCallbackQuery(callbackId,remains ? 'Deletion blocked: panel selected, associated, or changed.' : 'Panel deleted.',true);
        await showPanels(ctx);return;
    }
    const resolved=await resolvePanel(ctx.env,p.id);
    // Disabling always works, even when key/configuration has failed. Enabling
    // and selecting require valid configuration + successful dynamic test.
    if((session.action==='select' || !p.enabled_new) && (!resolved.ok || (p.id!=='legacy' && p.last_test!=='ok'))) {
        await ctx.api.answerCallbackQuery(callbackId,'Valid configuration and successful permission/group test required.',true);return;
    }
    if(session.action==='select' && !p.enabled_new) {await ctx.api.answerCallbackQuery(callbackId,'Enable new orders first.',true);return;}
    if(session.action==='select') {
        await ctx.db.batch([
            ctx.db.prepare(`UPDATE panel_selection SET panel_id=?1,revision=revision+1,last_change=?2 WHERE singleton=1 AND revision=?3
              AND EXISTS(SELECT 1 FROM panels WHERE id=?1 AND revision=?4 AND enabled_new=1)`).bind(p.id,token,session.selection_revision,p.revision),
            ctx.db.prepare("INSERT INTO panel_audit(actor,panel_id,action,result) SELECT ?1,?2,'select','ok' FROM panel_selection WHERE singleton=1 AND last_change=?3").bind(String(ctx.actor.id),p.id,token),
        ]);
        const won=await ctx.db.prepare('SELECT last_change FROM panel_selection WHERE singleton=1').first<{last_change:string}>();
        await ctx.api.answerCallbackQuery(callbackId,won?.last_change===token ? 'Selection saved.' : 'Selection changed concurrently; review again.',true);
    } else {
        await ctx.db.batch([
            ctx.db.prepare('UPDATE panels SET enabled_new=?1,last_change=?2 WHERE id=?3 AND revision=?4 AND enabled_new=?5').bind(p.enabled_new?0:1,token,p.id,p.revision,p.enabled_new),
            ctx.db.prepare("INSERT INTO panel_audit(actor,panel_id,action,result) SELECT ?1,id,'toggle_new','ok' FROM panels WHERE id=?2 AND last_change=?3").bind(String(ctx.actor.id),p.id,token),
        ]);
        const won=await ctx.db.prepare('SELECT last_change FROM panels WHERE id=?1').bind(p.id).first<{last_change:string}>();
        await ctx.api.answerCallbackQuery(callbackId,won?.last_change===token ? 'New-order eligibility saved.' : 'State changed; review again.',true);
    }
    await showPanels(ctx);
}
export async function panelAdminRoute(request:Request,env:Env): Promise<Response> {
    const url=new URL(request.url),origin=adminOrigin(env);
    const headers={
        'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
        'content-security-policy':"default-src 'none'; script-src https://telegram.org 'nonce-panel-form'; style-src 'nonce-panel-form'; connect-src 'self'; frame-ancestors https://web.telegram.org; base-uri 'none'; form-action 'self'",
    };
    const reply=(status:number,message:string)=>new Response(JSON.stringify({message}),{status,headers:{...headers,'content-type':'application/json'}});
    if(!origin || url.origin!==origin) return reply(403,'Configuration endpoint unavailable.');
    if(request.method==='GET' && url.pathname==='/admin/panels') {
        const token=url.searchParams.get('nonce');
        if(!token || !/^[a-f0-9]{32}$/.test(token)) return reply(400,'Open the form from /panels.');
        // A URL/nonce is not an identity. Serve no registry or session metadata.
        const scriptNonce=nonce();
        return new Response(renderPanelForm(token,scriptNonce,resolveLocale(url.searchParams.get('lang'))),{headers:{...headers,'content-security-policy':headers['content-security-policy'].replaceAll('nonce-panel-form',`nonce-${scriptNonce}`),'content-type':'text/html; charset=utf-8'}});
    }
    if(request.method!=='POST' || !['/admin/panels/configure','/admin/panels/metadata','/admin/panels/groups'].includes(url.pathname) || request.headers.get('origin')!==origin || !request.headers.get('content-type')?.startsWith('application/json')) return reply(403,'Not authorized.');
    try {
        const body=JSON.parse(await limitedText(new Response(request.body),16384)) as Record<string,unknown>;
        if(typeof body.initData!=='string') return reply(403,'Not authorized.');
        const actor=await verifyInitData(env,body.initData);
        if(!actor) return reply(403,'Not authorized.');
        if(url.pathname==='/admin/panels/metadata' || url.pathname==='/admin/panels/groups') {
            // Read-only session lookup: never consume the configure nonce here.
            // Caller identity is freshly verified above, not inferred from a link.
            const token=body.nonce;
            if(typeof token!=='string' || !/^[a-f0-9]{32}$/.test(token)) return reply(403,'Not authorized.');
            const session=await env.DB.prepare("SELECT * FROM panel_admin_sessions WHERE nonce=?1 AND actor=?2 AND action='configure' AND expires_at>?3")
                .bind(token,String(actor),Date.now()).first<Session>();
            if(!session) return reply(403,'Expired or unavailable form; open a new form.');
            const p=await getPanel(env.DB,session.panel_id);
            if((p?.revision ?? 0)!==session.panel_revision) return reply(409,'Configuration changed; reopen form.');
            if(url.pathname==='/admin/panels/groups') {
                const fail=(status:number,code:string)=>new Response(JSON.stringify({code}),{status,headers:{...headers,'content-type':'application/json'}});
                if(session.panel_id==='legacy')return fail(400,'legacy_configuration');
                const destination=typeof body.url==='string'?panelInputOrigin(body.url):null;
                if(!destination)return fail(400,'invalid_origin');
                if(p && destination!==p.origin) {
                    const refs=await env.DB.prepare('SELECT (SELECT COUNT(*) FROM orders WHERE panel_id=?1)+(SELECT COUNT(*) FROM service_migrations WHERE source_panel_id=?1 OR destination_panel_id=?1) n').bind(p.id).first<{n:number}>();
                    if(refs?.n)return fail(409,'origin_locked');
                }
                let supplied:unknown=body.apiKey;
                // A stored credential is bound to its exact origin and revision.
                // Never send a retained key to an edited hostname.
                if((supplied==='' || supplied===undefined) && p?.credentials && destination===p.origin)
                    supplied=(await decrypt<{apiKey:string}>(env,`panel:${p.id}:${p.revision}:${p.origin}:credentials`,p.credentials)).apiKey;
                if(!validApiKey(supplied))return fail(400,'key_required');
                const result=await clientFor({baseUrl:destination,apiKey:supplied,validateDestination:()=>publicDestination(destination)}).listGroups();
                if(!result.ok)return fail(result.kind==='auth'?401:result.kind==='permission'?403:502,
                    result.kind==='auth'?'key_rejected':result.kind==='permission'?'permission_denied':result.status===404?'unsupported_api':result.kind==='bad_url'?'invalid_origin':'discovery_failed');
                // A malicious upstream must not reflect our credential in a group name.
                if(result.data.some(group=>group.name.includes(supplied as string)))return fail(502,'discovery_failed');
                // Read-only discovery doesn't consume the one-time save nonce.
                const stillValid=await env.DB.prepare("SELECT nonce FROM panel_admin_sessions WHERE nonce=?1 AND actor=?2 AND action='configure' AND expires_at>?3 AND panel_revision=?4")
                    .bind(token,String(actor),Date.now(),session.panel_revision).first();
                const latest=await getPanel(env.DB,session.panel_id);
                if(!stillValid || (latest?.revision??0)!==session.panel_revision)return fail(409,'session_changed');
                return new Response(JSON.stringify({groups:result.data}),{status:200,headers:{...headers,'content-type':'application/json'}});
            }
            const groups=JSON.parse(p?.group_ids ?? '[]') as unknown;
            if(!Array.isArray(groups) || groups.some(v=>!Number.isSafeInteger(v) || v<1 || v>1000000)) return reply(400,'Configuration unavailable.');
            // Explicit DTO: never serialize PanelRow, ciphertext, keys or bindings.
            const metadata={name:p?.name ?? '',url:p?.origin ?? '',groups,legacy:session.panel_id==='legacy',hasApiKey:!!p?.credentials};
            return new Response(JSON.stringify(metadata),{status:200,headers:{...headers,'content-type':'application/json'}});
        }
        const {name,url:raw,apiKey,groups,nonce:token}=body;
        if(typeof name!=='string' || !name.trim() || name.length>64 || /[\x00-\x1f\x7f]/.test(name) || typeof token!=='string') return reply(400,'Invalid configuration.');
        const session=await consume(env,actor,token,'configure');
        if(!session) return reply(403,'Expired or used form; open a new form.');
        const id=session.panel_id,old=await getPanel(env.DB,id);
        if((old?.revision ?? 0)!==session.panel_revision) return reply(409,'Configuration changed; reopen form.');
        if(id==='legacy') {
            // Legacy credentials/origin stay in their existing environment. A
            // No encrypted credentials exist on the legacy row.
            await env.DB.batch([
                env.DB.prepare('UPDATE panels SET name=?1,last_change=?2,revision=revision+1 WHERE id=\'legacy\' AND revision=?3').bind(name.trim(),token,session.panel_revision),
                env.DB.prepare("INSERT INTO panel_audit(actor,panel_id,action,result) SELECT ?1,id,'rename','ok' FROM panels WHERE id='legacy' AND last_change=?2").bind(String(actor),token),
            ]);
            const won=await env.DB.prepare("SELECT last_change FROM panels WHERE id='legacy'").first<{last_change:string}>();
            return won?.last_change===token ? reply(200,'Legacy display name saved. Existing Worker URL/API key are unchanged.') : reply(409,'Configuration changed; reopen form.');
        }
        const destination=typeof raw==='string' ? panelInputOrigin(raw) : null;
        if(!destination) return reply(400,'Use a public HTTPS URL on port 443 or 8000 without credentials or queries.');
        if(!Array.isArray(groups) || !groups.length || groups.length>50 || groups.some(v=>!Number.isSafeInteger(v) || v<1 || v>1000000) || new Set(groups).size!==groups.length) return reply(400,'Invalid group IDs (1–50 unique IDs).');
        if(old && old.origin!==destination) {
            const refs=await env.DB.prepare('SELECT (SELECT COUNT(*) FROM orders WHERE panel_id=?1)+(SELECT COUNT(*) FROM service_migrations WHERE source_panel_id=?1 OR destination_panel_id=?1) n').bind(id).first<{n:number}>();
            if(refs?.n) return reply(409,'Cannot change the origin of a panel with assigned orders. Add a separate panel instead.');
        }
        // Legacy's origin is deliberately read from its existing binding, not
        // copied into the registry. Reject aliases of that same destination.
        let legacyOrigin:string|undefined;
        try {legacyOrigin=new URL(env.PASARGUARD_PANEL_URL ?? '').origin;} catch { /* missing legacy config */ }
        if(destination===legacyOrigin) return reply(409,'This origin is already the legacy panel.');
        const duplicates=await env.DB.prepare('SELECT id FROM panels WHERE origin=?1 AND id<>?2').bind(destination,id).first<{id:string}>();
        if(duplicates) return reply(409,'This origin is already registered.');
        let key:unknown=apiKey;
        if((apiKey==='' || apiKey===undefined) && old?.credentials && destination===old.origin) key=(await decrypt<{apiKey:string}>(env,`panel:${id}:${old.revision}:${old.origin}:credentials`,old.credentials)).apiKey;
        if(!validApiKey(key)) return reply(400,'A valid API key is required.');
        const config:PanelConfig={baseUrl:destination,apiKey:key,panelId:id,validateDestination:()=>publicDestination(destination)};
        const result=await verifyConfiguration(config,groups as number[]);
        await audit(env.DB,actor,id,'configuration_test',result);
        if(result!=='ok') return reply(422,`Configuration not accepted: ${result}. No credentials were saved.`);
        const revision=(old?.revision ?? 0)+1;
        const ciphertext=await encrypt(env,`panel:${id}:${revision}:${destination}:credentials`,{apiKey:key});
        await env.DB.batch([
            env.DB.prepare(`INSERT INTO panels(id,name,origin,auth_type,credentials,revision,enabled_new,group_ids,last_change,last_test,last_test_at)
              SELECT ?1,?2,?3,'api_key',?4,?5,0,?6,?7,'ok',strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE EXISTS(SELECT 1 FROM panels WHERE id=?1) OR (SELECT COUNT(*) FROM panels)<?9
              ON CONFLICT(id) DO UPDATE SET name=excluded.name,origin=excluded.origin,credentials=excluded.credentials,
              revision=excluded.revision,group_ids=excluded.group_ids,last_change=excluded.last_change,last_test='ok',last_test_at=excluded.last_test_at
              WHERE panels.revision=?8 AND (panels.origin=excluded.origin OR (NOT EXISTS(SELECT 1 FROM orders WHERE panel_id=panels.id) AND NOT EXISTS(SELECT 1 FROM service_migrations WHERE source_panel_id=panels.id OR destination_panel_id=panels.id)))`)
                .bind(id,name.trim(),destination,ciphertext,revision,JSON.stringify(groups),token,session.panel_revision,MAX_PANELS),
            env.DB.prepare("INSERT INTO panel_audit(actor,panel_id,action,result) SELECT ?1,id,'configure','ok' FROM panels WHERE id=?2 AND last_change=?3").bind(String(actor),id,token),
        ]);
        const won=await env.DB.prepare('SELECT last_change FROM panels WHERE id=?1').bind(id).first<{last_change:string}>();
        return won?.last_change===token ? reply(200,'API key validated and encrypted configuration saved. Return to /panels; enable/select explicitly for new services.') : reply(409,'Panel limit or concurrent configuration change; reopen form.');
    } catch { return reply(400,'Configuration could not be saved. No credential details are returned.'); }
}
