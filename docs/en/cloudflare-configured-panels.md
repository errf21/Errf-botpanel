# Cloudflare-configured PasarGuard panels

This extends the existing D1 panel registry; it does not replace Telegram-created
panels, the legacy API key, panel selection, service ownership, or migrations.
No username/password login, bearer-token acquisition, new Cloudflare product,
new runtime dependency, or per-panel source-code change is required.

## Required release ordering

1. Preserve the current D1 database and take a recoverable backup through your
   existing operational process. Preserve every existing secret and variable.
2. Review pending announcements and provisioning/migration work. Coordinate a
   cutover without overlapping old and new announcement processors. Retain the
   existing `*/5 * * * *` Cron; no additional trigger or Queue is needed.
3. Apply outstanding versioned migrations **0001 through 0025 in order** using
   the existing Wrangler migration mechanism. A current 0024 installation needs
   only `0025_cloudflare_panel_bindings.sql`. Do not replay released SQL manually.
   The new migration adds nullable `panels.credential_binding` and
   `panels.binding_fingerprint`; it changes no existing record or association.
   Migrations 0023 and 0024 must already be applied for the existing reliability
   and financial implementation before activating this Worker.
4. Activate this Worker through your approved release process. Initially leave
   all new configured panels disabled. Do not enable/select them while an older
   Worker version is still receiving Telegram traffic or scheduled invocations:
   older code cannot resolve Worker-backed registry rows. Do not use a mixed
   gradual rollout once configured panels are enabled.
5. Configure bindings in the **same Worker and environment** that serves
   `/telegram/webhook` and the Mini App origin. Open `/panels` to synchronize and
   explicitly validate/enable/select each desired panel.

Commands below describe future authorized operator actions; none were executed
against production during implementation:

```sh
# After release approval, not as part of local validation:
npx wrangler d1 migrations apply telbot-db --remote
# Enter a panel key in Wrangler's private interactive prompt, never an argument:
npx wrangler secret put PANEL_1_API_KEY
```

Cloudflare Dashboard location: **Workers & Pages → errf-botpanel → Settings →
Variables and Secrets**. Use the matching named environment if applicable.
Use type **Secret** for API keys, never ordinary Text or JSON. Saving a new
configuration version may require activating that version through Cloudflare;
subsequent Telegram panel switches do not require code changes or redeployment.
`wrangler.jsonc` has `keep_vars: true`; preserve that flag and your deployment
pipeline's variable policy. Explicit repo defaults such as an empty
`ADMIN_CHAT_ID` can still override values if blindly deployed. Merge/review the
existing real settings rather than replacing them with example defaults.

## Choose exactly ONE declaration mode

Do not set multiple mode variables together. Conflicting or malformed mode
configuration fails closed for affected Worker-managed panels; it never resets
selection to another panel. Unset all mode variables if there are no managed
panels. To intentionally retire indexed declarations, use `PANEL_COUNT=0`.

### A. Indexed bindings: simplest for a small/moderate fleet

Ordinary **Text** variables:

| Name | Example / format |
|---|---|
| `PANEL_COUNT` | `3`, decimal integer 0–99 |
| `PANEL_1_URL` | `https://germany.example.com` |
| `PANEL_2_URL` | `https://netherlands.example.com:8000` |
| `PANEL_3_URL` | `https://finland.example.com` |
| `PANEL_1_NAME` | `Germany` (optional, initial display name) |
| `PANEL_2_NAME` | `Netherlands` (optional) |
| `PANEL_3_NAME` | `Finland` (optional) |
| `PANEL_1_GROUP_IDS` | `[17,18]` (optional, initial numeric group IDs as JSON) |
| `PANEL_2_GROUP_IDS` | `[23]` (optional) |
| `PANEL_3_GROUP_IDS` | `[31]` (optional) |

Required **Secrets**: `PANEL_1_API_KEY`, `PANEL_2_API_KEY`,
`PANEL_3_API_KEY`, each containing that panel's existing generated PasarGuard
API key, with no whitespace/control characters. The printable-ASCII shape
validation matches the existing client (1–4096 characters); actual validity and
permissions are verified by the explicit connection test, not by string shape.

