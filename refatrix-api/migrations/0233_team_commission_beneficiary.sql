-- =====================================================================
-- Refatrix ERP · 0233_team_commission_beneficiary  (2026-09-28)
-- 팀 커미션 수혜자: 이 팀에 속한 고객의 매출 커미션을 고객 담당자 대신 지정한 사람에게 귀속.
--   NULL(기본) = 종전대로 고객마스터 담당자(customers.owner_id).
--   디렉터 결정: 06_Tele 팀 고객 매출 → Maria.
--   이미 지급된 커미션은 지급받은 사람으로 동결(변경 영향 없음).
-- =====================================================================

ALTER TABLE sales_teams ADD COLUMN IF NOT EXISTS commission_user_id BIGINT REFERENCES users(id);

UPDATE sales_teams
   SET commission_user_id = (
         SELECT id FROM users
          WHERE lower(name) = 'maria' AND deleted_at IS NULL
          ORDER BY id LIMIT 1)
 WHERE name = '06_Tele'
   AND commission_user_id IS NULL;
