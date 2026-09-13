/**
 * Phase 6 "My Services": list + detail for the customer's OWN completed
 * purchases. A service IS a completed purchase order (no separate table).
 *
 * Display model: the D1 rows are always renderable (snapshot + locally
 * maintained expiry); a live panel read is an OPT-IN enhancement per detail
 * view / refresh tap — panel failures degrade to the snapshot. Nothing here
 * ever writes to the panel or mutates order state, and ownership is enforced
 * by the queries themselves (customer_id is in the WHERE clause, not the UI).
 */
import {
  findActiveRenewalForService,
  getOwnedService,
  listServicesForCustomer,
  type OrderRow,
  type ServiceRow,
} from '../db/orders.ts';
import type { TelegramInlineKeyboardMarkup, TelegramParseMode, UpdateContext } from '../types.ts';
import { loadRenewalConfig, type RenewalConfig } from '../catalog/renewal.ts';
import { loadPanelConfig, PasarGuardClient, type PanelUser } from '../pasarguard/client.ts';
import { backToMenuKeyboard, serviceDetailKeyboard, servicesListKeyboard } from '../telegram/menu.ts';
import { tgEscapeHtml } from '../telegram/format.ts';
import { digitsFa, fa } from '../telegram/texts.ts';

const SERVICES_LIMIT = 10;
const DAY_MS = 86_400_000;
const GB_BYTES = 1_000_000_000;
const DEFAULT_NEAR_EXPIRY_DAYS = 7;

export interface ServiceSnapshot {
  name: string | null;
  volumeGb: number | null;
  deviceCount: number | null;
  durationDays: number | null;
}

export function serviceSnapshotData(order: OrderRow): ServiceSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(order.selections);
  } catch {
    raw = null;
  }
  const value =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const num = (key: string): number | null => {
    const field = value[key];
    return typeof field === 'number' && Number.isSafeInteger(field) ? field : null;
  };
  return {
    name: typeof value['config_name'] === 'string' ? value['config_name'] : null,
    volumeGb: num('volume_gb'),
    deviceCount: num('device_count'),
    durationDays: num('duration_days'),
  };
}

/**
 * Local expiry of record: the booked column first, else derive
 * created_at + purchased duration. Null only when neither is computable.
 */
export function effectiveExpiryIso(order: OrderRow): string | null {
  if (order.service_expires_at !== null) return order.service_expires_at;
  if (order.service_created_at === null) return null;
  const created = Date.parse(order.service_created_at);
  const days = serviceSnapshotData(order).durationDays;
  if (!Number.isFinite(created) || days === null) return null;
  return new Date(created + days * DAY_MS).toISOString();
}

export function statusLineFor(expiresIso: string | null, nearDays: number): string {
  if (expiresIso === null) return fa.serviceStatusUnknown;
  const left = Math.ceil((Date.parse(expiresIso) - Date.now()) / DAY_MS);
  if (left <= 0) return fa.serviceStatusExpired;
  if (left <= nearDays) return fa.serviceStatusExpiring;
  return fa.serviceStatusActive;
}

export function expiryDisplay(expiresIso: string | null): string {
  return expiresIso === null ? fa.accountNone : digitsFa(expiresIso.slice(0, 10));
}

/** Phase 9 audit: detail shows expiry date AND TIME (repo displays UTC). */
export function expiryDateTimeDisplay(expiresIso: string | null): string {
  if (expiresIso === null) return fa.accountNone;
  return digitsFa(`${expiresIso.slice(0, 10)} ${expiresIso.slice(11, 16)}`);
}

function gbDisplay(bytes: number | null): string {
  if (bytes === null) return fa.accountNone;
  return digitsFa(Math.round((bytes / GB_BYTES) * 10) / 10);
}

/** Live-only panel status → Persian label (unknown values shown raw, capped). */
function panelStatusFa(status: string): string {
  switch (status) {
    case 'active':
      return fa.svcPanelActive;
    case 'limited':
      return fa.svcPanelLimited;
    case 'expired':
      return fa.svcPanelExpired;
    case 'disabled':
      return fa.svcPanelDisabled;
    case 'on_hold':
      return fa.svcPanelOnHold;
    default:
      return status.slice(0, 24);
  }
}

