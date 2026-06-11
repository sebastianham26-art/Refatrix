-- =====================================================================
-- Refatrix ERP · 0031_stage_numbers_director_team
-- ① 고객 단계 이름에 번호 부여(00_미지정 포함) — 숫자 단계 인식 용이.
-- ② 디렉터 소속 표시용 'director' 팀(영업팀 아님) — is_sales 플래그 추가.
-- =====================================================================

-- ① 단계 번호 부여 + 미지정 추가
UPDATE stages SET name='01_잠재',   sort_order=10 WHERE name='잠재';
UPDATE stages SET name='02_접촉',   sort_order=20 WHERE name='접촉';
UPDATE stages SET name='03_견적',   sort_order=30 WHERE name='견적';
UPDATE stages SET name='04_협상',   sort_order=40 WHERE name='협상';
UPDATE stages SET name='05_수주',   sort_order=50 WHERE name='수주';
UPDATE stages SET name='06_거래중', sort_order=60 WHERE name='거래중';
INSERT INTO stages (name, sort_order)
  SELECT '00_미지정', 0 WHERE NOT EXISTS (SELECT 1 FROM stages WHERE name='00_미지정');

-- ② 디렉터 소속용 팀 구분
ALTER TABLE sales_teams ADD COLUMN IF NOT EXISTS is_sales BOOLEAN NOT NULL DEFAULT true;
INSERT INTO sales_teams (name, sort_order, is_sales)
  SELECT 'director', 0, false WHERE NOT EXISTS (SELECT 1 FROM sales_teams WHERE name='director');
