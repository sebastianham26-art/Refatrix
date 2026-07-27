-- 0149: 운반비 인보이스 배분 테이블 보정 생성 (0148 파일 교체 이슈 해결)
-- 배경: 0148이 초기 버전(freight_invoice_id 단일 컬럼)으로 이미 적용된 DB에서는
--   파일명이 같아 마이그레이션 러너가 최종판 0148(배분 테이블 포함)을 건너뛴다
--   → transaction_freight_allocations 부재로 인보이스 태그 거래등록이 500.
-- 같은 내용을 새 번호(0149)로 재시드. 전부 멱등(IF NOT EXISTS/IF EXISTS)이라
--   신규 DB(0148 최종판 적용)에서는 no-op, 구버전 적용 DB에서는 누락분만 생성.

-- (1) 고객 태그 컬럼 보장
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES customers(id);
CREATE INDEX IF NOT EXISTS idx_txn_customer ON transactions (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_txn_cat_date ON transactions (category_code, txn_date);

-- (2) 인보이스 균등배분 테이블 보장
CREATE TABLE IF NOT EXISTS transaction_freight_allocations (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id   BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  sales_invoice_id BIGINT NOT NULL REFERENCES sales_invoices(id),
  customer_id      BIGINT NOT NULL REFERENCES customers(id),
  amount_mxn       NUMERIC(15,2) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, sales_invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_tfa_txn      ON transaction_freight_allocations (transaction_id);
CREATE INDEX IF NOT EXISTS idx_tfa_customer ON transaction_freight_allocations (customer_id);
CREATE INDEX IF NOT EXISTS idx_tfa_invoice  ON transaction_freight_allocations (sales_invoice_id);

-- (3) 초기 버전(0148 v2)이 만들었을 수 있는 단일 컬럼 정리(미사용) — 없으면 no-op
DROP INDEX IF EXISTS idx_txn_freight_inv;
ALTER TABLE transactions DROP COLUMN IF EXISTS freight_invoice_id;
