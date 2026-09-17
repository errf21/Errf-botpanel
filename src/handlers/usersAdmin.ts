/**
 * Phase 20: /users admin dashboard — clean control panel, not a DB viewer.
 *
 * S0 dashboard shows overview counts + navigation only (never user rows).
 * Lists are paginated (8/page, progressive disclosure); wallet and
 * repurchases are separated from profile/orders; destructive actions stay
 * isolated (repurchase cancel reuses the existing `adm:cancel` flow only).
 *
 * Security: every entry re-checks `ctx.isAdmin` server-side; targets are
 * re-resolved from D1 on every tap (numeric telegram id → customer row, then
 * internal id for all scoped queries); order cards verify
 * `order.customer_id === target.id`. Snapshot/D1 only — zero PasarGuard
 * calls. Never renders subscription_url, receipt_file_id, or any secret.
 */
import type { UpdateContext } from '../types.ts';
import {
  countCustomers,
  getCustomer,
  getCustomerByUsername,
  listCustomersPage,
} from '../db/customers.ts';
import {
  countActiveRepurchases,
  countActiveServicesForCustomer,
  countAliveServices,
  countAllServices,
  countOrdersForCustomer,
  countServicesForCustomerAdmin,
  findActiveRenewalForService,
  findActiveRepurchaseForService,
  getOrderById,
  isRepurchaseProvisioningStarted,
  listActiveRepurchasesForCustomer,
  listOrdersForCustomerAdmin,
  listServicesForCustomerAdmin,
} from '../db/orders.ts';
import { getBalance, listWalletEntries } from '../db/wallet.ts';
import { orderSummaryLines } from '../admin.ts';
import {
  effectiveExpiryIso,
  loadRenewalViewConfig,
  serviceSnapshotData,
  statusLineFor,
} from './services.ts';
import {
  adminCallback,
  userProfileKeyboard,
  usersBackKeyboard,
  usersCallbackDet,
  usersCallbackList,
  usersCallbackOrdd,
  usersCallbackSvcd,
  usersDashboardKeyboard,
  usersListKeyboard,
} from '../telegram/menu.ts';
import { fa } from '../telegram/texts.ts';
import { FA_UI } from '../telegram/i18n.ts';
import { parseUsernameTarget, type UsersListMode } from '../lib/validate.ts';

export const USERS_PAGE_SIZE = 8;
const MESSAGE_CAP = 3900;

function cap(text: string): string {
  return text.length > MESSAGE_CAP ? text.slice(0, MESSAGE_CAP) : text;
}

function digits(value: number): string {
  return FA_UI.f.digits(value);
}

function displayName(record: {
  first_name: string | null;
  last_name: string | null;
  telegram_username: string | null;
  telegram_user_id: string;
}): string {
  const full = `${record.first_name ?? ''} ${record.last_name ?? ''}`.trim();
  if (full) return full;
  if (record.telegram_username) return `@${record.telegram_username}`;
  return record.telegram_user_id;
}

function shortHandle(record: {
  first_name: string | null;
  telegram_username: string | null;
  telegram_user_id: string;
}): string {
  const name = (record.first_name ?? '').trim();
  if (name && record.telegram_username) return `${name} — @${record.telegram_username}`;
  if (name) return `${name} — ${record.telegram_user_id}`;
  if (record.telegram_username) return `@${record.telegram_username}`;
  return record.telegram_user_id;
}

/** Numeric telegram id with Persian/Arabic digit normalization (canonical lookup). */
function parseNumericTgid(raw: string): string | null {
  const normalized = raw
    .trim()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (!/^[0-9]{1,20}$/.test(normalized)) return null;
  const num = Number(normalized);
  if (!Number.isSafeInteger(num) || num <= 0) return null;
  return normalized;
}

/** Resolve a /users search arg (numeric id or @username) to a customer row. */
async function resolveSearchTarget(
  ctx: UpdateContext,
  raw: string,
): Promise<{ kind: 'found'; telegramId: string } | { kind: 'not_found' } | { kind: 'invalid' }> {
  const text = raw.trim();
  if (!text) return { kind: 'invalid' };
  const numeric = parseNumericTgid(text);
  if (numeric !== null) {
    const record = await getCustomer(ctx.db, Number(numeric));
    return record ? { kind: 'found', telegramId: record.telegram_user_id } : { kind: 'not_found' };
  }
  const username = parseUsernameTarget(text);
  if (username === null) return { kind: 'invalid' };
  const record = await getCustomerByUsername(ctx.db, username);
  return record ? { kind: 'found', telegramId: record.telegram_user_id } : { kind: 'not_found' };
}

