import { limitedText } from '../panels/http.ts';
/**
 * PasarGuard panel API client (Phase 5 + 6).
 *
 * The contract below was derived from the panel's own published JS bundle
 * (read-only GET inspection of /dashboard/ statics): the dashboard talks to
 * `/api/...` endpoints and ships a `subscription_url` (possibly root-relative)
 * on every user object. Phase 6 re-read the bundle and confirmed the partial
 * update primitive: `PUT /api/user/by-username/{name}` with only dirty
 * fields, `expire` as absolute unix seconds (user edit dialog + quick
 * buttons +7d/+1m/+2m/+3m → 30/60/90d).
 *
 * Production finding (2026-09): the direct create endpoint silently ignored
 * a relative `expire_duration` field — services were born Unlimited. The
 * panel user model stores an ABSOLUTE `expire` (unix seconds; 0/absent =
 * no expiry), so creation now sends the same `expire` field the verified PUT
 * primitive uses, and provisioning read-back-verifies it (repair-PUT + fail
 * closed in `provision.ts`).
 *
 * Safety rules:
 *  - The API key is sent ONLY as the `x-api-key` header over HTTPS; it is
 *    never logged or included in error details; dynamic keys are encrypted in D1.
 *  - NO automatic retries here: a retry of an ambiguous write could double
 *    apply a write. Idempotency is handled one level up
 *    (`provision.ts`: pre-check by-username/claimed target before every
 *    create/modify, verify after).
 *  - Responses are parsed defensively; unexpected shapes degrade to typed
 *    errors instead of throwing.
 */

export const PANEL_TIMEOUT_MS = 15_000;

export interface PanelConfig {
  baseUrl: string;
  apiKey: string;
  panelId?: string;
  validateDestination?: () => Promise<boolean>;
  expectedUserId?: string;
  /** Migration-only: stable-ID mutations and certified absence, including legacy. */
  stableIdentity?: boolean;
  requireGlobalAbsence?: boolean;
  onVerifiedUser?: (user: PanelUser) => Promise<void>;
}

export type PanelErrorKind =
  | 'not_configured'
  | 'bad_url'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'permission'
  | 'identity'
  | 'not_found'
  | 'rejected'
  | 'server'
  | 'parse';

export type PanelResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: PanelErrorKind; status: number; detail: string };

/** Verified upstream GroupsResponse; expose no inbound/user/admin metadata. */
export interface PanelGroup { id:number; name:string; disabled?:boolean; statusVerified?:false; }
interface GroupPage { groups:PanelGroup[]; total:number; }
function groupPage(value:unknown, simple=false):GroupPage|null {
  const object=asRecord(value);
  if (!object || !Array.isArray(object.groups) || !Number.isSafeInteger(object.total) || Number(object.total)<0 || Number(object.total)>1000 || object.groups.length>100) return null;
  const groups:PanelGroup[]=[],seen=new Set<number>();
  for(const value of object.groups) {
    const group=asRecord(value);
    if(!group || typeof group.id!=='number' || !Number.isSafeInteger(group.id) || group.id<1 || group.id>1000000 ||
      typeof group.name!=='string' || !group.name.trim() || group.name.length>64 || /[\x00-\x1f\x7f]/.test(group.name) || seen.has(group.id))return null;
    if(group.is_disabled!==undefined && typeof group.is_disabled!=='boolean')return null;
    seen.add(group.id);groups.push({id:group.id,name:group.name,...(simple?{statusVerified:false as const}:group.is_disabled===true?{disabled:true}:{})});
  }
  return {groups,total:Number(object.total)};
}

