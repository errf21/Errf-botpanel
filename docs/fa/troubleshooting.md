# عیب‌یابی — فارسی

[🇬🇧 English](../en/troubleshooting.md) · 🇮🇷 **فارسی** · [فهرست](README.md)

علامت ← علت احتمالی ← بررسی ← درمان. هر «بررسی» با فرمان واقعی.

**سازنده / Creator:** [Espierz](https://t.me/Espierz) · تلگرام / Telegram: [@Espierz](https://t.me/Espierz)

---

## الف. پیکربندی و وب‌هوک

| علامت | علت احتمالی | بررسی | درمان |
| --- | --- | --- | --- |
| سکوت کامل ربات | webhook ثبت نشده / URL غلط / secret قدیمی | `getWebhookInfo` (url، pending، last_error) + `curl /health` | `setWebhook` مجدد با URL درست و secret **فعلی** ([telegram](telegram.md)) |
| پاسخ 503 به webhook | `TELEGRAM_WEBHOOK_SECRET` تنظیم نشده | `npx wrangler secret list` | `secret put TELEGRAM_WEBHOOK_SECRET` |
| `last_error: 401 Forbidden` سمت تلگرام | secret یک‌طرف چرخیده | مقایسه secret ثبتی و Worker | با هماهنگی re-register؛ تلگرام retry می‌کند |
| `/start` جواب می‌دهد ولی ارسال‌ها می‌سازد؟ token غلط/ربات حذف | | `wrangler tail` + `telegram_token` در health | secret توکن را ست کنید |
| تغییر PANEL_URL اثر ندارد | ردِ اعتبارسنجی سخت: منتهای `https`ِ origin بدون path (`client.ts:138-163`) | curl به همان origin | آدرس را origin خالص کنید |

## ب. Cloudflare / D1 / مهاجرت‌ها

| علامت | علت احتمالی | بررسی | درمان |
| --- | --- | --- | --- |
| `/health` = degraded با `d1:"error"` | پلاسهولدر `database_id` باقی‌مانده، اکانت غلط، D1 حذف‌شده | `wrangler d1 list` | id درست/ساخت مجدد + redeploy |
| دیپلوی با «database not found» | نام/شناسه `telbot-db` نمی‌خواند | `d1 list` | اصلاح config |
| خطای SQL «no such column/doc» در runtime | کد دیپلوی‌شده جلوتر از مهاجرت‌ها | `migrations list --remote` | apply → deploy؛ چون هر request تازه از D1 می‌خواند پس از apply خودترمیم (بدون restart) |
| apply ریموت وسط راه خطا داد (مثلاً پای 0006) | دستی‌کاری تاریخچه/محیط آلوده؛ بازسازی جدول نیمه‌کاره | جدول‌ها/سطرهای `D1_METADATA` | مهاجرت اعمال‌شده را **ویرایش نکنید**؛ در اسکرچ ریپرویدوس و همان جدول swap را دستی کامل/برگردان؛ مسیر امن: restore از export + apply دوباره |
| cron لوکال اجرا نمی‌شود | `wrangler dev` هرگز cron نمی‌زند (مستند) | تب Triggers در prod | جاروب را در تست‌ها مستقیم صدا بزنید؛ در prod هر ۵ دقیقه ran می‌شود |

## پ. رفتارها و UI تلگرام

| علامت | علت احتمالی | بررسی | درمان |
| --- | --- | --- | --- |
| تپِ دکمهٔ reply بی‌اثر | متن client سفارشی‌شده exact-match را می‌شکند | tail | `/start` (رندر مجدد برچسب canonical) |
| دکمه → توست خنثیِ تنها | stale button یا callback بیگانه/جعلی (ادعای حالت/مالکیت ۰ سطر) | حالت سفارش | رفتار درست؛ هیچ‌وقت به‌خاطر راحتی گاردها را شل نکنید |
| «کاتالوگ ناموجود موقتاً» | حفرهٔ پوشش قیمت/سند خراب pricing یا ladder | `settings`؛ کد خطا در tail/log | `pricingCoverageError` را با `/pricing`+ویرایش ladder حل کنید (کاتالوگ fail-closed است عمداً) |
| «قیمت با قبلی فرق دارد» | مقایسه با چت قدیمی — اسنپ‌شات سفارش حاکم است | `orders.selections.amount` | طراحی: هرگز مبلغ سفارش ثبت‌شده را SQL نکنید |
| فیش «نادیده گرفته شد» | خارج از `WAITING_PAYMENT_RECEIPT` / media نامعتبر (file_id > ۲۵۵، پترن fail) | حالت سفارش/tail | مسیر خرید/تمدید از سر گرفته شود؛ TTL سشن ۲۴ ساعت |
| کاربر پیامی نمی‌گیرد | مسدود (start-block)؛ ارسال null برمی‌گردد اما state پولی حفظ | tail | از سمت کاربر lift بلاک؛ لینک سرویس در «سرویس‌های من» هست |
| اطلاعیه وسط راه خوابید | سقف chunk | `/announcements` | «ادامه ارسال ➡️» — ادامه از همان جا (claim هر ردیف) |
| کیبورد زبانِ قدیمی رفتار عجیب؟ | نباید؛ مسیریابی هر دو locale را پوشش می‌دهد | تست‌های i18n | اگر دیدید، **باگ کد** است نه config |

## ت. پرداخت / کیف پول / دعوت

| علامت | علت احتمالی | بررسی | درمان |
| --- | --- | --- | --- |
| مشتری: «اطلاعات پرداخت در دسترس نیست» | `PAYMENT_CARD_NUMBER` نبود/غلط (fail-closed؛ فیلد D1 نادیده) | health + رویداد `payment_card_secret_unconfigured` | secret کارت |
| فیش به برخی ادمین‌ها نرسید | mismatch `ADMIN_CHAT_ID` یا `is_admin` ست‌نشده؛ خطای DB = تنزل به env-only | customers + env | اصلاح env/سطر |
| «موجودی ناکافی» با اینکه کاربر موجودی می‌بیند | view قدیمی/عملیات موازی برنده | `wallet_entries` همان مشتری | حقیقت همان UPDATE مراقبت‌شده است |
| برگشتِ وجهِ رد «نیست» | یا سفارش کیف‌پولی نبود یا batch رد (برنده) زده؛ refund کلید `order_refund` دارد | `SELECT * FROM wallet_entries WHERE order_id=…` | تحقیق با audit؛ سپس در صورت اثبات خطای بیرونی، یک `/credit` مستند — هیچ‌وقت balance خام UPDATE نشود |
| یادآور زود/دیر/انفجاری | کرون تا یک بازه تأخیر دارد؛ هرگز زودتر نیست؛ at-most-once | `payment_reminders` | طراحی (۳ حداکثر؛ catch-up فقط بالاترین موعد) |
| پاداش دعوت پرداخت نشد | سند disabled/خراب → no-op خاموش؛ floor صفر؛ سقف؛ تکرار (PK)؛ فقط تمدید در کار بوده؛ step اعتبار شکست (`referral_credit_failed`) | `referral_rewards`، `settings.referral` | سیاست را درست کنید؛ پاداش زوری ندارد؛ سطرِ یتیم با `/credit` مستند reconcile |

## ث. پروژن / PasarGuard

| علامت | علت احتمالی | بررسی | درمان |
| --- | --- | --- | --- |
| سفارش‌های approved بدون لینک و بدون ورود به `/failed` (park در `approved`) | skip **پیش از ادعا**: نبود کلید/URL، سند provisioning مفقود/خراب/`enabled:false` (تمدید: سند renewal هم) — صفر نوشتن (`provision.ts:411-445`) | tail (`provision_config_unavailable code=…`, `panel_key_or_url_missing`)؛ اسناد | config را کامل کنید. **محدودیت مستندِ فعلی: هیچ UI برای بازتريigger سطرهای پارک‌شده `approved` وجود ندارد** (`/failed` فقط `failed` است). راه‌حل مکتوبِ عملیاتی: برگردان مستند به `awaiting_review` با UPDATE (و بعد `/pending` و ✅ معمولی که خودش ادعا+audit می‌زند): `UPDATE orders SET state='awaiting_review', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='<ULID>' AND state='approved';` |
| سفارش روی approve = failed | تماس واقعی پنل خطا داد: auth(401/403)/timeout/network/rejected(4xx)/server/parse یا سقف تلاش | `/failed` (دلیل ≤۲۰۰ sanitize‌شده) + tail | 🔁 (سقف `max_attempts`)؛ علت ریشه‌ای (کلید، group_ids واقعی، پنل down)؛ ردیفِ `rejected`+detail ⇒ ناسازگاری contract — §۲ و §۳ [PasarGuard](pasarguard.md) |
| سرویس ساخت ولی لینک نرفت | پاسخ ساخت بدون envelope قابل‌برداشت — کد با `by-id/by-username` back-read تأیید و لینک را می‌گیرد | `subscription_url` سطر | اگر NULL بود ولی کاربر هست: link موجود در «سرویس‌های من»/تازه‌سازی؛ یا پنل لینک ندارد |
| «سرویس پیدا نشد» در حالی که ربات لیست می‌کند | حذف سرویس سمت پنل | جزئیات؛ خوانش پنل | طراحی: سنکِ حذفِ پنل به تلگرام sync نمی‌شود (این قابلیت وجود ندارد) |
| تمدید «موفق» اما تغییر انقضا ندارد | ناموفقِ verify = `renewal_unverified` و سفارش `failed` retry-پذیر؛ فقط booking رو به جلو | `renew_target_unix` و حالت سفارش | 🔁؛ اگر پنل expire را نمی‌نویسد: تست read-only GET مستقیم |
| ترس از 409/سرویس تکراری | ممکن نیست: ادعا + UNIQUE + adopt (5 مرحله §۵ [PasarGuard](pasarguard.md)) | `pasarguard_username` | اقدامی لازم نیست |

## ج. قیمت‌گذاری / کلید فروش

| علامت | علت احتمالی | بررسی | درمان |
| --- | --- | --- | --- |
| «ادمین دیگری تغییر داد» روی ✅ (قیمت/فروش) | CAS باختی — عمدي؛ صفر نوشتن | `settings_audit` آخرین ردیف‌ها | مجدد view/arm و اعمال intent |
| همه مشتری‌ها پیام توقف می‌گیرند بدون اقدام شما | `stopped:true` (توسط کسی که در audit هست) یا یادمان مانده | `SELECT value FROM settings WHERE key='sales';` | `/sales` → 🟢 (خودِ تاگل سند خراب را هم repair می‌کند) |
| `/sales` هشدار «سند معتبر نیست» ولی فروش کار می‌کند | JSON خراب → fail-open با هشدار | همان | یک stop/start از UI برای repair؛ منشأ خرابی (دستی SQL) را ببندید |
| خریدها fail-closed «ناموجود» شد بعد ویرایش ladder | حفرهٔ پوشش: preset روشن بدون `user_prices`/`duration_prices` | `/pricing` + ladder‌ها | ورودی اضافه/preset خاموش تا coverage پاس شود |

## چ. استقرار / runtime

| علامت | علت احتمالی | بررسی | درمان |
| --- | --- | --- | --- |
| دیپلوی موفق ولی رفتار قدیمی | commit غلط/vars تازه‌نشده | `wrangler deployments view`؛ زمان health | deploy دوباره از commit درست؛ rollback داشبورد برای عقب‌نشینی سریع |
| secret‌ها «بعد از یک دیپلوی» پریدن | هدف اشتباه: Worker دیگری با نام نزدیک | `wrangler secret list`؛ نام `telbotv2` | re-put در Worker درست (repo `keep_vars: true` دارد) |
| تکرار خطا در تست‌ها روی Node تازه | اجرای تست با Node <22.18 | `node -v` | ارتقای Node (اجرای native TS + `node:sqlite` شرطش است) |
| خطا بعد از مدتی از دید دور شد | tail زنده‌نگاه است | Dashboard Logs (observability روشن است) | query لاگ‌های تاریخ |
| `webhook_dispatch_error update_id=…` | خطای خورده‌شدهٔ هندلر (ACK سالم می‌ماند) | همان update_id در tail؛ replay لوکال | علت را رفع کنید؛ گاردها state را در این میانه سازگار نگه داشته‌اند |

> **هرچه در این فایل نیست**: در محیط لوکال با `.dev.vars` بازتولید کنید، آپدیت
> دقیق را POST کنید (دستور §۴ [توسعه](development.md)) و state قبل/after را
> مقایسه کنید؛ تقریباً همیشه می‌توان همان را به تست رگرسیون (`tests/phase*.test.ts`
> style) تبدیل کرد — چرخهٔ مورد انتظار مخزن همین است.

---

سازنده / Creator: **[Espierz](https://t.me/Espierz)** · تلگرام / Telegram:
[@Espierz](https://t.me/Espierz) — [🇬🇧 English](../en/troubleshooting.md)
