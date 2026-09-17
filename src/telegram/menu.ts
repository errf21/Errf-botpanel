import type {
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
  TelegramKeyboardButtonStyle,
  TelegramReplyKeyboardButton,
  TelegramReplyKeyboardMarkup,
} from '../types.ts';
import type { Texts } from './texts.ts';
import type { Ui } from './i18n.ts';
import { EN_UI, FA_UI } from './i18n.ts';

/**
 * Callback data vocabulary. Anything not in this exact set is rejected —
 * callback data is user-editable on the wire, so it is treated as hostile.
 * (Phase 3 will add `vol:`/`dur:`/`dev:` namespaces here + in `machine.ts`.)
 */
export const CB = {
  MENU_BUY: 'menu:buy',
  MENU_SERVICES: 'menu:services',
  MENU_ORDERS: 'menu:orders',
  MENU_ACCOUNT: 'menu:account',
  MENU_SUPPORT: 'menu:support',
  /** The customer's formal, trackable ticket flow (creates the ticket). */
  MENU_TICKET: 'menu:ticket',
  MENU_WALLET: 'menu:wallet',
  MENU_INVITE: 'menu:invite',
  /** ADMIN ticket queue — admin-only, reachable from inline buttons only. */
  MENU_TICKETS: 'menu:tickets',
  MENU_ANNOUNCE_LIST: 'menu:anncs',
  /** Phase 10: opens the language picker (stays the LAST main-menu button). */
  MENU_LANGUAGE: 'menu:lang',
  /** Phase 10: the two explicit choices; persisted server-side, never guessed. */
  LANG_FA: 'lang:fa',
  LANG_EN: 'lang:en',
  /** Phase 11: opens the connection guide (an unstyled main-menu button). */
  MENU_GUIDE: 'menu:guide',
  /**
   * Phase 11: stateless guide navigation. Every screen is re-derived from the
   * static registry in `guide.ts`, so these bare flat values (same validated
   * `name:payload` shape as everything above) are safe to tap repeatedly —
   * no state reads, no writes, no session involvement.
   */
  GUIDE_ANDROID: 'gud:android',
  GUIDE_IOS: 'gud:ios',
  GUIDE_WINDOWS: 'gud:windows',
  GUIDE_AND_NEKO: 'gud:and_neko',
  GUIDE_AND_TUN: 'gud:and_tun',
  GUIDE_AND_NG: 'gud:and_ng',
  GUIDE_IOS_V2BOX: 'gud:ios_v2box',
  GUIDE_IOS_STREISAND: 'gud:ios_streisand',
  GUIDE_WIN_THRONE: 'gud:win_throne',
  ACT_CANCEL: 'act:cancel',
  ACT_BACK_MENU: 'act:back_menu',
  STEP_BACK: 'step:back',
  ORDER_CONFIRM: 'ord:confirm',
  /** Phase 7: auto-pick a config name (allowed ONLY while WAITING_CONFIG_NAME). */
  CONFIG_AUTO: 'cfg:auto',
  /** Phase 7: wallet-paid order buttons on the purchase/renewal summary. */
  PAY_WALLET_FULL: 'wlt:full',
  PAY_WALLET_PART: 'wlt:part',
  /** Phase 17: customer wallet top-up entry (wallet view → amount → receipt). */
  TOPUP_START: 'top:start',
  /** Phase 15: claim the one-time free test (offer / services empty state). */
  TEST_CLAIM: 'tst:claim',
} as const;

/**
 * Admin action callbacks carry a ULID order id, so they live in their own
 * namespace with dedicated builders — values are produced ONLY by
 * `adminCallback()` below and parsed ONLY by `parseAdminCallback()`.
 *
 * Phase 10 note: admin-review keyboards are Persian-ONLY operational surface
 * (operator decision) — their labels are deliberately literal `fa` strings,
 * no `ui` parameter, so a mis-routed or forged tap can never localize them.
 */
export function adminCallback(
  action: 'ok' | 'no' | 'skip' | 'rt' | 'cancel',
  orderId: string,
): string {
  return `adm:${action}:${orderId}`;
}

