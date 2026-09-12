/**
 * Provisioning orchestration (Phase 5): the ONLY module that may create a
 * PasarGuard service, and only for orders that reached `approved` through the
 * manual admin review (or `failed` through an explicit admin retry).
 *
 * Race-safety: exactly one caller can move an order into `provisioning`
 * (single guarded UPDATE + affected-row check, same pattern as the review
 * transitions). Idempotency: the deterministic username is claimed on the
 * order row BEFORE any external write (UNIQUE guard), and every create is
 * preceded by a read-only by-username pre-check, so a retried attempt can
 * adopt an already-created service instead of creating a second one. The
 * panel POST itself is never auto-retried inside a single attempt.
 *
 * Phase 1-4 invariant preserved: when the panel or the provisioning document
 * is NOT configured, this module makes ZERO database or network changes.
 */
import type { Env, TelegramApiLike } from '../types.ts';
import type { CreateUserPayload, PanelUser } from '../pasarguard/client.ts';
import { loadPanelConfig, PasarGuardClient, resolveSubscriptionUrl } from '../pasarguard/client.ts';
import { loadProvisioningConfig } from '../catalog/provisioning.ts';
import type { ProvisioningConfig } from '../catalog/provisioning.ts';
import {
  claimOrderForProvisioning,
  claimOrderUsername,
  completeProvisionedOrder,
  failProvisionedOrder,
} from '../db/orders.ts';
import type { OrderRow } from '../db/orders.ts';
import { getCustomerContact, resolveAdminChatIds } from '../db/customers.ts';
import { isValidOrderId } from '../lib/validate.ts';
import { adminProvisionFailedKeyboard } from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';

/** 1 GB = 10^9 bytes on the panel wire (SI). Confirm on first live read. */
export const GB_BYTES = 1_000_000_000;
export const DAY_SECONDS = 86_400;

const MAX_GB = 4_194_304; // 2^32 bytes / 10^9 sanity cap
const MAX_DAYS = 36_600; // ~100 years
const MAX_DEVICES = 10_000;

export type ProvisionSkipReason = 'unconfigured' | 'config_invalid' | 'disabled';

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
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, buttons);
  } catch {
    console.error(`provision_notice_failed chat=${String(chatId).slice(0, 20)}`);
  }
}

async function notifyCustomer(
  deps: ProvisionDeps,
  order: OrderRow,
  text: string,
): Promise<void> {
  const contact = await getCustomerContact(deps.db, order.customer_id);
  const chatId = contact ? Number(contact.telegram_user_id) : NaN;
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return;
  await notice(chatId, text, deps.api);
}

async function notifyAdminsOfFailure(
  deps: ProvisionDeps,
  order: OrderRow,
  reason: string,
): Promise<void> {
  const chatIds = await resolveAdminChatIds(deps.env, deps.db);
  for (const chatId of chatIds) {
    await notice(
      chatId,
      fa.adminProvisionFailed(order.id, reason),
      deps.api,
      adminProvisionFailedKeyboard(order.id),
    );
  }
}

/** Close out a failed attempt: DB transition + customer notice + admin push. */
async function finalizeFailure(
  deps: ProvisionDeps,
  orderId: string,
  rawReason: string,
): Promise<ProvisionOutcome> {
  const reason = rawReason.slice(0, 300);
  const result = await failProvisionedOrder(deps.db, { orderId, reason });
  if (!result.ok) {
    console.error(`provision_finalize_failed_race orderId=${orderId.slice(0, 32)}`);
    return { ok: false, error: 'provision_failed' };
  }
  await notifyCustomer(deps, result.order, fa.provisionFailedNotice(result.order.id));
  await notifyAdminsOfFailure(deps, result.order, reason);
  return { ok: false, error: 'provision_failed' };
}

/** Close out a successful attempt: DB transition + customer delivery notice. */
async function finalizeSuccess(
  deps: ProvisionDeps,
  orderId: string,
  baseUrl: string,
  user: PanelUser | null,
): Promise<ProvisionOutcome> {
  const subscriptionUrl = resolveSubscriptionUrl(baseUrl, user?.subscriptionUrl ?? null);
  const result = await completeProvisionedOrder(deps.db, {
    orderId,
    pasarguardUserId: user?.id ?? null,
    subscriptionUrl,
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
  await notifyCustomer(deps, result.order, text);
  return { ok: true, order: result.order, attempted: true };
}

/**
 * Provision one order. `retry` opens the claim from `failed` instead of
 * `approved` — everything else (guards, pre-check, notifications) is identical.
 */
export async function provisionOrder(
  deps: ProvisionDeps,
  opts: { orderId: string; retry?: boolean },
): Promise<ProvisionOutcome> {
  const { db, env } = deps;
  if (!isValidOrderId(opts.orderId)) return { ok: false, error: 'invalid_id' };

  const config = await loadProvisioningConfig(db);
  if (!config.ok) {
    console.error(`provision_config_unavailable code=${config.error}`);
    return { ok: false, skip: 'config_invalid' };
  }
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

  const client = new PasarGuardClient(panel.config);
  const precheck = await client.getUserByUsername(serviceUsername);
  if (!precheck.ok && precheck.kind !== 'not_found') {
    return finalizeFailure(deps, order.id, panelReason(precheck));
  }
  if (precheck.ok && precheck.data !== null) {
    return finalizeSuccess(deps, order.id, panel.config.baseUrl, precheck.data);
  }

  const created = await client.createUser(buildCreatePayload(order.id, selections, config.config, serviceUsername));
  if (!created.ok) {
    if (created.kind === 'rejected' && created.status === 409) {
      // Raced with another creator: adopt if the lookup now finds it.
      const after = await client.getUserByUsername(serviceUsername);
      if (after.ok && after.data !== null) {
        return finalizeSuccess(deps, order.id, panel.config.baseUrl, after.data);
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
  return finalizeSuccess(deps, order.id, panel.config.baseUrl, user);
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
