/**
 * Phase 10: the English experience — written, not translated.
 *
 * Authorship rules (fixed with the operator):
 *  - Voice: a competent, friendly service desk. Clear and brief; contractions
 *    welcome; no forced slang, no "Hello dear", no exclamation stacking.
 *  - The Persian persona rules are honored in SPIRIT, not letter: a warm
 *    greeting opens the welcome and important standalone notices only — never
 *    mid-flow prompts, validation errors or consecutive bubbles; the payment
 *    reminders stay greeting-free in three distinct variants, like fa's.
 *  - Copy is written per key from the step's PURPOSE (both bundles share the
 *    `Texts` shape, never wording). Sentence case everywhere; plain-text
 *    messages contain no markup; HTML bubbles keep only <code> segments.
 *  - British/international spelling avoided in favor of neutral tech English
 *    ("sign in", "tap", "card"). Currency stays "Toman" (never translated).
 */
import type { Texts } from './texts.ts';
import { GENEROUS_VOLUME_GB } from './texts.ts';
import { tgCode, tgEscapeHtml } from './format.ts';

const durationEn = (days: number, daysPerMonth = 30): string => {
  const months = daysPerMonth > 0 ? days / daysPerMonth : NaN;
  if (Number.isSafeInteger(months) && months >= 1) {
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  return `${days} day${days === 1 ? '' : 's'}`;
};

const deviceLineEn = (count: number): string =>
  count === 2
    ? 'Nice — two devices it is, so a housemate can join you'
    : count === 3
      ? 'Three devices — the whole household is covered'
      : `${count} devices, one happy crew`;

const en: Texts = {
  notConfigured:
    '⚠️ This bot is not fully configured yet.',

  welcomeGreeting: (firstName: string | null) =>
    firstName ? `👋 Hi ${firstName}, welcome! ❤️` : '👋 Hi there, and welcome! ❤️',
  welcomeIntro: 'To get started, pick an option from the menu below.',
  menuPrompt: '👇 Main menu',

  cmdUnknown: '❓ I don\'t know that command.\nUse the menu buttons below, or type /help.',
  helpText: [
    '🤖 Help',
    '',
    '/start — show the main menu',
    '/cancel — return to the menu and cancel the current operation',
    '/help — this message',
    '/pending — (admins) receipts awaiting review',
    '/failed — (admins) orders with failed setup/renewal',
    '/tickets — (admins) open support tickets',
    '/announce — (admins) send an announcement to all users',
    '/announcements — (admins) recent announcement status',
    '/pricing — (admins) view and edit prices',
    '/sales — (admins) stop/resume service sales',
    '',
    '📦 Under "My Services" you can check each service\'s status and expiry, and renew it.',
    'Ready? Use the buttons below.',
  ].join('\n'),

  // Buy flow
  buyIntro: [
    '🛒 Buy a service',
    '',
    'First, choose a name for your config.',
    'It must be English, at least three words (Latin letters, single spaces), up to 64 characters.',
    'Change your mind? Press "Back to menu" or /cancel at any time.',
  ].join('\n'),
  buyWaitingConfigName:
    'Pick an English name with at least three words — or let me choose one for you.',
  configNameInvalid:
    '🙈 That name doesn\'t work — it has to be English with at least three words (like "Silver Falcon Network").\nTry again, or press "Auto-pick".',
  configNameSaved: (name: string) =>
    `✅ Config name set: "${name}".`,
  buyInProgress: '🛒 Your purchase is still in progress — keep going, or press "Back to menu" to cancel.',

  // Account / status screens
  accountHeader: '👤 Your account',
  accountUsername: (v: string) => `Username: ${v}`,
  accountNone: '—',
  accountLanguage: (v: string) => `Telegram language: ${v}`,
  accountSince: (v: string) => `Member since: ${v}`,
  accountStatusIdle: 'Status: ready ✅',
  accountStatusBusy: 'Status: in the middle of an operation (cancel anytime with /cancel)',

  cancelled: '↩️ You\'re back at the main menu.',
  sessionExpired: '⏱️ Your previous session had expired — starting fresh from the menu.',

  invalidChoice: '❌ That option isn\'t valid.',
  backToMenu: '🔙 Back to menu',
  // The OFF-TOPIC global fallback — used ONLY for input that falls outside
  // every flow (never inside a live step, payment, support or admin handling).
  idleInputHint:
    '😅 I\'m a bot, not a chat buddy — I can only take orders through the menu below.',
  // A mere back-tap while nothing is pending: a soft nudge, not the fallback.
  idleMenuNudge: '😊 Nothing is open right now — pick whatever you need from the menu below.',

  // ————— Phase 3: purchase options, summary, confirmation —————
  catalogUnavailable:
    '🔧 The options aren\'t available at the moment. Please try again shortly.',
  volumePrompt: (min: number, max: number) =>
    `📦 Choose a data volume.\n\nBetween ${min} and ${max} GB.\nWant a different amount? Type it (or press "Custom").`,
  durationPrompt: (min: number, max: number, allowCustom = true) =>
    `⏳ Choose a duration.\n\n${durationEn(min)} to ${durationEn(max)}.` +
    (allowCustom ? '\nWant something else? Type the number of days.' : ''),
  devicePrompt: (min: number, max: number, allowCustom = true) =>
    `📱 How many devices can connect at once?\n\nBetween ${min} and ${max}.` +
    (allowCustom ? '\nType a number for a custom amount.' : ''),
  customVolumeLabel: '✍️ Custom',
  customHint: '✍️ Now type your number here and send it.',
  rejectedRange: (min: number, max: number) =>
    `⚠️ The number must be between ${min} and ${max}. Try again, or press "Back".`,
  // Flow-specific rejections — each step answers in its own domain.
  rejectedVolumeRange: (got: number, min: number, max: number) =>
    `📦 ${got} GB doesn't fit here — volume runs from ${min} to ${max} GB.\nPick another number, or press "Back".`,
  rejectedDurationRange: (min: number, max: number) =>
    `⏳ Duration must be between ${min} and ${max} days.\nTry another number, or press "Back".`,
  rejectedDeviceRange: (min: number, max: number) =>
    `📱 The device limit must be between ${min} and ${max}.\nTry another number, or press "Back".`,
  rejectedPresetDisabled: '⚠️ That option is currently disabled — please pick another.',
  rejectedNotWhole: '✍️ That wasn\'t a number — send a whole number only, or press "Back".',
  staleChoice: '🔄 That button belongs to a different step. Please continue with the current one.',
  stepBack: '↩️ Previous step',
  confirmYes: '✅ Confirm & place order',

  summaryHeader: '🧾 Order summary',
  summaryName: (v: string) => `🏷 Name: ${v}`,
  summaryVolume: (gb: number) => `📦 Volume: ${gb} GB`,
  summaryDuration: (days: number, months: number) =>
    `⏳ Duration: ${days} days (${months} month${months === 1 ? '' : 's'})`,
  summaryDevices: (n: number) => `📱 Devices: ${n}`,
  summaryPrice: (v: string) => `💰 Total: ${v}`,
  summaryId: (id: string) => `🆔 Order ID: ${id}`,
  summaryHint: 'Everything look right? Press "Confirm" — press "Back" to edit.',

  orderCreated: (id: string) =>
    `✅ Order placed!\n\n🆔 ID: ${id}\n\n👇 Payment details are coming up next.`,
  orderConfirmToast: '✅ Order placed.',
  alreadyConfirmed: '✅ This order has already been placed.',

  paymentWaitNotice:
    '⏳ Your payment receipt is under review.\n\n💡 Sent the wrong one? Just send a new image/file and it will be replaced.\nTrack progress under "💳 My Orders".',

  missingDraftData: '⚠️ The order draft is incomplete — please start over.',

  // ————— Phase 4: payment, receipts, admin review —————
  paymentInstructionsHeader: '💳 Payment details',
  paymentHolder: (v: string) => `👤 Card holder: ${tgEscapeHtml(v)}`,
  // Only rendered in the HTML payment bubble — the value becomes tap-to-copy.
  paymentCard: (v: string) => `🏦 Card number: ${tgCode(v)}`,
  paymentIban: (v: string) => `IBAN: ${tgCode(v)}`,
  paymentAmountLine: (v: string) => `💰 Amount due: ${v}`,
  paymentReceiptPrompt:
    '🧾 After transferring, send a photo or file of the receipt right here in this chat.\n\nPlease note: receipts are verified manually, so it may take a little while.',
  paymentInfoUnavailable:
    '⚠️ Payment details aren\'t available right now. Please contact support to continue.',
  // Shown at most once per message, only when a <code> value is in it.
  copyHint: '(tap the value to copy it)',

  receiptAccepted:
    '✅ Receipt received and sent for review.\n\nReview is manual — once it\'s approved, everything else runs automatically. Nothing more is needed from you.\n\nResults usually come within a few hours; check "💳 My Orders" for status.',
  receiptReplaced:
    '✅ New receipt received — the old one has been replaced and sent for review.\n\nThe position in the review queue stays the same; you don\'t need to resubmit anything else.',
  receiptExpectedMedia: '🧾 Please send the receipt as an image or file (a photo of the slip counts) — a plain text message doesn\'t count as a receipt.',
  receiptOrderMissing: '⚠️ No order found for this chat — start again from the Buy menu.',
  receiptOrderNotPayable: '⚠️ This order is no longer waiting for a receipt. Check its status under "💳 My Orders".',

  // ————— Phase 8C: payment review reminders (15/30/45 min, max 3) —————
  // Three DISTINCT concise variants (never repeats), ⏳-anchored, no greeting
  // (the customer's own receipt is the previous bubble), no invented promises.
  reminderCustomer1: (id: string) =>
    `⏳ The receipt for order ${id} is still being reviewed.\n\nWe\'ll let you know as soon as it\'s decided — nothing else to do for now.`,
  reminderCustomer2: (id: string) =>
    `⏳ Order ${id} is still waiting on receipt review.\n\nIf you sent the wrong file, upload a new one — it replaces the old receipt.`,
  reminderCustomer3: (id: string) =>
    `⏳ Review for order ${id} is taking a bit longer than usual.\n\nThanks for your patience — we\'ll message you the moment there\'s news.`,
  reminderAdminHeader: '⏰ Reminder: these receipts are still awaiting review',
  reminderAdminEntry: (n: number, shortId: string, minutes: number) =>
    `${n}. 🆔 ${shortId} — waiting ${minutes} min`,

  statusPendingPayment: '⏳ Awaiting payment',
  statusAwaitingReview: '🔎 Receipt under review',
  statusApproved: '✅ Approved — awaiting setup',
  statusProvisioning: '⚙️ Setting up your service',
  statusCompleted: '🟢 Service is live',
  statusRejected: '❌ Rejected',
  statusFailed: '⚠️ Failed',
  statusCancelled: '🚫 Cancelled',

  ordersHeader: '🧾 Your recent orders',
  ordersEmpty: 'You haven\'t placed any orders yet.\nStart from "🛒 Buy a service" in the menu.',
  ordersEntry: (n: number, shortId: string, status: string, price: string, date: string) =>
    `${n}. 🆔 ${shortId} — ${status}\n   ${price} — ${date}`,

  // An important standalone notice gets the warm opener (fa's rule, in spirit).
  notifyApproved: (id: string, amount: string) =>
    `Hi there, your payment is confirmed! 🎉\n\n🆔 Order: ${id}\n💰 Amount: ${amount}\n\nYour service is being set up now — connection details will follow in a moment.`,
  notifyRejected: (id: string, reason: string) =>
    `❌ Unfortunately, the payment receipt for this order wasn\'t approved.\n\n🆔 Order: ${id}\n📝 Reason: ${reason}\n\nYou can place a new order, or chat with support about it.`,

  // ————— Admin surfaces (kept for type parity; the bot serves admins in Persian) —————
  adminReceiptHeader: '🧾 New receipt to review',
  adminReceiptLine: (n: number, id: string, status: string, amount: string, uploader: string) =>
    `${n}. 🆔 ${id}\n   ${status} — ${amount}\n   paid by: ${uploader}`,
  adminProcessedApprove: (id: string, adminId: string) =>
    `✅ Approved\n🆔 ${id}\nreviewed by: ${adminId}`,
  adminProcessedReject: (id: string, adminId: string) =>
    `❌ Rejected\n🆔 ${id}\nreviewed by: ${adminId}`,
  adminProcessedStale: (id: string) => `ℹ️ Order ${id} has already been reviewed.`,
  adminQueueHeader: '🗂 Receipts awaiting review',
  adminQueueEmpty: '🎉 No receipts are waiting for review.',
  adminRejectPromptMsg:
    '⌨️ Type the rejection reason and send it.\n\nThe customer will see this reason — or press "Reject without reason".',
  adminRejectDefaultReason: 'Payment could not be verified.',
  adminApprovedToast: '✅ Order approved.',
  adminRejectedToast: '❌ Order rejected.',
  adminStaleToast: 'This order has already been reviewed.',
  adminRejectCancelled: '↩️ Rejection cancelled.',
  cmdAdminOnly: '❌ This command isn\'t available to you.',

  paymentVerifiedByLabel: (v: string) => `Reviewed by: ${v}`,
  paymentReferenceLine: (v: string) => `🧾 Payment reference: ${v}`,

  // ————— Phase 5: automatic provisioning (PasarGuard) —————
  serviceReady: (id: string, url: string) =>
    `🎉 Your service is set up and live!\n\n🆔 Order: ${id}\n🔗 Subscription link:\n${tgCode(url)}\n${en.copyHint}\n\nOpen this link in your app (v2rayNG / Nekobox / Streisand, etc.).\n\n🌐 That same link is your dedicated service page — come back here anytime to see the link and your service details.`,
  serviceReadyWithoutLink: (id: string) =>
    `🎉 Your service has been created.\n\n🆔 Order: ${id}\n\nThe connection link isn\'t available yet — it will show up under "My Services" shortly. In a hurry? Support can help.`,
  provisionFailedNotice: (id: string) =>
    `⚠️ Setting up this order ran into repeated problems.\n\n🆔 Order: ${id}\n\nThe team has been alerted and is on it — you do NOT need to pay again.`,
  provisionNameRejectedNotice: (id: string) =>
    `⚠️ The panel didn\'t accept this order's service name.\n\n🆔 Order: ${id}\n\nYour payment is completely safe and nothing extra will be charged. Our team will retry with a fresh name shortly; if you\'re in a hurry, start a new order using "Auto-pick" or a different three-word English name.`,
  adminProvisionFailed: (id: string, reason: string) =>
    `⚠️ Service creation failed\n🆔 ${id}\n📝 ${reason.slice(0, 200)}\n\nYou can retry with the button below (within the allowed cap).`,
  failedQueueHeader: '🧯 Setup/renewal failures',
  failedQueueEmpty: '🎉 No failed orders right now.',
  failedQueueEntry: (n: number, id: string, reason: string, attempts: number) =>
    `${n}. 🆔 ${id}\n   ⚠️ ${reason.slice(0, 160)}\n   attempts: ${attempts}`,
  adminRetryOkToast: '✅ Service created.',
  adminRetryFailToast: '❌ The retry failed too; details were sent to admins.',
  adminRetryStaleToast: 'This order is currently being processed or transitioned.',
  adminRetryExhaustedToast: '🚫 The retry cap for this order has been reached.',
  adminPanelUnavailableToast: '⚠️ Panel configuration is incomplete; try again later.',
  adminProvisionDisabledToast: '⚠️ Automatic service creation is currently off.',
  adminProvisionDone: (id: string) => `🔁 Retry outcome recorded\n🆔 ${id}`,
  adminProvisionStale: (id: string) => `ℹ️ Order ${id} has changed state; this button is no longer needed.`,

  // ————— Phase 6: My Services + status + renewals —————
  servicesHeader: '📦 Your services',
  servicesEmpty: 'You don\'t have an active service yet.\nStart from "🛒 Buy a service" in the menu.',
  serviceStatusActive: '🟢 Active',
  serviceStatusExpiring: '⏳ Expiring soon',
  serviceStatusExpired: '‼️ Expired',
  serviceStatusUnknown: '⚪ Unknown',
  servicesEntry: (n: number, name: string, shortId: string, status: string, expires: string) =>
    `${n}. 📦 ${name} — ${status}\n   🆔 ${shortId} — expires: ${expires}`,
  serviceNotFound: '🚫 You don\'t have a service with that ID, or it isn\'t available.',
  serviceBusyFirst: '🛑 Please finish the current operation first, or send /cancel.',

  svcDetailHeader: (name: string) => `📦 Service "${name}"`,
  svcPanelActive: '🟢 Active',
  svcPanelLimited: '🟡 Limited (data cap)',
  svcPanelExpired: '‼️ Expired',
  svcPanelDisabled: '⛔ Disabled',
  svcPanelOnHold: '⏸ On hold',
  svcPendingRenewal: (shortId: string) => `🔁 Renewal in progress: order ${shortId}…`,
  svcToastPanel: '✅ Live status from the panel',
  svcToastSnapshot: '🖥 Panel unavailable; showing local status',
  svcId: (id: string) => `🆔 Service ID: ${id}`,
  svcPanelUsername: (v: string) => `👤 Panel username: ${v}`,
  svcCreated: (v: string) => `📅 Created: ${v}`,
  svcExpires: (v: string) => `⏳ Expires: ${v}`,
  svcDaysLeft: (days: number) => `🔂 Time left: ${days} day${days === 1 ? '' : 's'}`,
  svcExpiredDaysAgo: (days: number) => `⚠️ Expired ${days} day${days === 1 ? '' : 's'} ago`,
  svcUsage: (used: string, total: string) => `📊 Traffic: ${used} of ${total} GB used`,
  svcLink: '🔗 Subscription link:',
  svcLinkCode: (url: string) => `${en.svcLink}\n${tgCode(url)}\n${en.copyHint}`,
  svcSnapshotNote: '🖥 The panel wasn\'t reachable — showing the last locally recorded status.',
  svcLiveNote: '🖥 Live status from the panel',

  renewDisabledNotice: '🔧 Renewals are currently disabled.',
  renewInProgressNotice: (id: string) =>
    `🔁 There\'s already an open renewal for this service.\n\n🆔 Renewal order: ${id}\n\nTrack its status under "💳 My Orders".`,
  renewIntro: (name: string, expires: string) =>
    `🔁 Renew "${name}"\n\n📅 Current expiry: ${expires}\n\nPick a duration to renew.\nThe price is the exact number set for that duration; payment works like a purchase: send a receipt, manual confirmation.`,
  renewDurationPrompt: '⏳ Choose the renewal length:\n\n1 month • 2 months • 3 months',
  renewSummaryHeader: '🧾 Renewal summary',
  renewSummaryService: (name: string) => `📦 Service: "${name}"`,
  renewSummaryAdd: (months: number) => `➕ Adding: ${months} month${months === 1 ? '' : 's'}`,
  renewSummaryFrom: (v: string) => `📅 Current expiry: ${v}`,
  renewSummaryUntil: (v: string) => `📅 New expiry (approx.): ${v}`,
  renewConfirmed: (id: string) =>
    `✅ Renewal requested!\n\n🆔 ID: ${id}\n\n👇 Payment details are coming up next.`,
  renewApplied: (id: string, expiresDate: string) =>
    `🎉 Your service has been renewed!\n\n🆔 Order: ${id}\n📅 New expiry: ${expiresDate}\n\nYou can check the status under "📦 My Services".`,
  renewFailedNotice: (id: string) =>
    `⚠️ Renewing this order ran into repeated problems.\n\n🆔 Order: ${id}\n\nThe team has been alerted and is on it — you do NOT need to pay again.`,
  adminRenewalFailed: (id: string, reason: string) =>
    `⚠️ Service renewal failed\n🆔 ${id}\n📝 ${reason.slice(0, 200)}\n\nYou can retry with the button below (within the allowed cap).`,
  adminRenewalKind: (serviceId: string) => `🔄 Renewal for service ${serviceId}`,
  notifyApprovedRenewal: (id: string, amount: string) =>
    `🎉 Your renewal payment is confirmed!\n\n🆔 Order: ${id}\n💰 Amount: ${amount}\n\nThe extension will be applied to your service shortly.`,
  ordersKindRenewal: '(renewal)',

  // ————— Phase 7: wallet + referrals + support + announcements (IRT/Toman) —————
  walletUnavailable: '🔧 The wallet isn\'t available at the moment. Please try again shortly.',
  walletHeader: '💰 Your wallet',
  walletBalance: (v: string) => `Balance: ${v}`,
  walletEmpty: 'No wallet transactions yet.',
  walletEntry: (n: number, sign: string, kind: string, amount: string, date: string) =>
    `${n}. ${sign} ${amount} — ${kind}\n   ${date}`,
  walletKindReferralReward: '🎁 Referral bonus',
  walletKindAdminGrant: '➕ Gifted credit',
  walletKindAdminDebit: '➖ Deduction',
  walletKindOrderPayment: '🛒 Order payment',
  walletKindOrderRefund: '↩️ Credit returned',
  walletDebited: (v: string) => `✅ ${v} was deducted from the balance.`,
  walletGranted: (v: string) => `✅ ${v} was added to the wallet.`,
  walletAmountInvalid:
    '⚠️ Send a clean amount with no extra symbols — or press "Back".',
  walletAmountTooBig: (max: string) => `⚠️ The maximum per operation is: ${max}`,
  walletPromptAmount: (verb: string) =>
    `⌨️ Type the amount (${verb}, in Toman) as a whole number; press "Back to menu" to abort.`,
  walletBalanceLow: '⚠️ Your wallet balance isn\'t enough for this.',
  walletTargetUser: (v: string) => `👤 Target user: ${v}`,

  payWalletFull: '💰 Pay in full from wallet',
  payWalletPart: '🔅 Use balance, pay the rest',
  summaryWalletLine: (v: string) => `👛 Wallet balance: ${v}`,
  walletPayConfirmToast: '✅ Paid from wallet.',
  walletPaidOrderCreated: (id: string, used: string) =>
    `🎉 Payment cleared instantly — your order is in!\n\n🆔 ID: ${id}\n👛 Paid from wallet: ${used}\n\nYour service is being set up now — connection details coming right up.`,
  walletPartialCreated: (id: string, used: string, rest: string) =>
    `✅ Placed — ${used} was applied from your wallet.\n\n🆔 ID: ${id}\n💳 Remaining due: ${rest}\n\n👇 Payment details for the remainder are coming up next.`,
  walletPaidRenewal: (id: string, used: string) =>
    `🎉 Renewal paid instantly from your wallet!\n\n🆔 Order: ${id}\n👛 Paid from wallet: ${used}\n\nThe extension will be applied shortly.`,
  walletPartialRenewal: (id: string, used: string, rest: string) =>
    `✅ Renewal started — ${used} was applied from your wallet.\n\n🆔 Order: ${id}\n💳 Remaining due: ${rest}\n\n👇 Payment details for the remainder are coming up next.`,
  notifyWalletRefunded: (id: string, amount: string) =>
    `ℹ️ ${amount} from the rejected order has been returned to your wallet.\n\n🆔 Order: ${id}`,
  adminRefundedLine: (amount: string) => `↩️ Refunded to customer wallet: ${amount}`,

  inviteHeader: '🤝 Invite friends',
  inviteLinkNone: (link: string) => `🔗 Your invite link:\n${link}`,
  inviteCount: (n: number) => `Successful invites: ${n}`,
  inviteEarned: (v: string) => `Total earned: ${v}`,
  inviteHowTo: [
    'Share this link with a friend;',
    'when their first order is approved, the referral bonus lands in your wallet.',
  ].join('\n'),
  inviteRewardPercent: (v: string) => `🎁 Bonus per successful invite: ${v}% of their first order`,
  refNoticeJoined: (v: string) => `🌱 Your account was created through ${v}'s invite link.`,
  refPaidToReferrer: (amount: string, referee: string) =>
    `🎁 A referral bonus of ${amount} has landed in your wallet.\nNew user: ${referee}`,
  refPaidFromSide: (referee: string, amount: string) =>
    `🎉 Someone you invited made their first purchase — they received ${amount} as a bonus.`,
  referralUnavailable: '🔗 Invite links aren\'t available at the moment.',

  supportDirect: (url: string, ticketLabel: string) =>
    `🆘 Direct support\n\nOpen this account on Telegram and send your message there:\n${url}\n\nIf you need something tracked in writing, press "${ticketLabel}" instead.`,
  supportDirectNone: (ticketLabel: string) =>
    `🆘 A direct support contact isn't configured on this bot yet.\n\nFor anything that needs following up, press "${ticketLabel}" and we\'ll answer right here.`,
  supportIntro: [
    '🎫 Support ticket',
    '',
    'Describe your issue or question in one message and send it.',
    'A specialist usually replies right here in this chat.',
    'To go back, press "Back to menu" or /cancel.',
  ].join('\n'),
  supportTicketCreated: (id: string) =>
    `📨 Your message is in.\n\n🎫 Ticket ID: ${id}\n\nYou\'ll see the reply right here in this chat.`,
  supportTicketExists: (id: string) =>
    `🎫 Your open ticket (${id.slice(0, 10)}…) is still active.`,
  supportQueueChoice: '✍️ Send the message text and we\'ll pass it to a specialist.',
  supportAnswered: '💬 Support reply:\n\n',
  supportClosedNotice: '✅ Ticket closed. Need anything else? Opening "Support" again works fine.',
  supportTicketClosedAlready: 'ℹ️ This ticket is already closed.',
  adminTicketNew: (customer: string, subject: string) =>
    `🆕 Support ticket\n👤 ${customer}\n📝 ${subject}`,
  adminTicketFollowup: (customer: string, subject: string) =>
    `✍️ New customer message\n👤 ${customer}\n📝 ${subject}`,
  adminTicketQueueHeader: '🗂 Open support tickets',
  adminTicketQueueEmpty: '🎉 No open tickets.',
  adminTicketQueueEntry: (n: number, code: string, customer: string, subject: string, messages: number) =>
    `${n}. 🎫 ${code} — ${customer}\n   ${subject}\n   messages: ${messages}`,
  adminTicketPrompt: '⌨️ Type your reply and send it (max 2000 characters).',
  adminTicketSent: '✅ Reply delivered to the customer.',
  adminTicketStale: 'This ticket is no longer open, or wasn\'t found.',
  supportBusyFirst: '🛑 Please finish the current operation first, or send /cancel.',
  ticketNotFound: '🚫 No ticket found with that ID.',

  // ————— Phase 12: admin pricing management —————
  adminPricingHeader: '💰 Pricing management',
  adminPricingLegend:
    'The base product = 10GB + 1 user + 1 month.\n' +
    'Every longer duration and user count is YOUR independent number — ' +
    'the bot never invents a multiplier.',
  adminPricingFieldBase: (price: string) => `🧱 Base product: ${price}`,
  adminPricingFieldGb: (price: string) => `⚖️ Per extra GB: ${price}`,
  adminPricingFieldMonth: (months: number, price: string) =>
    `📅 ${months}-month: ${price}`,
  adminPricingFieldUsers: (count: number, price: string) =>
    `👤 ${count} users: ${price}`,
  adminPricingUserIncluded: 'in base',
  adminPricingPrompt: (label: string, current: string) =>
    `✏️ ${label}\nCurrent price: ${current}\n\nSend the new amount in Toman, digits only; "back to menu" cancels.`,
  adminPricingStaged: (label: string, value: string) =>
    `🧾 New value for "${label}": ${value}\n\nConfirm with "Save price" or cancel.`,
  adminPricingConfirmToast: '✅ New price saved.',
  adminPricingAppliedLine: (label: string, value: string) =>
    `✅ Saved — ${label}: ${value}`,
  adminPricingAmountInvalid:
    '⚠️ Send the amount properly: digits only (Persian or English), no signs, no decimals.',
  adminPricingAmountRejected:
    '⚠️ That value is not allowed for this field (0 to 1,000,000,000; base price and per-GB must be above zero).',
  adminPricingConflict:
    '⚠️ Another admin changed the pricing just now; your edit did not apply. Re-open the list.',
  adminPricingStale: '🔄 This pricing edit request expired or is no longer valid.',
  adminPricingFieldGone: '⚠️ That field is no longer in the configuration; re-open the list.',
  adminPricingUnavailable: '⚠️ The pricing configuration is invalid; a direct database fix is required.',
  adminPricingCancelled: '↩️ Pricing edit cancelled.',
  adminPricingHint: 'Type a number or tap a field.',

  // ————— Admin-only flow strings (the bot serves admins in Persian) —————
  announceIntro: '📢 Send the announcement text (max 2000 characters).',
  announceTooLong: '⚠️ That text is too long — send something shorter.',
  announceConfirmPrompt: (n: number) =>
    `📩 Send this announcement to about ${n} users?`,
  announceCreated: (id: string) =>
    `📤 Announcement accepted; delivery has started.\n🆔 ${id.slice(0, 10)}…`,
  announceProgress: (code: string, sent: number, total: number) =>
    `📊 Announcement ${code} — delivered: ${sent} of ${total}`,
  announceDone: (code: string, sent: number, failed: number) =>
    `✅ Announcement ${code} complete\ndelivered: ${sent}${failed > 0 ? ` — failed: ${failed}` : ''}`,
  announceQueueHeader: '🗂 Recent announcements',
  announceQueueEmpty: 'No announcements have been sent yet.',
  announceQueueEntry: (id: string, state: string, sent: number, total: number) =>
    `🆔 ${id.slice(0, 10)}… — ${state} — ${sent}/${total}`,
  announceStateSending: '⏳ Sending',
  announceStateDone: '✅ Done',
  announceStale: '🔄 This announcement changed or was already delivered.',
  announceReceived: '📢 Announcement',
  userBlocked: (id: string) => `🎫 Ticket ${id} is no longer active; delivery stopped.`,

  // ————— Phase 13: sales stop switch (customer notice + admin surface) —————
  salesStoppedNotice:
    '🛑 Service sales are on a short pause right now.\n\nHang tight — we\'ll be back soon ❤️\nOnce it\'s back, you can order or renew right from this menu.',
  adminSalesStateActive:
    '🛡 Service status: 🟢 active\nNew orders and renewals are open.',
  adminSalesStateStopped:
    '🛡 Service status: 🔴 stopped\nNew orders and renewals are temporarily closed; existing services are untouched and orders placed before the stop can still be paid and approved.',
  adminSalesUpdated: (v: string) => `Last change: ${v}`,
  adminSalesMalformed:
    '⚠️ The "sales" settings document is invalid; sales are assumed OPEN for now. Toggling once will rewrite it cleanly.',
  adminSalesHint:
    'This switch temporarily closes new service orders and renewals (e.g. when panel capacity is full). Everything else — existing services, support, announcements — keeps working.',
  adminSalesStoppedToast: '🛑 Service sales stopped.',
  adminSalesStartedToast: '🟢 Service sales resumed.',
  adminSalesConflict:
    '⚠️ Another admin just changed the state; showing the newest one.',
  adminSalesSaveFailed: '⚠️ The change could not be saved; showing the current state.',

  // ————— Phase 9: service notifications + subscription-page discovery —————
  // Important standalone notices: warm opener, never a greeting on mid-flow
  // bubbles, plain text, and no promises beyond what the panel actually does:
  // exhausted data → the panel puts the service in its own data-cap state;
  // renewing the duration does NOT add data — the copy has to say so honestly.
  usageNotice: (name: string, percent: string, remainingGb: string) =>
    `Heads up — 📊 "${name}" has used ${percent}% of its data (about ${remainingGb} GB left).\n\nWhen the data runs out, the panel puts the service into its "Limited (data cap)" state. Renewing the duration does not add data — if you need more, buy a new service or ask support for advice.`,
  expiryNotice: (name: string, remaining: string, expiresAt: string) =>
    `Quick reminder — ⏳ "${name}" expires in ${remaining}. Expiry date: ${expiresAt}.\n\nRenew it from "📦 My Services" whenever you\'d like so your connection doesn\'t drop; your dedicated service page is right there too.`,
  serviceNoticeView: '👁 View service',
  serviceNoticeList: '📦 My Services',

  // My Services audit — explicit remaining volume + degraded-usage pointer.
  svcRemaining: (v: string) => `📥 Data left: ${v} GB`,
  svcUsageHintSnapshot: '🔄 Press "Refresh status" for live usage numbers.',
  svcPageNote:
    '🌐 Same link, your personal service page — connection info and live status all in one place.',
  svcOpenPage: '🌐 Open service page',

  // ————— Phase 10: keyboards, the selector, Account rows —————
  menuBuy: '🛒 Buy a service',
  menuServices: '📦 My Services',
  menuOrders: '💳 My Orders',
  menuAccount: '👤 Account',
  menuWallet: '💰 Wallet',
  menuInvite: '🤝 Invite friends',
  menuSupport: '🆘 Support',
  menuTicket: '🎫 Create ticket',
  menuLanguage: '🌐 زبان / Language',
  langOptionFa: '🇮🇷 فارسی',
  langOptionEn: '🇬🇧 English',
  btnAutoPick: '🎲 Auto-pick',
  btnSkipReject: '❌ Reject without reason',
  btnCancelInline: '❌ Cancel',
  btnRenewService: '🔁 Renew service',
  btnRefreshStatus: '🔄 Refresh status',
  languageIntro:
    '🌐 Choose the language this bot should use.\n\nYou can switch back anytime.',
  languageSet:
    '✅ Bot language set to English.\n\nThe menu below is in English now.',
  accountBotLanguage: (v: string) => `Bot language: ${v}`,
  accountLanguageFa: 'Persian',
  accountLanguageEn: 'English',
  noticeServiceFallback: 'your service',

  // ————— Phase 11: connection guide — reviewed English copy —————
  // Authored to the Phase 10 voice rules: competent service desk, contractions
  // welcome, no hype. Store/platform/app names are locale-fixed brand text.
  menuGuide: '📚 Connection guide',
  guideIntro:
    '📚 Connection guide\n\nConnecting takes three quick steps:\n\n1) Copy the subscription link from 📦 My Services\n2) Install an app that fits your device\n3) Import the link into the app — and connect\n\nFirst — what are you connecting with? 👇',
  guidePlatformAndroid:
    '🤖 Connecting on Android\n\nPick one of the two apps below — both handle your subscription link, and each comes with its own step-by-step guide. For most phones, v2RayTun is the simpler pick.',
  guidePlatformIos:
    '🍎 Connecting on iPhone (iOS)\n\nInstall one of these two apps from the App Store — both import your subscription link. V2Box is the simpler pick.',
  guidePlatformWindows:
    '🪟 Connecting on Windows\n\nThrone is the pick for Windows — free and open-source. It imports subscription links straight from the official Releases page.',
  guideHowToApp: (app: string) => `📖 How to connect — ${app}`,
  guideBtnPlay: '📥 Google Play',
  guideBtnStore: '🍏 App Store',
  guideBtnReleases: '⬇️ Releases',
  guideBtnGithub: '📦 GitHub',
  guideOtherApps: '↩️ Other apps',
  guideStepsTun: `📚 v2RayTun — connect in a minute

1. Copy your subscription link: 📦 My Services → pick your service → tap the Subscription link.
2. Install v2RayTun from Google Play using the button below.
3. Open the app, tap +, and choose to import from the clipboard (QR or pasting the URL works too).
4. Name the profile anything you like — "My service" is fine.
5. Select the profile and tap Connect. When Android asks to set up a VPN connection, tap Allow.

Once traffic starts counting, you're online. Leave the rest of the settings alone — your link already does the work.`,
  guideStepsNg: `📚 v2rayNG — connect in a minute

1. Copy your subscription link: 📦 My Services → pick your service → tap the Subscription link.
2. This app ships through GitHub, not Google Play: the official download is the ⬇️ Releases button below. Grab the latest .apk and install it. If Android shows a security warning, follow the on-screen steps and make sure you are installing the release from the official 2dust/v2rayNG GitHub page.
3. Open v2rayNG → menu (☰) → "Add subscription over URL".
4. Paste the link, name the group, and confirm — the servers load right away.
5. Pick a server and press the ▶ Connect button. Tap Allow on the VPN request.

Defaults are fine — nothing else needs changing.`,
  guideStepsV2box: `📚 V2Box — connect in a minute

1. On your iPhone: copy your subscription link from 📦 My Services → pick your service → tap the Subscription link.
2. Install V2Box from the App Store using the button below.
3. Tap + (top right) → Subscribe → "Paste from clipboard" → name it → save.
4. Select your new profile and flip the switch at the top.
5. Tap Allow when iOS asks to add a VPN configuration — that's the only prompt.

The status turns green once you're connected.`,
  guideStepsStreisand: `📚 Streisand — connect in a minute

1. On your iPhone: copy your subscription link from 📦 My Services → pick your service → tap the Subscription link.
2. Install Streisand from the App Store using the button below.
3. Open Configs (the list icon) → tap + → Subscription.
4. Paste the link, keep the name it suggests, and save.
5. Choose the new config as your active profile, then flip the main switch and tap Allow on the VPN prompt.

Traffic in the status bar means you're online.`,
  guideStepsThrone: `📚 Throne — connect in a minute

1. Copy your subscription link from 📦 My Services → pick your service → tap the Subscription link. (On Telegram Desktop, right-click the link to copy it.)
2. Click ⬇️ Releases below and grab the latest version — the installer, or the portable ZIP if you'd rather not install anything.
3. If Windows SmartScreen shows a warning, verify that you downloaded Throne from the official GitHub releases page before continuing.
4. Open Throne → add a profile → choose the subscription/URL type and paste the link.
5. Pick your server and press Connect. Keep the default proxy mode.

Green status in the app means your whole machine is routed.`,

  orderStatus(state: string): string {
    switch (state) {
      case 'pending_payment':
        return en.statusPendingPayment;
      case 'awaiting_review':
        return en.statusAwaitingReview;
      case 'approved':
        return en.statusApproved;
      case 'provisioning':
        return en.statusProvisioning;
      case 'completed':
        return en.statusCompleted;
      case 'rejected':
        return en.statusRejected;
      case 'failed':
        return en.statusFailed;
      case 'cancelled':
        return en.statusCancelled;
      default:
        return state;
    }
  },
  panelStatus(status: string): string {
    switch (status) {
      case 'active':
        return en.svcPanelActive;
      case 'limited':
        return en.svcPanelLimited;
      case 'expired':
        return en.svcPanelExpired;
      case 'disabled':
        return en.svcPanelDisabled;
      case 'on_hold':
        return en.svcPanelOnHold;
      default:
        return status.slice(0, 24);
    }
  },
  walletKind(kind: string): string {
    switch (kind) {
      case 'referral_reward':
        return en.walletKindReferralReward;
      case 'admin_grant':
        return en.walletKindAdminGrant;
      case 'admin_debit':
        return en.walletKindAdminDebit;
      case 'order_payment':
        return en.walletKindOrderPayment;
      case 'order_refund':
        return en.walletKindOrderRefund;
      default:
        return kind.slice(0, 24);
    }
  },
  // English keeps the friendliness but none of the Persian catchphrases.
  reactionDevices: (count: number) =>
    count <= 1 ? null : deviceLineEn(count),
  reactionVolume: (gb: number) =>
    gb > GENEROUS_VOLUME_GB ? `Bold choice — ${gb} GB. We like that 😄` : null,
};

export { en };
