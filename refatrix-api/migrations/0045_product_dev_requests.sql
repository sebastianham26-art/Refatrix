-- =====================================================================
-- Refatrix ERP · 0045_product_dev_requests
--   케이스 3: 카탈로그 미등재 제품 개발요청(프로젝트) + 단계별 일정
--   + todos.kind (개발완료 등 특수 할 일 색상 구분용)
-- =====================================================================
CREATE TABLE IF NOT EXISTS product_dev_requests (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  input_code         TEXT,                                 -- 경쟁사(SYD) 코드 — 오더 접수 시
  customer_id        BIGINT REFERENCES customers(id),
  requested_qty      NUMERIC(15,3),
  order_memo         TEXT,
  -- 단계별 날짜
  requested_at       DATE NOT NULL DEFAULT CURRENT_DATE,    -- ① 오더 접수일
  reviewed_at        DATE,                                  -- ② 검토완료일
  factory_requested_at DATE,                                -- ③ 공장 개발요청일
  developed_at       DATE,                                  -- ④ 개발완료일
  -- 검토 단계 입력(제품·마케팅 담당)
  review_syd_code    TEXT,
  review_app         TEXT,
  review_list_price  NUMERIC(15,2),
  review_memo        TEXT,                                  -- 시장 판매수량 등
  -- 완료 결과
  result_product_id  BIGINT REFERENCES products(id),
  result_ctr_code    TEXT,
  status             TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','reviewed','factory_requested','developed','cancelled')),
  source_quote_id    BIGINT REFERENCES quotes(id),          -- 견적 전환에서 생성된 경우
  created_by         BIGINT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         BIGINT REFERENCES users(id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_devreq_status ON product_dev_requests (status);
CREATE INDEX IF NOT EXISTS idx_devreq_developed ON product_dev_requests (developed_at);
CREATE INDEX IF NOT EXISTS idx_devreq_customer ON product_dev_requests (customer_id);

-- 할 일 색상 구분용 태그(예: 'dev_complete')
ALTER TABLE todos ADD COLUMN IF NOT EXISTS kind TEXT;
