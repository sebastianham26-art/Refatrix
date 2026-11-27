-- =====================================================================
-- Refatrix ERP · 0344_hr_admin_role_reviewer  (2026-11-27 디렉터 결정)
--   1) 역할 'hr_admin'(인사·총무·재무) 추가.
--      · 화면은 사용자·권한에서 고른 만큼 열림(재무담당 treasury 처럼 재무·구매 그룹으로 잠기지 않음).
--      · 가격 마스터·구매단가/원가·금고/불공제 계좌는 코드에서 항상 차단(permissions.ROLE_DENY).
--   2) 전자결재 「검토·승인자」 reviewer_user_id — 직원 기안 → 검토·승인 → 디렉터 결재.
--   3) 일회성 데이터: 복제 계정(id 30, 로그인 mauricio, 이름 'christopher (복제)')
--      → 이름 Mauricio · 역할 hr_admin · 부서 인사·총무·재무.
--      전자결재 검토·승인자 = Mauricio, 재무 집행 담당이 삭제된 계정이면 Mauricio 로 교체.
--      조건이 정확히 맞을 때만 바뀐다(다른 DB·재실행에서는 아무 일도 안 함).
-- 멱등: DROP CONSTRAINT IF EXISTS / ADD COLUMN IF NOT EXISTS / 조건부 UPDATE.
-- (직전 role 목록 = 0100 기준 + 'hr_admin')
-- =====================================================================

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('director','socio','treasury','hr_admin','marketing','ops','sales','sales_support','warehouse','viewer'));

ALTER TABLE approval_settings ADD COLUMN IF NOT EXISTS reviewer_user_id BIGINT REFERENCES users(id);

-- 3) 복제 계정 → Mauricio
UPDATE users
   SET name = 'Mauricio', role = 'hr_admin', dept = COALESCE(NULLIF(dept, ''), '인사·총무·재무'), updated_at = now()
 WHERE id = 30 AND login_id = 'mauricio' AND deleted_at IS NULL
   AND name ILIKE 'christo%(복제)%';

-- 금고·불공제 계좌 권한 행이 있으면 제거(코드에서도 막지만 화면 표시도 깔끔하게)
DELETE FROM user_account_access uaa
 USING users u, accounts a
 WHERE uaa.user_id = u.id AND uaa.account_id = a.id
   AND u.role = 'hr_admin'
   AND (a.non_deductible = true OR a.treasury_exclude = true
        OR (COALESCE(a.name, '') || ' ' || COALESCE(a.type, '')) ~* '(금고|caja|efectivo|현금|cash|불공제|no\s*deduc)');

-- 전자결재: 검토·승인자 비어 있으면 Mauricio
UPDATE approval_settings s
   SET reviewer_user_id = 30, updated_at = now()
 WHERE s.id = 1 AND s.reviewer_user_id IS NULL
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = 30 AND u.role = 'hr_admin' AND u.deleted_at IS NULL);

-- 전자결재: 재무 집행 담당이 없거나 삭제된 계정이면 Mauricio
UPDATE approval_settings s
   SET finance_user_id = 30, updated_at = now()
 WHERE s.id = 1
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = 30 AND u.role = 'hr_admin' AND u.deleted_at IS NULL)
   AND (s.finance_user_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM users f WHERE f.id = s.finance_user_id AND f.deleted_at IS NULL));

INSERT INTO approval_settings_log (changed_by, detail)
SELECT 1, '0344 · 검토·승인자/재무 집행 = Mauricio (인사·총무·재무)'
 WHERE EXISTS (SELECT 1 FROM approval_settings WHERE id = 1 AND reviewer_user_id = 30)
   AND NOT EXISTS (SELECT 1 FROM approval_settings_log WHERE detail LIKE '0344 ·%');
