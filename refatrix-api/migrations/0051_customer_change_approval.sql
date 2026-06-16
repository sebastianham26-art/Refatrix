-- =====================================================================
-- Refatrix ERP · 0051_customer_change_approval
--   고객 정보 수정은 디렉터 승인을 거친다(신규 등록은 즉시).
--   비디렉터의 수정 요청을 보관 → 디렉터 승인 시 customers에 반영.
-- =====================================================================
CREATE TABLE IF NOT EXISTS customer_change_requests (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES customers(id),
  proposed      JSONB NOT NULL,                 -- 변경 제안 필드 모음
  status        TEXT NOT NULL DEFAULT 'pending' -- pending | approved | rejected
                CHECK (status IN ('pending','approved','rejected')),
  requested_by  BIGINT REFERENCES users(id),
  reason        TEXT,                           -- 요청자 메모(선택)
  decided_by    BIGINT REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  reject_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_custchg_pending ON customer_change_requests (customer_id) WHERE status='pending';
