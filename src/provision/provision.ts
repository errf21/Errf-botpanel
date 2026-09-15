/**
 * Provisioning orchestration (Phase 5 + 6): the ONLY module that writes to
 * PasarGuard. Two kinds of work, chosen by the order row's `kind`:
 *
 *  purchase (approved/failed retry): claim → pre-check GET by-username (an
 *  existing service is ADOPTED, never blindly re-created) → POST /api/user
 *  with an ABSOLUTE `expire` → verify the panel's expiry (read-back; one
 *  corrective PUT when missing/insufficient) → finalize completed + the
 *  VERIFIED panel expiry. Never completes on an Unlimited service.
 *
 *  renewal (approved/failed retry): resolve the linked service row → claim
 *  an ABSOLUTE expiry target on the renewal row BEFORE any panel write →
 *  GET: if the panel already shows ≥ target, the write is an adopt (no PUT);
 *  otherwise PUT {expire: target}, verify ≥ target, then complete the renewal
 *  and book the new expiry forward onto the SERVICE row. Because the target
 *  is claimed-deterministic, an admin retry after an ambiguous timeout can
 *  never stack a second extension.
 *
 * Race-safety (both kinds): exactly one caller can move an order into
 * `provisioning` (single guarded UPDATE + affected-row check). Rows stamped
 * with the `panel_deleted` disposition (0015) are claimed-blocked there and
 * refuse the create/renewal paths outright — a deleted service never returns.
 *
 * Phase 1-4 invariant preserved: when the panel, the provisioning document
 * or (for renewals) the renewal document is NOT configured, these paths make
 * ZERO database or network writes and the order stays where it is.
 *
 * Phase 16: `deletePanelService` is the panel module's ONLY deletion writer
 * (admin surface calls into this file, never straight into the client).
 */
