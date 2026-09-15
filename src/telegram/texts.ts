/**
 * All user-facing bot text in one place (Persian-first).
 * Keys are stable; wording polished across Phase 8 (8A keyboards, 8B persona).
 * NOTE: prices/payment copy arrive Phase 3/4 — never here.
 *
 * PHASE 8B PERSONALITY RULES:
 *  - Greeting style is «درود»، personalized «درود زیبا» when the name is
 *    unknown. Use it ONLY where a greeting is natural: the welcome (see
 *    welcomeGreeting) and important standalone customer notifications (see
 *    notifyApproved). NEVER force it into mid-flow prompts, validation
 *    errors, short confirmations, or back-to-back consecutive bubbles.
 *  - The 90%-usage and single-expiry alerts were reserved here in 8B and
 *    arrived in Phase 9: they open with «درود زیبا، …», stay idempotent
 *    (one per service, enforced in `service_notifications`), and promise
 *    nothing the panel contract does not actually guarantee.
 *  - «زیبا/رفیق/داداش» are sparing catchphrases, not filler.
 */
import { tgCode, tgEscapeHtml } from './format.ts';

export const fa = {
  notConfigured:
    '⚠️ ربات هنوز کامل تنظیم نشده است.',

  // Greeting rule (Phase 8B): «درود زیبا» when the user's first name is
  // unknown; the name itself personalizes it when available. Never forced
  // into mid-flow prompts, validation errors, or consecutive bubbles.
  welcomeGreeting: (firstName: string | null) =>
    `👋 درود ${firstName ?? 'زیبا'}، به ربات خوش اومدی ❤️`,
  welcomeIntro: 'برای شروع، از منوی پایین یه گزینه رو انتخاب کن.',
  menuPrompt: '👇 منوی اصلی',

  cmdUnknown: '❓ این دستور برام تازه‌ست!\nاز دکمه‌های منو استفاده کن یا /help رو بزن.',
  helpText: [
    '🤖 راهنما',
    '',
    '/start — نمایش منوی اصلی',
    '/cancel — بازگشت به منو و لغو عملیات جاری',
    '/help — همین پیام',
    '/pending — (مدیران) فیش‌های در انتظار بررسی',
    '/failed — (مدیران) سفارش‌های ناموفقِ راه‌اندازی/تمدید',
    '/tickets — (مدیران) تیکت‌های باز پشتیبانی',
    '/announce — (مدیران) ارسال اطلاعیه برای همه کاربران',
    '/announcements — (مدیران) وضعیت اطلاعیه‌های اخیر',
    '/pricing — (مدیران) نمایش و ویرایش قیمت‌ها',
    '/sales — (مدیران) توقف/فعال‌سازی سرویس',
    '',
    '📦 در «سرویس‌های من» می‌توانید وضعیت و انقضای سرویس‌ها را ببینید و آن‌ها را تمدید کنید.',
    'برای شروع، دکمه‌های زیر را بزنید.',
  ].join('\n'),

  // Buy flow (Phase 2 proves the machine; product steps arrive Phase 3)
  buyIntro: [
    '🛒 خرید سرویس',
    '',
    'اول یه نام برای کانفیگت انتخاب کن.',
    'باید انگلیسی باشه (حروف لاتین، حداکثر ۲۰ حرف هر کلمه، جدا با فاصله)، حداقل ۶ و حداکثر ۶۴ نویسه.',
    'هر وقت خواستی با «بازگشت به منو» یا /cancel بیرون بیا.',
  ].join('\n'),
  buyWaitingConfigName:
    'زیبا لطفا یه نام انگلیسی حداقل ۶ حرفی انتخاب کن یا اگر میخوای من برات رندوم انتخاب کنم',
  configNameInvalid:
    '🙈 نام کانفیگ نامعتبره؛ باید انگلیسی و حداقل ۶ حرف باشه (مثل: Silver). دوباره تلاش کن یا «انتخاب خودکار» رو بزن.',
  configNameSaved: (name: string) =>
    `✅ نام کانفیگ «${name}» ثبت شد.`,
  buyInProgress: '🛒 خریدت نصفه مونده؛ ادامه بده یا با «بازگشت به منو» لغوش کن.',

  // Sections not yet implemented
  accountHeader: '👤 اطلاعات حساب شما',
  accountUsername: (v: string) => `نام کاربری: ${v}`,
  accountNone: '—',
  accountLanguage: (v: string) => `زبان تلگرام: ${v}`,
  accountSince: (v: string) => `تاریخ عضویت: ${v}`,
  accountStatusIdle: 'وضعیت: آماده ✅',
  accountStatusBusy: 'وضعیت: وسط یک فرآیندی؛ با /cancel می‌تونی برگردی.',

  cancelled: '↩️ به منوی اصلی بازگشتید.',
  sessionExpired: '⏱️ نشست قبلی منقضی شده بود؛ با منوی اصلی ادامه می‌دهیم.',

  invalidChoice: '❌ این گزینه نامعتبره؛ از گزینه‌های همین مرحله استفاده کن.',
  backToMenu: '🔙 بازگشت به منو',
  // Phase 8B: the OFF-TOPIC global fallback — used ONLY for input/no media
  // that falls outside every defined flow context (never inside a live step,
  // payment, support or admin handling). Byte-frozen by tests/phase8b.
  idleInputHint:
    'مشتی من رباتماا😅 نمیتونم مثل شما حرف بزنم بی زحمت از منوی موجود استفاده کن،دمت گرم',
  // A mere back-tap while nothing is pending: soft nudge, not the fallback.
  idleMenuNudge: '😊 چیزی باز نیست؛ از منوی پایین هر چی خواستی انتخاب کن.',

  // ————— Phase 3: purchase options, summary, confirmation —————
  catalogUnavailable:
    '🔧 یه لحظه رفیق، گزینه‌ها درست بارگذاری نمی‌شن؛ کمی بعد دوباره سر بزن.',
  volumePrompt: (min: number, max: number) =>
    `📦 حجم سرویس رو انتخاب کن.\n\nحداقل ${min} و حداکثر ${max} گیگابایت.\nبرای مقدار دلخواه، عدد رو تایپ کن (یا دکمه‌ی «دلخواه»).`,
  durationPrompt: (min: number, max: number, allowCustom = true) =>
    `⏳ مدت سرویس رو انتخاب کن.\n\n${durationLabelFa(min)} تا ${durationLabelFa(max)}.` +
    (allowCustom ? '\nبرای مقدار دلخواه، عدد روز رو تایپ کن.' : ''),
  devicePrompt: (min: number, max: number, allowCustom = true) =>
    `📱 تعداد دستگاه‌های مجاز رو انتخاب کن:\n\nبین ${min} تا ${max}.` +
    (allowCustom ? '\nبرای مقدار دلخواه، عدد رو تایپ کن.' : ''),
  customVolumeLabel: '✍️ مقدار دلخواه',
  customHint: '✍️ حالا عدد دلخواه را همین‌جا تایپ کن و بفرست.',
  rejectedRange: (min: number, max: number) =>
    `⚠️ عدد باید بین ${min} تا ${max} باشد. دوباره تلاش کنید یا «بازگشت» را بزنید.`,
  // Phase 8B: flow-specific rejections — each step answers in its own domain.
  rejectedVolumeRange: (got: number, min: number, max: number) =>
    `📦 دِ آخه مشتی ${digitsFa(got)} گیگ؟ 😐 حجم مجاز بین ${digitsFa(min)} تا ${digitsFa(max)} گیگابایته؛\nیه عدد دیگه امتحان کن یا «بازگشت» رو بزن ❤️`,
  rejectedDurationRange: (min: number, max: number) =>
    `⏳ مدت سرویس باید بین ${min} تا ${max} روز باشه.\nیه عدد دیگه امتحان کن یا «بازگشت» رو بزن.`,
  rejectedDeviceRange: (min: number, max: number) =>
    `📱 تعداد دستگاه باید بین ${min} تا ${max} باشه.\nیه عدد دیگه امتحان کن یا «بازگشت» رو بزن.`,
  rejectedPresetDisabled: '⚠️ این گزینه فعلاً تو فهرست نیست؛ یکی از دکمه‌های موجود رو انتخاب کن.',
  rejectedNotWhole: '✍️ این که عدد نبود رفیق! فقط یک عدد صحیح بفرست؛ یا «بازگشت» رو بزن.',
  staleChoice: '🔄 این دکمه مال یه مرحله‌ی دیگه‌ست؛ اول همین مرحله رو ادامه بده.',
  stepBack: '↩️ بازگشت به مرحله قبل',
  confirmYes: '✅ تأیید و ثبت سفارش',

  summaryHeader: '🧾 خلاصه سفارش',
  summaryName: (v: string) => `🏷 نام کانفیگ: ${v}`,
  summaryVolume: (gb: number) => `📦 حجم: ${gb} گیگابایت`,
  summaryDuration: (days: number, months: number) =>
    `⏳ مدت: ${days} روز (${months} ماه)`,
  summaryDevices: (n: number) => `📱 دستگاه: ${n}`,
  summaryPrice: (v: string) => `💰 قیمت کل: ${v}`,
  summaryId: (id: string) => `🆔 کد سفارش: ${id}`,
  summaryHint: 'همه‌چیز اوکیه؟ «تأیید» رو بزن؛ برای ویرایش «بازگشت».',

  orderCreated: (id: string) =>
    `✅ سفارش شما ثبت شد!\n\n🆔 کد: ${id}\n\n👇 اطلاعات واریز در پیام بعدی ارسال می‌شود.`,
  orderConfirmToast: '✅ سفارش ثبت شد.',
  alreadyConfirmed: '✅ این سفارش قبلاً ثبت شده است.',

  paymentWaitNotice:
    '⏳ فیش پرداختت در انتظار بررسیشه؛ نگرانش نباش.\n\n💡 اگه فیش اشتباه اومده، تصویر/فایل جدیدی بفرست تا جاش بیاد.\nبرای پیگیری، وضعیتش رو از «💳 سفارش‌های من» ببین.',

  missingDraftData: '⚠️ اطلاعات سفارش کامل نیست؛ از اول شروع کن.',

  // ————— Phase 4: payment, receipts, admin review —————
  paymentInstructionsHeader: '💳 اطلاعات واریز وجه',
  paymentHolder: (v: string) => `👤 به نام: ${tgEscapeHtml(v)}`,
  // Phase 8C: the card line is only ever rendered in the HTML payment
  // instructions bubble; the value arrives raw and becomes tap-to-copy code.
  paymentCard: (v: string) => `🏦 شماره کارت: ${tgCode(v)}`,
  paymentIban: (v: string) => `IBAN: ${tgCode(v)}`,
  paymentAmountLine: (v: string) => `💰 مبلغ قابل واریز: ${v}`,
  paymentReceiptPrompt:
    '🧾 مبلغ دقیق سفارش را به شماره کارت ذکرشده واریز کنید.\nبعد از واریز، تصویر یا فایل فیش پرداخت رو همین‌جا در گفتگو ارسال کنید.\n\n🔎 بررسی فیش به‌صورت دستی انجام می‌شه؛ ممکنه کمی زمان ببره.',
  paymentCopyHint: '📋 برای کپی کردن شماره کارت، فقط یک بار روی شماره کارت بزن.',
  paymentInfoUnavailable:
    '⚠️ اطلاعات واریز فعلاً در دسترس نیست؛ برای ادامه با پشتیبانی در ارتباط باش.',
  // Phase 8C: shown at most once per message, only when a <code> value is in it.
  copyHint: '(یک بار بزن روی مقدار، کپی می‌شه)',

  receiptAccepted:
    '✅ فیش پرداختت ثبت شد و برای بررسی ارسال شد.\n\nبررسی دستیه؛ بعد از تأیید، ادامه‌ی کار خودکار انجام می‌شه و از تو کاری ساخته نیست.\n\nنتیجه معمولاً تا چند ساعت میاد؛ وضعیت رو از «💳 سفارش‌های من» پیگیری کن.',
  receiptReplaced:
    '✅ فیش جدید جایگزین شد و دوباره برای بررسی ارسال شد.\n\nصف بررسی از همون فیش اول حساب می‌شه؛ لازم نیست دوباره فیش بفرستی.',
  receiptExpectedMedia: '🧾 فیش رو به‌صورت تصویر یا فایل (برگردان فیش) بفرست؛ متن به‌تنهایی فیش حساب نمی‌شه.',
  receiptOrderMissing: '⚠️ سفارشی مرتبط با این گفتگو پیدا نشد؛ از منوی خرید دوباره شروع کن.',
  receiptOrderNotPayable: '⚠️ این سفارش دیگه تو مرحله‌ی ارسال فیش نیست؛ وضعیتش رو از «💳 سفارش‌های من» ببین.',

  // ————— Phase 8C: payment review reminders (15/30/45 min, max 3) —————
  // Persona rules: three DISTINCT concise variants (never repeats itself),
  // ⏳-anchored, no greeting (the customer's own receipt is the previous
  // bubble), no invented promises beyond «به‌زودی», Persian digits.
  reminderCustomer1: (id: string) =>
    `⏳ فیش سفارش ${id} هنوز در انتظار بررسی است.\n\nبه‌زودی نتیجه مشخص می‌شود؛ نیاز به اقدام دیگری نیست.`,
  reminderCustomer2: (id: string) =>
    `⏳ سفارش ${id} هنوز در انتظار بررسی فیش است.\n\nاگر فیش را اشتباه فرستاده‌اید، تصویر/فایل جدیدی بفرستید تا جایگزین شود.`,
  reminderCustomer3: (id: string) =>
    `⏳ فیش سفارش ${id} هنوز در انتظار بررسی است.\n\nبررسی کمی طول کشیده — ممنون که صبر دارید؛ نتیجه به‌زودی اعلام می‌شود.`,
  reminderAdminHeader: '⏰ یادآوری: این فیش‌ها هنوز در انتظار بررسی‌اند',
  reminderAdminEntry: (n: number, shortId: string, minutes: number) =>
    `${n}. 🆔 ${shortId} — ${digitsFa(minutes)} دقیقه است در انتظار`,

  statusPendingPayment: '⏳ در انتظار پرداخت',
  statusAwaitingReview: '🔎 در انتظار بررسی فیش',
  statusApproved: '✅ تأییدشده — در انتظار راه‌اندازی',
  statusProvisioning: '⚙️ در حال راه‌اندازی سرویس',
  statusCompleted: '🟢 سرویس فعال شد',
  statusRejected: '❌ رد شده',
  statusFailed: '⚠️ ناموفق',
  statusCancelled: '🚫 لغو شده',

  ordersHeader: '🧾 سفارش‌های شما (جدیدترین‌ها)',
  ordersEmpty: 'هنوز سفارشی ثبت نکردی.\nاز منوی «🛒 خرید سرویس» شروع کن.',
  ordersEntry: (n: number, shortId: string, status: string, price: string, date: string) =>
    `${n}. 🆔 ${shortId} — ${status}\n   ${price} — ${date}`,

  notifyApproved: (id: string, amount: string) =>
    `درود زیبا، پرداخت شما تأیید شد!\n\n🆔 سفارش: ${id}\n💰 مبلغ: ${amount}\n\nسرویس شما به‌زودی ساخته می‌شود و اطلاعات اتصال ارسال خواهد شد.`,
  notifyRejected: (id: string, reason: string) =>
    `❌ متأسفانه فیش پرداخت سفارش تأیید نشد.\n\n🆔 سفارش: ${id}\n📝 دلیل: ${reason}\n\nمی‌توانید دوباره خرید کنید یا با پشتیبانی گفتگو کنید.`,

  adminReceiptHeader: '🧾 فیش جدید برای بررسی',
  adminReceiptLine: (n: number, id: string, status: string, amount: string, uploader: string) =>
    `${n}. 🆔 ${id}\n   ${status} — ${amount}\n   پرداخت‌کننده: ${uploader}`,
  adminProcessedApprove: (id: string, adminId: string) =>
    `✅ تأیید شد\n🆔 ${id}\nبررسی‌کننده: ${adminId}`,
  adminProcessedReject: (id: string, adminId: string) =>
    `❌ رد شد\n🆔 ${id}\nبررسی‌کننده: ${adminId}`,
  adminProcessedStale: (id: string) => `ℹ️ سفارش ${id} قبلاً بررسی شده است.`,
  adminQueueHeader: '🗂 فیش‌های در انتظار بررسی',
  adminQueueEmpty: '🎉 در حال حاضر فیشی در انتظار بررسی نیست.',
  adminRejectPromptMsg:
    '⌨️ دلیل رد را بنویسید و بفرستید.\n\nاین دلیل برای مشتری ارسال می‌شود؛ یا دکمه‌ی «رد بدون دلیل» را بزنید.',
  adminRejectDefaultReason: 'پرداخت تأیید نشد.',
  adminApprovedToast: '✅ سفارش تأیید شد.',
  adminRejectedToast: '❌ سفارش رد شد.',
  adminStaleToast: 'این سفارش قبلاً بررسی شده است.',
  adminRejectCancelled: '↩️ رد سفارش لغو شد.',
  cmdAdminOnly: '❌ این دستور در دسترس شما نیست.',

  paymentVerifiedByLabel: (v: string) => `بررسی‌کننده: ${v}`,
  paymentReferenceLine: (v: string) => `🧾 مرجع پرداخت: ${v}`,

  // ————— Phase 5: automatic provisioning (PasarGuard) —————
  // Phase 9 (approved UX): the SAME panel link IS the customer's dedicated
  // service page — the bot only points at it (discovery/presentation), it
  // never builds a page or promises content the panel doesn't own.
  serviceReady: (id: string, url: string) =>
    `🎉 سرویس شما ساخته و فعال شد!\n\n🆔 سفارش: ${id}\n🔗 لینک اشتراک:\n${tgCode(url)}\n${fa.copyHint}\n\nاین لینک را در اپلیکیشن خود (v2rayNG / Nekobox / Streisand و…) وارد کنید.\n\n🌐 همین لینک، صفحه‌ی اختصاصی سرویس توئه؛ هر وقت خواستی لینک و اطلاعات سرویست رو دوباره ببینی، همین‌جاست.`,
  serviceReadyWithoutLink: (id: string) =>
    `🎉 سرویس شما ساخته شد.\n\n🆔 سفارش: ${id}\n\nلینک اتصال فعلاً نمیاد؛ به‌زودی از «سرویس‌های من» در دسترس می‌شه. اگه عجله داری با پشتیبانی در ارتباط باش.`,
  provisionFailedNotice: (id: string) =>
    `⚠️ ساخت سرویسِ این سفارش چند بار به مشکل خورد.\n\n🆔 سفارش: ${id}\n\nبچه‌ها در جریانی و دارن پیگیری می‌کنن؛ لازم نیست دوباره پرداخت کنی.`,
  provisionNameRejectedNotice: (id: string) =>
    `⚠️ متأسفانه پنل، نامِ سرویسِ این سفارش را نپذیرفت.\n\n🆔 سفارش: ${id}\n\n پرداخت شما کاملاً محفوظ است و هیچ مبلغی دوباره کسر نمی‌شود. تیم ما به‌زودی با نامی تازه تلاش می‌کند؛ اگر عجله دارید می‌توانید سفارشی نو با «انتخاب خودکار» یا یک نام انگلیسی حداقل ۶ حرفی دیگر شروع کنید.`,
  adminProvisionFailed: (id: string, reason: string) =>
    `⚠️ ساخت سرویس ناموفق بود\n🆔 ${id}\n📝 ${reason.slice(0, 200)}\n\nبا دکمه‌ی زیر می‌توانید دوباره تلاش کنید (تا سقف مجاز).`,
  failedQueueHeader: '🧯 سفارش‌های ناموفقِ راه‌اندازی',
  failedQueueEmpty: '🎉 سفارش ناموفقی وجود ندارد.',
  failedQueueEntry: (n: number, id: string, reason: string, attempts: number) =>
    `${n}. 🆔 ${id}\n   ⚠️ ${reason.slice(0, 160)}\n   تلاش: ${attempts}`,
  adminRetryOkToast: '✅ سرویس ساخته شد.',
  adminRetryFailToast: '❌ تلاش مجدد هم ناموفق بود؛ جزئیات برای مدیران ارسال شد.',
  adminRetryStaleToast: 'این سفارش هم‌اکنون در حال پردازش یا تغییر وضعیت است.',
  adminRetryExhaustedToast: '🚫 سقف تلاش مجدد برای این سفارش پر شده است.',
  adminPanelUnavailableToast: '⚠️ پیکربندی پنل کامل نیست؛ بعداً دوباره تلاش کنید.',
  adminProvisionDisabledToast: '⚠️ ساخت خودکار سرویس فعلاً غیرفعال است.',
  adminProvisionDone: (id: string) => `🔁 نتیجه‌ی تلاش مجدد ثبت شد\n🆔 ${id}`,
  adminProvisionStale: (id: string) => `ℹ️ وضعیت سفارش ${id} تغییر کرده است؛ نیازی به این دکمه نیست.`,

  // ————— Phase 6: My Services + status + renewals —————
  servicesHeader: '📦 سرویس‌های شما',
  servicesEmpty: 'هنوز سرویس فعالی نداری؛\nاز منوی «🛒 خرید سرویس» شروع کن.',
  serviceStatusActive: '🟢 فعال',
  serviceStatusExpiring: '⏳ رو به اتمام',
  serviceStatusExpired: '‼️ منقضی‌شده',
  serviceStatusUnknown: '⚪ نامشخص',
  servicesEntry: (n: number, name: string, shortId: string, status: string, expires: string) =>
    `${n}. 📦 ${name} — ${status}\n   🆔 ${shortId} — انقضا: ${expires}`,
  serviceNotFound: '🚫 سرویسی با این شناسه ندارید یا در دسترس نیست.',
  serviceBusyFirst: '🛑 اول همین مرحله رو کامل کن یا /cancel بفرست.',

  svcDetailHeader: (name: string) => `📦 سرویس «${name}»`,
  svcPanelActive: '🟢 فعال',
  svcPanelLimited: '🟡 محدود (حجم)',
  svcPanelExpired: '‼️ منقضی‌شده',
  svcPanelDisabled: '⛔ غیرفعال',
  svcPanelOnHold: '⏸ در انتظار',
  svcPendingRenewal: (shortId: string) => `🔁 تمدید در جریان: سفارش ${shortId}…`,
  svcToastPanel: '✅ وضعیت لحظه‌ای از پنل',
  svcToastSnapshot: '🖥 پنل در دسترس نبود؛ وضعیت محلی',
  svcId: (id: string) => `🆔 شناسه سرویس: ${id}`,
  svcPanelUsername: (v: string) => `👤 نام در پنل: ${v}`,
  svcCreated: (v: string) => `📅 ساخته‌شده: ${v}`,
  svcExpires: (v: string) => `⏳ تاریخ انقضا: ${v}`,
  svcDaysLeft: (days: number) => `🔂 باقی‌مانده: ${digitsFa(days)} روز`,
  svcExpiredDaysAgo: (days: number) => `⚠️ ${digitsFa(days)} روز پیش منقضی شده است`,
  svcUsage: (used: string, total: string) => `📊 مصرف ترافیک: ${used} از ${total} گیگ`,
  svcLink: '🔗 لینک اشتراک:',
  // Phase 8C: the detail bubble opts into HTML so the URL is tap-to-copy.
  svcLinkCode: (url: string) => `${fa.svcLink}\n${tgCode(url)}\n${fa.copyHint}`,
  svcSnapshotNote: '🖥 پنل در دسترس نبود؛ اطلاعات از آخرین وضعیت محلی نشون داده می‌شه.',
  svcLiveNote: '🖥 وضعیت لحظه‌ای از پنل',

  renewDisabledNotice: '🔧 امکان تمدید فعلاً غیرفعال است.',
  renewInProgressNotice: (id: string) =>
    `🔁 یک درخواست تمدید برای این سرویس باز است.\n\n🆔 سفارش تمدید: ${id}\n\nوضعیت آن را از «💳 سفارش‌های من» پیگیری کنید.`,
  renewIntro: (name: string, expires: string) =>
    `🔁 تمدید سرویس «${name}»\n\n📅 انقضای فعلی: ${expires}\n\nبرای تمدید، مدت رو انتخاب کن.\nهزینه‌ی تمدید همون عددِ مشخصِ همون مدته؛ پرداخت مثل خرید، با فیش و تأیید دستی.`,
  renewDurationPrompt: '⏳ مدت تمدید رو انتخاب کن:\n\n۱ ماه • ۲ ماه • ۳ ماه',
  renewSummaryHeader: '🧾 خلاصه‌ی تمدید',
  renewSummaryService: (name: string) => `📦 سرویس: «${name}»`,
  renewSummaryAdd: (months: number) => `➕ مدت تمدید: ${digitsFa(months)} ماه`,
  renewSummaryFrom: (v: string) => `📅 انقضای فعلی: ${v}`,
  renewSummaryUntil: (v: string) => `📅 انقضای جدید (تقریبی): ${v}`,
  renewConfirmed: (id: string) =>
    `✅ درخواست تمدید ثبت شد!\n\n🆔 کد: ${id}\n\n👇 اطلاعات واریز در پیام بعدی ارسال می‌شود.`,
  renewApplied: (id: string, expiresDate: string) =>
    `🎉 سرویس شما تمدید شد!\n\n🆔 سفارش: ${id}\n📅 انقضای جدید: ${expiresDate}\n\nاز «📦 سرویس‌های من» می‌توانید وضعیت را ببینید.`,
  renewFailedNotice: (id: string) =>
    `⚠️ تمدید سرویسِ این سفارش چند بار به مشکل خورد.\n\n🆔 سفارش: ${id}\n\nبچه‌ها در جریانی و دارن پیگیری می‌کنن؛ لازم نیست دوباره پرداخت کنی.`,
  adminRenewalFailed: (id: string, reason: string) =>
    `⚠️ تمدید سرویس ناموفق بود\n🆔 ${id}\n📝 ${reason.slice(0, 200)}\n\nبا دکمه‌ی زیر می‌توانید دوباره تلاش کنید (تا سقف مجاز).`,
  adminRenewalKind: (serviceId: string) => `🔄 تمدید سرویس ${serviceId}`,
  notifyApprovedRenewal: (id: string, amount: string) =>
    `🎉 پرداخت تمدید شما تأیید شد!\n\n🆔 سفارش: ${id}\n💰 مبلغ: ${amount}\n\nتمدید به‌زودی روی سرویس اعمال می‌شود.`,
  ordersKindRenewal: '(تمدید)',

  // ————— Phase 7: wallet + referrals + support + announcements (IRT/Toman) —————
  walletUnavailable: '🔧 کیف پول فعلاً در دسترس نیست رفیق؛ کمی بعد دوباره سر بزن.',
  walletHeader: '💰 کیف پول شما',
  walletBalance: (v: string) => `موجودی: ${v}`,
  walletEmpty: 'هنوز تراکنشی در کیف پول شما ثبت نشده است.',
  walletEntry: (n: number, sign: string, kind: string, amount: string, date: string) =>
    `${n}. ${sign} ${amount} — ${kind}\n   ${date}`,
  walletKindReferralReward: '🎁 جایزه معرفی',
  walletKindAdminGrant: '➕ اعتبار هدیه',
  walletKindAdminDebit: '➖ کسر اعتبار',
  walletKindOrderPayment: '🛒 پرداخت سفارش',
  walletKindOrderRefund: '↩️ بازگشت اعتبار',
  walletDebited: (v: string) => `✅ مبلغ ${v} از موجودی کیف پول کسر شد.`,
  walletGranted: (v: string) => `✅ مبلغ ${v} به کیف پول شما اضافه شد.`,
  walletAmountInvalid:
    '⚠️ مبلغ را صحیح و بدون نشانه‌ی اضافی بفرستید؛ یا «بازگشت» را بزنید.',
  walletAmountTooBig: (max: string) => `⚠️ حداکثر مقدار مجاز در هر عملیات: ${max}`,
  walletPromptAmount: (verb: string) =>
    `⌨️ مبلغ دلخواه (${verb}، به تومان) را با عدد صحیح بفرستید؛ برای انصراف «بازگشت به منو».`,
  walletBalanceLow: '⚠️ موجودی کیف پول کافی نیست.',
  walletTargetUser: (v: string) => `👤 کاربر هدف: ${v}`,

  payWalletFull: '💰 پرداخت کامل با کیف پول',
  payWalletPart: '🔅 کسر موجودی و پرداخت مابقی',
  summaryWalletLine: (v: string) => `👛 موجودی کیف پول شما: ${v}`,
  walletPayConfirmToast: '✅ پرداخت از کیف پول انجام شد.',
  walletPaidOrderCreated: (id: string, used: string) =>
    `🎉 سفارش شما با موفقیت و به‌صورت آنی پرداخت شد!\n\n🆔 کد: ${id}\n👛 از کیف پول: ${used}\n\nسرویس شما به‌زودی ساخته می‌شود و اطلاعات اتصال ارسال خواهد شد.`,
  walletPartialCreated: (id: string, used: string, rest: string) =>
    `✅ ثبت شد — ${used} از کیف پول کسر گردید.\n\n🆔 کد: ${id}\n💳 مانده قابل واریز: ${rest}\n\n👇 اطلاعات واریز در پیام بعدی ارسال می‌شود.`,
  walletPaidRenewal: (id: string, used: string) =>
    `🎉 تمدید شما با موفقیت و به‌صورت آنی پرداخت شد!\n\n🆔 سفارش: ${id}\n👛 از کیف پول: ${used}\n\nتمدید به‌زودی روی سرویس اعمال می‌شود.`,
  walletPartialRenewal: (id: string, used: string, rest: string) =>
    `✅ ثبت شد — ${used} از کیف پول کسر گردید.\n\n🆔 کد: ${id}\n💳 مانده قابل واریز: ${rest}\n\n👇 اطلاعات واریز در پیام بعدی ارسال می‌شود.`,
  notifyWalletRefunded: (id: string, amount: string) =>
    `ℹ️ مبلغ ${amount} از سفارشِ رد‌شده به کیف پول شما بازگشت.\n\n🆔 سفارش: ${id}`,
  adminRefundedLine: (amount: string) => `↩️ بازگشت به کیف پول مشتری: ${amount}`,

  inviteHeader: '🤝 دعوت از دوستان',
  inviteLinkNone: (link: string) => `🔗 لینک دعوت شما:\n${link}`,
  inviteCount: (n: number) => `دعوت‌های موفق: ${digitsFa(n)}`,
  inviteEarned: (v: string) => `مجموع جوایز: ${v}`,
  inviteHowTo: [
    'این لینک را برای دوستتان بفرستید؛',
    'با اولین خرید تأییدشده‌ی او، جایزه‌ی معرفی به کیف پول شما اضافه می‌شود.',
  ].join('\n'),
  inviteRewardPercent: (v: string) => `🎁 پاداش هر معرفی موفق: ${v}٪ از مبلغ اولین خرید`,
  refNoticeJoined: (v: string) => `🌱 حساب شما با لینک دعوت ${v} ثبت شد.`,
  refPaidToReferrer: (amount: string, referee: string) =>
    `🎁 جایزه‌ی معرفی به کیف پول شما اضافه شد: ${amount}\nدعوتشده: ${referee}`,
  refPaidFromSide: (referee: string, amount: string) =>
    `🎉 دوستی که دعوت کرده‌اید خرید اولش انجام شد — جایزه ${amount} به او داده شد.`,
  referralUnavailable: '🔗 فعلاً امکان ساخت لینک دعوت وجود ندارد.',

  /** Direct contact with a human — creates no ticket, tracks nothing. */
  supportDirect: (url: string, ticketLabel: string) =>
    `🆘 پشتیبانی مستقیم\n\nبرای حرف زدن با پشتیبانی، این حساب رو توی تلگرام باز کن و پیامت رو بفرست:\n${url}\n\nهر وقت کارت به پیگیری نیاز داشت «${ticketLabel}» رو بزن تا تیکت ثبت بشه.`,
  /** Fail-closed twin: the operator has not set SUPPORT_CONTACT yet. */
  supportDirectNone: (ticketLabel: string) =>
    `🆘 فعلاً راه تماس مستقیم پشتیبانی توی تنظیمات ربات ثبت نشده.\n\nبرای پیگیری، «${ticketLabel}» رو بزن — همین‌جا جوابت رو میدیم.`,
  supportIntro: [
    '🎫 تیکت پشتیبانی',
    '',
    'مشکل یا پرسشت رو توی یه پیام بنویس و بفرست.',
    'جواب کارشناس معمولاً همین‌جا برات می‌رسه.',
    'برای برگشت، «بازگشت به منو» یا /cancel.',
  ].join('\n'),
  supportTicketCreated: (id: string) =>
    `📨 درخواستت ثبت شد.\n\n🎫 کد تیکت: ${id}\n\nهمین‌جا باخبرت می‌کنیم وقتی جواب بیاد.`,
  supportTicketExists: (id: string) =>
    `🎫 تیکت بازِ شما (${id.slice(0, 10)}…) هنوز فعال است.`,
  supportQueueChoice: '✍️ متن پیام جدید رو بفرست تا به کارشناس برسه.',
  supportAnswered: '💬 پاسخ پشتیبانی:\n\n',
  supportClosedNotice: '✅ تیکت بسته شد. در صورت نیاز، دوباره «پشتیبانی» را بزنید.',
  supportTicketClosedAlready: 'ℹ️ این تیکت بسته شده است.',
  adminTicketNew: (customer: string, subject: string) =>
    `🆕 تیکت پشتیبانی\n👤 ${customer}\n📝 ${subject}`,
  adminTicketFollowup: (customer: string, subject: string) =>
    `✍️ پیام جدید مشتری\n👤 ${customer}\n📝 ${subject}`,
  adminTicketQueueHeader: '🗂 تیکت‌های باز پشتیبانی',
  adminTicketQueueEmpty: '🎉 تیکت بازی وجود ندارد.',
  adminTicketQueueEntry: (n: number, code: string, customer: string, subject: string, messages: number) =>
    `${n}. 🎫 ${code} — ${customer}\n   ${subject}\n   پیام‌ها: ${digitsFa(messages)}`,
  adminTicketPrompt: '⌨️ پاسخ خود را بنویسید و بفرستید (حداکثر ۲۰۰۰ نویسه).',
  adminTicketSent: '✅ پاسخ برای مشتری ارسال شد.',
  adminTicketStale: 'این تیکت دیگر باز نیست یا پیدا نشد.',
  supportBusyFirst: '🛑 اول همین مرحله رو کامل کن یا /cancel بفرست.',
  ticketNotFound: '🚫 تیکتی با این شناسه پیدا نشد.',

  // ————— Phase 12: admin pricing management (Persian-only operational surface) —————
  adminPricingHeader: '💰 مدیریت قیمت‌ها',
  adminPricingLegend:
    'محصول پایه = ۱۰ گیگ + ۱ کاربر + ۱ ماه.\n' +
    'قیمت ماه‌های بیشتر و هر تعداد کاربر، عدد مستقلِ انتخابیِ شماست؛ ' +
    'ربات هیچ ضریبی نمی‌سازد.',
  adminPricingFieldBase: (price: string) => `🧱 محصول پایه: ${price}`,
  adminPricingFieldGb: (price: string) => `⚖️ هر گیگ اضافه: ${price}`,
  adminPricingFieldMonth: (months: number, price: string) =>
    `📅 ${digitsFa(months)} ماهه: ${price}`,
  adminPricingFieldUsers: (count: number, price: string) =>
    `👤 ${digitsFa(count)} کاربر: ${price}`,
  adminPricingUserIncluded: 'داخل پایه',
  adminPricingPrompt: (label: string, current: string) =>
    `✏️ ${label}\nقیمت فعلی: ${current}\n\nمبلغ تازه را به تومان و فقط با عدد صحیح بفرستید؛ «بازگشت به منو» لغو می‌کند.`,
  adminPricingStaged: (label: string, value: string) =>
    `🧾 مقدار تازه برای «${label}»: ${value}\n\nبا «ثبت قیمت» تأیید کنید یا انصراف بدهید.`,
  adminPricingConfirmToast: '✅ قیمت جدید ثبت شد.',
  adminPricingAppliedLine: (label: string, value: string) =>
    `✅ ثبت شد — ${label}: ${value}`,
  adminPricingAmountInvalid:
    '⚠️ مبلغ را درست بفرستید؛ فقط رقم (فارسی یا انگلیسی)، بدون نشانه و بدون اعشار.',
  adminPricingAmountRejected:
    '⚠️ این مقدار برای این فیلد مجاز نیست (۰ تا ۱٬۰۰۰٬۰۰۰٬۰۰۰؛ قیمت پایه و هر گیگ باید بیش از صفر باشد).',
  adminPricingConflict:
    '⚠️ همین حالا مدیر دیگری قیمت را تغییر داد؛ این ویرایش بی‌اثر ماند. فهرست تازه را ببینید.',
  adminPricingStale: '🔄 این درخواست ویرایش منقضی یا بی‌اثر شده است.',
  adminPricingFieldGone: '⚠️ این فیلد دیگر در پیکربندی نیست؛ فهرست تازه را ببینید.',
  adminPricingUnavailable: '⚠️ پیکربندی قیمت‌ها معتبر نیست؛ اصلاح مستقیم در دیتابیس لازم است.',
  adminPricingCancelled: '↩️ ویرایش قیمت لغو شد.',
  adminPricingHint: 'عدد را تایپ کنید یا روی فیلدی بزنید.',

  announceIntro: '📢 متن اطلاعیه را بفرستید (حداکثر ۲۰۰۰ نویسه).',
  announceTooLong: '⚠️ متن اطلاعیه بیش از حد مجاز است؛ کوتاه‌تری بفرستید.',
  announceConfirmPrompt: (n: number) =>
    `📩 این اطلاعیه به حدود ${digitsFa(n)} کاربر ارسال شود؟`,
  announceCreated: (id: string) =>
    `📤 اطلاعیه ثبت شد و ارسال آغاز شد.\n🆔 ${id.slice(0, 10)}…`,
  announceProgress: (code: string, sent: number, total: number) =>
    `📊 اطلاعیه ${code} — ارسال‌شده: ${digitsFa(sent)} از ${digitsFa(total)}`,
  announceDone: (code: string, sent: number, failed: number) =>
    `✅ اطلاعیه ${code} کامل شد\nارسال‌شده: ${digitsFa(sent)}${failed > 0 ? ` — ناموفق: ${digitsFa(failed)}` : ''}`,
  announceQueueHeader: '🗂 آخرین اطلاعیه‌ها',
  announceQueueEmpty: 'هنوز اطلاعیه‌ای ارسال نشده است.',
  announceQueueEntry: (id: string, state: string, sent: number, total: number) =>
    `🆔 ${id.slice(0, 10)}… — ${state} — ${digitsFa(sent)}/${digitsFa((total))}`,
  announceStateSending: '⏳ در حال ارسال',
  announceStateDone: '✅ کامل',
  announceStale: '🔄 این اطلاعیه تغییر کرده یا قبلاً کامل ارسال شده است.',
  announceReceived: '📢 اطلاعیه',
  userBlocked: (id: string) => `🎫 تیکت ${id} دیگر فعال نیست؛ ارسال متوقف شد.`,

  // ————— Phase 13: sales stop switch (customer notice + admin surface) —————
  // The switch is a TEMPORARY COMMERCIAL STOP: new purchases and renewals
  // (anything that creates or extends a paid service) are refused with THIS
  // one voice; everything about existing services keeps working.
  salesStoppedNotice:
    '🛑 فعلاً ارائه سرویس متوقفه رفیق 😅\n\nیه کوچولو صبر کن، به‌زودی برمی‌گردیم ❤️\nهر وقت دوباره فعال شد، از همین منو می‌تونی سرویس بگیری.',
  adminSalesStateActive:
    '🛡 وضعیت سرویس: 🟢 فعال\nثبت سفارش خرید و تمدید باز است.',
  adminSalesStateStopped:
    '🛡 وضعیت سرویس: 🔴 متوقف\nثبت سفارش خرید و تمدید موقتاً بسته است؛ سرویس‌های فعال مشتری‌ها دست‌نخورده می‌ماند و سفارش‌های ثبت‌شده قبل از توقف مثل قبل قابل پرداخت و تأییدند.',
  adminSalesUpdated: (v: string) => `آخرین تغییر: ${v}`,
  adminSalesMalformed:
    '⚠️ سند تنظیمات «sales» معتبر نیست؛ فروش فعلاً باز فرض می‌شود. یک بار تغییر وضعیت، سند را اصلاح می‌کند.',
  adminSalesHint:
    'این کلید فروشِ سرویسِ جدید و تمدید را موقتاً می‌بندد (مثلاً وقتی ظرفیت پنل پر است). بقیه‌ی ربات، از جمله سرویس‌های فعال، پشتیبانی و اطلاعیه‌ها، کار می‌کنند.',
  adminSalesStoppedToast: '🛑 فروش سرویس متوقف شد.',
  adminSalesStartedToast: '🟢 فروش سرویس دوباره فعال شد.',
  adminSalesConflict:
    '⚠️ همین حالا مدیر دیگری وضعیت را تغییر داد؛ تازه‌ترین حالت نمایش داده می‌شود.',
  adminSalesSaveFailed: '⚠️ تغییر ذخیره نشد؛ وضعیت فعلی همین‌جا نشان داده می‌شود.',

  // ————— Phase 9: service notifications + subscription-page discovery —————
  // The 8B rule for these two alerts: they open with «درود زیبا»، they are
  // once-per-service by construction, «سلام» never appears, copy is plain
  // text, and NOTHING is promised beyond the panel contract actually holds:
  // exhausted volume -> the panel puts the service in its own
  // «محدود (حجم)» state (never a invented «deletion»); duration renewal does
  // NOT add volume (the Phase 6 decision) — the notice must say so honestly.
  usageNotice: (name: string, percent: string, remainingGb: string) =>
    `درود زیبا، 📊 سرویس «${name}» به ${percent}٪ رسید — حدود ${remainingGb} گیگش باقی مونده.\n\nوقتی حجم تموم بشه، پنل سرویس رو در حالت «محدود (حجم)» می‌ذاره؛ تمدیدِ مدت حجم تازه اضافه نمی‌کند، پس اگه حجم بیشتری لازم داری سرویس تازه بخر یا از پشتیبانی راهنما بگیر.`,
  expiryNotice: (name: string, remaining: string, expiresAt: string) =>
    `درود زیبا، ⏳ سرویس «${name}» تا انقضا فقط ${remaining} فاصله داره — تاریخ انقضا: ${expiresAt}.\n\nهر وقت خواستی از «📦 سرویس‌های من» تمدیدش کن تا سرویست قطع نشه؛ صفحه‌ی اختصاصی سرویست هم از همین‌جا در دسترسه.`,
  serviceNoticeView: '👁 مشاهده سرویس',
  serviceNoticeList: '📦 سرویس‌های من',

  // My Services audit — explicit remaining volume + degraded-usage pointer.
  svcRemaining: (v: string) => `📥 باقی‌مانده حجم: ${v} گیگ`,
  svcUsageHintSnapshot: '🔄 برای دیدن مصرف لحظه‌ای، «بروزرسانی وضعیت» را بزن.',
  // Subscription-page discovery, shown wherever the URL itself is shown.
  svcPageNote:
    '🌐 همین لینک، صفحه‌ی اختصاصی سرویسه — اطلاعات اتصال و وضعیت سرویس همین‌جا هست.',
  svcOpenPage: '🌐 باز کردن صفحه سرویس',

  // ————— Phase 15: the one-time free test (100 MB / 1 day by default) —————
  // The offer targets ONE user who has NEVER claimed (DB claim row). The copy
  // quotes the volume/duration only through the pre-formatted slot strings —
  // numbers in the config can change without a byte of copy moving. Warm
  // opener rule: this is a standalone notice-like bubble → «درود» is allowed
  // on the expiry notice only, never on flow prompts or toasts.
  freeTestOffer: (mb: string, days: string) =>
    `🎁 یه هدیه برای تازه‌واردیا!\n\nسرویسِ تستِ رایگان: ${mb} مگابایت ترافیک، ${days} — فقط یک‌بار برای هر کاربر، کاملاً مجانی.\n\nاگه می‌خوای امتحانش کنی، دکمه‌ی زیر رو بزن 👇`,
  freeTestCta: (mb: string, days: string) =>
    `🎁 هنوز تستِ رایگان نگرفتی؟ ${mb} مگابایت، ${days} — یک‌بار، مجانی. با دکمه‌ی زیر فعالش کن.`,
  freeTestBtnClaim: '🎁 فعال کردن تست رایگان',
  freeTestQueuedToast: '🎁 تستت داره آماده می‌شه…',
  freeTestCreated: (orderId: string) =>
    `🎁 درخواستِ تستِ رایگان ثبت شد!\nشناسه سفارش: ${orderId}\n\nبه‌محض آماده شدن، لینک اتصالش برات میاد؛ از «📦 سرویس‌های من» دنبالشی کن.`,
  freeTestAlready:
    '🎁 هر نفر فقط یک تستِ رایگان داره (همیشه) — سهم خودت مصرف شده.\n\nبرای ادامه می‌تونی از «🛒 خرید سرویس» یه سرویس اصلی بگیری؛ جزئیات همون تست پایین در دسترسه.',
  freeTestWait:
    '⏳ درخواستِ تستِ رایگان‌ت ثبت شده و هنوز نهایی نشده؛ کمی دیگه صبر کن و از «📦 سرویس‌های من» چکش کن.',
  freeTestUnavailable:
    '🙏 فعلاً امکان فعال‌سازی تستِ رایگان نیست؛ بعداً دوباره امتحان کن.',
  renewNotForFreeTest:
    '🎁 سرویسِ تستِ رایگان قابل تمدید نیست؛ وقتی تموم شد از «🛒 خرید سرویس» یک سرویس اصلی بگیر.',
  // Volume lines for sub-GB (test-class) services — unit-honest display.
  summaryVolumeMb: (mb: number) => `📦 حجم: ${mb} مگابایت`,
  svcUsageMb: (used: string, total: string) => `📊 مصرف ترافیک: ${used} از ${total} مگابایت`,
  svcRemainingMb: (v: string) => `📥 باقی‌مانده حجم: ${v} مگابایت`,
  // The dedicated free-test expiry notice (once-only, ~2h before the end —
  // the PAID 3-day usage/expiry set is never sent for a test service).
  freeTestExpiryNotice: (name: string, remaining: string, expiresAt: string) =>
    `درود زیبا، ⏳ تستِ رایگانِ «${name}» فقط ${remaining} دیگه وقت داره — پایان: ${expiresAt}.\n\n🎁 این تست یک‌باره و قابل تمدید نیست؛ اگه راضی بودی، از «🛒 خرید سرویس» سرویس اصلی‌ات رو بردار ❤️`,

  // ————— Phase 10: i18n — keyboard labels, the Account row, the selector —————
  // Main-menu labels moved here VERBATIM from menu.ts so the (en) bundle can
  // mirror them; the strings themselves are byte-frozen Phase 8A labels.
  menuBuy: '🛒 خرید سرویس',
  menuServices: '📦 سرویس‌های من',
  menuOrders: '💳 سفارش‌های من',
  menuAccount: '👤 حساب کاربری',
  menuWallet: '💰 کیف پول',
  menuInvite: '🤝 دعوت از دوستان',
  menuSupport: '🆘 پشتیبانی',
  menuTicket: '🎫 ثبت تیکت',
  // The selector button is deliberately BILINGUAL and locale-fixed: its label
  // is identical in both bundles and survives a switch at any moment.
  menuLanguage: '🌐 زبان / Language',
  langOptionFa: '🇮🇷 فارسی',
  langOptionEn: '🇬🇧 English',
  // Mid-flow keyboard controls (the composing-mode extras + inline cancel).
  btnAutoPick: '🎲 انتخاب خودکار',
  btnSkipReject: '❌ ثبت رد بدون دلیل',
  btnCancelInline: '❌ لغو',
  btnRenewService: '🔁 تمدید سرویس',
  btnRefreshStatus: '🔄 بروزرسانی وضعیت',
  // Language picker + confirmation (each bundle names ITS OWN language —
  // the confirmation is sent in the newly selected language).
  languageIntro:
    '🌐 زبان ربات را انتخاب کنید.\n\nهر زمان خواستید می‌توانید این انتخاب را تغییر دهید.',
  languageSet:
    '✅ زبان ربات به فارسی تنظیم شد.\n\nمنوی جدید در همین پیام جایگزین شده است.',
  accountBotLanguage: (v: string) => `زبان ربات: ${v}`,
  accountLanguageFa: 'فارسی',
  accountLanguageEn: 'انگلیسی',
  // Proactive-notice fallback when a service row carries no config name.
  noticeServiceFallback: 'سرویس شما',

  // ————— Phase 11: connection guide — stateless, customer-facing screens —————
  // Store/platform/app names and the four link-button labels are deliberately
  // locale-FIXED (precedent: menuLanguage) — they are brand text. Body copy
  // follows the Phase 8B persona rules: no forced greeting in a how-to.
  menuGuide: '📚 راهنمای اتصال',
  guideIntro:
    '📚 راهنمای اتصال\n\nوصل شدن بیشتر از سه قدم کوتاه نیست:\n\n۱) لینک اشتراکت را از «📦 سرویس‌های من» کپی کن\n۲) اپِ مناسب دستگاهت را نصب کن\n۳) لینک را در اپ import (وارد) کن و متصل شو\n\nاول بگو با چه دستگاهی می‌خواهی وصل شوی 👇',
  guidePlatformAndroid:
    '🤖 اتصال با اندروید\n\nیکی از این اپ‌ها را انتخاب کن؛ هر سه با لینک اشتراکِ ربات کار می‌کنند و راهنمای اتصالِ قدم‌به‌قدم دارند. برای بیشتر گوشی‌ها v2RayTun ساده‌تر است.',
  guidePlatformIos:
    '🍎 اتصال با آیفون (iOS)\n\nیکی از این دو اپ را از App Store نصب کن؛ هر دو لینک اشتراک را وارد (import) می‌کنند. V2Box انتخاب ساده‌تر است.',
  guidePlatformWindows:
    '🪟 اتصال با ویندوز\n\nبرای ویندوز از Throne استفاده کن — رایگان و متن‌باز؛ لینک اشتراک را مستقیم از صفحهٔ رسمی Releases می‌گیرد.',
  guideHowToApp: (app: string) => `📖 راهنمای اتصال — ${app}`,
  guideBtnPlay: '📥 Google Play',
  guideBtnStore: '🍏 App Store',
  guideBtnReleases: '⬇️ Releases',
  guideBtnGithub: '📦 GitHub',
  guideOtherApps: '↩️ انتخاب اپ دیگر',
  guideStepsTun: `📚 v2RayTun — اتصال در یک دقیقه

۱. لینک اشتراکت را بردار: «📦 سرویس‌های من» → سرویس موردنظر → روی «لینک اشتراک» بزن تا کپی شود.
۲. با دکمهٔ «📥 Google Play» پایین، اپ را نصب کن.
۳. v2RayTun را باز کن، روی + بزن و «افزودن از کلیپ‌بورد» (import from clipboard) را انتخاب کن؛ چسباندن مستقیم لینک یا اسکن QR هم کار می‌کند.
۴. برای پروفایل یک نام بگذار (مثلاً «سرویس من») و تأییدش کن.
۵. پروفایل را انتخاب کن و دکمهٔ اتصال را بزن؛ وقتی اندروید برای برقراری VPN اجازه خواست، Allow را بزن.

وقتی شمارندهٔ ترافیک راه افتاد، متصلی. بقیهٔ تنظیمات را دست نزن — لینکت همه‌چیز را از قبل آماده دارد.`,
  guideStepsNg: `📚 v2rayNG — اتصال در یک دقیقه

۱. لینک اشتراکت را بردار: «📦 سرویس‌های من» → سرویس موردنظر → روی «لینک اشتراک» بزن تا کپی شود.
۲. این اپ در گوگل‌پلی نیست؛ مسیر رسمی همان گیت‌هاب است: با دکمهٔ «⬇️ Releases» پایین، فایل apk آخرین نسخه را بگیر و نصب کن. اگر اندروید هنگام نصب هشدار امنیت داد، مراحل روی صفحه را دنبال کن و مطمئن شو که نسخهٔ منتشرشده را از همان صفحهٔ رسمی Releases در گیت‌هاب 2dust/v2rayNG نصب می‌کنی.
۳. وارد v2rayNG شو → منو (☰) → «Add subscription over URL».
۴. لینک را بچسبان، برای گروه یک نام بگذار و تأیید کن تا سرورها بیایند.
۵. یک سرور انتخاب کن و دکمهٔ ▶ اتصال را بزن؛ درخواست VPN اندروید را Allow کن.

تنظیمات پیش‌فرض را نگه دار — به‌جز این پنج قدم، کاری نداری.`,
  guideStepsIncy: `📚 incy — اتصال در یک دقیقه

۱. لینک اشتراکت را بردار: «📦 سرویس‌های من» → سرویس موردنظر → روی «لینک اشتراک» بزن تا کپی شود.
۲. با دکمهٔ «📥 Google Play» پایین، اپ را نصب کن.
۳. incy را باز کن؛ گزینهٔ افزودن کانفیگ را بزن و «وارد کردن با لینک» (import from link) را انتخاب کن، لینک را بچسبان — اسکن QR هم کار می‌کند.
۴. اگر اپ نام خواست، برایش یک نام بگذار (مثلاً «سرویس من») و تأییدش کن.
۵. کانفیگ را انتخاب کن و دکمهٔ اتصال را بزن؛ وقتی اندروید برای برقراری VPN اجازه خواست، Allow را بزن.

وقتی شمارندهٔ ترافیک راه افتاد، متصلی. بقیهٔ تنظیمات را دست نزن — لینکت همه‌چیز را از قبل آماده دارد.`,
  guideStepsV2box: `📚 V2Box — اتصال در یک دقیقه

۱. روی آیفون لینک اشتراکت را بردار: «📦 سرویس‌های من» → سرویس موردنظر → روی «لینک اشتراک» بزن تا کپی شود.
۲. با دکمهٔ «🍏 App Store» پایین V2Box را نصب کن.
۳. + (بالا راست) → Subscribe → «Paste from clipboard» → یک نام بگذار و ذخیره کن.
۴. پروفایل تازه را انتخاب کن و کلید بالای صفحه را روشن کن.
۵. وقتی iOS برای افزودن پیکربندی VPN اجازه خواست، Allow را بزن — تنها همان یک بار.

سبز شدن وضعیت یعنی اتصال برقرار است.`,
  guideStepsStreisand: `📚 Streisand — اتصال در یک دقیقه

۱. روی آیفون لینک اشتراکت را بردار: «📦 سرویس‌های من» → سرویس موردنظر → روی «لینک اشتراک» بزن تا کپی شود.
۲. با دکمهٔ «🍏 App Store» پایین Streisand را نصب کن.
۳. به بخش Configs (آیکون فهرست) برو → + → Subscription.
۴. لینک را بچسبان، با همان نام پیشنهادی ذخیره‌اش کن.
۵. کانفیگ تازه را به‌عنوان پروفایل فعال انتخاب کن، کلید اصلی را روشن کن و درخواست VPN را Allow کن.

رفت‌وشد ترافیک در نوار وضعیت یعنی آنلاین شدی.`,
  guideStepsThrone: `📚 Throne — اتصال در یک دقیقه

۱. لینک اشتراکت را بردار: «📦 سرویس‌های من» → سرویس موردنظر → روی «لینک اشتراک» بزن تا کپی شود (در تلگرام دسکتاپ روی لینک راست‌کلیک و Copy).
۲. با دکمهٔ «⬇️ Releases» پایین آخرین نسخه را بگیر — فایل نصبی؛ اگر نمی‌خواهی چیزی نصب شود، همان ZIP پرتابل کار می‌کند.
۳. اگر ویندوز هنگام اجرا پیام SmartScreen داد، پیش از ادامه مطمئن شو که Throne را از همان صفحهٔ رسمی Releases دانلود کرده‌ای.
۴. Throne را باز کن؛ برای افزودن پروفایل، نوع اشتراک/لینک را انتخاب کن و لینک را بچسبان.
۵. سرور را انتخاب کن و اتصال را بزن؛ همان حالت پروکسی پیش‌فرض را نگه دار.

سبز شدن وضعیت داخل اپ یعنی ترافیک سیستم از مسیر امن می‌رود.`,

  // ————— Phase 10: label mappers that used to live as switches in handlers —————
  // Moved byte-for-byte (payments.ts `statusFa`, services.ts `panelStatusFa`,
  // wallet.ts `entryLabel`) so both bundles own their own strings.
  orderStatus(state: string): string {
    switch (state) {
      case 'pending_payment':
        return fa.statusPendingPayment;
      case 'awaiting_review':
        return fa.statusAwaitingReview;
      case 'approved':
        return fa.statusApproved;
      case 'provisioning':
        return fa.statusProvisioning;
      case 'completed':
        return fa.statusCompleted;
      case 'rejected':
        return fa.statusRejected;
      case 'failed':
        return fa.statusFailed;
      case 'cancelled':
        return fa.statusCancelled;
      default:
        return state;
    }
  },
  panelStatus(status: string): string {
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
  },
  walletKind(kind: string): string {
    switch (kind) {
      case 'referral_reward':
        return fa.walletKindReferralReward;
      case 'admin_grant':
        return fa.walletKindAdminGrant;
      case 'admin_debit':
        return fa.walletKindAdminDebit;
      case 'order_payment':
        return fa.walletKindOrderPayment;
      case 'order_refund':
        return fa.walletKindOrderRefund;
      default:
        return kind.slice(0, 24);
    }
  },
  // Phase 8B display-only reactions, absorbed into the bundle unchanged.
  reactionDevices: deviceReaction,
  reactionVolume: volumeReaction,
} as const;