export function adminReceiptKeyboard(orderId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('✅ تأیید پرداخت', adminCallback('ok', orderId)), button('❌ رد', adminCallback('no', orderId))],
    ],
  };
}

/* ———— Repurchase lock management ————
 * Reuses the `adm:` namespace (strict parser in validate.ts); the cancel
 * action addresses ONLY repurchase rows server-side (guarded by
 * cancelRepurchaseOrder). Labels stay literal Persian (admin surface rule).
 */
export function adminRepurchaseReceiptKeyboard(
  orderId: string,
  cancellable: boolean,
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [
    [button('✅ تأیید پرداخت', adminCallback('ok', orderId)), button('❌ رد', adminCallback('no', orderId))],
  ];
  if (cancellable) {
    rows.push([button('🗑 لغو خرید مجدد', adminCallback('cancel', orderId))]);
  }
  return { inline_keyboard: rows };
}

export function adminRepurchaseQueueKeyboard(
  entries: Array<{ orderId: string; cancellable: boolean }>,
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: entries.map((entry) =>
      entry.cancellable
        ? [button(`🗑 ${entry.orderId.slice(0, 10)}…`, adminCallback('cancel', entry.orderId))]
        : [button(`ℹ️ ${entry.orderId.slice(0, 10)}…`, adminCallback('rt', entry.orderId))],
    ),
  };
}

/** Phase 8A: the reject-reason prompt is text input → composing-mode buttons. */
export function adminRejectPromptKeyboard(): TelegramReplyKeyboardMarkup {
  return composingKeyboard(FA_UI, [STEP_SKIP_REJECT_TEXT]);
}

export function adminQueueKeyboard(orderIds: string[]): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: orderIds.map((orderId) => [
      button('✅', adminCallback('ok', orderId)),
      button('❌', adminCallback('no', orderId)),
    ]),
  };
}

/** Phase 5: single-order retry button on provisioning-failure pushes. */
export function adminProvisionFailedKeyboard(orderId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [[button('🔁 تلاش مجدد', adminCallback('rt', orderId))]],
  };
}

/* ———— Phase 16: admin panel-service delete ————
 * Like every other admin keyboard the labels are deliberately literal
 * Persian (operating tools never localize). `pdel:` values are produced ONLY
 * here and consumed ONLY by `parsePanelDeleteCallback()`; the delete itself
 * re-checks admin + order state server-side on every tap.
 */
export function panelDeleteCallback(action: 'ok' | 'no', orderId: string): string {
  return `pdel:${action}:${orderId}`;
}

export function panelDeleteConfirmKeyboard(orderId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('🔴 تأیید حذف از پنل', panelDeleteCallback('ok', orderId))],
      [button('↩️ انصراف', panelDeleteCallback('no', orderId))],
    ],
  };
}

/** Phase 5: /failed queue — one retry button per failed order. */
export function failedQueueKeyboard(orderIds: string[]): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: orderIds.map((orderId) => [
      button(`🔁 ${orderId.slice(0, 10)}…`, adminCallback('rt', orderId)),
    ]),
  };
}

/* ———— Phase 6: My Services + renewals ————
 * `svc:` callbacks carry a full 28-char order id (beyond the generic
 * pattern's 24-char payload cap), so they get their OWN builder/parser pair
 * exactly like `adm:` — produced ONLY here, consumed ONLY by
 * `parseServiceCallback()`, and every action re-checks ownership server-side.
 */
export type ServiceAction = 'det' | 'ref' | 'rnw' | 'rep' | 'cancel';

export function serviceCallback(action: ServiceAction, orderId: string): string {
  return `svc:${action}:${orderId}`;
}

/** Services list: one detail button per service, then a menu row. */
export function servicesListKeyboard(
  ui: Ui,
  entries: Array<{ orderId: string; label: string }>,
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = entries.map((entry) => [
    button(entry.label, serviceCallback('det', entry.orderId)),
  ]);
  rows.push([button(ui.t.backToMenu, CB.ACT_BACK_MENU)]);
  return { inline_keyboard: rows };
}

