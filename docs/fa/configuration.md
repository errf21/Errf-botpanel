# پیکربندی — فارسی

[🇬🇧 English](../en/configuration.md) · 🇮🇷 **فارسی** · [فهرست](README.md)

دو دستگاه پیکربندی مستقل وجود دارد:

1. **پیکربندی Worker** — بایندینگ‌ها، secret‌ها و `vars` (کلودفلر/wrangler).
2. **پیکربندی کسب‌وکار** — اسناد JSON نسخه‌دار **داخل جدول `settings` در D1**
   (کاتالوگ، قیمت، پرداخت، پروژن، سیاست‌ها، کلید توقف فروش).

قاعدهٔ طراحی مخزن: *دادهٔ کسب‌وکار ویرایش D1 است، نه تغییر کد و نه redeploy.*

**سازنده / Creator:** [Espierz](https://t.me/Espierz) · تلگرام / Telegram: [@Espierz](https://t.me/Espierz)

---

## ۱. بایندینگ، secret و var‌های Worker

بر اساس `interface Env` (`src/types.ts:7-21`) و تمام `env.X`های واقعی در `src/`.

### Secret‌ها — با `wrangler secret put NAME` (لوکال داخل `.dev.vars`)

| نام | لازم | کاربرد | اگر ست نشود |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | بله | فراخوانی‌های خروجی Bot API (`src/telegram/api.ts`, `dispatch.ts:59`) | سلامتی `telegram_token:false`؛ ارسال‌ها شکست می‌خورند. |
| `TELEGRAM_WEBHOOK_SECRET` | بله | اعتبارسنجی هدر `X-Telegram-Bot-Api-Secret-Token` روی هر webhook | **وب‌هوک fail-closed: HTTP 503** (`webhook.ts:21-24`)؛ هیچ آپدیتی پردازش نمی‌شود. |
| `PASARGUARD_API_KEY` | فقط برای پروژن | هدر `x-api-key` (هرگز لاگ/هرگز در متن تلگرام) | پروژن **no-op کامل**: سفارش‌ها در `approved` می‌مانند؛ صفر نوشتن روی پنل (`provision.ts`, `client.ts:142`). |
| `PAYMENT_CARD_NUMBER` | فقط برای پرداخت | **تنها** منبع شماره کارتی که به مشتری نشان داده می‌شود (`payment.ts:48`) | دستور واریز fail-closed → پیام «در دسترس نیست — با پشتیبانی تماس بگیرید» و رویداد `payment_card_secret_unconfigured` (مقدار هرگز لاگ نمی‌شود). |

> **هیچ رازی** نباید در کد، `wrangler.jsonc`، مهاجرت، README، تست یا Git ظاهر
> شود. `.dev.vars` در .gitignore است. فیلد جای‌نمای `card_number` در سند
> `payment_info` (seed `0004`) در زمان اجرا **بی‌اثر** است — لودر عمداً آن را
> نادیده می‌گیرد.

### var‌های غیرراز — `wrangler.jsonc → vars`

| نام | مثال/جای‌نما | کاربرد |
| --- | --- | --- |
| `ADMIN_CHAT_ID` | `""` (شناسهٔ عددی تلگرام خود را بگذارید) | ادمین اصلی. کد آن را trim می‌کند و رشتهٔ عددی مثبتِ برابر `String(actorId)` ادمین می‌سازد (`admin.ts:33-34`). **یک شناسه** است، نه لیست. |
| `PASARGUARD_PANEL_URL` | `https://<panel-host>` | آدرس پایهٔ پنل. سخت اعتبارسنجی می‌شود: دقیقاً `https:`، hostname پر، بدون path اضافه و بدون user/pass داخلی، وگرنه `panel_url_rejected` — fail-closed (`client.ts:138-163`). |

### بایندینگ

| بایندینگ | نوع | مقدار |
| --- | --- | --- |
| `DB` | D1 | `telbot-db` — پس از `wrangler d1 create telbot-db` مقدار `database_id` واقعی را در `wrangler.jsonc` بگذارید (مخزن با `REPLACE_WITH_D1_DATABASE_ID` منتشر شده). |

## ۲. اسناد تنظیمات کسب‌وکار (جدول `settings` در D1)

کلید `value` با CHECK `json_valid` نگه داشته می‌شود. اعتبارسنجی در زمان
خواندن انجام می‌شود؛ سند خراب یا نسخه‌ناقص **fail-closed** با پیام دوستانهٔ
«موقتاً در دسترس نیست» (کاتالوگ/قیمت/پولی) یا غیرفعال‌شدن همان قابلیت
(سیاست‌ها) است — هرگز کرش نمی‌کند و مقدار پیش‌فرض نمی‌سازد.

| `key` | schema | لودر | فیلدها | نقش |
| --- | --- | --- | --- | --- |
| `volume_options` | 1 | `catalog.ts` | `min_gb,max_gb,allow_custom,presets[{gb,enabled}]` | نردبان حجم (۱۰/۳۰/۵۰/۱۰۰/۵۰۰، custom مجاز). |
| `duration_options` | 1 | `catalog.ts` | `min_days,max_days,allow_custom,presets[{days,enabled}]` | نردبان مدت؛ ماه‌محور ۳۰/۶۰/۹۰، custom خاموش (`0006`). |
| `device_options` | 1 | `catalog.ts` | همان شکل با `count` | تعداد کاربر {۱،۲،۳}، custom خاموش (`0012`). |
| `pricing` | **2** (`0011`) | `catalog.ts` + `pricingDoc.ts` | `currency,days_per_month,base_product{...},price_per_gb,duration_prices,user_prices` | موتور قیمت. [قیمت‌گذاری](pricing.md). |
| `payment_info` | 1 | `payment.ts` | `holder,card_number(نادیده),iban,instructions` | دستور واریز (کارت از **secret**). |
| `provisioning` | 1 | `provisioning.ts` | `enabled,group_ids,username_prefix,max_attempts,default_status` | کلید مادر تمام نوشتن‌های پنل. [PasarGuard](pasarguard.md). |
| `renewal` | 1 | `renewal.ts` | `enabled,near_expiry_days` | کلید توقف تمدید + آستانهٔ «نزدیک انقضا». |
| `wallet` | 1 | `wallet.ts` | `enabled,max_credit_irt,max_debit_irt` | کلید توقف + سقف هر عملیات پولی ادمین. |
| `referral` | 1 | `referral.ts` | `enabled,reward_percent,max_rewards_per_referrer` | سیاست پاداش دعوت. |
| `sales` | 1 (`0013`) | `sales.ts` | `stopped` | کلید توقف تجاری — **fail-open**. [قیمت‌گذاری](pricing.md). |
| `business_settings` | 1 | *(هیچ کدی نمی‌خواند)* | `{"schema":1}` | راکت/رزرو — در حال حاضر بی‌مصرف. |

### ویرایش اسناد تنظیمات

راه‌های امنِ ترجیحی:

- **اعداد قیمت** → جریان زندهٔ `/pricing` (arm → تایپ → staging → تأیید → CAS +
  `settings_audit`). هرگز SQL دستی نه — [قیمت‌گذاری](pricing.md).
- **کلید فروش** → دکمه‌های `/sales` — [قیمت‌گذاری](pricing.md).
- **سایر اسناد** (نردبان‌ها، متن دستور واریز، سیاست‌ها) → یک `UPDATE` تک‌سطری از
  راه D1؛ بررسی قبل و پس از ویرایش:

```bash
# اول ببینید
npx wrangler d1 execute telbot-db --remote \
  --command "SELECT key, value, updated_by, updated_at FROM settings WHERE key='provisioning';"

# یک سند را عوض کنید (JSON را با سند اعتبارسنجی‌شده جایگزین کنید؛ فیلد schema حفظ شود)
npx wrangler d1 execute telbot-db --remote --command \
  "UPDATE settings SET value='{\"schema\":1,\"enabled\":true,\"group_ids\":[24,25],\"username_prefix\":\"pg\",\"max_attempts\":3,\"default_status\":\"active\"}', updated_by='admin:<id>', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key='provisioning';"
```

> **اسناد `sales` و `pricing` را دستی ویرایش نکنید** — مسیرهای CAS+audit دارند؛
> ویرایش خام ممکن است race توکن را بشکند. SQL دستی فقط برای نردبان‌ها/سیاست‌ها.

## ۳. مقدارهای seed جای‌نما هستند — پیش از روشن‌شدن بازبینی شوند

تا زمانی که ادمین ویرایش نکرده باشد، ستون `updated_by` مقدار `migration:00xx`
دارد:

- `0011` pricing: `base_product.price=45000`, `price_per_gb=4500`,
  `duration_prices {2:80000,3:110000}`, `user_prices` یک تا ده — جای‌نما.
- `0004` payment_info: holder «نام صاحب کارت (جای‌نما)»، کارت `6037997100000000`
  (**بی‌اثر**؛ secret واقعی حاکم است)، `iban:null`.
- `0005` provisioning: `group_ids:[24,25]`, پیشوند `pg` — با گروه‌های واقعی پنل
  تطبیق دهید.

## ۴. چه چیزی به پیکربندی ربطی ندارد

پول هیچ‌جا float نیست؛ **همه مبالغ عدد صحیح IRT (تومان)** در `orders.amount`،
`customers.balance_irt`، `wallet_entries.delta_irt`. ربات هنگام اجرا هیچ
`.env` را نمی‌خواند — فقط بایندینگ/vars/secret کلودفلر. **هیچ**
`PAYMENT_PROVIDER_TOKEN`، کلید درگاه یا callback بانکی وجود ندارد: بررسی
پرداخت عمداً دستی است.

---

سازنده / Creator: **[Espierz](https://t.me/Espierz)** · تلگرام / Telegram:
[@Espierz](https://t.me/Espierz) — [🇬🇧 English](../en/configuration.md)
