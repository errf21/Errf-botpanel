# PasarGuard Integration — English

🇬🇧 English · [🇮🇷 فارسی](../fa/pasarguard.md) · [index](README.md)

Everything in this page is read directly from `src/pasarguard/client.ts`,
`src/provision/provision.ts` and `src/catalog/provisioning.ts` — no assumed
endpoints.

**Creator / سازنده:** [Espierz](https://t.me/Espierz) · Telegram / تلگرام: [@Espierz](https://t.me/Espierz)

---

## 1. Panel requirements

- A **PasarGuard** subscription panel reachable over **HTTPS** from Cloudflare.
- The base URL goes in `wrangler.jsonc → vars.PASARGUARD_PANEL_URL` and is
  validated strictly (`client.ts:138-163`): protocol must be exactly `https:`,
  hostname non-empty, **no embedded credentials, no path beyond `/`** (the
  effective base becomes `url.origin`). Anything else → provisioning fails
  closed (`panel_url_rejected`) with no writes.
- An **API key** created in the panel's admin UI (API keys section), provided to
  the Worker **only** as secret `PASARGUARD_API_KEY`, sent **only** as the
  `x-api-key` header over HTTPS. Never logged, never sent anywhere else, never
  rendered into a Telegram message. Exact key permission names are a panel
  concern — **not determinable from this repository**.
- The provisioning groups referenced in the `provisioning` settings doc
  (`group_ids`, seed `[24,25]`) must exist and be sellable on the panel.
  Confirm group ids against your panel before first live order.
- **Templates**: the bot does not reference panel inbound/outbound templates at
  all — the create payload contains only the fields in §3 which are what the
  panel user-creation API accepts (wire contract re-confirmed by the authoring
  team against the dashboard's own `/statics/api-*.js` bundles in Phase 6).
  A template configured on the group is a panel-side decision outside this bot.

## 2. Endpoints actually used (complete list, from code)

| Method & path (client.ts) | Used by | Purpose |
| --- | --- | --- |
| `GET /api/user/by-username/{username}` | `getUserByUsername` (client.ts:239) | pre-check adoption on create; live status enrich in My Services; usage/expiry sweep reads; post-create confirmation |
| `GET /api/user/by-id/{id}` | `getUserById` (client.ts:253) | confirmation read after an envelope-less create |
| `POST /api/user` | `createUser` (client.ts:245) | purchase provisioning — **never auto-retried blindly** |
| `PUT /api/user/by-username/{username}` | `modifyUserByUsername` (client.ts:274) | renewal — sets an **absolute** `{expire: unix_seconds}` and nothing else |

Input guards inside the client: username `/^[A-Za-z0-9]{3,32}$/`, user id
`/^[0-9]{1,20}$/`, `expire` safe-int `1..4_000_000_000`; timeout
`PANEL_TIMEOUT_MS = 15_000` via `AbortSignal.timeout`; responses parsed
tolerantly (unwraps one level of `data|user|result` envelope; accepts
`id|user_id|userId`, `subscription_url|subscriptionUrl`; normalizes absolute unix
seconds; `data_limit=0/used` null = unlimited; POST/PUT 2xx with unusable body is
`ok:true,data:null` — the caller then **confirms by reading back**).
Subscription URLs are only accepted as absolute `http(s)` (joined to origin if
root-relative), capped 512, otherwise dropped (never shown).

Typed error kinds (`client.ts:30-39`): `not_configured`, `bad_url`, `network`,
`timeout`, `auth` (401/403), `not_found` (404), `rejected` (other 4xx), `server`
(≥500), `parse`. Detail text is stripped of control chars and sliced to 200 —
it is the only panel text that can reach admin logs/queues.

## 3. Create payload (purchase) — exact shape

Built in `provision.ts:526-536`:

| Field | Value | Unit |
| --- | --- | --- |
| `username` | `provisioning.username_prefix` + order ULID, **lower case**, sliced to 32 (claim on the order row happens BEFORE any panel call; `UNIQUE` column = duplicate guard) |
| `status` | `provisioning.default_status` (`active`/`on_hold`) | — |
| `data_limit` | `volume_gb × 1_000_000_000` | **SI bytes** |
| `expire_duration` | `duration_days × 86_400` | seconds (relative on create) |
| `hwid_limit` | chosen device/user count | — |
| `group_ids` | from `provisioning` doc | array of ints |
| `note` | `telbot:<order_id>` | link-back marker |

Local sanity caps before any network call (`provision.ts:49-54,105-122`):
`1 ≤ gb ≤ 4_194_304`, `1 ≤ days ≤ 36_600`, `1 ≤ devices ≤ 10_000`, else failure
`selections_invalid`.

## 4. Update payload (renewal extend)

`PUT by-username/{u}` with `{ expire: <absolute unix seconds> }` —
`target = max(now, panel-or-local expire) + duration_days×86_400`;
the target is **computed and claimed on the renewal order row
(`orders.renew_target_unix`) BEFORE the write**, so a retry (admin `🔁` /
`/failed`) converges: if the panel already shows `expire ≥ target`, the code
**adopts without re-PUT** — an ambiguous network result can never stack two
extensions. After the PUT it re-reads and requires `≥ target`, otherwise
failure `renewal_unverified` (nothing is booked on failure). Success books the
service row forward-only (`service_expires_at` never shortens) + `service_extended`
event; the renewal order goes `completed`. It never touches the service's
`pasarguard_user_id`/`subscription_url`/username.

## 5. Idempotency & concurrency design (why one order can't create two services)

1. Single guarded claim `approved→provisioning` (or `failed→provisioning` for
   retry) with `provision_attempts < max_attempts` **inside the UPDATE** —
   one winner among double-taps, replays, parallel isolates.
2. Username claimed on the order row first (UNIQUE violation = someone else owns
   it → stop).
3. `GET by-username` pre-check → **adopt** an existing service instead of POST
   (covers ambiguous timeouts).
4. A `409` from create → re-read the winner and adopt.
5. Every attempt verified by read-back before `completed`; `subscription_url`
   stored from that read.

## 6. Fail-closed no-op (unconfigured behavior)

`provisionOrder` performs **zero DB and zero network writes** and leaves the
order untouched (`approved` or `failed`) when any precondition fails
(`provision.ts:411-445`): missing key/URL, invalid `provisioning` doc,
`provisioning.enabled=false` (THE master switch over **all** panel writes —
creates AND extensions), or for renewals a missing/`enabled:false`/malformed
`renewal` doc. Skip reasons: `unconfigured | config_invalid | disabled |
renewal_disabled | renewal_unavailable`.

## 7. Error handling & operator loop

- Create/extend failure → order `failed` + sanitized short reason (panel `detail`
  ≤200 chars, no key, no raw HTML) — a push with a `🔁 retry` button goes to all
  admins, `/failed` lists the queue, retry re-enters through the same claim/cap.
- Customer-facing message on failure never includes the raw reason: they're told
  it's being handled (their receipt/money stays safe — an approved order cannot
  be re-charged; retry only re-provisions).
- Transient reads failing in My Services / notification sweeps **degrade to the
  D1 snapshot**; a `not_found` from a usage check on an expired/deleted panel
  account **settles** the notice row (`skipped`) instead of retrying forever.
- Live production proof: before the first real sell, the recommended manual step
  (documented as a one-time check in this repo's README model) is an
  **authenticated read-only GET** against a known username (e.g. via curl with
  `x-api-key`) to confirm host + auth + response shape — credentials handling
  identical to production (header only, never echoed). This is operational
  verification, **not automated in code**.

## 8. Security considerations

- `x-api-key` only over validated HTTPS origin; the key is never logged by any
  path in this repo (client details are redacted to `error=${name}` style).
- All panel **outputs** are treated as hostile display data: user records are
  parsed into a narrow `PanelUser`, subscription URLs re-sanitized, panel `note`
  never rendered (provenance is by order id), and admin-facing strings bounded
  and control-char-stripped.
- Panel **inputs** are constructed exclusively from server-side snapshots
  (`orders.selections`), never from keyboard payloads.

## 9. Operational checklist

```
□ HTTPS URL reachable from Cloudflare; no path components
□ API key created in panel, set as secret, never pasted anywhere else
□ group_ids verified against real panel group numbers (seed is [24,25])
□ provisioning doc `enabled:true` and parses (a malformed doc = strict no-op!)
□ username_prefix fits: ≤4 chars [a-z0-9] (28-char order id + prefix ≤ 32 cap)
□ read-only GET smoke test → then one cheap end-to-end test order through
  /pending → approve → receives subscription link → opens the page
```

---

Creator / سازنده: **[Espierz](https://t.me/Espierz)** · Telegram / تلگرام:
[@Espierz](https://t.me/Espierz) — [🇮🇷 فارسی](../fa/pasarguard.md)
