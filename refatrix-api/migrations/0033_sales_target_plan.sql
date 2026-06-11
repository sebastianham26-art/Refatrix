-- =====================================================================
-- Refatrix ERP · 0033_sales_target_plan
-- 매출 목표: 전체 월 목표(monthly_targets 재사용) → 팀 월 목표 →
--   고객 월 목표(담당자 할당) → 팀 단위 승인(담당자 제출 → 디렉터 승인).
-- 미래 12개월(YYYY-MM)을 한 페이지에서 입력. 부족분은 화면 경고.
-- =====================================================================

-- 팀 월 목표(디렉터가 전체에서 팀으로 할당)
CREATE TABLE IF NOT EXISTS target_team_months (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id     BIGINT NOT NULL REFERENCES sales_teams(id),
  ym          TEXT NOT NULL,                         -- 'YYYY-MM'
  amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT REFERENCES users(id),
  UNIQUE (team_id, ym)
);
CREATE INDEX IF NOT EXISTS idx_ttm_ym ON target_team_months (ym);

-- 고객 월 목표(담당자가 팀 목표를 고객으로 할당)
CREATE TABLE IF NOT EXISTS target_customer_months (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  ym          TEXT NOT NULL,                         -- 'YYYY-MM'
  amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT REFERENCES users(id),
  UNIQUE (customer_id, ym)
);
CREATE INDEX IF NOT EXISTS idx_tcm_ym ON target_customer_months (ym);
CREATE INDEX IF NOT EXISTS idx_tcm_cust ON target_customer_months (customer_id);

-- 팀 목표 계획 승인 상태(팀 단위)
CREATE TABLE IF NOT EXISTS target_team_status (
  team_id      BIGINT PRIMARY KEY REFERENCES sales_teams(id),
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','submitted','approved','rejected')),
  note         TEXT,
  submitted_by BIGINT REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  decided_by   BIGINT REFERENCES users(id),
  decided_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
