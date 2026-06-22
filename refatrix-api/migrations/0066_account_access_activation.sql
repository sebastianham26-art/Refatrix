-- =====================================================================
-- Refatrix ERP · 0066_account_access_activation
-- 계좌별 사용자 권한(user_account_access) 활성화.
--   · 테이블은 0003에서 이미 생성됨(user_id, account_id, can_operate).
--   · 이번 마이그레이션은 (1) 조회 인덱스 (2) 안전한 초기 시드만 수행.
--
-- 시드 정책(현행 동작 보존 + 디렉터 의도 반영):
--   · 재무(transactions) 화면 권한이 있는 "비디렉터" 사용자에게
--     현재 모든 계좌의 "열람(view)" 권한을 부여한다(can_operate=false).
--     → 배포 직후 기존 직원이 보던 잔고가 사라지지 않음(시각적 단절 없음).
--   · "운영(거래등록/확정)" 권한은 아무에게도 자동 부여하지 않는다(opt-in).
--     → 대표님이 사용자관리에서 "등록 가능한 사람"만 골라 운영 권한을 켠다.
--   · 디렉터는 테이블과 무관하게 전체 열람/운영(코드에서 처리).
-- =====================================================================

-- 역방향 조회(계좌→사용자) 및 사용자별 조회용 인덱스
CREATE INDEX IF NOT EXISTS idx_user_account_access_user    ON user_account_access (user_id);
CREATE INDEX IF NOT EXISTS idx_user_account_access_account ON user_account_access (account_id);

-- 초기 시드: 재무 화면 권한자(비디렉터)에게 전체 계좌 "열람"만 부여
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
ON CONFLICT (user_id, account_id) DO NOTHING;
