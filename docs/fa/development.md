# توسعه — فارسی

[🇬🇧 English](../en/development.md) · 🇮🇷 **فارسی** · [فهرست](README.md)

**سازنده / Creator:** [Espierz](https://t.me/Espierz) · تلگرام / Telegram: [@Espierz](https://t.me/Espierz)

---

## ۱. راه‌اندازی محیط توسعه

```bash
git clone <repo-url> && cd telbotv2
npm install                      # فقط ۳ devDependency: wrangler + typescript + workers-types
cp .dev.vars.example .dev.vars   # مقادیر LOCAL (gitignored)
npx wrangler login               # فقط نخستین بار / برای D1 واقعی
npx wrangler d1 create telbot-db # database_id را در wrangler.jsonc بگذارید
npm run db:migrate:local         # اعمال ۰۰۰۱..۰۰۱۳ روی D1 لوکال
```

## ۲. فرمان‌ها (اسکریپت‌های دقیق `package.json` — چیزی جز این نیست)

| فرمان | واقعی | توضیح |
| --- | --- | --- |
| `npm test` | `node --disable-warning=ExperimentalWarning --test tests/*.test.ts` | ۲۲ فایل تست (`helpers.ts` کتابخانهٔ مشترک است، نه سوئیت)؛ **Node ≥ 22.18 / ≥ 23.6** (اجرای native TS + `node:sqlite`). |
| `npm run typecheck` | `tsc --noEmit` (strict + `noUncheckedIndexedAccess`) | تنها دروازهٔ ایستا؛ **اسکریپت lint در مخزن نیست**. |
| `npm run dev` | `wrangler dev` (`.dev.vars` + D1 لوکال؛ cron فعال نمی‌شود) | |
| `npm run deploy` | `wrangler deploy` | |
| `npm run db:create` | `wrangler d1 create telbot-db` | |
| `npm run db:migrate:local` / `:remote` | `wrangler d1 migrations apply telbot-db [--local|--remote]` | |

## ۳. معماری تست (`tests/helpers.ts`)

- **shim دیتابیس**: SQLite در حافظه با `node:sqlite` (`DatabaseSync`) که
  `prepare/bind/all/first/raw/batch` و `meta.changes` را پیاده می‌کند — SQL
  واقعی `src/db/*` اجرا می‌شود، از جمله CHECK‌ها و unique‌های جزئی.
- **stub تلگرام**: fetch جعلی که پیام‌ها/کیبوردها را ضبط می‌کند؛ آپدیت کامل از
  `processTelegramUpdate` عبور می‌کند.
- سوئیت‌ها: تست خالصِ لایه‌ها (`machine`, `pricing`, `pricingDoc`, `validate`,
  `i18n`, `configname`, `catalog`, guide) + تست e2e فازها (`phase2…phase13`)
  که جریان سرتاسری و جاروب‌ها (با `now` صریح) را ران می‌کنند و متن‌های
  فارسیِ تثبیت‌شده را پین می‌کنند. بدون شبکه/سرویس خارجی.

قرارداد مخزن: قبل و بعد هر تغییر `npm run typecheck && npm test`.

## ۴. گردش کار تکرار لوکال

```bash
# POST مستقیم آپدیت به وب‌هوک (dev) (بدون تلگرام واقعی):
printf '{"update_id":1,"message":{"message_id":1,"from":{"id":111,"is_bot":false,"first_name":"Dev"},"chat":{"id":111},"text":"/start"}}' \
 | curl -sS -X POST http://localhost:8787/telegram/webhook \
   -H "X-Telegram-Bot-Api-Secret-Token: <secret لوکال>" \
   -H 'content-type: application/json' -d @-

# پرس‌وجوی D1 لوکال:
npx wrangler d1 execute telbot-db --local --command "SELECT * FROM settings;"
```

برای دریافت واقعی پیام‌ها حین dev، توکن `.dev.vars` باید توکن یک ربات تست باشد
(ارسال‌ها همان‌جا می‌روند؛ ربات پروداکشن را هرگز به dev وصل نکنید).

## ۵. قراردادها/ سبک کد (چیزی که مخزن می‌طلبد)

- **بدون فریمورک**: هندلر خام `fetch`/`scheduled`، مسیریابی صریح،
  `UpdateContext` (env, db, api, actor, isAdmin, ui).
- SQL تازه فقط در `src/db/<domain>.ts` به‌صورت **تک‌استیتممنت ادعایی (claim)** (WHERE
  حالت + بررسی affected-rows یا CAS)؛ آثار جانبی بعد از بردنِ ادعا
  (`meta.changes === 1`)؛ واحدهای اتمیک با `db.batch`.
- تنظیمات تازه: `src/catalog/` با `"schema"` نسخه‌دار + دلایل خطاِ typed +
  سیاستِ صریح: پولی ⇒ **closed**؛ ریسکِ تعطیل‌کردن کسب ⇒ **open** (مثل `sales`).
- callback تازه: اول allowlist در `menu.ts`+`validate.ts`، بعد هندلر؛ namespace‌های idدار
  پارسر مخصوص خود دارند؛ هر اکشن مالکیت/ادمینی را دوباره چک می‌کند.
- متن تازه: فارسی قرارداد `Texts` را تعریف می‌کند؛ `texts.en.ts` باید
  type-check آینه باشد؛ انگلیسی اصیل بنویسید؛ **قرارداد نمایش قیمت مشتری**
  (فقط مبلغ نهایی) خط‌سرخ است.
- مهاجرت: فقط-افزودنی `NNNN_name.sql`؛ seed‌ها `INSERT OR IGNORE`؛ الگوی آماده
  بازسازی CHECK؛ بک‌فیل deploy-safe برای داده زنده؛ دغدغه در هر فایل = یک.
- هیچ رازی وارد لاگ/متن نشود؛ جزئیات پنل فقط همان برش ۲۰۰‌تایی sanitize.

## ۶. گردش امن تغییر (همان انتظام خودِ مخزن)

۱. از `master` تمیز؛ فازها granular. ۲. مهاجرت **بدون لمس مهاجرت‌های
اعمال‌شده**؛ کد تا حد امکان با DB قدیمی‌تر هم سازگار بماند؛ جایی که نمی‌شود
ترتیب «مهاجرت پیش از دیپلوی» حاکم است ([استقرار](deployment.md)).
۳. typecheck → تست → smoke لوکال. ۴. **مستندات دوزبانه در همان تغییر به‌روز
شوند** (صفحه‌های en و fa قرینه). ۵. diff را دور این‌ها با وسواس بخوانید: موتور
قیمت، checkout، گاردهای db، احراز webhook، مرز `uiFor`، گیت‌های sales —
ثابت‌های آن‌ها خودِ محصول است. ۶. الگوی کامیت مخزن: `feat: … phase …`.

## ۷. یادداشت ابزار

- TS 5.x، `moduleResolution: bundler`، `allowImportingTsExtensions: true`،
  ES2022 + `@cloudflare/workers-types`، فلگ `nodejs_compat`.
- Wrangler 4: `keep_vars: true`؛ `compatibility_date` pin شده.
- ESLint/Prettier سراسری وجود ندارد؛ اگر ادیتور شخصی دارید محلی نگه دارید —
  **برای همین، کانفیگ جدید به مخزن اضافه نکنید** (امضای فعلی مخزن همین است).

---

سازنده / Creator: **[Espierz](https://t.me/Espierz)** · تلگرام / Telegram:
[@Espierz](https://t.me/Espierz) — [🇬🇧 English](../en/development.md)
