-- 출고완료(shipped) 상태: 출고 대기에서 수동으로 내보냄(디렉터 승인)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS shipped_by INTEGER;
CREATE INDEX IF NOT EXISTS idx_quotes_shipped_at ON quotes(shipped_at);