import type { Env, TelegramApiLike } from '../types.ts';
import type { CreateUserPayload, PanelUser } from '../pasarguard/client.ts';
import { loadPanelConfig, PasarGuardClient, resolveSubscriptionUrl } from '../pasarguard/client.ts';
import { loadProvisioningConfig } from '../catalog/provisioning.ts';
import type { ProvisioningConfig } from '../catalog/provisioning.ts';
import { MB_BYTES } from '../catalog/freeTest.ts';
import { loadRenewalConfig } from '../catalog/renewal.ts';
import {
  bookRenewalOnService,
  claimOrderForProvisioning,
  claimOrderUsername,
  claimRenewalTarget,
  completeProvisionedOrder,
  completeRenewedOrder,
  failProvisionedOrder,
  getOrderById,
} from '../db/orders.ts';
import type { OrderRow } from '../db/orders.ts';
import { getCustomerContact, resolveAdminChatIds } from '../db/customers.ts';
import { isValidOrderId } from '../lib/validate.ts';
import { adminProvisionFailedKeyboard, serviceReadyKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { FA_UI, uiFor } from '../telegram/i18n.ts';
import type { Ui } from '../telegram/i18n.ts';

/**
 * 1 GB of panel traffic = 2^30 bytes: the panel displays `data_limit` in GiB,
 * so a selected N GB must arrive as exactly N × 1_073_741_824 bytes to render
 * as « N » (live proof: 10^9 bytes displayed as 9.31). The free-test MB
 * conversion (catalog/freeTest.ts MB_BYTES) deliberately stays SI.
 */
export const GB_BYTES = 1_073_741_824;
export const DAY_SECONDS = 86_400;

const MAX_GB = 4_194_304; // sanity cap on the snapshot volume_gb (wire bytes stay far below 2^53)
const MAX_DAYS = 36_600; // ~100 years
const MAX_DEVICES = 10_000;
/** Free-test volume cap: snapshot `volume_mb` must stay inside this range. */
const MAX_MB = 100_000;
/** Clock-skew tolerance (seconds) when verifying a create's ABSOLUTE expiry. */
const EXPIRY_SLACK_SECONDS = 300;

export type ProvisionSkipReason =
  | 'unconfigured'
  | 'config_invalid'
  | 'disabled'
  | 'renewal_disabled'
  | 'renewal_unavailable';

export type ProvisionOutcome =
  | { ok: true; order: OrderRow; attempted: true }
  | {
      ok: false;
      error:
        | 'invalid_id'
        | 'not_found'
        | 'state_changed'
        | 'attempts_exhausted'
        | 'provision_failed';
    }
  | { ok: false; skip: ProvisionSkipReason };

export interface ProvisionDeps {
  env: Env;
  db: D1Database;
  api: TelegramApiLike;
}

/**
 * Panel-side service removal (Phase 16 admin surface — the ONLY deletion
 * writer). Same contract as every other write from this module: exactly one
 * attempt, never auto-retried, and the panel's OWN read-back is the only
 * proof accepted. A confirmed 404 after the call (whether the DELETE landed
 * or the service was already gone) is success; ANYTHING else — 2xx with the
 * user still present, an unreadable record, auth/server/transport failure on
 * either call — fails CLOSED with a sanitized reason and changes nothing
 * local. Callers book `panel_deleted` ONLY after `ok: true`.
 */
export type PanelDeleteOutcome =
  | { ok: true; alreadyGone: boolean }
  | { ok: false; reason: string };

export async function deletePanelService(
  env: Env,
  username: string,
): Promise<PanelDeleteOutcome> {
  const panel = loadPanelConfig(env);
  if (!panel.ok) return { ok: false, reason: `panel_${panel.kind}` };
  const client = new PasarGuardClient(panel.config);
  const attempt = await client.deleteUserByUsername(username);
  const readBack = await client.getUserByUsername(username);
  if (readBack.ok && readBack.data !== null) {
    // The service is STILL THERE (or the panel answered the delete but not us):
    // never book a deletion the panel does not confirm.
    return {
      ok: false,
      reason: attempt.ok ? 'panel_delete_ignored' : panelReason(attempt),
    };
  }
  if (readBack.ok) return { ok: false, reason: 'panel_delete_state_unreadable' };
  if (readBack.kind !== 'not_found') {
    return { ok: false, reason: `panel_delete_confirm_${panelReason(readBack)}` };
  }
  if (attempt.ok) return { ok: true, alreadyGone: false };
  if (attempt.kind === 'not_found') return { ok: true, alreadyGone: true };
  // Ambiguous on the wire but the read says gone: report success WITHOUT a
  // local claim either way — booking stays the caller's, and the same read
  // made the outcome true, so this is the confirmed shape, not a hope.
  return { ok: true, alreadyGone: true };
}

/** Deterministic panel username: config prefix + full order id. */
export function provisionUsername(orderId: string, prefix: string): string {
  return (prefix + orderId.toLowerCase()).slice(0, 32);
}

function panelReason(result: { kind: string; status: number; detail: string }): string {
  const detail = result.detail.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return `${result.kind}:${result.status || 0}:${detail}`.slice(0, 300);
}

function parseSelections(order: OrderRow): {
  volumeGb: number;
  /** Traffic cap in bytes on the panel wire (GiB conversion; test path: SI MB). */
  dataLimitBytes: number;
  durationDays: number;
  deviceCount: number;
} | null {
  let snapshot: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(order.selections);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    snapshot = raw as Record<string, unknown>;
  } catch {
    return null;
  }
  const { duration_days: days, device_count: devices } = snapshot;
  if (
    typeof days !== 'number' ||
    typeof devices !== 'number' ||
    !Number.isSafeInteger(days) ||
    !Number.isSafeInteger(devices) ||
    days < 1 ||
    days > MAX_DAYS ||
    devices < 1 ||
    devices > MAX_DEVICES
  ) {
    return null;
  }
  // Free-test orders carry a strict byte-based volume (`volume_mb`, marked by
  // the immutable `free_test: true` snapshot flag): 100 MB is below the GB
  // ladder's integer floor of 1, so it can NEVER flow through volume_gb.
  // Anything not explicitly marked takes the identical legacy path below.
  if (snapshot['free_test'] === true) {
    const mb = snapshot['volume_mb'];
    if (
      typeof mb !== 'number' ||
      !Number.isSafeInteger(mb) ||
      mb < 1 ||
      mb > MAX_MB
    ) {
      return null;
    }
    return {
      volumeGb: 0, // unused on the test path; the byte cap is authoritative
      dataLimitBytes: mb * MB_BYTES,
      durationDays: days,
      deviceCount: devices,
    };
  }
  const gb = snapshot['volume_gb'];
  if (
    typeof gb !== 'number' ||
    !Number.isSafeInteger(gb) ||
    gb < 1 ||
    gb > MAX_GB
  ) {
    return null;
  }
  return {
    volumeGb: gb,
    dataLimitBytes: gb * GB_BYTES,
    durationDays: days,
    deviceCount: devices,
  };
}

