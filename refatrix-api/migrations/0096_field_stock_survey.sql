-- =====================================================================
-- Refatrix ERP · 0096_field_stock_survey
--   현장재고조사 — 영업사원이 고객창고에서 경쟁사/CTR 코드를 입력하면
--   서버가 코드를 자동 분류(즉시매출가능 / 재고부족 / 개발필요)하고
--   한 건마다 즉시 저장(데이터 분실 차단)한다.
--   "모두 완료" 시 개발필요 줄은 자동으로 개발요청(product_dev_requests) 등록.
--   매칭된 줄은 견적(quotes)으로 발송 가능.
-- =====================================================================

-- 조사 헤더 (고객 × 방문 단위) ----------------------------------------
CREATE TABLE IF NOT EXISTS field_surveys (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id   BIGINT REFERENCES customers(id),
  customer_name TEXT,                                  -- 고객명 스냅샷
  survey_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','completed','quoted','cancelled')),
  note          TEXT,
  completed_at  TIMESTAMPTZ,
  quote_id      BIGINT REFERENCES quotes(id),          -- 견적 전환 시 연결
  dev_req_count INT NOT NULL DEFAULT 0,                -- 완료 시 자동 등록된 개발요청 수
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_fsurvey_customer ON field_surveys (customer_id);
CREATE INDEX IF NOT EXISTS idx_fsurvey_creator  ON field_surveys (created_by);
CREATE INDEX IF NOT EXISTS idx_fsurvey_status   ON field_surveys (status);

DROP TRIGGER IF EXISTS trg_fsurvey_upd ON field_surveys;
CREATE TRIGGER trg_fsurvey_upd BEFORE UPDATE ON field_surveys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 조사 줄 (코드 한 건 = 한 줄, 입력 즉시 저장) -------------------------
CREATE TABLE IF NOT EXISTS field_survey_lines (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  survey_id      BIGINT NOT NULL REFERENCES field_surveys(id) ON DELETE CASCADE,
  line_no        INTEGER,
  input_code     TEXT NOT NULL,                        -- 현장 입력 코드(CTR or 경쟁사)
  product_id     BIGINT REFERENCES products(id),
  ctr_code       TEXT,                                 -- 매칭된 CTR 코드
  product_name   TEXT,
  app_text       TEXT,                                 -- 적용차종
  match_source   TEXT,                                 -- 'ctr' | 'syd' | 'none'
  avail_stock    NUMERIC(15,3),                        -- 저장 시점 가용재고(현재고 − 타 예약) 스냅샷
  observed_qty   NUMERIC(15,3) NOT NULL DEFAULT 1,     -- 고객창고 관측수량
  classification TEXT NOT NULL DEFAULT 'dev'
                 CHECK (classification IN ('imm','short','dev')),  -- 즉시/부족/개발
  dev_request_id BIGINT REFERENCES product_dev_requests(id),       -- 자동 개발요청 연결
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fsline_survey ON field_survey_lines (survey_id);
CREATE INDEX IF NOT EXISTS idx_fsline_ctr    ON field_survey_lines (ctr_code);

-- 개발요청에 현장재고조사 출처 연결(중복가드 + 추적용) -----------------
ALTER TABLE product_dev_requests
  ADD COLUMN IF NOT EXISTS field_survey_id BIGINT REFERENCES field_surveys(id);
CREATE INDEX IF NOT EXISTS idx_devreq_field_survey ON product_dev_requests (field_survey_id);
