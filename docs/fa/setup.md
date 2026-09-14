# راه‌اندازی و پیش‌نیازها — فارسی

[🇬🇧 English](../en/setup.md) · 🇮🇷 **فارسی** · [فهرست](README.md)

هرچه برای رسیدن از یک ماشین خالی به یک TELBOTV2 در حال اجرا و راستی‌آزمایی‌شده
نیاز است.

**سازنده / Creator:** [Espierz](https://t.me/Espierz) · تلگرام / Telegram: [@Espierz](https://t.me/Espierz)

---

## ۱. پیش‌نیازها

### اکانت‌ها و سرویس‌ها

| پیش‌نیاز | چرا | توضیح |
| --- | --- | --- |
| اکانت Cloudflare | Worker + D1 + cron | پلن رایگان از نظر فنی قابل استفاده است؛ مسیرهای کد به افزونهٔ پولی نیاز ندارند. |
| Cloudflare Worker | کل برنامه | از `wrangler.jsonc` دیپلوی می‌شود. |
| Cloudflare D1 (با نام `telbot-db`) | تمام حالت + تنظیمات کسب‌وکار | نام بایندینگ `DB`؛ ساخت با `wrangler d1 create telbot-db`. |
| ربات تلگرام | رابط کاربری | از @BotFather (`/newbot`، توکن). |
| شناسهٔ چت ادمین | مجوز ادمین | یک شناسهٔ عددی در `ADMIN_CHAT_ID` به‌علاوه/یا سطرهای `customers.is_admin`. |
| پنل PasarGuard | پروژن | URL پایهٔ HTTPSِ در دسترس + یک API key از رابط ادمین پنل. |

### ابزارها (بر اساس `package.json`، `wrangler.jsonc` و تست‌ها)

| ابزار | نسخه | شاهد |
| --- | --- | --- |
| Node.js | **≥ ۲۲٫۱۸ یا ≥ ۲۳٫۶** (محیط نگارش مخزن روی v23+) | تست‌ها TypeScript را مستقیم با `node --test tests/*.test.ts` اجرا می‌کنند و به `node:sqlite` داخلی (`DatabaseSync`) نیاز دارند؛ Node قدیمی سوئیت را اجرا نمی‌کند. |
| npm | همراه Node | `package-lock.json` موجود است. |
| Wrangler | `^4.0.0` (devDependency؛ نصب سراسری لازم نیست) | `package.json → devDependencies`. |
| TypeScript | `^5.6.0` (devDependency) — فقط typecheck، `noEmit` | `tsconfig.json`، `npm run typecheck`. |

هیچ سرویس دیتابیس، پایپ‌لاین بیلد یا کانتینری لازم نیست: Worker و D1 درون همان
Worker زمان اجرا هستند. در این پروژه **اسکریپت lint وجود ندارد** (به
[توسعه](development.md) رجوع کنید).

## ۲. دریافت کد

```bash
git clone <repo-url> telbotv2
cd telbotv2
npm install
```

## ۳. راه‌اندازی محیط لوکال

```bash
# ۱) secret‌های اجرای لوکال (به هیچ وجه کامیت نشوند؛ .dev.vars در .gitignore است)
cp .dev.vars.example .dev.vars
#    پر کنید: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,
#             PASARGUARD_API_KEY (اختیاری), PAYMENT_CARD_NUMBER

# ۲) ساخت D1 (یک‌بار؛ همان دیتابیس برای پروداکشن هم استفاده می‌شود)
npx wrangler login
npx wrangler d1 create telbot-db
#    database_id بازگشتی را در wrangler.jsonc بچسبانید
#    (جایگزین "REPLACE_WITH_D1_DATABASE_ID")

# ۳) اعمال هر ۱۳ مهاجرت روی D1 لوکال
npm run db:migrate:local        # = wrangler d1 migrations apply telbot-db --local

# ۴) دروازه‌های صحت
npm run typecheck
npm test                        # ۲۲ فایل تست؛ D1 در حافظه + جعل تلگرام

# ۵) اجرای لوکال
npm run dev                     # wrangler dev → http://localhost:8787
curl http://localhost:8787/health
```

در `wrangler dev` کرون پنج‌دقیقه **اجرا نمی‌شود**؛ جاروب‌های یادآور/اعلان در
تست‌ها مستقیم با `now` صریح ران می‌شوند (بخش
[کرون](architecture.md)).

## ۴. secret و var پروداکشن

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put PASARGUARD_API_KEY      # پروژن را فعال می‌کند (تا قبلش no-op)
npx wrangler secret put PAYMENT_CARD_NUMBER     # کارت فروشنده — تنها منبع نمایش به مشتری
```

var‌های غیرراز (`ADMIN_CHAT_ID`, `PASARGUARD_PANEL_URL`) در `wrangler.jsonc →
vars` هستند. مرجع کامل: [پیکربندی](configuration.md).

## ۵. مهاجرت + دیپلوی + ثبت webhook

ترتیب مهم است: **مهاجرت پیش از دیپلوی**، و webhook فقط وقتی Worker و D1 سالم‌اند
ثبت می‌شود.

```bash
npx wrangler d1 migrations list telbot-db --remote   # باید ۰۰۰۱..۰۰۱۳ بی‌اعمال بمانند بررسی شود
npx wrangler d1 migrations apply telbot-db --remote
npm run deploy                                        # = wrangler deploy
npx wrangler tail                                     # اختیاری: تماشای لاگ
```

دستور دقیق webhook و راستی‌آزمایی: [تلگرام](telegram.md). ران‌بوک کامل استقرار
شامل راستی‌آزمایی و بازگشت: [استقرار](deployment.md).

## ۶. ویرایش‌های D1 که پس از راه‌اندازی الزامی‌اند

دیتابیس تازه با **جای‌نما (placeholder)** ساخته می‌شود (قیمت ۴۵۰۰۰/۴۵۰۰…، متن
جای‌نمای صاحب کارت، `group_ids [24,25]`، پیشوند `pg`). پیش از دریافت پول واقعی،
اسناد تنظیمات D1 را ویرایش کنید (نمونه SQL در
[پیکربندی](configuration.md) یا رابط زندهٔ `/pricing`
— [قیمت‌گذاری](pricing.md)) و یک کارت فروشندهٔ واقعی ست کنید (فقط secret).
همچنین `provisioning.enabled`, `renewal.enabled`, `wallet.enabled`,
`referral.enabled` را مطابق قصد خود تنظیم کنید.

## ۷. چک‌لیست پروداکشن — از صفر تا آمادهٔ تولید

```
□  مخزن clone و `npm install` تمیز
□  .dev.vars لوکال پر شده (مقادیر واقعی کامیت نمی‌شوند؛ .gitignore پوشش می‌دهد)
□  D1 ساخته شده و database_id در wrangler.jsonc نشسته است
□  هر ۴ secret با `wrangler secret put` در پروداکشن ست شده
□  ADMIN_CHAT_ID روی شناسهٔ عددی تلگرام ادمین اصلی
□  PASARGUARD_PANEL_URL آدرس پایهٔ HTTPS واقعی پنل (پروتکل https، بدون path)
□  مهاجرت‌ها اعمال شده: لیست --remote بدون pending
□  اسناد تنظیمات بازبینی و جای‌نماها عوض شده‌اند (pricing/payment_info/provisioning)
□  typecheck و test سبز
□  wrangler deploy موفق؛ GET <worker-url>/health برابر healthy با d1=ok و
   telegram_token/webhook_secret/pasarguard_key روی true
□  POST به /telegram/webhook بدون هدر secret → 401
□  webhook ثبت شده و getWebhookInfo: URL درست، pending=0، بدون last_error
□  تست دودی: /start (منوی فارسی) → خرید کامل → دستور پرداخت فقط مبلغ نهایی و کارت
   شما را نشان می‌دهد → فیش → /pending → تأیید → لینک سرویس ظرف چند ثانیه
□  وضعیت /sales بررسی شد (توقف → پیام مشتری؛ ادامه → بازگشت)
□  پروژن واقعی راستی‌آزمایی شد (GET فقط‌خواندنی با کلید، یا همان تست دودی)
□  راهنمای ادمین به اپراتور تحویل شد (صف‌ها، تلاش مجدد، بازگشت وجه) → [ادمین](admin.md)
```

بعدی: [پیکربندی](configuration.md) → [معماری](architecture.md).

---

سازنده / Creator: **[Espierz](https://t.me/Espierz)** · تلگرام / Telegram:
[@Espierz](https://t.me/Espierz) — [🇬🇧 English](../en/setup.md)