export async function loadRenewalViewConfig(db: D1Database): Promise<RenewalConfig> {
  const loaded = await loadRenewalConfig(db);
  return loaded.ok
    ? loaded.config
    : { enabled: false, nearExpiryDays: DEFAULT_NEAR_EXPIRY_DAYS };
}

/** `menu:services` — the customer's own services, rendered from the DB. */
export async function showMyServices(ctx: UpdateContext): Promise<void> {
  const [rows, renewal] = await Promise.all([
    listServicesForCustomer(ctx.db, ctx.customerId, SERVICES_LIMIT),
    loadRenewalViewConfig(ctx.db),
  ]);
  if (rows.length === 0) {
    await ctx.api.sendMessage(ctx.chatId, fa.servicesEmpty, backToMenuKeyboard());
    return;
  }
  const lines: string[] = [fa.servicesHeader];
  const entries: Array<{ orderId: string; label: string }> = [];
  rows.forEach((row, index) => {
    const expires = effectiveExpiryIso(row);
    const status = statusLineFor(expires, renewal.nearExpiryDays);
    const snapshot = serviceSnapshotData(row);
    lines.push(
      fa.servicesEntry(
        index + 1,
        snapshot.name ?? row.id.slice(0, 8),
        row.id.slice(0, 10),
        status,
        expiryDisplay(expires),
      ),
    );
    entries.push({
      orderId: row.id,
      label: `📦 ${snapshot.name ?? row.id.slice(0, 8)} — ${status}`.slice(0, 60),
    });
  });
  await ctx.api.sendMessage(
    ctx.chatId,
    lines.join('\n\n'),
    servicesListKeyboard(entries),
  );
}

/**
 * Renders the owned service's detail (live panel read only when allowed).
 * Phase 8C: when the subscription URL is shown the whole bubble opts into
 * HTML (tap-to-copy); every user/panel-authored string in THAT message is
 * escaped — machine values (ULIDs, dates, numbers) are injection-safe.
 */
