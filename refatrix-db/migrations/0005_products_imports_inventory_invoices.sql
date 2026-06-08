-- =====================================================================
-- Refatrix ERP · 0005_products_imports_inventory_invoices
-- 제품 마스터 · 수입 입고(이동평균) · 입출고 · 매출내역
-- =====================================================================

-- 제품 마스터 (Product & Marketing 담당) ---------------------------
CREATE TABLE products (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,                  -- 제품코드
  scode       TEXT,                                  -- 보조코드
  app         TEXT,                                  -- 적용/용도
  ean         TEXT,                                  -- 바코드
  name        TEXT,
  list_price  NUMERIC(15,2) DEFAULT 0,               -- 정가
  discount    NUMERIC(5,2) DEFAULT 0,                -- 기본 할인율(%)
  iva_rate    NUMERIC(5,2) DEFAULT 16,               -- 부가세율(%)
  stock_qty   NUMERIC(15,3) NOT NULL DEFAULT 0,      -- 재고(입출고로만 변동)
  avg_cost    NUMERIC(15,2) NOT NULL DEFAULT 0,      -- 이동평균 단위원가(MXN)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT REFERENCES users(id),
  deleted_at  TIMESTAMPTZ
);
CREATE TRIGGER trg_products_upd BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- SKU ~5,000 검색 대비 인덱스
CREATE INDEX idx_products_code ON products (code);
CREATE INDEX idx_products_ean  ON products (ean);
CREATE INDEX idx_products_name ON products (name);

-- 수입 입고 헤더 -----------------------------------------------------
CREATE TABLE import_batches (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_no     TEXT,                                 -- 수입 건/선적 번호
  import_date  DATE NOT NULL,                        -- 입고일(환율 기준일)
  currency     TEXT NOT NULL DEFAULT 'USD',
  fx_rate      NUMERIC(15,6) NOT NULL,               -- 입고일 환율(자동, 수정 가능)
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','pending','approved','rejected')),
  created_by   BIGINT REFERENCES users(id),          -- 영업지원 작성자
  approved_by  BIGINT REFERENCES users(id),
  approved_at  TIMESTAMPTZ,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE TRIGGER trg_import_batches_upd BEFORE UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_import_batches_status ON import_batches (status);

-- 입고 라인(SKU별) ---------------------------------------------------
CREATE TABLE import_lines (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id        BIGINT NOT NULL REFERENCES import_batches(id),
  product_id      BIGINT NOT NULL REFERENCES products(id),
  qty             NUMERIC(15,3) NOT NULL,
  import_price    NUMERIC(15,2) NOT NULL,            -- 수입단가(원통화)
  alloc_overhead  NUMERIC(15,2) NOT NULL DEFAULT 0,  -- 배분된 부대비용(MXN, 1/n)
  unit_cost_mxn   NUMERIC(15,2),                     -- 입고 단위원가(MXN)
  avg_cost_after  NUMERIC(15,2)                      -- 갱신 후 평균원가(스냅샷)
);
CREATE INDEX idx_import_lines_batch ON import_lines (batch_id);
CREATE INDEX idx_import_lines_prod  ON import_lines (product_id);

-- 부대비용 라인(명목·인보이스별) -----------------------------------
CREATE TABLE import_overheads (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id    BIGINT NOT NULL REFERENCES import_batches(id),
  label       TEXT NOT NULL,                         -- 명목(직접 입력)
  amount      NUMERIC(15,2) NOT NULL,                -- 금액(원통화)
  currency    TEXT,
  invoice_no  TEXT
);
CREATE INDEX idx_import_overheads_batch ON import_overheads (batch_id);

-- 입출고 원장 --------------------------------------------------------
CREATE TABLE stock_movements (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES products(id),
  move_type      TEXT NOT NULL CHECK (move_type IN ('in','out','adjust')),
  qty            NUMERIC(15,3) NOT NULL,
  unit_cost_mxn  NUMERIC(15,2),
  ref            TEXT,                                -- 근거(batch:#, invoice:# 등)
  moved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT REFERENCES users(id)
);
CREATE INDEX idx_stock_moves_prod ON stock_movements (product_id, moved_at);

-- 매출내역(SAT) ------------------------------------------------------
CREATE TABLE invoices (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sat_no             TEXT UNIQUE,                     -- SAT 넘버
  customer_id        BIGINT NOT NULL REFERENCES customers(id),
  product_id         BIGINT NOT NULL REFERENCES products(id),
  qty                NUMERIC(15,3) NOT NULL,
  unit_price         NUMERIC(15,2) NOT NULL,          -- 판매단가(ex-IVA)
  iva_rate           NUMERIC(5,2) DEFAULT 16,
  inv_date           DATE NOT NULL,
  credit_days        INT DEFAULT 0,
  applied_unit_cost  NUMERIC(15,2),                   -- 판매 적용 단위원가(평균 스냅샷)
  cogs               NUMERIC(15,2),                   -- 매출원가 = qty × applied_unit_cost
  txn_id             BIGINT REFERENCES transactions(id),
  owner_id           BIGINT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         BIGINT REFERENCES users(id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         BIGINT REFERENCES users(id),
  deleted_at         TIMESTAMPTZ
);
CREATE TRIGGER trg_invoices_upd BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_invoices_cust ON invoices (customer_id, inv_date);
CREATE INDEX idx_invoices_prod ON invoices (product_id);
CREATE INDEX idx_invoices_date ON invoices (inv_date);

-- 이동평균 원가 규칙(주석) -----------------------------------------
--  입고 단위원가 = import_price*fx_rate + (Σ부대비용(MXN) ÷ 선적 총수량)   [1/n 균등배분]
--  새 평균 = (기존수량*기존평균 + 입고수량*입고단위원가)/(기존수량+입고수량)
--  디렉터 승인(status=approved) 시에만 products.avg_cost·stock_qty 갱신,
--    import_lines.avg_cost_after 기록, stock_movements(in) 생성.
--  판매 시 products.avg_cost → invoices.applied_unit_cost 스냅샷, cogs 계산,
--    stock_movements(out) 생성. (판매는 평균원가를 바꾸지 않음)
