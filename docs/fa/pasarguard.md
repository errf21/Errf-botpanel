# یکپارچه‌سازی PasarGuard — فارسی

[🇬🇧 English](../en/pasarguard.md) · 🇮🇷 **فارسی** · [فهرست](README.md)

تمام موارد این صفحه از روی `src/pasarguard/client.ts`،
`src/provision/provision.ts` و `src/catalog/provisioning.ts` خوانده شده —
هیچ اندپوینتی از خودمان نمی‌سازیم.

**سازنده / Creator:** [Espierz](https://t.me/Espierz) · تلگرام / Telegram: [@Espierz](https://t.me/Espierz)

---

## ۱. پیش‌نیازهای پنل

- پنل **PasarGuard** reachable از طریق **HTTPS** از Cloudflare.
- آدرس پایه در `wrangler.jsonc → vars.PASARGUARD_PANEL_URL` و سخت
  اعتبارسنجی می‌شود (`client.ts:138-163`): دقیقاً `https:`، hostname پر،
  **بدون نام‌کاربری/رمز و بدون path غیر از `/`** (مبنای نهایی `url.origin`)؛
  در غیر این صورت پروژن fail-closed با `panel_url_rejected` و صفر نوشتن.
- **API key** از رابط ادمین پنل (بخش API keys) ساخته می‌شود و فقط به‌صورت
  secret `PASARGUARD_API_KEY` به Worker داده می‌شود؛ فقط در هدر `x-api-key`
  روی HTTPS ارسال می‌شود — هیچ‌جا لاگ و هیچ‌جا در متن تلگرامی نمی‌رود. سطح
  دسترسی/نقش دقیق کلید مربوط به پنل است و **از مخزن قابل استنباط نیست**.
- گروه‌های اشتراک که در سند `provisioning` آمده (`group_ids`، seed
  `[24,25]`) باید روی پنل وجود داشته و قابل فروش باشند — پیش از اولین
  سفارش واقعی تطبیق دهید.
- **Template‌ها**: ربات هیچ ارجاعی به template پنل ندارد — payload ساخت فقط
  فیلدهای §3 است (قرارداد سیم در فاز ۶ از bundle داشبورد `/statics/api-*.js`
  بازبینی شد؛ **اصلاح یافتهٔ پروداکشن ۰۹/۲۰۲۶**: فیلد نسبی `expire_duration`
  توسط `POST /api/user` نادیده گرفته می‌شد و سرویس‌ها Unlimited ساخته می‌شدند
  — اکنون همان `expire` مطلق مثل PUT تمدید فرستاده و تأیید می‌شود). تنظیم
  template روی گروه، تصمیم سمت پنل و خارج از این ربات است.

## ۲. اندپوینت‌های واقعاً استفاده‌شده (کل مجموعه، از کد)

| اندپوینت (client.ts) | مصرف‌کننده | کاربرد |
| --- | --- | --- |
| `GET /api/user/by-username/{username}` | `getUserByUsername` (:239) | پیش‌بررسی adoption هنگام ساخت؛ غنی‌سازی زندهٔ «سرویس‌های من»؛ جاروب usage/expiry؛ تأیید-خوانش پس از ساخت |
| `GET /api/user/by-id/{id}` | `getUserById` (:253) | تأیید-خوانش وقتی پاسخ POST پاکت قابل‌برداشت نداشت |
| `POST /api/user` | `createUser` (:245) | پروژن خرید — **هرگز بدون بررسی retry نمی‌شود** |
| `PUT /api/user/by-username/{username}` | `modifyUserByUsername` (:274) | تمدید — فقط `{expire:unix_seconds}` مطلق را ست می‌کند؛ همین primitive نوشتنِ **ترمیم انقضای ساخت** هم هست (§3). خرید مجدد (فاز ۱۸) مقادیر نهایی مطلق `{data_limit, expire, hwid_limit}` را با همین primitive می‌فرستد |
| `POST /api/user/by-username/{username}/reset` | `resetUserUsageByUsername` | فقط خرید مجدد (فاز ۱۸) — صفر کردن `used_traffic` روی همان کاربر موجود (POST خالی؛ سهمیه/انقضا دست‌نخورده؛ لینک اشتراک ممکن است بچرخد). هرگز نسخهٔ گروهی `POST /api/users/reset` |
| `DELETE /api/user/by-username/{username}` | `deleteUserByUsername` (client.ts) | **فقط حذف سرویس توسط ادمین** (§5) — تک‌تلاش، تأیید با `GET` همان نام؛ هیچ cron/جاروبی آن را صادر نمی‌کند |

محافظ‌های ورودی داخل client: username `/^[A-Za-z0-9]{3,32}$/`، user id
`/^[0-9]{1,20}$/`، `expire` عددصحیح `1..4_000_000_000`؛ تایم‌اوت
`PANEL_TIMEOUT_MS = 15_000` با `AbortSignal.timeout`؛ پارس مقاوم پاسخ (بازکردن
یک لایهٔ پاکت `data|user|result`؛ پذیرش `id|user_id|userId`، لینک از
`subscription_url|subscriptionUrl`؛ نرمال‌سازی ثانیهٔ مطلق؛ `data_limit=0`
یعنی نامحدود؛ POST/PUT موفق بدون پاکتِ قابل‌برداشت = `ok:true,data:null` و
caller با **خوانش مجدد** تأیید می‌کند). URL سابسکریپشن فقط به‌صورت مطلق
`http(s)` می‌پذیرد (نسبی به origin وصل می‌شود)، سقف ۵۱۲، وگرنه دور ریخته
می‌شود.

انواع خطای تایپ‌شده (`client.ts:30-39`): `not_configured`, `bad_url`,
`network`, `timeout`, `auth` (401/403), `not_found` (404), `rejected` (سایر
4xx), `server` (≥500), `parse`. متن detail کاراکترهای کنترلی‌اش حذف و ۲۰۰
کاراکتر بریده می‌شود — تنها متن پنل که می‌تواند به لاگ/صف ادمین برسد.

## ۳. payload ساخت (خرید) — دقیقاً

ساخته‌شده در `provision.ts` (`parseSelections` + `buildCreatePayload`):

| فیلد | مقدار | واحد |
| --- | --- | --- |
| `username` | `username_prefix` سند provisioning + ULID سفارش، **کوچک‌حروف**، بریده به ۳۲ (ادعای name روی سطر سفارش **پیش از** هر تماس؛ ستون UNIQUE) |
| `status` | `default_status` سند (`active`/`on_hold`) | — |
| `data_limit` | `volume_gb × 1_073_741_824` (۲³⁰) | **بایت GiB** — پنل حجم را GiB نشان می‌دهد؛ ۱۰ انتخاب‌شده دقیقاً `10.00` (تبدیل SI قدیم ۹٫۳۱ می‌کرد؛ مگابایت تست رایگان عامدانه SI می‌ماند) |
| `expire` | `now + duration_days × 86_400` | **ثانیهٔ مطلق unix** — همان فیلدی که PUTِ اثبات‌شدهٔ تمدید می‌زند؛ `expire_duration` نسبی توسط پنل نادیده گرفته می‌شد (یافتهٔ پروداکشن ۱۳۸۹/۰۹ — §1) |
| `hwid_limit` | تعداد کاربر/دستگاه | — |
| `group_ids` | از سند `provisioning` | آرایهٔ int |
| `note` | `telbot:<order_id>` | نشانگر بازگشت |

**تأیید انقضا** پس از هر ساخت/adopt: `expire` اعلامیِ پنل باید به هدف ادعاشده
برسد (تلورانس ساعت ۳۰۰ ثانیه)؛ نبود یا کمبودِ آن (همان شکل Unlimited) دقیقاً
**یک PUTِ اصلاحی** `{expire: target}` با همان primitive تمدید می‌زند و خوانشِ
مجدد تصمیم می‌گیرد. بدون تأیید، سفارش fail-closed به `failed` می‌رود
(`create_expiry_unverified` / `expiry_repair_…`) — هرگز با
`service_expires_at` محلی‌ساخته تمام نمی‌شود؛ retry همگراست (پیش‌بررسی موجود را
adopt می‌کند و PUT مطلق no-op است).

سقف‌های منطقی پیش از هر تماس شبکه (`provision.ts` — `parseSelections`):
`1 ≤ gb ≤ 4_194_304`، `1 ≤ days ≤ 36_600`، `1 ≤ devices ≤ 10_000`، وگرنه
خطای `selections_invalid`؛ هدف `expire` غیرقابل‌نمایش → `create_target_overflow`
پیش از هر نوشتن پنل.

## ۴. payload تمدید (extend)

`PUT by-username/{u}` با `{ expire: <ثانیهٔ مطلق unix> }` — از اصلاح ۰۹/۲۰۲۶
همین primitive برای **ترمیم انقضای ساخت** (§3) هم به‌کار می‌رود؛ هر دو مطلق
هستند، پس هیچ‌کدام روی هم انباشته نمی‌شود.
`target = max(now, انقضای پنل/محلی) + duration_days×86_400`.
هدف **پیش از نوشتن روی سطر سفارش تمدید ادعا می‌شود
(`orders.renew_target_unix`)**، پس retry (دکمهٔ `🔁` / `/failed`) همگراست:
اگر پنل از قبل `expire ≥ target` نشان دهد، **adopt می‌شود و PUT تکراری
نمی‌رود** — نتیجهٔ مبهم شبکه هرگز دو تمدید روی هم نمی‌گذارد. پس از PUT دوباره
می‌خواند و `≥ target` لازم است، وگرنه `renewal_unverified` (هیچ booking
نمی‌شود). موفقیت، `service_expires_at` سرویس را **فقط رو به جلو** تثبیت می‌کند
+ رویداد `service_extended`؛ سفارش تمدید `completed`. هرگز
`pasarguard_user_id`/`subscription_url`/username سرویس را دست نمی‌زند.

## ۵. حذف (حذف سرویس توسط ادمین — فاز ۱۶)

`provision.ts:deletePanelService(env, username)` تنها نویسندهٔ حذف است و فقط
از مسیر ادمین در دسترس است (`/panel_del` ← تأیید صریح `pdel:ok` — §۲/§۳
راهنمای ادمین):

1. یک `DELETE /api/user/by-username/{u}` — بدون retry خودکار داخل فراخوانی.
2. بی‌درنگ یک `GET` روی همان نام: **۴۰۴ تنها دلیل پذیرفتنی است**. ۲xx با
   آبجکت کاربر ← `panel_delete_ignored`؛ ۲xx بی‌شکل ←
   `panel_delete_state_unreadable`؛ هر خطای شبکه/auth/۵xx در هر دو فراخوانی ←
   شکست با دلیل sanitizeشده. `alreadyGone:true` اگر خودِ DELETE پاسخ not_found
   داد (حذف دستی روی پنل یا دابل‌تپ همزمان).
3. **فقط** پس از `ok:true` دیتابیس وضعیت پایان‌یافتهٔ `panel_deleted` را ثبت
   می‌کند: تک UPDATE مراقبت‌شدهٔ `markPanelDeleted` (`state IN (completed,failed)`
   + `panel_deleted_at IS NULL`) که `panel_deleted_at`/`panel_deleted_by` را
   ست می‌کند (`admin:<tg>` / `system:svc-refresh` / `system:notice-sweep`) +
   یک رویداد ممیزی `service_panel_deleted` + اطلاع مشتری به زبانِ گیرنده.
   شکست یا ابهام در پنل = صفر تغییر محلی.

اثر (`panel_deleted` پایان‌یافته است): سفارش از مسیرهای فهرست/جزئیات/تمدید
حذف می‌شود (`getOwnedService` و `listServicesForCustomer` روی همین ستون
فیلتر می‌کنند)، از صف retryِ `/failed` می‌رود، ادعاهای پروژن برای آن بسته‌اند
(پیش‌بررسی `provisionOrder` + خودِ UPDATE ادعا)، تمدیدِ صف‌شده رو به آن
fail-closed می‌شود (`renewal_service_deleted`)، و جاروب اعلان‌ها آن را نامزد
نمی‌کند. ردیف‌های سفارش/پرداخت/تمدید/ممیزی هرگز حذف نمی‌شوند — تاریخچه و
`pasarguard_username` اصلی می‌مانند تا آن نام تا وجود این ردیف به سفارش
دیگری واگذار نشود.

حذف‌های دستیِ انجام‌شده مستقیم روی پنل، هرگاه یک ناظرِ وصل‌شده ۴۰۴ ببیند، به
همین وضعیت تطبیق داده می‌شوند: تپِ بروزرسانیِ مشتری (`system:svc-refresh`) یا
جاروب usage (`system:notice-sweep`)؛ همه idempotent (همان UPDATE
مراقبت‌شده).


## ۶. طراحی idempotent/همزمان (چرا یک سفارش دو سرویس نمی‌سازد)

1. ادعای تک UPDATE مراقبت‌شده `approved→provisioning` (retry:
   `failed→provisioning`) با `provision_attempts < max_attempts` **داخل خودِ
   UPDATE** — برندهٔ یکتا در دابل‌تپ/رپلی/نمونه‌های موازی.
2. username اول روی سطر سفارش (violation = مال کس دیگری → توقف).
3. پیش‌بررسی `GET by-username` → **adopt سرویس موجود** (موقع timeout مبهم؛ POST
   کور تکرار نمی‌شود).
4. `409` روی ساخت → خواندن برنده و adopt.
5. هر تلاش قبل از `completed` با خوانش تأیید-مجدد سنجیده می‌شود؛
   `subscription_url` از همان خوانش ذخیره می‌شود.

## ۷. no-op کاملِ fail-closed (رفتار بدون تنظیمات)

هرگاه پیش‌نیازی نقص داشته باشد `provisionOrder` **صفر نوشتن DB و صفر تماس
شبکه** انجام می‌دهد و سفارش همان‌جا (approved/failed) می‌ماند
(`provision.ts:411-445`): نبود کلید/URL، سند `provisioning` ناموجود/خراب،
`provisioning.enabled=false` (کلید مادر تمام نوشتن‌های پنل — ساخت **و** تمدید)،
یا برای تمدید سند `renewal` ناموجود/`enabled:false`/خراب. دلایل skip:
`unconfigured | config_invalid | disabled | renewal_disabled |
renewal_unavailable` — و همه **پیش از ادعا** بررسی‌اند (مهم برای عیب‌یابی؛
به [عیب‌یابی §E](troubleshooting.md) رجوع کنید).

## ۸. مدیریت خطا و گردش ادمین

- شکست ساخت/تمدید → سفارش `failed` + دلیل کوتاه sanitize‌شده — پوش 🔁 برای همهٔ
  ادمین‌ها، صف `/failed`، retry با همان ادعا/سقف.
- پیام مشتری در شکست هیچ‌وقت خام نیست؛ فقط «در دسترس است» — پول/فیش‌شان
  نمی‌سوزد و retry فقط پروژن را تکرار می‌کند.
- خطای خوانش در «سرویس‌های من»/جاروب‌ها → تنزل به snapshot محلی؛ `not_found`
  روی سرویس حذف‌شده/منقضی، ردیف اعلان را `skipped` می‌کند تا برای ابد retry
  نکند.
- **اثبات اولیهٔ زنده** (توصیهٔ عملیاتی، نه کد): پیش از اولین فروش، یک `GET`
  فقط‌خواندنیِ احرازشده روی نام‌کاربری معلوم، بعد یک سفارش تست کامل
  end-to-end؛ کلید فقط هدر، هرگز echo نشود.

## ۹. ملاحظات امنیتی

- `x-api-key` فقط روی originِ اعتبارسنجی‌شدهٔ HTTPS؛ هیچ مسیر لاگی کلید را
  درج نمی‌کند (خطاها با `error=${name}` ثبت می‌شوند).
- **خروجی‌های پنل** دشمن فرض می‌شوند: به `PanelUser` باریک تبدیل، URL
  باز-sanitize، فیلد `note` پنل هرگز رندر نمی‌شود، رشته‌ها سقف‌دار.
- **ورودی‌های پنل** فقط از snapshot‌های سمت سرور ساخته می‌شوند
  (`orders.selections`)، هرگز از payload کیبورد.

## ۱۰. چک‌لیست عملیاتی

```
□ HTTPS reachable بدون path اضافه
□ API key ساخته و secret شده؛ جای دیگری paste نشده
□ group_ids با شمارهٔ گروه‌های واقعی پنل تطبیق شد (seed [24,25] است)
□ سند provisioning enabled و parse-شدنی (سند خراب = no-op کامل!)
□ username_prefix: حداکثر ۴ کاراکتر [a-z0-9] (۲۸ + پیشوند ≤ ۳۲)
□ GET فقط‌خواندنی → سپس یک سفارش تستی کامل **روی حداقلِ واقعی خرید — ۱۰ گیگ /
  ۱ ماه** (نه ۱ گیگ؛ زیر کف کسب‌وکار است): /pending → تأیید → لینک؛ روی پنل
  باید دقیقاً ۱۰٫۰۰ گیگ و انقضای متناهی (ساخت + ۳۰ روز) نشان دهد — هرگز
  «Unlimited»
```

---

سازنده / Creator: **[Espierz](https://t.me/Espierz)** · تلگرام / Telegram:
[@Espierz](https://t.me/Espierz) — [🇬🇧 English](../en/pasarguard.md)
