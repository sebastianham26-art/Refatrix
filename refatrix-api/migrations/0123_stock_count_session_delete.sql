-- =====================================================================
-- 0123_stock_count_session_delete  (실사 세션 삭제 요청/승인)
--   담당자가 세션 삭제를 요청 → 디렉터 승인 시 status='canceled'(목록에서 숨김).
-- =====================================================================
ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS del_requested_at TIMESTAMPTZ;
ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS del_requested_by BIGINT REFERENCES users(id);
