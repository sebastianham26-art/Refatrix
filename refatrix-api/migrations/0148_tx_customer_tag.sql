-- 0148: 거래(transactions) 고객 태그 + 운반비 인보이스 균등배분 테이블 — 매출출고 운반비(6160) P&L 귀속용
-- 재무>거래등록에서 계정과목이 '운반비(매출출고)'(6160)일 때:
--   · 고객만 태그 → transactions.customer_id 에 저장(그 고객 직접 귀속)
--   · 인보이스 1~N건 태그 → transaction_freight_allocations 에 거래금액을 건수로 균등 분할해 저장
--     (한 번의 배송비가 여러 인보이스/여러 고객 출고를 겸하는 실무 반영 — 디렉터 확정 2026-07-27)
--   · 미태그 → 손익 화면에서 기간 매출 비중으로 자동 배분(백엔드 계산)
--
-- ⚠ 기존 transactions.sales_invoice_id 재사용 금지:
--   그 컬럼이 붙은 거래는 시스템 전반이 "매출연계(AR 수금)"로 간주해
--   수정/삭제 잠금(sales_linked_readonly)·영업실적 집계에 얽힌다. 운반비 배분은 전용 테이블로 격리.
-- 멱등: IF NOT EXISTS — 재실행 안전.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES customers(id);
CREATE INDEX IF NOT EXISTS idx_txn_customer ON transactions (customer_id) WHERE customer_id IS NOT NULL;
-- 손익 집계가 (category_code, txn_date)로 좁혀 읽으므로 보조 인덱스 추가.
CREATE INDEX IF NOT EXISTS idx_txn_cat_date ON transactions (category_code, txn_date);

-- 운반비 지출 1건 → 인보이스 N건 균등 배분(스냅샷).
--   customer_id = 그 인보이스의 고객(조회 조인 절약용 스냅샷).
--   amount_mxn  = 거래 amount_mxn ÷ 선택 건수(마지막 행이 반올림 잔액 흡수 — 합계 = 거래금액 보장).
--   거래 금액 수정 시 백엔드가 균등 재분할(PATCH /api/transactions/:id).
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
