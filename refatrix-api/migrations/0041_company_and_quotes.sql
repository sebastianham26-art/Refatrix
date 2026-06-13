-- =====================================================================
-- Refatrix ERP · 0041_company_and_quotes
--   ① company_settings : 회사정보 + 로고(base64) — 견적서/포털 공통
--   ② quotes / quote_lines : 견적(수주관리) — 작성·저장·열람·수정·매출전환
-- =====================================================================

-- ① 회사 설정(단일 행, id=1 고정) ----------------------------------
CREATE TABLE IF NOT EXISTS company_settings (
  id           INT PRIMARY KEY DEFAULT 1,
  emisor       TEXT,
  domicilio    TEXT,
  homepage     TEXT,
  rfc          TEXT,
  phone        TEXT,
  email        TEXT,
  logo_data    TEXT,                                  -- data:image/...;base64,...
  updated_by   BIGINT REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);
INSERT INTO company_settings (id, emisor, domicilio, homepage)
VALUES (1, 'Refatrix', 'Pedraplen 133, Nuevo Centro Urbano, Apodaca, Nuevo León, México 66603', 'refatrix.com.mx')
ON CONFLICT (id) DO NOTHING;

-- ② 견적 헤더 -------------------------------------------------------
CREATE TABLE IF NOT EXISTS quotes (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_no      TEXT UNIQUE,                          -- Q-2026-0001
  customer_id   BIGINT NOT NULL REFERENCES customers(id),
  quote_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  discount_rate NUMERIC(5,2) NOT NULL DEFAULT 0,      -- 견적 시점 고객 할인율 스냅샷
  iva_rate      NUMERIC(5,2) NOT NULL DEFAULT 16,
  memo          TEXT,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','confirmed','converted','cancelled')),
  -- 합계 스냅샷(ex-IVA 소계 / IVA / 총액 / 총수량 / 품목수)
  subtotal_mxn  NUMERIC(15,2) NOT NULL DEFAULT 0,
  iva_mxn       NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_mxn     NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_qty     NUMERIC(15,3) NOT NULL DEFAULT 0,
  sku_count     INT NOT NULL DEFAULT 0,
  invoice_id    BIGINT REFERENCES sales_invoices(id), -- 매출 전환 시 연결
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes (customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_date ON quotes (quote_date);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes (status);

-- ③ 견적 줄 ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS quote_lines (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_id        BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  line_no         INT NOT NULL DEFAULT 0,
  product_id      BIGINT REFERENCES products(id),       -- 매칭 실패 시 NULL
  input_code      TEXT,                                 -- 사용자가 입력한 코드(CTR 또는 SYD)
  ctr_code        TEXT,                                 -- 매칭된 CTR 코드
  syd_codes       TEXT,                                 -- 해당 제품의 SYD 코드들(' / ' 결합, 표시용)
  product_name    TEXT,
  app_text        TEXT,                                 -- application(차량적용)
  qty             NUMERIC(15,3) NOT NULL DEFAULT 0,
  list_price      NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_rate   NUMERIC(5,2) NOT NULL DEFAULT 0,
  final_price     NUMERIC(15,2) NOT NULL DEFAULT 0,     -- 단가(할인 후, ex-IVA)
  line_subtotal   NUMERIC(15,2) NOT NULL DEFAULT 0,     -- final_price × qty
  line_iva        NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_total      NUMERIC(15,2) NOT NULL DEFAULT 0,     -- IVA 포함 라인 총액
  avail_stock     NUMERIC(15,3),                        -- 견적 시점 가용재고 스냅샷
  stock_flag      TEXT NOT NULL DEFAULT 'ok'
                  CHECK (stock_flag IN ('ok','low_stock','not_found')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qlines_quote ON quote_lines (quote_id);
