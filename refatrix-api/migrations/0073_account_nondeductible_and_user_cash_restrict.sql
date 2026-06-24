-- =====================================================================
-- Refatrix ERP · 0073_account_nondeductible_and_user_cash_restrict
-- 기능 3) 디렉터여도 "현금계정·불공제 계좌"는 잔액만 보이고 세부내역(거래목록·현금흐름)을 차단.
--   ① accounts.non_deductible : 계좌를 '불공제'로 표시(불공제 매입 등). 기본 false.
--      ※ '현금'계정은 기존 accounts.type 으로 식별(type 에 '현금' 포함). 별도 컬럼 불필요.
--   ② users.restrict_cash_detail : 이 사용자는 디렉터여도 현금·불공제 계좌의
--      거래내역/현금흐름이 차단되고 잔액만 보임. 기본 false(=기존 동작 그대로).
--   - 잔액(재무/계좌 목록)은 계속 보임. 차단은 '세부내역'(거래목록·현금흐름·운영)만.
--   - 비디렉터는 기존 계좌별 권한(없음/잔액만/열람/운영)으로 이미 제어되므로 영향 없음.
-- 멱등(IF NOT EXISTS). 재실행 안전.
-- =====================================================================

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS non_deductible BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE users    ADD COLUMN IF NOT EXISTS restrict_cash_detail BOOLEAN NOT NULL DEFAULT false;
