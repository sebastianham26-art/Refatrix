-- =====================================================================
-- Refatrix ERP · 0023_recurring_rules_extend
-- 고정비 반복 규칙 확장 + 생성된 예정거래 멱등 표시.
-- 규칙: 시작일 + 주기(월=일자 / 주=요일) + 종료월(없으면 무기한) + 통화·계좌·활성.
-- 생성: 오늘부터 24개월 지평까지 예정(plan) 거래. (rule_id, period) 유니크로 중복 방지.
-- =====================================================================

ALTER TABLE recurring_rules ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'MXN';
ALTER TABLE recurring_rules ADD COLUMN IF NOT EXISTS account_id BIGINT REFERENCES accounts(id);
ALTER TABLE recurring_rules ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE recurring_rules ADD COLUMN IF NOT EXISTS end_month TEXT;          -- 'YYYY-MM' 또는 NULL(무기한)
ALTER TABLE recurring_rules ADD COLUMN IF NOT EXISTS weekday INT;             -- 주 반복: 0(일)~6(토)
ALTER TABLE recurring_rules ADD COLUMN IF NOT EXISTS day_of_month INT;        -- 월 반복: 1~31
ALTER TABLE recurring_rules ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE recurring_rules ADD COLUMN IF NOT EXISTS memo TEXT;
ALTER TABLE recurring_rules ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id);

-- 생성된 예정거래 멱등 표시
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recurring_rule_id BIGINT REFERENCES recurring_rules(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recurring_period TEXT;       -- 'YYYY-MM' 또는 'WYYYY-MM-DD'

-- 같은 규칙·같은 기간 중복 생성 방지(부분 유니크)
CREATE UNIQUE INDEX IF NOT EXISTS uq_txn_recurring
  ON transactions (recurring_rule_id, recurring_period)
  WHERE recurring_rule_id IS NOT NULL;
