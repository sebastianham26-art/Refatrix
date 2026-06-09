-- =====================================================================
-- Refatrix ERP · 0015_customer_credit_days
-- 고객 마스터에 기본 외상일(credit_days) 추가.
-- 매출 등록 시 입금 예정일 = inv_date + customers.credit_days 로 자동 계산.
-- 예외 외상일은 sales_invoices.credit_days(+미승인 꼬리표)로 별도 관리.
-- =====================================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_days INT NOT NULL DEFAULT 0;
