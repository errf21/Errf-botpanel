# معماری و نقشهٔ کد — فارسی

[🇬🇧 English](../en/architecture.md) · 🇮🇷 **فارسی** · [فهرست](README.md)

**سازنده / Creator:** [Espierz](https://t.me/Espierz) · تلگرام / Telegram: [@Espierz](https://t.me/Espierz)

---

## ۱. اجزا

```
کاربر / ادمین تلگرام
        │  (وب‌هوک HTTPS — به‌جای long-poll؛ JSON آپدیت)
        ▼
Cloudflare Worker   ── ورودی: src/index.ts (fetch + scheduled)
   routes/ ── webhook.ts (دروازهٔ احراز)  health.ts (زنده‌مانی)
   dispatch.ts ── dedupe → ثبت کاربر → تشخیص ادمین و زبان → مسیریابی
   handlers/* ── همهٔ جریان‌ها (خرید، پرداخت، سرویس‌ها، تمدید، کیف پول، تیکت،
                 اطلاعیه، یادآور، اعلان، قیمت، فروش، زبان، راهنما)
   state/machine.ts ── ماشین حالت گفتگوی «خالص» (بدون I/O و زمان)
   catalog/* ── لود+اعتبارسنجی اسناد تنظیمات (fail-closed /افتِ ایمن)
   orders/checkout ── تنها مسیری که پیش‌نویس قیمت‌گذاری‌شده را سفارش پایدار می‌کند
   db/* ── هر SQL: تک‌استیتممنت مراقبت‌شده، batch، CAS، audit فقط-افزودنی
   pasarguard/client ── REST تایپ‌شده (x-api-key، تایم‌اوت ۱۵ ثانیه، نوع خطا)
   provision/* ── تنها ارکستراتور ساخت/تمدید سرویس روی پنل
        │                     │
        ▼                     ▼
  Cloudflare D1         پنل PasarGuard
  (telbot-db): یگانه    (HTTPS با x-api-key): ساخت /
  منبع حقیقت — سفارش،   خواندن / تمدید سرویس +
  دفتر کل، audit،       لینک سابسکریپشن؛ فقط از
  اسناد settings        طریق provision/*
```

مرزهای مسئولیتی که کد به‌سختت نگه می‌دارد:

- **هندلرها** UX را می‌سازند، اما هر تصمیم مهم (مجوز، قیمت، اعتبارسنجی، ادعای
  حالت) بارِ دوم در همان request در سمت سرور دوباره بررسی می‌شود (`ctx.isAdmin`,
  `ctx.ui`، بازاعتبارسنجی کاتالوگ — مقدار دکمه‌ها هرگز باور نمی‌شود).
- **`db/*`** تنها محل SQL؛ **`catalog/*`** تنها محل خواندن اسناد تنظیمات؛
  **`provision/provision.ts`** تنها مسیر تماس با پنل (client.ts فقط HTTP است)؛
  **`orders/checkout.ts`** تنها مسیر ساخت سفارش.
- **`telegram/i18n.ts`** تنها شاخهٔ زبانی کل مخزن است (`uiFor()`) و
  **`telegram/menu.ts`** یگانه منبع کیبورد‌ها و واژگان callback.

## ۲. خط لولهٔ پردازش آپدیت (هر آپدیت، دقیقاً یک‌بار)

`src/dispatch.ts` — فقط پس از قبولی هدر secret از `routes/webhook.ts`:

1. **Dedupe**: `update_id` در `update_dedupe` ثبت می‌شود (INSERT ساده داخل
   try/catch در `db/dedupe.ts`)؛ replay تلگرام به PK-contradiction می‌خورد →
   dispatch قبل از هر کاری برمی‌گردد و webhook همان 200 ACK را می‌دهد.
2. **ثبت**: upsert بی‌اثر-تکرار مشتری (`db/customers.ts`؛ فیلدهای پروفایل تازه
   می‌شوند اما `language` هرگز دست نمی‌خورد). اولین /start خوش‌آمد سیستمی؛ آرگومان
   `ref_*` لینک دعوت فقط در اولین /start تاریخ می‌شود.
3. **تعیین یک‌بار در هر آپدیت**: `isAdmin` (env `ADMIN_CHAT_ID` یا
   `customers.is_admin`) و `ui = uiFor(customers.language)` — فقط انتخاب
   صریح ذخیره‌شده؛ NULL یعنی فارسی. `language_code` تلگرام فقط نمایشی است.
4. **مسیریابی**: فرمان ← `commands.ts`؛ callback ← `callbacks.ts` (واژگان
   allowlist)؛ متن/عکس/فایل ← `menuActions.ts` / `messages.ts` → ماشین حالت.
5. **ACK همیشه 200** (`webhook.ts:44-47`): خطا لاگ می‌شود تا طوفان retry تلگرام
   راه نیفتد؛ کار طولانی (پروژن) با `waitUntil` بعد از ACK ادامه می‌یابد.

## ۳. مکالمه و حالت سشن

`state/machine.ts` خالص است؛ ماندگاری در `conversation_states` (یک سطر به ازای
هر مشتری، ۱۳ حالت با CHECK، پیش‌نویس JSON، انقضای تنبل ۲۴ ساعته —
`db/states.ts`). توکن ULIDِ `order_token` هنگام ظاهر شدن صفحهٔ تأیید ساخته
می‌شود و بعد `idempotency_key` سفارش می‌شود.

حالت‌ها: `IDLE, BUYING, WAITING_CONFIG_NAME, WAITING_VOLUME, WAITING_DURATION,
WAITING_DEVICE_LIMIT, WAITING_ORDER_CONFIRMATION, WAITING_PAYMENT_RECEIPT,
WAITING_RENEWAL_DURATION, WAITING_RENEWAL_CONFIRMATION, WAITING_SUPPORT_MESSAGE,
WAITING_ANNOUNCE_TEXT, WAITING_ANNOUNCE_CONFIRM` (`src/types.ts:47-61`).

## ۴. جریان خرید و پرداخت (هستهٔ کسب‌وکار)

```
تپ‌های خرید ← ماشین پیش‌نویس می‌سازد ← checkout قیمت می‌زند (موتور عددصحیح،
   کاتالوگ fail-closed) ← سفارش پایدار (batch: سطر orders + رویداد order_created)
← دستور واریز (سند payment_info + secret کارت + مبلغ اسنپ‌shot — مشتری فقط
   مبلغ نهایی قابل‌پرداخت را می‌بیند)
← بارگذاری فیش (عکس/سند؛ متن بی‌اثر)
← UPDATE مراقبت‌شده pending_payment → awaiting_review؛ فیش برای همهٔ ادمین‌ها فوروارد
← ادمین ✅/❌ (یا دکمه‌های همان digest — مسیر کد یکسان)
   ✅ approved → (اگر با کیف پول پرداخت شده باشد: مستقیم پروژن)…
   ❌ rejected → دلیل (admin_actions، TTL ۱۵ دقیقه) → تک UPDATE مراقبت‌شده؛
      برنده به مشتری اطلاع می‌دهد + برگشت اعتبار کیف پول در همان batch
← سفارش approved: تأییدِ ادمین، provisionOrder را روی waitUntil زمان‌بندی می‌کند:
   ادعای approved→provisioning (تک UPDATE با سقف تلاش در خودِ UPDATE) →
   پیش‌بررسی GET by-username ← adoption سرویس موجود یا POST /api/user
   (`expire` مطلق + بایت GiB) → تأیید قرائتی + سنجش انقضا (یک PUT ترمیم) →
   completed + subscription_url → لینک فوری برای مشتری؛
   شکست ← failed + پوش ادمین با 🔁 + صف /failed (ادعا از حالت failed).
```

حالت‌های سفارش در D1 با CHECK قفل‌اند: `pending_payment, awaiting_review,
approved, provisioning, completed, rejected, failed, cancelled`. تمدیدها همان
خط لوله را با `kind='renewal'` روی سطر سرویس مقصد طی می‌کنند.

## ۵. مسیر پرداخت کیس‌پول (کیف پول)

در صفحهٔ خلاصه، مشتریِ دارای موجودی دکمه‌های `wlt:full` / `wlt:part` می‌بیند.
جریان (purchase.ts + checkout.ts + `db/wallet.ts`): برداشت **پیش از ساخت سفارش**
روی «توکن پیش‌نویس» ادعا می‌شود (UPDATE مراقبت‌شده + NOT EXISTS + ایندکس یکتای
جزئی ضد دوبار-پرداخت)، سفارش با `amount = باقیمانده` ساخته می‌شود (پرداخت
کامل ← سفارش با حالت `approved` و `verified_by='wallet'` متولد می‌شود — بدون
فیش و بدون صف ادمین)، سپس ردیف‌های دفتر کل از توکن به id سفارش «re-point»
می‌شوند (`setPaidLedgerOrder`). هر مسیر شکست checkout ادعای بازگشت وجه دارد
که نه دوبار-برگشت ممکن است نه گم‌شدن آن.

## ۶. جاروب‌های زمان‌بندی‌شده (cron)

`src/index.ts:scheduled` — کرون `*/5`، جاروب‌های مستقل با `try/catch` جدا، با
ادعاهای at-most-once داخل D1 (`db/paymentReminders.ts` مراحل ۱،۲،۳ =
≥۱۵/۳۰/۴۵ دقیقه از اولین فیش؛ `db/serviceNotifications.ts` برای سرویس پولی یک
`usage90` و یک `expiring`، و برای تست رایگان یک `free_test_expiring` منحصربه‌فرد
~۲ ساعت پیش از پایان — هر سه با PK مرکب + lease ۳۰ دقیقه‌ای؛ SQL دو سطح پولی با
NOT EXISTS سفارش‌های ادعاشدهٔ تست را کنار می‌گذارند). دقت کرون تشریفاتی
است — همهٔ تضمین‌ها در دیتابیس زنده.

## ۷. مرزهای احراز هویت و مجوز

| مرز | مکانیزم |
| --- | --- |
| تلگرام ← Worker | هدر `X-Telegram-Bot-Api-Secret-Token`، مقایسهٔ زمان‌ثابت، 503 تا قبل از تنظیم secret / 401 / 400. |
| هویت بازیگر | `from.id` آپدیتِ احراز شده؛ ثبت خودکار (upsert)؛ بدون session token. |
| ادمین | یک‌بار محاسبه + بازبررسی در هر هندلر/شاخه‌ای؛ payload جعلی = توست خنثی، صفر اثر. |
| مالکیت سرویس | اکشن‌های `svc:*` مالکیت را **داخل WHERE** بررسی می‌کنند. |
| Worker ← پنل | `x-api-key` روی HTTPS اعتبارسنجی‌شده؛ کلید هیچ‌جا درز نمی‌کند. |
| ورودی متن‌آزاد | sanitize با سقف سخت (نام کانفیگ، مبلغ، دلیل رد، متن تیکت) — [امنیت](security.md). |

## ۸. مسئولیت‌های دیتابیس

D1 تنها منبع حقیقت: هویت (`customers`)، اسناد کسب‌وکار (`settings`)،
سفارش‌ها (`orders` + audit فقط-افزودنی `order_events`)، دفتر پول
(`wallet_entries`)، دعوت (`referral_rewards`)، پشتیبانی (`support_*`)،
پخش انبوه (`announcements`/`announcement_deliveries`)، داربست exactly-once
(`update_dedupe`, `payment_reminders`, `service_notifications`)، پرامپت‌های موقت
ادمین (`admin_actions`)، audit تنظیمات (`settings_audit`) و سشن گفتگو
(`conversation_states`). هیچ کش/صف خارجی‌ای نیست؛ ماشین گفتگو و کلید فروش هیچ
فرض حافظه‌ای روی Worker ندارند (هر خواندن از D1؛ بازراه‌اندازی بی‌تأثیر).

## ۹. مرزهای API خارجی

فقط دو سیستم بیرونی: **Bot API تلگرام** (HTTPS به api.telegram.org؛ ارسال‌های
`src/telegram/api.ts`) و **پنل PasarGuard** (۴ اندپوینت — [PasarGuard](pasarguard.md)).
هیچ آنالیتیکس/CDN/outbound webhook دیگری نیست؛ تنها اندپوینت ورودی وب‌هوک و
`/health` عمومی است.

## ۱۰. نقشهٔ کد — قابلیت ← فایل

| قابلیت | فایل‌ها |
| --- | --- |
| احراز وب‌هوک + سیاست ACK | `src/routes/webhook.ts` |
| خط لوله، dedupe، ثبت، مسیریابی | `src/dispatch.ts`, `src/db/dedupe.ts`, `src/db/customers.ts` |
| ماشین گفتگو + سشن | `src/state/machine.ts`, `src/db/states.ts` |
| لود کاتالوگ + اعتبارسنجی متقاطع fail-closed | `src/catalog/catalog.ts` |
| فرمول قیمت + اسنپ‌شات | `src/catalog/pricing.ts` |
| رابط قیمت ادمین (توکن، bound، render) | `src/handlers/pricingAdmin.ts`, `src/catalog/pricingDoc.ts`, `src/db/pricing.ts` |
| ساخت سفارش (idempotency، کیف پول، backstop) | `src/orders/checkout.ts`, `src/db/orders.ts`, `src/handlers/purchase.ts` |
| دستور واریز، فیش، صف بررسی | `src/catalog/payment.ts`, `src/handlers/payment.ts`, `src/admin.ts`, `src/telegram/format.ts` |
| دفتر کل و فرمان پول ادمین | `src/db/wallet.ts`, `src/handlers/wallet.ts`, `src/catalog/wallet.ts` |
| دعوت/کد/پاداش | `src/db/referrals.ts`, `src/lib/referralPayout.ts`, `src/handlers/referrals.ts` |
| تیکت پشتیبانی | `src/db/support.ts`, `src/handlers/support.ts` |
| اطلاعیهٔ انبوه | `src/db/announcements.ts`, `src/handlers/announcements.ts` |
| تمدید (نردبان، اعمال، booking فقط-رو به جلو) | `src/handlers/renewal.ts`, `src/catalog/renewal.ts`, `src/provision/provision.ts` |
| پروژن + کلاینت پنل | `src/provision/provision.ts`, `src/pasarguard/client.ts`, `src/catalog/provisioning.ts` |
| سرویس‌های من (لیست/جزئیات/غنی‌سازی زنده) | `src/handlers/services.ts` |
| جاروب یادآور 8C | `src/handlers/paymentReminders.ts`, `src/db/paymentReminders.ts` |
| جاروب اعلان فاز ۹ | `src/handlers/serviceNotifications.ts`, `src/db/serviceNotifications.ts` |
| کلید توقف فروش | `src/handlers/salesAdmin.ts`, `src/catalog/sales.ts`, `src/db/sales.ts`, گیت‌ها در `purchase/renewal` + `checkout.ts` |
| مرز i18n و باندل‌ها | `src/telegram/i18n.ts`, `texts.ts`, `texts.en.ts` |
| کیبورد + واژگان callback | `src/telegram/menu.ts` |
| راهنمای اتصال (ثابت، بدون حالت) | `src/telegram/guide.ts`, `src/handlers/guide.ts` |
| اعتبارسنجی/اصول امنیتی | `src/lib/validate.ts`, `src/lib/security.ts`, `src/lib/configName.ts` |
| health | `src/routes/health.ts` |
| کرون | `src/index.ts:scheduled`, `wrangler.jsonc → triggers.crons` |
| مهاجرت‌ها | `migrations/0001…0014.sql` |
| هارنس تست | `tests/helpers.ts` (shim D1 با `node:sqlite` + جعل تلگرام) |

سازنده / Creator: **[Espierz](https://t.me/Espierz)** · تلگرام / Telegram:
[@Espierz](https://t.me/Espierz) — [🇬🇧 English](../en/architecture.md)
