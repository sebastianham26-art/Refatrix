-- =====================================================================
-- Refatrix ERP · 0075_notice_popup_persist
-- 공지 팝업 '지속 유지' 옵션:
--   popup_persist=true  → 수신자가 확인할 때까지 모든 화면에서 팝업을 계속 표시(nav 공통).
--   popup_persist=false → 기존 동작(로그인/포털 팝업, '나중에'로 세션 보류 가능).
-- 멱등(IF NOT EXISTS). 기본 false 라 기존 공지는 동작 변화 없음.
-- =====================================================================

ALTER TABLE notices ADD COLUMN IF NOT EXISTS popup_persist BOOLEAN NOT NULL DEFAULT false;
