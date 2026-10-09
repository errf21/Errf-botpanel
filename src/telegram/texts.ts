/**
 * All user-facing bot text in one place (Persian-first).
 * Keys are stable; wording polished across Phase 8 (8A keyboards, 8B persona).
 * NOTE: prices/payment copy arrive Phase 3/4 — never here.
 *
 * PHASE 8B PERSONALITY RULES:
 *  - Greeting style is «درود»، personalized «درود زیبا» when the name is
 *    unknown. Use it ONLY where a greeting is natural: the welcome (see
 *    welcomeGreeting) and important standalone customer notifications (see
 *    notifyApproved). NEVER force it into mid-flow prompts, validation
 *    errors, short confirmations, or back-to-back consecutive bubbles.
 *  - The 90%-usage and single-expiry alerts were reserved here in 8B and
 *    arrived in Phase 9: they open with «درود زیبا، …», stay idempotent
 *    (one per service, enforced in `service_notifications`), and promise
 *    nothing the panel contract does not actually guarantee.
 *  - «زیبا/رفیق/داداش» are sparing catchphrases, not filler.
 */
import { tgCode, tgEscapeHtml } from './format.ts';

export const fa = {
  panelFormManagedIntro: "آدرس و کلید API این پنل از تنظیمات کلادفلر خوانده می‌شود. نام و گروه‌های پنل را اینجا ویرایش کنید.",
  panelFormManagedLocked: "آدرس و کلید این پنل فقط از تنظیمات کلادفلر قابل تغییر است.",
  panelFormManagedUnavailable: "تنظیمات Worker ناقص، نامعتبر یا تغییر کرده است. پس از اصلاح، /panels را دوباره باز کنید.",
  panelGroupsDestinationFailed: "آدرس HTTPS درست خوانده شد، اما بررسی DNS یا عمومی بودن مقصد ناموفق بود. DNS و ایمنی آدرس را بررسی کنید؛ حفاظت SSRF را غیرفعال نکنید.",

  // Cross-panel migration: shared locale and saved customer preference.
  migrationUsageCommands: "/migrate <شناسه_عدد_تلگرام_مشتری>\n/migrate status <شناسه_انتقال>\n/migrate panels <شناسه_سرویس> [صفحه]",
  migrationManualCommand: "/migrate manual {id} <حجم_بایت> <YYYY-MM-DDTHH:mm:ssZ> <سقف_دستگاه>",
  migrationPanelsCommand: "/migrate panels <شناسه_سرویس>",
  migrationDenied: "انتقال سرویس فقط برای مدیران مجاز و در گفت‌وگوی خصوصی امکان‌پذیر است.",
  migrationUnknown: "نامشخص",
  migrationHeader: "انتقال {id}",
  migrationCustomerLine: "مشتری: تلگرام {telegram} {username} (شناسه داخلی {customer})؛ سرویس: {service}",
  migrationSourceLine: "پنل مبدأ: {name} ({id})",
  migrationDestinationLine: "پنل مقصد: {name} ({id})",
  migrationGroupsLine: "گروه‌های مقصد: {groups}. گروه‌های پیش‌فرض پنل در زمان بررسی، برای این انتقال ثبت می‌شوند؛ انتخاب گروه جداگانه‌ای وجود ندارد.",
  migrationModelWarning: "انتقال بر اساس سهمیه محدود، تاریخ انقضای قطعی و سقف دستگاه انجام می‌شود. تنظیمات سفارشی پروکسی، بازنشانی دوره‌ای و طرح بعدی کپی نمی‌شوند.",
  migrationStageLine: "مرحله: {stage}",
  migrationAbortRequested: "درخواست لغو ثبت شده",
  migrationBlockedLine: "متوقف شده: {reason}",
  migrationActiveLine: "سرویس فعال در بات: {panel} / {user}",
  migrationRevokedLine: "لغو سرویس مبدأ: نبودن کاربر از طریق API در {date} (UTC) تأیید شد",
  migrationNotRevoked: "لغو سرویس مبدأ تأیید نشده است؛ اشتراک قبلی ممکن است همچنان قابل استفاده باشد.",
  migrationEvidenceLine: "مبنای حق استفاده: {source}؛ زمان مشاهده یا ورود: {date} (UTC)",
  migrationFresh: "داده تازه و تأییدشده",
  migrationSaved: "داده ذخیره‌شده قدیمی؛ وضعیت فعلی تأیید نشده است",
  migrationManual: "مقادیر دستی با تأیید صریح مدیر",
  migrationRemainingLine: "حجم باقی‌مانده: {bytes} بایت؛ انقضای قطعی: {expiry}؛ سقف دستگاه: {devices}",
  migrationQuotaLine: "شواهد سهمیه / مصرف: {quota} / {used} بایت",
  migrationSnapshotWarning: "این مقادیر یک تصویر از وضعیت در زمان ثبت هستند. مصرف بعد از آن بین دو پنل به‌صورت اتمی قابل انتقال نیست. پیش از تأیید، هر ابهام در حق استفاده را بررسی کنید.",
  migrationNoEntitlement: "اطلاعات کامل و قابل‌اعتماد برای حق استفاده محدود موجود نیست. تا بررسی مدیر ادامه ندهید. فقط با دلیل معتبر، مقادیر دستی وارد کنید.",
  migrationConfirmFresh: "تأیید حق استفاده بررسی‌شده و انتقال",
  migrationConfirmSaved: "تأیید حق استفاده بر اساس داده قدیمی و انتقال",
  migrationConfirmManual: "تأیید حق استفاده دستی و انتقال",
  migrationCancelDraft: "لغو پیش‌نویس بدون تغییر در پنل",
  migrationManualHelp: "بررسی دستی به معنی پذیرش مقادیر ثابت باقی‌مانده است، نه کپی ویژگی‌های پشتیبانی‌نشده.\n{command}\nحجم را به بایت، انقضا را به‌صورت زمان قطعی UTC و سقف دستگاه وارد کنید؛ سپس بررسی جدید را صریحاً تأیید کنید.",
  migrationAbortReview: "بررسی لغو؛ حفظ سرویس مبدأ",
  migrationRetryAbort: "تلاش مجدد برای پاک‌سازی مقصد لغوشده",
  migrationContinue: "ادامه فعال‌سازی مقصد تأییدشده",
  migrationRetry: "تلاش مجدد پس از بررسی وضعیت واقعی",
  migrationReviewRevoke: "بررسی لغو سرویس مبدأ",
  migrationRefresh: "به‌روزرسانی وضعیت",
  migrationDestinationHelp: "مشتری {customer}، سرویس {service}\nپنل فعلی: {panel}. یک مقصد فعال انتخاب کنید؛ هنوز تغییری در پنل‌ها انجام نشده است.\nپنل‌های بیشتر: {command}",
  migrationDestinationButton: "انتقال به {name}",
  migrationNoDestinations: "در این صفحه مقصد واجد شرایطی وجود ندارد. پنل دیگری را آزمایش و فعال کنید یا به صفحه 0 برگردید.",
  migrationSelectService: "مشتری {id}: یک سرویس انتخاب کنید (10 سرویس اخیر). برای شناسه سرویس مشخص: {command}",
  migrationNoServices: "سرویس خریداری‌شده تکمیل‌شده و واجد شرایطی پیدا نشد. این مسیر برای سرویس آزمایشی نیست.",
  migrationServiceButton: "سرویس {service} — {panel}",
  migrationUsage: "راهنما:\n{commands}\nشناسه عددی تلگرام مشتری را وارد کنید. هزینه یا سفارش جدیدی ایجاد نمی‌شود. حق استفاده را بررسی کنید، مقصد را فعال کنید و سپس لغو مبدأ را جداگانه تأیید کنید.",
  migrationStopped: "انتقال متوقف شد: {reason}. سوابق مالی و تاریخی اصلی تغییر نکرده‌اند.",
  migrationInterrupted: "انتقال متوقف یا قطع شده است. با /migrate وضعیت ثبت‌شده را بررسی کنید؛ تلاش مجدد ابتدا وضعیت واقعی را تطبیق می‌دهد. خطای خام یا اطلاعات محرمانه نمایش داده نمی‌شود.",
  migrationChecking: "در حال بررسی انتقال…",
  migrationRevokePrompt: "مقصد فعال است. حذف فقط کاربر مبدأ {user} از پنل {panel} را تأیید می‌کنید؟ نتیجه ناموفق یا نامشخص، تأییدشده محسوب نمی‌شود.",
  migrationConfirmRevoke: "تأیید لغو سرویس مبدأ",
  migrationAbortPrompt: "لغو پیش از جایگزینی سرویس فعال را تأیید می‌کنید؟ فقط مقصد منتشرنشده بررسی و حذف می‌شود. سرویس مبدأ و سوابق مالی حفظ می‌شوند. پاک‌سازی نامشخص در انتظار می‌ماند و بازیابی، انتقال در حال لغو را فعال نمی‌کند.",
  migrationConfirmAbort: "تأیید لغو ایمن",
  migrationCustomerNotice: "سرویس شما توسط مدیر منتقل شده است. از لینک اشتراک جدید استفاده کنید:\n{url}",
  migrationStateReview: "بررسی؛ در انتظار تأیید",
  migrationStateCreating: "ایجاد یا تطبیق وضعیت مقصد",
  migrationStateVerified: "مقصد آماده و تأیید شده؛ هنوز در بات فعال نیست",
  migrationStateActivating: "فعال‌سازی و ثبت جایگزینی",
  migrationStateCleanupPending: "مقصد فعال؛ پاک‌سازی مبدأ تأیید نشده",
  migrationStateCompleted: "تکمیل‌شده؛ نبودن سرویس مبدأ تأیید شده",
  migrationStateCancelled: "لغوشده؛ سرویس اصلی حفظ شده",
  migrationError_migration_not_authorized: "اجازه انتقال سرویس را ندارید.",
  migrationError_migration_not_found: "انتقال پیدا نشد.",
  migrationError_service_busy: "عملیات دیگری سرویس را قفل کرده است؛ بعداً تلاش کنید.",
  migrationError_service_owner_or_identity_invalid: "مالکیت سرویس یا هویت کاربر پنل تأیید نشد.",
  migrationError_pending_service_operation: "ابتدا تمدید یا خرید مجدد در انتظار را تعیین تکلیف کنید.",
  migrationError_destination_not_ready: "مقصد برای ساخت سرویس فعال، آزمایش یا پیکربندی نشده است.",
  migrationError_manual_entitlement_invalid: "مقادیر دستی باید شامل حجم مثبت و صحیح به بایت، انقضای آینده در UTC و سقف دستگاه معتبر باشند.",
  migrationError_cannot_cancel_remote_migration: "لغو ایمن در این مرحله با این اقدام امکان‌پذیر نیست.",
  migrationError_expired_or_incomplete_review: "بررسی منقضی یا ناقص است؛ بررسی جدیدی باز کنید.",
  migrationError_entitlement_expired: "اعتبار اشتراک پایان یافته است.",
  migrationError_fresh_preview_expired_cancel_and_review_again: "بیش از 60 ثانیه از بررسی تازه گذشته است؛ پیش‌نویس را لغو و دوباره بررسی کنید.",
  migrationError_fresh_preview_changed_cancel_and_review_again: "حق استفاده مبدأ تغییر کرده است. پیش‌نویس را لغو و مقادیر جدید را بررسی کنید؛ حجم قبلی منتقل نمی‌شود.",
  migrationError_source_origin_unavailable: "آدرس اصلی پنل مبدأ مشخص نیست؛ بررسی مدیر لازم است.",
  migrationError_use_explicit_UTC_timestamp: "زمان دقیق UTC را با قالب YYYY-MM-DDTHH:mm:ssZ وارد کنید.",
  migrationError_customer_not_found: "مشتری با این شناسه عددی تلگرام پیدا نشد.",
  migrationError_service_invalid: "یک سرویس خریداری‌شده تکمیل‌شده و حذف‌نشده انتخاب کنید.",
  migrationError_invalid_migration_action: "اقدام انتقال نامعتبر است.",
  migrationError_invalid_service_id: "شناسه سرویس نامعتبر است.",
  migrationError_expired_or_used_choice: "این دکمه منقضی شده یا قبلاً استفاده شده است؛ مسیر را دوباره باز کنید.",
  migrationError_invalid_migration_id: "شناسه انتقال نامعتبر است.",
  migrationError_source_not_ready_for_revocation: "لغو مبدأ فقط پس از ثبت موفق جایگزینی مقصد مجاز است.",
  migrationError_source_or_pending_operation_changed: "هویت مبدأ یا عملیات در انتظار تغییر کرده است؛ بررسی مدیر لازم است.",
  migrationError_entitlement_expired_requires_review: "اعتبار پیش از فعال‌سازی پایان یافته است؛ بررسی مدیر لازم است.",
  migrationError_destination_configuration_unavailable: "پیکربندی مقصد در دسترس نیست؛ آن را اصلاح و دوباره تلاش کنید.",
  migrationError_destination_origin_changed: "آدرس مقصد با آدرس بررسی‌شده متفاوت است؛ جایگزینی خودکار مجاز نیست.",
  migrationError_destination_absent_explicit_retry_required: "مقصد پیدا نشد. وضعیت آن را بررسی و صریحاً دوباره تلاش کنید؛ ایجاد خودکار متوقف است.",
  migrationError_destination_creation_unverified: "ایجاد مقصد تأیید نشده یا نتیجه نامشخص است؛ تلاش مجدد ابتدا همان هویت را بررسی می‌کند.",
  migrationError_destination_identity_owned_elsewhere: "هویت مقصد متعلق به سرویس دیگری است؛ جایگزینی مجاز نیست.",
  migrationError_destination_staging_disable_unverified: "غیرفعال بودن مقصد آماده‌سازی‌شده تأیید نشد؛ سرویس اصلی فعال می‌ماند.",
  migrationError_destination_url_unverified: "لینک اشتراک مقصد تأیید نشد.",
  migrationError_activation_identity_unverified: "هویت مقصد برای فعال‌سازی تأیید نشد.",
  migrationError_activation_unverified: "فعال‌سازی مقصد یا حق استفاده آن تأیید نشد.",
  migrationError_active_url_unverified: "لینک مقصد فعال تأیید نشد؛ جایگزینی در بات متوقف است.",
  migrationError_source_is_current_active_resource: "مبدأ همچنان سرویس فعال است و نمی‌توان آن را لغو کرد.",
  migrationError_source_unavailable_revocation_unconfirmed: "مبدأ در دسترس نیست. لغو آن تأیید نشده و لینک قبلی ممکن است همچنان کار کند.",
  migrationError_source_revocation_unconfirmed: "حذف مبدأ ناموفق یا نامشخص است؛ پیش از اقدام صریح بعدی، وضعیت را تطبیق دهید.",
  migrationError_source_absence_scope_unverified: "دامنه دسترسی API برای اثبات نبودن مبدأ کافی نیست؛ دسترسی مالک یا خواندن همه کاربران لازم است.",
  migrationError_candidate_cleanup_unconfirmed: "پاک‌سازی مقصد منتشرنشده نامشخص است؛ لغو در انتظار می‌ماند و فعال‌سازی مجاز نیست.",
  migrationError_candidate_identity_unverified: "هویت مقصد منتشرنشده برای پاک‌سازی ایمن تأیید نشد.",
  migrationError_candidate_absence_scope_unverified: "دامنه دسترسی API پاک‌سازی مقصد را اثبات نمی‌کند؛ لغو در انتظار می‌ماند.",
  migrationError_review_expired: "بررسی تأییدنشده بدون ساخت سرویس منقضی شد.",
  migrationError_panel_groups_invalid: "گروه‌های مقصد خالی یا نامعتبرند؛ از /panels اصلاح کنید.",
  migrationError_destination_groups_unverified: "خواندن یا تأیید گروه‌های مقصد ممکن نشد؛ دسترسی کلید API و وجود گروه‌ها را بررسی کنید.",
  migrationError_destination_groups_disabled: "یکی از گروه‌های بررسی‌شده مقصد غیرفعال است؛ پیش از تلاش مجدد گروه‌ها را اصلاح کنید.",
  migrationError_destination_groups_mismatch: "گروه‌های مقصد در پنل با شناسه‌های بررسی‌شده متفاوتند؛ فعال‌سازی متوقف است.",

  // Authenticated panel form and visual group selector.
  panelFormTitle: "تنظیم پنل با کلید API",
  panelFormEdit: "ویرایش پنل",
  panelFormLegacy: "نام پنل اصلی",
  panelFormIntro: "کلید API فقط به این فرم امن ارسال می‌شود؛ آن را در گفتگو نفرستید.",
  panelFormLegacyIntro: "آدرس و کلید پنل اصلی در تنظیمات Worker باقی می‌مانند و اینجا تغییر نمی‌کنند.",
  panelFormName: "نام نمایشی",
  panelFormOrigin: "آدرس HTTPS پنل",
  panelFormKey: "کلید API",
  panelFormKeepKey: "کلید API — برای حفظ کلید ذخیره‌شده خالی بگذارید",
  panelFormSave: "آزمایش و ذخیرهٔ امن",
  panelFormSaving: "در حال آزمایش و ذخیره…",
  panelTestGroupsMissing: "فهرست گروه‌ها با موفقیت دریافت شد، اما هنوز گروهی برای ساخت سرویس انتخاب نشده است. حداقل یک گروه فعال را انتخاب و ذخیره کنید. هنگام استفاده از این فرم، تنظیم متغیر گروه‌ها در کلادفلر لازم نیست.",
  panelTestChooseGroups: "انتخاب گروه‌های پنل",
  panelTestFormUnavailable: "فرم امن در دسترس نیست؛ تنظیم موجود PANEL_ADMIN_ORIGIN باید یک‌بار پیکربندی شود. کلید API را در گفتگو نفرستید.",
  panelGroupsNoneEnabled: "هیچ گروه فعالی در دسترس نیست. ابتدا گروه مناسب را در همین پنل فعال کنید.",
  panelGroupsDisabledLabel: "غیرفعال",
  panelGroupsDisabledError: "یکی از گروه‌های انتخاب‌شده غیرفعال است. گروه‌های همین پنل را بررسی کنید و برای ذخیرهٔ دوباره فرم تازه‌ای باز کنید.",
  panelGroupsConfigInvalid: "شناسه‌های گروه ذخیره‌شده یا ارسالی معتبر نیستند. گروه‌های معتبر را در فرم تازه انتخاب کنید.",
  panelGroupsNotFound: "یکی از گروه‌های انتخاب‌شده دیگر وجود ندارد یا قابل دریافت نیست. گروه‌های همین پنل را تازه‌سازی کنید و فرم تازه‌ای باز کنید.",
  panelGroupsUnexpected: "پاسخ API پنل با قالب مورد انتظار سازگار نیست. هیچ گروهی پذیرفته نشد. سازگاری API را بررسی کنید و فرم را دوباره باز کنید.",
  panelFormManagedSaved: "نام و گروه‌های پنل با موفقیت ذخیره شدند. کلید API ورکر تغییری نکرده است. برای آزمایش، فعال‌سازی یا انتخاب پنل به منوی پنل‌ها برگردید.",
  panelFormSaved: "تنظیمات امن ذخیره شد. به منوی پنل‌ها برگردید و پنل را برای سفارش‌های جدید فعال یا انتخاب کنید.",
  panelFormSaveFailed: "ذخیره انجام نشد. اطلاعات را بررسی کنید و فرم تازه‌ای از منوی پنل‌ها باز کنید.",
  panelFormAuthenticating: "در حال احراز هویت…",
  panelFormAuthError: "احراز هویت انجام نشد. فرم تازه‌ای از منوی پنل‌ها باز کنید.",
  panelGroupsTitle: "گروه‌های پنل",
  panelGroupsHint: "گروه‌های مجاز برای سرویس‌های جدید این پنل را انتخاب کنید.",
  panelGroupsLoad: "دریافت گروه‌ها",
  panelGroupsSelectAll: "انتخاب همه",
  panelGroupsCountOne: "1 گروه انتخاب شده",
  panelGroupsCountMany: "{count} گروه انتخاب شده",
  panelGroupsLoading: "در حال دریافت گروه‌های پنل…",
  panelGroupsPrompt: "آدرس HTTPS و کلید API را وارد کنید تا گروه‌ها دریافت شوند.",
  panelGroupsEmpty: "گروهی در دسترس نیست. دسترسی حساب یا گروه‌های پنل را بررسی کنید.",
  panelGroupsError: "گروه‌ها دریافت نشدند. اتصال پنل و دسترسی حساب را بررسی کنید.",
  panelGroupsRetry: "تلاش مجدد",
  panelGroupsPermission: "حساب پنل اجازهٔ خواندن کامل گروه‌ها را ندارد. دسترسی groups.read را فعال کنید؛ دسترسی فهرست ساده به‌تنهایی کافی نیست.",
  panelGroupsKeyRejected: "کلید API پذیرفته نشد؛ کلید را بررسی کنید.",
  panelGroupsOriginLocked: "آدرس پنلی که سابقهٔ سرویس دارد قابل تغییر نیست؛ پنل جداگانه‌ای اضافه کنید.",
  panelGroupsInvalidOrigin: "از آدرس عمومی HTTPS با پورت 443 یا 8000 و بدون پارامتر یا اطلاعات ورود استفاده کنید. لینک داشبورد به آدرس اصلی پنل تبدیل می‌شود.",
  panelGroupsKeyRequired: "برای این آدرس، کلید API لازم است.",
  panelGroupsUnsupported: "نسخهٔ پنل، API فهرست گروه‌ها را ارائه نمی‌کند. سازگاری نسخه را بررسی کنید.",
  panelGroupsSessionChanged: "فرم منقضی یا تنظیمات تغییر کرده است؛ فرم تازه‌ای باز کنید.",
  panelGroupsMissing: "برخی گروه‌های قبلی در دسترس نیستند. انتخاب‌ها را پیش از ذخیره بررسی کنید.",
  panelGroupsLimit: "حداکثر 50 گروه قابل ذخیره است؛ انتخاب‌ها را کاهش دهید.",

  notConfigured:
    '⚠️ ربات هنوز کامل تنظیم نشده.',

  // Greeting rule (Phase 8B): «درود زیبا» when the user's first name is
  // unknown; the name itself personalizes it when available. Never forced
  // into mid-flow prompts, validation errors, or consecutive bubbles.
  welcomeGreeting: (firstName: string | null) =>
    `درود ${firstName ?? 'زیبا'}،امیدوارم که چطورت عالی باشه\nمرسی که مارو انتخاب کردی❤️(چه خوش سلیقه😁)`,
  welcomeIntro:
    '\nهر کاری داشته باشی، از همین منوی پایین انتخابش کن؛\nاگه بار اولت هست، «🛒 خرید سرویس» رو بزن.\n🎁 تازه‌واردا هم یه تستِ رایگان مهمونن — برای فعال کردنش برو به بخش سرویس های من تست رایگان‌رو میبینی😉.',
  menuPrompt: '👇 منوی اصلی',

  cmdUnknown: '❓ این دستور برام تازه‌ست!\nاز دکمه‌های منو استفاده کن یا /help رو بزن.',
  helpText: [
    '🤖 راهنما',
    '',
    '/start — نمایش منوی اصلی',
    '/cancel — بازگشت به منو و لغو عملیات جاری',
    '/help — همین پیام',
    '/pending — (مدیران) فیش‌های در انتظار بررسی',
    '/repurchases — (مدیران) خریدهای مجدد فعال و قفل سرویس',
    '/failed — (مدیران) سفارش‌های ناموفقِ راه‌اندازی/تمدید',
    '/tickets — (مدیران) تیکت‌های باز پشتیبانی',
    '/announce — (مدیران) ارسال اطلاعیه برای همه کاربران',
    '/announcements — (مدیران) وضعیت اطلاعیه‌های اخیر',
    '/pricing — (مدیران) نمایش و ویرایش قیمت‌ها',
    '/sales — (مدیران) توقف/فعال‌سازی سرویس',
    '',
    '📦 تو «📦 سرویس‌های من» می‌تونی وضعیت و انقضای سرویس‌هات رو ببینی و تمدیدشون کنی.',
    'برای شروع، دکمه‌های پایین رو بزن.',
  ].join('\n'),

  // Buy flow (Phase 2 proves the machine; product steps arrive Phase 3)
  buyIntro: [
    '🛒 خرید سرویس',
    '',
    'اول یه نام برای کانفیگت انتخاب کن.',
    'نام کانفیگ باید بین ۶ تا ۶۴ کاراکتر باشه و فقط می‌تونه شامل حروف انگلیسی (A-Z, a-z)، اعداد (0-9)، نقطه (.)، آندرلاین (_) و خط تیره (-) باشه. فاصله، حروف و اعداد فارسی/عربی و هر کاراکتر دیگه‌ای قابل استفاده نیست. مثلاً ERRF01، ERRF_Pro، ERRF-Pro و ERRF.Service همگی قابل قبول هستند.',
    'هر وقت خواستی با «بازگشت به منو» یا /cancel بیرون بیا.',
  ].join('\n'),
  buyWaitingConfigName:
    'زیبا لطفا یه نام بین ۶ تا ۶۴ کاراکتری انتخاب کن؛ فقط حروف انگلیسی (A-Z, a-z)، اعداد (0-9)، نقطه (.)، آندرلاین (_) و خط تیره (-) مجازه — بدون فاصله. یا اگر می‌خوای من برات رندوم انتخاب کنم',
  configNameInvalid:
    '🙈 نام کانفیگ نامعتبره؛ باید بین ۶ تا ۶۴ کاراکتر باشه و فقط می‌تونه شامل حروف انگلیسی (A-Z, a-z)، اعداد (0-9)، نقطه (.)، آندرلاین (_) و خط تیره (-) باشه. فاصله، حروف و اعداد فارسی/عربی و هر کاراکتر دیگه‌ای قابل استفاده نیست. مثلاً ERRF01، ERRF_Pro، ERRF-Pro و ERRF.Service همگی قابل قبول هستند. دوباره تلاش کن یا «انتخاب خودکار» رو بزن.',
  configNameSaved: (name: string) =>
    `✅ نام کانفیگ «${name}» ثبت شد.`,
  buyInProgress: '🛒 خریدت نصفه مونده؛ ادامه بده یا با «بازگشت به منو» لغوش کن.',

  // Sections not yet implemented
  accountHeader: '👤 اطلاعات حساب شما',
  accountUsername: (v: string) => `نام کاربری: ${v}`,
  accountNone: '—',
  accountLanguage: (v: string) => `زبان تلگرام: ${v}`,
  accountSince: (v: string) => `تاریخ عضویت: ${v}`,
  accountStatusIdle: 'وضعیت: آماده ✅',
  accountStatusBusy: 'وضعیت: وسط یک فرآیندی؛ با /cancel می‌تونی برگردی.',

  cancelled: '↩️ به منوی اصلی بازگشتید.',
  sessionExpired: '⏱️ مرحله‌ی قبلی‌ات منقضی شده بود؛ با منوی اصلی ادامه می‌دیم.',

  invalidChoice: '❌ این گزینه نامعتبره؛ از گزینه‌های همین مرحله یکی رو انتخاب کن.',
  backToMenu: '🔙 بازگشت به منو',
  // Phase 8B: the OFF-TOPIC global fallback — used ONLY for input/no media
  // that falls outside every defined flow context (never inside a live step,
  // payment, support or admin handling). Byte-frozen by tests/phase8b.
  idleInputHint:
    'مشتی من رباتماا😅 نمیتونم مثل شما حرف بزنم بی زحمت از منوی موجود استفاده کن،دمت گرم',
  // A mere back-tap while nothing is pending: soft nudge, not the fallback.
  idleMenuNudge: '😊 چیزی باز نیست؛ از منوی پایین هر چی خواستی انتخاب کن.',

  // ————— Phase 3: purchase options, summary, confirmation —————
  catalogUnavailable:
    '🔧 یه لحظه رفیق، گزینه‌ها درست بارگذاری نمی‌شن؛ کمی بعد دوباره سر بزن.',
  volumePrompt: (min: number, max: number) =>
    `📦 حجم سرویس رو انتخاب کن.\n\nحداقل ${min} و حداکثر ${max} گیگابایت.\nبرای مقدار دلخواه، عدد رو تایپ کن (یا دکمه‌ی «دلخواه»).`,
  durationPrompt: (min: number, max: number, allowCustom = true) =>
    `⏳ مدت سرویس رو انتخاب کن.\n\n${durationLabelFa(min)} تا ${durationLabelFa(max)}.` +
    (allowCustom ? '\nبرای مقدار دلخواه، عدد روز رو تایپ کن.' : ''),
  devicePrompt: (min: number, max: number, allowCustom = true) =>
    `📱 تعداد دستگاه‌های مجاز رو انتخاب کن:\n\nبین ${min} تا ${max}.` +
    (allowCustom ? '\nبرای مقدار دلخواه، عدد رو تایپ کن.' : ''),
  customVolumeLabel: '✍️ مقدار دلخواه',
  customHint: '✍️ حالا عدد دلخواهت رو همین‌جا تایپ کن و بفرست.',
  rejectedRange: (min: number, max: number) =>
    `⚠️ این عدد باید بین ${min} تا ${max} باشه.\nیه عدد دیگه امتحان کن یا «بازگشت» رو بزن.`,
  // Phase 8B: flow-specific rejections — each step answers in its own domain.
  rejectedVolumeRange: (got: number, min: number, max: number) =>
    `📦 دِ آخه مشتی ${got} گیگ؟ 😅 حداقل خرید ${min} گیگه زیبا؛\nیه عدد بین ${min} تا ${max} گیگ وارد کن یا «بازگشت» رو بزن ❤️`,
  rejectedDurationRange: (min: number, max: number) =>
    `⏳ مدت سرویس باید بین ${min} تا ${max} روز باشه.\nیه عدد دیگه امتحان کن یا «بازگشت» رو بزن.`,
  rejectedDeviceRange: (min: number, max: number) =>
    `📱 تعداد دستگاه باید بین ${min} تا ${max} باشه.\nیه عدد دیگه امتحان کن یا «بازگشت» رو بزن.`,
  rejectedPresetDisabled: '⚠️ این گزینه فعلاً تو فهرست نیست؛ یکی از دکمه‌های موجود رو انتخاب کن.',
  rejectedNotWhole: '✍️ این که عدد نبود رفیق! فقط یک عدد صحیح بفرست؛ یا «بازگشت» رو بزن.',
  staleChoice: '🔄 این دکمه مال یه مرحله‌ی دیگه‌ست؛ اول همین مرحله رو ادامه بده.',
  stepBack: '↩️ بازگشت به مرحله قبل',
  confirmYes: '✅ تأیید و ثبت سفارش',

  summaryHeader: '🧾 خلاصه سفارش',
  summaryName: (v: string) => `🏷 نام کانفیگ: ${v}`,
  summaryVolume: (gb: number) => `📦 حجم: ${gb} گیگابایت`,
  summaryDuration: (days: number, months: number) =>
    `⏳ مدت: ${days} روز (${months} ماه)`,
  summaryDevices: (n: number) => `📱 دستگاه: ${n}`,
  summaryPrice: (v: string) => `💰 قیمت کل: ${v}`,
  summaryId: (id: string) => `🆔 کد سفارش: ${id}`,
  summaryHint: 'همه‌چیز اوکیه؟ «تأیید» رو بزن؛ برای ویرایش «بازگشت».',

  orderCreated: (id: string) =>
    `✅ سفارش شما ثبت شد!\n\n🆔 کد: ${id}\n\n👇 اطلاعات واریز رو توی پیام بعدی می‌فرستم.`,
  orderConfirmToast: '✅ سفارش ثبت شد.',
  alreadyConfirmed: '✅ این سفارش قبلاً ثبت شده است.',

  paymentWaitNotice:
    '⏳ فیش پرداختت در انتظار بررسیشه؛ نگرانش نباش.\n\n💡 اگه فیش اشتباه اومده، تصویر/فایل جدیدی بفرست تا جاش بیاد.\nبرای پیگیری، وضعیتش رو از «💳 سفارش‌های من» ببین.',

  missingDraftData: '⚠️ اطلاعات سفارش کامل نیست؛ از اول شروع کن.',

  // ————— Phase 4: payment, receipts, admin review —————
  paymentInstructionsHeader: '💳 اطلاعات واریز وجه',
  paymentHolder: (v: string) => `👤 به نام: ${tgEscapeHtml(v)}`,
  // Phase 8C: the card line is only ever rendered in the HTML payment
  // instructions bubble; the value arrives raw and becomes tap-to-copy code.
  paymentCard: (v: string) => `🏦 شماره کارت: ${tgCode(v)}`,
  paymentIban: (v: string) => `IBAN: ${tgCode(v)}`,
  paymentAmountLine: (v: string) => `💰 مبلغ قابل واریز: ${v}`,
  paymentReceiptPrompt:
    '🧾 مبلغ دقیق سفارش رو به شماره کارت ذکرشده واریز کن.\nبعد از واریز، تصویر یا فایل فیش پرداخت رو همین‌جا توی گفتگو بفرست.\n\n🔎 بررسی فیش دستیه؛ ممکنه کمی زمان ببره.',
  paymentCopyHint: '📋 برای کپی کردن شماره کارت، فقط یک بار روی شماره کارت بزن.',
  paymentInfoUnavailable:
    '⚠️ اطلاعات واریز فعلاً در دسترس نیست؛ برای ادامه با پشتیبانی در ارتباط باش.',
  // Phase 8C: shown at most once per message, only when a <code> value is in it.
  copyHint: '(یک بار بزن روی مقدار، کپی می‌شه)',

  receiptAccepted:
    '✅ فیش پرداختت ثبت شد و برای بررسی ارسالش کردیم.\n\nپرداختت دستی بررسی می‌شه و به محض تأیید، بقیه مراحل خودکار انجام می‌شن. 🚀\n\nنگران نباش رفیق؛ اگر بررسی پرداخت طول بکشه، هر ۱۵ دقیقه به ادمین یادآوری می‌کنم که سفارشت از یادش نره. 😄\n\nبعد از تأیید هم نتیجه رو همینجا بهت خبر می‌دم. ❤️',
  receiptReplaced:
    '✅ فیش جدید جایگزین شد و دوباره برای بررسی ارسال شد.\n\nصف بررسی از همون فیش اول حساب می‌شه؛ لازم نیست دوباره فیش بفرستی.',
  receiptExpectedMedia: '🧾 فیش رو به‌صورت تصویر یا فایل (برگردان فیش) بفرست؛ متن به‌تنهایی فیش حساب نمی‌شه.',
  receiptOrderMissing: '⚠️ سفارشی مرتبط با این گفتگو پیدا نشد؛ از منوی خرید دوباره شروع کن.',
  receiptOrderNotPayable: '⚠️ این سفارش دیگه تو مرحله‌ی ارسال فیش نیست؛ وضعیتش رو از «💳 سفارش‌های من» ببین.',

  // ————— Phase 8C: payment review reminders (15/30/45 min, max 3) —————
  // Persona rules: three DISTINCT concise variants (never repeats itself),
  // ⏳-anchored, no greeting (the customer's own receipt is the previous
  // bubble), no invented promises beyond «به‌زودی», Persian digits.
  reminderCustomer1: (id: string) =>
    `⏳ رفیق، فیش سفارشت هنوز در حال بررسیه.\n\nنگران نباش ❤️ بررسی پرداخت دستیه و به محض تأیید، بقیه مراحل خودکار انجام می‌شن. الان یه یادآوری برای ادمین فرستادم که سفارشت از یادش نره. 😄\n\n🆔 سفارش: ${id}`,
  reminderCustomer2: (id: string) =>
    `⏳ رفیق، ببخشید بررسی فیش یکم طول کشیده 😅 هنوز در انتظار بررسیه و تأیید یا رد نشده.\n\nدوباره به ادمین یادآوری کردم که سفارشت رو بررسی کنه ❤️\n\n🆔 سفارش: ${id}`,
  reminderCustomer3: (id: string) =>
    `⏳ رفیق، بررسی فیشت طول کشیده و هنوز در انتظار بررسیه 🙏 می‌دونم معطل شدی.\n\nیه یادآوری آخر برای ادمین فرستادم که سفارشت رو بررسی کنه؛ نتیجه رو همین‌جا بهت خبر می‌دم ❤️\n\n🆔 سفارش: ${id}`,
  reminderAdminHeader: '⏰ یادآوری: این فیش‌ها هنوز در انتظار بررسی‌اند',
  reminderAdminEntry: (n: number, shortId: string, minutes: number) =>
    `${n}. 🆔 ${shortId} — ${minutes} دقیقه است در انتظار`,

  statusPendingPayment: '⏳ در انتظار پرداخت',
  statusAwaitingReview: '🔎 در انتظار بررسی فیش',
  statusApproved: '✅ تأییدشده — در انتظار راه‌اندازی',
  statusProvisioning: '⚙️ در حال راه‌اندازی سرویس',
  statusCompleted: '🟢 سرویس فعال شد',
  statusRejected: '❌ رد شده',
  statusFailed: '⚠️ ناموفق',
  statusCancelled: '🚫 لغو شده',

  ordersHeader: '🧾 سفارش‌های شما (جدیدترین‌ها)',
  ordersEmpty: 'هنوز سفارشی ثبت نکردی.\nاز منوی «🛒 خرید سرویس» شروع کن.',
  ordersEntry: (n: number, shortId: string, status: string, price: string, date: string) =>
    `${n}. 🆔 ${shortId} — ${status}\n   ${price} — ${date}`,

  notifyApproved: (id: string, amount: string) =>
    `درود زیبا، پرداخت شما تأیید شد!\n\n🆔 سفارش: ${id}\n💰 مبلغ: ${amount}\n\nسرویس شما به‌زودی ساخته می‌شه و اطلاعات اتصال رو براتون می‌فرستیم.`,
  notifyRejected: (id: string, reason: string) =>
    `❌ متأسفانه فیش پرداخت سفارش تأیید نشد.\n\n🆔 سفارش: ${id}\n📝 دلیل: ${reason}\n\nمی‌توانید دوباره خرید کنید یا با پشتیبانی گفتگو کنید.`,

  adminReceiptHeader: '🧾 فیش جدید برای بررسی',
  adminReceiptLine: (n: number, id: string, status: string, amount: string, uploader: string) =>
    `${n}. 🆔 ${id}\n   ${status} — ${amount}\n   ${faAdmin.payerLine(uploader)}`,
  adminProcessedApprove: (id: string, adminId: string) =>
    `✅ تأیید شد\n🆔 ${id}\nبررسی‌کننده: ${adminId}`,
  adminProcessedReject: (id: string, adminId: string) =>
    `❌ رد شد\n🆔 ${id}\nبررسی‌کننده: ${adminId}`,
  adminProcessedStale: (id: string) => `ℹ️ سفارش ${id} قبلاً بررسی شده است.`,
  adminQueueHeader: '🗂 فیش‌های در انتظار بررسی',
  adminQueueEmpty: '🎉 در حال حاضر فیشی در انتظار بررسی نیست.',
  adminRejectPromptMsg:
    '⌨️ دلیل رد را بنویسید و بفرستید.\n\nاین دلیل برای مشتری ارسال می‌شود؛ یا دکمه‌ی «رد بدون دلیل» را بزنید.',
  adminRejectDefaultReason: 'پرداخت تأیید نشد.',
  adminApprovedToast: '✅ سفارش تأیید شد.',
  adminRejectedToast: '❌ سفارش رد شد.',
  adminStaleToast: 'این سفارش قبلاً بررسی شده است.',
  adminRejectCancelled: '↩️ رد سفارش لغو شد.',
  cmdAdminOnly: '❌ این دستور در دسترس شما نیست.',

  paymentVerifiedByLabel: (v: string) => `بررسی‌کننده: ${v}`,
  paymentReferenceLine: (v: string) => `🧾 مرجع پرداخت: ${v}`,

  // ————— Phase 5: automatic provisioning (PasarGuard) —————
  // Phase 9 (approved UX): the SAME panel link IS the customer's dedicated
  // service page — the bot only points at it (discovery/presentation), it
  // never builds a page or promises content the panel doesn't own.
  serviceReady: (id: string, url: string) =>
    `🎉 سرویس شما ساخته و فعال شد!\n\n🆔 سفارش: ${id}\n🔗 لینک اشتراک:\n${tgCode(url)}\n${fa.copyHint}\n\nاین لینک رو توی اپ خودت (v2rayNG / Nekobox / Streisand و…) وارد (import) کن.\n\n⚠️❌لطفا به چند کاربره بودن سرویس خود توجه داشته باشید،اگر تک کاربره خرید کردین، مجاز به استفاده از آن در فقط یک دستگاه (یک اپ، یک کلاینت) هستید. و اگر بیشتر از یک دستگاه(اپ) استفاده کنید خطا خواهد داد.با تشکر از همراهی شما🙏\n\n🌐 همین لینک، صفحه‌ی اختصاصی سرویست هست؛ هر وقت خواستی لینک و اطلاعات سرویست رو دوباره ببینی، همین‌جاست.`,
  serviceReadyWithoutLink: (id: string) =>
    `🎉 سرویس شما ساخته شد.\n\n🆔 سفارش: ${id}\n\nلینک اتصال فعلاً نمیاد؛ به‌زودی از «سرویس‌های من» در دسترس می‌شه. اگه عجله داری با پشتیبانی در ارتباط باش.`,
  provisionFailedNotice: (id: string) =>
    `⚠️ ساخت سرویسِ این سفارش چند بار به مشکل خورد.\n\n🆔 سفارش: ${id}\n\nبچه‌ها در جریانی و دارن پیگیری می‌کنن؛ لازم نیست دوباره پرداخت کنی.`,
  provisionNameRejectedNotice: (id: string) =>
    `⚠️ متأسفانه پنل، نامِ سرویسِ این سفارش را نپذیرفت.\n\n🆔 سفارش: ${id}\n\nنگران نباش؛ پرداختت کامل محفوظه و هیچ مبلغی دوباره کسر نمی‌شه. تیم ما به‌زودی با یه نام جدید تلاش می‌کنه. اگه عجله داری، می‌تونی با «انتخاب خودکار» یا یه نام انگلیسیِ تازه، سفارش جدیدی شروع کنی.`,
  adminProvisionFailed: (id: string, reason: string) =>
    `⚠️ ساخت سرویس ناموفق بود\n🆔 ${id}\n📝 ${reason.slice(0, 200)}\n\nبا دکمه‌ی زیر می‌توانید دوباره تلاش کنید (تا سقف مجاز).`,
  failedQueueHeader: '🧯 سفارش‌های ناموفقِ راه‌اندازی',
  failedQueueEmpty: '🎉 سفارش ناموفقی وجود ندارد.',
  failedQueueEntry: (n: number, id: string, reason: string, attempts: number) =>
    `${n}. 🆔 ${id}\n   ⚠️ ${reason.slice(0, 160)}\n   تلاش: ${attempts}`,
  adminRetryOkToast: '✅ سرویس ساخته شد.',
  adminRetryFailToast: '❌ تلاش مجدد هم ناموفق بود؛ جزئیات برای مدیران ارسال شد.',
  adminRetryStaleToast: 'این سفارش هم‌اکنون در حال پردازش یا تغییر وضعیت است.',
  adminRetryExhaustedToast: '🚫 سقف تلاش مجدد برای این سفارش پر شده است.',
  adminPanelUnavailableToast: '⚠️ پیکربندی پنل کامل نیست؛ بعداً دوباره تلاش کنید.',
  adminProvisionDisabledToast: '⚠️ ساخت خودکار سرویس فعلاً غیرفعال است.',
  adminProvisionDone: (id: string) => `🔁 نتیجه‌ی تلاش مجدد ثبت شد\n🆔 ${id}`,
  adminProvisionStale: (id: string) => `ℹ️ وضعیت سفارش ${id} تغییر کرده است؛ نیازی به این دکمه نیست.`,

  // ————— Phase 16: panel-service deletion (admin command, explicit confirm) —————
  // The admin surface is Persian-only by project decision; these live in the
  // bundle anyway so the EN mirror keeps its key contract (i18n.test pins
  // parity). Deletion is only EVER admin-initiated (or a reconciliation of a
  // delete already done on the panel) and never touches money/order rows.
  pdlUsage:
    '🗑 نحوه حذف سرویس از پنل:\n/panel_del <نام‌کاربریِ پنل یا شناسه 28 رقمیِ سفارش>',
  pdlNotFound: '🗑 سرویسِ قابل‌حذفی با این شناسه پیدا نشد (از قبل حذف شده یا هرگز پنلی نبوده).',
  pdlAlready: 'ℹ️ این سرویس قبلاً حذف (panel_deleted) شده است.',
  pdlCancelled: '↩️ حذف لغو شد؛ هیچ چیزی تغییر نکرد.',
  adminPdlConfirmHeader: (id: string) => `⚠️ تأیید حذف سرویس از پنل\n🆔 ${id}`,
  adminPdlCustomer: (tgId: string) => `👤 مشتری: ${tgId}`,
  adminPdlWarning:
    'این کار سرویس را روی پنل حذف می‌کند و قابل بازگردانی نیست.\nتاریخچه سفارش، پرداخت و تمدیدها در دیتابیس می‌ماند؛ فقط وضعیت سرویس «panel_deleted» می‌شود.',
  adminPdlDone: (id: string) =>
    `✅ سرویسِ سفارش ${id} از پنل حذف و در دیتابیس «panel_deleted» ثبت شد.\nپیام اطلاع‌رسانی برای مشتری ارسال شد.`,
  adminPdlAlreadyGone: (id: string) =>
    `✅ سرویسِ سفارش ${id} روی پنل نبود (حذف دستی پنل)؛ دیتابیس هم «panel_deleted» شد.`,
  adminPdlFailed: (id: string, reason: string) =>
    `⚠️ حذف سرویسِ سفارش ${id} انجام نشد.\n📝 ${reason}\nدیتابیس دست‌نخورده است؛ می‌توانید دوباره تلاش کنید.`,
  pdlToastDone: '🗑 حذف شد.',
  pdlToastFailed: '❌ حذف انجام نشد.',
  serviceRevokedNotice: (name: string) =>
    `🗑 سرویس «${name}» توسط پشتیبانی از پنل حذف شد.\n\nاگر به نظرتان این کار اشتباه بوده، از «🆘 پشتیبانی» یا «🎫 ثبت تیکت» با ما در تماس باشید.`,
  svcPanelGone: '🗑 این سرویس روی پنل دیگر وجود ندارد (حذف شده است).',
  serviceStatusDeleted: '🗑 حذف‌شده از پنل',

  // ————— Phase 6: My Services + status + renewals —————
  servicesHeader: '📦 سرویس‌های شما',
  servicesEmpty: 'هنوز سرویس فعالی نداری؛\nاز منوی «🛒 خرید سرویس» شروع کن.',
  serviceStatusActive: '🟢 فعال',
  serviceStatusExpiring: '⏳ رو به اتمام',
  serviceStatusExpired: '‼️ منقضی‌شده',
  serviceStatusUnknown: '⚪ نامشخص',
  servicesEntry: (n: number, name: string, shortId: string, status: string, expires: string) =>
    `${n}. 📦 ${name} — ${status}\n   🆔 ${shortId} — انقضا: ${expires}`,
  serviceNotFound: '🚫 سرویسی با این شناسه ندارید یا در دسترس نیست.',
  serviceBusyFirst: '🛑 اول همین مرحله رو کامل کن یا /cancel بفرست.',

  svcDetailHeader: (name: string) => `📦 سرویس «${name}»`,
  svcPanelActive: '🟢 فعال',
  svcPanelLimited: '🟡 محدود (حجم)',
  svcPanelExpired: '‼️ منقضی‌شده',
  svcPanelDisabled: '⛔ غیرفعال',
  svcPanelOnHold: '⏸ در انتظار',
  svcPendingRenewal: (shortId: string) => `🔁 تمدید در جریان: سفارش ${shortId}…`,
  svcToastPanel: '✅ وضعیت لحظه‌ای از پنل',
  svcToastSnapshot: '🖥 پنل در دسترس نبود؛ وضعیت محلی',
  svcId: (id: string) => `🆔 شناسه سرویس: ${id}`,
  svcPanelUsername: (v: string) => `👤 نام در پنل: ${v}`,
  svcCreated: (v: string) => `📅 ساخته‌شده: ${v}`,
  svcExpires: (v: string) => `⏳ تاریخ انقضا: ${v}`,
  svcDaysLeft: (days: number) => `⏳ باقی‌مانده: ${days} روز`,
  svcExpiredDaysAgo: (days: number) => `⚠️ ${days} روز پیش منقضی شده`,
  svcUsage: (used: string, total: string) => `📊 مصرف ترافیک: ${used} از ${total} گیگ`,
  svcLink: '🔗 لینک اشتراک:',
  // Phase 8C: the detail bubble opts into HTML so the URL is tap-to-copy.
  svcLinkCode: (url: string) => `${fa.svcLink}\n${tgCode(url)}\n${fa.copyHint}`,
  svcSnapshotNote: '🖥 پنل در دسترس نبود؛ اطلاعات از آخرین وضعیت محلی نشون داده می‌شه.',
  svcLiveNote: '🖥 وضعیت لحظه‌ای از پنل',

  renewDisabledNotice: '🔧 امکان تمدید فعلاً غیرفعال است.',
  renewRetiredNotice:
    '🔄 تمدید جدا حذف شده؛ برای همین سرویس از «🔄 خرید سرویس با مشخصات قبلی» استفاده کن.',
  renewInProgressNotice: (id: string) =>
    `🔁 یک درخواست تمدید برای این سرویس باز است.\n\n🆔 سفارش تمدید: ${id}\n\nوضعیت آن را از «💳 سفارش‌های من» پیگیری کنید.`,
  renewIntro: (name: string, expires: string) =>
    `🔄 تمدید / افزایش سرویس «${name}»\n\n📅 انقضای فعلی: ${expires}\n\nاول مدت اضافه را انتخاب کن (می‌توانی بدون تمدید رد شوی)، بعد حجم اضافه. قیمت دقیق همان قیمت خرید محاسبه می‌شود؛ پرداخت مثل خرید، با فیش و تأیید دستی یا کیف پول.`,
  renewDurationPrompt: '⏳ مدت اضافه را انتخاب کن:\n\nبدون تمدید • 1 ماه • 2 ماه • 3 ماه',
  renewNoDuration: '➖ بدون تمدید زمان',
  renewVolumePrompt: '📦 حجم اضافه را انتخاب کن:\n\n+10 • +20 • +30 گیگ، یا حجم دلخواه (حداقل 10 گیگ)، یا بدون افزایش حجم.',
  renewNoVolume: '➖ بدون افزایش حجم',
  renewSummaryHeader: '🧾 خلاصه‌ی تمدید',
  renewSummaryService: (name: string) => `📦 سرویس: «${name}»`,
  renewSummaryAdd: (months: number) => `➕ مدت تمدید: ${months} ماه`,
  renewSummaryNoTime: '➕ مدت اضافه: بدون تمدید',
  renewSummaryVolume: (gb: number) => `📦 حجم اضافه: ${gb} گیگابایت`,
  renewSummaryNoVolume: '📦 حجم اضافه: بدون افزایش',
  renewSummaryFrom: (v: string) => `📅 انقضای فعلی: ${v}`,
  renewSummaryUntil: (v: string) => `📅 انقضای جدید (تقریبی): ${v}`,
  renewConfirmed: (id: string) =>
    `✅ درخواست تمدید ثبت شد!\n\n🆔 کد: ${id}\n\n👇 اطلاعات واریز رو توی پیام بعدی می‌فرستم.`,
  renewApplied: (id: string, expiresDate: string) =>
    `🎉 سرویس شما تمدید شد!\n\n🆔 سفارش: ${id}\n📅 انقضای جدید: ${expiresDate}\n\nاز «📦 سرویس‌های من» می‌توانید وضعیت را ببینید.`,
  renewVolumeApplied: (id: string, addedGb: string) =>
    `🎉 حجم سرویس شما افزایش یافت!\n\n🆔 سفارش: ${id}\n📦 حجم اضافه‌شده: ${addedGb} گیگ\n\nاز «📦 سرویس‌های من» می‌توانید وضعیت را ببینید.`,
  renewEmptyError: '⚠️ لطفاً حداقل یکی را انتخاب کنید: تمدید زمان یا افزایش حجم.',
  renewFailedNotice: (id: string) =>
    `⚠️ تمدید سرویسِ این سفارش چند بار به مشکل خورد.\n\n🆔 سفارش: ${id}\n\nبچه‌ها در جریانی و دارن پیگیری می‌کنن؛ لازم نیست دوباره پرداخت کنی.`,
  adminRenewalFailed: (id: string, reason: string) =>
    `⚠️ تمدید سرویس ناموفق بود\n🆔 ${id}\n📝 ${reason.slice(0, 200)}\n\nبا دکمه‌ی زیر می‌توانید دوباره تلاش کنید (تا سقف مجاز).`,
  adminRenewalKind: (serviceId: string) => `🔄 تمدید سرویس ${serviceId}`,
  notifyApprovedRenewal: (id: string, amount: string) =>
    `🎉 پرداخت تمدید شما تأیید شد!\n\n🆔 سفارش: ${id}\n💰 مبلغ: ${amount}\n\nتمدید به‌زودی روی سرویس اعمال می‌شود.`,
  ordersKindRenewal: '(تمدید)',

  // ————— Phase 18: repurchase with previous specifications (same user) —————
  repEntryButton: '🔄 خرید سرویس با مشخصات قبلی',
  repBuyNewButton: '🛒 خرید سرویس جدید',
  repModeSame: '🔄 خرید با همان مشخصات قبلی',
  repModeCustom: '⚙️ شخصی‌سازی و خرید مجدد',
  repDisabledNotice: '🔧 امکان خرید مجدد فعلاً غیرفعال است.',
  repNotForFreeTest: '🎁 سرویس تستی قابل خرید مجدد نیست؛ از «🛒 خرید سرویس جدید» یک سرویس کامل بگیر.',
  repNotEligible: 'ℹ️ خرید مجدد فقط برای سرویس‌های منقضی‌شده یا تمام‌شده است.',
  repInProgressNotice: (id: string) =>
    `🔄 یک خرید مجدد برای این سرویس در حال پردازشه.\n\n🆔 سفارش خرید مجدد: ${id}\n\nتا وقتی این سفارش بازه، خرید مجدد دیگه‌ای نمی‌تونی شروع کنی. وضعیتش رو از «💳 سفارش‌های من» ببین؛ اگه ادمین این سفارش رو لغو کنه، خرید مجدد دوباره برات باز می‌شه.`,
  repModeIntro: (name: string, prev: string) =>
    `🔄 خرید مجدد سرویس «${name}»\n\n📦 مشخصات قبلی: ${prev}\n\nهمان سرویس فعلی بازنشانی و پیکربندی می‌شود؛ سرویس جدیدی ساخته نمی‌شود.`,
  repSummaryHeader: '🧾 خلاصه‌ی خرید مجدد',
  repSummaryService: (name: string) => `📦 سرویس: «${name}»`,
  repSummaryReuse:
    '♻️ همین سرویس فعلی استفاده می‌شود: مصرف صفر، سهمیه و انقضا تازه، لینک اتصال بدون تغییر باقی می‌ماند.',
  repSummaryFreshCycle: '🆕 چرخه‌ی جدید از لحظه‌ی فعال‌سازی شروع می‌شود.',
  repConfirmed: (id: string) =>
    `✅ درخواست خرید مجدد ثبت شد!\n\n🆔 کد: ${id}\n\n👇 اطلاعات واریز رو توی پیام بعدی می‌فرستم.`,
  repApplied: (id: string, expiresDate: string) =>
    `🎉 سرویس شما با موفقیت خرید مجدد شد!\n\n🆔 سفارش: ${id}\n📅 انقضای جدید: ${expiresDate}\n\nمصرف صفر شد و مشخصات تازه اعمال شد. از «📦 سرویس‌های من» می‌توانید وضعیت را ببینید.`,
  repFailedNotice: (id: string) =>
    `⚠️ خرید مجدد سرویسِ این سفارش چند بار به مشکل خورد.\n\n🆔 سفارش: ${id}\n\nبچه‌ها در جریانی و دارن پیگیری می‌کنن؛ لازم نیست دوباره پرداخت کنی.`,
  adminRepurchaseFailed: (id: string, reason: string) =>
    `⚠️ خرید مجدد سرویس ناموفق بود\n🆔 ${id}\n📝 ${reason.slice(0, 200)}\n\nبا دکمه‌ی زیر می‌توانید دوباره تلاش کنید (تا سقف مجاز).`,
  adminRepurchaseKind: (serviceId: string) => `🔄 خرید مجدد سرویس ${serviceId}`,
  notifyApprovedRepurchase: (id: string, amount: string) =>
    `🎉 پرداخت خرید مجدد شما تأیید شد!\n\n🆔 سفارش: ${id}\n💰 مبلغ: ${amount}\n\nسرویس فعلی به‌زودی بازنشانی و پیکربندی می‌شود.`,
  ordersKindRepurchase: '(خرید مجدد)',
  svcPendingRepurchase: (shortId: string) =>
    `🔄 خرید مجدد در جریانه: سفارش ${shortId}… تا بازه، خرید مجدد دیگه‌ای شروع نمی‌شه؛ با لغو ادمین دوباره باز می‌شه.`,
  repCancelButton: '❌ بستن/لغو خرید مجدد',
  repActiveLine: (id: string, status: string) =>
    `🔄 خرید مجدد در حال پردازش\n🆔 سفارش: ${id}\n📊 وضعیت: ${status}`,
  repCancelledDone: (id: string) =>
    `✅ خرید مجدد لغو شد.\n\n🆔 سفارش: ${id}\n\nحالا می‌تونی دوباره خرید مجدد رو شروع کنی رفیق.`,
  repCancelBlockedProvisioning:
    '⚠️ این خرید مجدد وارد مرحله‌ی راه‌اندازی شده و دیگه قابل لغو نیست.\n\nوضعیتش رو از «💳 سفارش‌های من» ببین؛ لازم نیست دوباره پرداخت کنی.',
  repCancelStale: 'ℹ️ این خرید مجدد قبلاً لغو یا بررسی شده.',
  adminRepurchaseQueueHeader: '🔄 خریدهای مجدد فعال (قفل سرویس)',
  adminRepurchaseQueueEmpty: '🎉 خرید مجدد فعالی نیست.',
  adminRepurchaseEntry: (n: number, id: string, status: string, mode: string, serviceId: string) =>
    `${n}. 🆔 ${id}\n   ${status} — ${mode}\n   🔒 سرویس: ${serviceId}`,
  adminRepurchaseCancelledToast: '✅ خرید مجدد لغو شد.',
  adminRepurchaseCancelStale: 'این خرید مجدد قبلاً لغو یا بررسی شده است.',
  adminRepurchaseProvisioningBlocked: '⚠️ راه‌اندازی شروع شده؛ لغو امن نیست.',
  adminRepurchaseLockLine: '🔒 این سفارش قفل خرید مجدد سرویس را نگه داشته است.',
  adminRepurchaseProvisioningLine: '⚠️ راه‌اندازی شروع شده — لغو امن نیست.',
  adminRepurchaseCancelledMsg: (id: string, adminId: string) =>
    `🗑 لغو شد\n🆔 ${id}\nلغوکننده: ${adminId}`,

  // ————— Phase 7: wallet + referrals + support + announcements (IRT/Toman) —————
  walletUnavailable: '🔧 کیف پول فعلاً در دسترس نیست رفیق؛ کمی بعد دوباره سر بزن.',
  walletHeader: '💰 کیف پول شما',
  walletBalance: (v: string) => `موجودی: ${v}`,
  walletEmpty: 'هنوز هیچ تراکنشی تو کیف پولت ثبت نشده.',
  walletEntry: (n: number, sign: string, kind: string, amount: string, date: string) =>
    `${n}. ${sign} ${amount} — ${kind}\n   ${date}`,
  walletKindReferralReward: '🎁 جایزه معرفی',
  walletKindAdminGrant: '➕ اعتبار هدیه',
  walletKindAdminDebit: '➖ کسر اعتبار',
  walletKindOrderPayment: '🛒 پرداخت سفارش',
  walletKindOrderRefund: '↩️ بازگشت اعتبار',
  walletKindTopupCredit: '➕ شارژ کیف پول',
  walletDebited: (v: string) => `✅ مبلغ ${v} از موجودی کیف پول کسر شد.`,
  walletGranted: (v: string) => `✅ مبلغ ${v} به کیف پول شما اضافه شد.`,
  walletAmountInvalid:
    '⚠️ مبلغ را صحیح و بدون نشانه‌ی اضافی بفرستید؛ یا «بازگشت» را بزنید.',
  walletAmountTooBig: (max: string) => `⚠️ حداکثر مقدار مجاز در هر عملیات: ${max}`,
  walletPromptAmount: (verb: string) =>
    `⌨️ مبلغ دلخواه (${verb}، به تومان) را با عدد صحیح بفرستید؛ برای انصراف «بازگشت به منو».`,
  walletBalanceLow: '⚠️ موجودی کیف پول کافی نیست.',
  walletTargetUser: (v: string) => `👤 کاربر هدف: ${v}`,

  payWalletFull: '💰 پرداخت کامل با کیف پول',
  payWalletPart: '🔅 کسر موجودی و پرداخت مابقی',
  summaryWalletLine: (v: string) => `👛 موجودی کیف پول شما: ${v}`,
  walletPayConfirmToast: '✅ پرداخت از کیف پول انجام شد.',
  walletPaidOrderCreated: (id: string, used: string) =>
    `🎉 سفارش شما همون لحظه از کیف پول پرداخت شد!\n\n🆔 کد: ${id}\n👛 از کیف پول: ${used}\n\nسرویس شما به‌زودی ساخته می‌شه و اطلاعات اتصال رو براتون می‌فرستیم.`,
  walletPaidRenewal: (id: string, used: string) =>
    `🎉 تمدید شما همون لحظه از کیف پول پرداخت شد!\n\n🆔 سفارش: ${id}\n👛 از کیف پول: ${used}\n\nتمدید به‌زودی روی سرویس اعمال می‌شه.`,
  walletPartialCreated: (id: string, used: string, rest: string) =>
    `✅ ثبت شد — ${used} از کیف پول کم شد.\n\n🆔 کد: ${id}\n💳 مانده قابل واریز: ${rest}\n\n👇 اطلاعات واریز رو توی پیام بعدی می‌فرستم.`,
  walletPartialRenewal: (id: string, used: string, rest: string) =>
    `✅ ثبت شد — ${used} از کیف پول کم شد.\n\n🆔 کد: ${id}\n💳 مانده قابل واریز: ${rest}\n\n👇 اطلاعات واریز رو توی پیام بعدی می‌فرستم.`,
  walletPaidRepurchase: (id: string, used: string) =>
    `🎉 خرید مجدد شما همون لحظه از کیف پول پرداخت شد!\n\n🆔 سفارش: ${id}\n👛 از کیف پول: ${used}\n\nسرویس فعلی به‌زودی بازنشانی و پیکربندی می‌شه.`,
  walletPartialRepurchase: (id: string, used: string, rest: string) =>
    `✅ ثبت شد — ${used} از کیف پول کم شد.\n\n🆔 کد: ${id}\n💳 مانده قابل واریز: ${rest}\n\n👇 اطلاعات واریز رو توی پیام بعدی می‌فرستم.`,
  notifyWalletRefunded: (id: string, amount: string) =>
    `ℹ️ مبلغ ${amount} از سفارشِ رد‌شده به کیف پول شما بازگشت.\n\n🆔 سفارش: ${id}`,
  adminRefundedLine: (amount: string) => `↩️ بازگشت به کیف پول مشتری: ${amount}`,

  // ————— Phase 17: customer wallet top-up (Toman; MIN 45,000, same IRT unit) —————
  topupButton: '➕ افزایش موجودی',
  topupPromptAmount: (min: string) =>
    `⌨️ مبلغ شارژ را به تومان بفرستید (حداقل ${min}).\n\nبرای انصراف «بازگشت به منو» را بزنید.`,
  topupAmountInvalid:
    '⚠️ مبلغ را صحیح و بدون نشانه‌ی اضافی بفرستید؛ یا «بازگشت» را بزنید.',
  topupAmountTooSmall: (min: string) => `⚠️ حداقل مبلغ شارژ: ${min}`,
  topupAmountTooBig: (max: string) => `⚠️ حداکثر مقدار مجاز در هر عملیات: ${max}`,
  topupAmountLine: (v: string) => `💰 مبلغ شارژ: ${v}`,
  topupReceiptPrompt:
    '🧾 مبلغ دقیق شارژ را به شماره کارت ذکرشده واریز کنید.\nبعد از واریز، تصویر یا فایل فیش پرداخت را همین‌جا توی گفتگو بفرستید.\n\n🔎 بررسی فیش دستی است؛ ممکن است کمی زمان ببرد.',
  topupSubmitted: (id: string) =>
    `✅ درخواست شارژ ثبت شد و برای بررسی ارسال شد.\n\n🆔 کد: ${id}\n\nنتیجه‌ی بررسی را همین‌جا به شما خبر می‌دهیم.`,
  topupReceiptReplaced: (id: string) =>
    `✅ فیش جدید جایگزین شد و دوباره برای بررسی ارسال شد.\n\n🆔 کد: ${id}`,
  topupWaitNotice:
    '⏳ درخواست شارژ شما در انتظار بررسی است؛ نگران نباشید.\n\n💡 اگر فیش اشتباه ارسال شده، تصویر/فایل جدیدی بفرستید تا جایگزین شود.',
  topupApproved: (id: string, amount: string) =>
    `🎉 شارژ کیف پول تأیید شد!\n\n🆔 کد: ${id}\n💰 مبلغ: ${amount}\n\nموجودی کیف پول شما به‌روز شد.`,
  topupRejected: (id: string, reason: string) =>
    `❌ متأسفانه درخواست شارژ تأیید نشد.\n\n🆔 کد: ${id}\n📝 دلیل: ${reason}`,
  topupReceiptMissing: '⚠️ درخواست شارژی مرتبط با این گفتگو پیدا نشد؛ از «💰 کیف پول» دوباره شروع کنید.',
  topupNotPayable: '⚠️ این درخواست شارژ دیگر در مرحله‌ی ارسال فیش نیست.',
  topupUserNotFound: '🚫 کاربری با این نام کاربری پیدا نشد.',
  adminTopupHeader: '🧾 درخواست شارژ کیف پول',
  adminTopupProcessedApprove: (id: string, adminId: string) =>
    `✅ شارژ تأیید شد\n🆔 ${id}\nبررسی‌کننده: ${adminId}`,
  adminTopupProcessedReject: (id: string, adminId: string) =>
    `❌ شارژ رد شد\n🆔 ${id}\nبررسی‌کننده: ${adminId}`,
  adminTopupQueueHeader: '🗂 درخواست‌های شارژ در انتظار بررسی',
  adminTopupQueueEmpty: '🎉 در حال حاضر درخواست شارژی در انتظار بررسی نیست.',
  adminTopupApprovedToast: '✅ شارژ تأیید و به کیف پول اضافه شد.',
  adminTopupRejectedToast: '❌ درخواست شارژ رد شد.',
  adminTopupStaleToast: 'این درخواست شارژ قبلاً بررسی شده است.',
  myId: (id: string) => `🆔 Telegram ID: ${id}`,

  // ————— Phase 21: /msg admin direct message (stateless, no D1 writes) —————
  msgUsage: '✉️ نحوه استفاده:\n/msg <شناسه تلگرام> <متن پیام>\n/msg @username <متن پیام>',
  msgSent: '✅ پیام ارسال شد.',
  msgSendFailed: '⚠️ ارسال پیام انجام نشد؛ بعداً دوباره تلاش کنید.',
  msgFromAdmin: (v: string) => `👑 از طرف ادمین\n\n${v}`,

  // ————— Phase 20: /users admin dashboard (Persian-only operational surface) —————
  // Clean control-panel copy: short headers, field lines reuse the existing
  // 🆔/👤/📅/💰/📦 conventions. No separators, no secrets, ASCII digits.
  usersDashboardHeader: '👑 مدیریت کاربران',
  usersDashboardUsers: (v: string) => `👥 کاربران: ${v}`,
  usersDashboardActiveServices: (v: string) => `🟢 سرویس‌های فعال: ${v}`,
  usersDashboardTotalServices: (v: string) => `📦 کل سرویس‌ها: ${v}`,
  usersDashboardActiveRepurchases: (v: string) => `🔄 خریدهای مجدد فعال: ${v}`,
  usersSearchHint:
    '🔎 برای جست‌وجو بفرستید:\n/users 123456789\n/users @username',
  usersNotFound: '🚫 کاربری با این مشخصات پیدا نشد.',
  usersUsage: '👥 نحوه استفاده:\n/users\n/users <شناسه تلگرام>\n/users @username',
  usersListHeader: '👥 کاربران',
  usersListEmpty: 'هنوز کاربری ثبت نشده است.',
  usersListPage: (page: string, pages: string) => `صفحه ${page} از ${pages}`,
  usersListEntry: (n: number, name: string, balance: string) =>
    `${n}. ${name} — ${balance}`,
  usersProfileHeader: (name: string) => `👤 ${name}`,
  usersProfileId: (v: string) => `🆔 شناسه: ${v}`,
  usersProfileName: (v: string) => `نام: ${v}`,
  usersProfileUsername: (v: string) => `یوزرنیم: ${v}`,
  usersProfileSince: (v: string) => `📅 عضویت: ${v}`,
  usersProfileBalance: (v: string) => `💰 موجودی: ${v}`,
  usersProfileServices: (v: string) => `📦 سرویس‌ها: ${v}`,
  usersServicesHeader: '📦 سرویس‌ها',
  usersServicesEmpty: 'این کاربر هنوز سرویسی ندارد.',
  usersServiceEntry: (n: number, name: string, status: string, expires: string) =>
    `${n}. 📦 ${name} — ${status}\n   انقضا: ${expires}`,
  usersServiceDetailHeader: (name: string) => `📦 سرویس «${name}»`,
  usersOrdersHeader: '🧾 سفارش‌ها',
  usersOrdersEmpty: 'این کاربر هنوز سفارشی ندارد.',
  usersOrderEntry: (n: number, shortId: string, kind: string, status: string, amount: string, date: string) =>
    `${n}. 🆔 ${shortId} — ${kind}${status}\n   ${amount} — ${date}`,
  usersWalletHeader: (name: string) => `💰 کیف پول ${name}`,
  usersWalletHint: 'برای شارژ یا کسر موجودی از /credit و /debit استفاده کنید.',
  usersRepurchasesHeader: '🔄 خریدهای مجدد فعال',
  usersRepurchasesEmpty: 'خرید مجدد فعالی برای این کاربر نیست.',
  usersBackUsers: '🔙 بازگشت به کاربران',
  usersBackProfile: '🔙 بازگشت به پروفایل',
  usersBackDashboard: '🔙 بازگشت',
  usersBtnUsers: '👥 کاربران',
  usersBtnSearch: '🔎 جست‌وجو',
  usersBtnServices: '📦 سرویس‌ها',
  usersBtnOrders: '🧾 سفارش‌ها',
  usersBtnRepurchases: '🔄 خریدهای مجدد',
  usersBtnWallet: '💰 کیف پول',
  usersBtnPrev: '◀️ قبلی',
  usersBtnNext: 'بعدی ▶️',
  usersBtnBackMenu: '🔙 بازگشت به منو',

  // ————— Phase 22: /users filter submenu (Persian-only operational surface) —————
  usersFilterHeader: '👥 فیلتر کاربران',
  usersFilterBack: '⬅️ بازگشت',
  usersFilterAll: (v: string) => `👥 همه کاربران (${v})`,
  usersFilterActive: (v: string) => `🟢 کاربران دارای سرویس فعال (${v})`,
  usersFilterPaywait: (v: string) => `⏳ کاربران با سفارش در انتظار پرداخت (${v})`,
  usersFilterReview: (v: string) => `🔎 کاربران با سفارش در انتظار بررسی (${v})`,
  usersFilterFailed: (v: string) => `⚠️ کاربران با سفارش ناموفق (${v})`,
  usersFilterDeleted: (v: string) => `🗑 کاربران دارای سرویس حذف‌شده (${v})`,
  usersFilterLabel(filter: string): string {
    switch (filter) {
      case 'active':
        return '🟢 سرویس فعال';
      case 'paywait':
        return '⏳ در انتظار پرداخت';
      case 'review':
        return '🔎 در انتظار بررسی';
      case 'failed':
        return '⚠️ ناموفق';
      case 'deleted':
        return '🗑 حذف‌شده از پنل';
      default:
        return '👥 همه کاربران';
    }
  },

  inviteHeader: '🤝 دعوت از دوستان',
  inviteLinkNone: (link: string) => `🔗 لینک دعوت شما:\n${link}`,
  inviteCount: (n: number) => `دعوت‌های موفق: ${n}`,
  inviteEarned: (v: string) => `مجموع جوایز: ${v}`,
  inviteHowTo: [
    'این لینک رو برای دوستت بفرست؛',
    'با اولین خرید تأییدشده‌ی اون، جایزه‌ی معرفی به کیف پولت اضافه می‌شه.',
  ].join('\n'),
  inviteRewardPercent: (v: string) => `🎁 پاداش هر معرفی موفق: ${v}٪ از مبلغ اولین خرید`,
  refNoticeJoined: (v: string) => `🌱 حساب شما با لینک دعوت ${v} ثبت شد.`,
  refPaidToReferrer: (amount: string, referee: string) =>
    `🎁 جایزه‌ی معرفی به کیف پول شما اضافه شد: ${amount}\nدعوتشده: ${referee}`,
  refPaidFromSide: (referee: string, amount: string) =>
    `🎉 دوستی که دعوت کرده‌اید خرید اولش انجام شد — جایزه ${amount} به او داده شد.`,
  referralUnavailable: '🔗 فعلاً امکان ساخت لینک دعوت وجود ندارد.',

  /** Direct contact with a human — creates no ticket, tracks nothing. */
  supportDirect: (url: string, ticketLabel: string) =>
    `🆘 پشتیبانی مستقیم\n\nبرای حرف زدن با پشتیبانی، این حساب رو توی تلگرام باز کن و پیامت رو بفرست:\n${url}\n\nهر وقت کارت به پیگیری نیاز داشت «${ticketLabel}» رو بزن تا تیکت ثبت بشه.`,
  /** Fail-closed twin: the operator has not set SUPPORT_CONTACT yet. */
  supportDirectNone: (ticketLabel: string) =>
    `🆘 فعلاً راه تماس مستقیم پشتیبانی توی تنظیمات ربات ثبت نشده.\n\nبرای پیگیری، «${ticketLabel}» رو بزن — همین‌جا جوابت رو میدیم.`,
  supportIntro: [
    '🎫 تیکت پشتیبانی',
    '',
    'مشکل یا پرسشت رو توی یه پیام بنویس و بفرست.',
    'جواب کارشناس معمولاً همین‌جا برات می‌رسه.',
    'برای برگشت، «بازگشت به منو» یا /cancel.',
  ].join('\n'),
  supportTicketCreated: (id: string) =>
    `📨 درخواستت ثبت شد.\n\n🎫 کد تیکت: ${id}\n\nهمین‌جا باخبرت می‌کنیم وقتی جواب بیاد.`,
  supportTicketExists: (id: string) =>
    `🎫 تیکت بازِ شما (${id.slice(0, 10)}…) هنوز فعال است.`,
  supportQueueChoice: '✍️ متن پیام جدید رو بفرست تا به کارشناس برسه.',
  supportAnswered: '💬 پاسخ پشتیبانی:\n\n',
  supportClosedNotice: '✅ تیکت بسته شد. اگه باز هم نیاز داشتی، «پشتیبانی» رو بزن.',
  supportTicketClosedAlready: 'ℹ️ این تیکت بسته شده است.',
  adminTicketNew: (customer: string, subject: string) =>
    `🆕 تیکت پشتیبانی\n👤 ${customer}\n📝 ${subject}`,
  adminTicketFollowup: (customer: string, subject: string) =>
    `✍️ پیام جدید مشتری\n👤 ${customer}\n📝 ${subject}`,
  adminTicketQueueHeader: '🗂 تیکت‌های باز پشتیبانی',
  adminTicketQueueEmpty: '🎉 تیکت بازی وجود ندارد.',
  adminTicketQueueEntry: (n: number, code: string, customer: string, subject: string, messages: number) =>
    `${n}. 🎫 ${code} — ${customer}\n   ${subject}\n   پیام‌ها: ${messages}`,
  adminTicketPrompt: '⌨️ پاسخ خود را بنویسید و بفرستید (حداکثر 2000 نویسه).',
  adminTicketSent: '✅ پاسخ برای مشتری ارسال شد.',
  adminTicketStale: 'این تیکت دیگر باز نیست یا پیدا نشد.',
  supportBusyFirst: '🛑 اول همین مرحله رو کامل کن یا /cancel بفرست.',
  ticketNotFound: '🚫 تیکتی با این شناسه پیدا نشد.',

  // ————— Phase 12: admin pricing management (Persian-only operational surface) —————
  adminPricingHeader: '💰 مدیریت قیمت‌ها',
  adminPricingLegend:
    'محصول پایه = 10 گیگ + 1 کاربر + 1 ماه.\n' +
    'قیمت ماه‌های بیشتر و هر تعداد کاربر، عدد مستقلِ انتخابیِ شماست؛ ' +
    'ربات هیچ ضریبی نمی‌سازد.',
  adminPricingFieldBase: (price: string) => `🧱 محصول پایه: ${price}`,
  adminPricingFieldGb: (price: string) => `⚖️ هر گیگ اضافه: ${price}`,
  adminPricingFieldMonth: (months: number, price: string) =>
    `📅 ${months} ماهه: ${price}`,
  adminPricingFieldUsers: (count: number, price: string) =>
    `👤 ${count} کاربر: ${price}`,
  adminPricingUserIncluded: 'داخل پایه',
  adminPricingPrompt: (label: string, current: string) =>
    `✏️ ${label}\nقیمت فعلی: ${current}\n\nمبلغ تازه را به تومان و فقط با عدد صحیح بفرستید؛ «بازگشت به منو» لغو می‌کند.`,
  adminPricingStaged: (label: string, value: string) =>
    `🧾 مقدار تازه برای «${label}»: ${value}\n\nبا «ثبت قیمت» تأیید کنید یا انصراف بدهید.`,
  adminPricingConfirmToast: '✅ قیمت جدید ثبت شد.',
  adminPricingAppliedLine: (label: string, value: string) =>
    `✅ ثبت شد — ${label}: ${value}`,
  adminPricingAmountInvalid:
    '⚠️ مبلغ را درست بفرستید؛ فقط رقم (فارسی یا انگلیسی)، بدون نشانه و بدون اعشار.',
  adminPricingAmountRejected:
    '⚠️ این مقدار برای این فیلد مجاز نیست (0 تا 1,000,000,000؛ قیمت پایه و هر گیگ باید بیش از صفر باشد).',
  adminPricingConflict:
    '⚠️ همین حالا مدیر دیگری قیمت را تغییر داد؛ این ویرایش بی‌اثر ماند. فهرست تازه را ببینید.',
  adminPricingStale: '🔄 این درخواست ویرایش منقضی یا بی‌اثر شده است.',
  adminPricingFieldGone: '⚠️ این فیلد دیگر در پیکربندی نیست؛ فهرست تازه را ببینید.',
  adminPricingUnavailable: '⚠️ پیکربندی قیمت‌ها معتبر نیست؛ اصلاح مستقیم در دیتابیس لازم است.',
  adminPricingCancelled: '↩️ ویرایش قیمت لغو شد.',
  adminPricingHint: 'عدد را تایپ کنید یا روی فیلدی بزنید.',

  announceIntro: '📢 متن اطلاعیه را بفرستید (حداکثر 2000 نویسه).',
  announceTooLong: '⚠️ متن اطلاعیه بیش از حد مجاز است؛ کوتاه‌تری بفرستید.',
  announceConfirmPrompt: (n: number) =>
    `📩 این اطلاعیه به حدود ${n} کاربر ارسال شود؟`,
  announceCreated: (id: string) =>
    `📤 اطلاعیه ثبت شد و ارسال آغاز شد.\n🆔 ${id.slice(0, 10)}…`,
  announceProgress: (code: string, sent: number, total: number) =>
    `📊 اطلاعیه ${code} — ارسال‌شده: ${sent} از ${total}`,
  announceDone: (code: string, sent: number, failed: number) =>
    `✅ اطلاعیه ${code} کامل شد\nارسال‌شده: ${sent}${failed > 0 ? ` — ناموفق: ${failed}` : ''}`,
  announceQueueHeader: '🗂 آخرین اطلاعیه‌ها',
  announceQueueEmpty: 'هنوز اطلاعیه‌ای ارسال نشده است.',
  announceQueueEntry: (id: string, state: string, sent: number, total: number) =>
    `🆔 ${id.slice(0, 10)}… — ${state} — ${sent}/${total}`,
  announceStateSending: '⏳ در حال ارسال',
  announceStateDone: '✅ کامل',
  announceStale: '🔄 این اطلاعیه تغییر کرده یا قبلاً کامل ارسال شده است.',
  announceReceived: '📢 اطلاعیه',
  userBlocked: (id: string) => `🎫 تیکت ${id} دیگر فعال نیست؛ ارسال متوقف شد.`,

  // ————— Phase 13: sales stop switch (customer notice + admin surface) —————
  // The switch is a TEMPORARY COMMERCIAL STOP: new purchases and renewals
  // (anything that creates or extends a paid service) are refused with THIS
  // one voice; everything about existing services keeps working.
  salesStoppedNotice:
    '🛑 فعلاً ارائه سرویس متوقفه رفیق 😅\n\nیه کوچولو صبر کن، به‌زودی برمی‌گردیم ❤️\nهر وقت دوباره فعال شد، از همین منو می‌تونی سرویس بگیری.',
  adminSalesStateActive:
    '🛡 وضعیت سرویس: 🟢 فعال\nثبت سفارش خرید و تمدید باز است.',
  adminSalesStateStopped:
    '🛡 وضعیت سرویس: 🔴 متوقف\nثبت سفارش خرید و تمدید موقتاً بسته است؛ سرویس‌های فعال مشتری‌ها دست‌نخورده می‌ماند و سفارش‌های ثبت‌شده قبل از توقف مثل قبل قابل پرداخت و تأییدند.',
  adminSalesUpdated: (v: string) => `آخرین تغییر: ${v}`,
  adminSalesMalformed:
    '⚠️ سند تنظیمات «sales» معتبر نیست؛ فروش فعلاً باز فرض می‌شود. یک بار تغییر وضعیت، سند را اصلاح می‌کند.',
  adminSalesHint:
    'این کلید فروشِ سرویسِ جدید و تمدید را موقتاً می‌بندد (مثلاً وقتی ظرفیت پنل پر است). بقیه‌ی ربات، از جمله سرویس‌های فعال، پشتیبانی و اطلاعیه‌ها، کار می‌کنند.',
  adminSalesStoppedToast: '🛑 فروش سرویس متوقف شد.',
  adminSalesStartedToast: '🟢 فروش سرویس دوباره فعال شد.',
  adminSalesConflict:
    '⚠️ همین حالا مدیر دیگری وضعیت را تغییر داد؛ تازه‌ترین حالت نمایش داده می‌شود.',
  adminSalesSaveFailed: '⚠️ تغییر ذخیره نشد؛ وضعیت فعلی همین‌جا نشان داده می‌شود.',

  // ————— Phase 23: free-test stop switch (/stoptest) —————
  // TEMPORARY stop of NEW free-test requests only. Existing test services
  // (orders, claims, panel services, notifications) are never touched by the
  // switch — the claim gate is the single enforcement point.
  freeTestStoppedNotice:
    '🛑 رفیق، سرویس تست فعلاً متوقفه 😅\nبه‌محض اینکه دوباره فعالش کنیم، می‌تونی تستت رو بگیری ❤️',
  adminStoptestStateActive:
    '🎁 وضعیت تست رایگان: 🟢 فعال\nکاربران جدید می‌توانند تست رایگان بگیرند.',
  adminStoptestStateStopped:
    '🎁 وضعیت تست رایگان: 🔴 متوقف\nدرخواست‌های جدید تست مسدود است؛ تست‌های فعال فعلی دست‌نخورده می‌مانند.',
  adminStoptestUpdated: (v: string) => `آخرین تغییر: ${v}`,
  adminStoptestMalformed:
    '⚠️ سند تنظیمات «free_test» معتبر نیست؛ تست فعلاً در دسترس نیست و تغییر وضعیت بدون اصلاح سند ممکن نیست.',
  adminStoptestStoppedToast: '🛑 تست رایگان متوقف شد.',
  adminStoptestStartedToast: '🟢 تست رایگان دوباره فعال شد.',
  adminStoptestAlreadyStopped: 'تست رایگان از قبل متوقف است.',
  adminStoptestAlreadyStarted: 'تست رایگان از قبل فعال است.',
  adminStoptestConflict:
    '⚠️ همین حالا مدیر دیگری وضعیت را تغییر داد؛ تازه‌ترین حالت نمایش داده می‌شود.',
  adminStoptestSaveFailed: '⚠️ تغییر ذخیره نشد؛ وضعیت فعلی همین‌جا نشان داده می‌شود.',

  // ————— Phase 24: admin-configurable free-test volume (SI megabytes) —————
  // Canonical unit is the megabyte (1 MB = 1,000,000 B; 1 GB = 1000 MB).
  // Every surface renders the CURRENT settings.free_test volume — never a
  // hardcoded number. Per-order snapshots keep old services on old quotas.
  adminStoptestVolume: (v: string) => `📦 حجم تست: ${v}`,
  adminStoptestDuration: (v: string) => `⏱ مدت: ${v}`,
  adminStoptestDevices: (v: string) => `👤 دستگاه: ${v}`,
  stoptestChangeVolumeBtn: '📦 تغییر حجم تست',
  stoptestVolumePrompt:
    '⌨️ حجم جدید تست را با این دستور بفرستید:\n/stoptest vol 500MB\n\nمثال: 50MB ،500MB ،1GB ،2GB\nمحدوده مجاز: 1MB تا 100000MB ‏(GB معادل 1000MB‏).',
  stoptestVolumeInvalid:
    '⚠️ قالب نامعتبر است. مثال: /stoptest vol 500MB\nمحدوده مجاز: 1MB تا 100000MB ‏(GB معادل 1000MB‏)؛ تغییر نکرد.',
  stoptestVolumeApplied: (v: string) => `✅ حجم تست به ${v} تغییر کرد.`,

  // ————— Phase 9: service notifications + subscription-page discovery —————
  // The 8B rule for these two alerts: they open with «درود زیبا»، they are
  // once-per-service by construction, «سلام» never appears, copy is plain
  // text, and NOTHING is promised beyond the panel contract actually holds:
  // exhausted volume -> the panel puts the service in its own
  // «محدود (حجم)» state (never a invented «deletion»); duration renewal does
  // NOT add volume (the Phase 6 decision) — the notice must say so honestly.
  usageNotice: (name: string, percent: string, remainingGb: string) =>
    `درود زیبا، 📊 سرویس «${name}» به ${percent}٪ رسید — حدود ${remainingGb} گیگش باقی مونده.\n\nوقتی حجم تموم بشه، پنل سرویس رو در حالت «محدود (حجم)» می‌ذاره؛ تمدیدِ مدت حجم تازه اضافه نمی‌کند، پس اگه حجم بیشتری لازم داری سرویس تازه بخر یا از پشتیبانی راهنما بگیر.`,
  expiryNotice: (name: string, remaining: string, expiresAt: string) =>
    `درود زیبا، ⏳ سرویس «${name}» تا انقضا فقط ${remaining} فاصله داره — تاریخ انقضا: ${expiresAt}.\n\nهر وقت خواستی از «📦 سرویس‌های من» تمدیدش کن تا سرویست قطع نشه؛ صفحه‌ی اختصاصی سرویست هم از همین‌جا در دسترسه.`,
  serviceNoticeView: '👁 مشاهده سرویس',
  serviceNoticeList: '📦 سرویس‌های من',

  // My Services audit — explicit remaining volume + degraded-usage pointer.
  svcRemaining: (v: string) => `📥 باقی‌مانده حجم: ${v} گیگ`,
  svcUsageHintSnapshot: '🔄 برای دیدن مصرف لحظه‌ای، «بروزرسانی وضعیت» را بزن.',
  // Subscription-page discovery, shown wherever the URL itself is shown.
  svcPageNote:
    '🌐 همین لینک، صفحه‌ی اختصاصی سرویسه — اطلاعات اتصال و وضعیت سرویس همین‌جا هست.',
  svcOpenPage: '🌐 باز کردن صفحه سرویس',

  // ————— Phase 15: the one-time free test (100 MB / 1 day by default) —————
  // The offer targets ONE user who has NEVER claimed (DB claim row). The copy
  // quotes the volume/duration only through the pre-formatted slot strings —
  // numbers in the config can change without a byte of copy moving. Warm
  // opener rule: this is a standalone notice-like bubble → «درود» is allowed
  // on the expiry notice only, never on flow prompts or toasts.
  freeTestOffer: (mb: string, days: string) =>
    `🎁 یه هدیه برای کاربرای جدید!\n\nسرویسِ تستِ رایگان: ${mb} مگابایت ترافیک، ${days} — فقط یک‌بار برای هر کاربر، کاملاً مجانی.\n\nاگه می‌خوای امتحانش کنی، دکمه‌ی زیر رو بزن 👇`,
  freeTestCta: (mb: string, days: string) =>
    `🎁 هنوز تستِ رایگان نگرفتی؟ ${mb} مگابایت، ${days} — یک‌بار، مجانی. با دکمه‌ی زیر فعالش کن.`,
  freeTestBtnClaim: '🎁 فعال کردن تست رایگان',
  freeTestQueuedToast: '🎁 تستت داره آماده می‌شه…',
  freeTestCreated: (orderId: string) =>
    `🎁 درخواستِ تستِ رایگان ثبت شد!\nشناسه سفارش: ${orderId}\n\nبه‌محض آماده شدن، لینک اتصالش برات میاد؛ از «📦 سرویس‌های من» دنبالشی کن.`,
  freeTestAlready:
    '🎁 هر نفر فقط یک تستِ رایگان داره (همیشه) — سهم خودت مصرف شده.\n\nبرای ادامه می‌تونی از «🛒 خرید سرویس» یه سرویس اصلی بگیری؛ جزئیات همون تست پایین در دسترسه.',
  freeTestWait:
    '⏳ درخواستِ تستِ رایگان‌ت ثبت شده و هنوز نهایی نشده؛ کمی دیگه صبر کن و از «📦 سرویس‌های من» چکش کن.',
  freeTestUnavailable:
    '🙏 فعلاً امکان فعال‌سازی تستِ رایگان نیست؛ بعداً دوباره امتحان کن.',
  renewNotForFreeTest:
    '🎁 سرویسِ تستِ رایگان قابل تمدید نیست؛ وقتی تموم شد از «🛒 خرید سرویس» یک سرویس اصلی بگیر.',
  // Volume lines for sub-GB (test-class) services — unit-honest display.
  summaryVolumeMb: (mb: number) => `📦 حجم: ${mb} مگابایت`,
  svcUsageMb: (used: string, total: string) => `📊 مصرف ترافیک: ${used} از ${total} مگابایت`,
  svcRemainingMb: (v: string) => `📥 باقی‌مانده حجم: ${v} مگابایت`,
  // The dedicated free-test expiry notice (once-only, ~2h before the end —
  // the PAID 3-day usage/expiry set is never sent for a test service).
  freeTestExpiryNotice: (name: string, remaining: string, expiresAt: string) =>
    `درود زیبا، ⏳ به تستِ رایگانِ «${name}» فقط ${remaining} مونده — پایان: ${expiresAt}.\n\n🎁 این تست یک‌باره و قابل تمدید نیست؛ اگه راضی بودی، از «🛒 خرید سرویس» سرویس اصلی‌ات رو بردار ❤️`,
  // Phase 15b: free-test 90% usage notice (MB-honest; GB copy stays paid-only).
  freeTestUsageNotice: (name: string, percent: string, remainingMb: string) =>
    `درود زیبا، 📊 تستِ رایگانِ «${name}» به ${percent}٪ رسید — حدود ${remainingMb} مگابایتش باقی مونده.\n\n🎁 این تست یک‌باره و قابل تمدید نیست؛ اگه راضی بودی، از «🛒 خرید سرویس» سرویس اصلی‌ات رو بردار ❤️`,
  // Phase 15b: free-test quota-exhausted notice (binary event, no volumes).
  freeTestExhaustedNotice: (name: string) =>
    `😄 رفیق، حجم سرویس تستت «${name}» تموم شد.\n\nامیدوارم تستش برات خوب بوده باشه ❤️ اگه راضی بودی و خواستی ادامه بدی، می‌تونی از داخل ربات یه سرویس اصلی برای خودت تهیه کنی. 🚀\n\nاز منوی «🛒 خرید سرویس» می‌تونی شروع کنی.`,

  // ————— Phase 10: i18n — keyboard labels, the Account row, the selector —————
  // Main-menu labels moved here VERBATIM from menu.ts so the (en) bundle can
  // mirror them; the strings themselves are byte-frozen Phase 8A labels.
  menuBuy: '🛒 خرید سرویس',
  menuServices: '📦 سرویس‌های من',
  menuOrders: '💳 سفارش‌های من',
  menuAccount: '👤 حساب کاربری',
  menuWallet: '💰 کیف پول',
  menuInvite: '🤝 دعوت از دوستان',
  menuSupport: '🆘 پشتیبانی',
  menuTicket: '🎫 ثبت تیکت',
  // The selector button is deliberately BILINGUAL and locale-fixed: its label
  // is identical in both bundles and survives a switch at any moment.
  menuLanguage: '🌐 زبان / Language',
  langOptionFa: '🇮🇷 فارسی',
  langOptionEn: '🇬🇧 English',
  // Mid-flow keyboard controls (the composing-mode extras + inline cancel).
  btnAutoPick: '🎲 انتخاب خودکار',
  btnSkipReject: '❌ ثبت رد بدون دلیل',
  btnCancelInline: '❌ لغو',
  btnRenewService: '🔄 تمدید / افزایش سرویس',
  btnRefreshStatus: '🔄 بروزرسانی وضعیت',
  // Language picker + confirmation (each bundle names ITS OWN language —
  // the confirmation is sent in the newly selected language).
  languageIntro:
    '🌐 زبان ربات رو انتخاب کن.\n\nهر وقت خواستی می‌تونی همین‌جا عوضش کنی.',
  languageSet:
    '✅ زبان ربات به فارسی تنظیم شد.\n\nمنوی جدید همین‌جا جایگزین شد.',
  accountBotLanguage: (v: string) => `زبان ربات: ${v}`,
  accountLanguageFa: 'فارسی',
  accountLanguageEn: 'انگلیسی',
  // Proactive-notice fallback when a service row carries no config name.
  noticeServiceFallback: 'سرویس شما',

  // ————— Phase 11: connection guide — stateless, customer-facing screens —————
  // Store/platform/app names and the four link-button labels are deliberately
  // locale-FIXED (precedent: menuLanguage) — they are brand text. Body copy
  // follows the Phase 8B persona rules: no forced greeting in a how-to.
  menuGuide: '📚 راهنمای اتصال',
  guideIntro:
    '📚 راهنمای اتصال\n\nوصل شدن بیشتر از سه قدم کوتاه نیست:\n\n1) لینک اشتراکت را از «📦 سرویس‌های من» کپی کن\n2) اپِ مناسب دستگاهت را نصب کن\n3) لینک را در اپ import (وارد) کن و متصل شو\n\nاول بگو با چه دستگاهی می‌خواهی وصل شوی 👇',
  guidePlatformAndroid:
    '🤖 اتصال با اندروید\n\nیکی از این اپ‌ها را انتخاب کن؛ هر سه با لینک اشتراکِ ربات کار می‌کنند و راهنمای اتصالِ قدم‌به‌قدم دارند. برای بیشتر گوشی‌ها v2RayTun ساده‌تر است.',
  guidePlatformIos:
    '🍎 اتصال با آیفون (iOS)\n\nیکی از این دو اپ را از App Store نصب کن؛ هر دو لینک اشتراک را وارد (import) می‌کنند. V2Box انتخاب ساده‌تر است.',
  guidePlatformWindows:
    '🪟 اتصال با ویندوز\n\nبرای ویندوز از Throne استفاده کن — رایگان و متن‌باز؛ لینک اشتراک را مستقیم از صفحهٔ رسمی Releases می‌گیرد.',
  guideHowToApp: (app: string) => `📖 راهنمای اتصال — ${app}`,
  guideBtnPlay: '📥 Google Play',
  guideBtnStore: '🍏 App Store',
  guideBtnReleases: '⬇️ Releases',
  guideBtnGithub: '📦 GitHub',
  guideOtherApps: '↩️ انتخاب اپ دیگر',
  guideStepsTun: `📚 v2RayTun — اتصال در یک دقیقه

1. لینک اشتراکت را بردار: «📦 سرویس‌های من» → سرویس موردنظر → روی «لینک اشتراک» بزن تا کپی شود.
2. با دکمهٔ «📥 Google Play» پایین، اپ را نصب کن.
3. v2RayTun را باز کن، روی + بزن و «افزودن از کلیپ‌بورد» (import from clipboard) را انتخاب کن؛ چسباندن مستقیم لینک یا اسکن QR هم کار می‌کند.
4. برای پروفایل یک نام بگذار (مثلاً «سرویس من») و تأییدش کن.
5. پروفایل را انتخاب کن و دکمهٔ اتصال را بزن؛ وقتی اندروید برای برقراری VPN اجازه خواست، Allow را بزن.

وقتی شمارندهٔ ترافیک راه افتاد، متصلی. بقیهٔ تنظیمات را دست نزن — لینکت همه‌چیز را از قبل آماده دارد.`,
  guideStepsNg: `📚 v2rayNG — اتصال در یک دقیقه

1. لینک اشتراکت را بردار: «📦 سرویس‌های من» → سرویس موردنظر → روی «لینک اشتراک» بزن تا کپی شود.
2. این اپ در گوگل‌پلی نیست؛ مسیر رسمی همان گیت‌هاب است: با دکمهٔ «⬇️ Releases» پایین، فایل apk آخرین نسخه را بگیر و نصب کن. اگر اندروید هنگام نصب هشدار امنیت داد، مراحل روی صفحه را دنبال کن و مطمئن شو که نسخهٔ منتشرشده را از همان صفحهٔ رسمی Releases در گیت‌هاب 2dust/v2rayNG نصب می‌کنی.
3. وارد v2rayNG شو → منو (☰) → «Add subscription over URL».
4. لینک را بچسبان، برای گروه یک نام بگذار و تأیید کن تا سرورها بیایند.
5. یک سرور انتخاب کن و دکمهٔ ▶ اتصال را بزن؛ درخواست VPN اندروید را Allow کن.

تنظیمات پیش‌فرض را نگه دار — به‌جز این پنج قدم، کاری نداری.`,
  guideStepsNeko: `📚 NekoBox — اتصال در یک دقیقه

1. لینک اشتراکت را بردار: «📦 سرویس‌های من» → سرویس موردنظر → روی «لینک اشتراک» بزن تا کپی شود.
2. این اپ در گوگل‌پلی نیست؛ مسیر رسمی همان گیت‌هاب است: با دکمهٔ «⬇️ Releases» پایین، فایل apk آخرین نسخه را بگیر و نصب کن. اگر اندروید هنگام نصب هشدار امنیت داد، مراحل روی صفحه را دنبال کن و مطمئن شو که نسخهٔ منتشرشده را از همان صفحهٔ رسمی Releases در گیت‌هاب MatsuriDayo/NekoBoxForAndroid نصب می‌کنی.
3. NekoBox را باز کن؛ گزینهٔ افزودن کانفیگ را بزن و «وارد کردن با لینک» (import from link) را انتخاب کن، لینک را بچسبان — اسکن QR هم کار می‌کند.
4. اگر اپ نام خواست، برایش یک نام بگذار (مثلاً «سرویس من») و تأییدش کن.
5. کانفیگ را انتخاب کن و دکمهٔ اتصال را بزن؛ وقتی اندروید برای برقراری VPN اجازه خواست، Allow را بزن.

وقتی شمارندهٔ ترافیک راه افتاد، متصلی. بقیهٔ تنظیمات را دست نزن — لینکت همه‌چیز را از قبل آماده دارد.`,
  guideStepsV2box: `📚 V2Box — اتصال در یک دقیقه

1. روی آیفون لینک اشتراکت را بردار: «📦 سرویس‌های من» → سرویس موردنظر → روی «لینک اشتراک» بزن تا کپی شود.
2. با دکمهٔ «🍏 App Store» پایین V2Box را نصب کن.
3. + (بالا راست) → Subscribe → «Paste from clipboard» → یک نام بگذار و ذخیره کن.
4. پروفایل تازه را انتخاب کن و کلید بالای صفحه را روشن کن.
5. وقتی iOS برای افزودن پیکربندی VPN اجازه خواست، Allow را بزن — تنها همان یک بار.

سبز شدن وضعیت یعنی اتصال برقرار است.`,
  guideStepsStreisand: `📚 Streisand — اتصال در یک دقیقه

1. روی آیفون لینک اشتراکت را بردار: «📦 سرویس‌های من» → سرویس موردنظر → روی «لینک اشتراک» بزن تا کپی شود.
2. با دکمهٔ «🍏 App Store» پایین Streisand را نصب کن.
3. به بخش Configs (آیکون فهرست) برو → + → Subscription.
4. لینک را بچسبان، با همان نام پیشنهادی ذخیره‌اش کن.
5. کانفیگ تازه را به‌عنوان پروفایل فعال انتخاب کن، کلید اصلی را روشن کن و درخواست VPN را Allow کن.

رفت‌وشد ترافیک در نوار وضعیت یعنی آنلاین شدی.`,
  guideStepsThrone: `📚 Throne — اتصال در یک دقیقه

1. لینک اشتراکت را بردار: «📦 سرویس‌های من» → سرویس موردنظر → روی «لینک اشتراک» بزن تا کپی شود (در تلگرام دسکتاپ روی لینک راست‌کلیک و Copy).
2. با دکمهٔ «⬇️ Releases» پایین آخرین نسخه را بگیر — فایل نصبی؛ اگر نمی‌خواهی چیزی نصب شود، همان ZIP پرتابل کار می‌کند.
3. اگر ویندوز هنگام اجرا پیام SmartScreen داد، پیش از ادامه مطمئن شو که Throne را از همان صفحهٔ رسمی Releases دانلود کرده‌ای.
4. Throne را باز کن؛ برای افزودن پروفایل، نوع اشتراک/لینک را انتخاب کن و لینک را بچسبان.
5. سرور را انتخاب کن و اتصال را بزن؛ همان حالت پروکسی پیش‌فرض را نگه دار.

سبز شدن وضعیت داخل اپ یعنی ترافیک سیستم از مسیر امن می‌رود.`,

  // ————— Phase 10: label mappers that used to live as switches in handlers —————
  // Moved byte-for-byte (payments.ts `statusFa`, services.ts `panelStatusFa`,
  // wallet.ts `entryLabel`) so both bundles own their own strings.
  orderStatus(state: string): string {
    switch (state) {
      case 'pending_payment':
        return fa.statusPendingPayment;
      case 'awaiting_review':
        return fa.statusAwaitingReview;
      case 'approved':
        return fa.statusApproved;
      case 'provisioning':
        return fa.statusProvisioning;
      case 'completed':
        return fa.statusCompleted;
      case 'rejected':
        return fa.statusRejected;
      case 'failed':
        return fa.statusFailed;
      case 'cancelled':
        return fa.statusCancelled;
      default:
        return state;
    }
  },
  panelStatus(status: string): string {
    switch (status) {
      case 'active':
        return fa.svcPanelActive;
      case 'limited':
        return fa.svcPanelLimited;
      case 'expired':
        return fa.svcPanelExpired;
      case 'disabled':
        return fa.svcPanelDisabled;
      case 'on_hold':
        return fa.svcPanelOnHold;
      default:
        return status.slice(0, 24);
    }
  },
  walletKind(kind: string): string {
    switch (kind) {
      case 'referral_reward':
        return fa.walletKindReferralReward;
      case 'admin_grant':
        return fa.walletKindAdminGrant;
      case 'admin_debit':
        return fa.walletKindAdminDebit;
      case 'order_payment':
        return fa.walletKindOrderPayment;
      case 'order_refund':
        return fa.walletKindOrderRefund;
      case 'topup_credit':
        return fa.walletKindTopupCredit;
      default:
        return kind.slice(0, 24);
    }
  },
  // Phase 8B display-only reactions, absorbed into the bundle unchanged.
  reactionDevices: deviceReaction,
  reactionVolume: volumeReaction,
} as const;

