-- =====================================================================
-- Refatrix ERP · 0166_ar_default_account
-- 「수금 기본계좌」: 매출 수금예정(AR·인보이스 자동 예정, 계좌미지정)은
-- 이 계좌로 입금된다고 간주한다 (2026-08-06 디렉터 확정: BBVA).
-- 현금잔액 워터폴의 계좌별 보기에서 수금예정이 이 계좌로 귀속된다.
-- =====================================================================

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ar_default BOOLEAN NOT NULL DEFAULT false;

-- 최대 1개만 true (부분 유니크 인덱스)
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_ar_default ON accounts (ar_default) WHERE ar_default = true;

-- 시드: 아직 지정이 없고, 이름이 정확히 'BBVA'인 활성 계좌가 1개면 그 계좌로 지정.
-- (다르면 재무 > 계좌 관리에서 디렉터가 직접 지정)
UPDATE accounts SET ar_default = true
 WHERE deleted_at IS NULL AND disabled IS NOT TRUE AND name = 'BBVA'
   AND (SELECT COUNT(*) FROM accounts WHERE deleted_at IS NULL AND disabled IS NOT TRUE AND name = 'BBVA') = 1
   AND NOT EXISTS (SELECT 1 FROM accounts WHERE ar_default = true);