/* ———— S0: dashboard home (counts + nav, never user rows) ———— */

/** `/users` with no args — overview counts + navigation. Admin-only. */
export async function showUsersMenu(ctx: UpdateContext): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return;
  }
  const [users, alive, total, repurchases] = await Promise.all([
    countCustomers(ctx.db),
    countAliveServices(ctx.db),
    countAllServices(ctx.db),
    countActiveRepurchases(ctx.db),
  ]);
  const lines = [
    fa.usersDashboardHeader,
    '',
    fa.usersDashboardUsers(digits(users)),
    fa.usersDashboardActiveServices(digits(alive)),
    fa.usersDashboardTotalServices(digits(total)),
    fa.usersDashboardActiveRepurchases(digits(repurchases)),
  ];
  await ctx.api.sendMessage(ctx.chatId, cap(lines.join('\n')), usersDashboardKeyboard(fa));
}

/** `/users <id|@username>` — migration-free direct jump (no arming/state). */
export async function handleUsersCommand(ctx: UpdateContext, args: string[]): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return;
  }
  const [raw = ''] = args;
  if (!raw || !raw.trim()) {
    await showUsersMenu(ctx);
    return;
  }
  const resolved = await resolveSearchTarget(ctx, raw);
  if (resolved.kind === 'found') {
    await showUserDetail(ctx, resolved.telegramId, 'det', 0);
    return;
  }
  if (resolved.kind === 'not_found') {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  await ctx.api.sendMessage(
    ctx.chatId,
    `${fa.usersUsage}\n\n${fa.usersSearchHint}`,
    usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'),
  );
}

/* ———— S1: user list (mode-aware picker, 8/page) ———— */

const LIST_TITLE: Record<UsersListMode, string> = {
  det: fa.usersListHeader,
  svc: fa.usersServicesHeader,
  ord: fa.usersOrdersHeader,
  rep: fa.usersRepurchasesHeader,
  wal: fa.usersWalletHeader(fa.accountNone),
};

export async function showUsersPage(
  ctx: UpdateContext,
  next: UsersListMode,
  page: number,
): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return;
  }
  const safePage = Number.isSafeInteger(page) && page >= 0 ? Math.min(page, 9999) : 0;
  const total = await countCustomers(ctx.db);
  const pages = Math.max(1, Math.ceil(total / USERS_PAGE_SIZE));
  const clamped = Math.min(safePage, pages - 1);
  const rows = await listCustomersPage(ctx.db, USERS_PAGE_SIZE, clamped * USERS_PAGE_SIZE);
  if (rows.length === 0) {
    await ctx.api.sendMessage(
      ctx.chatId,
      `${LIST_TITLE[next]}\n\n${fa.usersListEmpty}`,
      usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'),
    );
    return;
  }
  const lines = [
    LIST_TITLE[next],
    fa.usersListPage(digits(clamped + 1), digits(pages)),
    '',
  ];
  rows.forEach((row, index) => {
    const n = clamped * USERS_PAGE_SIZE + index + 1;
    const balance = FA_UI.f.price(typeof row.balance_irt === 'number' ? row.balance_irt : 0, 'IRT');
    lines.push(fa.usersListEntry(n, shortHandle(row), balance));
  });
  const entries = rows.map((row) => ({
    label: `${clamped * USERS_PAGE_SIZE + rows.indexOf(row) + 1}. ${displayName(row)}`.slice(0, 60),
    callback: usersCallbackDet(row.telegram_user_id, next, clamped),
  }));
  await ctx.api.sendMessage(
    ctx.chatId,
    cap(lines.join('\n')),
    usersListKeyboard(fa, entries, {
      prev: clamped > 0 ? usersCallbackList(next, clamped - 1) : null,
      next: clamped + 1 < pages ? usersCallbackList(next, clamped + 1) : null,
      back: 'usr:menu',
    }),
  );
}

/* ———— S2: compact profile card ———— */

