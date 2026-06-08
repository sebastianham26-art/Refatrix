-- =====================================================================
-- Refatrix ERP · 0006_marketing
-- 마케팅 메뉴(카탈로그) · 마케팅 활동
-- =====================================================================

-- 마케팅 메뉴(활동 종류 + 단위예산) --------------------------------
CREATE TABLE activity_catalog (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL,                       -- 예: SNS광고, 전시회부스
  category      TEXT,                                -- 표시용 분류
  category_code TEXT REFERENCES categories(code),    -- 연결 과목(예: 6070)
  unit_budget   NUMERIC(15,2) NOT NULL DEFAULT 0,    -- 단위 예산(단가)
  unit          TEXT,                                -- 단위(건/회 등)
  deleted_at    TIMESTAMPTZ
);

-- 마케팅 활동(편성·집행) -------------------------------------------
CREATE TABLE marketing_activities (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  catalog_id     BIGINT REFERENCES activity_catalog(id),
  name           TEXT NOT NULL,                       -- 선택 메뉴명(스냅샷)
  category       TEXT,
  category_code  TEXT REFERENCES categories(code),
  customer_id    BIGINT REFERENCES customers(id),     -- 고객 연결(전사면 NULL)
  qty            NUMERIC(15,3) NOT NULL DEFAULT 0,
  unit_budget    NUMERIC(15,2) NOT NULL DEFAULT 0,    -- 단가(편성 = qty*unit_budget)
  actual         NUMERIC(15,2) NOT NULL DEFAULT 0,    -- 집행액
  act_date       DATE,
  owner_id       BIGINT REFERENCES users(id),
  memo           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     BIGINT REFERENCES users(id),
  deleted_at     TIMESTAMPTZ
);
CREATE TRIGGER trg_mkt_acts_upd BEFORE UPDATE ON marketing_activities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_mkt_acts_cust ON marketing_activities (customer_id);
CREATE INDEX idx_mkt_acts_date ON marketing_activities (act_date);
