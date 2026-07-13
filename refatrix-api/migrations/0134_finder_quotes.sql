-- 0134: 제품찾기 전용 견적 저장소 (finder_quotes)
--   · 공용 견적(quotes/quote_lines · 영업>견적·매출추적)과 완전 분리 —
--     경쟁사 카탈로그 기반 비교 견적은 제품 구성이 달라 같은 리스트로 관리 불가.
--   · 저장·조회는 제품찾기 화면에서만. 재고 예약·수주 단계 등 공용 파이프라인과 무관.
--   · 금액 계산은 공용과 동일 함수(src/quotes.js computeQuoteLine/Totals) 재사용 → 수치 일치.

CREATE TABLE IF NOT EXISTS finder_quotes (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id   BIGINT REFERENCES customers(id),      -- 기존 고객 선택 시
  customer_name TEXT NOT NULL,                        -- 표시용 (기존 고객명 또는 신규 입력명)
  discount_rate NUMERIC(6,2)  NOT NULL DEFAULT 0,
  iva_rate      NUMERIC(6,2)  NOT NULL DEFAULT 16,
  subtotal_mxn  NUMERIC(15,2) NOT NULL DEFAULT 0,
  iva_mxn       NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_mxn     NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_qty     NUMERIC(15,3) NOT NULL DEFAULT 0,
  sku_count     INT           NOT NULL DEFAULT 0,
  memo          TEXT,
  created_by    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS finder_quote_lines (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fq_id         BIGINT NOT NULL REFERENCES finder_quotes(id) ON DELETE CASCADE,
  line_no       INT NOT NULL,
  product_id    BIGINT,
  input_code    TEXT,                                 -- 업로드된 원본(경쟁사) 코드
  ctr_code      TEXT,
  syd_codes     TEXT,                                 -- ' / ' 연결 문자열
  product_name  TEXT,
  app_text      TEXT,
  qty           NUMERIC(15,3) NOT NULL DEFAULT 0,
  list_price    NUMERIC(15,2) NOT NULL DEFAULT 0,
  discount_rate NUMERIC(6,2)  NOT NULL DEFAULT 0,
  final_price   NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_iva      NUMERIC(15,2) NOT NULL DEFAULT 0,
  line_total    NUMERIC(15,2) NOT NULL DEFAULT 0,
  avail_stock   NUMERIC(15,3),
  stock_flag    TEXT
);
CREATE INDEX IF NOT EXISTS idx_fql_fq ON finder_quote_lines (fq_id);
CREATE INDEX IF NOT EXISTS idx_fq_created ON finder_quotes (created_at DESC);
