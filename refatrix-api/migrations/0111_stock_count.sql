-- =====================================================================
-- Refatrix ERP · 0111_stock_count  (재고실사 / Inventory Count)
--   · promo_items        : 프로모션 상품(장갑·티셔츠·모자 등) 경량 마스터
--                          자동차부품 products 와 분리 — 견적/매출/분석에 미노출
--   · stock_counts       : 실사 세션 헤더 (SC-YYYY-NNNN)
--   · stock_count_lines  : 실사 1건(랙에서 센 한 항목)
--   격리 원칙: 실사 기록 자체는 재고를 바꾸지 않음(감사 전용).
--   디렉터 "실물로 맞추기" 시에만 stock_movements(adjust) + stock_qty 갱신.
-- =====================================================================

-- 프로모션 상품 경량 마스터 -------------------------------------------
CREATE TABLE IF NOT EXISTS promo_items (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,                  -- 사내 지정 코드(예: PROMO-GUANTE)
  name          TEXT NOT NULL,                         -- 품명(장갑/티셔츠/모자 등)
  barcode       TEXT,                                  -- 부착 바코드(있으면)
  rack_location TEXT,                                  -- 보관 위치(랙)
  stock_qty     NUMERIC(15,3) NOT NULL DEFAULT 0,      -- 시스템 수량(수동 관리)
  unit_cost     NUMERIC(15,2) DEFAULT 0,               -- 참고 원가(MXN, 선택)
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES users(id),
  deleted_at    TIMESTAMPTZ
);
DROP TRIGGER IF EXISTS trg_promo_items_upd ON promo_items;
CREATE TRIGGER trg_promo_items_upd BEFORE UPDATE ON promo_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_promo_items_barcode ON promo_items (barcode);
CREATE INDEX IF NOT EXISTS idx_promo_items_active  ON promo_items (active);

-- 실사 세션 헤더 -------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_counts (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,                 -- SC-2026-0001
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','submitted','reconciled','canceled')),
  scope_note     TEXT,                                 -- 실사 범위 메모(예: A동 랙 전체)
  started_by     BIGINT REFERENCES users(id),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at   TIMESTAMPTZ,
  reconciled_at  TIMESTAMPTZ,
  reconciled_by  BIGINT REFERENCES users(id),
  adjust_event_no BIGINT,                              -- 실물맞추기 시 stock_movements event_no
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_stock_counts_upd ON stock_counts;
CREATE TRIGGER trg_stock_counts_upd BEFORE UPDATE ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_stock_counts_status ON stock_counts (status);
CREATE INDEX IF NOT EXISTS idx_stock_counts_by     ON stock_counts (started_by);

-- 실사 라인(랙에서 센 한 항목) ---------------------------------------
CREATE TABLE IF NOT EXISTS stock_count_lines (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_id      BIGINT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  item_kind     TEXT NOT NULL CHECK (item_kind IN ('part','promo','unknown')),
  product_id    BIGINT REFERENCES products(id),        -- part 일 때
  promo_item_id BIGINT REFERENCES promo_items(id),     -- promo 일 때
  raw_code      TEXT NOT NULL,                         -- 스캔/입력 원본 코드
  matched_code  TEXT,                                  -- 매칭된 CTR/프로모 코드
  match_source  TEXT,                                  -- ctr / ean / syd / promo / none
  rack_scanned  TEXT,                                  -- 스캔한 랙 위치
  counted_qty   NUMERIC(15,3) NOT NULL DEFAULT 0,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scl_count   ON stock_count_lines (count_id);
CREATE INDEX IF NOT EXISTS idx_scl_product ON stock_count_lines (product_id);
CREATE INDEX IF NOT EXISTS idx_scl_promo   ON stock_count_lines (promo_item_id);