/** Service detail: optional renewal + refresh row, service list, menu. */
/**
 * The detail keyboard. `serviceUrl` (when present) becomes the FIRST button:
 * Phase 9 discovery CTA that opens the EXISTING panel subscription page —
 * the bot builds no page of its own, it only points at the panel's.
 */
export function serviceDetailKeyboard(
  ui: Ui,
  orderId: string,
  opts: { canRepurchase: boolean; serviceUrl: string | null; canCancelRepurchase?: boolean },
): TelegramInlineKeyboardMarkup {
  const t = ui.t;
  const top: TelegramInlineKeyboardButton[] = [];
  // Phase 19: repurchase REPLACED renewal for every paid service — the legacy
  // renewal button is gone from the product. `serviceCallback('rnw', …)`
  // still parses (validate.ts) so stale keyboards get a retired notice
  // instead of an invalid-choice dead end.
  if (opts.canRepurchase) {
    top.push(button(t.repEntryButton, serviceCallback('rep', orderId)));
  }
  const rows: TelegramInlineKeyboardButton[][] = [
    ...(top.length > 0 ? [top] : []),
    ...(opts.canRepurchase ? [[button(t.repBuyNewButton, CB.MENU_BUY)]] : []),
    ...(opts.canCancelRepurchase === true
      ? [[button(t.repCancelButton, serviceCallback('cancel', orderId))]]
      : []),
    ...(opts.serviceUrl !== null ? [[urlButton(t.svcOpenPage, opts.serviceUrl)]] : []),
    [button(t.btnRefreshStatus, serviceCallback('ref', orderId))],
    [button(t.menuServices, CB.MENU_SERVICES)],
    [button(t.backToMenu, CB.ACT_BACK_MENU)],
  ];
  return { inline_keyboard: rows };
}

/**
 * Phase 18: repurchase mode picker — same previous specs vs customize.
 * Values are fixed literals (validated by exact match in the handler).
 */
export function repurchaseModeKeyboard(ui: Ui): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button(ui.t.repModeSame, 'rep:same')],
      [button(ui.t.repModeCustom, 'rep:custom')],
      [button(ui.t.btnCancelInline, CB.ACT_CANCEL)],
    ],
  };
}

/**
 * Phase 9 notice keyboard: view THIS service (validated `svc:det` tap with a
 * server-side ownership re-check) + the services list. No URLs here: the
 * detail view behind the first button carries the service-page CTA.
 */
export function serviceNoticeKeyboard(ui: Ui, orderId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button(ui.t.serviceNoticeView, serviceCallback('det', orderId))],
      [button(ui.t.serviceNoticeList, CB.MENU_SERVICES)],
    ],
  };
}

/** Phase 9: provisioning-success keyboard — open the panel's service page
 *  (when the link exists) and the services list. Pure discovery. */
export function serviceReadyKeyboard(ui: Ui, serviceUrl: string | null): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...(serviceUrl !== null ? [[urlButton(ui.t.svcOpenPage, serviceUrl)]] : []),
      [button(ui.t.serviceNoticeList, CB.MENU_SERVICES)],
    ],
  };
}

/** Renewal duration: no-extension row + month presets (labels month-aware upstream). */
export function renewalDurationKeyboard(
  ui: Ui,
  presets: number[],
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [];
  rows.push([button(ui.t.renewNoDuration, 'dur:0')]);
  for (let i = 0; i < presets.length; i += 2) {
    const row: TelegramInlineKeyboardButton[] = [];
    for (const value of presets.slice(i, i + 2)) {
      row.push(button(ui.f.duration(value), `dur:${value}`));
    }
    rows.push(row);
  }
  rows.push([button(ui.t.btnCancelInline, CB.ACT_CANCEL)]);
  return { inline_keyboard: rows };
}

/** Renewal add-on volume: fixed presets + custom entry + no-increase row. */
export function renewalVolumeKeyboard(
  ui: Ui,
  presets: number[],
  allowCustom: boolean,
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [];
  for (let i = 0; i < presets.length; i += 2) {
    const row: TelegramInlineKeyboardButton[] = [];
    for (const value of presets.slice(i, i + 2)) {
      row.push(button(`+${String(value)}GB`, `vol:${value}`));
    }
    rows.push(row);
  }
  if (allowCustom) {
    rows.push([button(ui.t.customVolumeLabel, 'vol:custom')]);
  }
  rows.push([button(ui.t.renewNoVolume, 'vol:0')]);
  rows.push([button(ui.t.stepBack, CB.STEP_BACK), button(ui.t.btnCancelInline, CB.ACT_CANCEL)]);
  return { inline_keyboard: rows };
}

