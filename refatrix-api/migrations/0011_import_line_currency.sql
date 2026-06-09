-- =====================================================================
-- Refatrix ERP · 0011_import_line_currency
-- 수입 라인(SKU별 수입단가)에 통화 칸 추가.
-- 항목별 통화 + 입고일 환율 하나로 MXN 환산하기 위함.
-- (부대비용 통화는 import_overheads.currency 에 이미 존재)
-- =====================================================================
ALTER TABLE import_lines ADD COLUMN IF NOT EXISTS currency TEXT;
