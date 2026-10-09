import { resolvePanel, resolveServicePanel, selection, provisioningForPanel, clientFor, acquireServiceLock, releaseServiceLock } from '../panels/registry.ts';
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
import { PasarGuardClient, resolveSubscriptionUrl } from '../pasarguard/client.ts';
import { loadProvisioningConfig } from '../catalog/provisioning.ts';
import type { ProvisioningConfig } from '../catalog/provisioning.ts';
import { MB_BYTES } from '../catalog/freeTest.ts';
import { loadRenewalConfig } from '../catalog/renewal.ts';
import { loadRepurchaseConfig } from '../catalog/repurchase.ts';
import { isSalesStopped } from '../catalog/sales.ts';
import {
  bookRenewalOnService,
  bookRepurchaseOnService,
  claimOrderForProvisioning,
  claimOrderUsername,
  claimRenewalQuotaTarget,
  claimRenewalTarget,
  claimRepurchaseExpiryTarget,
  claimRepurchaseHwidTarget,
  claimRepurchaseQuotaTarget,
  claimRepurchaseReset,
  completeProvisionedOrder,
  completeRenewedOrder,
  completeRepurchasedOrder,
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
  | 'renewal_unavailable'
  | 'repurchase_disabled'
  | 'repurchase_unavailable';

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
  service: OrderRow,
): Promise<PanelDeleteOutcome> {
  if (!service.panel_id) return {ok:false,reason:'service_panel_missing'};
  const panel = await resolveServicePanel(env,service);
  if (!panel.ok) return { ok: false, reason: `panel_${panel.kind}` };
  const client = clientFor(panel.config,service.pasarguard_user_id);
  const before = await client.getUserByUsername(username);
  if (!before.ok && before.kind !== 'not_found') return {ok:false,reason:`delete_precheck_${before.kind}`};
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
  renewal: boolean | 'repurchase' = false,
): Promise<ProvisionOutcome> {
  const reason = rawReason.slice(0, 300);
  const result = await failProvisionedOrder(deps.db, { orderId, reason });
  if (!result.ok) {
    console.error(`provision_finalize_failed_race orderId=${orderId.slice(0, 32)}`);
    return { ok: false, error: 'provision_failed' };
  }
  const isRepurchase = renewal === 'repurchase';
  await notifyCustomer(deps, result.order, (ui) => ({
    text: isRepurchase
      ? ui.t.repFailedNotice(result.order.id)
      : renewal
        ? ui.t.renewFailedNotice(result.order.id)
        : looksLikeNameRejection(reason)
          ? ui.t.provisionNameRejectedNotice(result.order.id)
          : ui.t.provisionFailedNotice(result.order.id),
  }));
  await notifyAdminsOfFailure(deps, result.order, reason, renewal === true, isRepurchase);
  return { ok: false, error: 'provision_failed' };
}

