# Scalable panel implementation — evidence and handoff

## Exact source and scope

Baseline: public `master` **e3b565910991da82cf64e1eb89d478a89afb7967**,
224 tracked files, “Normalize panel dashboard URLs before registration”.
Its code was compared with the previous tested local origin-fix implementation:
functional source matched except stale Persian origin wording; differences in
historical CHANGES/report packaging were identified rather than hiding them.
The baseline suite and TypeScript check were rerun before edits: **754 passed**,
zero failures/skips. No older vanilla tree was substituted.

Final complete suite: **799 passed, 0 failed, 0 skipped, 0 cancelled**,
including **45 new tests**. No existing test was weakened, removed or skipped.
No package or lockfile changes; reused existing installed dependencies.

## Implemented architecture

`src/panels/bindings.ts` parses explicitly counted indexed or named/sharded
manifest declarations, securely resolves named Worker secrets, and synchronizes
registry metadata. It never enumerates env, persists raw keys, sends user writes
while synchronizing, changes `panel_selection`, or overwrites order assignments.
CAS revisions + atomic D1 audit batches handle concurrent initialization.
Secret/origin/binding revisions are keyed HMAC fingerprints using the existing
bot token. Only initial names/groups are seeded from bindings; Telegram edits
are retained. A configured panel begins disabled/untested. Test→Enable→Select is
explicit. Changed keys disable new assignment until retested. Origins cannot be
repointed under existing IDs. Removed declarations retire rows without deleting
history, and unresolved ownership never falls back.

One implementation-stage isolation defect was reproduced and corrected before
handoff: a newly added `cf_10` duplicate sorted before an existing `cf_2` owner,
which could have disabled that existing owner. Registered immutable owners now
take precedence; later duplicates are rejected. A permanent regression verifies
unchanged existing revision/fingerprint/enabled flag and selected panel.

`src/panels/registry.ts::resolvePanel` feeds managed credentials into the same
`x-api-key`, typed/redacted-error, public-DNS, redirect-rejecting API client used
for existing dynamic panels. `clientFor` remains shared. Existing legacy
configuration uses its unchanged original resolver. No password/token flow was
introduced. Managed metadata DTOs only add `managed: true`; they return no key,
ciphertext, fingerprint or secret binding name. The generic GET remains empty of
existing metadata. Valid signatures/freshness/current admin allowlist and
owner-bound sessions remain mandatory for sensitive POST endpoints.

## Purchase/lifecycle code-path review

- `src/provision/provision.ts::provisionOrder`: unassigned new purchase uses fresh
  D1 selection; assigned retry or lifecycle operation resolves assigned/original
  service panel, never the current default as substitute. Claim persists stable
  panel/configuration and checks panel/selection revisions before remote requests.
- `src/db/orders.ts::claimOrderForProvisioning`: existing atomic assignment and
  claim ownership unchanged. No business workflow rewrite was necessary.
- Free-trial/admin-approved services use that same provisioner; regression tests
  verify managed trial and approved order routing before the first remote request.
- Renewal and repurchase/reset use origin-service ownership/configuration.
- Customer status/URL refresh calls through dispatch, deletion through
  `deletePanelService`, notifications through `runServiceNotificationSweep`,
  and pending work through `recoverPanelOperations` use the shared resolver.
- Subscription migration resolves original/current/destination panel IDs through
  the existing shared registry; its state machine, entitlement, revocation,
  observation and financial protections were not changed.
- Remaining direct legacy binding references are confined to legacy resolution,
  duplicate-origin guards, health's existing key-presence boolean, and migration
  evidence fallback for legacy origin—not a new-service global routing bypass.

Tests use independent mock origins/keys with intentionally equal external IDs.
They exercise confirmed Telegram selection across three panels, a switch during
creation, uncertain create/reconcile retry, original ownership after switching,
renewal, repurchase/reset, status/URL callbacks, notifications, deletion and
scheduled recovery. They assert the panel/config claim exists before POST and
that no unintended host receives a request.

## Dashboard validation: confirmed facts versus live incident

The baseline already allowed port 8000 and normalized dashboard links in the
frontend and Worker. This work did not blindly repeat the port change.

Confirmed old code issues: Persian UI dictionary still instructed “no path”,
and `/admin/panels/groups` returned `invalid_origin` for a downstream client's
`bad_url` caused by public-destination/DNS validation. This conflated valid
normalized input with DNS failure. Corrected to distinct 400 syntax versus 502
`destination_check_failed`, retaining auth/permission classifications. Persian
wording now agrees with English. Non-secret header/HTML release markers support
checking the actual Mini App route/version after authorized deployment.

The exact inputs requested in prior troubleshooting are reproduced by tests:
full uppercase-host dashboard URL normalizes to
`https://panel.mrapanel.shop:8000`, canonical 8000 is valid, port 444 is rejected.
SSRF/public DNS and redirect enforcement remain intact. No API key requested.

**Not verified:** the actual deployed Worker hostname, active route/version,
request body or response from the user's incident. The literal old English
path-prohibition error is not the current English source message. A stale/wrong
Worker route is possible, but was not claimed as proven. A Ready deployment in
Cloudflare does not itself establish which Worker serves the Mini App hostname.

## Executed validation

