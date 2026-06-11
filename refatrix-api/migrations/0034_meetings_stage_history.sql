-- =====================================================================
-- Refatrix ERP · 0034_meetings_stage_history
-- 영업미팅 기록 + 고객 단계 이력(병목 분석용).
--   · customer_meetings        : 미팅 일자·내용·단계 변화
--   · customer_stage_history   : 단계 진입/이탈(체류기간·병목 계산)
-- 기존 고객은 현재 단계로 진입 이력을 1건 백필.
-- =====================================================================

CREATE TABLE IF NOT EXISTS customer_meetings (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  meeting_date DATE NOT NULL,
  note         TEXT,
  stage_before BIGINT REFERENCES stages(id),
  stage_after  BIGINT REFERENCES stages(id),
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cmeet_cust ON customer_meetings (customer_id, meeting_date);

CREATE TABLE IF NOT EXISTS customer_stage_history (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  stage_id     BIGINT REFERENCES stages(id),
  entered_at   DATE NOT NULL,
  left_at      DATE,                               -- NULL = 현재 단계
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cshist_cust ON customer_stage_history (customer_id);
CREATE INDEX IF NOT EXISTS idx_cshist_open ON customer_stage_history (stage_id) WHERE left_at IS NULL;

-- 기존 고객: 현재 단계로 열린 이력 백필(없을 때만)
INSERT INTO customer_stage_history (customer_id, stage_id, entered_at)
  SELECT c.id, c.stage_id, COALESCE(c.stage_since, c.created_at::date, CURRENT_DATE)
    FROM customers c
   WHERE c.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM customer_stage_history h WHERE h.customer_id=c.id AND h.left_at IS NULL);
