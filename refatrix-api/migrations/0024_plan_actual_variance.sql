-- =====================================================================
-- Refatrix ERP · 0024_plan_actual_variance
-- 계획(예정) → 실적(실제) 전환 시 날짜·금액이 달라질 수 있음.
-- 계획값(plan_amount, plan_date)을 보존해 실적과 비교(절감/증가)하고,
-- 전환·수정 시 변경 횟수(change_count)와 메모(plan_memo)를 기록.
-- =====================================================================

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plan_amount NUMERIC(15,2);  -- 계획 금액(원통화)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plan_date   DATE;           -- 계획 날짜
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plan_memo   TEXT;           -- 변경 사유/이력 메모
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS change_count INT NOT NULL DEFAULT 0; -- 계획 대비 수정 횟수

-- 기존 예정 거래의 계획값 백필(현재 값이 곧 계획값)
UPDATE transactions SET plan_amount = amount WHERE plan_amount IS NULL;
UPDATE transactions SET plan_date = txn_date WHERE plan_date IS NULL;