export async function showUserDetail(
  ctx: UpdateContext,
  tgid: string,
  originNext: UsersListMode,
  originPage: number,
): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return;
  }
  const numeric = parseNumericTgid(tgid);
  if (numeric === null) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const record = await getCustomer(ctx.db, Number(numeric));
  if (!record) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const [balance, totalServices, activeServices] = await Promise.all([
    getBalance(ctx.db, record.id),
    countServicesForCustomerAdmin(ctx.db, record.id),
    countActiveServicesForCustomer(ctx.db, record.id),
  ]);
  const name = displayName(record);
  const fullName = `${record.first_name ?? ''} ${record.last_name ?? ''}`.trim();
  const lines = [
    fa.usersProfileHeader(name),
    '',
    fa.usersProfileId(record.telegram_user_id),
    fa.usersProfileName(fullName || fa.accountNone),
    fa.usersProfileUsername(record.telegram_username ? `@${record.telegram_username}` : fa.accountNone),
    fa.usersProfileSince(FA_UI.f.date(record.created_at)),
    fa.usersProfileBalance(FA_UI.f.price(balance ?? 0, 'IRT')),
    fa.usersProfileServices(
      totalServices === 0
        ? digits(0)
        : `${digits(totalServices)} (فعال ${digits(activeServices)})`,
    ),
  ];
  await ctx.api.sendMessage(
    ctx.chatId,
    cap(lines.join('\n')),
    userProfileKeyboard(fa, record.telegram_user_id, { next: originNext, page: originPage }),
  );
}

/* ———— S3: services (admin history includes panel-deleted) ———— */

export async function showUserServices(
  ctx: UpdateContext,
  tgid: string,
  page: number,
): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return;
  }
  const numeric = parseNumericTgid(tgid);
  if (numeric === null) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const record = await getCustomer(ctx.db, Number(numeric));
  if (!record) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const safePage = Number.isSafeInteger(page) && page >= 0 ? Math.min(page, 9999) : 0;
  const [total, renewal] = await Promise.all([
    countServicesForCustomerAdmin(ctx.db, record.id),
    loadRenewalViewConfig(ctx.db).catch(() => ({ nearExpiryDays: 7 })),
  ]);
  const nearDays = typeof renewal.nearExpiryDays === 'number' ? renewal.nearExpiryDays : 7;
  const pages = Math.max(1, Math.ceil(total / USERS_PAGE_SIZE));
  const clamped = Math.min(safePage, pages - 1);
  const rows = await listServicesForCustomerAdmin(ctx.db, record.id, USERS_PAGE_SIZE, clamped * USERS_PAGE_SIZE);
  const back = usersCallbackDet(record.telegram_user_id, 'det', 0);
  if (rows.length === 0) {
    await ctx.api.sendMessage(
      ctx.chatId,
      `${fa.usersServicesHeader}\n${displayName(record)}\n\n${fa.usersServicesEmpty}`,
      usersBackKeyboard(fa.usersBackProfile, back),
    );
    return;
  }
  const lines = [
    `${fa.usersServicesHeader} — ${displayName(record)}`,
    fa.usersListPage(digits(clamped + 1), digits(pages)),
    '',
  ];
  rows.forEach((row, index) => {
    const n = clamped * USERS_PAGE_SIZE + index + 1;
    const snapshot = serviceSnapshotData(row);
    const name = snapshot.name ?? row.id.slice(0, 8);
    const status =
      row.panel_deleted_at !== null ? fa.serviceStatusDeleted : statusLineFor(FA_UI, effectiveExpiryIso(row), nearDays);
    const expires =
      row.panel_deleted_at !== null
        ? fa.serviceStatusDeleted
        : effectiveExpiryIso(row) === null
          ? fa.accountNone
          : FA_UI.f.date(effectiveExpiryIso(row) as string);
    lines.push(fa.usersServiceEntry(n, name, status, expires));
  });
  const entries = rows.map((row) => {
    const snapshot = serviceSnapshotData(row);
    const name = snapshot.name ?? row.id.slice(0, 8);
    const status =
      row.panel_deleted_at !== null ? fa.serviceStatusDeleted : statusLineFor(FA_UI, effectiveExpiryIso(row), nearDays);
    return {
      label: `📦 ${name} — ${status}`.slice(0, 60),
      callback: usersCallbackSvcd(record.telegram_user_id, row.id),
    };
  });
  await ctx.api.sendMessage(
    ctx.chatId,
    cap(lines.join('\n')),
    usersListKeyboard(fa, entries, {
      prev: clamped > 0 ? `usr:svc:${record.telegram_user_id}:${clamped - 1}` : null,
      next: clamped + 1 < pages ? `usr:svc:${record.telegram_user_id}:${clamped + 1}` : null,
      back,
    }),
  );
}

