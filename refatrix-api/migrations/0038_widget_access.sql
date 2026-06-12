-- =====================================================================
-- Refatrix ERP · 0038_widget_access
-- 위젯 권한을 3단계로: none / view / edit.
-- enabled(boolean) → access(text)로 의미 확장. 기존 enabled=true는 'edit'로 간주.
-- 'view'만 가진 유저는 연결 화면도 읽기전용으로 잠김(서버가 화면 권한맵으로 내려줌).
-- =====================================================================

ALTER TABLE dashboard_widgets
  ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'edit'
  CHECK (access IN ('none','view','edit'));

-- 기존 데이터 정합: enabled=false면 none
UPDATE dashboard_widgets SET access='none' WHERE enabled = false AND access <> 'none';

-- 화면(페이지) 권한도 보기/수정 레벨을 가짐. 기존 권한은 모두 'edit'로 간주.
ALTER TABLE user_page_access
  ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'edit'
  CHECK (access IN ('view','edit'));