Stable registry IDs are `cf_1`, `cf_2`, `cf_3`. To add another panel, add
`PANEL_4_URL` and secret `PANEL_4_API_KEY`, optional name/groups, then increase
`PANEL_COUNT` to `4`. No TypeScript edit is required. Slots from 1 through count
are explicit, not discovered by enumerating arbitrary bindings.
**Never renumber/reuse slots for different hosts.** An accepted origin is
immutable under its stable ID, including when it currently has no services.
Use a new slot/ID for a different panel. Omitting a slot within count creates an
unusable entry; it does not redirect its services elsewhere.

### B. Named manifest: fewer bindings and stable geographic IDs

Set ordinary Text variable `PANEL_MANIFEST` to a JSON array, e.g.:

```json
[
  {"id":"cf_germany","name":"Germany","url":"https://germany.example.com","apiKeyBinding":"PANEL_GERMANY_API_KEY","groupIds":[17,18]},
  {"id":"cf_netherlands","name":"Netherlands","url":"https://netherlands.example.com:8000/dashboard/#/login","apiKeyBinding":"PANEL_NETHERLANDS_API_KEY","groupIds":[23]},
  {"id":"cf_finland","name":"Finland","url":"https://finland.example.com","apiKeyBinding":"PANEL_FINLAND_API_KEY","groupIds":[31]}
]
```

Create the three referenced **Secrets** separately. `apiKeyBinding` is only a
binding NAME, not a key value. Do not put keys in this manifest. IDs must match
`cf_[a-z0-9_-]{1,29}`; references must match
`PANEL_[A-Z0-9_]{1,48}_API_KEY`. Display names are optional, maximum 64 characters;
omitted names use the stable ID. Groups are optional initial IDs only.
Preserve IDs/origins when reordering or growing the array.

### C. Sharded manifest for larger configurations

Unset `PANEL_COUNT` and `PANEL_MANIFEST`; set ordinary Text
`PANEL_MANIFEST_COUNT` to 1–20, and Text `PANEL_MANIFEST_1` through
`PANEL_MANIFEST_N`, each a JSON array using the same descriptor schema above.
Each shard must be at most 5120 UTF-8 bytes. Combined descriptors must not
exceed 99. All referenced API keys remain separate Secrets. A malformed shard
is reported with a redacted code; valid independent shards still synchronize.
Missing declarations can retire previously configured rows, so inspect all
shards before activating a configuration change.

### Real limits—not unlimited panels

The existing registry cap is **100 total panels**, including `legacy`,
Telegram-created panels, retired rows, and Worker-managed rows. Thus at most
99 Worker declarations are accepted and fewer may fit an existing registry.
Cloudflare currently documents **64 combined text variables + secrets on Free**,
**128 on Paid**, and **5 KB per variable**. Count existing bot secrets/variables
against this budget. Indexed mode uses at least two bindings per panel plus
count, and optional name/groups consume more; the practical limit is much lower
than 99 in that mode. Manifest mode/shards consolidate ordinary metadata, but
still require one secret per panel and remain subject to plan/runtime/API limits.
Do not assume that a 99-panel configuration fits Free or that every plan can
process arbitrarily many simultaneous API requests.

Platform source: https://developers.cloudflare.com/workers/platform/limits/
(verified against the official Cloudflare docs source during implementation).
Actual indexed lookup and concurrent synchronization were also executed in
local Cloudflare **workerd/D1**, not inferred from JavaScript alone.

## Existing settings: preserve, do not rotate

