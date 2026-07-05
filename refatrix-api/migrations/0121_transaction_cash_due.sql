-- 0121: 거래(지출)에 '현금받아야함' 표시 — 금고 등에서 나간 지출 중 디렉터가 현금으로 회수할 항목.
-- cash_due          : 플래그 (등록 시 체크 또는 디렉터가 목록/상세에서 지정)
-- cash_due_done_at  : 디렉터가 현금 수령 완료한 시각 (NULL = 미수령)
-- cash_due_done_by  : 수령 확인자
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_due BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_due_done_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_due_done_by BIGINT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_txn_cash_due ON transactions (cash_due) WHERE cash_due = TRUE;
