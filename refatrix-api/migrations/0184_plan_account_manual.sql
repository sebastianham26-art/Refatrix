-- 0184_plan_account_manual.sql  (2026-08-26)
-- 거래목록 > 예정 행 [계획 수정] 에서 「자금출처 계좌」를 개별 지정했을 때,
-- 나중에 그 고정비 규칙을 저장해도 그 회차의 계좌만은 덮어쓰지 않도록 하는 표식.
--
--  · false(기본) = 회차 계좌는 고정비 규칙을 따른다(기존 동작 그대로).
--  · true        = 사람이 이 회차만 다른 계좌로 지정했다 → PATCH /api/recurring/:id 의
--                  plan 회차 동기화에서 **계좌만** 건너뛴다(금액·계정과목은 계속 규칙을 따름).
--
-- 멱등: 재실행해도 안전. 기존 행은 전부 false 라 동작 변화 없음.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plan_account_manual boolean NOT NULL DEFAULT false;

-- 예정(plan) 회차에만 의미가 있는 표식이라 부분 인덱스로 충분(동기화 쿼리의 필터용).
CREATE INDEX IF NOT EXISTS idx_txn_plan_account_manual
  ON transactions (recurring_rule_id)
  WHERE plan_account_manual = true AND status = 'plan' AND deleted_at IS NULL;
