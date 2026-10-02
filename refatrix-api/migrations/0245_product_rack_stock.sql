-- =====================================================================
-- Refatrix ERP · 0245_product_rack_stock  (랙별 재고 / Inventario por ubicación)
--
--  왜: 재고실사(SC-2026-0013)는 라인마다 랙을 기록하지만, 저장·반영 단계에서
--      SKU 합계 하나와 "AE1-3, AE1-1" 같은 랙 이름 문자열만 남았다.
--      그래서 포장작업지시서·제품찾기에서 "어느 랙에 몇 개"를 알려줄 수 없었다.
--
--  디렉터 결정(2026-10-01):
--    · 제품 × 랙 × 수량을 항상 유지하고 보여준다(실사 반영 · 포장지시서 · 제품찾기).
--    · 피킹 지시서는 여러 위치 중 **fast moving 랙을 먼저** 보여준다.
--    · 포장 때 랙 바코드는 스캔하지 않는다. **지시서에 적힌 위치에서 자동 차감**한다.
--
--  ① product_rack_stock : 현재 랙별 수량(제품 1 × 랙 1 = 1행). rack 은 UPPER(TRIM) 정규화 키.
--  ② product_rack_moves : 랙별 수량이 바뀐 모든 이력(원장). 지우지 않는다.
--  ③ quote_pick_alloc   : 포장작업지시서 출력 시점에 정해진 피킹 위치(견적 × 제품 × 랙 × 수량).
--                          매출 전환 때 이 위치에서 차감하고 consumed_invoice_id 를 남긴다.
--
--  격리 원칙: 기존 테이블은 변경하지 않는다(신규 3테이블). products.stock_qty 가
--  여전히 재고 총량의 기준이며, 랙 수량 합과의 차이는 화면에서 「위치 미지정」으로 보인다.
-- =====================================================================

-- ① 현재 랙별 수량 ------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_rack_stock (
  product_id  BIGINT NOT NULL REFERENCES products(id),
  rack        TEXT   NOT NULL,                        -- UPPER(TRIM()) 정규화된 랙 번호
  qty         NUMERIC(15,3) NOT NULL DEFAULT 0,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, rack)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prs_qty_chk') THEN
    ALTER TABLE product_rack_stock ADD CONSTRAINT prs_qty_chk CHECK (qty >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prs_rack_chk') THEN
    ALTER TABLE product_rack_stock ADD CONSTRAINT prs_rack_chk CHECK (rack <> '' AND rack = UPPER(TRIM(rack)));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_prs_rack ON product_rack_stock (rack);

-- ② 원장 ----------------------------------------------------------------
--   reason: count(실사 반영) / sale(매출 출고) / sale_reverse(매출 삭제·수정 복원)
--           putaway(수입 적치) / relocate(위치변경) / manual(디렉터 수동)
CREATE TABLE IF NOT EXISTS product_rack_moves (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id       BIGINT NOT NULL REFERENCES products(id),
  rack             TEXT   NOT NULL,
  delta            NUMERIC(15,3) NOT NULL,
  qty_after        NUMERIC(15,3) NOT NULL,
  reason           TEXT   NOT NULL,
  ref              TEXT,                               -- count:26 / sales:812 / rack_move:44 / inbound_item:91 …
  sales_invoice_id BIGINT,
  quote_id         BIGINT,
  note             TEXT,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prm_reason_chk') THEN
    ALTER TABLE product_rack_moves ADD CONSTRAINT prm_reason_chk
      CHECK (reason IN ('count','sale','sale_reverse','putaway','relocate','manual'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_prm_product ON product_rack_moves (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prm_invoice ON product_rack_moves (sales_invoice_id) WHERE sales_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prm_rack    ON product_rack_moves (rack, created_at DESC);

-- ③ 피킹 위치(포장작업지시서 스냅샷) -------------------------------------
--   rack NULL = 랙 수량이 모자라 「위치 미지정」으로 나간 분량(제품마스터 위치로 안내).
CREATE TABLE IF NOT EXISTS quote_pick_alloc (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_id            BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id          BIGINT NOT NULL REFERENCES products(id),
  rack                TEXT,
  qty                 NUMERIC(15,3) NOT NULL,
  seq                 INTEGER NOT NULL DEFAULT 0,      -- 피킹 순서(fast moving 먼저)
  consumed_invoice_id BIGINT,                          -- 매출 전환으로 차감 완료된 인보이스
  created_by          BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qpa_qty_chk') THEN
    ALTER TABLE quote_pick_alloc ADD CONSTRAINT qpa_qty_chk CHECK (qty > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_qpa_quote   ON quote_pick_alloc (quote_id, product_id);
CREATE INDEX IF NOT EXISTS idx_qpa_open    ON quote_pick_alloc (product_id, rack) WHERE consumed_invoice_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_qpa_invoice ON quote_pick_alloc (consumed_invoice_id) WHERE consumed_invoice_id IS NOT NULL;