/** Subset of the panel user object this bot understands. */
export interface PanelUser {
  id: string | null;
  note?: string | null;
  username: string | null;
  status: string | null;
  subscriptionUrl: string | null;
  /** Absolute expiry in unix seconds (null = none/unlimited). */
  expire: number | null;
  /** Traffic bytes (null = unknown / unlimited). Wire unit: bytes. */
  dataLimit: number | null;
  usedTraffic: number | null;
  /** Phase 18: concurrent-device cap as reported by the panel (null = unknown). */
  hwidLimit: number | null;
  /** PasarGuard 5.4.1 UserResponse.group_ids; absent/malformed stays unverified. */
  groupIds?: number[] | null;
  /** Features outside the bot's fixed finite plan model require explicit manual review. */
  migrationRestrictions?: string[];
}

/**
 * Panel dates arrive either as unix seconds or ISO strings (defensively,
 * since the field is optional per response). Anything nonsensical parses to
 * null — we never guess a date the customer could act on.
 */
export function coerceUnixSeconds(value: unknown): number | null {
  let seconds: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) seconds = value;
  else if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    seconds = Number.isFinite(numeric) ? numeric : Date.parse(value) / 1000;
  }
  if (seconds === null || Number.isNaN(seconds)) return null;
  if (seconds > 1e12) seconds = Math.floor(seconds / 1000); // ms → s
  seconds = Math.floor(seconds);
  if (seconds === 0) return null; // panel "no expiry" marker
  if (seconds < 0 || seconds > 4_000_000_000) return null;
  return seconds;
}

/** Byte counts only ever arrive as finite non-negative numbers. */
function coerceBytes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (value === 0) return null; // 0 = unlimited on the panel
  return Math.floor(value);
}

function numberField(obj: Record<string, unknown> | null, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export interface CreateUserPayload {
  username: string;
  status: 'active' | 'on_hold';
  /** Traffic cap in bytes (panel wire unit; provisioning converts GiB→bytes). */
  data_limit: number;
  /**
   * ABSOLUTE expiry in unix seconds — the same `expire` field/semantics the
   * verified PUT/renewal primitive uses. 0/absent means Unlimited on the
   * panel, so the provisioner never sends one (guarded in createUser below).
   */
  expire: number;
  /** Concurrent-device cap. */
  hwid_limit: number;
  /** Panel access groups the service is created in. */
  group_ids: number[];
  /** Order cross-reference written into the panel's note field. */
  note: string;
}

/**
 * Renewal / increase patch: absolute `expire` (unix seconds) and/or absolute
 * `data_limit` (bytes). Partial bodies are supported by the panel (its own
 * edit dialog sends only dirty fields). Callers send ONLY dirty fields:
 * duration-only renewals send `expire` exactly as before; volume add-ons add
 * `data_limit` (additively computed upstream); both send both. `used_traffic`
 * is NEVER part of this payload — the panel preserves usage on partial PUTs.
 *
 * Phase 18 repurchase: the SAME partial primitive carries the absolute
 * repurchase finals — `data_limit` (absolute quota, never a delta), `expire`
 * (fresh absolute expiry) and `hwid_limit` (final device cap, verified live
 * on the deployed panel: Modify/Edit User accepts it on an existing user).
 * `used_traffic` is still NEVER sent here — usage is zeroed exclusively via
 * the dedicated reset operation (`resetUserUsageByUsername`).
 */
export interface ModifyUserPayload {
  expire?: number;
  data_limit?: number;
  /** Phase 18: final concurrent-device cap on an EXISTING user. */
  hwid_limit?: number;
  status?: 'active' | 'on_hold' | 'disabled';
}

function failure(status: number, detail: string, kind?: PanelErrorKind): { ok: false; status: number; detail: string; kind: PanelErrorKind } {
  return {
    ok: false,
    kind: kind ?? classifyStatus(status),
    status,
    detail: detail.slice(0, 200),
  };
}

function classifyStatus(status: number): PanelErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'rejected'; // 4xx validation / business rejection
}

/**
 * Validates env-provided config. Fails closed: a missing key, non-HTTPS
 * base URL, or malformed URL disables provisioning entirely.
 */
