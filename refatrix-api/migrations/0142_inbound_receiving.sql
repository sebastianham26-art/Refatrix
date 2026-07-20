-- =====================================================================
-- Refatrix ERP · 0142_inbound_receiving
-- 수입 입고(Recepción) — 창고 현장 수령 시스템
--   선적(컨테이너/인보이스) → 팔렛(ORDER NO+PL NO) → SKU별 라인(패킹리스트)
--   · 패킹리스트 업로드로 생성 → 즉시 "입고예정 재고"로 노출(판매 지원)
--   · 카톤(Code-128=SKU) 스캔 검수 → 적치 → 마감
--   · 마감 시 구매(purchase_order_lines.received_qty) 자동 갱신 (ORDER NO = ref_no)
--   · products.stock_qty/평균원가는 건드리지 않음 — 기존 수입원가(import_batches) 승인에서 반영.
--     따라서 원가는 창고가 보지 않음(수량·위치만). 입고예정은 마감 전(도착 예정) 물량만 표시.
-- =====================================================================

-- 선적(컨테이너·인보이스 단위) --------------------------------------
CREATE TABLE IF NOT EXISTS inbound_shipments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_no  TEXT,                                   -- 패킹리스트 인보이스 번호
  eta         DATE,                                   -- 도착 예정일 → 가용재고 예측일
  status      TEXT NOT NULL DEFAULT 'incoming'
              CHECK (status IN ('incoming','receiving','closed','cancelled')),
  note        TEXT,
  created_by  BIGINT REFERENCES users(id),
  closed_by   BIGINT REFERENCES users(id),
  closed_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE TRIGGER trg_inbound_shipments_upd BEFORE UPDATE ON inbound_shipments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_inbound_ship_status ON inbound_shipments (status);

-- 팔렛(ORDER NO + PL NO 조합) ----------------------------------------
CREATE TABLE IF NOT EXISTS inbound_pallets (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id      BIGINT NOT NULL REFERENCES inbound_shipments(id),
  order_no         TEXT NOT NULL,                     -- = 구매 ref_no(PO)
  pl_no            INT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'wait'
                   CHECK (status IN ('wait','unloaded','checking','checked','done')),
  cartons_expected INT NOT NULL DEFAULT 0,
  qty_expected     NUMERIC(15,3) NOT NULL DEFAULT 0,
  checked_by       BIGINT REFERENCES users(id),
  checked_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inbound_pal_ship ON inbound_pallets (shipment_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_pal ON inbound_pallets (shipment_id, order_no, pl_no);

-- 팔렛 내 SKU별 라인(패킹리스트 기준) --------------------------------
CREATE TABLE IF NOT EXISTS inbound_pallet_items (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pallet_id       BIGINT NOT NULL REFERENCES inbound_pallets(id),
  shipment_id     BIGINT NOT NULL REFERENCES inbound_shipments(id),  -- 입고예정 롤업 가속용 비정규화
  product_id      BIGINT REFERENCES products(id),                    -- NULL = 미등록(input_code 보존)
  input_code      TEXT NOT NULL,                                     -- CTR NO 원본(감사·재매칭)
  cartons         INT NOT NULL,                                      -- 예상 카톤 수
  qty             NUMERIC(15,3) NOT NULL,                            -- 예상 수량(개별박스)
  scanned_cartons INT NOT NULL DEFAULT 0,                            -- 검수된 카톤 수
  put_cartons     INT NOT NULL DEFAULT 0,                            -- 적치된 카톤 수
  rack_saved      TEXT                                               -- 적치 시 저장한 랙
);
CREATE INDEX IF NOT EXISTS idx_inbound_pi_pallet ON inbound_pallet_items (pallet_id);
CREATE INDEX IF NOT EXISTS idx_inbound_pi_prod   ON inbound_pallet_items (product_id);
CREATE INDEX IF NOT EXISTS idx_inbound_pi_ship   ON inbound_pallet_items (shipment_id);

-- 입고예정(가용) 재고 뷰 --------------------------------------------
--   아직 마감(closed) 안 된 선적의 SKU별 예상 수량 합 + 가장 이른 ETA.
--   재고 표시되는 모든 화면(/api/products)에서 LEFT JOIN 하여 "곧 추가될 재고"로 노출.
CREATE OR REPLACE VIEW v_incoming_stock AS
  SELECT pi.product_id,
         SUM(pi.qty) AS incoming_qty,
         MIN(s.eta)  AS incoming_eta
    FROM inbound_pallet_items pi
    JOIN inbound_shipments s ON s.id = pi.shipment_id
   WHERE s.deleted_at IS NULL
     AND s.status IN ('incoming','receiving')
     AND pi.product_id IS NOT NULL
   GROUP BY pi.product_id;