| Existing setting | Kind | Required action |
|---|---|---|
| `DB` | D1 binding | Preserve existing `telbot-db` database and actual ID |
| `TELEGRAM_BOT_TOKEN` | Secret | Preserve; Mini App HMAC and managed-credential revision fingerprint depend on it |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | Preserve; webhook authentication is unchanged |
| `PASARGUARD_PANEL_URL` | Text | Preserve existing legacy origin; do not register its alias as another panel |
| `PASARGUARD_API_KEY` | Secret | Preserve existing working legacy key; never copy it into a new manifest |
| `PANEL_ENCRYPTION_KEY` | Secret | Preserve EXACTLY; existing Telegram-managed AES-GCM credentials must remain decryptable |
| `ADMIN_CHAT_ID` | Text | Preserve the authorized administrator's positive numeric Telegram user ID |
| `PANEL_ADMIN_IDS` | Text, optional | Existing comma-separated positive numeric additional panel-admin IDs |
| `PANEL_ADMIN_ORIGIN` | Text | Existing exact public HTTPS Worker/Mini App origin, no path/query/credentials |
| `PAYMENT_CARD_NUMBER` | Secret, existing payment feature | Preserve; unrelated to panel registration |
| `SUPPORT_CONTACT` | Text, optional | Preserve; unrelated support setting |

No password, login-safety, bearer-token, or new encryption secret is required.
Do not remove unrelated existing settings. Database `customers.is_admin` grants
only existing general-admin permissions; it does **not** authorize panel control.
Panel controls require `ADMIN_CHAT_ID` or `PANEL_ADMIN_IDS`, and private Telegram
chat. Mini App endpoints additionally validate fresh bot-token-signed initData,
current allowlist, owner-bound expiring sessions, expected Origin, revisions,
and one-time save/confirmation consumption. Missing allowlist/token fails closed.

## Telegram workflow

1. Authorized administrator opens a **private** bot chat and sends `/panels`.
   Synchronization also runs on Telegram dispatch and the existing five-minute
   schedule. New rows start **disabled** / `not_tested`; selection is untouched.
2. Find the stable ID/name. Use **Next/Previous** if needed (five rows per page).
3. If groups were not seeded, press **Edit <name>**. The authenticated Mini App
   shows a read-only managed URL and no key input. It fetches real `/api/groups`
   results; select at least one valid group via checkbox rows or Select All,
   then **Test and save securely**. IDs, not names, are saved. No hardcoded group
   fallback exists. Names/groups become D1-managed after first registration;
   later binding synchronization does not overwrite Telegram edits.
4. Press **Test <name>**. This verifies HTTPS/public DNS, API-key authentication,
   active account, declared user permissions, and each configured group through
   read-only APIs. A successful test is a snapshot, not continuous health or live
   mutation proof. Insufficient groups/permissions/key reject activation.
5. Press **Enable new orders → Confirm** if disabled.
6. Press **Select <name> → Confirm**. `/panels` shows the persisted destination
   for NEW services. Repeat these controls to switch back to legacy or another
   enabled, tested panel. No redeployment is needed for switching.
7. **Disable new orders → Confirm** stops future assignment without preventing
   management of services already bound to that panel.

Assigned retries, renewals/repurchases, resets, status, URLs, notifications,
recovery, and migration resources use their stored panel. New unassigned orders
use a fresh selection revision and persist the panel/configuration claim before
remote provisioning. A switch mid-operation cannot change that claim. Failures
never silently fall back. Failed orders can remain assigned and recover on the
same host after repair; disabling a selected panel does not select another one.

## Synchronization, updates and retirement

- Repeat synchronization is idempotent: no duplicate registry rows, audit
  registrations, auto-enabling, default changes, order updates, or history loss.
- Legacy and Telegram-created entries coexist. Stable `cf_*` collisions cannot
  take over an encrypted/dynamic row. Duplicate origins are rejected; existing
  registered owners take precedence over later duplicate declarations.
- Worker keys stay in Worker secret storage; D1 stores only the binding reference
  and a keyed HMAC revision fingerprint. Dynamic panels keep AES-GCM D1 storage.
  The fingerprint uses the existing bot token with domain separation and
  includes the canonical origin, binding name and key. It is not a plaintext key
  or publicly computable unkeyed digest. Bot-token rotation triggers managed
  revision invalidation/re-testing; encryption-key rotation is NOT part of this
  feature. Keep bot/credential changes coordinated across versions.
