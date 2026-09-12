-- Phase 4: payment receipt submission + manual admin approval.
-- Additive only; 0001-0003 untouched. Orders already carry the receipt /
-- verification columns (0001) and every needed enum state exists.

-- Payment instructions as a versioned settings doc (like the catalog):
-- the admin edits THIS row to change card/instructions — never a redeploy.
-- the admin edits THIS row to change card/instructions — never a redeploy.
UPDATE settings SET value = '{
  "schema": 1,
  "holder": "نام صاحب کارت (جای‌نما)",
  "card_number": "6037997100000000",
  "iban": null,
  "instructions": "مبلغ دقیق سفارش را به کارت زیر واریز کنید و سپس تصویر یا فایل فیش را در همین گفتگو بفرستید."
}' WHERE key = 'payment_info';
-- NOTE: card values above are PLACEHOLDERS for the admin to edit in D1.

-- One short-lived pending ADMIN action per admin (used for the
-- "reject → type a reason" step). Keyed by telegram user id (string).
CREATE TABLE IF NOT EXISTS admin_actions (
  admin_user_id TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  action        TEXT NOT NULL CHECK (action IN ('reject')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT NOT NULL
);
