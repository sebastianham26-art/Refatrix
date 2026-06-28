-- =====================================================================
-- Refatrix ERP · 0099_audit_packing_print_index
--   포장작업지시서 "출력" 클릭 감사로그(audit_log: action='print',
--   target='packing_print')에서 견적별 최초 출력시각(MIN occurred_at)을
--   빠르게 찾기 위한 부분 인덱스. KPI·SLA 피킹 경과 계산에 사용.
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_audit_packing_print_quote
  ON audit_log ((detail->>'quote_id'))
  WHERE action = 'print' AND target = 'packing_print';
