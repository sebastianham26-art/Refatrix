-- 0181: (더 이상 필요 없음 — 남겨두는 이유는 이미 적용된 DB가 있기 때문)
--
-- 처음에는 타팀 고객 수정요청 권한을 users.cross_team_request 컬럼에 저장했으나,
-- "코드는 배포됐는데 migrate 는 다른 DB에 돌아가는" 반쪽 배포 사고가 반복되어
-- 2026-08-24 에 **스키마 변경이 필요 없는 방식**으로 바꿨다.
--   → 권한은 기존 user_page_access 테이블에 page_key='cust_cross_req' 행으로 저장한다.
--     (permLoader.js 의 CROSS_TEAM_PAGE_KEY)
--
-- 아래 컬럼은 이제 아무 코드도 읽지 않는다. 이미 적용한 DB에서는 그냥 두면 되고,
-- 새 DB에서는 이 파일이 돌아도 무해하다(멱등).
ALTER TABLE users ADD COLUMN IF NOT EXISTS cross_team_request BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN users.cross_team_request IS
  '(미사용) 2026-08-24 부터 권한은 user_page_access.page_key=''cust_cross_req'' 로 관리한다.';
