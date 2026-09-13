/**
 * Provisioning orchestration (Phase 5 + 6): the ONLY module that writes to
 * PasarGuard. Two kinds of work, chosen by the order row's `kind`:
 *
 *  purchase (approved/failed retry): claim → pre-check GET by-username (an
 *  existing service is ADOPTED, never blindly re-created) → POST /api/user →
 *  finalize completed + local expiry.
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
 * `provisioning` (single guarded UPDATE + affected-row check).
 *
 * Phase 1-4 invariant preserved: when the panel, the provisioning document
 * or (for renewals) the renewal document is NOT configured, these paths make
 * ZERO database or network writes and the order stays where it is.
 */
import type { Env, TelegramApiLike } from '../types.ts';
import type { CreateUserPayload, PanelUser } from '../pasarguard/client.ts';
import { loadPanelConfig, PasarGuardClient, resolveSubscriptionUrl } from '../pasarguard/client.ts';
import { loadProvisioningConfig } from '../catalog/provisioning.ts';
import type { ProvisioningConfig } from '../catalog/provisioning.ts';
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

/** 1 GB = 10^9 bytes on the panel wire (SI). Confirm on first live read. */
export const GB_BYTES = 1_000_000_000;
export const DAY_SECONDS = 86_400;

const MAX_GB = 4_194_304; // 2^32 bytes / 10^9 sanity cap
const MAX_DAYS = 36_600; // ~100 years
const MAX_DEVICES = 10_000;

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
  const { volume_gb: gb, duration_days: days, device_count: devices } = snapshot;
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
  return { volumeGb: gb, durationDays: days, deviceCount: devices };
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

async function notifyCustomer(
  deps: ProvisionDeps,
  order: OrderRow,
  text: string,
  parseMode?: Parameters<TelegramApiLike['sendMessage']>[3],
  buttons?: Parameters<TelegramApiLike['sendMessage']>[2],
): Promise<void> {
  const contact = await getCustomerContact(deps.db, order.customer_id);
  const chatId = contact ? Number(contact.telegram_user_id) : NaN;
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return;
  await notice(chatId, text, deps.api, buttons, parseMode);
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
  await notifyCustomer(
    deps,
    result.order,
    renewal
      ? fa.renewFailedNotice(result.order.id)
      : looksLikeNameRejection(reason)
      ? fa.provisionNameRejectedNotice(result.order.id)
      : fa.provisionFailedNotice(result.order.id),
  );
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
  const text =
    result.order.subscription_url !== null
      ? fa.serviceReady(result.order.id, result.order.subscription_url)
      : fa.serviceReadyWithoutLink(result.order.id);
  // Phase 8C: serviceReady carries an inline-code URL → send it as HTML.
  // Phase 9: attach the service-page discovery keyboard (panel's own page).
  await notifyCustomer(
    deps,
    result.order,
    text,
    result.order.subscription_url !== null ? 'HTML' : undefined,
    serviceReadyKeyboard(result.order.subscription_url),
  );
  return { ok: true, order: result.order, attempted: true };
}

function isoInDays(days: number): string {
  return new Date(Date.now() + days * DAY_SECONDS * 1000).toISOString();
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
  await notifyCustomer(deps, result.order, fa.renewApplied(result.order.id, expiresIso.slice(0, 10)));
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
    return finalizeSuccess(
      deps, order.id, panel.config.baseUrl, precheck.data, isoInDays(selections.durationDays),
    );
  }

  const created = await client.createUser(buildCreatePayload(order.id, selections, config.config, serviceUsername));
  if (!created.ok) {
    if (created.kind === 'rejected' && created.status === 409) {
      // Raced with another creator: adopt if the lookup now finds it.
      const after = await client.getUserByUsername(serviceUsername);
      if (after.ok && after.data !== null) {
        return finalizeSuccess(
          deps, order.id, panel.config.baseUrl, after.data, isoInDays(selections.durationDays),
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
  if (user !== null && user.expire !== null) {
    // Panel reports the real expiry — trust it over our arithmetic.
    return finalizeSuccess(
      deps,
      order.id,
      panel.config.baseUrl,
      user,
      new Date(user.expire * 1000).toISOString(),
    );
  }
  return finalizeSuccess(
    deps, order.id, panel.config.baseUrl, user, isoInDays(selections.durationDays),
  );
}

function buildCreatePayload(
  orderId: string,
  selections: { volumeGb: number; durationDays: number; deviceCount: number },
  config: ProvisioningConfig,
  username: string,
): CreateUserPayload {
  return {
    username,
    status: config.defaultStatus,
    data_limit: selections.volumeGb * GB_BYTES,
    expire_duration: selections.durationDays * DAY_SECONDS,
    hwid_limit: selections.deviceCount,
    group_ids: [...config.groupIds],
    note: `telbot:${orderId}`,
  };
}
