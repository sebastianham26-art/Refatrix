-- =====================================================================
-- Refatrix ERP · 0115_recurring_private
-- 비공개 고정비: 디렉터만 보는 고정비 규칙.
-- recurring_rules.is_private=true 인 규칙과 그 규칙이 생성한 거래(transactions.is_private=true)는
-- 비디렉터의 고정비 목록·거래목록·예정내역·현금흐름·계획대비실적에서 전부 숨긴다.
-- =====================================================================

ALTER TABLE recurring_rules ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;

-- 비공개 거래만 부분 인덱스(대부분 false라 작음)
CREATE INDEX IF NOT EXISTS idx_txn_private ON transactions (is_private) WHERE is_private = true;

-- 안전 동기화: 이미 비공개인 규칙이 있다면 그 규칙의 거래도 비공개로 (재실행 안전)
UPDATE transactions t SET is_private = true
  FROM recurring_rules r
 WHERE t.recurring_rule_id = r.id AND r.is_private = true AND t.is_private = false;
