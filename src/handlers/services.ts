/**
 * Phase 6 "My Services": list + detail for the customer's OWN completed
 * purchases. A service IS a completed purchase order (no separate table).
 *
 * Display model: the D1 rows are always renderable (snapshot + locally
 * maintained expiry); a live panel read is an OPT-IN enhancement per detail
 * view / refresh tap — panel failures degrade to the snapshot. Nothing here
 * ever writes to the panel or mutates order state, and ownership is enforced
 * by the queries themselves (customer_id is in the WHERE clause, not the UI).
 * Phase 10: rendering flows entirely through `ctx.ui` (text + formatters).
 */
import {
  findActiveRenewalForService,
  getOwnedService,
  listServicesForCustomer,
  type OrderRow,
  type ServiceRow,
} from '../db/orders.ts';
import type { TelegramInlineKeyboardMarkup, TelegramParseMode, UpdateContext } from '../types.ts';
import type { Ui } from '../telegram/i18n.ts';
import { loadRenewalConfig, type RenewalConfig } from '../catalog/renewal.ts';
import { isSalesStopped } from '../catalog/sales.ts';
import { loadPanelConfig, PasarGuardClient, type PanelUser } from '../pasarguard/client.ts';
import { backToMenuKeyboard, serviceDetailKeyboard, servicesListKeyboard } from '../telegram/menu.ts';
import { tgEscapeHtml } from '../telegram/format.ts';

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

export function statusLineFor(ui: Ui, expiresIso: string | null, nearDays: number): string {
  if (expiresIso === null) return ui.t.serviceStatusUnknown;
  const left = Math.ceil((Date.parse(expiresIso) - Date.now()) / DAY_MS);
  if (left <= 0) return ui.t.serviceStatusExpired;
  if (left <= nearDays) return ui.t.serviceStatusExpiring;
  return ui.t.serviceStatusActive;
}

export function expiryDisplay(ui: Ui, expiresIso: string | null): string {
  return expiresIso === null ? ui.t.accountNone : ui.f.date(expiresIso);
}

/** Phase 9 audit: detail shows expiry date AND TIME (repo displays UTC). */
export function expiryDateTimeDisplay(ui: Ui, expiresIso: string | null): string {
  if (expiresIso === null) return ui.t.accountNone;
  return ui.f.dateTime(expiresIso);
}

function gbDisplay(ui: Ui, bytes: number | null): string {
  if (bytes === null) return ui.t.accountNone;
  return ui.f.digits(Math.round((bytes / GB_BYTES) * 10) / 10);
}

export async function loadRenewalViewConfig(db: D1Database): Promise<RenewalConfig> {
  const loaded = await loadRenewalConfig(db);
  return loaded.ok
    ? loaded.config
    : { enabled: false, nearExpiryDays: DEFAULT_NEAR_EXPIRY_DAYS };
}

/** `menu:services` — the customer's own services, rendered from the DB. */
export async function showMyServices(ctx: UpdateContext): Promise<void> {
  const { t, f } = ctx.ui;
  const [rows, renewal] = await Promise.all([
    listServicesForCustomer(ctx.db, ctx.customerId, SERVICES_LIMIT),
    loadRenewalViewConfig(ctx.db),
  ]);
  if (rows.length === 0) {
    await ctx.api.sendMessage(ctx.chatId, t.servicesEmpty, backToMenuKeyboard(ctx.ui));
    return;
  }
  const lines: string[] = [t.servicesHeader];
  const entries: Array<{ orderId: string; label: string }> = [];
  rows.forEach((row, index) => {
    const expires = effectiveExpiryIso(row);
    const status = statusLineFor(ctx.ui, expires, renewal.nearExpiryDays);
    const snapshot = serviceSnapshotData(row);
    lines.push(
      t.servicesEntry(
        index + 1,
        snapshot.name ?? row.id.slice(0, 8),
        row.id.slice(0, 10),
        status,
        expiryDisplay(ctx.ui, expires),
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
    servicesListKeyboard(ctx.ui, entries),
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
  const { t, f } = ctx.ui;
  const service = await getOwnedService(ctx.db, ctx.customerId, orderId);
  if (!service) return null;
  const asHtml = service.subscription_url !== null;
  const esc = (value: string): string => (asHtml ? tgEscapeHtml(value) : value);

  const [renewal, active, salesStopped] = await Promise.all([
    loadRenewalViewConfig(ctx.db),
    findActiveRenewalForService(ctx.db, service.id),
    // Phase 13: a commercial stop hides the renew affordance too — the
    // server-side guard in renewableService stays the authority.
    isSalesStopped(ctx.db),
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
  const lines: string[] = [t.svcDetailHeader(esc(snapshot.name ?? t.accountNone))];
  lines.push(
    panelUser !== null && panelUser.status !== null
      ? esc(t.panelStatus(panelUser.status))
      : statusLineFor(ctx.ui, expiresIso, renewal.nearExpiryDays),
  );
  lines.push(t.svcId(service.id));
  if (service.pasarguard_username !== null) {
    lines.push(t.svcPanelUsername(service.pasarguard_username));
  }
  if (snapshot.volumeGb !== null) lines.push(t.summaryVolume(snapshot.volumeGb));
  if (snapshot.deviceCount !== null) lines.push(t.summaryDevices(snapshot.deviceCount));
  if (service.service_created_at !== null) {
    lines.push(t.svcCreated(f.date(service.service_created_at)));
  }
  lines.push(t.svcExpires(expiryDateTimeDisplay(ctx.ui, expiresIso)));
  if (expiresIso !== null) {
    const left = Math.ceil((Date.parse(expiresIso) - Date.now()) / DAY_MS);
    lines.push(left > 0 ? t.svcDaysLeft(left) : t.svcExpiredDaysAgo(Math.max(0, -left)));
  }
  if (panelUser !== null) {
    lines.push(t.svcUsage(gbDisplay(ctx.ui, panelUser.usedTraffic), gbDisplay(ctx.ui, panelUser.dataLimit)));
    // Phase 9 audit: remaining volume, explicit (panel bytes, display GB).
    if (panelUser.usedTraffic !== null && panelUser.dataLimit !== null) {
      lines.push(
        t.svcRemaining(
          f.digits(Math.max(0, Math.round(((panelUser.dataLimit - panelUser.usedTraffic) / GB_BYTES) * 10) / 10)),
        ),
      );
    }
  } else if (service.pasarguard_username !== null) {
    // Degraded path (snapshot render): point at the live-refresh affordance
    // instead of silently dropping the usage lines.
    lines.push(t.svcUsageHintSnapshot);
  }
  if (service.subscription_url !== null) {
    // Phase 8C: show the subscription URL as tap-to-copy inline code. The
    // value is panel-sourced, so HTML-escaping is also a correctness win.
    // Phase 9: name the panel page it opens (discovery only — no new page).
    lines.push(t.svcLinkCode(service.subscription_url));
    lines.push(t.svcPageNote);
  }
  if (active !== null) {
    lines.push(t.svcPendingRenewal(active.id.slice(0, 10)));
  }
  if (attemptedPanel) {
    lines.push(panelUser !== null ? t.svcLiveNote : t.svcSnapshotNote);
  }
  if (!renewal.enabled) lines.push(t.renewDisabledNotice);

  return {
    text: lines.join('\n'),
    keyboard: serviceDetailKeyboard(ctx.ui, service.id, {
      canRenew: renewal.enabled && !salesStopped && active === null,
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
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.serviceNotFound, true);
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
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.serviceNotFound, true);
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
    rendered.live ? ctx.ui.t.svcToastPanel : ctx.ui.t.svcToastSnapshot,
  );
}
