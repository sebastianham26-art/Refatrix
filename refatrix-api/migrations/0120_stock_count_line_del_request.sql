-- 재고실사 라인 삭제 요청/승인(디렉터 승인 후 삭제)
ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS del_requested_at TIMESTAMPTZ;
ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS del_requested_by BIGINT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_scl_del_req ON stock_count_lines (del_requested_at);
