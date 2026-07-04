-- =====================================================================
-- Refatrix ERP · 0116_marketing_spend_items
-- 마케팅 지출 계획 고도화: 활동(계획) → 집행 항목 N개 → 항목별 지급 라인 N개
--   · 하나의 행사에 장소·케이터링·판촉물처럼 여러 집행이 있고,
--     각 집행마다 선지급/중도금/잔금 분할 지급을 계획.
--   · 기존 데이터는 계획당 '기본 집행' 항목으로 자동 귀속(백필).
-- =====================================================================

-- 집행 항목 -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_spend_items (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id     BIGINT NOT NULL REFERENCES marketing_spend_plans(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                          -- 집행 항목명(예: 장소 대관, 케이터링)
  memo        TEXT,                                   -- 업체·비고
  sort_order  INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msi_plan ON marketing_spend_items (plan_id);

-- 지급 라인 → 집행 항목 연결 ------------------------------------------
ALTER TABLE marketing_spend_lines
  ADD COLUMN IF NOT EXISTS item_id BIGINT REFERENCES marketing_spend_items(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_msl_item ON marketing_spend_lines (item_id);

-- 백필: 기존 라인이 있으면 계획당 '기본 집행' 항목 1개 생성 후 귀속 -----
INSERT INTO marketing_spend_items (plan_id, name, sort_order)
SELECT DISTINCT plan_id, '기본 집행', 0
  FROM marketing_spend_lines
 WHERE item_id IS NULL;

UPDATE marketing_spend_lines l
   SET item_id = i.id
  FROM marketing_spend_items i
 WHERE l.item_id IS NULL
   AND i.plan_id = l.plan_id
   AND i.name = '기본 집행';
