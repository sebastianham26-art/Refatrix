-- 0124: 마케팅 지출계획 — 담당자 수정 요청(pending revision)
--   승인된(approved) 계획을 담당자가 수정하면 자금계획에 바로 반영하지 않고
--   pending_revision(jsonb)에 보관 → 디렉터가 검토·승인 시에만 예정 지출 동기화.
ALTER TABLE marketing_spend_plans ADD COLUMN IF NOT EXISTS pending_revision jsonb;
ALTER TABLE marketing_spend_plans ADD COLUMN IF NOT EXISTS revision_by bigint;
ALTER TABLE marketing_spend_plans ADD COLUMN IF NOT EXISTS revision_at timestamptz;
