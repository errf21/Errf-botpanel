# MraPanel DNS preflight / Worker fetch fix

## Baseline and preservation

Inspected public `master` at **a653a98ae173e5efc8121235df9e178339df1934**
(“Add scalable Cloudflare-configured panel management”), 231 tracked files.
Its source tree matches the previous local scalable-panel delivery; current
master was cloned separately rather than overwriting any existing local work.
The starting full suite actually passed: **799 tests, 0 failures/skips**.

Only the DNS/address validation and shared panel transport implementation plus
matching regression tests/documentation changed. Configuration, secrets, legacy
panel bindings, registry/synchronization, Telegram authorization, default panel,
financial code, migration state machine, encryption key and released migrations
remain unchanged. No new dependency, binding, secret or schema migration exists.
Do **not** rerun migration 0025 or change PANEL_COUNT/PANEL_1_* for this fix.

## Reproduced causal failure—not an assumption about Termux

`publicAddress('176.120.17.222')` returns true. NOERROR with absent or empty AAAA
Answer was already accepted by the baseline implementation. Lack of IPv6 alone
was **not** the root defect.

The baseline `publicDestination()` passed `redirect: 'error'` to `fetch()`.
Inside actual installed Cloudflare **workerd**, using the project's
`compatibility_date: 2026-09-01` and `nodejs_compat`, both A and AAAA requests
failed **before I/O** with this TypeError prefix:

