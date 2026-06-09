-- =====================================================================
-- Refatrix ERP · 0016_stock_shortages
-- 부족 기록(백오더): 매출 시 재고가 모자라 인보이스에 담지 못한 부족분을 기록.
-- 목적: 재고가 마이너스로 가지 않게 하면서, 공장 주문 근거 + 영업 재오퍼 단서로 활용.
-- 회계(매출·COGS·AR·재고)는 실제 출고분으로만 움직이고, 부족분은 여기에만 남는다.
--   · 인보이스에는 현재 재고로 출고 가능한 수량만 들어감.
--   · 부족분 = 원하던 수량 − 출고 수량. 채워야 할 미결 주문이 아니라 수요 신호.
-- =====================================================================

CREATE TABLE IF NOT EXISTS stock_shortages (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id        BIGINT NOT NULL REFERENCES products(id),
  customer_id       BIGINT REFERENCES customers(id),       -- 누가 원했는가(재오퍼 단서)
  sales_invoice_id  BIGINT REFERENCES sales_invoices(id),  -- 어느 매출에서 발생했는가
  requested_qty     NUMERIC(15,3) NOT NULL,                -- 원하던 수량
  fulfilled_qty     NUMERIC(15,3) NOT NULL DEFAULT 0,      -- 실제 출고(인보이싱)된 수량
  shortage_qty      NUMERIC(15,3) NOT NULL,                -- 부족분 = requested - fulfilled
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','resolved','cancelled')),
                    -- open=미해소(주문 필요) / resolved=재고 확보·처리됨 / cancelled=취소
  occurred_at       DATE NOT NULL,                         -- 발생일(인보이스일)
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        BIGINT REFERENCES users(id),
  resolved_at       TIMESTAMPTZ,
  resolved_by       BIGINT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_shortage_product ON stock_shortages (product_id, status);
CREATE INDEX IF NOT EXISTS idx_shortage_customer ON stock_shortages (customer_id);
CREATE INDEX IF NOT EXISTS idx_shortage_status ON stock_shortages (status, occurred_at);
