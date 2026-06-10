-- =====================================================================
-- Refatrix ERP · 0017_cogs_adjustments_sales
-- 매출 수정·삭제에서 발생하는 정산차액/소급 정정을 cogs_adjustments에 기록할 수 있게 확장.
-- 기존 cogs_adjustments.doc_id 는 수입 부대비용(import_cost_docs) 전용 NOT NULL 이었음.
--   · doc_id 를 NULL 허용으로 변경(매출 출처는 doc_id 없음)
--   · sales_invoice_id 추가(매출 출처 연결)
--   · source 추가('import_cost' | 'sales_edit' | 'sales_delete')로 출처 구분
-- 정책: 정산차액은 여기에 기록만 하고, 실제 거래 전기는 거래·계좌 모듈(#13) 후속.
-- =====================================================================

ALTER TABLE cogs_adjustments ALTER COLUMN doc_id DROP NOT NULL;
ALTER TABLE cogs_adjustments ADD COLUMN IF NOT EXISTS sales_invoice_id BIGINT REFERENCES sales_invoices(id);
ALTER TABLE cogs_adjustments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'import_cost';
CREATE INDEX IF NOT EXISTS idx_cogsadj_sales ON cogs_adjustments (sales_invoice_id);
