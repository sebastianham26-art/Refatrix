-- =====================================================================
-- Refatrix ERP · 0026_marketing_budget
-- 마케팅 예산: 디렉터가 기간+매출목표→5% 한도를 개설 →
--   마케팅 담당이 월별 항목(카테고리·항목명·수량·단가·예측불허) 작성 →
--   디렉터 항목별 승인 → 승인 시 마케팅(6070) 계획 거래(plan) 생성 →
--   실제 집행은 예정 내역에서 실적 처리(판관비) → 계획대비 실적 자동 집계.
-- 고객별 배분/메뉴판 연결은 매출목표 메뉴 이후 단계.
-- =====================================================================

-- 예산 기간(디렉터 개설) --------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_budget_periods (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title         TEXT NOT NULL,                         -- 예: 2026 상반기 마케팅 예산
  start_month   TEXT NOT NULL,                         -- 'YYYY-MM'
  end_month     TEXT NOT NULL,                         -- 'YYYY-MM'
  sales_target  NUMERIC(15,2) NOT NULL DEFAULT 0,      -- 매출목표(수동입력, MXN)
  pct           NUMERIC(5,2) NOT NULL DEFAULT 5,       -- 예산 비율(%) 기본 5
  limit_amount  NUMERIC(15,2) NOT NULL DEFAULT 0,      -- 한도(=target*pct/100, 디렉터 조정 가능)
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','closed')),
  memo          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES users(id),
  deleted_at    TIMESTAMPTZ
);
CREATE TRIGGER trg_mbp_upd BEFORE UPDATE ON marketing_budget_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_mbp_status ON marketing_budget_periods (status);

-- 예산 항목(마케팅/디렉터 작성, 항목별 승인) ------------------------
CREATE TABLE IF NOT EXISTS marketing_budget_items (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_id     BIGINT NOT NULL REFERENCES marketing_budget_periods(id),
  category      TEXT,                                  -- 자유 입력(쌓이면 드롭다운). 예: 인쇄물/행사/디지털
  name          TEXT NOT NULL,                         -- 항목명. 예: 카탈로그 인쇄
  plan_month    TEXT NOT NULL,                         -- 'YYYY-MM' 예정 월
  date_unknown  BOOLEAN NOT NULL DEFAULT false,        -- 예측불허(날짜 미정)
  plan_date     DATE,                                  -- 결정된 예정일(예측불허면 그 달 마지막 워킹데이)
  qty           NUMERIC(15,3) NOT NULL DEFAULT 1,      -- 수량
  unit_price    NUMERIC(15,2) NOT NULL DEFAULT 0,      -- 단가
  amount        NUMERIC(15,2) NOT NULL DEFAULT 0,      -- 금액 = qty*unit_price (MXN)
  category_code TEXT NOT NULL DEFAULT '6070',          -- 계정과목(마케팅비, 판관비)
  memo          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
  txn_id        BIGINT REFERENCES transactions(id),    -- 승인 시 생성된 계획 거래
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES users(id),
  decided_by    BIGINT REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES users(id),
  deleted_at    TIMESTAMPTZ
);
CREATE TRIGGER trg_mbi_upd BEFORE UPDATE ON marketing_budget_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_mbi_period ON marketing_budget_items (period_id);
CREATE INDEX IF NOT EXISTS idx_mbi_status ON marketing_budget_items (status);
CREATE INDEX IF NOT EXISTS idx_mbi_category ON marketing_budget_items (category);
