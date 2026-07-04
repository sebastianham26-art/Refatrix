-- =====================================================================
-- Refatrix ERP · 0115_marketing_spend
-- 마케팅 지출 계획(행사·활동 단위 기안 → 디렉터 수정·승인 → 자금계획 연결)
--   · 계획 1건 = 헤더 + 지급 라인 N(선지급/중도금/잔금/일시불) + 대상 N(고객/불특정) + 증빙 N
--   · 승인 시 지급 라인마다 transactions(status='plan', 6070) 생성 — 기존 마케팅 예산(0026)과 동일 패턴
--   · 실제 송금은 재무 예정 내역 [실적 처리](confirm-pay)로 확정 (기존 흐름 그대로)
-- =====================================================================

-- 계획 헤더 -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_spend_plans (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title         TEXT NOT NULL,                        -- 활동·행사명
  category      TEXT,                                 -- 행사·이벤트/판촉물/광고/전시회/고객접대/기타
  event_date    DATE,                                 -- 행사일(예정)
  purpose       TEXT,                                 -- 목적·내용
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','submitted','approved','rejected')),
  reject_reason TEXT,
  submitted_at  TIMESTAMPTZ,
  decided_by    BIGINT REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES users(id),
  deleted_at    TIMESTAMPTZ
);
CREATE TRIGGER trg_msp_upd BEFORE UPDATE ON marketing_spend_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_msp_status  ON marketing_spend_plans (status);
CREATE INDEX IF NOT EXISTS idx_msp_creator ON marketing_spend_plans (created_by);

-- 지급 라인(선지급금·중도금·잔금·일시불) -------------------------------
CREATE TABLE IF NOT EXISTS marketing_spend_lines (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id     BIGINT NOT NULL REFERENCES marketing_spend_plans(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'one'
              CHECK (kind IN ('adv','mid','fin','one')),  -- 선지급/중도금/잔금/일시불
  due_date    DATE NOT NULL,                              -- 지급 예정일
  amount      NUMERIC(15,2) NOT NULL DEFAULT 0,           -- MXN
  memo        TEXT,                                       -- 명목·메모
  sort_order  INT NOT NULL DEFAULT 0,
  txn_id      BIGINT REFERENCES transactions(id)          -- 승인 시 생성된 계획 거래
);
CREATE INDEX IF NOT EXISTS idx_msl_plan ON marketing_spend_lines (plan_id);
CREATE INDEX IF NOT EXISTS idx_msl_txn  ON marketing_spend_lines (txn_id);

-- 마케팅 대상(등록 고객 복수 + 불특정 다수) ----------------------------
CREATE TABLE IF NOT EXISTS marketing_spend_targets (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id     BIGINT NOT NULL REFERENCES marketing_spend_plans(id) ON DELETE CASCADE,
  customer_id BIGINT REFERENCES customers(id),            -- NULL이면 불특정 다수
  is_general  BOOLEAN NOT NULL DEFAULT false              -- true = 불특정 다수
);
CREATE INDEX IF NOT EXISTS idx_mst_plan ON marketing_spend_targets (plan_id);
CREATE INDEX IF NOT EXISTS idx_mst_cust ON marketing_spend_targets (customer_id);

-- 증빙자료(계획당 N개, base64 — 인보이스 첨부(0091)와 동일 패턴) --------
CREATE TABLE IF NOT EXISTS marketing_spend_files (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id     BIGINT NOT NULL REFERENCES marketing_spend_plans(id) ON DELETE CASCADE,
  file_name   TEXT,
  mime_type   TEXT,
  file_data   TEXT NOT NULL,
  file_size   BIGINT,
  uploaded_by BIGINT REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msf_plan ON marketing_spend_files (plan_id);
