-- =====================================================================
-- 0254 · 고정급여 단계표 (2026-10-06 · 디렉터 결정)
--   커미션 전환 기간에 월 고정급여가 단계적으로 조정되는 경우(예: Oscar 2026-10 ~ 2027-03),
--   적용 시작일·종료일(월이 아니라 날짜)과 금액을 기록한다.
--   커미션 조건 합의 문서(0251)에 「Tu sueldo fijo mensual」 표로 나오고,
--   단계표가 바뀌면 그 사람의 조건 버전이 바뀌어 재합의 대상이 된다.
--   end_date NULL = 그 날부터 계속(∞).
-- =====================================================================

CREATE TABLE IF NOT EXISTS commission_salary_steps (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  start_date  DATE   NOT NULL,
  end_date    DATE,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount >= 0),   -- 월 고정급여(MXN)
  note        TEXT,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT salary_step_range_ok CHECK (end_date IS NULL OR end_date >= start_date),
  UNIQUE (user_id, start_date)
);

CREATE INDEX IF NOT EXISTS idx_salary_steps_user ON commission_salary_steps (user_id, start_date);
