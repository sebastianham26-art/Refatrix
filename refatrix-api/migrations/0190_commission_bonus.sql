-- =====================================================================
-- Refatrix ERP · 0190_commission_bonus
-- 영업사원 보상을 「커미션(율 기반)」과 「성과급 Bono(목표 달성률 기반)」로 분리.
--   · bonus_plans   : 사원별 성과급 정책 1건 (기준 매출/수금 · 적용기간 · 수금목표 산출옵션)
--   · bonus_targets : 월별 매출목표(수동 입력). 수금목표는 저장하지 않고 인보이스 만기에서 산출.
--   · bonus_tiers   : 달성률 구간별 정액 성과급 (계단식)
--   · bonus_payouts : 월 확정 시점 스냅샷(목표·실적·달성률·금액) — 확정 후 동결, 지급 추적
-- 커미션 쪽(commission_agent_periods 등)은 전혀 건드리지 않는다.
-- 멱등: IF NOT EXISTS 로 재실행 안전.
-- =====================================================================

-- 성과급 정책 (사원 1명당 1건) ---------------------------------------
CREATE TABLE IF NOT EXISTS bonus_plans (
  user_id          BIGINT PRIMARY KEY REFERENCES users(id),
  enabled          BOOLEAN NOT NULL DEFAULT true,
  basis            TEXT    NOT NULL DEFAULT 'revenue'
                   CHECK (basis IN ('revenue','collection')),   -- 목표 기준(매출/수금) — 사원별 하나 고정
  start_month      TEXT    NOT NULL,                            -- 'YYYY-MM'
  end_month        TEXT,                                        -- NULL = 지속(∞)
  include_overdue  BOOLEAN NOT NULL DEFAULT true,               -- 수금목표에 전월까지의 연체 미수 이월분 포함
  partial_credit   BOOLEAN NOT NULL DEFAULT true,               -- 수금실적에 부분수금을 비례 인정(false=완납분만)
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       BIGINT REFERENCES users(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       BIGINT REFERENCES users(id)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_bonus_plans_upd') THEN
    CREATE TRIGGER trg_bonus_plans_upd BEFORE UPDATE ON bonus_plans
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- 월별 매출목표(수동) -------------------------------------------------
-- 수금목표는 여기에 저장하지 않는다: 고객 결제조건(외상일)에서 만기도래액으로 산출하므로
-- 영업사원이 손댈 수 없고, 조작 여지도 없다.
CREATE TABLE IF NOT EXISTS bonus_targets (
  user_id        BIGINT NOT NULL REFERENCES users(id),
  month          TEXT   NOT NULL,                     -- 'YYYY-MM'
  revenue_target NUMERIC(15,2) NOT NULL DEFAULT 0,    -- ex-IVA
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     BIGINT REFERENCES users(id),
  PRIMARY KEY (user_id, month)
);

-- 달성률 구간별 성과급 (계단식) ---------------------------------------
CREATE TABLE IF NOT EXISTS bonus_tiers (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id   BIGINT NOT NULL REFERENCES users(id),
  min_rate  NUMERIC(6,2)  NOT NULL,      -- 달성률 하한(%)
  amount    NUMERIC(15,2) NOT NULL,      -- 그 구간 정액 성과급(MXN)
  UNIQUE (user_id, min_rate)
);
CREATE INDEX IF NOT EXISTS idx_bonus_tiers_user ON bonus_tiers (user_id, min_rate);

-- 월 확정 스냅샷 + 지급 추적 -------------------------------------------
CREATE TABLE IF NOT EXISTS bonus_payouts (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  settle_ym      TEXT   NOT NULL,                    -- 'YYYY-MM' (성과 달)
  basis          TEXT   NOT NULL CHECK (basis IN ('revenue','collection')),
  target_amount  NUMERIC(15,2) NOT NULL DEFAULT 0,   -- 확정 시점 목표(수금목표도 여기서 동결)
  actual_amount  NUMERIC(15,2) NOT NULL DEFAULT 0,
  achieved_rate  NUMERIC(8,2),                       -- 달성률(%) — 목표 0이면 NULL
  tier_min_rate  NUMERIC(6,2),                       -- 적용된 구간 하한(미달이면 NULL)
  amount         NUMERIC(15,2) NOT NULL DEFAULT 0,   -- 확정 성과급
  paid           BOOLEAN NOT NULL DEFAULT false,
  paid_date      DATE,
  payment_id     BIGINT REFERENCES commission_payments(id),
  confirmed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_by   BIGINT REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     BIGINT REFERENCES users(id),
  UNIQUE (user_id, settle_ym)
);
CREATE INDEX IF NOT EXISTS idx_bonus_payouts_ym   ON bonus_payouts (settle_ym);
CREATE INDEX IF NOT EXISTS idx_bonus_payouts_paid ON bonus_payouts (user_id, paid);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_bonus_payouts_upd') THEN
    CREATE TRIGGER trg_bonus_payouts_upd BEFORE UPDATE ON bonus_payouts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
