-- =====================================================================
-- Refatrix ERP · 0094_quote_stage_timing
--   수주흐름추이 "현재 진행 단계/경고" 고도화용 시각 컬럼.
--   · quotes.packing_printed_at : 포장작업지시서 최초 출력 시각(= '포장작업 중' 진입)
--   · quotes.packing_due_at     : 포장완료 기한(출력 + 업무시간 6시간; 07:30~17:00, UTC-6)
--   · sales_invoices.sat_entered_at : 실제 SAT 번호 최초 입력 시각(전환→SAT 3시간 기준)
--   모두 nullable·하위호환. 기존 데이터 백필 없음(앞으로 채워짐).
-- =====================================================================

ALTER TABLE quotes          ADD COLUMN IF NOT EXISTS packing_printed_at TIMESTAMPTZ;
ALTER TABLE quotes          ADD COLUMN IF NOT EXISTS packing_due_at     TIMESTAMPTZ;
ALTER TABLE sales_invoices  ADD COLUMN IF NOT EXISTS sat_entered_at     TIMESTAMPTZ;

-- 조회 보조(추이 화면이 진행 단계별로 필터/정렬할 때)
CREATE INDEX IF NOT EXISTS idx_quotes_packing_due ON quotes (packing_due_at);
