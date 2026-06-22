-- =====================================================================
-- Refatrix ERP · 0067_account_detail_flag
-- 계좌별 "거래내역(세부) 열람" 플래그 추가.
--   · can_detail=false  → 계좌·잔액은 보이되 거래내역(거래목록·현금흐름)은 숨김("잔액만")
--   · can_detail=true   → 거래내역까지 열람(기존 동작)
--   · 기존 행은 DEFAULT true → 현행 동작 보존(열람 권한자는 그대로 거래내역까지 봄).
--
-- 권한 레벨(인라인 드롭다운) 해석:
--   없음   = 행 없음
--   잔액만 = 행 있음, can_detail=false, can_operate=false
--   열람   = 행 있음, can_detail=true,  can_operate=false
--   운영   = 행 있음, can_detail=true,  can_operate=true
-- =====================================================================

ALTER TABLE user_account_access
  ADD COLUMN IF NOT EXISTS can_detail BOOLEAN NOT NULL DEFAULT true;