/**
 * Admin-surface fragments that handlers used to build inline. The operational
 * surface is Persian-only by the Phase 10 decision, so these live OUTSIDE the
 * `Texts` contract and the English bundle stays byte-identical.
 */
export const faAdmin = {
  payerLine: (v: string) => `پرداخت‌کننده: ${v}`,
  walletUsage: (grant: boolean) => `${grant ? '/credit' : '/debit'} <شناسه تلگرام> <مبلغ>`,
  walletUsageExample: 'مثال: /credit 123456789 500000',
  walletVerbAdd: 'افزودن',
  walletVerbSub: 'کسر',
  uploaderFallback: 'کاربر',
  pricingLastEdit: (by: string, when: string) => `آخرین ویرایش: ${by} — ${when}`,
  pricingMonthGlyph: (index: number | null) => `📅${index}م`,
} as const;

/** The structural contract every language bundle must satisfy (Phase 10):
 *  same key set, string leaves widened from fa's `as const`, function shapes
 *  preserved exactly — a missing or mismatched English key is a compile error. */
export type Texts = {
  [K in keyof typeof fa]: [typeof fa[K]] extends [string] ? string : typeof fa[K];
};

/** Format integer money with ASCII thousands + currency word. */
export function formatPrice(amount: number, currency: string): string {
  const word = currency === 'IRT' ? 'تومان' : currency === 'IRR' ? 'ریال' : currency;
  return `${amount.toLocaleString('en-US')} ${word}`;
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** ASCII digits → Persian (display only; storage/wire stay ASCII). */
export function digitsFa(value: number | string): string {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)] ?? d);
}

