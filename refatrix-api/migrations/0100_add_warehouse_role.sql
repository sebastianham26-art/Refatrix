-- =====================================================================
-- Refatrix ERP · 0100_add_warehouse_role
-- 역할 'warehouse'(창고) 추가 — 입고·피킹·패킹 작업자 전용.
--   warehouse = 창고 그룹 화면만(다른 그룹 자동 숨김). 원가·매출액·계좌 미노출.
--   기본 페이지: 'warehouse'(창고 모듈). 디렉터가 사용자·권한에서 가감.
-- 멱등: DROP CONSTRAINT IF EXISTS 후 재생성. 재실행 안전.
-- (직전 role 목록 = 0074 기준 + 'warehouse' 추가)
-- =====================================================================

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('director','socio','treasury','marketing','ops','sales','sales_support','warehouse','viewer'));
