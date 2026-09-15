# پایگاه داده و مهاجرت‌ها — فارسی

[🇬🇧 English](../en/database.md) · 🇮🇷 **فارسی** · [فهرست](README.md)

دیتابیس: **Cloudflare D1** (`telbot-db`، سازگار با SQLite) با بایندینگ `DB`.
مهاجرت‌ها: پوشهٔ `migrations/` (تنظیم `"migrations_dir"` در `wrangler.jsonc`)،
اعمال دقیقاً به ترتیب نام فایل `0001 → 0014`.

**سازنده / Creator:** [Espierz](https://t.me/Espierz) · تلگرام / Telegram: [@Espierz](https://t.me/Espierz)

---

## ۱. جدول مهاجرت‌ها (ترتیب و هدف واقعی)

| ترتیب | فایل | هدف | نکات |
| --- | --- | --- | --- |
| ۱ | `0001_init.sql` | پی‌ریزی: `customers`, `orders`, `order_events`, `settings` | seed کردن ۶ ظرف خالی تنظیمات با `INSERT OR IGNORE`؛ CHECK روی ۸ حالت سفارش؛ یکتاهای username/id پنل؛ بررسی‌های json و `amount ≥ 0`. |
| ۲ | `0002_phase2.sql` | `conversation_states` (۸ حالت) + `update_dedupe` | نگهداری سشن + محافظ replay وب‌هوک. |
| ۳ | `0003_phase3.sql` | `orders.idempotency_key` + ایندکس یکتای جزئی | seed کاتالوگ + قیمت‌گذاری نرخ‌خطی **جای‌نما** (schema 1) و نردبان‌ها. |
| ۴ | `0004_phase4.sql` | `admin_actions` (رد) + سند `payment_info` | جای‌نمای کارت/صاحب/دستورالعمل (متن‌های فارسی جای‌نما). |
| ۵ | `0005_phase5.sql` | `orders`: `provision_attempts`, `subscription_url` + سند `provisioning` | `group_ids:[24,25]`، پیشوند `pg`، سقف ۳ تلاش، وضعیت active. |
| ۶ | `0006_phase6.sql` | `orders`: `kind`, `renews_order_id`, `service_expires_at`, `renew_target_unix`؛ بازسازی `conversation_states` (+۲ حالت تمدید)؛ سند `renewal`؛ **بازنویسی سند مدت** به ماه‌محور {30,60,90} بدون custom | الگوی بازسازی CHECK = جدول جدید ← کپی ← drop ← rename؛ **غیر ایدمپوتنت، دقیقاً یک‌بار و به ترتیب**. |
| ۷ | `0007_phase7.sql` | کیف پول + دعوت + تیکت + اطلاعیه: `balance_irt`/`referred_by`/`referral_code`؛ `wallet_entries` (+یکتای جزئی ضد دوبارپرداخت)، `referral_rewards` (PK =مدعو)، `support_tickets` (+یک تیکت باز یکتا)، `support_messages`، `announcements`، `announcement_deliveries` (PK مرکب)؛ بازسازی states (+۳) و admin_actions (۴ اکشن + target_id)؛ سند `wallet` + `referral` | همهٔ پول عددصحیح IRT. |
| ۸ | `0008_phase8c.sql` | `payment_reminders` (PK سفارش، مرحله ۰..۳) + **بک‌فیل امن** | سفارش‌های awaiting موجود، طوفان نوتیف در روز استقرار نمی‌گیرند؛ قابلیت اجرای مجدد `INSERT OR IGNORE`. |
| ۹ | `0009_phase9.sql` | `service_notifications` (PK `(order_id,kind)`، تلاش ≤۶۴) + **بک‌فیل سرکوب** | سرویس‌های داخل پنجرهٔ ۳ روزه از قبل `sent` علامت می‌خورند؛ دوباره‌خوانی بی‌ضرر. |
| ۱۰ | `0010_phase10.sql` | `customers.language` (fa/en، NULL مجاز) | **بدون بک‌فیل** — NULL یعنی فارسی، رفتار کاربران فعلی صفر تغییر. |
| ۱۱ | `0011_pricing_model.sql` | بازسازی `admin_actions` (+اکشن `pricing`)؛ جدول **`settings_audit`** (مستند کامل قبل/بعد با json_valid)؛ سند `pricing` به **schema 2** | هدر فایل صراحتاً می‌گوید پیش‌نویس منسوخِ `0011_pricing_admin.sql` هرگز اعمال نشده و حذف شده است. |
| ۱۲ | `0012_device_limit.sql` | سند `device_options` → {1,2,3}، custom خاموش | سند قیمت دست‌نخورده؛ `user_prices` کلیدهای ۴..۱۰ غیرقابل‌دسترس ولی سازگار می‌مانند. |
| ۱۳ | `0013_sales_switch.sql` | سند `sales` = `{"schema":1,"stopped":false}` + بک‌فیلِ فقط-provenance | کلید توقف تجاری. |
| ۱۴ | `0014_free_test.sql` | **`free_test_claims`** (PK `customer_id`، UNIQUE `order_id`)؛ سند `free_test` `{"schema":1,"enabled":true,"volume_mb":100,"duration_days":1,"device_count":1}`؛ **بازسازی `service_notifications`** (+kind `free_test_expiring`، سطرها کلمه‌به‌کلمه حفظ می‌شوند) | بازسازی برگِ CHECK (FK ورودی ندارد)؛ seed با `INSERT OR IGNORE`؛ orders/customers تغییری نمی‌کنند. |

### قاعده‌های ترتیبی که کد به آن‌ها تکیه می‌کند

- اسنادی که با `UPDATE ... WHERE key=...` نوشته می‌شوند (0003،0004،0006،0011،0012)
  **نیازمند** سطرهای ظرف 0001 هستند — دلیل دیگر برای هرگز-ویرایش-نکردن تاریخچه.
- بازسازی‌های جدول‌های CHECK یعنی 0006/0007/0011/0014 باید دقیقاً به ترتیب اجرا شوند.
- seed‌های بعدی `INSERT OR IGNORE` هستند (provisioning, renewal, wallet, referral,
  sales, free_test) و ویرایش ادمین را پاک نمی‌کنند؛ 0013 حتی `updated_by` را شرطی می‌زند.

## ۲. نمای اسکیما (وضعیت نهایی پس از 0014)

### `customers`
ستون‌های کلیدی: `id` (PK)؛ `telegram_user_id` **UNIQUE NOT NULL**؛ `is_admin`
DEFAULT 0 با CHECK؛ `balance_irt` DEFAULT 0، ≥۰؛ `referral_code` (یکتای جزئی)
و `referred_by`؛ `language` (`'fa'|'en'`، NULL-accept). `language_code` فقط
نمایشی است.

### `orders` («سرویس همان سطر خریدِ تکمیل‌شده است»)
`id` ULID-۲۸ (Crockford base32 = ۱۲ زمان + ۱۶ تصادف)؛ `customer_id` →
customers؛ `state` (۸ مقدارِ CHECK)؛ `selections` jsonِ **غییرناپذیر**: انتخاب‌ها +
`config_name` + اسنپ‌شات کامل قیمت با ورودی‌های اعمال‌شده + سقف‌ها + بلوک
اختیاری کیف‌پول؛ `amount` عددصحیح ≥۰؛ `currency` DEFAULT `'IRR'` (سطرهای
واقعی `IRT` اسنپ‌شات را می‌برند)؛ `receipt_file_id`, `payment_reference`,
`verified_by` (`admin:<id>` | `'wallet'`), `verified_at`؛ `pasarguard_username`
**UNIQUE**، `pasarguard_user_id` **UNIQUE**؛ `idempotency_key` + یکتای جزئی؛
`provision_attempts`, `subscription_url`؛ `kind` (`purchase|renewal`),
`renews_order_id` (نرم، ایندکس‌شده), `service_expires_at` (فقط رو به جلو),
`renew_target_unix` (هدف مطلق ادعاشده).

### جداول پشتیبان
| جدول | کلید/محافظ‌ها | نقش |
| --- | --- | --- |
| `order_events` | autoincrement؛ FK cascade | audit فقط-افزودنی هر گذار و اکشن ادمین. |
| `settings` | PK `key` + json_valid | اسناد کسب‌وکار. |
| `settings_audit` | autoincrement | audit تنظیمات: key/actor/action + **مستند کامل قبل/بعد**؛ ایندکس (key, created_at). |
| `conversation_states` | PK customer_id (FK cascade) | ۱۳ حالت + data + 24h. |
| `update_dedupe` | PK update_id | محافظ replay. |
| `admin_actions` | PK admin_user_id | یک پرامپت موقت ادمین (`reject|support_reply|wallet_grant|wallet_debit|pricing`) + TTL ۱۵ دقیقه. |
| `wallet_entries` | PK ULID؛ **یکتای جزئی order_id WHERE kind='order_payment'** | دفتر کل؛ `delta ≠ 0`; `balance_after ≥ 0`. |
| `referral_rewards` | **PK referred_customer_id** | یک پاداش ابدی برای هر مدعو. |
| `support_tickets` / `support_messages` | یکتای «یک تیکت باز»؛ FK cascade | پشتیبانی (متن/فایل + تحویل). |
| `announcements` / `announcement_deliveries` | PK مرکب (announcement_id, customer_id) | پخش انبوهِ قابل‌ازسرگیری. |
| `payment_reminders` | PK order_id | مراحل یادآور 8C با ادعای تک‌UPDATE. |
| `service_notifications` | PK (order_id, kind) | تعهد «یک‌بار در عمر سرویس» + lease ۳۰دقیقه. سطوح *فقط-تجاری* (`expiring`,`usage90`) با NOT EXISTS روی `free_test_claims` تست‌ها را کنار می‌گذارند؛ سطح `free_test_expiring` دقیقاً برعکس (EXISTS) — پنجرهٔ ۲ ساعتهٔ منحصربه‌فردِ تست. |
| `free_test_claims` | **PK customer_id**؛ UNIQUE order_id | دیوار «یک‌بار در عمر» تست رایگان (فاز ۱۵)؛ `order_id` پیش از ساخت سفارش کشته می‌شود (mint) و لنگرِ بازیابی کرش است. |

## ۳. روش امن مهاجرت

محلی و ریموت دو کپی جدا هستند؛ به هر دو صریح اعمال کنید:

```bash
# ۱) ببینید هر محیط چه کم دارد
npx wrangler d1 migrations list telbot-db --local
npx wrangler d1 migrations list telbot-db --remote

# ۲) اول همیشه LOCAL: typecheck+test و اجرای dev
npm run db:migrate:local && npm test && npm run dev

# ۳) پروداکشن — پیش از دیپلویی که کد جدید اسکیما می‌خواهد
#    (wrangler خود فایل‌های اعمال‌شده را ردگیری می‌کند و بازسازی‌ها
#     هرگز دوباره اعمال نمی‌شوند — چون ایدمپوتنت نیستند)
npx wrangler d1 migrations apply telbot-db --remote
```

**قاعده‌های طلایی**

1. مهاجرت‌ها **فقط-افزودنی‌اند**: `0001…0014` را ویرایش/جابه‌جا نکنید؛ تغییر
   تازه فایل `0015_*.sql` است.
2. سند جدید: seed با `INSERT OR IGNORE` + مقدار json_valid + فیلد `"schema"` +
   کامنت provenance (سبک 0013).
3. گسترش لیست CHECK؟ همان الگوی بازسازی 0006/0007/0011 (جدول جدید ← کپی ←
   rename) — یک‌بارمصرف و ترتیب‌محور.
4. تغییر شکلِ دادهٔ زنده: با **بک‌فیل دیپلوی‌ایمن** مثل 0008/0009 (ایدپوتنت،
   `INSERT OR IGNORE`، با تست e2e).
5. D1 رولبک تراکنشی ندارد: هر مهاجرت را روی کپی لوکال بیازمایید؛ هر فایل = یک
   نگرانی.
6. وضعیت applied/اعمال‌نشده روی D1 واقعی **از مخزن قابل تشخیص نیست** (شناسهٔ
   منتشرشده placeholder است) — با `migrations list --remote` روی همان اکانت
   بررسی کنید.

## ۴. جمع‌بندی seed و مقادیر پیش‌فرض

| سند | seed‌کنندهٔ نهایی | واجب‌التغییر پیش از تولید |
| --- | --- | --- |
| نردبان‌ها | حجم `0003`، مدت `0006`، دستگاه `0012` | فعال/غیرفعال preset و بازه (یا همان {10,30,50,100,500}/{30,60,90}/{1,2,3}) |
| `pricing` schema 2 | `0011` | تمام اعداد (جای‌نما) — با `/pricing`، نه SQL |
| `payment_info` | `0004` | holder/iban/instructions؛ کارت = secret `PAYMENT_CARD_NUMBER` |
| `provisioning` | `0005` | `group_ids` واقعی، پیشوند، `enabled` |
| `renewal` / `wallet` / `referral` | `0006`/`0007` | عدد سیاست‌ها یا `enabled` |
| `sales` | `0013` | چیزی نه — فقط با `/sales` (CAS+audit) |

---

سازنده / Creator: **[Espierz](https://t.me/Espierz)** · تلگرام / Telegram:
[@Espierz](https://t.me/Espierz) — [🇬🇧 English](../en/database.md)
