-- Additive, versioned once by Wrangler. No secret values are copied to D1.
-- Existing origins, encrypted credentials, selection and every relationship remain intact.
ALTER TABLE panels ADD COLUMN credential_binding TEXT;
ALTER TABLE panels ADD COLUMN binding_fingerprint TEXT;