/** The structural contract every language bundle must satisfy (Phase 10):
 *  same key set, string leaves widened from fa's `as const`, function shapes
 *  preserved exactly — a missing or mismatched English key is a compile error. */
export type Texts = {
  [K in keyof typeof fa]: [typeof fa[K]] extends [string] ? string : typeof fa[K];
};

/** Format integer money with Persian thousands + currency word. */
export function formatPrice(amount: number, currency: string): string {
  const word = currency === 'IRT' ? 'تومان' : currency === 'IRR' ? 'ریال' : currency;
  return `${amount.toLocaleString('fa-IR')} ${word}`;
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** ASCII digits → Persian (display only; storage/wire stay ASCII). */
export function digitsFa(value: number | string): string {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)] ?? d);
}

/** Duration display: whole months read as «X ماه», everything else keeps days. */
export function durationLabelFa(days: number, daysPerMonth = 30): string {
  const months = daysPerMonth > 0 ? days / daysPerMonth : NaN;
  if (Number.isSafeInteger(months) && months >= 1) {
    return `${digitsFa(months)} ماه`;
  }
  return `${digitsFa(days)} روز`;
}

/* ———— Phase 8B: display-only personality reactions ————
 * These NEVER validate or gate anything: business acceptance stays entirely
 * in the catalog `accept*` guards. A reaction only rides along on the NEXT
 * already-sent bubble (one line, no extra message, never consecutive).
 */

/** Generosity threshold for the volume wink. Display-only, not a rule. */
export const GENEROUS_VOLUME_GB = 20;

/** Device/user-count reaction; `null` = plain, unremarkable confirmation. */
export function deviceReaction(count: number): string | null {
  if (count <= 1) return null;
  if (count === 2) return 'دمت گرم، تک‌خور نیستی 😄 دوکاربره انتخاب کردی';
  if (count === 3) return 'ایول، سه‌کاربره انتخاب کردی 😄';
  return `${digitsFa(count)} کاربره انتخاب کردی، چه تیم پرجمعیتی 😄`;
}

/** Volume reaction: only above the generosity threshold, never less. */
export function volumeReaction(gb: number): string | null {
  return gb > GENEROUS_VOLUME_GB ? 'عووو چه دست‌ودلباز، خوشمان آمد 😄' : null;
}

