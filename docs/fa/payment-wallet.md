# پرداخت، کیف پول و دعوت — فارسی

[🇬🇧 English](../en/payment-wallet.md) · 🇮🇷 **فارسی** · [فهرست](README.md)

مرجع: `src/handlers/payment.ts`, `src/admin.ts`, `src/db/orders.ts`,
`src/catalog/payment.ts`, `src/handlers/paymentReminders.ts`, `src/db/wallet.ts`,
`src/catalog/wallet.ts`, `src/handlers/wallet.ts`, `src/db/referrals.ts`,
`src/lib/referralPayout.ts`.

**سازنده / Creator:** [Espierz](https://t.me/Espierz) · تلگرام / Telegram: [@Espierz](https://t.me/Espierz)

---

## ۱. جریان پرداخت کارت‌به‌کارتِ دستی (چرخهٔ کامل)

```
ساخت سفارش (pending_payment) ← نمایش دستور واریز ←
مشتری فیش می‌فرستد (عکس/سند) ←
سفارش → awaiting_review؛ فیش + خلاصه برای همهٔ ادمین‌ها فوروارد
(ست ادمین = ADMIN_CHAT_ID ∪ ردیف‌های is_admin) ←
✅ تأیید پرداخت / ❌ رد روی پیام فوروارد، /pending یا digest (یک مسیر کد) ←
✅ approved ← اطلاع مشتری ← پروژن روی waitUntil (پنل)
❌ rejected ← پرامپت دلیل (admin_actions, TTL ۱۵دقیقه، متن ≤۲۰۰ یا «رد
  بدون دلیل»؛ تک UPDATE مراقبت‌شده؛ برگشت اعتبار کیف‌پول در همان batch)
```

- گذارها تک UPDATE با `state='awaiting_review'` در WHERE + بررسی تعداد سطر:
  دابل‌تپ/دو ادمین نمی‌توانند دوبار پردازش کنند؛ برنده audit
  `payment_approved|payment_rejected` با `actor='admin:<id>'` ثبت می‌کند؛
  بازنده توست خنثی و خنثی‌سازی دکمه‌های مرده پیام را می‌بیند.
- **بررسی همیشه دستی** — هیچ callback بانکی/درگاهی وجود ندارد.

## ۲. دستور واریز و پیکربندی آن

- از سند `payment_info` (صاحب کارت، IBAN اختیاری، دستورالعمل) +
  **secret `PAYMENT_CARD_NUMBER`** رندر می‌شود؛ secret تنها منبع کارت در
  زمان اجراست. فیلد جای‌نمای `card_number` در D1 توسط لودر نادیده گرفته
  می‌شود و مرده تلقی شود.
- fail-closed: نبود/غلط secret ⇒ پیام «در دسترس نیست — با پشتیبانی تماس
  بگیرید» + رویداد `payment_card_secret_unconfigured` (مقدار لاگ نمی‌شود).
- کارت/IBAN/URL به‌صورت HTML inline-code (کپی با تپ + راهنمای یک‌باره «کپی») —
  parse_mode فقط و فقط برای همان حباب‌ها؛ هر رشتهٔ پویا از escape
  `format.ts` رد می‌شود.
- `instructions` و `holder` محتوای دست‌نویس ادمین‌اند که **عیناً** رندر
  می‌شوند؛ ربات ترجمه نمی‌کند — مخاطب دوزبانه ⇒ متن دوزبانه در D1 بگذارید
  (بدون redeploy).
- پیچ‌های پرداختِ موجود: `payment_info.holder/iban/instructions` + secret
  کارت. پیچ‌های موجودِ فرضی/نبوده: کلید درگاه، تأیید خودکار، callback،
  چندواحدی… (پرداخت جزئیِ کیف‌پول بحث جداست: §۴).

## ۳. یادآورهای بررسی فیش (Phase 8C)

- بر همان کرون ۵ دقیقه‌ای (handler `scheduled`)، جاروب مستقل.
- لنگر = **اولین** ثبت فیش؛ مراحل در ≥۱۵/۳۰/۴۵ دقیقه ماندن در
  `awaiting_review` — دقیقاً حداکثر ۳ یادآور، هیچ‌وقت زودتر، اجرای catch-up
  فقط بالاترین مرحلهٔ موعددار را می‌فرستد (بدون burst).
- claim-first، at-most-once: یک سطر `payment_reminders` به ازای هر سفارش (PK؛
  فیش جایگزین نمی‌تواند لنگر را جابه‌جا کند) + تک UPDATE مراقبت‌شده که
  `state='awaiting_review'` را دوباره اثبات می‌کند — همپوشانی/رپلی/تأییدِ همزمان
  به یک برنده همگرا می‌شوند. کرش بعد از برد آن یادآور را می‌سوزاند (تصمیم
  آگاهانه: تکرار بدتر از گم‌شدن است).
- ادمین هر اجرا **یک digest تجمیعی** با همان کیبورد `adm:ok|no` می‌گیرد؛
  فیش‌های تمدید نیز همان مسیرند؛ سفارش‌های بدون-review (کیف‌پول کامل یا
  ول‌شده) طبق ساختار لنگر ندارند.

## ۴. کیف پول (دفترکل‌محور)

- **موجودی**: `customers.balance_irt` آینه است (عددصحیح ≥۰)؛
  `wallet_entries` حقیقت ممیزی (فقط-افزودنی، `delta≠0`, `balance_after≥0` که
  از خود سطر بعد از نوشتن خوانده می‌شود).
- **هر جابه‌جایی**: تک UPDATE مراقبت‌شده (شرط موجودی/سقف در WHERE)؛ صفرسطر →
  طبقه‌بندی `insufficient|cap|state`؛ همیشه با INSERT در `wallet_entries`
  جفت می‌شود — پرداخت/برگشتِ سفارش در یک `db.batch` اتمیک؛ اعطا/برداشت ادمین
  بعد از UPDATE مراقبت‌شده، دفتر را از موجودیِ بازخوانی‌شده ثبت می‌کند.
- **ورودی**: `/credit` ادمین (arm→مبلغ↔سقف `max_credit_irt`)،
  `referral_reward` با actor=`system`. **خروجی**: `/debit` (سقف
  `max_debit_irt`)، `order_payment`، `order_refund`. شارژ خودکار مشتری وجود
  ندارد.
- **پرداخت سفارش**: `wlt:full` ⇒ موجودی ≥ کل؛ سفارش با `approved` و
  `verified_by='wallet'` متولد می‌شود (بدون فیش/صف؛ مستقیم پروژن).
  `wlt:part` ⇒ باقیمانده ≥۱ بعداً کارت‌به‌کارت (دستور واریز فقط باقیمانده را
  نشان می‌دهد). برداشت **پیش از ساخت** با توکن پیش‌نویس ادعا می‌شود
  (`NOT EXISTS` + یکتای جزئی `idx_wallet_payment_once` ضد دوبارپرداخت حتی در
  همزمانی واقعی)؛ سپس re-point به id سفارش؛ هر مسیر شکست checkout ادعای
  refund همگرا دارد (`refundOrderWalletPayment`) — نه دوبار-برگشت، نه
  گم‌برگشت.
- **کلید توقف و سقف**: سند `{enabled, max_credit_irt, max_debit_irt}`؛
  نبود/خراب ⇒ کیف‌پول «در دسترس نیست» (fail-closed برای پول).
- تعامل با توقف فروش: گیت‌ها پیش از برداشت ⇒ توقف اعتبار مصرف نمی‌کند
  ([قیمت‌گذاری](pricing.md)).

## ۵. موتور دعوت (referral)

- کد: ۱۲ کاراکتر Crockford base32، minted-on-demand (UPDATE شرطی + retry
  تصادم، همگرا زیر race). لینک `https://t.me/<bot>?start=ref_<code>`
  (username از `getMe` کش‌شدهٔ isolate).
- **انتساب**: فقط first-touch، فقط اولین /start تاریخ کاربر، WHERE با
  `referred_by IS NULL`؛ خوددعوت و کد جعلی رد. انتساب همیشه کار می‌کند
  (به تنظیمات نیاز ندارد)؛ پاداش سیاست‌محور است.
- **پاداش**: `floor((orders.amount + اعتبار کیف‌پول snapshot) ×
  reward_percent / 100)` روی **اولین خرید تأییدشدهٔ** مدعو (تمدید نه)، با
  هر دو مسیر تأیید فراخوانی می‌شود (✅ ادمین و پرداخت‌کیف‌پولی خودکار) از راه
  `payReferrerIfDue`.
- **یک‌باربه‌ازای هر مدعو** با PK `referral_rewards.referred_customer_id`؛
  سقف عمر `max_rewards_per_referrer` داخل همان INSERT...SELECT مراقبت‌شده.
  هر نبود تنظیم ⇒ no-op خاموش (تأییدِ خودِ سفارش را never بلاک نمی‌کند)؛
  شکست stepِ اعتبار، سطر پاداش را برای تطبیق دستی می‌گذارد
  (`referral_credit_failed`).

## ۶. تیکت پشتیبانی

بازکردن (`menu:support` → `WAITING_SUPPORT_MESSAGE`؛ یک تیکت زنده به ازای
مشتری با ایندکس یکتای جزئی) ← پیام‌های مشتری (فایل/عکس هم) فوروارد زنده به
ادمین‌ها ← پاسخ ادمین (`tsk:rp` arm؛ تایپ ≤۲۰۰ sanitize؛ با ثبت و
`delivered` relay می‌شود) ← وضعیت open↔answered ← بستن `tsk:cl`؛ مشاهدهٔ
تاریخچه 👁.

## ۷. اطلاعیه‌ها

`/announce [متن]` ← حالت تایپ ← ذخیرهٔ draft ← preview + تأیید
📢 → **سطرهای تحویل seed-once فقط برای مشتریانِ ثبت‌نام‌کرده**
(`INSERT ... SELECT FROM customers WHERE NOT EXISTS`؛ PK مرکب
(announce_id, customer_id) دوبارارسال را غیرقابل‌نمایش و re-run را امن می‌کند)
→ ارسال چانکی + «ادامه ارسال ➡️» (`ann:ct`)؛ `/announcements` وضعیت ۵ کار
آخر (state، sent/تخمین).

## ۸. ثابت‌های ایمنی پول (چیزی که تست‌ها میخ‌کوب می‌کنند)

- بدون float؛ مبلغ هیچ سفارشی ≠ snapshot نیست.
- بدون پرداخت-دوباره (۳ لایه)، بدون برگشت-دوباره، بدون بازگشت روی حالت
  «نامعلوم»، بدون جابه‌جایی پول بدون guard و سقف محافظ.
- تأیید ← تلاش پاداش خاموش-امن؛ رد در batch خودش بدهکار/برگشت می‌کند؛
  توقف اعتبار مصرف نمی‌کند؛ یادآور زودتر از موعد نه؛ اعلان پس از تمدیدِ
  دوباره arm نمی‌شود (قول یک‌باردرعمر).

---

سازنده / Creator: **[Espierz](https://t.me/Espierz)** · تلگرام / Telegram:
[@Espierz](https://t.me/Espierz) — [🇬🇧 English](../en/payment-wallet.md)
