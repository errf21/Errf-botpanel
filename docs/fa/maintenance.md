# نگهداری — فارسی

[🇬🇧 English](../en/maintenance.md) · 🇮🇷 **فارسی** · [فهرست](README.md)

**سازنده / Creator:** [Espierz](https://t.me/Espierz) · تلگرام / Telegram: [@Espierz](https://t.me/Espierz)

---

## ۱. بررسی‌های دوره‌ای (ریتم پیشنهادی)

### هفتگی (و بعد از هر حادثه)

```bash
# ۱) زنده بودن ورکر، D1 و secret‌های اصلی
curl -s https://<worker-url>/health | python3 -m json.tool
# ۲) سفارش‌های مسن در حالت میانجی
npx wrangler d1 execute telbot-db --remote --command "
  SELECT state, COUNT(*) n FROM orders
   WHERE state IN ('awaiting_review','approved','provisioning','failed')
   GROUP BY state;"
# ۳) صف پروژن ناموفق
npx wrangler d1 execute telbot-db --remote --command \
  "SELECT id, updated_at FROM orders WHERE state='failed' ORDER BY updated_at DESC LIMIT 10;"
# ۴) بدهی بررسی فیش (همان چیزی که digest 8C گوشزد می‌کند)
npx wrangler d1 execute telbot-db --remote --command \
  "SELECT COUNT(*) FROM orders WHERE state='awaiting_review';"
# ۵) اطلاعیه ناتمام
npx wrangler d1 execute telbot-db --remote --command \
  "SELECT id,state,sent_count,total_estimate FROM announcements WHERE state='sending';"
```

تفسیر: ردیف `approved` (بدون ادعا/پروژن) = پارک ناشی از config no-op — صفر
تحمل؛ درمان در [عیب‌یابی §ث](troubleshooting.md). `awaiting_review` بالای یک
روز = فراموشی صف؛ یادآوری به ادمین‌ها.

### ماهانه

- بازبینی `settings_audit` برای actor/مقادیر غیرمنتظره:
  `SELECT id,key,action,actor,created_at FROM settings_audit ORDER BY id DESC LIMIT 50;`
- آنومالی دعوت: `SELECT referrer_customer_id, COUNT(*) FROM referral_rewards GROUP BY 1;`
- سلامت کیف‌پول: رشد `wallet_entries` طبیعی است (هر رویداد یک ردیف)؛
  هرگز balance دستی را UPDATE نکنید.
- مقیاس: متریک‌های D1 (reads/minutes) نسبت به پلن — اگر تنگ شد پلن را بالا
  ببرید نه کد را (خوانی‌های طراحی‌شده برای درستی‌اند).
- export (بخش ۳) + **آزمایش import** روی scratch — exportِ تست‌نشده backup
  نیست.
- پنل: تأیید اینکه گروه‌های داخل `provisioning.group_ids` هنوز وجود/فعالیت
  دارند.

### موقع هر دیپلوی و هر تغییر تنظیمی

فقط آیتم‌های «قبل/بعد»ِ چک‌لیستِ استقرار
([استقرار §۱](deployment.md)).

## ۲. عملیات routine امن

| عملیات | روش (در همین پروژه) |
| --- | --- |
| چرخش webhook secret | `secret put` ← فوری `setWebhook` با مقدار تازه ← `getWebhookInfo` + health + یک `/start`. |
| چرخش توکن بات | `/revoke` در BotFather → `secret put`ِ توکن نو → `setWebhook` نو → verify. |
| چرخش کلید پنل | کلید جدید در پنل بسازید → `wrangler secret put PASARGUARD_API_KEY` → با `/failed` سالم و `tail`، پنل قدیمی را revoke کنید. |
| چرخش کارت فروشنده | `wrangler secret put PAYMENT_CARD_NUMBER` + اطلاعیه `/announce` (متن‌نویس خود اپراتور). فیلد D1 لازم نیست/نادیده. |
| توقف موقت برای نگهداری | `/sales` 🛑 → ... → 🟢 (+ اطلاعیهٔ ازسرگیری) — هر دو در audit. |
| ویرایش قیمت‌ها | `/pricing` (هرگز SQL برای CAS-doc‌ها). |
| افزودن/حذف ادمین | `/start` کاربر ← `UPDATE customers SET is_admin=1/0` ([ادمین](admin.md)). |
| لدرها/سیاست‌ها | تک‌UPDATE سند D1 + smoke ([پیکربندی](configuration.md)). |
| ارتقای Node/Wrangler ماشین توسعه | lock-pinned؛ بعد هرت bump: `typecheck` + `test`. |

## ۳. پشتیبان‌گیری

```bash
# export منطقی کامل (ریموت)، timestamped:
npx wrangler d1 export telbot-db --remote --output=backups/telbot-db-$(date +%F).sql
```

خروجی‌ها شامل **اطلاعات شخصی** (شناسه/نام، مبالغ سفارش)‌اند → محرمانه، دور
از git. بازیابی: تست import روی scratch، یا PITR داشبورد (بستهٔ به پلن). تکرار:
حداقل هفتگی + همیشه **پیش از** apply مهاجرت. رازی داخل D1 نیست (تطابق
طراحی)، پس export خطر افشای secret ندارد.

## ۴. مراقبت وابستگی/پلتفرم

- وابستگی‌ها فقط ۳ تای dev (typescript, wrangler, workers-types) و **صفر
  وابستگی runtime** — بازبینی دوره‌ای `npm outdated` کافی است.
- notices دیپریکشن Cloudflare را رصد کنید؛ `compatibility_date` پین شده
  رفتار را تثبیت می‌کند؛ جابه‌جایی‌اش را مثل هر تغییر بزرگ با دروازهٔ کامل
  انجام دهید (رفتار cron/batch D1 تستی).
- Bot API: متدهای پرکار‌وبتاثیر؛ `style` دکمه‌ها سازگار با کلاینت قدیمی.

## ۵. انتظام تغییر (قاعده‌های خود مخزن)

۱. مهاجرت فقط-افزودنی؛ ۲. پول/قیمت/فروش فقط از مسیر UIِ CAS+audit؛ ۳.
`typecheck`+`test` سبز پیش از هر push؛ ۴. مستندات دوزبانه در همان تغییر؛
۵. بدون secret در هر لایه؛ ۶. بعد دیپلوی: health، `/pending`، یک تست دود
خرید.

---

سازنده / Creator: **[Espierz](https://t.me/Espierz)** · تلگرام / Telegram:
[@Espierz](https://t.me/Espierz) — [🇬🇧 English](../en/maintenance.md)
