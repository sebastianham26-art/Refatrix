-- =====================================================================
-- Refatrix ERP · 0074_add_socio_role
-- 역할 'socio'(소시오, 파트너) 추가.
--   director = 본인 전용(무제한).
--   socio    = 디렉터처럼 전 계좌 잔액·내역을 보되, 계좌별 '세부 열람/잔액만'을
--              디렉터가 사용자·권한 화면에서 지정. 관리(admin) 탭은 비디렉터라 자동 숨김.
-- 멱등: DROP CONSTRAINT IF EXISTS 후 재생성. 재실행 안전.
-- =====================================================================

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('director','socio','treasury','marketing','ops','sales','sales_support','viewer'));
