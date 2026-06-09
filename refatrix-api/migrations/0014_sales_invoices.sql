-- =====================================================================
-- Refatrix ERP · 0014_sales_invoices
-- 매출 모듈: 다품목 인보이스(헤더+라인) + 수정/삭제 변경요청 + 예외 외상일 승인 + AR 연결.
-- 정책: 등록=즉시 반영(승인 불필요) / 수정·삭제=디렉터 승인 / 예외 외상일=매출 반영하되 미승인 꼬리표.
--   · sales_invoices       : 인보이스 헤더(고객·일자·외상·합계·상태)
--   · sales_invoice_lines  : 품목 라인(제품·수량·정가·할인·판매단가·원가스냅샷·COGS)
--   · sales_change_requests: 수정/삭제 요청 보관(원본 불변, 승인 시 반영)
--   · transactions(plan)   : 입금 예정(AR) — 기존 테이블 사용, invoice_id 연결만 추가
-- =====================================================================

-- 인보이스 헤더 ------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_invoices (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sat_no            TEXT UNIQUE,                          -- SAT factura 번호
  customer_id       BIGINT NOT NULL REFERENCES customers(id),
  inv_date          DATE NOT NULL,                        -- 인보이스 기록일
  credit_days       INT NOT NULL DEFAULT 0,               -- 적용된 외상일(기준 또는 예외)
  due_date          DATE,                                 -- 예상 입금일 = inv_date + credit_days
  credit_exception  BOOLEAN NOT NULL DEFAULT false,       -- 기준 외상일과 다른가
  credit_memo       TEXT,                                 -- 예외 외상일 사유(메모)
  credit_approved   BOOLEAN NOT NULL DEFAULT false,       -- 예외 외상일 디렉터 승인 여부
  credit_approved_by BIGINT REFERENCES users(id),
  credit_approved_at TIMESTAMPTZ,
  iva_rate          NUMERIC(5,2) NOT NULL DEFAULT 16,
  subtotal_mxn      NUMERIC(15,2) NOT NULL DEFAULT 0,      -- 소계(할인 후, ex-IVA)
  iva_mxn           NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_mxn         NUMERIC(15,2) NOT NULL DEFAULT 0,      -- 총액(입금 예정 금액)
  status            TEXT NOT NULL DEFAULT 'posted'
                    CHECK (status IN ('posted','edit_pending','delete_pending','deleted')),
                    -- posted=정상반영 / edit_pending=수정승인대기 / delete_pending=삭제승인대기 / deleted=삭제됨
  txn_id            BIGINT REFERENCES transactions(id),    -- 입금 예정(AR) 연결
  owner_id          BIGINT REFERENCES users(id),           -- 영업 담당
  memo              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        BIGINT REFERENCES users(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        BIGINT REFERENCES users(id),
  deleted_at        TIMESTAMPTZ
);
CREATE TRIGGER trg_sales_invoices_upd BEFORE UPDATE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_si_customer ON sales_invoices (customer_id, inv_date);
CREATE INDEX IF NOT EXISTS idx_si_status   ON sales_invoices (status);
CREATE INDEX IF NOT EXISTS idx_si_due      ON sales_invoices (due_date);

-- 인보이스 품목 라인 -------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_invoice_lines (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id        BIGINT NOT NULL REFERENCES sales_invoices(id),
  product_id        BIGINT NOT NULL REFERENCES products(id),
  qty               NUMERIC(15,3) NOT NULL,
  list_price        NUMERIC(15,2) NOT NULL,               -- 정가(스냅샷)
  discount_rate     NUMERIC(5,2) NOT NULL DEFAULT 0,      -- 적용 할인율(%)
  unit_price        NUMERIC(15,2) NOT NULL,               -- 판매단가 = 정가×(1-할인/100)
  line_amount_mxn   NUMERIC(15,2) NOT NULL,               -- 라인금액(ex-IVA) = 판매단가×수량
  applied_unit_cost NUMERIC(15,2),                        -- 판매 시점 평균원가 스냅샷
  cogs_mxn          NUMERIC(15,2),                        -- 매출원가 = 수량×applied_unit_cost
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sil_invoice ON sales_invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS idx_sil_product ON sales_invoice_lines (product_id);

-- 수정/삭제 변경요청 (원본 불변, 디렉터 승인 시 반영) ----------------
CREATE TABLE IF NOT EXISTS sales_change_requests (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id    BIGINT NOT NULL REFERENCES sales_invoices(id),
  req_type      TEXT NOT NULL CHECK (req_type IN ('edit','delete')),
  payload       JSONB,                                    -- 수정 요청 시 변경 후 내용(헤더+라인)
  reason        TEXT,                                     -- 요청 사유
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
  requested_by  BIGINT REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    BIGINT REFERENCES users(id),
  decided_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_scr_invoice ON sales_change_requests (invoice_id);
CREATE INDEX IF NOT EXISTS idx_scr_status  ON sales_change_requests (status);

-- 재고이동 원장: 매출 라인 연결(소급 재계산용) -----------------------
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS sales_invoice_id      BIGINT REFERENCES sales_invoices(id);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS sales_invoice_line_id BIGINT REFERENCES sales_invoice_lines(id);

-- 입금 예정(AR) 연결: transactions → 매출 인보이스 -------------------
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sales_invoice_id BIGINT REFERENCES sales_invoices(id);