/** Compact service card (snapshot-only, never panel reads, never secrets). */
export async function showUserServiceDetail(
  ctx: UpdateContext,
  tgid: string,
  orderId: string,
): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return;
  }
  const numeric = parseNumericTgid(tgid);
  if (numeric === null) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const record = await getCustomer(ctx.db, Number(numeric));
  if (!record) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const back = `usr:svc:${record.telegram_user_id}:0`;
  const order = await getOrderById(ctx.db, orderId);
  if (!order || order.customer_id !== record.id || order.kind !== 'purchase' || order.state !== 'completed') {
    await ctx.api.sendMessage(ctx.chatId, fa.invalidChoice, usersBackKeyboard(fa.usersBackProfile, back));
    return;
  }
  const [renewal, activeRenewal, activeRepurchase] = await Promise.all([
    loadRenewalViewConfig(ctx.db).catch(() => ({ nearExpiryDays: 7 })),
    findActiveRenewalForService(ctx.db, order.id).catch(() => null),
    findActiveRepurchaseForService(ctx.db, order.id).catch(() => null),
  ]);
  const nearDays = typeof renewal.nearExpiryDays === 'number' ? renewal.nearExpiryDays : 7;
  const snapshot = serviceSnapshotData(order);
  const name = snapshot.name ?? fa.accountNone;
  const expires = effectiveExpiryIso(order);
  const lines = [
    fa.usersServiceDetailHeader(name),
    order.panel_deleted_at !== null
      ? fa.serviceStatusDeleted
      : statusLineFor(FA_UI, expires, nearDays),
    fa.svcId(order.id),
  ];
  if (order.pasarguard_username !== null) lines.push(fa.svcPanelUsername(order.pasarguard_username));
  if (snapshot.volumeGb !== null) lines.push(fa.summaryVolume(snapshot.volumeGb));
  if (snapshot.deviceCount !== null) lines.push(fa.summaryDevices(snapshot.deviceCount));
  if (order.service_created_at !== null) lines.push(fa.svcCreated(FA_UI.f.date(order.service_created_at)));
  if (order.panel_deleted_at === null && expires !== null) {
    lines.push(fa.svcExpires(FA_UI.f.dateTime(expires)));
  }
  if (activeRenewal !== null && activeRenewal.repurchase_mode == null) {
    lines.push(fa.svcPendingRenewal(activeRenewal.id.slice(0, 10)));
  }
  if (activeRepurchase !== null) {
    lines.push(fa.svcPendingRepurchase(activeRepurchase.id.slice(0, 10)));
    lines.push(fa.repActiveLine(activeRepurchase.id, FA_UI.t.orderStatus(activeRepurchase.state)));
  }
  await ctx.api.sendMessage(ctx.chatId, cap(lines.join('\n')), usersBackKeyboard(fa.usersBackProfile, back));
}

/* ———— S4: orders (full history paginated) ———— */

function orderKindLabel(order: { kind: string; repurchase_mode: string | null }): string {
  if (order.kind !== 'renewal') return 'خرید ';
  return order.repurchase_mode !== null ? `${FA_UI.t.ordersKindRepurchase} ` : `${FA_UI.t.ordersKindRenewal} `;
}

export async function showUserOrders(
  ctx: UpdateContext,
  tgid: string,
  page: number,
): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return;
  }
  const numeric = parseNumericTgid(tgid);
  if (numeric === null) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const record = await getCustomer(ctx.db, Number(numeric));
  if (!record) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const safePage = Number.isSafeInteger(page) && page >= 0 ? Math.min(page, 9999) : 0;
  const total = await countOrdersForCustomer(ctx.db, record.id);
  const pages = Math.max(1, Math.ceil(total / USERS_PAGE_SIZE));
  const clamped = Math.min(safePage, pages - 1);
  const rows = await listOrdersForCustomerAdmin(ctx.db, record.id, USERS_PAGE_SIZE, clamped * USERS_PAGE_SIZE);
  const back = usersCallbackDet(record.telegram_user_id, 'det', 0);
  if (rows.length === 0) {
    await ctx.api.sendMessage(
      ctx.chatId,
      `${fa.usersOrdersHeader}\n${displayName(record)}\n\n${fa.usersOrdersEmpty}`,
      usersBackKeyboard(fa.usersBackProfile, back),
    );
    return;
  }
  const lines = [
    `${fa.usersOrdersHeader} — ${displayName(record)}`,
    fa.usersListPage(digits(clamped + 1), digits(pages)),
    '',
  ];
  rows.forEach((row, index) => {
    const n = clamped * USERS_PAGE_SIZE + index + 1;
    lines.push(
      fa.usersOrderEntry(
        n,
        row.id.slice(0, 10),
        orderKindLabel(row),
        FA_UI.t.orderStatus(row.state),
        FA_UI.f.price(row.amount, row.currency),
        row.created_at.slice(0, 10),
      ),
    );
  });
  const entries = rows.map((row) => ({
    label: `🧾 ${row.id.slice(0, 10)} — ${FA_UI.t.orderStatus(row.state)}`.slice(0, 60),
    callback: usersCallbackOrdd(record.telegram_user_id, row.id),
  }));
  await ctx.api.sendMessage(
    ctx.chatId,
    cap(lines.join('\n')),
    usersListKeyboard(fa, entries, {
      prev: clamped > 0 ? `usr:ord:${record.telegram_user_id}:${clamped - 1}` : null,
      next: clamped + 1 < pages ? `usr:ord:${record.telegram_user_id}:${clamped + 1}` : null,
      back,
    }),
  );
}

