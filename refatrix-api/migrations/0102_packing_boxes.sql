-- =====================================================================
-- Refatrix ERP · 0102_packing_boxes
-- 창고 출고-1b: 패킹(박스 분류 + EAN-13 스캔) 데이터 모델.
--   · packing_box       : 오더별 박스(Box 1,2,3…)
--   · packing_box_line  : 박스별 SKU 수량(집계) — 어느 SKU가 어느 박스에 몇 개
--   · packing_scan      : 스캔 1건(=1피스) 감사 로그(재개·추적)
-- 추가형(CREATE IF NOT EXISTS)만 — 기존 테이블·재고·전환에 영향 없음. 재실행 안전.
-- =====================================================================

CREATE TABLE IF NOT EXISTS packing_box (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_id    BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  box_no      INT NOT NULL,
  sealed_at   TIMESTAMPTZ,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quote_id, box_no)
);
CREATE INDEX IF NOT EXISTS idx_packing_box_quote ON packing_box (quote_id);

CREATE TABLE IF NOT EXISTS packing_box_line (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  box_id      BIGINT NOT NULL REFERENCES packing_box(id) ON DELETE CASCADE,
  quote_id    BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  qty         INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (box_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_pbl_quote ON packing_box_line (quote_id);
CREATE INDEX IF NOT EXISTS idx_pbl_box   ON packing_box_line (box_id);

CREATE TABLE IF NOT EXISTS packing_scan (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_id    BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  box_id      BIGINT REFERENCES packing_box(id) ON DELETE SET NULL,
  product_id  BIGINT REFERENCES products(id),
  ean         TEXT,
  result      TEXT NOT NULL,          -- ok | wrong | excess | unknown | undo
  scanned_by  BIGINT REFERENCES users(id),
  scanned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pscan_quote ON packing_scan (quote_id);
