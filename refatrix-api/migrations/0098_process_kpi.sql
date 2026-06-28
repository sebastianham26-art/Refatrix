-- =====================================================================
-- Refatrix ERP · 0098_process_kpi
--   업무 프로세스 KPI 기능:
--   1) sales_invoices.sat_entered_at : SAT 번호 발행(입력) 시각
--      · 이후 SAT 입력 시 백엔드가 now() 기록.
--      · 백필(보수적): 실 SAT 번호(TMP- 아님)가 있는 기존 인보이스는 생성시각으로.
--        (정확한 과거 입력시각은 event_logs 로 별도 백필 가능 — 선택)
--   2) process_sla_kpi : 단계별 KPI 기준시간(단일행). 디렉터가 화면에서 직접 입력.
--      · order_hours   = 오더확정 KPI(시간)        기본 48
--      · packing_hours = 피킹/포장 KPI(업무시간)    기본 6
--      · sat_hours     = SAT 발행 KPI(시간)         기본 3
--      · 수금은 고객별 외상기일(credit_days) 준수가 KPI — 별도 컬럼 없음.
-- =====================================================================

ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS sat_entered_at TIMESTAMPTZ;

UPDATE sales_invoices
   SET sat_entered_at = created_at
 WHERE sat_entered_at IS NULL
   AND sat_no IS NOT NULL
   AND sat_no NOT LIKE 'TMP-%';

CREATE TABLE IF NOT EXISTS process_sla_kpi (
  id             INT PRIMARY KEY DEFAULT 1,
  order_hours    NUMERIC(7,2) NOT NULL DEFAULT 48,
  packing_hours  NUMERIC(7,2) NOT NULL DEFAULT 6,
  sat_hours      NUMERIC(7,2) NOT NULL DEFAULT 3,
  updated_by     BIGINT REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

INSERT INTO process_sla_kpi (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