/** Read-only order card (reuses snapshot renderers, never receipt/secrets). */
export async function showUserOrderDetail(
  ctx: UpdateContext,
  tgid: string,
  orderId: string,
): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return;
  }
  const numeric = parseNumericTgid(tgid);
  if (numeric === null) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const record = await getCustomer(ctx.db, Number(numeric));
  if (!record) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const back = `usr:ord:${record.telegram_user_id}:0`;
  const order = await getOrderById(ctx.db, orderId);
  if (!order || order.customer_id !== record.id) {
    await ctx.api.sendMessage(ctx.chatId, fa.invalidChoice, usersBackKeyboard(fa.usersBackProfile, back));
    return;
  }
  const lines = [
    ...orderSummaryLines(order),
    `📊 وضعیت: ${FA_UI.t.orderStatus(order.state)}`,
    `📅 ثبت: ${order.created_at.slice(0, 10)}`,
  ];
  await ctx.api.sendMessage(ctx.chatId, cap(lines.join('\n')), usersBackKeyboard(fa.usersBackProfile, back));
}

/* ———— S5: wallet (separated, read-only + hint) ———— */

export async function showUserWallet(ctx: UpdateContext, tgid: string): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return;
  }
  const numeric = parseNumericTgid(tgid);
  if (numeric === null) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const record = await getCustomer(ctx.db, Number(numeric));
  if (!record) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const back = usersCallbackDet(record.telegram_user_id, 'det', 0);
  const [balance, entries] = await Promise.all([
    getBalance(ctx.db, record.id),
    listWalletEntries(ctx.db, record.id, USERS_PAGE_SIZE),
  ]);
  const lines = [
    fa.usersWalletHeader(displayName(record)),
    '',
    fa.walletBalance(FA_UI.f.price(balance ?? 0, 'IRT')),
  ];
  if (entries.length === 0) {
    lines.push('', fa.walletEmpty);
  } else {
    lines.push('');
    entries.forEach((entry, index) => {
      lines.push(
        FA_UI.t.walletEntry(
          index + 1,
          entry.delta_irt > 0 ? '➕' : '➖',
          FA_UI.t.walletKind(entry.kind),
          FA_UI.f.price(Math.abs(entry.delta_irt), 'IRT'),
          FA_UI.f.date(entry.created_at),
        ),
      );
    });
  }
  lines.push('', fa.usersWalletHint);
  await ctx.api.sendMessage(ctx.chatId, cap(lines.join('\n')), usersBackKeyboard(fa.usersBackProfile, back));
}

/* ———— S6: repurchases (separated; cancel via existing adm:cancel only) ———— */