export type KnownCallback = (typeof CB)[keyof typeof CB];

const KNOWN_CALLBACK_VALUES: readonly string[] = Object.values(CB);

/** Option-namespace values are catalog-derived (validated in handlers). */
export type OptionNamespace = 'vol' | 'dur' | 'dev';

export type RouteResult =
  | { kind: 'known'; callback: KnownCallback }
  | { kind: 'option'; namespace: OptionNamespace; value: 'custom' | number }
  | { kind: 'invalid' };

const NAMESPACE_STEP: Record<OptionNamespace, 'volume' | 'duration' | 'device'> = {
  vol: 'volume',
  dur: 'duration',
  dev: 'device',
};

export function stepForNamespace(ns: OptionNamespace): 'volume' | 'duration' | 'device' {
  return NAMESPACE_STEP[ns];
}

/** Classify validated callback data against the static allowlist + option namespaces. */
export function routeCallback(data: string): RouteResult {
  if (isKnownCallback(data)) return { kind: 'known', callback: data };
  const match = /^(vol|dur|dev):(.+)$/.exec(data);
  if (match) {
    const ns = match[1] as OptionNamespace;
    const raw = match[2] ?? '';
    if (raw === 'custom') return { kind: 'option', namespace: ns, value: 'custom' };
    if (/^[0-9]{1,8}$/.test(raw)) {
      const num = Number(raw);
      if (Number.isSafeInteger(num)) {
        return { kind: 'option', namespace: ns, value: num };
      }
    }
  }
  return { kind: 'invalid' };
}

export function isKnownCallback(data: string): data is KnownCallback {
  return KNOWN_CALLBACK_VALUES.includes(data);
}

function button(text: string, callbackData: string): TelegramInlineKeyboardButton {
  return { text, callback_data: callbackData };
}

/** Phase 9: opener for the EXISTING panel subscription page (never callback). */
function urlButton(text: string, url: string): TelegramInlineKeyboardButton {
  return { text, url };
}

/* ———— Phase 8A: main menu = a REAL Reply Keyboard (one source of truth) ————
 * Reply-keyboard taps arrive as ordinary text messages, so the menu doubles
 * as the exact-match routing table (`menuCallbackForText`) feeding the SAME
 * callback vocabulary the inline buttons historically used. Labels must
 * stay byte-identical to the button text: Telegram echoes them verbatim.
 * Every entry carries a style — `success` (green) on the wallet/services/buy
 * group, `primary` (blue) on the account/orders/invite/support group, and
 * `danger` (red) on the ticket/guide/language group.
 *
 * Phase 10: LABELS ARE LOCALIZED but ROUTING IS NOT. Every keyboard label the
 * bot can ever display is indexed across ALL bundles, so a tap on a stale
 * Persian keyboard from an English user (or the reverse) still routes to the
 * exact same callback. The language button's own label is deliberately
 * bilingual and locale-FIXED, so it survives any switch mid-air.
 */

/** The locale-independent selector label (byte-identical in both bundles). */
const LANG_LABEL = '🌐 زبان / Language';

interface MenuCore {
  label: (t: Texts) => string;
  callback: KnownCallback;
  style?: TelegramKeyboardButtonStyle;
}

/**
 * Main-menu styling groups (visual-only; order, labels and callbacks frozen):
 * 🟢 `success` (green) = Buy + My Services + Wallet · 🔵 `primary` (blue) =
 * Orders + Account + Invite + Support · 🔴 `danger` (red) = Ticket + Guide +
 * Language. The row builder renders each colour group together, so a button
 * can only change rows by changing groups — never by reordering this list.
 */
