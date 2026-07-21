-- =====================================================================
-- 커미션 기간별 조건 (영업사원별) — 매출/수금 기준 + 기간별 지급률
--   디렉터가 영업사원마다 "인보이스 발행일" 타임라인을 기간으로 나눠,
--   각 기간의 커미션 기준(매출/수금)과 지급률(%)을 지정한다.
--
--   - 기간 판정 기준 = 인보이스 발행일(sales_invoices.inv_date).
--   - 한 영업사원의 기간들은 서로 겹치지 않고 빈틈 없이 연속되며(앱에서 강제),
--     가장 최근 기간은 end_date=NULL(∞, 지속)로 두어 앞으로의 발행분을 항상 덮는다.
--     → 어떤 인보이스도 "어느 기간에도 안 속하는" 상태가 되지 않는다.
--   - basis='revenue'(매출)  : 인보이스 발행 즉시 전액 확정(수금 무관).
--     basis='collection'(수금): 인보이스 반제완납 시 전액 확정(기존 동작).
--   - 한 인보이스는 발행일이 속하는 기간이 정확히 하나뿐이므로,
--     매출 기준과 수금 기준이 중복 적용될 수 없다(이중지급 원천 차단).
--   - 지급률은 기간값이 base. 고객별 예외율(commission_customer_rates)이
--     있으면 그 인보이스에 한해 예외율이 우선한다(율만 override, 기준은 기간값 유지).
--
--   [이관] 기존 commission_agents(effective_from + default_rate)을
--          [effective_from~∞ · 수금 · 기존율] 기간 한 줄로 옮겨,
--          지금까지의 동작(반제완납 시 확정)을 그대로 보존한다.
-- =====================================================================

CREATE TABLE IF NOT EXISTS commission_agent_periods (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  start_date  DATE NOT NULL,
  end_date    DATE,                                     -- NULL = ∞ (지속·최신 기간)
  basis       TEXT NOT NULL DEFAULT 'collection'
              CHECK (basis IN ('revenue','collection')),
  rate        NUMERIC(6,3) NOT NULL DEFAULT 0,          -- 지급률(%)
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT comm_period_range_ok CHECK (end_date IS NULL OR end_date >= start_date),
  UNIQUE (user_id, start_date)
);

CREATE INDEX IF NOT EXISTS idx_comm_period_user ON commission_agent_periods (user_id, start_date);

-- 기존 대상 영업사원(기본률 지정됨)을 기간 한 줄로 이관.
--   effective_from 이 있으면 그 날부터, 없으면 전체 기간(2000-01-01 바닥) ~ ∞.
--   기준은 'collection'(수금·반제완납) → 지금까지의 확정 동작과 동일.
INSERT INTO commission_agent_periods (user_id, start_date, end_date, basis, rate, created_by)
SELECT ca.user_id,
       COALESCE(ca.effective_from, DATE '2000-01-01'),
       NULL,
       'collection',
       COALESCE(ca.default_rate, 0),
       ca.created_by
  FROM commission_agents ca
 WHERE ca.default_rate IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM commission_agent_periods p WHERE p.user_id = ca.user_id);
