-- =====================================================================
-- Refatrix ERP · 0128_purchase_orders
-- 구매(발주) 내역 기록 — 1단계: 엑셀 업로드(제품코드·수량·구매원가 USD·구매참조번호) 기록·조회
--   · 헤더(purchase_orders) = 구매참조번호 단위
--   · 라인(purchase_order_lines) = SKU별 수량·구매원가(USD)
--   · 향후 훅: received_qty(입고 연동 → backorder = qty-received_qty), import_line_id(입고배치 연결 → COGS)
-- 재고/평균원가/현금흐름에는 아직 영향 없음(순수 기록). 후속 단계에서 연결.
-- =====================================================================

-- 구매 헤더(구매참조번호 단위) ---------------------------------------
CREATE TABLE IF NOT EXISTS purchase_orders (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ref_no      TEXT NOT NULL,                          -- 구매참조번호(선적/PO 참조)
  order_date  DATE NOT NULL DEFAULT CURRENT_DATE,     -- 발주(기록)일
  currency    TEXT NOT NULL DEFAULT 'USD',            -- 구매원가 통화(1단계 USD 고정)
  status      TEXT NOT NULL DEFAULT 'recorded'
              CHECK (status IN ('recorded','shipped','received','cancelled')),
  note        TEXT,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE TRIGGER trg_purchase_orders_upd BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_purchase_orders_ref  ON purchase_orders (ref_no);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_date ON purchase_orders (order_date);

-- 구매 라인(SKU별) ---------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_id          BIGINT NOT NULL REFERENCES purchase_orders(id),
  product_id     BIGINT REFERENCES products(id),      -- NULL = 미매칭(코드 미등록) — 기록은 보존
  input_code     TEXT NOT NULL,                       -- 업로드 원본 제품코드(감사·재매칭용)
  qty            NUMERIC(15,3) NOT NULL,              -- 구매 수량
  unit_cost_usd  NUMERIC(15,4) NOT NULL,              -- 구매원가(USD/단위)
  amount_usd     NUMERIC(15,2) NOT NULL,              -- qty × unit_cost_usd
  -- ▼ 향후 단계 훅(1단계에서는 기본값만; 아직 사용 안 함) --------------
  received_qty   NUMERIC(15,3) NOT NULL DEFAULT 0,    -- 입고 연동 시 채워짐 → backorder = qty - received_qty
  import_line_id BIGINT REFERENCES import_lines(id)   -- 입고배치 연결(→ 이동평균원가/COGS)
);
CREATE INDEX IF NOT EXISTS idx_po_lines_po   ON purchase_order_lines (po_id);
CREATE INDEX IF NOT EXISTS idx_po_lines_prod ON purchase_order_lines (product_id);

-- backorder(미입고 잔량) 조회 뷰(향후 가용재고 정보로 활용) -----------
--   po.status <> 'cancelled' AND 라인 잔량 > 0
CREATE OR REPLACE VIEW v_backorder AS
  SELECT l.product_id,
         SUM(l.qty - l.received_qty) AS backorder_qty
  FROM purchase_order_lines l
  JOIN purchase_orders p ON p.id = l.po_id
  WHERE p.deleted_at IS NULL
    AND p.status <> 'cancelled'
    AND l.product_id IS NOT NULL
    AND (l.qty - l.received_qty) > 0
  GROUP BY l.product_id;
