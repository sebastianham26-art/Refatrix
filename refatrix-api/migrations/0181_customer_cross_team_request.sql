-- 0181: 타팀 고객 수정요청 권한
-- 디렉터가 사용자별로 켜는 권한. 켜져 있으면 자기 팀이 아닌 고객도
-- "수정 요청"을 넣을 수 있다(즉시 반영 아님 — 반드시 디렉터 승인을 거친다).
-- ⚠ 열람 범위는 확장하지 않는다. 고객 목록/상세/매출·미수 정보는 종전대로 팀 스코프 유지.
--    수정요청 화면에서 필요한 기본 항목(이름·RFC·연락처·팀·담당자 등)만 보인다.
ALTER TABLE users ADD COLUMN IF NOT EXISTS cross_team_request BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN users.cross_team_request IS
  '타팀 고객 수정요청 허용(디렉터 승인 필수). 열람 범위는 확장하지 않음.';