async function renderServiceDetail(
  ctx: UpdateContext,
  orderId: string,
  live: boolean,
): Promise<{
  text: string;
  keyboard: TelegramInlineKeyboardMarkup;
  live: boolean;
  parseMode: TelegramParseMode | undefined;
} | null> {
  const service = await getOwnedService(ctx.db, ctx.customerId, orderId);
  if (!service) return null;
  const asHtml = service.subscription_url !== null;
  const esc = (value: string): string => (asHtml ? tgEscapeHtml(value) : value);

  const [renewal, active] = await Promise.all([
    loadRenewalViewConfig(ctx.db),
    findActiveRenewalForService(ctx.db, service.id),
  ]);

  const localExpiry = effectiveExpiryIso(service);
  let panelUser: PanelUser | null = null;
  const attemptedPanel = live && service.pasarguard_username !== null;
  if (attemptedPanel && service.pasarguard_username !== null) {
    const panel = loadPanelConfig(ctx.env);
    if (panel.ok) {
      const result = await new PasarGuardClient(panel.config).getUserByUsername(
        service.pasarguard_username,
      );
      if (result.ok && result.data !== null) panelUser = result.data;
    }
  }

  // The panel is authoritative for expiry WHEN SEEN; local data otherwise.
  const expiresUnix =
    panelUser?.expire ?? (localExpiry === null ? null : Math.floor(Date.parse(localExpiry) / 1000));
  const expiresIso = expiresUnix === null ? null : new Date(expiresUnix * 1000).toISOString();

  const snapshot = serviceSnapshotData(service);
  const lines: string[] = [fa.svcDetailHeader(esc(snapshot.name ?? fa.accountNone))];
  lines.push(
    panelUser !== null && panelUser.status !== null
      ? esc(panelStatusFa(panelUser.status))
      : statusLineFor(expiresIso, renewal.nearExpiryDays),
  );
  lines.push(fa.svcId(service.id));
  if (service.pasarguard_username !== null) {
    lines.push(fa.svcPanelUsername(service.pasarguard_username));
  }
  if (snapshot.volumeGb !== null) lines.push(fa.summaryVolume(snapshot.volumeGb));
  if (snapshot.deviceCount !== null) lines.push(fa.summaryDevices(snapshot.deviceCount));
  if (service.service_created_at !== null) {
    lines.push(fa.svcCreated(digitsFa(service.service_created_at.slice(0, 10))));
  }
  lines.push(fa.svcExpires(expiryDateTimeDisplay(expiresIso)));
  if (expiresIso !== null) {
    const left = Math.ceil((Date.parse(expiresIso) - Date.now()) / DAY_MS);
    lines.push(left > 0 ? fa.svcDaysLeft(left) : fa.svcExpiredDaysAgo(Math.max(0, -left)));
  }
  if (panelUser !== null) {
    lines.push(fa.svcUsage(gbDisplay(panelUser.usedTraffic), gbDisplay(panelUser.dataLimit)));
    // Phase 9 audit: remaining volume, explicit (panel bytes, display GB).
    if (panelUser.usedTraffic !== null && panelUser.dataLimit !== null) {
      lines.push(
        fa.svcRemaining(
          digitsFa(Math.max(0, Math.round(((panelUser.dataLimit - panelUser.usedTraffic) / GB_BYTES) * 10) / 10)),
        ),
      );
    }
  } else if (service.pasarguard_username !== null) {
    // Degraded path (snapshot render): point at the live-refresh affordance
    // instead of silently dropping the usage lines.
    lines.push(fa.svcUsageHintSnapshot);
  }
  if (service.subscription_url !== null) {
    // Phase 8C: show the subscription URL as tap-to-copy inline code. The
    // value is panel-sourced, so HTML-escaping is also a correctness win.
    // Phase 9: name the panel page it opens (discovery only — no new page).
    lines.push(fa.svcLinkCode(service.subscription_url));
    lines.push(fa.svcPageNote);
  }
  if (active !== null) {
    lines.push(fa.svcPendingRenewal(active.id.slice(0, 10)));
  }
  if (attemptedPanel) {
    lines.push(panelUser !== null ? fa.svcLiveNote : fa.svcSnapshotNote);
  }
  if (!renewal.enabled) lines.push(fa.renewDisabledNotice);

  return {
    text: lines.join('\n'),
    keyboard: serviceDetailKeyboard(service.id, {
      canRenew: renewal.enabled && active === null,
      serviceUrl: service.subscription_url,
    }),
    live: panelUser !== null,
    parseMode: asHtml ? 'HTML' : undefined,
  };
}

/** `svc:det` — fresh detail message; neutral toast when not owned/known. */
export async function viewOwnedService(
  ctx: UpdateContext,
  callbackQueryId: string,
  orderId: string,
): Promise<void> {
  const rendered = await renderServiceDetail(ctx, orderId, false);
  if (!rendered) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.serviceNotFound, true);
    return;
  }
  await ctx.api.answerCallbackQuery(callbackQueryId);
  await ctx.api.sendMessage(ctx.chatId, rendered.text, rendered.keyboard, rendered.parseMode);
}

/** `svc:ref` — live panel read (best effort) + in-place edit of the detail. */
export async function refreshOwnedService(
  ctx: UpdateContext,
  callbackQueryId: string,
  orderId: string,
  messageChatId: number | null,
  messageId: number | null,
): Promise<void> {
  const rendered = await renderServiceDetail(ctx, orderId, true);
  if (!rendered) {
    await ctx.api.answerCallbackQuery(callbackQueryId, fa.serviceNotFound, true);
    return;
  }
  if (messageChatId !== null && messageId !== null && messageChatId === ctx.chatId) {
    await ctx.api.editMessageText(
      messageChatId,
      messageId,
      rendered.text,
      rendered.keyboard,
      rendered.parseMode,
    );
  } else {
    await ctx.api.sendMessage(ctx.chatId, rendered.text, rendered.keyboard, rendered.parseMode);
  }
  await ctx.api.answerCallbackQuery(
    callbackQueryId,
    rendered.live ? fa.svcToastPanel : fa.svcToastSnapshot,
  );
}

