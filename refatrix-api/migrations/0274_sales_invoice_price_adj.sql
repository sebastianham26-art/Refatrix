-- 2026-10-13 · 매출확정 인보이스 매출액 수정(할인율·총액) 내역을 남겨 화면·엑셀에 보이게 한다.
--   price_adj_basis   : 마지막 수정 방식 'list'(정가 대비) | 'current'(현재 매출액에서 추가 할인) | 'total'(총액 직접 입력)
--   price_adj_rate    : 'list' = 정가 대비 할인율 / 'current' = 누적 추가 할인율(수정 전 매출액 대비) / 'total' = NULL
--   pre_adj_subtotal_mxn·pre_adj_total_mxn : 첫 수정 직전의 매출액(IVA 제외·포함) — 여러 번 고쳐도 처음 값 유지
--   sales_invoice_lines.pre_adj_unit_price : 첫 수정 직전의 품목 단가
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS price_adj_basis TEXT;
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS price_adj_rate NUMERIC(7,2);
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS pre_adj_subtotal_mxn NUMERIC(15,2);
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS pre_adj_total_mxn NUMERIC(15,2);
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS price_adj_at TIMESTAMPTZ;
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS price_adj_by BIGINT REFERENCES users(id);
ALTER TABLE sales_invoice_lines ADD COLUMN IF NOT EXISTS pre_adj_unit_price NUMERIC(15,2);
