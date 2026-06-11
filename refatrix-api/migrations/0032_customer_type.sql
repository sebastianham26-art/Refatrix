-- =====================================================================
-- Refatrix ERP · 0032_customer_type
-- 고객 회사 종류 구분: refraccionaria / Mayoreo / Flotia / taller / publico
-- =====================================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_type TEXT;
