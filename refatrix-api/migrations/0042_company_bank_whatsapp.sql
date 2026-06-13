-- =====================================================================
-- Refatrix ERP · 0042_company_bank_whatsapp
--   company_settings 확장: 수취은행 계좌(4칸) + WhatsApp QR 이미지
-- =====================================================================
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS bank_name    TEXT;   -- Banco
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS bank_account TEXT;   -- Cuenta
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS bank_clabe   TEXT;   -- CLABE
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS bank_holder  TEXT;   -- Beneficiario
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS whatsapp_qr  TEXT;   -- data:image/...;base64,...