const MAIN_MENU_CORE: readonly MenuCore[] = [
  { label: (t) => t.menuBuy, callback: CB.MENU_BUY, style: 'success' },
  { label: (t) => t.menuServices, callback: CB.MENU_SERVICES, style: 'success' },
  { label: (t) => t.menuOrders, callback: CB.MENU_ORDERS, style: 'primary' },
  { label: (t) => t.menuAccount, callback: CB.MENU_ACCOUNT, style: 'primary' },
  { label: (t) => t.menuWallet, callback: CB.MENU_WALLET, style: 'success' },
  { label: (t) => t.menuInvite, callback: CB.MENU_INVITE, style: 'primary' },
  /** Direct contact with support — never opens a ticket. */
  { label: (t) => t.menuSupport, callback: CB.MENU_SUPPORT, style: 'primary' },
  /** The formal ticket flow; listed after support. */
  { label: (t) => t.menuTicket, callback: CB.MENU_TICKET, style: 'danger' },
  /** Phase 11: the connection guide — next to language. */
  { label: (t) => t.menuGuide, callback: CB.MENU_GUIDE, style: 'danger' },
  { label: () => LANG_LABEL, callback: CB.MENU_LANGUAGE, style: 'danger' },
];

export interface MainMenuEntry {
  label: string;
  callback: KnownCallback;
  style?: TelegramKeyboardButtonStyle;
}

export function mainMenuEntries(t: Texts): MainMenuEntry[] {
  return MAIN_MENU_CORE.map((core) => ({
    label: core.label(t),
    callback: core.callback,
    ...(core.style !== undefined ? { style: core.style } : {}),
  }));
}

/** The Persian (default) menu view — kept for tooling and Phase 8A pins. */
export const MAIN_MENU_ENTRIES: readonly MainMenuEntry[] = mainMenuEntries(FA_UI.t);

/** All locale bundles whose menu labels can ever land on the wire (fa + en). */
const MENU_TEXTS: readonly Texts[] = [FA_UI.t, EN_UI.t];

/** Composing-mode control texts (fa view; routing tables cover ALL locales). */
export const STEP_BACK_TEXT = FA_UI.t.backToMenu;
export const STEP_AUTO_TEXT = FA_UI.t.btnAutoPick;
export const STEP_SKIP_REJECT_TEXT = FA_UI.t.btnSkipReject;

function replyButton(text: string, style?: TelegramKeyboardButtonStyle): TelegramReplyKeyboardButton {
  return style === undefined ? { text } : { text, style };
}

/**
 * Keyboard lifecycle, per the Bot API docs + on-device behaviour:
 * - NON-persistent (`is_persistent` never sent): a presented panel does NOT
 *   force itself back over the regular keyboard (that is exactly what
 *   is_persistent would do) and it stays summonable with the input-field
 *   keyboard icon.
 * - Android Back does NOT dismiss a presented non-persistent keyboard
 *   (verified on device); the bot-side levers are the two below.
 * - The main menu is therefore ONE-TIME (`one_time_keyboard: true`): clients
 *   hide it immediately after any button press, so the chat returns to the
 *   full-screen letter keyboard after every single menu interaction, and the
 *   icon (or any explicit menu send) brings it back.
 * - A reply keyboard is re-presented whenever a bot SENDS one, so catch-all
 *   hint replies carry NO reply markup at all: only explicit menu/flow
 *   transitions are allowed to re-present the panel.
 */
function replyKeyboard(
  rows: TelegramReplyKeyboardButton[][],
  opts?: { oneTime?: boolean },
): TelegramReplyKeyboardMarkup {
  return {
    keyboard: rows,
    resize_keyboard: true,
    ...(opts?.oneTime === true ? { one_time_keyboard: true } : {}),
  };
}

/**
 * The bottom main menu.
 *
 * Rows follow the colour groups in MAIN_MENU_CORE source order: row 1 is the
 * green group (`success` 🛒 Buy + 📦 My Services + 💰 Wallet), rows 2-3 are
 * the blue group (`primary` 💳 Orders + 👤 Account + 🤝 Invite + 🆘 Support,
 * two per row), and row 4 is the red group (`danger` 🎫 Ticket + 📚 Guide +
 * 🌐 Language) — 10 buttons therefore render [3,2,2,3], and the guide keeps
 * sitting directly before the language selector (which stays last).
 * Labels, callbacks and order are untouched; only the style grouping differs
 * from the flat MAIN_MENU_CORE order.
 *
 * One-time on purpose (see `replyKeyboard`): every tap collapses the panel back
 * to the full chat screen; the input-field keyboard icon re-summons it.
 */
