-- =====================================================================
-- Refatrix ERP · 0047_quote_delete_approval
--   견적 삭제 승인 워크플로
--   - status 에 'delete_pending' 추가 (삭제요청 → 디렉터 승인/반려)
--   - 삭제요청 메모/요청자/요청일, 직전 상태 보관(반려 시 복귀)
--   - delete_pending 견적은 모든 집계에서 제외
-- =====================================================================
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_status_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_status_check
  CHECK (status IN ('draft','confirmed','converted','cancelled','delete_pending'));

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS del_reason     TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS del_requested_by BIGINT REFERENCES users(id);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS del_requested_at TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS del_prev_status TEXT;   -- 반려 시 복귀할 직전 상태

CREATE INDEX IF NOT EXISTS idx_quotes_delpending ON quotes (status) WHERE status='delete_pending';
