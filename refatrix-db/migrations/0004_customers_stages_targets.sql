-- =====================================================================
-- Refatrix ERP · 0004_customers_stages_targets
-- 단계 · 고객 · 단계 이력 · 전사월목표 · 고객별 매출목표
-- =====================================================================

-- 파이프라인 단계(마스터) ------------------------------------------
CREATE TABLE stages (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  deleted_at  TIMESTAMPTZ
);

-- 고객 ---------------------------------------------------------------
CREATE TABLE customers (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,                -- 고객번호 C-0001
  name          TEXT NOT NULL,
  rfc           TEXT,                                -- 멕시코 세금번호
  contact       TEXT,
  phone         TEXT,
  discount      NUMERIC(5,2) DEFAULT 0,              -- 기본 할인율(%)
  stage_id      BIGINT REFERENCES stages(id),
  stage_since   DATE,                                -- 현재 단계 진입일(홀딩 계산)
  owner_id      BIGINT REFERENCES users(id),         -- 영업 담당
  memo          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES users(id),
  deleted_at    TIMESTAMPTZ
);
CREATE TRIGGER trg_customers_upd BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_customers_owner ON customers (owner_id);
CREATE INDEX idx_customers_stage ON customers (stage_id);

-- 단계 변경 이력 -----------------------------------------------------
CREATE TABLE stage_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  prev_stage   BIGINT REFERENCES stages(id),
  new_stage    BIGINT REFERENCES stages(id),
  direction    TEXT CHECK (direction IN ('forward','back','same')),
  user_id      BIGINT REFERENCES users(id),
  log_date     DATE NOT NULL,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stagelog_cust ON stage_log (customer_id);
CREATE INDEX idx_stagelog_date ON stage_log (log_date);

-- 전사 월 매출목표 ---------------------------------------------------
CREATE TABLE monthly_targets (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ym          TEXT NOT NULL UNIQUE,                  -- YYYY-MM
  amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT REFERENCES users(id)
);
CREATE TRIGGER trg_monthly_targets_upd BEFORE UPDATE ON monthly_targets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 고객별 매출목표(거래 kind=sales 와 연결) --------------------------
CREATE TABLE sales_targets (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txn_id       BIGINT REFERENCES transactions(id),
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  sale_date    DATE NOT NULL,
  amount       NUMERIC(15,2) NOT NULL,
  credit_days  INT DEFAULT 0,
  owner_id     BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE TRIGGER trg_sales_targets_upd BEFORE UPDATE ON sales_targets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_sales_targets_cust ON sales_targets (customer_id, sale_date);