export function mainMenuKeyboard(ui: Ui): TelegramReplyKeyboardMarkup {
  const entries = mainMenuEntries(ui.t);
  const of = (style: TelegramKeyboardButtonStyle) =>
    entries
      .filter((entry) => entry.style === style)
      .map((entry) => replyButton(entry.label, entry.style));
  const green = of('success');
  const blue = of('primary');
  const red = of('danger');
  const rows: TelegramReplyKeyboardButton[][] = [green];
  for (let i = 0; i < blue.length; i += 2) {
    rows.push(blue.slice(i, i + 2));
  }
  rows.push(red);
  return replyKeyboard(rows, { oneTime: true });
}

/** Exact-match routing of a reply-button press to the callback vocabulary —
 *  resolves against EVERY locale's labels so stale localized keyboards from
 *  before a language switch keep working as before. */
export function menuCallbackForText(text: string): KnownCallback | null {
  for (const t of MENU_TEXTS) {
    const entry = mainMenuEntries(t).find((candidate) => candidate.label === text);
    if (entry) return entry.callback;
  }
  return null;
}

export type StepTextKind = 'back' | 'auto' | 'skip';

/** Which composing-mode control (if any) this incoming text is — across
 *  every locale, for the same stale-keyboard safety as the menu table. */
export function matchStepText(text: string): StepTextKind | null {
  for (const t of MENU_TEXTS) {
    if (text === t.backToMenu) return 'back';
    if (text === t.btnAutoPick) return 'auto';
    if (text === t.btnSkipReject) return 'skip';
  }
  return null;
}

/**
 * Composing mode: replaces the main keyboard while the bot awaits free text.
 * Rows `[⬆ extras…]` (optional) then the always-present back row; pressing any
 * of these lands in the exact-match interceptions of `handleText`.
 */
export function composingKeyboard(ui: Ui, extras: string[] = []): TelegramReplyKeyboardMarkup {
  const rows: TelegramReplyKeyboardButton[][] = [
    ...extras.map((text) => [replyButton(text)]),
    [replyButton(ui.t.backToMenu)],
  ];
  return replyKeyboard(rows);
}

/** Inline single back button — kept for mid-flow messages (not the main menu). */
export function backToMenuKeyboard(ui: Ui): TelegramInlineKeyboardMarkup {
  return { inline_keyboard: [[button(ui.t.backToMenu, CB.ACT_BACK_MENU)]] };
}

/**
 * Phase 15: the free-test offer — the one-time claim CTA plus the standard
 * back-to-menu row. INLINE only, by contract: the main Reply Keyboard keeps
 * its pinned ten buttons in rows [3,2,2,3] (MAIN_MENU_CORE + phase8a.test.ts)
 * and Telegram allows exactly ONE markup per message — a "persistent menu"
 * and this CTA can never share a bubble, so the offer is its own bubble.
 */
export function freeTestKeyboard(ui: Ui): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button(ui.t.freeTestBtnClaim, CB.TEST_CLAIM)],
      [button(ui.t.backToMenu, CB.ACT_BACK_MENU)],
    ],
  };
}

/** Phase 10: the language picker — labels in their OWN script, always. */
export function languagePickerKeyboard(ui: Ui): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button(ui.t.langOptionFa, CB.LANG_FA)],
      [button(ui.t.langOptionEn, CB.LANG_EN)],
      [button(ui.t.backToMenu, CB.ACT_BACK_MENU)],
    ],
  };
}

/**
 * Phase 3: catalog-driven option keyboards. Rows follow the configured preset
 * order (two per row), then a custom-input hint row and the back/cancel row.
 * Values are plain integers — validation happens server-side against the
 * freshly loaded catalog, never against what the button promised.
 */
