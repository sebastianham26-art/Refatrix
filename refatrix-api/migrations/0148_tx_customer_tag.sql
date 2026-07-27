-- 0148: 거래(transactions)에 고객·인보이스 태그 컬럼 추가 — 매출출고 운반비(6160)의 P&L 귀속용
-- 재무>거래등록에서 계정과목이 '운반비(매출출고)'(6160)일 때 고객(+선택: 그 고객의 인보이스)을
-- 태그해 저장하면, 손익 화면의 고객별/팀별 공헌이익 집계에서 그 고객에 직접 귀속된다.
-- 미태그(customer_id NULL) 운반비는 화면에서 기간 매출 비중으로 자동 배분(백엔드 계산).
--
-- ⚠ freight_invoice_id를 신설한 이유 — 기존 sales_invoice_id 재사용 금지:
--   sales_invoice_id가 붙은 거래는 시스템 전반이 "매출연계(AR 수금)"로 간주해
--   수정/삭제 잠금(sales_linked_readonly)·영업실적 집계 등에 얽힌다.
--   운반비 지출의 인보이스 귀속은 별도 컬럼으로 분리해 그 의미와 완전히 격리한다.
-- 멱등: IF NOT EXISTS — 재실행 안전.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES customers(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS freight_invoice_id BIGINT REFERENCES sales_invoices(id);
CREATE INDEX IF NOT EXISTS idx_txn_customer ON transactions (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_txn_freight_inv ON transactions (freight_invoice_id) WHERE freight_invoice_id IS NOT NULL;
-- 손익 집계가 (category_code, txn_date)로 좁혀 읽으므로 보조 인덱스 추가.
CREATE INDEX IF NOT EXISTS idx_txn_cat_date ON transactions (category_code, txn_date);
