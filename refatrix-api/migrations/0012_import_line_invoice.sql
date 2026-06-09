-- =====================================================================
-- Refatrix ERP · 0012_import_line_invoice
-- 수입 라인(SKU별)에 매입 인보이스 번호 칸 추가.
-- 부대비용 인보이스(import_overheads.invoice_no)와는 별개의, 물건 매입 인보이스.
-- =====================================================================
ALTER TABLE import_lines ADD COLUMN IF NOT EXISTS invoice_no TEXT;