/** Fire-and-forget notices must never take down a provisioning result. */
async function notice(
  chatId: number,
  text: string,
  api: TelegramApiLike,
  buttons?: Parameters<TelegramApiLike['sendMessage']>[2],
  parseMode?: Parameters<TelegramApiLike['sendMessage']>[3],
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, buttons, parseMode);
  } catch {
    console.error(`provision_notice_failed chat=${String(chatId).slice(0, 20)}`);
  }
}

/**
 * Phase 10: the recipient's persisted language decides the bundle the notice
 * is composed FROM (`select` runs with the resolved Ui) — one contact read,
 * zero behavior change beyond the text itself.
 */
async function notifyCustomer(
  deps: ProvisionDeps,
  order: OrderRow,
  select: (ui: Ui) => {
    text: string;
    parseMode?: Parameters<TelegramApiLike['sendMessage']>[3];
    buttons?: Parameters<TelegramApiLike['sendMessage']>[2];
  },
): Promise<void> {
  const contact = await getCustomerContact(deps.db, order.customer_id);
  const chatId = contact ? Number(contact.telegram_user_id) : NaN;
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return;
  const composed = select(uiFor(contact?.language));
  await notice(chatId, composed.text, deps.api, composed.buttons, composed.parseMode);
}

/**
 * Does this failure reason READ LIKE a name/username rejection? The config
 * name itself is never sent to the panel (username stays the deterministic
 * prefix+order-id), but the honest customer copy for "rejected because of
 * the name" is only worth its own text when the evidence points there:
 * the client's own username_charset guard, or a panel detail mentioning
 * username/name. Purely a copy decision — zero behavior change.
 */
function looksLikeNameRejection(reason: string): boolean {
  return /username|user name|config[_ -]?name/i.test(reason);
}

/** Close out a failed attempt: DB transition + customer notice + admin push. */
async function finalizeFailure(
  deps: ProvisionDeps,
  orderId: string,
  rawReason: string,
  renewal = false,
): Promise<ProvisionOutcome> {
  const reason = rawReason.slice(0, 300);
  const result = await failProvisionedOrder(deps.db, { orderId, reason });
  if (!result.ok) {
    console.error(`provision_finalize_failed_race orderId=${orderId.slice(0, 32)}`);
    return { ok: false, error: 'provision_failed' };
  }
  await notifyCustomer(deps, result.order, (ui) => ({
    text: renewal
      ? ui.t.renewFailedNotice(result.order.id)
      : looksLikeNameRejection(reason)
        ? ui.t.provisionNameRejectedNotice(result.order.id)
        : ui.t.provisionFailedNotice(result.order.id),
  }));
  await notifyAdminsOfFailure(deps, result.order, reason, renewal);
  return { ok: false, error: 'provision_failed' };
}

async function notifyAdminsOfFailure(
  deps: ProvisionDeps,
  order: OrderRow,
  reason: string,
  renewal = false,
): Promise<void> {
  const chatIds = await resolveAdminChatIds(deps.env, deps.db);
  for (const chatId of chatIds) {
    await notice(
      chatId,
      renewal ? fa.adminRenewalFailed(order.id, reason) : fa.adminProvisionFailed(order.id, reason),
      deps.api,
      adminProvisionFailedKeyboard(order.id),
    );
  }
}

