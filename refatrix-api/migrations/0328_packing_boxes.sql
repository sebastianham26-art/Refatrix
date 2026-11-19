-- =====================================================================
-- Refatrix ERP · 0328_packing_boxes  (2026-11-18 · 디렉터 요청 — 0327 보완)
-- 제품마다 가로·세로·높이를 직접 넣는 대신 「포장 박스 코드」를 넣고,
-- 박스 코드별 사이즈는 포장 박스 마스터에 나중에 넣는다 → 견적 대략 총사이즈는 박스 마스터로 계산.
--   · products.box_code          : 그 제품을 포장하는 박스 코드(명칭)
--   · packing_boxes              : 박스 코드 → 가로(Largo) · 세로(Ancho) · 높이(Alto) cm · 설명
--   · product_dims_log           : 박스 코드(글자) 이력 칸 추가
--   · packing_box_log            : 박스 마스터 변경 이력
--   0327 의 products.box_l/w/h_cm 칸은 남겨 두지만 더 이상 계산에 쓰지 않는다.
--   멱등(IF NOT EXISTS) — 재실행 안전.
-- =====================================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS box_code TEXT;
CREATE INDEX IF NOT EXISTS idx_products_box_code ON products (box_code) WHERE box_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS packing_boxes (
  code         TEXT PRIMARY KEY,
  description  TEXT,
  box_l_cm     NUMERIC(8,1) CHECK (box_l_cm IS NULL OR box_l_cm > 0),
  box_w_cm     NUMERIC(8,1) CHECK (box_w_cm IS NULL OR box_w_cm > 0),
  box_h_cm     NUMERIC(8,1) CHECK (box_h_cm IS NULL OR box_h_cm > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT REFERENCES users(id)
);

ALTER TABLE product_dims_log ADD COLUMN IF NOT EXISTS old_text TEXT;
ALTER TABLE product_dims_log ADD COLUMN IF NOT EXISTS new_text TEXT;

CREATE TABLE IF NOT EXISTS packing_box_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id    TEXT NOT NULL,
  box_code    TEXT NOT NULL,
  field       TEXT NOT NULL,          -- box_l_cm | box_w_cm | box_h_cm | description | (new)
  old_value   TEXT,
  new_value   TEXT,
  changed_by  BIGINT REFERENCES users(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pbl_box ON packing_box_log (box_code, changed_at DESC);
