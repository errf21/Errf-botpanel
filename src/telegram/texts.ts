/**
 * All user-facing bot text in one place (Persian-first).
 * Keys are stable; wording gets polished in Phase 8.
 * NOTE: prices/payment copy arrive Phase 3/4 — never here.
 */
export const fa = {
  notConfigured:
    '⚠️ ربات هنوز به‌طور کامل پیکربندی نشده است.',

  welcomeHeader: '👋 سلام',
  welcomeIntro: 'ربات فروش سرویس VPN. از منوی زیر گزینه‌ی مورد نظرتان را انتخاب کنید.',
  menuPrompt: '👇 منوی اصلی',

  cmdUnknown: '❓ دستور ناشناخته.\nاز دکمه‌های منو استفاده کنید یا /help را بزنید.',
  helpText: [
    '🤖 راهنما',
    '',
    '/start — نمایش منوی اصلی',
    '/cancel — بازگشت به منو و لغو عملیات جاری',
    '/help — همین پیام',
    '/pending — (مدیران) فیش‌های در انتظار بررسی',
    '/failed — (مدیران) سفارش‌های ناموفقِ راه‌اندازی',
    '',
    'برای شروع، دکمه‌های زیر را بزنید.',
  ].join('\n'),

  // Buy flow (Phase 2 proves the machine; product steps arrive Phase 3)
  buyIntro: [
    '🛒 خرید سرویس',
    '',
    'برای شروع، یک نام برای کانفیگ خود انتخاب کنید.',
    'نام باید ۱ تا ۶۴ نویسه باشد (بدون کاراکترهای کنترلی).',
    'هر وقت خواستید با «بازگشت به منو» یا /cancel خارج شوید.',
  ].join('\n'),
  buyWaitingConfigName: '⌨️ لطفاً نام کانفیگ را در همین چت ارسال کنید.',
  configNameInvalid:
    '❌ نام کانفیگ نامعتبر است (۱ تا ۶۴ نویسه، بدون کاراکترهای کنترلی).\nدوباره تلاش کنید یا «بازگشت به منو» را بزنید.',
  configNameSaved: (name: string) =>
    `✅ نام کانفیگ «${name}» ثبت شد.`,
  buyInProgress: '🛒 فرآیند خرید جاری را ادامه دهید یا برای لغو «بازگشت به منو» را بزنید.',

  // Sections not yet implemented
  comingSoonServices: '📦 بخش «سرویس‌های من» در فاز ۶ اضافه می‌شود.',
  comingSoonSupport: '🆘 بخش «پشتیبانی» در فاز ۷ اضافه می‌شود.',

  accountHeader: '👤 اطلاعات حساب شما',
  accountUsername: (v: string) => `نام کاربری: ${v}`,
  accountNone: '—',
  accountLanguage: (v: string) => `زبان تلگرام: ${v}`,
  accountSince: (v: string) => `تاریخ عضویت: ${v}`,
  accountStatusIdle: 'وضعیت: آماده ✅',
  accountStatusBusy: 'وضعیت: در میانه‌ی یک فرآیند (با /cancel قابل لغو است)',

  cancelled: '↩️ به منوی اصلی بازگشتید.',
  sessionExpired: '⏱️ نشست قبلی منقضی شده بود؛ با منوی اصلی ادامه می‌دهیم.',

  invalidChoice: '❌ گزینه نامعتبر.',
  backToMenu: '🔙 بازگشت به منو',
  idleInputHint: 'برای شروع یک گزینه از منو را انتخاب کنید.',

  // ————— Phase 3: purchase options, summary, confirmation —————
  catalogUnavailable:
    '🔧 فعلاً امکان انتخاب گزینه‌ها وجود ندارد. کمی بعد دوباره امتحان کنید.',
  volumePrompt: (min: number, max: number) =>
    `📦 حجم سرویس را انتخاب کنید.\n\nحداقل ${min} و حداکثر ${max} گیگابایت.\nبرای مقدار دلخواه، عدد را تایپ کنید (یا دکمه‌ی «دلخواه»).`,
  durationPrompt: (min: number, max: number) =>
    `⏳ مدت سرویس را انتخاب کنید.\n\nبین ${min} تا ${max} روز.\nبرای مقدار دلخواه، عدد روز را تایپ کنید.`,
  devicePrompt: (min: number, max: number) =>
    `📱 تعداد دستگاه‌های مجاز:\n\nبین ${min} تا ${max}.\nبرای مقدار دلخواه، عدد را تایپ کنید.`,
  customVolumeLabel: '✍️ مقدار دلخواه',
  customHint: '✍️ حالا عدد دلخواه را همین‌جا تایپ کن و بفرست.',
  rejectedRange: (min: number, max: number) =>
    `⚠️ عدد باید بین ${min} تا ${max} باشد. دوباره تلاش کنید یا «بازگشت» را بزنید.`,
  rejectedPresetDisabled: '⚠️ این گزینه فعلاً غیرفعال است؛ یکی دیگر را انتخاب کنید.',
  rejectedNotWhole: '⚠️ لطفاً فقط یک عدد صحیح بفرستید.',
  staleChoice: '🔄 این گزینه مربوط به مرحله‌ی دیگری است. مرحله‌ی فعلی را ادامه دهید.',
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
  summaryHint: 'اگر همه‌چیز درست است «تأیید» را بزنید. برای ویرایش، «بازگشت».',

  orderCreated: (id: string) =>
    `✅ سفارش شما ثبت شد!\n\n🆔 کد: ${id}\n\n👇 اطلاعات واریز در پیام بعدی ارسال می‌شود.`,
  orderConfirmToast: '✅ سفارش ثبت شد.',
  alreadyConfirmed: '✅ این سفارش قبلاً ثبت شده است.',

  paymentWaitNotice:
    '⏳ فیش پرداخت شما در انتظار بررسی است.\n\n💡 اگر فیش اشتباه است، تصویر/فایل جدیدی بفرستید تا جایگزین شود.\nبرای پیگیری، وضعیت را در «💳 سفارش‌های من» ببینید.',

  missingDraftData: '⚠️ اطلاعات سفارش کامل نیست. از ابتدا شروع کنید.',

  // ————— Phase 4: payment, receipts, admin review —————
  paymentInstructionsHeader: '💳 اطلاعات واریز وجه',
  paymentHolder: (v: string) => `👤 به نام: ${v}`,
  paymentCard: (v: string) => `🏦 شماره کارت: ${v}`,
  paymentIban: (v: string) => `IBAN: ${v}`,
  paymentAmountLine: (v: string) => `💰 مبلغ قابل واریز: ${v}`,
  paymentReceiptPrompt:
    '🧾 پس از واریز، تصویر یا فایل فیش پرداخت را در همین گفتگو بفرستید.\n\nتوجه: بررسی فیش به‌صورت دستی انجام می‌شود و ممکن است کمی زمان ببرد.',
  paymentInfoUnavailable:
    '⚠️ اطلاعات واریز فعلاً در دسترس نیست. برای ادامه با پشتیبانی در ارتباط باشید.',

  receiptAccepted:
    '✅ فیش پرداخت ثبت شد و برای بررسی ارسال گردید.\nنتیجه معمولاً تا چند ساعت اعلام می‌شود؛ وضعیت را از «💳 سفارش‌های من» پیگیری کنید.',
  receiptReplaced: '✅ فیش جدید جایگزین شد و دوباره برای بررسی ارسال گردید.',
  receiptExpectedMedia: '🧾 لطفاً فیش را به‌صورت تصویر یا فایل (برگردان فیش) ارسال کنید؛ متن به‌تنهایی فیش محسوب نمی‌شود.',
  receiptOrderMissing: '⚠️ سفارش مرتبط با این گفتگو پیدا نشد. از منوی خرید شروع مجدد کنید.',
  receiptOrderNotPayable: '⚠️ این سفارش دیگر در مرحله‌ی ارسال فیش نیست. وضعیت آن را از «💳 سفارش‌های من» ببینید.',

  statusPendingPayment: '⏳ در انتظار پرداخت',
  statusAwaitingReview: '🔎 در انتظار بررسی فیش',
  statusApproved: '✅ تأییدشده — در انتظار راه‌اندازی',
  statusProvisioning: '⚙️ در حال راه‌اندازی سرویس',
  statusCompleted: '🟢 سرویس فعال شد',
  statusRejected: '❌ رد شده',
  statusFailed: '⚠️ ناموفق',
  statusCancelled: '🚫 لغو شده',

  ordersHeader: '🧾 سفارش‌های شما (جدیدترین‌ها)',
  ordersEmpty: 'هنوز سفارشی ثبت نکرده‌اید.\nاز منوی «🛒 خرید سرویس» شروع کنید.',
  ordersEntry: (n: number, shortId: string, status: string, price: string, date: string) =>
    `${n}. 🆔 ${shortId} — ${status}\n   ${price} — ${date}`,

  notifyApproved: (id: string, amount: string) =>
    `🎉 پرداخت شما تأیید شد!\n\n🆔 سفارش: ${id}\n💰 مبلغ: ${amount}\n\nسرویس شما به‌زودی ساخته می‌شود و اطلاعات اتصال ارسال خواهد شد.`,
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
  serviceReady: (id: string, url: string) =>
    `🎉 سرویس شما ساخته و فعال شد!\n\n🆔 سفارش: ${id}\n🔗 لینک اشتراک:\n${url}\n\nاین لینک را در اپلیکیشن خود (v2rayNG / Nekobox / Streisand و…) وارد کنید.`,
  serviceReadyWithoutLink: (id: string) =>
    `🎉 سرویس شما ساخته شد.\n\n🆔 سفارش: ${id}\n\nلینک اتصال فعلاً قابل دریافت نیست؛ به‌زودی از بخش «سرویس‌های من» در دسترس خواهد بود. در صورت عجله با پشتیبانی در ارتباط باشید.`,
  provisionFailedNotice: (id: string) =>
    `⚠️ ساخت سرویسِ سفارش پیش از حد مجاز به مشکل خورد.\n\n🆔 سفارش: ${id}\n\nمسئولان در جریان قرار گرفتند و موضوع پیگیری می‌شود؛ نیازی به پرداخت مجدد نیست.`,
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
} as const;

/** Format integer money with Persian thousands + currency word. */
export function formatPrice(amount: number, currency: string): string {
  const word = currency === 'IRT' ? 'تومان' : currency === 'IRR' ? 'ریال' : currency;
  return `${amount.toLocaleString('fa-IR')} ${word}`;
}

