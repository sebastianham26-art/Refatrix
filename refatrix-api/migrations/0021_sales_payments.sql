-- =====================================================================
-- Refatrix ERP · 0021_sales_payments
-- 고객별 반제(입금 배분): 입금 한 건을 여러 미수 인보이스에 배분.
-- 과입금은 선수금으로 기록. 각 배분/선수금은 실제 입금 거래(transactions)로도 기록되어
-- 계좌 잔액에 반영된다.
-- =====================================================================

-- 입금 헤더
CREATE TABLE IF NOT EXISTS sales_payments (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id    BIGINT NOT NULL REFERENCES customers(id),
  pay_date       DATE NOT NULL,
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  amount         NUMERIC(15,2) NOT NULL,                 -- 받은 입금 총액(MXN)
  advance_amount NUMERIC(15,2) NOT NULL DEFAULT 0,       -- 과입금→선수금
  advance_txn_id BIGINT REFERENCES transactions(id),     -- 선수금 실제 거래
  memo           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT REFERENCES users(id)
);

-- 배분 명세(인보이스별)
CREATE TABLE IF NOT EXISTS sales_payment_allocations (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id     BIGINT NOT NULL REFERENCES sales_payments(id),
  invoice_id     BIGINT NOT NULL REFERENCES sales_invoices(id),
  amount         NUMERIC(15,2) NOT NULL,
  txn_id         BIGINT REFERENCES transactions(id),     -- 이 배분의 실제 입금 거래
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spa_invoice ON sales_payment_allocations (invoice_id);
CREATE INDEX IF NOT EXISTS idx_spa_payment ON sales_payment_allocations (payment_id);
CREATE INDEX IF NOT EXISTS idx_sp_customer ON sales_payments (customer_id);

-- transactions에 입금/선수금 종류 구분용(없으면 무방, kind 텍스트 컬럼 사용)
-- kind: 'general' | 'invoice'(AR예정) | 'payment'(입금배분) | 'advance'(선수금)

-- 선수금 계정과목(부채)
INSERT INTO categories (code, name, group_name, sort_order) VALUES
  ('2030','선수금','부채',25)
ON CONFLICT (code) DO NOTHING;
