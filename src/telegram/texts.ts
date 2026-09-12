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
} as const;
