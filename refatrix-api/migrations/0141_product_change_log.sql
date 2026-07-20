-- =====================================================================
-- Refatrix ERP · 0141_product_change_log
-- 제품 마스터 변경 이력 (화면 직접 추가/수정 · 엑셀 업로드 · 소재 지정)
--   changes JSONB 형식: { "필드": {"from": 이전값, "to": 새값}, "_syd": {...}, "_app": {...} }
--   INSERT 전용(수정·삭제 없음). 기록 실패가 실제 작업을 깨지 않도록 코드에서 방어적으로 호출.
-- =====================================================================

CREATE TABLE IF NOT EXISTS product_change_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id),
  code        TEXT,
  action      TEXT NOT NULL CHECK (action IN ('create','update')),
  source      TEXT NOT NULL DEFAULT 'manual',   -- manual | import | material | material_bulk
  changes     JSONB,
  changed_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcl_product ON product_change_log (product_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_pcl_created ON product_change_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pcl_code    ON product_change_log (code);
