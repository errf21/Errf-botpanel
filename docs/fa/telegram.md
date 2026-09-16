# راه‌اندازی تلگرام — فارسی

[🇬🇧 English](../en/telegram.md) · 🇮🇷 **فارسی** · [فهرست](README.md)

**سازنده / Creator:** [Espierz](https://t.me/Espierz) · تلگرام / Telegram: [@Espierz](https://t.me/Espierz)

---

## ۱. BotFather

```
/start با @BotFather  →  /newbot
  - نمایشی (display name)  → نام سرویس شما
  - username               → هرنامی که با "bot" تمام شود
  - توکن ربات برگردانده می‌شود
```

توصیه‌ها (مطابق رفتار همین مخزن):

- **حالت حریم خصوصی**: همهٔ فرمان‌ها و منوها در چت خصوصی‌اند و هیچ جریان گروهی
  پیاده نشده؛ privacy mode پیش‌فرض می‌تواند روشن بماند.
- **Menu Commands** (آرایهٔ اختیاری — ربات بدون آن هم کار می‌کند؛ فرمان‌ها در
  `handlers/commands.ts` پارس می‌شوند):
  `/start`, `/help`, `/cancel` و برای ادمین‌ها `/pending`, `/failed`, `/tickets`,
  `/announce`, `/announcements`, `/credit`, `/debit`, `/pricing`, `/sales`.
- توضیح/About دلخواه؛ متن `/help` واقعیِ ربات از باندل‌های کد می‌آید
  (`src/telegram/texts.ts` / `texts.en.ts`).

## ۲. توکن → secret

توکن هرگز در کد، `wrangler.jsonc`، لاگ یا لاگ‌فایل نیست.

پروداکشن:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
# هنگام prompt جای‌گذاری کنید (ورودی مخفی است)
```

لوکال: داخل `.dev.vars` (در .gitignore؛ الگو: `.dev.vars.example`).

## ۳. انتخاب webhook secret

خودتان یک رشتهٔ تصادفی بلند بسازید (تلگرام آن را در هدر
`X-Telegram-Bot-Api-Secret-Token` برمی‌گرداند؛ Worker با مقایسهٔ زمان‌ثابت
بررسی می‌کند — `webhook.ts`، `security.ts`):

```bash
openssl rand -hex 32      # یا هر مولد تصادفی قوی
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

تا تنظیم‌نشدن این secret، وب‌هوک **fail-closed** است (۵۰۳) و هیچ آپدیتی
پردازش نمی‌شود؛ هدر غلط = ۴۰۱.

## ۴. ثبت webhook

بعد از دیپلوی شدن Worker و `healthy` بودن `/health`:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  --data-urlencode "url=https://<worker-subdomain>.workers.dev/telegram/webhook" \
  --data-urlencode "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
# → {"ok":true,"result":true,"description":"Webhook was set"}
```

نکات:

- مسیر دقیقاً `/telegram/webhook` و فقط `POST` (`src/index.ts:20`).
- با دامنه/Custom Domain اختصاصی همان را بگذارید؛ فقط path باید مطابق باشد.
- تلگرام روی non-2xx retry می‌کند؛ این Worker همیشه ۲۰۰ ACK می‌دهد — خطاها را
  هندلر خود می‌خورد (کد همین کار را می‌کند).
- برای `wrangler dev` ثبت webhook لازم نیست؛ همان‌جا با POST مستقیم آپدیت JSON
  + هدر secret ربات را ران کنید (نمونه در [توسعه](development.md)).

## ۵. راستی‌آزمایی

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

انتظار: `url` = آدرس webhook ورکر شما؛ `pending_update_count` صفر یا بسیار
کم؛ **بدون** `last_error_message`.

راستی‌آزمایی زنده: ربات را باز کنید و `/start` بزنید — منوی ۱۰ دکمه‌ای با ردیف
اولِ سه‌تاییِ رنگی (پیش‌فرض فارسی) باید بیاید. خطاها با `npx wrangler tail` دیده می‌شوند
(`webhook_dispatch_error ...`).

برای حذف/چرخش: `deleteWebhook`، secret تازه `put` کنید و دوباره `setWebhook` —
ترتیب: اول secret را عوض کنید و بعد ثبت کنید تا آپدیت‌های in-flight مدت
کوتاهی ۴۰۱ بگیرند و تلگرام retry کند (قابل‌قبول؛ چیزی گم نمی‌شود).

## ۶. هدف‌گیری ادمین

`ADMIN_CHAT_ID` (`wrangler.jsonc → vars`) = **تک** شناسهٔ عددی کاربر ادمین اصلی.
ادمین‌های بیشتر با سطر `customers.is_admin=1` (باید یک‌بار `/start` زده باشند تا
سطر وجود داشته باشد):

```bash
npx wrangler d1 execute telbot-db --remote --command \
  "SELECT id, telegram_user_id, first_name FROM customers WHERE first_name LIKE '%شما%';"
npx wrangler d1 execute telbot-db --remote --command \
  "UPDATE customers SET is_admin=1 WHERE telegram_user_id='<شناسه عددی>';"
```

فوروارد فیش‌ها و digest یادآور به `ADMIN_CHAT_ID ∪ همهٔ ردیف‌های is_admin`
می‌رود (`resolveAdminChatIds` در `db/customers.ts`؛ خطای دیتابیس به
targetingِ فقط-env تنزل می‌کند و آپدیت را نمی‌شکند).

## ۷. ملاحظات پروداکشن

- **قابلیت‌های Bot API 8.0+**: فیلد `style` دکمه‌های reply-keyboard با
  سازگاری کامل (کلاینت قدیمی آن را نادیده می‌گیرد — `src/types.ts:148`).
- `parse_mode` **فقط انتخابی** و فقط برای حباب‌های کارت/IBAN/URL (phase 8C)؛
  بقیهٔ پیام‌ها plain‌اند (بدون سطح حملهٔ پارس HTML).
- توکن داخل `.dev.vars` **نباید** توکن پروداکشن باشد؛ آزمایش روی ربات واقعی
  ممنوع — ربات تست جدا بگیرید.
- اگر ربات قبلاً polling بوده، حذف webhook کافی نیست — اول هر پُلر
  `getUpdates` را متوقف کنید (تلگرام تا polling فعال webhook را رد می‌کند:
  `409 Conflict: terminated by other getUpdates`).

---

سازنده / Creator: **[Espierz](https://t.me/Espierz)** · تلگرام / Telegram:
[@Espierz](https://t.me/Espierz) — [🇬🇧 English](../en/telegram.md)
