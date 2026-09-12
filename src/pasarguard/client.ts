/**
 * PasarGuard panel API client (Phase 5).
 *
 * The contract below was derived from the panel's own published JS bundle
 * (read-only GET inspection of /dashboard/ statics): the dashboard talks to
 * `/api/...` endpoints and ships a `subscription_url` (possibly root-relative)
 * on every user object. Server-to-server auth uses an API key created in the
 * panel's admin UI.
 *
 * Safety rules:
 *  - The API key is sent ONLY as the `x-api-key` header over HTTPS; it is
 *    never logged, never included in error details, never stored in D1.
 *  - NO automatic retries here: a retry of an ambiguous write could double
 *    create a service. Idempotency is handled one level up
 *    (`provision.ts` pre-checks `by-username` before every create).
 *  - Responses are parsed defensively; unexpected shapes degrade to typed
 *    errors instead of throwing.
 */

export const PANEL_TIMEOUT_MS = 15_000;

export interface PanelConfig {
  baseUrl: string;
  apiKey: string;
}

export type PanelErrorKind =
  | 'not_configured'
  | 'bad_url'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'not_found'
  | 'rejected'
  | 'server'
  | 'parse';

export type PanelResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: PanelErrorKind; status: number; detail: string };

/** Subset of the panel user object this bot understands. */
export interface PanelUser {
  id: string | null;
  username: string | null;
  status: string | null;
  subscriptionUrl: string | null;
}

export interface CreateUserPayload {
  username: string;
  status: 'active' | 'on_hold';
  /** Traffic cap in bytes (panel wire unit). */
  data_limit: number;
  /** Lifetime in seconds from creation (panel wire unit). */
  expire_duration: number;
  /** Concurrent-device cap. */
  hwid_limit: number;
  /** Panel access groups the service is created in. */
  group_ids: number[];
  /** Order cross-reference written into the panel's note field. */
  note: string;
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
  if (status === 401 || status === 403) return 'auth';
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
        username: stringField(record, ['username']),
        status: stringField(record, ['status']),
        subscriptionUrl: stringField(record, ['subscription_url', 'subscriptionUrl']),
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

  constructor(config: PanelConfig) {
    this.#baseUrl = config.baseUrl;
    this.#apiKey = config.apiKey;
  }

  /**
   * GET /api/user/by-username/{name}.
   * 404 maps to ok+null (the service genuinely does not exist yet);
   * every other failure is a typed error (never treated as "absent").
   */
  getUserByUsername(username: string): Promise<PanelResult<PanelUser | null>> {
    if (!/^[A-Za-z0-9]{3,32}$/.test(username)) {
      return Promise.resolve(failure(0, 'username_charset', 'rejected'));
    }
    return this.#request<PanelUser | null>(
      'GET',
      `/api/user/by-username/${encodeURIComponent(username)}`,
    );
  }

  /** POST /api/user — creates the service. NEVER auto-retried. */
  createUser(payload: CreateUserPayload): Promise<PanelResult<PanelUser | null>> {
    return this.#request<PanelUser | null>('POST', '/api/user', payload);
  }

  /** GET /api/user/by-id/{id} — confirmation read after an envelope-less create. */
  getUserById(id: string): Promise<PanelResult<PanelUser | null>> {
    if (!/^[0-9]{1,20}$/.test(id)) {
      return Promise.resolve(failure(0, 'user_id_charset', 'rejected'));
    }
    return this.#request<PanelUser | null>('GET', `/api/user/by-id/${encodeURIComponent(id)}`);
  }

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<PanelResult<T | null>> {
    const url = `${this.#baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'x-api-key': this.#apiKey, // header only; the value is never logged
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(PANEL_TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const kind: PanelErrorKind = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
      console.error(`pasarguard_request_failed method=${method} path=${path.slice(0, 60)} kind=${kind}`);
      return failure(0, kind, kind);
    }

    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok) {
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
      return { ok: true, data: (extractPanelUser(json) ?? null) as T | null };
    }

    // POST: a 2xx with an unusable envelope is still a SUCCESS signal —
    // the create happened; callers confirm details with by-username/by-id.
    if (json === null) return { ok: true, data: null as T | null };
    const parsed = extractPanelUser(json);
    return { ok: true, data: parsed as T | null };
  }
}

/** Pull a safe one-line message out of a panel error body (no secrets echo). */
function errorDetail(json: unknown): string {
  const record = asRecord(json);
  if (!record) return 'no_body';
  for (const key of ['detail', 'message', 'error', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    }
  }
  // FastAPI-style `detail` arrays: keep field names only.
  const detail = record['detail'];
  if (Array.isArray(detail) && detail.length > 0) {
    const first = asRecord(detail[0]);
    const loc = Array.isArray(first?.['loc']) ? (first['loc'] as unknown[]).join('.') : '';
    const msg = typeof first?.['msg'] === 'string' ? first['msg'] : 'invalid_payload';
    return `${msg} (${loc || 'unknown field'})`;
  }
  return 'no_message';
}
