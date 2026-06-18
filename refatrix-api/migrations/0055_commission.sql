-- =====================================================================
-- 커미션 모듈 (구조)
--   - 커미션 대상 영업사원 + 기본 지급률(%)
--   - 고객별 예외 지급률(있으면 우선)
--   - 커미션 지급 상태(인보이스 단위) 기록
-- 계산은 sales_invoices(subtotal_mxn=ex-IVA, owner_id=담당) + 반제(allocations)에서 파생.
-- 지급 로직: 반제(완납)된 달의 익월 15일 지급.
-- =====================================================================

-- (1) 커미션 대상 영업사원 + 기본률
CREATE TABLE IF NOT EXISTS commission_agents (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id),
  default_rate  NUMERIC(6,3) NOT NULL DEFAULT 0,   -- 기본 지급률(%)
  active        BOOLEAN NOT NULL DEFAULT true,
  note          TEXT,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (2) 고객별 예외 지급률 (해당 영업사원·고객 조합에만 적용; 있으면 기본률 대신)
CREATE TABLE IF NOT EXISTS commission_customer_rates (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  customer_id   BIGINT NOT NULL REFERENCES customers(id),
  rate          NUMERIC(6,3) NOT NULL,             -- 예외 지급률(%)
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, customer_id)
);

-- (3) 커미션 지급 상태(인보이스 단위). 반제 완료로 확정된 커미션의 실제 지급 여부.
CREATE TABLE IF NOT EXISTS commission_payouts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id    BIGINT NOT NULL REFERENCES sales_invoices(id),
  agent_id      BIGINT NOT NULL REFERENCES users(id),   -- 지급 대상(=인보이스 owner)
  amount        NUMERIC(15,2) NOT NULL DEFAULT 0,       -- 확정 커미션 금액(MXN)
  settle_ym     TEXT,                                   -- 반제(완납)된 달 'YYYY-MM'
  due_date      DATE,                                   -- 지급 예상일(익월 15일)
  paid          BOOLEAN NOT NULL DEFAULT false,
  paid_date     DATE,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_comm_cust_rate_user ON commission_customer_rates (user_id);
CREATE INDEX IF NOT EXISTS idx_comm_payout_agent ON commission_payouts (agent_id);

-- (4) 페이지 권한: 영업사원(sales)에게 'commission' 조회 부여(본인 내역만 열람).
--     디렉터는 ALL 권한이라 자동 포함. 그 외 역할은 부여하지 않음(영업사원·디렉터만).
INSERT INTO user_page_access (user_id, page_key, device_req, access)
SELECT u.id, 'commission', 'anywhere', 'view'
  FROM users u
 WHERE u.deleted_at IS NULL AND u.role = 'sales'
ON CONFLICT (user_id, page_key) DO NOTHING;
