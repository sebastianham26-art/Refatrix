-- =====================================================================
-- Refatrix ERP · 0027_budget_over_approved
-- 마케팅 예산 항목: 한도 초과 상태에서 디렉터가 별도 승인한 경우 표시.
-- =====================================================================

ALTER TABLE marketing_budget_items
  ADD COLUMN IF NOT EXISTS over_approved BOOLEAN NOT NULL DEFAULT false;