| Check | Actual result / isolation |
|---|---|
| Baseline `npm test` | 754 passed; 0 failures/skips |
| Final `npm test` | 799 passed; 0 failures/skips/cancelled; ~45 seconds locally |
| `npm run typecheck` | Passed |
| `node --disable-warning=ExperimentalWarning --test tests/configuredPanels*.test.ts` | 45 passed; 0 failures/skips |
| `wrangler deploy --dry-run --outdir <local-directory>` | Passed; 900.26 KiB, gzip 176.44 KiB; no deploy |
| Indexed env lookup and concurrent registry sync inside actual installed workerd with local D1 | Passed; no binding enumeration; one registration/audit per row; selected ID retained |
| Local Wrangler fresh migrations 0001–0025 | Passed |
| Local Wrangler seeded 0024→0025 upgrade | Passed; all 29 application tables/original columns preserved; 25 migration records |
| Local Wrangler repeat apply | Passed; “No migrations to apply” |
| Local D1/SQLite foreign key checks | Zero violations |
| Transactional 0025 rollback / direct raw repeat | Rollback preserves data; raw repeat rejects duplicate columns safely, no data rewrite |
| New-file formatting / whitespace check | TypeScript printer used; `git diff --check` passed |
| GitHub push availability | HTTPS dry-run failed: no authenticated Username; no push |

Wrangler 4.131.1 and installed Miniflare 5/workerd were reused. The installed
Miniflare version required its bundled `convertV4MiniflareOptions` adapter; early
constructor schema errors were tooling-configuration errors, corrected before
the successful permanent runtime test. An attempted Prettier command could not
run because that package was absent in the restored environment. No dependency
was installed; new files were formatted with the installed TypeScript printer.
There is no separate lint/format script in this project's package.json; no lint
success is fabricated.

API network tests are **offline mocks**, not live PasarGuard. The local workerd
binding/D1 test is real runtime execution but has synthetic credentials and no
remote panel API. Synthetic migration fixtures are not production exports.
No Telegram send, real customer migration, certificate or live permission test
against a real panel was performed.

## Changed files

- `src/panels/bindings.ts` — declaration loader, secure references, fingerprint,
  immutable identity, duplicate isolation, idempotent sync/retirement.
- `src/panels/registry.ts` — managed resolver and shared cap, optional row fields.
- `src/panels/admin.ts` — authorized synchronization, managed edit guards/DTO,
  deletion guard, safe labels, distinct DNS errors, release header.
- `src/panels/form.ts` — read-only managed URL/hidden key, localized explanation,
  correct error mapping, non-secret release marker.
- `src/dispatch.ts` — safe binding sync before normal dispatch.
- `src/index.ts` — safe sync before existing scheduled sweeps.
- `src/types.ts` — three optional mode bindings, no env enumeration contract.
- `src/telegram/texts.ts`, `src/telegram/texts.en.ts` — matching new form/error
  texts; corrected Persian origin guidance.
- `migrations/0025_cloudflare_panel_bindings.sql` — additive nullable metadata.
- `tests/helpers.ts` — fresh fixture includes 0025.
- `tests/configuredPanels.test.ts` — handlers, browser and multi-panel lifecycle.
- `tests/configuredPanelsRuntime.test.ts` — actual workerd/local D1 concurrency.
- `tests/configuredPanelsSchema.test.ts` — preservation, rollback, raw repeat.
- `docs/en/cloudflare-configured-panels.md` — exact bindings/setup/release guide.
- `docs/en/scalable-panels-implementation-report.md` — this evidence report.
- `README.md` — setup guide link.
- `CHANGES.txt` — new delivery notes; previous notes retained.

No released migration, pricing, wallet/referral/top-up money logic, announcement
lease/counter behavior, entitlement logic, or migration state machine changed.

## Packaging and release boundary

The final ZIP is generated from every tracked final source file, not node_modules,
`.git`, `.dev.vars`, local D1 databases, caches, or production secrets. Packaging
verification compares every ZIP entry with the final Git/source bytes.
The unified patch is against the exact tested baseline commit above; verification
runs `git apply --check`, applies to an isolated copy of that baseline, then
compares every final path and byte. A matching baseline ZIP is also supplied.
Final packaging hashes/verification and local commit ID are recorded in the
separate artifact-verification JSON accompanying the delivery.

A local commit is authorized; authenticated remote push is unavailable. No
Cloudflare deployment, remote D1 migration, production query/configuration/secret
change, encryption-key rotation, release publication or remote push occurred.

## Remaining operational risks and staging requirements

- Cloudflare's practical binding/query/CPU limits may be below the registry cap.
  A large initial fleet causes more synchronization D1 operations than adding
  one panel. Independent failed registrations are reported and can converge on
  subsequent dispatch/scheduled sync; no default is changed. Validate plan budgets
  and initial batch sizes in staging, especially on Free, rather than assuming
  this entire bot's existing financial/provisioning workload fits Free limits.
- Test live PasarGuard/API permissions/group contracts, public A+AAAA resolution,
  TLS/8000 reachability, redirects, Telegram initData on mobile clients, and actual
  configuration delivery against disposable staging panels.
- Read-only connection tests cannot prove real mutation permissions/connectivity;
  test purchases/renewals/migrations only in an explicitly approved disposable
  staging environment, not production.
- Deleted/rotated bindings cannot preserve old remote management without valid
  current credentials; retain declarations/secrets for referenced panels.
- Key/host/version configuration changes must be coordinated. Old Worker code
  cannot resolve managed rows; no mixed rollout or simplistic old-code rollback
  after assigning services. Never force database reassignment to bypass this.
- Existing rate limits, ambiguous Telegram delivery and source-revocation
  limitations remain; they were not renamed “exactly once” or claimed live-tested.

Use the setup guide's explicit authorized staging/release checklist before
activation. This handoff is implemented and locally validated, not a claim of
live production compatibility or completed deployment.
