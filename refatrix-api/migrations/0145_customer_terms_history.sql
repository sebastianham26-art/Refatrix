-- 0145: 기본할인(%)·외상일 변경 통제
--  1) customer_terms_history — 할인·외상일 변경이력(날짜·이전→이후·수정이유·제공조건·요청자·승인자)
--  2) customer_change_requests.conditions — 승인요청에 "제공 조건" 텍스트 보관(수정이유는 기존 reason 재사용)
-- 멱등: IF NOT EXISTS 로 재실행 안전.

CREATE TABLE IF NOT EXISTS customer_terms_history (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  field        TEXT   NOT NULL,          -- 'discount' | 'credit_days'
  old_value    NUMERIC,
  new_value    NUMERIC,
  reason       TEXT,                     -- 수정이유
  conditions   TEXT,                     -- 제공 조건
  changed_by   BIGINT REFERENCES users(id),   -- 변경(요청)자
  approved_by  BIGINT REFERENCES users(id),   -- 승인자(디렉터 본인 변경이면 본인)
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cth_customer ON customer_terms_history (customer_id, changed_at DESC);

ALTER TABLE customer_change_requests ADD COLUMN IF NOT EXISTS conditions TEXT;