function optionKeyboard(
  ui: Ui,
  namespace: OptionNamespace,
  presets: number[],
  allowCustom: boolean,
  labelOf: (value: number) => string,
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [];
  for (let i = 0; i < presets.length; i += 2) {
    const row: TelegramInlineKeyboardButton[] = [];
    for (const value of presets.slice(i, i + 2)) {
      row.push(button(labelOf(value), `${namespace}:${value}`));
    }
    rows.push(row);
  }
  if (allowCustom) {
    rows.push([button(ui.t.customVolumeLabel, `${namespace}:custom`)]);
  }
  rows.push([button(ui.t.stepBack, CB.STEP_BACK), button(ui.t.btnCancelInline, CB.ACT_CANCEL)]);
  return { inline_keyboard: rows };
}

export function volumeKeyboard(
  ui: Ui,
  presets: number[],
  allowCustom: boolean,
): TelegramInlineKeyboardMarkup {
  return optionKeyboard(ui, 'vol', presets, allowCustom, (v) => ui.f.volumeOption(v));
}

export function durationKeyboard(
  ui: Ui,
  presets: number[],
  allowCustom: boolean,
): TelegramInlineKeyboardMarkup {
  return optionKeyboard(ui, 'dur', presets, allowCustom, (v) => ui.f.duration(v));
}

export function deviceKeyboard(
  ui: Ui,
  presets: number[],
  allowCustom: boolean,
): TelegramInlineKeyboardMarkup {
  return optionKeyboard(ui, 'dev', presets, allowCustom, (v) => ui.f.deviceOption(v));
}

export function confirmKeyboard(ui: Ui): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button(ui.t.confirmYes, CB.ORDER_CONFIRM)],
      [button(ui.t.stepBack, CB.STEP_BACK), button(ui.t.btnCancelInline, CB.ACT_CANCEL)],
    ],
  };
}

/* ———— Phase 7: wallet, support tickets, announcements ————
 * `tsk:` and `ann:` carry full ULIDs, so — exactly like `adm:` and `svc:` —
 * they live in a STRICT pattern in validate.ts and are produced ONLY by the
 * builders below and parsed ONLY by parseTicketCallback/parseAnnounceCallback.
 * The ticket/admin ones are Persian-only operational surface.
 */
export function ticketCallback(action: 'rp' | 'cl' | 'vw', ticketId: string): string {
  return `tsk:${action}:${ticketId}`;
}

/** Queue row for one live ticket: [reply][view][close] + the subject. */
export function adminTicketKeyboard(ticketId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('💬 پاسخ', ticketCallback('rp', ticketId)), button('👁 جزئیات', ticketCallback('vw', ticketId))],
      [button('✅ بستن تیکت', ticketCallback('cl', ticketId))],
    ],
  };
}

/** One pushed ticket message: quick reply + queue. */
export function adminTicketPushKeyboard(ticketId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('💬 پاسخ', ticketCallback('rp', ticketId))],
      [button('🗂 صف پشتیبانی', CB.MENU_TICKETS)],
    ],
  };
}

/** Customer-facing ticket notice: back to menu. */
export function ticketAcknowledgedKeyboard(ui: Ui): TelegramInlineKeyboardMarkup {
  return { inline_keyboard: [[button(ui.t.backToMenu, CB.ACT_BACK_MENU)]] };
}

/** Announcement confirm/receive keyboard (admin-only surface). */
export function announceConfirmKeyboard(announcementId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('📢 ارسال', `ann:go:${announcementId}`)],
      [button('❌ انصراف', CB.ACT_CANCEL)],
    ],
  };
}

/** Announcement job control: [continue] + the /announcements-style list. */
export function announceProgressKeyboard(announcementId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('ادامه ارسال ➡️', `ann:ct:${announcementId}`)],
      [button('🗂 اطلاعیه‌ها', CB.MENU_ANNOUNCE_LIST)],
    ],
  };
}

