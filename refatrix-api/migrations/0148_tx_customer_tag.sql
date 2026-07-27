-- 0148: 거래(transactions)에 고객 태그 컬럼 추가 — 매출출고 운반비(6160)의 고객별 P&L 귀속용
-- 재무>거래등록에서 계정과목이 '운반비(매출출고)'(6160)일 때 고객을 선택해 저장하면,
-- 손익(매출총이익) 화면의 고객별/팀별 공헌이익 집계에서 그 고객에 직접 귀속된다.
-- 미태그(customer_id NULL) 운반비는 화면에서 기간 매출 비중으로 자동 배분(백엔드 계산).
-- 멱등: IF NOT EXISTS — 재실행 안전.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES customers(id);
CREATE INDEX IF NOT EXISTS idx_txn_customer ON transactions (customer_id) WHERE customer_id IS NOT NULL;
-- 손익 집계가 (category_code, txn_date)로 좁혀 읽으므로 보조 인덱스 추가.
CREATE INDEX IF NOT EXISTS idx_txn_cat_date ON transactions (category_code, txn_date);
