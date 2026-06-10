-- =====================================================================
-- Refatrix ERP · 0018_sales_sku_pending
-- 매출 엑셀 업로드 시, 제품마스터에 없는 CTR 코드 줄을 보류(pending)로 보관.
-- 나중에 해당 제품을 제품마스터에 등록하면 이 보류 줄을 다시 처리(resolve)할 수 있음.
-- 매출 자체는 정상 코드로만 발행되고, 미등록 코드는 여기로 분리된다.
-- =====================================================================

CREATE TABLE IF NOT EXISTS sales_sku_pending (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code           TEXT NOT NULL,                         -- 업로드된 CTR 코드(미등록)
  qty            NUMERIC(15,3) NOT NULL,
  customer_id    BIGINT REFERENCES customers(id),       -- 업로드 화면에서 선택한 고객
  intended_sat_no TEXT,                                 -- 의도한 SAT 번호(있으면)
  sales_invoice_id BIGINT REFERENCES sales_invoices(id),-- 같은 업로드의 정상분 인보이스(있으면)
  note           TEXT,
  occurred_at    DATE NOT NULL DEFAULT CURRENT_DATE,
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','resolved','cancelled')),
  resolved_at    TIMESTAMPTZ,
  resolved_by    BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sku_pending_status ON sales_sku_pending (status);
CREATE INDEX IF NOT EXISTS idx_sku_pending_code   ON sales_sku_pending (code);
