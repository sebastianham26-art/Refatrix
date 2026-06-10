-- =====================================================================
-- Refatrix ERP · 0020_txn_change_requests
-- 일반 거래(직접 등록한 수입·지출)의 수정·삭제 승인 워크플로.
-- 이미 승인·반영된 거래는 원본 유지 + 변경요청 저장 → 디렉터 승인 시 되돌림+재적용.
-- 매출 연동 거래(sales_invoice_id 있는 것)와 미승인 거래는 대상 아님(라우트에서 차단).
-- =====================================================================

CREATE TABLE IF NOT EXISTS txn_change_requests (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txn_id        BIGINT NOT NULL REFERENCES transactions(id),
  req_type      TEXT NOT NULL CHECK (req_type IN ('edit','delete')),
  payload       JSONB,                                  -- 수정 요청 시 변경 후 내용
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
  requested_by  BIGINT REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    BIGINT REFERENCES users(id),
  decided_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_txn_cr_status ON txn_change_requests (status);
CREATE INDEX IF NOT EXISTS idx_txn_cr_txn    ON txn_change_requests (txn_id);

-- 거래 상태에 변경요청 진행중 표시용 컬럼(원본 보호)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS change_status TEXT
  CHECK (change_status IN ('edit_pending','delete_pending'));
