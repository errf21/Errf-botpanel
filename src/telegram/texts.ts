/**
 * All user-facing bot text in one place (Persian-first).
 * Keys are stable; wording gets polished in Phase 8.
 * NOTE: prices/payment copy arrive Phase 3/4 — never here.
 */
export const fa = {
  notConfigured:
    '⚠️ ربات هنوز به‌طور کامل پیکربندی نشده است.',

  welcomeHeader: '👋 درود',
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
    '/failed — (مدیران) سفارش‌های ناموفقِ راه‌اندازی/تمدید',
    '/tickets — (مدیران) تیکت‌های باز پشتیبانی',
    '/announce — (مدیران) ارسال اطلاعیه برای همه کاربران',
    '/announcements — (مدیران) وضعیت اطلاعیه‌های اخیر',
    '',
    '📦 در «سرویس‌های من» می‌توانید وضعیت و انقضای سرویس‌ها را ببینید و آن‌ها را تمدید کنید.',
    'برای شروع، دکمه‌های زیر را بزنید.',
  ].join('\n'),

  // Buy flow (Phase 2 proves the machine; product steps arrive Phase 3)
  buyIntro: [
    '🛒 خرید سرویس',
    '',
    'برای شروع، یک نام برای کانفیگ خود انتخاب کنید.',
    'نام باید انگلیسی، حداقل سه کلمه (حروف لاتین، جدا با فاصله) و حداکثر ۶۴ نویسه باشد.',
    'هر وقت خواستید با «بازگشت به منو» یا /cancel خارج شوید.',
  ].join('\n'),
  buyWaitingConfigName:
    'زیبا لطفا یه نام انگلیسی حداقل سه کلمه‌ای انتخاب کن یا اگر میخوای من برات رندوم انتخاب کنم',
  configNameInvalid:
    '❌ نام کانفیگ نامعتبر است؛ باید انگلیسی و حداقل سه کلمه باشد (مثل: Silver Falcon Network).\nدوباره تلاش کنید یا «انتخاب خودکار» را بزنید.',
  configNameSaved: (name: string) =>
    `✅ نام کانفیگ «${name}» ثبت شد.`,
  buyInProgress: '🛒 فرآیند خرید جاری را ادامه دهید یا برای لغو «بازگشت به منو» را بزنید.',

  // Sections not yet implemented
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
  durationPrompt: (min: number, max: number, allowCustom = true) =>
    `⏳ مدت سرویس را انتخاب کنید.\n\n${durationLabelFa(min)} تا ${durationLabelFa(max)}.` +
    (allowCustom ? '\nبرای مقدار دلخواه، عدد روز را تایپ کنید.' : ''),
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
  provisionNameRejectedNotice: (id: string) =>
    `⚠️ متأسفانه پنل، نامِ سرویسِ این سفارش را نپذیرفت.\n\n🆔 سفارش: ${id}\n\n پرداخت شما کاملاً محفوظ است و هیچ مبلغی دوباره کسر نمی‌شود. تیم ما به‌زودی با نامی تازه تلاش می‌کند؛ اگر عجله دارید می‌توانید سفارشی نو با «انتخاب خودکار» یا یک نام انگلیسی سه‌کلمه‌ای دیگر شروع کنید.`,
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
  servicesEmpty: 'هنوز سرویس فعالی ندارید.\nاز منوی «🛒 خرید سرویس» شروع کنید.',
  serviceStatusActive: '🟢 فعال',
  serviceStatusExpiring: '⏳ رو به اتمام',
  serviceStatusExpired: '‼️ منقضی‌شده',
  serviceStatusUnknown: '⚪ نامشخص',
  servicesEntry: (n: number, shortId: string, status: string, expires: string) =>
    `${n}. 🆔 ${shortId} — ${status}\n   انقضا: ${expires}`,
  serviceNotFound: '🚫 سرویسی با این شناسه ندارید یا در دسترس نیست.',
  serviceBusyFirst: '🛑 ابتدا فرآیند فعلی را کامل کنید یا /cancel بفرستید.',

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
  svcSnapshotNote: '🖥 پنل در دسترس نبود؛ اطلاعات از آخرین وضعیت محلی نمایش داده می‌شود.',
  svcLiveNote: '🖥 وضعیت لحظه‌ای از پنل',

  renewDisabledNotice: '🔧 امکان تمدید فعلاً غیرفعال است.',
  renewInProgressNotice: (id: string) =>
    `🔁 یک درخواست تمدید برای این سرویس باز است.\n\n🆔 سفارش تمدید: ${id}\n\nوضعیت آن را از «💳 سفارش‌های من» پیگیری کنید.`,
  renewIntro: (name: string, expires: string) =>
    `🔁 تمدید سرویس «${name}»\n\n📅 انقضای فعلی: ${expires}\n\nبرای تمدید، مدت را انتخاب کنید.\nقیمت هر ماه تمدید جداگانه محاسبه می‌شود و پرداخت مانند خرید، با فیش و تأیید دستی است.`,
  renewDurationPrompt: '⏳ مدت تمدید را انتخاب کنید:\n\n۱ ماه • ۲ ماه • ۳ ماه',
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
    `⚠️ تمدید سرویسِ سفارش پیش از حد مجاز به مشکل خورد.\n\n🆔 سفارش: ${id}\n\nمسئولان در جریان قرار گرفتند و موضوع پیگیری می‌شود؛ نیازی به پرداخت مجدد نیست.`,
  adminRenewalFailed: (id: string, reason: string) =>
    `⚠️ تمدید سرویس ناموفق بود\n🆔 ${id}\n📝 ${reason.slice(0, 200)}\n\nبا دکمه‌ی زیر می‌توانید دوباره تلاش کنید (تا سقف مجاز).`,
  adminRenewalKind: (serviceId: string) => `🔄 تمدید سرویس ${serviceId}`,
  notifyApprovedRenewal: (id: string, amount: string) =>
    `🎉 پرداخت تمدید شما تأیید شد!\n\n🆔 سفارش: ${id}\n💰 مبلغ: ${amount}\n\nتمدید به‌زودی روی سرویس اعمال می‌شود.`,
  ordersKindRenewal: '(تمدید)',

  // ————— Phase 7: wallet + referrals + support + announcements (IRT/Toman) —————
  walletUnavailable: '🔧 کیف پول فعلاً در دسترس نیست. کمی بعد دوباره امتحان کنید.',
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

  supportIntro: [
    '🆘 پشتیبانی',
    '',
    'مشکل یا پرسش خود را در یک پیام بنویسید و بفرستید.',
    'پاسخ کارشناس معمولاً در همین گفتگو برایتان ارسال می‌شود.',
    'برای بازگشت، «بازگشت به منو» یا /cancel.',
  ].join('\n'),
  supportTicketCreated: (id: string) =>
    `📨 درخواست شما ثبت شد.\n\n🎫 کد تیکت: ${id}\n\nبه‌محض پاسخ، در همین گفتگو متوجه خواهید شد.`,
  supportTicketExists: (id: string) =>
    `🎫 تیکت بازِ شما (${id.slice(0, 10)}…) هنوز فعال است.`,
  supportQueueChoice: '✍️ متن پیام جدید را بفرستید تا برای کارشناس ارسال شود.',
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
  supportBusyFirst: '🛑 ابتدا فرآیند فعلی را کامل کنید یا /cancel بفرستید.',
  ticketNotFound: '🚫 تیکتی با این شناسه پیدا نشد.',

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
} as const;

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

