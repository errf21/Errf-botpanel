import type { Env } from '../types.ts';
export function isPanelAdmin(env: Env, actor: number): boolean {
    if (!Number.isSafeInteger(actor) || actor <= 0)
        return false;
    const allowed = [env.ADMIN_CHAT_ID ?? '', ...(env.PANEL_ADMIN_IDS ?? '').split(',')];
    return allowed.some(id => /^\d+$/.test(id.trim()) && id.trim() === String(actor));
}
/** Administrator-managed public HTTPS origins only; never follow redirects. */
export function panelOrigin(raw: string): string | null {
    try {
        const u = new URL(raw);
        if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash ||
            (u.pathname !== '/' && u.pathname !== '') || (u.port && u.port !== '443' && u.port !== '8000'))
            return null;
        const host = u.hostname.toLowerCase();
        // DNS names only; prohibit literal IPs, local names and ambiguous numeric hosts.
        if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) ||
            /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(host))
            return null;
        return u.origin;
    }
    catch {
        return null;
    }
}
/** Normalize a pasted panel/dashboard URL only at the administrator input
 * boundary. Stored origins, the Mini App origin and DNS checks stay strict.
 * Never strip embedded credentials or a query into an apparently safe URL. */
export function panelInputOrigin(raw: string): string | null {
    try {
        if (/[\x00-\x1f\x7f]/.test(raw)) return null;
        const u = new URL(raw.trim());
        if (u.username || u.password || u.search) return null;
        return panelOrigin(u.origin);
    } catch { return null; }
}
function bytes64(bytes: Uint8Array): string {
    return btoa(Array.from(bytes, v => String.fromCharCode(v)).join(''));
}
function from64(value: string): Uint8Array {
    return Uint8Array.from(atob(value), v => v.charCodeAt(0));
}
async function key(env: Env): Promise<CryptoKey> {
    const raw = from64(env.PANEL_ENCRYPTION_KEY ?? '');
    if (raw.length !== 32)
        throw new Error('panel_encryption_unavailable');
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(env: Env, aad: string, value: unknown): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const out = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, await key(env), new TextEncoder().encode(JSON.stringify(value)));
    return JSON.stringify({ v: 1, iv: bytes64(iv), data: bytes64(new Uint8Array(out)) });
}
export async function decrypt<T>(env: Env, aad: string, ciphertext: string): Promise<T> {
    try {
        const record = JSON.parse(ciphertext) as {
            v: number;
            iv: string;
            data: string;
        };
        if (record.v !== 1)
            throw new Error();
        const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(record.iv), additionalData: new TextEncoder().encode(aad) }, await key(env), from64(record.data));
        return JSON.parse(new TextDecoder().decode(out)) as T;
    }
    catch {
        throw new Error('panel_decryption_failed');
    }
}
export function nonce(): string { return crypto.randomUUID().replace(/-/g, ''); }
/** Telegram WebApp HMAC; caller still enforces Cloudflare admin IDs + one-use nonce. */
export async function verifyInitData(env: Env, value: string, now = Date.now()): Promise<number | null> {
    // Required secret: never authenticate with a publicly computable empty key.
    const botToken = env.TELEGRAM_BOT_TOKEN;
    if (typeof botToken !== 'string' || botToken.trim() === '')
        return null;
    try {
        if (value.length > 8192)
            return null;
        const p = new URLSearchParams(value);
        if (new Set(Array.from(p.keys())).size !== Array.from(p.keys()).length)
            return null;
        const hash = p.get('hash');
        const at = Number(p.get('auth_date'));
        if (!hash || !/^[a-f0-9]{64}$/.test(hash) || !Number.isFinite(at) ||
            at * 1000 > now + 30000 || now - at * 1000 > 300000)
            return null;
        p.delete('hash');
        const check = Array.from(p.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
        const hmac = async (k: Uint8Array, data: string) => {
            const imported = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
            return new Uint8Array(await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(data)));
        };
        const secret = await hmac(new TextEncoder().encode('WebAppData'), botToken);
        const expected = Array.from(await hmac(secret, check), v => v.toString(16).padStart(2, '0')).join('');
        let diff = 0;
        for (let i = 0; i < 64; i++)
            diff |= expected.charCodeAt(i) ^ hash.charCodeAt(i);
        if (diff)
            return null;
        const user = JSON.parse(p.get('user') ?? '{}') as {
            id?: number;
        };
        return typeof user.id === 'number' && isPanelAdmin(env, user.id) ? user.id : null;
    }
    catch {
        return null;
    }
}

