-- 외상일(여신) 변경 요청: 활성 외상일(credit_days)과 분리해서 "요청값"을 보관.
-- 직원이 매출확정 단계에서 마스터와 다른 외상일을 요청하면 여기에 저장되고,
-- 활성 credit_days/due_date 는 디렉터 승인 전까지 그대로 유지된다(승인 시 적용).
ALTER TABLE sales_invoices
  ADD COLUMN IF NOT EXISTS credit_days_req INT,
  ADD COLUMN IF NOT EXISTS credit_req_by   BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS credit_req_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS credit_req_memo TEXT;

CREATE INDEX IF NOT EXISTS idx_sales_invoices_credit_req
  ON sales_invoices (credit_days_req) WHERE credit_days_req IS NOT NULL;
