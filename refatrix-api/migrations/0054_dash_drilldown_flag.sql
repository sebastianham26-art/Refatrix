-- 영업대시보드 드릴다운 허용 여부(기본 허용). false면 대시보드의 세부 드릴다운
-- (매출 목록 보기·수금 계획 보기 링크, 고객 상세 모달)이 비활성화된다.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS dash_drilldown BOOLEAN NOT NULL DEFAULT true;

-- Armando: 대시보드는 기존 포맷대로 보되 세부 드릴다운만 차단
UPDATE users SET dash_drilldown = false
 WHERE deleted_at IS NULL AND (name ILIKE '%armando%' OR login_id ILIKE '%armando%');