- Changing a managed key/reference disables NEW creation, increments its
  revision, and clears its test; explicitly test/enable again. Existing service
  operations still resolve the same stable host with the current key. An origin
  change under an existing ID is blocked instead of sending its new key to an old
  host. Use a new ID; move services only through explicit validated migration.
- Keep declarations and secrets for any panel owning historical/live services,
  assigned pending orders, observations, or migration resources. Removing them
  cannot magically preserve remote access: the row/history stays, new creation
  is disabled and missing configuration fails closed with no cross-panel fallback.
- Telegram deletion is blocked while a managed declaration exists. After an
  intentional declaration removal, all existing selection/history/migration/
  observation guards still apply. No automatic reassignment or remote deletion
  is performed. Do not remove secrets merely to hide a panel; use Disable.
- Misconfiguration diagnostics contain controlled codes, never supplied secrets.
  One inaccessible independent panel does not disable unrelated valid panels.

## Dashboard URL error: verified cause and remaining incident diagnosis

Public master `e3b565910991da82cf64e1eb89d478a89afb7967` already normalizes
administrator input in both form and Worker routes. Port 8000 is already allowed;
this implementation does NOT repeat the old port change.

Verified reproductions:

- `https://panel.MraPanel.shop:8000/dashboard/#/login`
  → `https://panel.mrapanel.shop:8000` at the input boundary.
- `https://panel.mrapanel.shop:8000` → accepted strict origin.
- `https://panel.mrapanel.shop:444` → rejected.

Confirmed misleading-message bugs: Persian text still prohibited paths after
the normalizer was added; downstream public-DNS/client `bad_url` failures were
mapped to the SAME `invalid_origin` code as malformed input. Both are corrected:
syntax is HTTP 400 `invalid_origin`, downstream public-destination validation is
HTTP 502 `destination_check_failed`, and credentials/permissions remain distinct.
Dashboard normalization is also used for Worker-configured input; stored origins,
Mini App origin, per-request public DNS and redirects remain strictly validated.

The exact live incident (wrong Worker route/stale version versus DNS rejection)
cannot be established without the actual Worker/Mini App hostname and request
response evidence. No live deployment or panel API was tested. If the literal
old English path-prohibition text persists, it is not the English message in
this current source. Check actual routing/version rather than relaxing security.

Post-release, a fresh generic form response from the expected Mini App hostname
must contain header **`x-errf-panel-ui: cloudflare-bindings-v1`** and HTML meta
`errf-panel-form-version=cloudflare-bindings-v1`. These are non-secret release
markers, not authentication. Check Network response status/code for `/groups`,
confirm the submitted URL and Worker host, and check public A/AAAA/TLS access.
Never export request bodies containing initData or keys into shared logs.
DNS timeouts, private A/AAAA answers, TLS errors and inaccessible port 8000 must
not be bypassed. Redirects remain rejected, and query/userinfo URLs are rejected
rather than stripping potentially sensitive parameters into a valid URL.

## Staging checks and rollback limitations

Before production: use disposable panels/accounts and customers; verify Test,
visual groups, three-panel selection, paid/free/admin-created orders, retries,
renewal/reset/status/URL/deletion, notifications and cross-panel migration. Check
that every remote request uses its saved panel and that a failing panel creates
no resource on another host. Test invalid URL/key and fail-closed unauthorized
Mini App requests. Real network compatibility, DNS/TLS and Telegram delivery are
not proven by mocks or local workerd alone.

Migration 0025 can be rolled back transactionally before activation in an
isolated test. After application, leave the additive columns in place. A plain
rollback to old Worker code is **not safe** once any order/active migration uses a
managed panel: old code cannot read Worker-secret references. Prefer a forward
fix, or an explicitly approved bridge supporting these rows before rollback.
Do not delete registry/financial/history rows or change `panel_id` to force a
rollback. Until activation/assignment, select legacy/disable managed panels and
verify no pending work references them before considering old-code rollback.
No production commands or secret/configuration changes were performed by the
implementation task.