/** Close out a successful PURCHASE: DB transition + local expiry + notice. */
async function finalizeSuccess(
  deps: ProvisionDeps,
  orderId: string,
  baseUrl: string,
  user: PanelUser | null,
  serviceExpiresAt: string | null = null,
): Promise<ProvisionOutcome> {
  const subscriptionUrl = resolveSubscriptionUrl(baseUrl, user?.subscriptionUrl ?? null);
  const result = await completeProvisionedOrder(deps.db, {
    orderId,
    pasarguardUserId: user?.id ?? null,
    subscriptionUrl,
    serviceExpiresAt,
  });
  if (!result.ok) {
    if (result.error === 'identity_conflict') {
      return finalizeFailure(deps, orderId, 'panel_identity_conflict');
    }
    console.error(`provision_finalize_complete_race orderId=${orderId.slice(0, 32)}`);
    return { ok: false, error: 'provision_failed' };
  }
  // Phase 8C: serviceReady carries an inline-code URL → send it as HTML.
  // Phase 9: attach the service-page discovery keyboard (panel's own page).
  await notifyCustomer(deps, result.order, (ui) => ({
    text:
      result.order.subscription_url !== null
        ? ui.t.serviceReady(result.order.id, result.order.subscription_url)
        : ui.t.serviceReadyWithoutLink(result.order.id),
    parseMode: result.order.subscription_url !== null ? 'HTML' : undefined,
    buttons: serviceReadyKeyboard(ui, result.order.subscription_url),
  }));
  return { ok: true, order: result.order, attempted: true };
}

/**
 * The ABSOLUTE create-expiry target (panel `expire` semantics: unix seconds;
 * what renewal's PUT primitive proves works). Null = unrepresentable — the
 * order is failed BEFORE any username claim or panel write.
 */
function createExpiryTargetUnix(durationDays: number): number | null {
  const target = Math.floor(Date.now() / 1000) + durationDays * DAY_SECONDS;
  if (!Number.isSafeInteger(target) || target < 1 || target > 4_000_000_000) return null;
  return target;
}

/** Panel-reported expiry reaches the claimed target (small clock skew OK). */
function expiryAtTarget(expire: number | null, targetUnix: number): expire is number {
  return expire !== null && expire >= targetUnix - EXPIRY_SLACK_SECONDS;
}

/**
 * Post-create expiry verification (production fix 2026-09: creation used a
 * relative `expire_duration` the panel silently ignored — services completed
 * with a purely LOCAL expiry while the panel showed them Unlimited). The
 * panel's reported ABSOLUTE `expire` is trusted when it reaches the claimed
 * target; anything less (absent/0 = Unlimited, or short) earns exactly one
 * corrective PUT with the renewal-proven primitive, then a read-back decides.
 * Absolute re-application is a no-op, so this step converges across
 * ambiguous timeouts and retries. FAIL CLOSED on anything unconfirmed: an
 * order never completes while the panel could show it Unlimited.
 */
async function ensureCreateExpiry(
  client: PasarGuardClient,
  username: string,
  user: PanelUser | null,
  targetUnix: number,
): Promise<
  | { ok: true; user: PanelUser | null; expireUnix: number }
  | { ok: false; reason: string }
> {
  let current = user;
  let expire = current?.expire ?? null;
  if (expiryAtTarget(expire, targetUnix)) return { ok: true, user: current, expireUnix: expire };

  const patched = await client.modifyUserByUsername(username, { expire: targetUnix });
  if (!patched.ok) {
    // The write may STILL have landed (ambiguous timeout): one read decides.
    const after = await client.getUserByUsername(username);
    if (after.ok) {
      const afterExpire = after.data?.expire ?? null;
      if (expiryAtTarget(afterExpire, targetUnix)) {
        return { ok: true, user: after.data, expireUnix: afterExpire };
      }
    }
    return { ok: false, reason: `expiry_repair_${panelReason(patched)}` };
  }
  if (patched.data !== null) current = patched.data;
  expire = current?.expire ?? null;
  if (!expiryAtTarget(expire, targetUnix)) {
    const after = await client.getUserByUsername(username);
    if (after.ok && after.data !== null) {
      current = after.data;
      expire = current.expire;
    }
  }
  return expiryAtTarget(expire, targetUnix)
    ? { ok: true, user: current, expireUnix: expire }
    : { ok: false, reason: 'create_expiry_unverified' };
}