export function loadPanelConfig(env: {
  PASARGUARD_API_KEY?: string;
  PASARGUARD_PANEL_URL?: string;
}): { ok: true; config: PanelConfig } | { ok: false; kind: 'not_configured' | 'bad_url'; detail: string } {
  const apiKey = env.PASARGUARD_API_KEY?.trim() ?? '';
  const rawUrl = env.PASARGUARD_PANEL_URL?.trim() ?? '';
  if (apiKey === '' || rawUrl === '') {
    return { ok: false, kind: 'not_configured', detail: 'panel_key_or_url_missing' };
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, kind: 'bad_url', detail: 'panel_url_unparseable' };
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    return { ok: false, kind: 'bad_url', detail: 'panel_url_rejected' };
  }
  return { ok: true, config: { baseUrl: url.origin, apiKey } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(obj: Record<string, unknown> | null, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Unwraps the panel's (unknown-depth) JSON envelope defensively: looks for an
 * object carrying a username or id, one level under `data`/`user`/`result`.
 */
export function extractPanelUser(json: unknown): PanelUser | null {
  const root = asRecord(json);
  if (!root) return null;
  const candidates: Record<string, unknown>[] = [root];
  for (const key of ['data', 'user', 'result']) {
    const nested = asRecord(root[key]);
    if (nested) candidates.push(nested);
  }
  for (const record of candidates) {
    if (
      record['username'] !== undefined ||
      record['id'] !== undefined ||
      record['subscription_url'] !== undefined
    ) {
      return {
        id: stringField(record, ['id', 'user_id', 'userId']),
        note: typeof record['note'] === 'string' ? record['note'] : null,
        username: stringField(record, ['username']),
        status: stringField(record, ['status']),
        subscriptionUrl: stringField(record, ['subscription_url', 'subscriptionUrl']),
        expire: coerceUnixSeconds(record['expire']),
        dataLimit: coerceBytes(numberField(record, ['data_limit'])),
        usedTraffic: (() => { const n = numberField(record, ['used_traffic']); return n !== null && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? Math.floor(n) : null; })(),
        hwidLimit: coerceBytes(numberField(record, ['hwid_limit'])),
        groupIds: (() => {const ids=record['group_ids'];return Array.isArray(ids)&&ids.length>0&&ids.length<=50&&ids.every(id=>Number.isSafeInteger(id)&&id>=1&&id<=1000000)&&new Set(ids).size===ids.length ? [...ids] as number[] : null;})(),
        ...(() => {
          const features:string[]=[];
          if(record['data_limit_reset_strategy'] && record['data_limit_reset_strategy']!=='no_reset')features.push('periodic_quota_reset');
          if(record['next_plan']!=null)features.push('scheduled_next_plan');
          if(typeof record['on_hold_expire_duration']==='number' && record['on_hold_expire_duration']>0)features.push('relative_on_hold_expiry');
          if(typeof record['auto_delete_in_days']==='number' && record['auto_delete_in_days']>0)features.push('custom_auto_delete');
          return features.length ? {migrationRestrictions:features} : {};
        })(),
      };
    }
  }
  return null;
}

/** Absolute subscription link for a (possibly root-relative) panel value. */
export function resolveSubscriptionUrl(baseUrl: string, value: string | null): string | null {
  if (value === null) return null;
  if (/^https?:\/\//i.test(value)) return value.slice(0, 512);
  if (value.startsWith('/')) return `${baseUrl}${value}`.slice(0, 512);
  return null; // anything else is not a safe link to hand to a customer
}

export class PasarGuardClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #validateDestination?: () => Promise<boolean>;
  readonly #strictAbsence: boolean;
  readonly #requireGlobalAbsence: boolean;
  readonly #expectedUserId?: string;
  readonly #panelId?: string;
  readonly #onVerifiedUser?: (user: PanelUser) => Promise<void>;
  readonly baseUrl: string;

  constructor(config: PanelConfig) {
    this.#baseUrl = config.baseUrl;
    this.#apiKey = config.apiKey;
    this.#validateDestination = config.validateDestination;
    this.#strictAbsence = config.stableIdentity === true || (!!config.panelId && config.panelId !== 'legacy');
    this.#requireGlobalAbsence = config.requireGlobalAbsence === true;
    this.#onVerifiedUser = config.onVerifiedUser;
    this.#expectedUserId = config.expectedUserId;
    this.#panelId = config.panelId;
    this.baseUrl = config.baseUrl;
  }

  /** Bind an already verified identity before any corrective mutation. */
  withExpectedUserId(id: string): PasarGuardClient {
    return new PasarGuardClient({ baseUrl: this.#baseUrl, apiKey: this.#apiKey,
      panelId: this.#panelId, validateDestination: this.#validateDestination, expectedUserId: id,
      stableIdentity: this.#strictAbsence, requireGlobalAbsence: this.#requireGlobalAbsence, onVerifiedUser: this.#onVerifiedUser });
  }

  /** Dynamic-panel mutations use the upstream stable-ID endpoints, avoiding
   * username replacement races. Preserve the working legacy endpoint contract. */
  #mutationPath(username: string, suffix = ''): string | null {
    if (this.#strictAbsence && this.#expectedUserId) {
      if (!/^[0-9]{1,20}$/.test(this.#expectedUserId)) return null;
      return `/api/user/by-id/${encodeURIComponent(this.#expectedUserId)}${suffix}`;
    }
    return `/api/user/by-username/${encodeURIComponent(username)}${suffix}`;
  }

  /**
   * GET /api/user/by-username/{name}.
   * 404 maps to a typed not_found (only a certified resource absence);
   * every other failure is a typed error (never treated as "absent").
   */
  getUserByUsername(username: string): Promise<PanelResult<PanelUser | null>> {
    if (!/^[A-Za-z0-9]{3,32}$/.test(username)) {
      return Promise.resolve(failure(0, 'username_charset', 'rejected'));
    }
    return (async () => {
      const result = await this.#request<PanelUser | null>('GET', `/api/user/by-username/${encodeURIComponent(username)}`);
      // A renamed resource is not a deleted resource. On dynamic panels, a
      // known stable ID must also be absent before destructive reconciliation.
      if (!result.ok && result.kind === 'not_found' && this.#strictAbsence && this.#expectedUserId) {
        const byId = await this.getUserById(this.#expectedUserId);
        if (byId.ok) return failure(0,'resource_username_changed','identity');
        if (byId.kind !== 'not_found') return byId;
      }
      return result;
    })();
  }

  /**
   * POST /api/user — creates the service. NEVER auto-retried. The absolute
   * `expire` is range-guarded exactly like the PUT primitive so an
   * Unlimited-shaped (0/out-of-range) create can never leave this client.
   */
  createUser(payload: CreateUserPayload): Promise<PanelResult<PanelUser | null>> {
    if (
      !Number.isSafeInteger(payload.expire) ||
      payload.expire < 1 ||
      payload.expire > 4_000_000_000
    ) {
      return Promise.resolve(failure(0, 'expire_target_range', 'rejected'));
    }
    return this.#request<PanelUser | null>('POST', '/api/user', payload);
  }

  /** GET /api/user/by-id/{id} — confirmation read after an envelope-less create. */
  getUserById(id: string): Promise<PanelResult<PanelUser | null>> {
    if (!/^[0-9]{1,20}$/.test(id)) {
      return Promise.resolve(failure(0, 'user_id_charset', 'rejected'));
    }
    return this.#request<PanelUser | null>('GET', `/api/user/by-id/${encodeURIComponent(id)}`);
  }

  /**
   * PUT /api/user/by-username/{name} — partial modify (renewals set an
   * absolute `expire` and/or an absolute `data_limit`; Phase 18 repurchases
   * additionally set an absolute `hwid_limit`). NEVER auto-retried
   * blindly: callers pre-check the stored targets and post-verify with
   * getUserByUsername, and absolute re-application is a no-op by
   * construction. At least one of expire/data_limit/hwid_limit must be present.
   */
  modifyUserByUsername(
    username: string,
    patch: ModifyUserPayload,
  ): Promise<PanelResult<PanelUser | null>> {
    if (!/^[A-Za-z0-9]{3,32}$/.test(username)) {
      return Promise.resolve(failure(0, 'username_charset', 'rejected'));
    }
    const hasExpire = patch.expire !== undefined;
    const hasLimit = patch.data_limit !== undefined;
    const hasHwid = patch.hwid_limit !== undefined;
    if (!hasExpire && !hasLimit && !hasHwid) {
      return Promise.resolve(failure(0, 'empty_patch', 'rejected'));
    }
    if (
      hasExpire &&
      (!Number.isSafeInteger(patch.expire) || (patch.expire as number) < 1 || (patch.expire as number) > 4_000_000_000)
    ) {
      return Promise.resolve(failure(0, 'expire_target_range', 'rejected'));
    }
    if (
      hasLimit &&
      (!Number.isSafeInteger(patch.data_limit) || (patch.data_limit as number) < 1 || (patch.data_limit as number) > Number.MAX_SAFE_INTEGER)
    ) {
      return Promise.resolve(failure(0, 'data_limit_range', 'rejected'));
    }
    if (
      hasHwid &&
      (!Number.isSafeInteger(patch.hwid_limit) || (patch.hwid_limit as number) < 1 || (patch.hwid_limit as number) > 10_000)
    ) {
      return Promise.resolve(failure(0, 'hwid_limit_range', 'rejected'));
    }
    const path = this.#mutationPath(username);
    if (!path) return Promise.resolve(failure(0, 'user_id_charset', 'identity'));
    return this.#request<PanelUser | null>(
      'PUT',
      path,
      patch,
    );
  }

  /**
   * POST /api/user/by-username/{name}/reset — zero the user's used traffic
   * on the EXISTING user (Phase 18 repurchases). Verified live on the
   * deployed panel: HTTP 200, used_traffic becomes 0, data_limit and expire
   * unchanged, same user/id retained, subscription_url MAY rotate (callers
   * must re-read it, never treat it as identity). Empty POST — no body.
   * NEVER auto-retried blindly: callers claim `repurchase_reset_done` BEFORE
   * the call and prove the result with getUserByUsername (used_traffic == 0);
   * re-issuing a reset whose usage already reads 0 is a value-idempotent
   * no-op. NEVER use the bulk `POST /api/users/reset` (resets EVERY user).
   */
  resetUserUsageByUsername(username: string): Promise<PanelResult<PanelUser | null>> {
    if (!/^[A-Za-z0-9]{3,32}$/.test(username)) {
      return Promise.resolve(failure(0, 'username_charset', 'rejected'));
    }
    const path = this.#mutationPath(username, '/reset');
    if (!path) return Promise.resolve(failure(0, 'user_id_charset', 'identity'));
    return this.#request<PanelUser | null>(
      'POST',
      path,
    );
  }

  /**
   * DELETE /api/user/by-username/{name} — removes the service. NEVER
   * auto-retried; the caller CONFIRMS with a by-username read-back before any
   * local bookkeeping, and a 404 here means "already gone" (idempotent), not
   * an error. `provision.ts:deletePanelService` is the only caller.
   */
  deleteUserByUsername(username: string): Promise<PanelResult<PanelUser | null>> {
    if (!/^[A-Za-z0-9]{3,32}$/.test(username)) {
      return Promise.resolve(failure(0, 'username_charset', 'rejected'));
    }
    const path = this.#mutationPath(username);
    if (!path) return Promise.resolve(failure(0, 'user_id_charset', 'identity'));
    return this.#request<PanelUser | null>(
      'DELETE',
      path,
    );
  }

  getCurrentAdmin(): Promise<PanelResult<Record<string, unknown> | null>> {
    return this.#request('GET', '/api/admin', undefined, asRecord);
  }
  /** An OWN-scoped 404 may hide an existing resource, not prove absence. */
  async canVerifyAbsence(): Promise<boolean> {
    const result = await this.getCurrentAdmin();
    if (!result.ok || !result.data || typeof result.data.username !== 'string' || result.data.status !== 'active') return false;
    const data = result.data as {is_owner?:boolean;role?:{is_owner?:boolean;permissions?:{users?:{read?:unknown}}}};
    const read = data.role?.permissions?.users?.read;
    return data.is_owner === true || data.role?.is_owner === true || read === true ||
      (typeof read === 'object' && read !== null && (read as {scope?:unknown}).scope === 2);
  }
  getGroup(id: number, timeoutMs = PANEL_TIMEOUT_MS): Promise<PanelResult<Record<string, unknown> | null>> {
    if (!Number.isSafeInteger(id) || id < 1) return Promise.resolve(failure(0,'group_invalid','rejected'));
    return this.#request('GET', `/api/group/${id}`, undefined, asRecord, timeoutMs);
  }

  /** Verify ONLY explicitly selected IDs through the official group-detail
   * endpoint. Simple lists/templates cannot certify group disabled status. */
  async verifyGroupStatuses(ids:unknown):Promise<PanelResult<{id:number;disabled:boolean}[]>> {
    if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(id=>!Number.isSafeInteger(id)||id<1||id>1000000)||new Set(ids).size!==ids.length)
      return failure(0,'group_selection_invalid','rejected');
    const deadline=Date.now()+20000,statuses:{id:number;disabled:boolean}[]=[];
    for(const id of ids){
      const remaining=deadline-Date.now();if(remaining<=0)return failure(0,'group_status_timeout','timeout');
      const result=await this.getGroup(id,remaining);
      if(!result.ok)return result;
      if(Date.now()>=deadline)return failure(0,'group_status_timeout','timeout');
      if(!result.data||result.data.id!==id||typeof result.data.is_disabled!=='boolean')return failure(200,'group_status_unexpected','parse');
      statuses.push({id,disabled:result.data.is_disabled});
    }
    return {ok:true,data:statuses};
  }

  /** Upstream v5.4.1: full list uses groups.read; the documented simple
   * list uses groups.read_simple. Only a 403 permits this capability fallback,
   * on the same validated origin/key. Simple IDs/names do NOT prove status. */
  async listGroups():Promise<PanelResult<PanelGroup[]>> {
    const deadline=Date.now()+20000;
    const full=await this.#groupList(false,deadline);
    return !full.ok && full.kind==='permission' && full.status===403
      ? this.#groupList(true,deadline) : full;
  }
  async #groupList(simple:boolean,deadline:number):Promise<PanelResult<PanelGroup[]>> {
    const groups:PanelGroup[]=[],seen=new Set<number>();let total:number|null=null;
    for(let page=0;page<10;page++) {
      const remaining=deadline-Date.now();if(remaining<=0)return failure(0,'group_discovery_timeout','timeout');
      const result=await this.#request('GET',`/api/groups${simple?'/simple':''}?offset=${groups.length}&limit=100`,undefined,value=>groupPage(value,simple),remaining);
      if(!result.ok)return result;
      if(!result.data || (total!==null && total!==result.data.total))return failure(0,'group_list_changed','parse');
      total=result.data.total;
      for(const group of result.data.groups) {
        if(seen.has(group.id))return failure(0,'group_list_changed','parse');
        seen.add(group.id);groups.push(group);
      }
      if(groups.length===total)return {ok:true,data:groups};
      if(groups.length>total || !result.data.groups.length)return failure(0,'group_list_incomplete','parse');
    }
    return failure(0,'group_list_incomplete','parse');
  }

  async #request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    parser?: (json: unknown) => T | null,
    timeoutMs = PANEL_TIMEOUT_MS,
  ): Promise<PanelResult<T | null>> {
    const url = `${this.#baseUrl}${path}`;
    let response: Response;
    try {
      if (this.#validateDestination && !await this.#validateDestination()) return failure(0,'destination_not_public','bad_url');
      const send = () => fetch(url, {
        // workerd rejects redirect:'error' before I/O. Manual + the
        // explicit 3xx guard below preserves no-follow credential protection.
        method, redirect: 'manual',
        headers: {
          'x-api-key': this.#apiKey,
          accept: 'application/json',
          ...(body === undefined ? {} : {'content-type': 'application/json'}),
        },
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        signal: AbortSignal.timeout(Math.min(PANEL_TIMEOUT_MS,timeoutMs)),
      });
      response = await send();
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const kind: PanelErrorKind = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
      console.error(`pasarguard_request_failed method=${method} path=${path.slice(0, 60)} kind=${kind}`);
      return failure(0, kind, kind);
    }

    if (response.status>=300 && response.status<400) {
      // Never inspect Location/redirect bodies or resend a key to another URL.
      await response.body?.cancel().catch(()=>undefined);
      return failure(response.status,'redirect_rejected','rejected');
    }

    let json: unknown = null;
    try {
      json = JSON.parse(await limitedText(response));
    } catch {
      json = null;
    }

    if (!response.ok) {
      if (response.status === 404 && this.#strictAbsence && (path==='/api/user' || path.startsWith('/api/user/'))) {
        const detail = asRecord(json)?.['detail'];
        // Dynamic panels must return the supported user absence contract.
        // A proxy/route 404 is not evidence that the user was deleted.
        if (!path.startsWith('/api/user/') || typeof detail !== 'string' || !/^user not found$/i.test(detail.trim())) {
          return failure(404,'unverified_resource_absence','parse');
        }
        if (this.#requireGlobalAbsence && !await this.canVerifyAbsence()) {
          return failure(404,'resource_absence_scope_unverified','permission');
        }
      }
      const detail = errorDetail(json);
      console.error(
        `pasarguard_http_error method=${method} path=${path.slice(0, 60)} status=${String(response.status)}`,
      );
      return failure(response.status, detail);
    }

    if (method === 'GET') {
      if (response.status === 204 || json === null) {
        return failure(0, 'parse', 'parse'); // 2xx GET without usable body
      }
      const data = parser ? parser(json) : extractPanelUser(json) as T | null;
      if (data === null) return failure(response.status,'unexpected_response','parse');
      if (!parser) {
        const user = data as PanelUser;
        if (!user.id || !user.username) return failure(response.status,'missing_identity','parse');
        if (path.startsWith('/api/user/by-username/') && !path.endsWith('/reset') && user.username !== decodeURIComponent(path.slice('/api/user/by-username/'.length))) return failure(response.status,'username_identity_changed','identity');
        if (path.startsWith('/api/user/by-id/') && user.id !== path.slice('/api/user/by-id/'.length)) return failure(response.status,'external_identity_changed','identity');
        if (this.#expectedUserId && user.id !== this.#expectedUserId) return failure(response.status,'external_identity_changed','identity');
        try { await this.#onVerifiedUser?.(user); } catch { /* Cache failure must not change a verified API read. */ }
      }
      return {ok:true,data};
    }

    // POST/PUT/DELETE: a 2xx with an unusable envelope is still a SUCCESS
    // signal — the mutation happened; callers confirm with by-username reads
    // (for DELETE the confirmation read must come back 404).
    if (json === null) return { ok: true, data: null as T | null };
    const parsed = extractPanelUser(json);
    if (parsed && this.#expectedUserId && parsed.id !== this.#expectedUserId) return failure(response.status,'external_identity_changed','identity');
    return { ok: true, data: parsed as T | null };
  }
}

/** Never persist or relay untrusted error strings. */
function errorDetail(json: unknown): string {
  const record = asRecord(json);
  const detail = record?.['detail'];
  // Preserve the existing name-rejection UX without echoing any input.
  return typeof detail === 'string' && /username/i.test(detail) ? 'username_rejected' : 'panel_request_rejected';
}