/** Public DNS preflight before sending ANY dynamic API key. No DNS override or
 * IP-literal credential requests. Rechecked for each API call, bounded/timeouts.
 * The operator must trust the panel DNS/TLS owner: DNS lookup and Worker fetch
 * are separate resolutions, not an atomic DNS-pinned egress firewall. */
export function publicAddress(value: string): boolean {
    if (typeof value !== 'string') return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
        const parts = value.split('.');
        if (parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))) return false;
        const b = parts.map(Number);
        if (b.some(v => v > 255)) return false;
        const [a,c,d] = b as [number,number,number,number];
        return !(a===0 || a===10 || a===127 || a>=224 ||
            (a===100 && c>=64 && c<=127) || (a===169 && c===254) ||
            (a===172 && c>=16 && c<=31) || (a===192 && (c===168 || c===0 || (c===88 && d===99))) ||
            (a===198 && (c===18 || c===19 || (c===51 && d===100))) || (a===203 && c===0 && d===113));
    }
    // IPv6: only globally routed unicast 2000::/3, exclude documentation,
    // transition/tunnelling and special-purpose 2001::/23.
    if (!/^[0-9a-f:]+$/i.test(value) || !value.includes(':')) return false;
    try { new URL(`https://[${value}]/`); } catch { return false; }
    const first = parseInt(value.split(':')[0]!,16);
    const second = parseInt(value.split(':')[1] || '0',16);
    return first>=0x2000 && first<=0x3fff && first!==0x2002 &&
        !(first===0x2001 && (second<0x200 || second===0xdb8)) &&
        !(first===0x3fff && second<0x1000);
}
export async function publicDestination(origin: string): Promise<boolean> {
    if (!panelOrigin(origin)) return false;
    try {
        const host = new URL(origin).hostname;
        const answers = await Promise.all(['A','AAAA'].map(async type => {
            const u = new URL('https://cloudflare-dns.com/dns-query');
            u.searchParams.set('name',host); u.searchParams.set('type',type);
            const response = await fetch(u,{headers:{accept:'application/dns-json'},redirect:'manual',signal:AbortSignal.timeout(5000)});
            // Workers supports follow/manual, not redirect:'error'. Non-2xx
            // (including every redirect) is rejected without following it.
            if (!response.ok) {
                await response.body?.cancel().catch(()=>undefined);
                throw new Error();
            }
            const {limitedText} = await import('./http.ts');
            const raw:unknown = JSON.parse(await limitedText(response,32768));
            if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error();
            const data=raw as {Status?:unknown;TC?:unknown;Answer?:unknown};
            if (data.Status!==0 || data.TC===true || (data.TC!==undefined && typeof data.TC!=='boolean')) throw new Error();
            // NOERROR with absent/empty Answer is normal AAAA NODATA, not
            // a failure. At least one public address across both queries is
            // still required; any failed query or malformed/private answer blocks.
            if (data.Answer===undefined) return [];
            if (!Array.isArray(data.Answer) || data.Answer.length>64) throw new Error();
            const addresses:string[]=[];
            for (const item of data.Answer) {
                if (!item || typeof item!=='object' || Array.isArray(item)) throw new Error();
                const record=item as {type?:unknown;data?:unknown};
                if (!Number.isInteger(record.type) || Number(record.type)<1 || Number(record.type)>65535 || typeof record.data!=='string' || !record.data.length) throw new Error();
                if (record.type===1 && !/^\d+\.\d+\.\d+\.\d+$/.test(record.data)) throw new Error();
                if (record.type===28 && !record.data.includes(':')) throw new Error();
                if (record.type===1 || record.type===28) addresses.push(record.data);
            }
            return addresses;
        }));
        const addresses = answers.flat();
        return addresses.length>0 && addresses.every(publicAddress);
    } catch { return false; }
}
