-- 수입입고 반려(승인거절) 기록
ALTER TABLE import_batches
  ADD COLUMN IF NOT EXISTS rejected_by   BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS rejected_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reject_reason TEXT;