/** Summary buttons when the wallet is usable: pay-all-from-wallet / deduct. */
export function walletPayKeyboard(ui: Ui, partialAvailable: boolean): TelegramInlineKeyboardMarkup {
  const t = ui.t;
  const rows: TelegramInlineKeyboardButton[][] = [
    [button(t.payWalletFull, CB.PAY_WALLET_FULL)],
  ];
  if (partialAvailable) {
    rows.push([button(t.payWalletPart, CB.PAY_WALLET_PART)]);
  }
  rows.push(
    [button(t.confirmYes, CB.ORDER_CONFIRM)],
    [button(t.stepBack, CB.STEP_BACK), button(t.btnCancelInline, CB.ACT_CANCEL)],
  );
  return { inline_keyboard: rows };
}

/* ———— Phase 17: customer wallet top-up ————
 * Top-up lives OUTSIDE orders: the wallet view gains one entry button, and
 * admin review rides its own `tup:` namespace (strict parser in validate.ts),
 * so a forged tap can only ever address the top-up it was minted for.
 */
export function topupCallback(action: 'ok' | 'no', topupId: string): string {
  return `tup:${action}:${topupId}`;
}

/** Wallet view: top-up entry (hidden under sales stop / kill-switch) + back. */
export function walletViewKeyboard(ui: Ui, showTopup: boolean): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [];
  if (showTopup) {
    rows.push([button(ui.t.topupButton, CB.TOPUP_START)]);
  }
  rows.push([button(ui.t.backToMenu, CB.ACT_BACK_MENU)]);
  return { inline_keyboard: rows };
}

/** Admin review keyboard for one top-up request (Persian operational surface). */
export function topupReviewKeyboard(topupId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('✅ تأیید شارژ', topupCallback('ok', topupId)), button('❌ رد', topupCallback('no', topupId))],
    ],
  };
}

/** Admin queue rows for pending top-ups: one approve/reject pair per request. */
export function topupQueueKeyboard(topupIds: string[]): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: topupIds.map((id) => [
      button('✅', topupCallback('ok', id)),
      button('❌', topupCallback('no', id)),
    ]),
  };
}

/** Phase 8A: the config-name step is free text → composing mode with auto-pick. */
export function configNameKeyboard(ui: Ui): TelegramReplyKeyboardMarkup {
  return composingKeyboard(ui, [ui.t.btnAutoPick]);
}

/* ———— Phase 12: admin pricing management ————
 * Persian-only operational surface (same rule as the `adm:`/`tsk:` keyboards:
 * literal `fa` labels, deliberately NOT localized via `ui`, so a mis-routed
 * or forged tap can never re-style the admin controls). Tokens are validated
 * by parsePricingCallback — the keyboards here only ever emit `prc:` values.
 */
export function pricingEditCallback(token: string): string {
  return `prc:e_${token}`;
}

/** Field grid (two buttons per row) + refresh + cancel. */
export function pricingMenuKeyboard(
  fields: Array<{ label: string; token: string }>,
): TelegramInlineKeyboardMarkup {
  const rows: TelegramInlineKeyboardButton[][] = [];
  for (let i = 0; i < fields.length; i += 2) {
    rows.push(
      fields.slice(i, i + 2).map((field) =>
        button(field.label, pricingEditCallback(field.token)),
      ),
    );
  }
  rows.push([button('🔄 نمایش دوباره', 'prc:menu')]);
  rows.push([button('❌ انصراف', CB.ACT_CANCEL)]);
  return { inline_keyboard: rows };
}

/** The staged-value confirmation (value itself NEVER rides on the wire). */
export function pricingConfirmKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [button('✅ ثبت قیمت', 'prc:ok'), button('❌ انصراف', 'prc:no')],
    ],
  };
}

/* ———— Phase 13: sales stop switch ————
 * Persian-only operational surface (same rule as the `adm:`/`tsk:`/`prc:`
 * keyboards). Toggle semantics: stop = close NEW commercial service creation
 * (buy + renewal); start = reopen it. `sal:view` simply re-renders the state.
 */
export function salesKeyboard(stopped: boolean): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      stopped
        ? [button('🟢 فعال‌سازی سرویس', 'sal:start')]
        : [button('🛑 توقف سرویس', 'sal:stop')],
      [button('🔄 نمایش دوباره', 'sal:view')],
    ],
  };
}
