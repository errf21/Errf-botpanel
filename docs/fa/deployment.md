# استقرار و به‌روزرسانی — فارسی

[🇬🇧 English](../en/deployment.md) · 🇮🇷 **فارسی** · [فهرست](README.md)

**سازنده / Creator:** [Espierz](https://t.me/Espierz) · تلگرام / Telegram: [@Espierz](https://t.me/Espierz)

---

## ۰. یادداشت وضعیت (حقیقت مخزن)

مستنداتِ مخزن: محصولِ کامل فازهای ۱..۱۳ با تست‌های سبز، ولی
`wrangler.jsonc` همچنان با `database_id: REPLACE_WITH_D1_DATABASE_ID` منتشر
شده. **از مخزن قابل تشخیص نیست که در پروداکشن Worker/D1/webhook ثبت‌شده وجود
دارد** — هر اکانت را یا green-field فرض کنید (همه‌چیز از اول طبق این صفحه)،
یا با همین فرمان‌ها وضع موجود را ممیزی کنید.

## ۱. وارسی پیش از استقرار

```bash
git log --oneline -3          # همان چیزی که دیپلوی می‌کنید ببینید
npm install
npm run typecheck && npm test # ۲۲ سوئیت — باید سبز باشند
# wrangler.jsonc:
#   - database_id واقعی؛ vars.ADMIN_CHAT_ID عددیِ trimشده
# secret‌ها (مقادیر چاپ نشوند):
npx wrangler secret list      # انتظار ۴ نام؛ افزودن:
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put PASARGUARD_API_KEY      # تا نبودش پروژن no-op
npx wrangler secret put PAYMENT_CARD_NUMBER     # برای UX پرداخت لازم
```

## ۲. ترتیب مهاجرت — قاعدهٔ سخت

**اول schema.** هر دیپلویی که کدش ستون/سند تازه می‌خواهد، **باید**
`migrations apply --remote` را پیش‌تر دیده باشد (نمونه: کلید `sales` / سند
`pricing` schema-2 که گیت‌ها و UI رویش سوارند). ترتیب امنِ جهانی:

```bash
npx wrangler d1 migrations list  telbot-db --remote    # بی‌اعمال‌ها را ببینید
npx wrangler d1 migrations apply telbot-db --remote    # اعمال ۰۰۰۱..۰۰۱۳
npx wrangler d1 migrations list  telbot-db --remote    # تأیید: چیزی نمانده
npm run deploy                                         # آنگاه Worker
```

**قابلیت اجرای مجدد:** مهاجرت‌ها رو‌به‌جلو هستند؛ wrangler خود اعمال‌شده‌ها را
ردگیری و رد می‌کند؛ بازسازی‌های جداول (۰۰۰۶/۰۰۰۷/۰۰۱۱) ایدمپوتنت نیستند —
SQL را دستی اعمال/جابه‌جا **نکنید** و فایل اعمال‌شده را ویرایش نکنید.

## ۳. دیپلوی + webhook + راستی‌آزمایی

```bash
npm run deploy
curl -s https://<worker-url>/health      # status healthy, checks true
# webhook یک‌بار/پس از تغییر بات — دستور در [telegram.md](telegram.md)
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"   # url + pending 0 + بدون last_error
npx wrangler tail                        # تماشای ترافیک تست دود
```

کمترین تست دود: `/start` ← نردبان خرید ← خلاصه فقط قیمت نهایی ← دستور واریز با
کارت و مبلغ درست ← فیش ← `/pending` ← ✅ ← لینک سرویس ← `/failed` خالی ←
`/sales` stop/start یک‌بار ← `/pricing` view ← تبدیل زبان ← «سرویس‌های من» با
دکمهٔ صفحه.

## ۴. به‌روزرسانی نسخهٔ در حال اجرا

```bash
git pull                                   # یا checkout ریلیز هدف
git log --oneline HEAD@{1}..HEAD           # چه عوض شد؟ بخوانید
git diff --stat HEAD@{1} HEAD -- migrations/  # مهاجرت تازه اضافه شده؟
npx wrangler d1 migrations list telbot-db --remote   # فایلهای اعمال‌نشده؟
# در صورت وجود pending:
npx wrangler d1 migrations apply telbot-db --remote  # پیش از دیپلوی
npm run typecheck && npm test
npx wrangler d1 execute telbot-db --remote --command \
  "SELECT id, state, updated_at FROM orders WHERE state='awaiting_review' LIMIT 5;"  # نیم‌نگاهی به در‌جریان
npm run deploy
# secret فقط اگر نام/مقدار عوض شده: wrangler secret put
# webhook فقط اگر URL بات عوض شده: setWebhook با همان secret
curl -s https://<worker-url>/health && npx wrangler tail
```

رازها در به‌روزرسانی: هرگز پاسخ‌های `secret put` را در CI بدون ماسک نکنید؛
`.dev.vars` لوکال می‌ماند. **کرون** کاری ندارد — trigger در `wrangler.jsonc`
با دیپلوی می‌رود (تب Triggers را روی Worker راستی‌آزمایی کنید).

## ۵. بازگشت و بازیابی

- **کد**: بازگرداندن commit قبلی و دیپلوی مجدد (یا Rollback داشبورد —
  سریع‌ترین راه؛ Cloudflare نسخه‌های اخیر را نگه می‌دارد).
- **داده**: مهاجرت خودکار برگشت **نمی‌شود** (بازسازی‌ها یک‌طرفه‌اند). پس بعد
  rollback باید کد قدیمی با اسکیما جدید کار کند — الگوی مخزن (چک لیست‌های
  افزودنی/enumeration) همین را ممکن کرده؛ مهاجرت مخربِ بدون نقشهٔ بازیابیِ مکتوب
  ممنوع.
- **توقف امن world**: پیش از هر کاری `/sales` 🛑 (توقف تجاری ممیزی‌شده)؛
  `deleteWebhook` گزینهٔ اتمیک — هیچ آپدیتی وارد نمی‌شود و state به‌خاطر
  ادعاهای idempotent سالم می‌ماند.
- **گیرکردگی**: سفارش `approved` پروژانشده صبر می‌کند (no-op)؛ `failed` 🔁 با
  `/failed`؛ هرگز دستی `orders.state` را برای رد شدن از گاردها تغییر ندهید —
  برای بازتريgger کردنِ پارک‌شده راه‌حلِ مستند [عیب‌یابی §E](troubleshooting.md)
  است (برگشت مستند به `awaiting_review` + تأیید مجددِ عادی).
- **بازیابی داده**: export منظم (نگهداری)؛ بدترین سناریو `d1 restore` (اگر
  پلن PITR داد) یا import در scratch DB و ترمیم جراحی‌شده.

## ۶. روزِ نخستِ تولید (اثبات پروژن)

قبل از رونج: یک `GET` فقط‌خواندنی با `x-api-key` روی نام‌کاربری معلوم
(تطبیق shape: §۲ [PasarGuard](pasarguard.md)) ← یک سفارش تستیِ کاملِ واقعی با
کمترین پلکان ← تأیید ← لینک باز شود ← تمدیدِ همان سرویس هم تست شود ←
`/failed` خالی. سپس سرویس تستی را در پنل تعیین تکلیف کنید.

---

سازنده / Creator: **[Espierz](https://t.me/Espierz)** · تلگرام / Telegram:
[@Espierz](https://t.me/Espierz) — [🇬🇧 English](../en/deployment.md)