/** Verified-expiry close-out for every create-shaped path (new or adopted). */
async function finalizeCreate(
  deps: ProvisionDeps,
  order: OrderRow,
  baseUrl: string,
  client: PasarGuardClient,
  username: string,
  user: PanelUser | null,
  targetUnix: number,
): Promise<ProvisionOutcome> {
  const verified = await ensureCreateExpiry(client, username, user, targetUnix);
  if (!verified.ok) {
    return finalizeFailure(deps, order.id, verified.reason);
  }
  return finalizeSuccess(
    deps,
    order.id,
    baseUrl,
    verified.user,
    new Date(verified.expireUnix * 1000).toISOString(),
  );
}

/** Parse the renewal-only fields of a renewal order's selections snapshot. */
function parseRenewalSelections(order: OrderRow): {
  durationDays: number;
  serviceOrderId: string | null;
} | null {
  let snapshot: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(order.selections);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    snapshot = raw as Record<string, unknown>;
  } catch {
    return null;
  }
  const days = snapshot['duration_days'];
  if (
    typeof days !== 'number' ||
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > MAX_DAYS
  ) {
    return null;
  }
  const link = snapshot['renews_order_id'];
  const serviceOrderId =
    typeof link === 'string' && isValidOrderId(link) ? link : order.renews_order_id;
  return {
    durationDays: days,
    serviceOrderId: serviceOrderId !== null && isValidOrderId(serviceOrderId) ? serviceOrderId : null,
  };
}

/** ISO (D1 format) → unix seconds, or null when absent/meaningless. */
function isoToUnix(iso: string | null): number | null {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / 1000);
}

/**
 * Renewal provisioning on an ALREADY-CLAIMED order (state = provisioning).
 * Idempotency contract: the absolute target is claimed on the renewal row
 * before the panel PUT and never recomputed once stored — retries verify
 * instead of extending again (mirrors the purchase username-claim discipline).
 */
