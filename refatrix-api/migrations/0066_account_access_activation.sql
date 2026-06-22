-- =====================================================================
-- Refatrix ERP · 0066_account_access_activation
-- 계좌별 사용자 권한(user_account_access) 활성화.
--   · 테이블은 0003에서 이미 생성됨(user_id, account_id, can_operate).
--   · 일부 프로덕션에는 (user_id, account_id) UNIQUE 제약이 빠져 있을 수 있어
--     여기서 UNIQUE 인덱스를 보강한다(없으면 추가, 있으면 그대로).
--   · 시드는 ON CONFLICT 대신 NOT EXISTS 가드를 써서 제약 유무와 무관하게 동작.
--
-- 시드 정책(현행 동작 보존 + 디렉터 의도 반영):
--   · 재무(transactions) 화면 권한이 있는 "비디렉터" 사용자에게
--     현재 모든 계좌의 "열람(view)" 권한을 부여(can_operate=false).
--     → 배포 직후 기존 직원이 보던 잔고가 사라지지 않음.
--   · "운영(거래등록/확정)" 권한은 자동 부여하지 않음(opt-in) → 대표가 직접 선택.
--   · 디렉터는 테이블과 무관하게 전체(코드에서 처리).
-- =====================================================================

-- (user_id, account_id) UNIQUE 보강 — 중복이 없으면 안전하게 추가됨.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_account_access
  ON user_account_access (user_id, account_id);

-- 조회 인덱스
CREATE INDEX IF NOT EXISTS idx_user_account_access_user    ON user_account_access (user_id);
CREATE INDEX IF NOT EXISTS idx_user_account_access_account ON user_account_access (account_id);

-- 초기 시드: 재무 화면 권한자(비디렉터)에게 전체 계좌 "열람"만 부여(NOT EXISTS 가드).
INSERT INTO user_account_access (user_id, account_id, can_operate)
SELECT u.id, a.id, false
  FROM users u
  CROSS JOIN accounts a
 WHERE u.deleted_at IS NULL
   AND a.deleted_at IS NULL
   AND u.role <> 'director'
   AND EXISTS (
     SELECT 1 FROM user_page_access upa
      WHERE upa.user_id = u.id AND upa.page_key = 'transactions'
   )
   AND NOT EXISTS (
     SELECT 1 FROM user_account_access x
      WHERE x.user_id = u.id AND x.account_id = a.id
   );