async function notifyAdminsOfFailure(
  deps: ProvisionDeps,
  order: OrderRow,
  reason: string,
  renewal = false,
  repurchase = false,
): Promise<void> {
  const chatIds = await resolveAdminChatIds(deps.env, deps.db);
  for (const chatId of chatIds) {
    await notice(
      chatId,
      repurchase
        ? fa.adminRepurchaseFailed(order.id, reason)
        : renewal
          ? fa.adminRenewalFailed(order.id, reason)
          : fa.adminProvisionFailed(order.id, reason),
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
  if (!user?.id || user.username !== username) return finalizeFailure(deps,order.id,'create_identity_unverified');
  if (order.panel_id !== 'legacy' && user.note !== `telbot:${order.id}`) {
    return finalizeFailure(deps,order.id,'create_ownership_unverified');
  }
  const verified = await ensureCreateExpiry(client.withExpectedUserId(user.id), username, user, targetUnix);
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
export function parseRenewalSelections(order: OrderRow): {
  durationDays: number;
  addedVolumeGb: number;
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
    days < 0 ||
    days > MAX_DAYS
  ) {
    return null;
  }
  // Legacy time-only snapshots predate the volume key — default to 0 (no
  // increase), preserving existing duration-only renewals byte-for-byte.
  const addedRaw = snapshot['added_volume_gb'] ?? 0;
  if (
    typeof addedRaw !== 'number' ||
    !Number.isSafeInteger(addedRaw) ||
    addedRaw < 0 ||
    addedRaw > MAX_GB
  ) {
    return null;
  }
  if (days === 0 && addedRaw === 0) return null;
  const link = snapshot['renews_order_id'];
  const serviceOrderId =
    typeof link === 'string' && isValidOrderId(link) ? link : order.renews_order_id;
  return {
    durationDays: days,
    addedVolumeGb: addedRaw,
    serviceOrderId: serviceOrderId !== null && isValidOrderId(serviceOrderId) ? serviceOrderId : null,
  };
}

/**
 * Quota delta for a renewal add-on, reusing the purchase conversion: the SAME
 * `gb * GB_BYTES` expression as `parseSelections` (provision.ts:212) with the
 * SAME `GB_BYTES` constant — never a second formula, never SI MB, never a
 * rounded approximation. Returns null when unrepresentable.
 */
export function quotaDeltaBytesForAddedGb(addedGb: number): number | null {
  if (!Number.isSafeInteger(addedGb) || addedGb < 0 || addedGb > MAX_GB) return null;
  if (addedGb === 0) return 0;
  const delta = addedGb * GB_BYTES;
  return Number.isSafeInteger(delta) ? delta : null;
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
 * Idempotency contract: absolute targets are claimed on the renewal row
 * before the panel PUT and never recomputed once stored — retries verify
 * instead of extending/adding again (mirrors the purchase username-claim
 * discipline). Supports duration-only (legacy), volume-only, and both.
 * Volume is strictly additive: newQuota = panel.dataLimit + purchase-
 * equivalent delta; used_traffic is never sent and never reset.
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

  // ———— expiry target (duration dimension; null = no time extension) ————
  let target: number | null = order.renew_target_unix;
  if (selections.durationDays === 0) {
    target = null;
  } else if (target === null) {
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

  // ———— quota target (volume dimension; null = no increase) ————
  // Additive: existing panel data_limit + purchase-equivalent delta. Fail
  // CLOSED when the current quota is unknown (null/Unlimited) — never guess.
  let quotaTarget: number | null = null;
  try {
    quotaTarget = (order as OrderRow).renew_target_data_limit_bytes ?? null;
  } catch {
    quotaTarget = null;
  }
  if (selections.addedVolumeGb === 0) {
    quotaTarget = null;
  } else {
    if (quotaTarget === null) {
      const baseLimit = precheck.data.dataLimit;
      if (baseLimit === null) {
        return finalizeFailure(deps, order.id, 'renewal_quota_unknown', true);
      }
      const delta = quotaDeltaBytesForAddedGb(selections.addedVolumeGb);
      if (delta === null) {
        return finalizeFailure(deps, order.id, 'renewal_quota_overflow', true);
      }
      const candidate = baseLimit + delta;
      if (!Number.isSafeInteger(candidate) || candidate < 1) {
        return finalizeFailure(deps, order.id, 'renewal_quota_overflow', true);
      }
      const claimed = await claimRenewalQuotaTarget(db, { orderId: order.id, quotaBytes: candidate });
      if (!claimed.ok) {
        return { ok: false, error: claimed.error === 'not_found' ? 'not_found' : 'state_changed' };
      }
      quotaTarget = claimed.quotaBytes ?? candidate;
    }
  }

  const expirySatisfied =
    target === null || (precheck.data.expire !== null && precheck.data.expire >= target);
  const quotaSatisfied =
    quotaTarget === null || (precheck.data.dataLimit !== null && precheck.data.dataLimit >= quotaTarget);
  // Already extended/increased to/through the targets (earlier ambiguous
  // attempt, or a manual panel edit that overshot): adopt — NO second PUT.
  if (expirySatisfied && quotaSatisfied) {
    return finalizeRenewalSuccess(deps, order, service.id, target, quotaTarget, selections.addedVolumeGb);
  }

  // Single partial PUT with ONLY dirty fields — never used_traffic, never a
  // new user. used_traffic is preserved by the panel on partial writes.
  const patch: { expire?: number; data_limit?: number } = {};
  if (target !== null && !expirySatisfied) patch.expire = target;
  if (quotaTarget !== null && !quotaSatisfied) patch.data_limit = quotaTarget;
  if (Object.keys(patch).length === 0) {
    return finalizeRenewalSuccess(deps, order, service.id, target, quotaTarget, selections.addedVolumeGb);
  }
  const applied = await client.modifyUserByUsername(username, patch);
  if (!applied.ok) {
    return finalizeFailure(deps, order.id, panelReason(applied), true);
  }
  let confirmedExpire = applied.data?.expire ?? null;
  let confirmedLimit = applied.data?.dataLimit ?? null;
  if (
    (target !== null && !expirySatisfied && (confirmedExpire === null || confirmedExpire < target)) ||
    (quotaTarget !== null && !quotaSatisfied && (confirmedLimit === null || confirmedLimit < quotaTarget))
  ) {
    const verified = await client.getUserByUsername(username);
    if (verified.ok && verified.data !== null) {
      confirmedExpire = verified.data.expire;
      confirmedLimit = verified.data.dataLimit;
    }
  }
  if (target !== null && !expirySatisfied && (confirmedExpire === null || confirmedExpire < target)) {
    // Panel accepted the write but the read does not confirm it yet: fail
    // CLOSED. The stored target makes the admin retry converge (adopt path).
    return finalizeFailure(deps, order.id, 'renewal_unverified', true);
  }
  if (quotaTarget !== null && !quotaSatisfied && (confirmedLimit === null || confirmedLimit < quotaTarget)) {
    return finalizeFailure(deps, order.id, 'renewal_quota_unverified', true);
  }
  return finalizeRenewalSuccess(deps, order, service.id, target, quotaTarget, selections.addedVolumeGb);
}

/** Close out a successful RENEWAL: complete order → book service → notify. */
async function finalizeRenewalSuccess(
  deps: ProvisionDeps,
  order: OrderRow,
  serviceOrderId: string,
  targetUnix: number | null,
  quotaBytes: number | null = null,
  addedGb = 0,
): Promise<ProvisionOutcome> {
  const result = await completeRenewedOrder(deps.db, { orderId: order.id, targetUnix, quotaBytes });
  if (!result.ok) {
    console.error(`renewal_finalize_race orderId=${order.id.slice(0, 32)}`);
    return { ok: false, error: result.error === 'not_found' ? 'not_found' : 'provision_failed' };
  }
  let expiresIso: string | null = targetUnix === null ? null : new Date(targetUnix * 1000).toISOString();
  if (expiresIso !== null) {
    const booked = await bookRenewalOnService(deps.db, {
      serviceOrderId,
      renewalOrderId: order.id,
      expiresIso,
    });
    if (!booked) {
      // The renewal IS applied (panel says so) — only local bookkeeping raced.
      console.error(`renewal_booking_skipped service=${serviceOrderId.slice(0, 32)}`);
    }
  } else {
    const service = await getOrderById(deps.db, serviceOrderId);
    expiresIso = service?.service_expires_at ?? null;
  }
  await notifyCustomer(deps, result.order, (ui) => {
    // The date stays the raw ISO slice exactly as today (ASCII in fa too —
    // byte-frozen Phase 6 behavior; ISO is equally correct English output).
    if (targetUnix !== null && expiresIso !== null) {
      return { text: ui.t.renewApplied(result.order.id, expiresIso.slice(0, 10)) };
    }
    return { text: ui.t.renewVolumeApplied(result.order.id, String(addedGb)) };
  });
  return { ok: true, order: result.order, attempted: true };
}

/**
 * Parse the repurchase-only fields of a repurchase order's selections
 * snapshot. The snapshot is IMMUTABLE once checkout created the order:
 * provisioning reads ONLY this (plus the claimed D1 targets), so later UI
 * or catalog changes can never alter the finals being applied.
 */
export function parseRepurchaseSelections(order: OrderRow): {
  mode: 'same' | 'custom';
  volumeGb: number;
  /** Absolute final quota in bytes (GB_BYTES conversion — never a delta). */
  quotaBytes: number;
  durationDays: number;
  deviceCount: number;
  configName: string | null;
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
  if (snapshot['kind'] !== 'repurchase') return null;
  const mode = snapshot['mode'];
  if (mode !== 'same' && mode !== 'custom') return null;
  if (order.repurchase_mode !== null && order.repurchase_mode !== mode) return null;
  const gb = snapshot['volume_gb'];
  const days = snapshot['duration_days'];
  const devices = snapshot['device_count'];
  if (
    typeof gb !== 'number' ||
    typeof days !== 'number' ||
    typeof devices !== 'number' ||
    !Number.isSafeInteger(gb) ||
    !Number.isSafeInteger(days) ||
    !Number.isSafeInteger(devices) ||
    gb < 1 ||
    gb > MAX_GB ||
    days < 1 ||
    days > MAX_DAYS ||
    devices < 1 ||
    devices > MAX_DEVICES
  ) {
    return null;
  }
  const quotaBytes = gb * GB_BYTES;
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) return null;
  const link = snapshot['repurchases_order_id'];
  const fallback = snapshot['renews_order_id'];
  const rawLink =
    (typeof link === 'string' && isValidOrderId(link) ? link : null) ??
    (typeof fallback === 'string' && isValidOrderId(fallback) ? fallback : null) ??
    (typeof order.renews_order_id === 'string' && isValidOrderId(order.renews_order_id)
      ? order.renews_order_id
      : null);
  const name = snapshot['config_name'];
  return {
    mode,
    volumeGb: gb,
    quotaBytes,
    durationDays: days,
    deviceCount: devices,
    configName: typeof name === 'string' ? name : null,
    serviceOrderId: rawLink,
  };
}

/**
 * Repurchase provisioning on an ALREADY-CLAIMED order (state = provisioning).
 *
 * Same-user invariant: the EXISTING panel user (by the service row's
 * pasarguard_username) is reset and reconfigured in place. This path NEVER
 * POSTs /api/user and NEVER DELETEs — a missing panel user fails closed.
 *
 * Sequence (verified live on the deployed panel):
 *   1. GET existing user (precheck; 404 = fail closed, zero further writes).
 *   2. Claim ABSOLUTE targets (quota bytes, expiry unix, hwid) in D1.
 *   3. Claim the reset flag; the winner POSTs .../by-username/{u}/reset once.
 *   4. ONE combined PUT {data_limit, expire, hwid_limit} with dirty fields.
 *   5. GET again and verify: same user/id, EXACT quota, used_traffic == 0,
 *      exact hwid, fresh expiry within tolerance.
 *   6. Persist the CURRENT subscription URL (it may rotate on reset — URL is
 *      not identity) and finalize/book only after verification succeeds.
 *
 * Idempotency: absolute claimed targets are never recomputed once stored —
 * retries re-read the panel and adopt when the final state already holds
 * (no second reset, no second PUT, no stacking, no double finalize).
 */
export async function provisionRepurchase(
  deps: ProvisionDeps,
  order: OrderRow,
  client: PasarGuardClient,
): Promise<ProvisionOutcome> {
  const { db } = deps;
  const selections = parseRepurchaseSelections(order);
  if (selections === null) {
    return finalizeFailure(deps, order.id, 'repurchase_selections_invalid', 'repurchase');
  }
  const service = selections.serviceOrderId === null
    ? null
    : await getOrderById(db, selections.serviceOrderId);
  if (
    service === null ||
    service.kind !== 'purchase' ||
    service.state !== 'completed' ||
    // A deleted service cannot be repurchased, even by an order that entered
    // the queue before the deletion (fail CLOSED, zero panel writes, and
    // NEVER recreate the panel user automatically).
    service.panel_deleted_at !== null ||
    service.customer_id !== order.customer_id
  ) {
    return finalizeFailure(deps, order.id, 'repurchase_service_invalid', 'repurchase');
  }
  const username = service.pasarguard_username;
  if (username === null) {
    return finalizeFailure(deps, order.id, 'repurchase_service_unlinked', 'repurchase');
  }
  // Sales Stop re-check immediately before ANY panel mutation: a stop that
  // landed after checkout must block the reconfiguration (the order stays
  // failed and retryable; money handling follows the existing reject/refund
  // paths, never an automatic second charge).
  if (await isSalesStopped(db)) {
    return finalizeFailure(deps, order.id, 'repurchase_sales_stopped', 'repurchase');
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  const precheck = await client.getUserByUsername(username);
  if (!precheck.ok) {
    // 404 is NOT "safe to proceed" (unlike purchase create): the service row
    // says the user exists — if the panel lost it, stop and NEVER recreate.
    if (precheck.kind === 'not_found') {
      return finalizeFailure(deps, order.id, 'repurchase_service_missing', 'repurchase');
    }
    return finalizeFailure(deps, order.id, `repurchase_precheck_${panelReason(precheck)}`, 'repurchase');
  }
  if (precheck.data === null) {
    return finalizeFailure(deps, order.id, 'repurchase_service_missing', 'repurchase');
  }
  const panelId = precheck.data.id;

  // ———— claim ABSOLUTE targets BEFORE any panel mutation ————
  // Fresh expiry starts at repurchase time (a new lifecycle), not at the old
  // expiry: base = now. First claim wins; retries adopt the stored target.
  const expiryCandidate = nowUnix + selections.durationDays * DAY_SECONDS;
  if (!Number.isSafeInteger(expiryCandidate) || expiryCandidate < 1 || expiryCandidate > 4_000_000_000) {
    return finalizeFailure(deps, order.id, 'repurchase_target_overflow', 'repurchase');
  }
  const claimedQuota = await claimRepurchaseQuotaTarget(db, { orderId: order.id, quotaBytes: selections.quotaBytes });
  if (!claimedQuota.ok) {
    return { ok: false, error: claimedQuota.error === 'not_found' ? 'not_found' : 'state_changed' };
  }
  const claimedExpiry = await claimRepurchaseExpiryTarget(db, { orderId: order.id, targetUnix: expiryCandidate });
  if (!claimedExpiry.ok) {
    return { ok: false, error: claimedExpiry.error === 'not_found' ? 'not_found' : 'state_changed' };
  }
  const claimedHwid = await claimRepurchaseHwidTarget(db, { orderId: order.id, hwid: selections.deviceCount });
  if (!claimedHwid.ok) {
    return { ok: false, error: claimedHwid.error === 'not_found' ? 'not_found' : 'state_changed' };
  }
  const quotaTarget = claimedQuota.value;
  const targetUnix = claimedExpiry.value;
  const hwidTarget = claimedHwid.value;
  if (quotaTarget < 1 || targetUnix < 1 || hwidTarget < 1) {
    return finalizeFailure(deps, order.id, 'repurchase_target_invalid', 'repurchase');
  }

  const usedIsZero = (used: number | null): boolean => used === 0;
  // Zero is distinct from missing/unknown usage; unknown never proves a reset.

  // ———— reset usage (exactly one POST per order; losers verify via GET) ————
  const resetClaim = await claimRepurchaseReset(db, { orderId: order.id });
  if (!resetClaim.ok) {
    return { ok: false, error: resetClaim.error === 'not_found' ? 'not_found' : 'state_changed' };
  }
  if (resetClaim.issued) {
    const reset = await client.resetUserUsageByUsername(username);
    if (!reset.ok) {
      return finalizeFailure(deps, order.id, `repurchase_reset_${panelReason(reset)}`, 'repurchase');
    }
  }

  // ———— adopt check: final state already holds (earlier ambiguous attempt) ————
  const fresh = await client.getUserByUsername(username);
  if (!fresh.ok) {
    if (fresh.kind === 'not_found') {
      return finalizeFailure(deps, order.id, 'repurchase_service_missing', 'repurchase');
    }
    return finalizeFailure(deps, order.id, `repurchase_recheck_${panelReason(fresh)}`, 'repurchase');
  }
  if (fresh.data === null) {
    return finalizeFailure(deps, order.id, 'repurchase_service_missing', 'repurchase');
  }
  if (panelId !== null && fresh.data.id !== null && fresh.data.id !== panelId) {
    // Same username must still be the same panel user — never finalize onto
    // a swapped identity.
    return finalizeFailure(deps, order.id, 'repurchase_identity_changed', 'repurchase');
  }
  const quotaSatisfied = fresh.data.dataLimit === quotaTarget;
  const expirySatisfied = expiryAtTarget(fresh.data.expire, targetUnix);
  const usedSatisfied = usedIsZero(fresh.data.usedTraffic);
  const hwidSatisfied = fresh.data.hwidLimit === hwidTarget;

  // ———— ONE combined PUT with ONLY dirty absolute fields ————
  // hwid: the panel may omit hwid_limit from GET (unknown = null). A null
  // read is NOT proof of application — it only passes when this attempt's
  // PUT for hwid succeeded (or an earlier attempt's did, proven below by the
  // re-read still showing null while quota/expiry/usage all verify).
  const patch: { expire?: number; data_limit?: number; hwid_limit?: number } = {};
  if (!quotaSatisfied) patch.data_limit = quotaTarget;
  if (!expirySatisfied) patch.expire = targetUnix;
  if (!hwidSatisfied) patch.hwid_limit = hwidTarget;
  let putHwidConfirmed = hwidSatisfied;
  if (Object.keys(patch).length > 0) {
    const applied = await client.modifyUserByUsername(username, patch);
    if (!applied.ok) {
      return finalizeFailure(deps, order.id, panelReason(applied), 'repurchase');
    }
    // PUT-response confirmation for hwid when GET cannot show it.
    if (!hwidSatisfied && patch.hwid_limit !== undefined) {
      const reported = applied.data?.hwidLimit ?? null;
      if (reported === hwidTarget) putHwidConfirmed = true;
      else if (reported !== null && reported !== hwidTarget) {
        return finalizeFailure(deps, order.id, 'repurchase_hwid_unverified', 'repurchase');
      }
      // reported === null (envelope-less success): the mutation happened per
      // the client contract — the final GET below decides.
    }
  }

  // ———— final GET + strict verification (fail CLOSED on any mismatch) ————
  const verified = await client.getUserByUsername(username);
  if (!verified.ok) {
    if (verified.kind === 'not_found') {
      return finalizeFailure(deps, order.id, 'repurchase_service_missing', 'repurchase');
    }
    return finalizeFailure(deps, order.id, `repurchase_verify_${panelReason(verified)}`, 'repurchase');
  }
  if (verified.data === null) {
    return finalizeFailure(deps, order.id, 'repurchase_service_missing', 'repurchase');
  }
  if (panelId !== null && verified.data.id !== null && verified.data.id !== panelId) {
    return finalizeFailure(deps, order.id, 'repurchase_identity_changed', 'repurchase');
  }
  if (verified.data.dataLimit !== quotaTarget) {
    return finalizeFailure(deps, order.id, 'repurchase_quota_unverified', 'repurchase');
  }
  if (!usedIsZero(verified.data.usedTraffic)) {
    return finalizeFailure(deps, order.id, 'repurchase_reset_unverified', 'repurchase');
  }
  if (!expiryAtTarget(verified.data.expire, targetUnix)) {
    return finalizeFailure(deps, order.id, 'repurchase_unverified', 'repurchase');
  }
  if (verified.data.hwidLimit !== null && verified.data.hwidLimit !== hwidTarget) {
    return finalizeFailure(deps, order.id, 'repurchase_hwid_unverified', 'repurchase');
  }
  if (verified.data.hwidLimit === null && !putHwidConfirmed && !hwidSatisfied) {
    // Panel never surfaces hwid AND no PUT in this attempt confirmed it:
    // an earlier attempt's PUT may have applied it (envelope-less), but with
    // zero positive evidence we fail closed rather than invent success.
    // In practice the deployed panel returns hwid_limit on GET (verified
    // live), so this branch should not trigger there.
    return finalizeFailure(deps, order.id, 'repurchase_hwid_unverified', 'repurchase');
  }
  return finalizeRepurchaseSuccess(deps, order, service.id, targetUnix, quotaTarget, hwidTarget, verified.data,client.baseUrl);
}

/** Close out a successful REPURCHASE: complete order → book service → notify. */
async function finalizeRepurchaseSuccess(
  deps: ProvisionDeps,
  order: OrderRow,
  serviceOrderId: string,
  targetUnix: number,
  quotaBytes: number,
  hwid: number,
  user: PanelUser | null,
  baseUrl: string,
): Promise<ProvisionOutcome> {
  // The subscription URL MAY rotate on reset (verified live — old URL keeps
  // working). It is not identity: always persist the CURRENT value.
  const subscriptionUrl = resolveSubscriptionUrl(baseUrl, user?.subscriptionUrl ?? null);
  const result = await completeRepurchasedOrder(deps.db, {
    orderId: order.id,
    targetUnix,
    quotaBytes,
    hwid,
    subscriptionUrl,
  });
  if (!result.ok) {
    console.error(`repurchase_finalize_race orderId=${order.id.slice(0, 32)}`);
    return { ok: false, error: result.error === 'not_found' ? 'not_found' : 'provision_failed' };
  }
  const expiresIso = new Date(targetUnix * 1000).toISOString();
  const booked = await bookRepurchaseOnService(deps.db, {
    serviceOrderId,
    repurchaseOrderId: order.id,
    expiresIso,
    subscriptionUrl,
  });
  if (!booked) {
    // The panel reconfiguration IS applied — only local bookkeeping raced.
    console.error(`repurchase_booking_skipped service=${serviceOrderId.slice(0, 32)}`);
  }
  // Paid notice re-arming is atomic with idempotent service booking.
  await notifyCustomer(deps, result.order, (ui) => ({
    text: ui.t.repApplied(result.order.id, expiresIso.slice(0, 10)),
    parseMode: subscriptionUrl !== null ? 'HTML' : undefined,
    buttons: serviceReadyKeyboard(ui, subscriptionUrl),
  }));
  return { ok: true, order: result.order, attempted: true };
}

/**
 * Provision one order. `retry` opens the claim from `failed` instead of
 * `approved` — everything else (guards, pre-check, notifications) is identical.
 * The order's `kind` (+ repurchase_mode) picks the purchase-create,
 * renewal-extend or repurchase-reconfigure path.
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
  const isRepurchase = kindProbe.kind === 'renewal' &&
    (kindProbe.repurchase_mode === 'same' || kindProbe.repurchase_mode === 'custom');
  const isRenewal = kindProbe.kind === 'renewal' && !isRepurchase;

  if (isRepurchase) {
    // Repurchase kill switch (independent of provisioning): malformed/missing
    // doc or disabled → ZERO writes, the order stays exactly where it is.
    const repurchase = await loadRepurchaseConfig(db);
    if (!repurchase.ok) {
      console.error(`repurchase_config_unavailable code=${repurchase.error}`);
      return { ok: false, skip: 'repurchase_unavailable' };
    }
    if (!repurchase.config.enabled) return { ok: false, skip: 'repurchase_disabled' };
  }

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

  let originService: OrderRow | null = null;
  if (kindProbe.kind === 'renewal') {
    const linked = isRepurchase ? parseRepurchaseSelections(kindProbe)?.serviceOrderId : parseRenewalSelections(kindProbe)?.serviceOrderId;
    originService = linked ? await getOrderById(db,linked) : null;
    if (!originService?.panel_id) return {ok:false,skip:'unconfigured'};
  }
  // Only unassigned NEW provisioning consults the mutable default.
  const assignedPanel = originService?.panel_id ?? kindProbe.panel_id;
  const selected = assignedPanel ? null : await selection(db);
  const panelId = assignedPanel ?? selected!.panel_id;
  const panel = originService ? await resolveServicePanel(env,originService) : await resolvePanel(env,panelId);
  if (!panel.ok) return {ok:false,skip:'unconfigured'};
  if (kindProbe.kind === 'purchase' && !kindProbe.panel_id &&
      (!panel.row.enabled_new || (panelId!=='legacy' && panel.row.last_test!=='ok'))) return {ok:false,skip:'disabled'};
  let effectiveConfig: ProvisioningConfig;
  try {
    effectiveConfig = kindProbe.panel_provision_config
      ? JSON.parse(kindProbe.panel_provision_config) as ProvisioningConfig
      : provisioningForPanel(panel.row,config.config);
  } catch {return {ok:false,skip:'config_invalid'};}
  const lockId=originService?.id ?? kindProbe.id;
  const lockOwner=crypto.randomUUID();
  if (!await acquireServiceLock(db,lockId,lockOwner)) return {ok:false,error:'state_changed'};
  try {
  if (originService) {
    const latest = await getOrderById(db,originService.id);
    if (!latest || latest.panel_id!==originService.panel_id || latest.pasarguard_user_id!==originService.pasarguard_user_id || latest.pasarguard_username!==originService.pasarguard_username) return {ok:false,error:'state_changed'};
  }
  const fromState = opts.retry === true ? 'failed' : 'approved';
  const claim = await claimOrderForProvisioning(db, {
    orderId: opts.orderId,
    fromState,
    maxAttempts: config.config.maxAttempts,
    panelId,panelRevision:panel.row.revision,selectionRevision:selected?.revision,
    panelConfig:JSON.stringify(effectiveConfig),
  });
  if (!claim.ok) {
    return { ok: false, error: claim.error };
  }
  const order = claim.order;
  const client = clientFor(panel.config,originService?.pasarguard_user_id ?? order.pasarguard_user_id);

  return await (async (): Promise<ProvisionOutcome> => {
  if (order.kind === 'renewal' && (order.repurchase_mode === 'same' || order.repurchase_mode === 'custom')) {
    return provisionRepurchase(deps, order, client);
  }

  if (order.kind === 'renewal') {
    return provisionRenewal(deps, order, client);
  }

  const selections = parseSelections(order);
  if (selections === null) {
    return finalizeFailure(deps, order.id, 'selections_invalid');
  }
  // Persist the first absolute expiry before any remote write. Retries reuse
  // this value, even after a panel switch or a Worker restart.
  const candidate = createExpiryTargetUnix(selections.durationDays);
  if (candidate !== null) await db.prepare(`UPDATE orders SET create_target_unix=?2 WHERE id=?1 AND state='provisioning' AND create_target_unix IS NULL`)
    .bind(order.id,candidate).run();
  const targetUnix = (await getOrderById(db,order.id))?.create_target_unix ?? null;
  if (targetUnix === null) {
    return finalizeFailure(deps, order.id, 'create_target_overflow');
  }

  const username = provisionUsername(order.id, effectiveConfig.usernamePrefix);
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
    buildCreatePayload(order.id, selections, effectiveConfig, serviceUsername, targetUnix),
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
  })();
  } catch {
    // No raw exception messages: DB/transport errors can contain sensitive material.
    return await finalizeFailure(deps,opts.orderId,'panel_operation_interrupted',isRepurchase?'repurchase':isRenewal);
  } finally { await releaseServiceLock(db,lockId,lockOwner); }
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