export async function provisionRenewal(
  deps: ProvisionDeps,
  order: OrderRow,
  client: PasarGuardClient,
): Promise<ProvisionOutcome> {
  const { db } = deps;
  const selections = parseRenewalSelections(order);
  if (selections === null) {
    return finalizeFailure(deps, order.id, 'renewal_selections_invalid', true);
  }
  const service = selections.serviceOrderId === null
    ? null
    : await getOrderById(db, selections.serviceOrderId);
  if (
    service === null ||
    service.kind !== 'purchase' ||
    service.state !== 'completed' ||
    // Phase 16: a deleted service cannot be extended, even by a renewal that
    // entered the queue before the deletion (fail CLOSED, zero panel writes).
    service.panel_deleted_at !== null ||
    service.customer_id !== order.customer_id
  ) {
    return finalizeFailure(deps, order.id, 'renewal_service_invalid', true);
  }
  const username = service.pasarguard_username;
  if (username === null) {
    return finalizeFailure(deps, order.id, 'renewal_service_unlinked', true);
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  const precheck = await client.getUserByUsername(username);
  if (!precheck.ok) {
    // For a renewal, 404 is NOT "safe to proceed" (as in create): the service
    // row says it exists — if the panel lost it, stop and tell the admins.
    if (precheck.kind === 'not_found') {
      return finalizeFailure(deps, order.id, 'renewal_service_missing', true);
    }
    return finalizeFailure(deps, order.id, `renewal_precheck_${panelReason(precheck)}`, true);
  }
  if (precheck.data === null) {
    return finalizeFailure(deps, order.id, 'renewal_service_missing', true);
  }

  let target = order.renew_target_unix;
  if (target === null) {
    const local = isoToUnix(service.service_expires_at) ?? isoToUnix(service.service_created_at);
    const base = Math.max(nowUnix, precheck.data.expire ?? 0, local ?? 0);
    const candidate = base + selections.durationDays * DAY_SECONDS;
    if (!Number.isSafeInteger(candidate) || candidate > 4_000_000_000) {
      return finalizeFailure(deps, order.id, 'renewal_target_overflow', true);
    }
    const claimed = await claimRenewalTarget(db, { orderId: order.id, targetUnix: candidate });
    if (!claimed.ok) {
      return { ok: false, error: claimed.error === 'not_found' ? 'not_found' : 'state_changed' };
    }
    target = claimed.targetUnix ?? candidate;
  }

  // Already extended to/through the target (earlier ambiguous attempt, or a
  // manual panel edit that overshot): adopt — NO second PUT, no stacking.
  if (precheck.data.expire !== null && precheck.data.expire >= target) {
    return finalizeRenewalSuccess(deps, order, service.id, target);
  }

  const applied = await client.modifyUserByUsername(username, { expire: target });
  if (!applied.ok) {
    return finalizeFailure(deps, order.id, panelReason(applied), true);
  }
  let confirmed = applied.data?.expire ?? null;
  if (confirmed === null || confirmed < target) {
    const verified = await client.getUserByUsername(username);
    if (verified.ok && verified.data !== null) confirmed = verified.data.expire;
  }
  if (confirmed === null || confirmed < target) {
    // Panel accepted the write but the read does not confirm it yet: fail
    // CLOSED. The stored target makes the admin retry converge (adopt path).
    return finalizeFailure(deps, order.id, 'renewal_unverified', true);
  }
  return finalizeRenewalSuccess(deps, order, service.id, target);
}

/** Close out a successful RENEWAL: complete order → book service → notify. */
async function finalizeRenewalSuccess(
  deps: ProvisionDeps,
  order: OrderRow,
  serviceOrderId: string,
  targetUnix: number,
): Promise<ProvisionOutcome> {
  const result = await completeRenewedOrder(deps.db, { orderId: order.id, targetUnix });
  if (!result.ok) {
    console.error(`renewal_finalize_race orderId=${order.id.slice(0, 32)}`);
    return { ok: false, error: result.error === 'not_found' ? 'not_found' : 'provision_failed' };
  }
  const expiresIso = new Date(targetUnix * 1000).toISOString();
  const booked = await bookRenewalOnService(deps.db, {
    serviceOrderId,
    renewalOrderId: order.id,
    expiresIso,
  });
  if (!booked) {
    // The renewal IS applied (panel says so) — only local bookkeeping raced.
    console.error(`renewal_booking_skipped service=${serviceOrderId.slice(0, 32)}`);
  }
  await notifyCustomer(deps, result.order, (ui) => ({
    // The date stays the raw ISO slice exactly as today (ASCII in fa too —
    // byte-frozen Phase 6 behavior; ISO is equally correct English output).
    text: ui.t.renewApplied(result.order.id, expiresIso.slice(0, 10)),
  }));
  return { ok: true, order: result.order, attempted: true };
}

/**
 * Provision one order. `retry` opens the claim from `failed` instead of
 * `approved` — everything else (guards, pre-check, notifications) is identical.
 * The order's `kind` picks the purchase-create or renewal-extend path.
 */
export async function provisionOrder(
  deps: ProvisionDeps,
  opts: { orderId: string; retry?: boolean },
): Promise<ProvisionOutcome> {
  const { db, env } = deps;
  if (!isValidOrderId(opts.orderId)) return { ok: false, error: 'invalid_id' };

  const kindProbe = await getOrderById(db, opts.orderId);
  if (!kindProbe) return { ok: false, error: 'not_found' };
  // Phase 16: a `panel_deleted` row is terminal — never re-provisioned,
  // never resurrected (the D1 username claim would collide anyway; refusing
  // here keeps the audit honest and makes ZERO panel calls).
  if (kindProbe.panel_deleted_at !== null) return { ok: false, error: 'state_changed' };
  const isRenewal = kindProbe.kind === 'renewal';

  if (isRenewal) {
    // Renewal kill switch (independent of provisioning): malformed/missing
    // doc or disabled → ZERO writes, the order stays exactly where it is.
    const renewal = await loadRenewalConfig(db);
    if (!renewal.ok) {
      console.error(`renewal_config_unavailable code=${renewal.error}`);
      return { ok: false, skip: 'renewal_unavailable' };
    }
    if (!renewal.config.enabled) return { ok: false, skip: 'renewal_disabled' };
  }

  const config = await loadProvisioningConfig(db);
  if (!config.ok) {
    console.error(`provision_config_unavailable code=${config.error}`);
    return { ok: false, skip: 'config_invalid' };
  }
  // One master switch over ALL panel writes (creates AND extensions).
  if (!config.config.enabled) return { ok: false, skip: 'disabled' };

  const panel = loadPanelConfig(env);
  if (!panel.ok) {
    // Unconfigured panel: leave the order untouched (still approved/failed).
    return { ok: false, skip: 'unconfigured' };
  }

  const fromState = opts.retry === true ? 'failed' : 'approved';
  const claim = await claimOrderForProvisioning(db, {
    orderId: opts.orderId,
    fromState,
    maxAttempts: config.config.maxAttempts,
  });
  if (!claim.ok) {
    return { ok: false, error: claim.error };
  }
  const order = claim.order;
  const client = new PasarGuardClient(panel.config);

  if (order.kind === 'renewal') {
    return provisionRenewal(deps, order, client);
  }

  const selections = parseSelections(order);
  if (selections === null) {
    return finalizeFailure(deps, order.id, 'selections_invalid');
  }
  // Absolute expiry is CLAIMED here (before any panel write), like a renewal
  // target: retries re-derive the same shape, and the verification step makes
  // a re-application a no-op — no stacking, ever.
  const targetUnix = createExpiryTargetUnix(selections.durationDays);
  if (targetUnix === null) {
    return finalizeFailure(deps, order.id, 'create_target_overflow');
  }

  const username = provisionUsername(order.id, config.config.usernamePrefix);
  const claimed = await claimOrderUsername(db, { orderId: order.id, username });
  if (!claimed.ok) {
    if (claimed.error === 'not_found') return { ok: false, error: 'not_found' };
    return finalizeFailure(deps, order.id, `username_claim_${claimed.error}`);
  }
  const serviceUsername = claimed.order.pasarguard_username ?? username;

  const precheck = await client.getUserByUsername(serviceUsername);
  if (!precheck.ok && precheck.kind !== 'not_found') {
    return finalizeFailure(deps, order.id, panelReason(precheck));
  }
  if (precheck.ok && precheck.data !== null) {
    // ADOPT, but only with a verified finite expiry — a pre-existing
    // Unlimited service gets the same corrective PUT as a fresh create.
    return finalizeCreate(
      deps, order, panel.config.baseUrl, client, serviceUsername, precheck.data, targetUnix,
    );
  }

  const created = await client.createUser(
    buildCreatePayload(order.id, selections, config.config, serviceUsername, targetUnix),
  );
  if (!created.ok) {
    if (created.kind === 'rejected' && created.status === 409) {
      // Raced with another creator: adopt if the lookup now finds it.
      const after = await client.getUserByUsername(serviceUsername);
      if (after.ok && after.data !== null) {
        return finalizeCreate(
          deps, order, panel.config.baseUrl, client, serviceUsername, after.data, targetUnix,
        );
      }
    }
    return finalizeFailure(deps, order.id, panelReason(created));
  }

  let user = created.data;
  if (user === null || user.id === null || user.subscriptionUrl === null) {
    // Envelope-less create: one read-only confirmation for the full record.
    const confirmed = await client.getUserByUsername(serviceUsername);
    if (confirmed.ok && confirmed.data !== null) user = confirmed.data;
  }
  return finalizeCreate(
    deps, order, panel.config.baseUrl, client, serviceUsername, user, targetUnix,
  );
}

function buildCreatePayload(
  orderId: string,
  selections: { dataLimitBytes: number; deviceCount: number },
  config: ProvisioningConfig,
  username: string,
  expireUnix: number,
): CreateUserPayload {
  return {
    username,
    status: config.defaultStatus,
    data_limit: selections.dataLimitBytes,
    expire: expireUnix,
    hwid_limit: selections.deviceCount,
    group_ids: [...config.groupIds],
    note: `telbot:${orderId}`,
  };
}
