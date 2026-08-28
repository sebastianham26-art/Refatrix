-- =====================================================================
-- Refatrix ERP · 0188_stock_count_spot  (SKU 스팟점검 / Conteo puntual)
--
--  왜: 지금 재고실사는 "세션을 열고 전부 센다"가 전제라, 대조 화면이 세지 않은
--      SKU 를 전부 「미실사」로 잡는다. 현장에서 원하는 것은 그 반대다 —
--      바코드 스캐너를 들고 **눈에 띄는 제품 몇 개만** 골라
--        ① 제품 바코드 스캔 → 시스템 수량·위치가 화면에 뜨고
--        ② 실물이 맞으면 랙 바코드를 스캔(= 맞음 확정)
--        ③ 다르면 화면의 [틀림] 버튼
--      그리고 그 점검 이력이 남는 것.
--
--  ① stock_counts.mode : 'full'(기존 전체 재고실사) / 'spot'(SKU 스팟점검)
--                        기존 행은 전부 'full' 로 백필된다 — 기존 동작 불변.
--  ② stock_count_spot_checks : 점검 1건 = 제품 1개를 한 번 확인한 기록.
--
--  격리 원칙(디렉터 결정 2026-08-27):
--    · 스팟점검은 **기록 전용**이다. 재고 수량(products.stock_qty)도,
--      마스터 위치(products.rack_location)도 이 기능으로는 바뀌지 않는다.
--      수량을 고치려면 기존 전체 재고실사의 디렉터 PIN 검토·반영을 쓴다.
--    · 그래서 stock_count_lines / stock_count_adjustments 는 **손대지 않는다**.
--      스팟 기록이 그 테이블에 섞이면 대조·반영 집계가 오염되기 때문이다.
--    · 이 마이그레이션이 기존 테이블에 하는 일은 stock_counts 에 컬럼 1개
--      추가하는 것뿐이다(신규 테이블 1개).
-- =====================================================================

-- ① 세션 모드 ---------------------------------------------------------
ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'full';

UPDATE stock_counts SET mode = 'full' WHERE mode IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_counts_mode_chk') THEN
    ALTER TABLE stock_counts ADD CONSTRAINT stock_counts_mode_chk CHECK (mode IN ('full','spot'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_stock_counts_mode ON stock_counts (mode, started_at DESC);

-- ② 점검 기록 ---------------------------------------------------------
--   한 세션에서 같은 SKU 를 여러 번 점검할 수 있다(다시 세어 봤다). 원장이므로
--   덮어쓰지 않고 매번 새 행을 남기고, 요약에서는 **가장 최근 행**을 그 SKU 의
--   결과로 본다. system_qty·master_rack 은 **점검 시점 스냅샷**이다 — 나중에
--   재고가 움직여도 "그때 화면에 뭐가 떴는지"가 그대로 남아야 하기 때문.
CREATE TABLE IF NOT EXISTS stock_count_spot_checks (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_id      BIGINT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  item_kind     TEXT NOT NULL,                        -- 'part' | 'promo'
  product_id    BIGINT REFERENCES products(id),
  promo_item_id BIGINT REFERENCES promo_items(id),
  raw_code      TEXT NOT NULL,                        -- 스캔 원문(진단용)
  matched_code  TEXT,                                 -- 매칭된 CTR/프로모 코드
  match_source  TEXT,                                 -- ctr / ean / syd / promo
  item_name     TEXT,                                 -- 점검 시점 품명 스냅샷
  system_qty    NUMERIC(15,3) NOT NULL DEFAULT 0,     -- 화면에 띄운 시스템 수량(스냅샷)
  master_rack   TEXT,                                 -- 화면에 띄운 마스터 위치(스냅샷)
  result        TEXT NOT NULL,                        -- 'ok'(실물=시스템) | 'mismatch'(틀림)
  rack_scanned  TEXT,                                 -- 맞음 확정용으로 스캔한 랙. NULL = 랙 스캔 생략
  rack_match    BOOLEAN,                              -- 스캔 랙이 마스터 위치 안에 있는지. NULL = 판정 불가
  note          TEXT,
  checked_by    BIGINT REFERENCES users(id),
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scsc_kind_chk') THEN
    ALTER TABLE stock_count_spot_checks ADD CONSTRAINT scsc_kind_chk CHECK (item_kind IN ('part','promo'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scsc_result_chk') THEN
    ALTER TABLE stock_count_spot_checks ADD CONSTRAINT scsc_result_chk CHECK (result IN ('ok','mismatch'));
  END IF;
  -- part 면 product_id, promo 면 promo_item_id 가 반드시 있어야 한다(빈 점검 기록 방지)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scsc_item_chk') THEN
    ALTER TABLE stock_count_spot_checks ADD CONSTRAINT scsc_item_chk CHECK (
      (item_kind = 'part'  AND product_id    IS NOT NULL AND promo_item_id IS NULL) OR
      (item_kind = 'promo' AND promo_item_id IS NOT NULL AND product_id    IS NULL)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scsc_count   ON stock_count_spot_checks (count_id, id);
CREATE INDEX IF NOT EXISTS idx_scsc_product ON stock_count_spot_checks (product_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_scsc_promo   ON stock_count_spot_checks (promo_item_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_scsc_at      ON stock_count_spot_checks (checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_scsc_result  ON stock_count_spot_checks (result);
