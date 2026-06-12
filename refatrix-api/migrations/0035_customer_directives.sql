-- =====================================================================
-- Refatrix ERP · 0035_customer_directives
-- 디렉터 지시·피드백 → 담당자 읽음확인 → F/UP 완료(3단계).
--   status: open(작성) → read(읽음확인) → done(완료)
-- 각 단계 시각 로그로 전달·확인·후속이 되는지 추적.
-- =====================================================================

CREATE TABLE IF NOT EXISTS customer_directives (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  note         TEXT NOT NULL,                       -- 지시·피드백 내용
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','read','done')),
  created_by   BIGINT REFERENCES users(id),         -- 작성 디렉터
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_by      BIGINT REFERENCES users(id),         -- 읽음확인 담당자
  read_at      TIMESTAMPTZ,
  done_by      BIGINT REFERENCES users(id),         -- F/UP 완료 담당자
  done_at      TIMESTAMPTZ,
  done_note    TEXT                                 -- 완료 시 담당자 코멘트(선택)
);
CREATE INDEX IF NOT EXISTS idx_directive_cust ON customer_directives (customer_id);
CREATE INDEX IF NOT EXISTS idx_directive_status ON customer_directives (status);
