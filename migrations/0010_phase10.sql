-- Phase 10: explicit user language preference.
-- Fully additive; 0001-0009 untouched. `language` stores ONLY an explicit
-- choice made through the in-bot selector ('fa' | 'en'). NULL means "never
-- chosen" — and per the Phase 10 decision, the bot then speaks PERSIAN
-- regardless of the stored Telegram `language_code` (the hint is display-only
-- on the Account screen, never a routing input). Existing users keep NULL and
-- see zero change: no backfill by design. CHECK allows NULL (SQLite).
ALTER TABLE customers ADD COLUMN language TEXT CHECK (language IN ('fa', 'en'));