export async function showUserRepurchases(ctx: UpdateContext, tgid: string): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return;
  }
  const numeric = parseNumericTgid(tgid);
  if (numeric === null) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const record = await getCustomer(ctx.db, Number(numeric));
  if (!record) {
    await ctx.api.sendMessage(ctx.chatId, fa.usersNotFound, usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'));
    return;
  }
  const back = usersCallbackDet(record.telegram_user_id, 'det', 0);
  const rows = await listActiveRepurchasesForCustomer(ctx.db, record.id, 20);
  if (rows.length === 0) {
    await ctx.api.sendMessage(
      ctx.chatId,
      `${fa.usersRepurchasesHeader}\n${displayName(record)}\n\n${fa.usersRepurchasesEmpty}`,
      usersBackKeyboard(fa.usersBackProfile, back),
    );
    return;
  }
  const lines = [fa.usersRepurchasesHeader, displayName(record), ''];
  rows.forEach((row, index) => {
    const mode = row.repurchase_mode === 'custom' ? 'custom' : row.repurchase_mode === 'same' ? 'same' : '—';
    lines.push(
      fa.adminRepurchaseEntry(index + 1, row.id, FA_UI.t.orderStatus(row.state), mode, row.id.slice(0, 10)),
    );
    lines.push(
      isRepurchaseProvisioningStarted(row)
        ? `   ${fa.adminRepurchaseProvisioningLine}`
        : `   ${fa.adminRepurchaseLockLine}`,
    );
  });
  // Destructive actions isolated: cancel buttons ONLY for cancellable rows,
  // reusing the existing `adm:cancel:` flow (single source of truth).
  const cancelRows = rows
    .filter(
      (row) =>
        (row.state === 'pending_payment' ||
          row.state === 'awaiting_review' ||
          row.state === 'approved' ||
          row.state === 'failed') &&
        !isRepurchaseProvisioningStarted(row),
    )
    .map((row) => [{ text: `🗑 ${row.id.slice(0, 10)}…`, callback_data: adminCallback('cancel', row.id) }]);
  cancelRows.push([{ text: fa.usersBackProfile, callback_data: back }]);
  await ctx.api.sendMessage(ctx.chatId, cap(lines.join('\n')), { inline_keyboard: cancelRows });
}

/* ———— search hint (stateless, migration-free) ———— */

export async function showUsersSearchHint(ctx: UpdateContext): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.sendMessage(ctx.chatId, fa.cmdAdminOnly);
    return;
  }
  await ctx.api.sendMessage(
    ctx.chatId,
    fa.usersSearchHint,
    usersBackKeyboard(fa.usersBackDashboard, 'usr:menu'),
  );
}

/* ———— usr: callback dispatcher (admin re-checked on every branch) ———— */

export async function handleUsersCallback(
  ctx: UpdateContext,
  action:
    | { action: 'menu' }
    | { action: 'search' }
    | { action: 'list'; next: UsersListMode; page: number }
    | { action: 'det'; tgid: string; next: UsersListMode; page: number }
    | { action: 'svc'; tgid: string; page: number }
    | { action: 'svcd'; tgid: string; orderId: string }
    | { action: 'ord'; tgid: string; page: number }
    | { action: 'ordd'; tgid: string; orderId: string }
    | { action: 'wal'; tgid: string }
    | { action: 'rep'; tgid: string },
  callbackQueryId: string,
): Promise<void> {
  if (!ctx.isAdmin) {
    await ctx.api.answerCallbackQuery(callbackQueryId, ctx.ui.t.invalidChoice);
    return;
  }
  await ctx.api.answerCallbackQuery(callbackQueryId);
  switch (action.action) {
    case 'menu':
      await showUsersMenu(ctx);
      return;
    case 'search':
      await showUsersSearchHint(ctx);
      return;
    case 'list': {
      // A repurchase/wallet "list" pick reuses the user picker, then jumps
      // straight into that subsection on select (progressive disclosure).
      await showUsersPage(ctx, action.next, action.page);
      return;
    }
    case 'det': {
      // Picker-mode jump: land directly in the chosen subsection when the
      // list was opened from a dashboard subsection button.
      if (action.next === 'svc') {
        await showUserServices(ctx, action.tgid, 0);
        return;
      }
      if (action.next === 'ord') {
        await showUserOrders(ctx, action.tgid, 0);
        return;
      }
      if (action.next === 'rep') {
        await showUserRepurchases(ctx, action.tgid);
        return;
      }
      if (action.next === 'wal') {
        await showUserWallet(ctx, action.tgid);
        return;
      }
      await showUserDetail(ctx, action.tgid, action.next, action.page);
      return;
    }
    case 'svc':
      await showUserServices(ctx, action.tgid, action.page);
      return;
    case 'svcd':
      await showUserServiceDetail(ctx, action.tgid, action.orderId);
      return;
    case 'ord':
      await showUserOrders(ctx, action.tgid, action.page);
      return;
    case 'ordd':
      await showUserOrderDetail(ctx, action.tgid, action.orderId);
      return;
    case 'wal':
      await showUserWallet(ctx, action.tgid);
      return;
    case 'rep':
      await showUserRepurchases(ctx, action.tgid);
      return;
  }
}
