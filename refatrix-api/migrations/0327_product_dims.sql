-- =====================================================================
-- Refatrix ERP · 0327_product_dims  (2026-11-18 · 디렉터 요청)
-- 제품별 무게 · 개별 박스 사이즈 — 견적 건별 대략 총무게 · 총사이즈(가로×세로×높이) 계산용
--   · weight_kg : 제품 1개(개별 박스 포함) 무게 kg
--   · box_l_cm / box_w_cm / box_h_cm : 개별 박스 가로 · 세로 · 높이 cm
--   제품마스터 › 업로드 탭 「📦 무게 · 박스 사이즈」에서 엑셀 업로드 / 양식 · 현재값 다운로드.
--   비어 있으면 견적 계산에서 그 줄만 빠지고 「자료 없음 n줄」로 알린다.
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_kg        NUMERIC(10,3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS box_l_cm         NUMERIC(8,1);
ALTER TABLE products ADD COLUMN IF NOT EXISTS box_w_cm         NUMERIC(8,1);
ALTER TABLE products ADD COLUMN IF NOT EXISTS box_h_cm         NUMERIC(8,1);
ALTER TABLE products ADD COLUMN IF NOT EXISTS dims_updated_at  TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS dims_updated_by  BIGINT REFERENCES users(id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_dims_chk') THEN
    ALTER TABLE products ADD CONSTRAINT products_dims_chk CHECK (
      (weight_kg IS NULL OR weight_kg > 0) AND (box_l_cm IS NULL OR box_l_cm > 0)
      AND (box_w_cm IS NULL OR box_w_cm > 0) AND (box_h_cm IS NULL OR box_h_cm > 0));
  END IF;
END $$;

-- 변경 이력(업로드 1회 = batch 1건, 바뀐 칸만 행으로)
CREATE TABLE IF NOT EXISTS product_dims_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id    TEXT NOT NULL,
  product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code        TEXT,
  field       TEXT NOT NULL,          -- weight_kg | box_l_cm | box_w_cm | box_h_cm
  old_value   NUMERIC,
  new_value   NUMERIC,
  source      TEXT,                   -- excel
  changed_by  BIGINT REFERENCES users(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pdl_product ON product_dims_log (product_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pdl_batch   ON product_dims_log (batch_id);
