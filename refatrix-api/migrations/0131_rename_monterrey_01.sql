-- 0131: 영업팀 세분화 준비 — '01_Monterrey' → '01_Monterrey_01' 개명
--   Monterrey 내부를 01_Monterrey_01 / 01_Monterrey_02 로 나누기 위한 사전 개명.
--   id 는 그대로라 기존 고객(customers.team_id)·유저(users.team_id)·
--   실적·견적·매출 연결이 전부 유지됨(모두 team_id FK 기반, 이름 참조 아님).
--   01_Monterrey_02 는 팀 관리 화면에서 디렉터가 직접 생성(자동 추가).
-- 멱등: 이미 개명됐거나 해당 이름이 없으면 no-op(재실행 안전).
UPDATE sales_teams SET name = '01_Monterrey_01' WHERE name = '01_Monterrey';
