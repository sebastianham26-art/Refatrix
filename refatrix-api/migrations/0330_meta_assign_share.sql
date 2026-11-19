-- =====================================================================
-- 0330 · 영업사원 배분 — 비율(%) 방식 (2026-11-19 디렉터: 「%로 정하고 모두 할당되도록」)
--   mode = 'share' : 사람마다 비율(%) — 나눌 문의를 남김없이 그 비율대로(하루 상한 없음)
--   mode = 'target': 사람마다 하루 목표(건) — 목표가 차면 멈춤(0329 방식)
-- =====================================================================
ALTER TABLE meta_assign_settings ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'target';
ALTER TABLE meta_assign_settings DROP CONSTRAINT IF EXISTS meta_assign_settings_mode_chk;
ALTER TABLE meta_assign_settings ADD CONSTRAINT meta_assign_settings_mode_chk CHECK (mode IN ('target','share'));
ALTER TABLE meta_assign_members ADD COLUMN IF NOT EXISTS share_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE meta_assign_members DROP CONSTRAINT IF EXISTS meta_assign_members_share_chk;
ALTER TABLE meta_assign_members ADD CONSTRAINT meta_assign_members_share_chk CHECK (share_pct >= 0 AND share_pct <= 100);