/** Duration display: whole months read as «X ماه», everything else keeps days. */
export function durationLabelFa(days: number, daysPerMonth = 30): string {
  const months = daysPerMonth > 0 ? days / daysPerMonth : NaN;
  if (Number.isSafeInteger(months) && months >= 1) {
    return `${months} ماه`;
  }
  return `${days} روز`;
}

/* ———— Phase 8B: display-only personality reactions ————
 * These NEVER validate or gate anything: business acceptance stays entirely
 * in the catalog `accept*` guards. A reaction only rides along on the NEXT
 * already-sent bubble (one line, no extra message, never consecutive).
 */

/** Generosity threshold for the volume wink. Display-only, not a rule. */
export const GENEROUS_VOLUME_GB = 20;

/** Device/user-count reaction; `null` = plain, unremarkable confirmation. */
export function deviceReaction(count: number): string | null {
  if (count <= 1) return null;
  if (count === 2) return 'دمت گرم، تک‌خور نیستی 😄 دوکاربره انتخاب کردی';
  if (count === 3) return 'ایول، سه‌کاربره انتخاب کردی 😄';
  return `${count} کاربره انتخاب کردی، چه تیم پرجمعیتی 😄`;
}

/** Volume reaction: only above the generosity threshold, never less. */
export function volumeReaction(gb: number): string | null {
  return gb > GENEROUS_VOLUME_GB ? 'عووو چه دست‌ودلباز، خوشمان آمد 😄' : null;
}