> Invalid redirect value, must be one of "follow" or "manual" ("error" won't be implemented since it does not make sense at the edge; use "manual" and check the ...

The broad catch converted this into `false`. The API client's preflight then
returned `{ok:false,kind:'bad_url',status:0,detail:'destination_not_public'}`;
`src/panels/admin.ts::verifyConfiguration()` formats that into
**`test_bad_url_0`**. This reproduces the reported symptom with the real Worker
fetch implementation, without any panel API call or API key.

The panel client's subsequent `fetch()` also used the same unsupported option.
Changing only DNS would leave a second runtime failure. Both relevant transports
are corrected; no host whitelist or DNS bypass is used.

After the fix, the same local workerd probe made successful public Cloudflare DoH
requests: A Status 0 returned `176.120.17.222`, AAAA Status 0 returned no Answer,
and `publicDestination('https://panel.mrapanel.shop:8000')` returned **true**.
This was a real public DNS fetch from local workerd, not a mocked DNS result or
Termux lookup. It is **not** a claim to have accessed the deployed Worker's logs,
Cloudflare account, API key, or live authenticated panel API. Raw sanitized
before/after evidence is in `docs/evidence/mrapanel-workerd-dns.json`.

## Minimal transport fix and retained protections

- `src/panels/security.ts::publicDestination`: uses supported
  `redirect: 'manual'`. All DNS non-2xx responses, including redirects, fail
  closed; their bodies are cancelled without following Location. The same
  Cloudflare DoH endpoint, accept header, 5-second timeout, 32-KiB response bound,
  64-answer bound and both A/AAAA lookups remain.
- DNS JSON must be an object with numeric Status 0 and a non-truncated valid
  response. Absent/empty Answer is normal NODATA; malformed null/object records,
  wrong address types, non-string RDATA and truncated/oversized payloads reject.
  A/AAAA RDATA must match its declared address family. No addresses in either
  family, a failed query in either family, or **any** non-public address rejects.
- `publicAddress` retains existing private/loopback/link-local/reserved/multicast/
  special-purpose exclusions. Canonical IPv4 octets are now required, rejecting
  ambiguous leading-zero or oversized representations instead of interpreting
  them differently across resolvers. IPv6 guards remain unchanged.
- `src/pasarguard/client.ts::#request`: uses `redirect: 'manual'` and explicitly
  rejects **every 3xx** before parsing redirect bodies or inspecting Location.
  Returns fixed `{kind:'rejected',detail:'redirect_rejected',status:<3xx>}` and
  cancels the body. API keys never go to redirected destinations; no retry or
  cross-panel fallback was added.
- Initial panel requests still wait for successful preflight, then use exactly
  the configured origin and `x-api-key`. HTTPS/TLS verification remains native;
  no TLS override, IP substitution, private-host exception, port change,
  authentication change or query/credential stripping was introduced.
- Existing API timeout/redaction/parsing, strict absence and identity checks
  remain. Future DNS or panel failures may still correctly report typed errors;
  the fix does not pretend that every account/permission/endpoint is valid.

DNS preflight and later fetch remain separate resolutions, as documented before
this task; this is not an atomic DNS-pinned egress firewall. That existing
limitation has not been hidden or relaxed.

## Tests and results actually executed

| Check | Actual result |
|---|---|
| Baseline `npm test` | 799 pass, 0 fail, 0 skip |
| Final `npm test` | **876 pass, 0 fail, 0 skip, 0 cancelled** |
| `node --disable-warning=ExperimentalWarning --test tests/panelDestination*.test.ts` | **77 pass**, 0 fail/skip |
| `npm run typecheck` | Pass |
| `node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir <local>` | Pass; 901.63 KiB / gzip 176.78 KiB; no deploy |
| Real workerd outbound fixture | DNS and API fetch semantics pass; redirects are not followed; failed DNS sends no key |
| Real public Cloudflare DoH from local workerd | Before false/TypeError; after true/public A + no AAAA |
| Preservation checks | Configuration/bindings, admin/registry, origin/auth/encryption prefix, all migrations byte-identical to base |
| `git diff --check` | Pass |

The 77 new regressions cover IPv4-only, IPv4+IPv6, IPv6-only, no addresses,
transport and DNS-status failures, private/reserved/multicast/malformed addresses,
malformed/truncated/oversized JSON, CNAME chains, HTTP redirects/failures, reflected
secret rejection and cancellation. A permanent real workerd test executes the
actual DNS/client code with an isolated outbound service. No live panel API is
called and no production key is used.

Six existing fixture files had only their transport-option expectations updated
from unsupported `error` to supported `manual`. Their authorization, ownership,
header and lifecycle assertions remain; tests were not removed or weakened.
Explicit redirect rejection is now tested against real 3xx responses and workerd,
not just a mock that accepted an invalid RequestInit option.

No D1 migration commands were executed. The existing full-suite helper creates
new isolated SQLite fixtures using released schema files; no migration was
reapplied to an existing local or production D1 database. Existing permanent
workerd registry tests also use isolated synthetic D1 state, not the user's DB.

## Exact changed files

1. `src/panels/security.ts`
2. `src/pasarguard/client.ts`
3. `tests/panelDestination.test.ts` — new offline DNS/transport regressions
4. `tests/panelDestinationRuntime.test.ts` — new actual workerd fetch regressions
5. `tests/configuredPanels.test.ts` — transport expectation only
6. `tests/multiPanel.test.ts` — transport expectations only
7. `tests/multiPanelWorkflowAudit.test.ts` — transport expectation only
8. `tests/panelGroups.test.ts` — transport expectations only
9. `tests/pasarguard541.test.ts` — transport expectation only
10. `tests/serviceMigration.test.ts` — transport expectation only
11. `CHANGES.txt` — new notes; prior delivery notes preserved
12. `docs/en/mrapanel-dns-transport-fix.md` — this report
13. `docs/evidence/mrapanel-workerd-dns.json` — sanitized runtime evidence

## GitHub / Cloudflare status and release boundary

A read-only public GitHub check for the **existing baseline** a653a98 reported
`Workers Builds: errf-botpanel`, completed, conclusion **success**. That proves a
successful pre-existing build check, not authenticated runtime verification or a
deployment of this new fix. The GitHub combined legacy status endpoint had no
status entries; the completed check-run was examined separately.

HTTPS push availability failed with `could not read Username for
'https://github.com'`. No authenticated GitHub credentials are available in this
environment. The final local commit ID is recorded in the handoff/verification
artifact. This fix was **not pushed or deployed**. No Cloudflare account API,
production configuration/secret, D1 data, selected panel or legacy credentials
were read or changed. Production runtime/deployment of the new fix is therefore
**not verified / not performed**—not reported as Ready or successful.

After approved integration/deployment of the source, keep the current
`PANEL_COUNT=1`, `PANEL_1_URL`, `PANEL_1_NAME`, `PANEL_1_API_KEY`, bot/admin settings,
`PANEL_ENCRYPTION_KEY`, D1 binding and existing Cron unchanged. Run the existing
private-admin `/panels` → **Test MraPanel**. The DNS preflight should no longer
fail merely because Workers rejects a request option or IPv6 is absent. Actual
TLS/port reachability, account status, permissions and configured groups still
require that authorized read-only live test. No key should be posted in chat or
shared logs. Do not force selection/enablement, bypass validation, rerun migration
0025, rotate a key or modify the origin to hide a different failure.

## Separate pre-existing issue, deliberately not altered

`src/telegram/api.ts::sendMessageDelivery` also contains `redirect:'error'`.
It is not involved in the panel test's regular sendMessage path. The same runtime
restriction means this separate recoverable-delivery transport needs its own
scoped follow-up. It was left byte-identical, rather than silently changing
announcement/migration-delivery behavior during this panel-only fix.

## Artifacts / APK

The complete source ZIP contains all tracked final files and excludes .git,
node_modules, caches, .dev.vars and local databases. The patch applies to the
exact baseline above, not an older delivery. Verification checks ZIP integrity,
every source byte and patch application/reconstructed tree equality.

This is a TypeScript Cloudflare Worker project with no Android/Gradle/APK build
pipeline. **No APK exists or is fabricated.** Source ZIP + Changes TXT are the
appropriate deliverables, with patch/report/evidence provided for review.
