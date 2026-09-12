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
    `✅ نام کانفیگ «${name}» ثبت شد.\nانتخاب حجم/مدت/دستگاه در فاز بعد فعال می‌شود.`,
  buyInProgress: '🛒 فرآیند خرید جاری را ادامه دهید یا برای لغو «بازگشت به منو» را بزنید.',
  buyFlowSoon:
    '⏳ ادامه‌ی فرآیند خرید در فاز بعدی فعال می‌شود. فعلاً می‌توانید با «بازگشت به منو» خارج شوید.',

  // Sections not yet implemented
  comingSoonServices: '📦 بخش «سرویس‌های من» در فاز ۶ اضافه می‌شود.',
  comingSoonOrders: '💳 بخش «سفارش‌های من» در فاز ۴ اضافه می‌شود.',
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
    `✅ سفارش شما ثبت شد!\n\n🆔 کد: ${id}\n\nاطلاعات کارت و ارسال فیش پرداخت در گام بعدی فعال می‌شود.`,
  orderConfirmToast: '✅ سفارش ثبت شد.',
  alreadyConfirmed: '✅ این سفارش قبلاً ثبت شده است.',

  paymentWaitNotice:
    '⏳ سفارش شما ثبت شده و در انتظار پرداخت است. لینک ارسال فیش در فاز بعد فعال می‌شود.',

  missingDraftData: '⚠️ اطلاعات سفارش کامل نیست. از ابتدا شروع کنید.',
} as const;

/** Format integer money with Persian thousands + currency word. */
export function formatPrice(amount: number, currency: string): string {
  const word = currency === 'IRT' ? 'تومان' : currency === 'IRR' ? 'ریال' : currency;
  return `${amount.toLocaleString('fa-IR')} ${word}`;
}

