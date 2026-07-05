-- =====================================================================
-- 0122_stock_count_review  (재고실사 디렉터 검토·반영 이력)
--   차이 항목별 디렉터 결정(반영/보류)·코멘트·랙저장 여부를 감사 기록.
--   반영/보류 모두 기록되어 "왜 안 맞췄는지"가 남습니다.
-- =====================================================================
CREATE TABLE IF NOT EXISTS stock_count_adjustments (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_id      BIGINT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  item_kind     TEXT NOT NULL CHECK (item_kind IN ('part','promo')),
  product_id    BIGINT REFERENCES products(id),
  promo_item_id BIGINT REFERENCES promo_items(id),
  code          TEXT,
  system_qty    NUMERIC(15,3),
  counted_qty   NUMERIC(15,3),
  delta         NUMERIC(15,3),
  decision      TEXT NOT NULL DEFAULT 'skip' CHECK (decision IN ('apply','skip')),
  comment       TEXT,                                 -- 디렉터 코멘트(차이 사유 등)
  rack_scanned  TEXT,                                 -- 실사 중 스캔된 랙
  rack_saved    BOOLEAN NOT NULL DEFAULT FALSE,       -- 마스터 랙위치에 저장했는지
  applied       BOOLEAN NOT NULL DEFAULT FALSE,       -- 재고에 반영했는지
  event_no      BIGINT,                               -- stock_movements 이벤트 묶음
  reviewed_by   BIGINT REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sca_count   ON stock_count_adjustments (count_id);
CREATE INDEX IF NOT EXISTS idx_sca_product ON stock_count_adjustments (product_id);
