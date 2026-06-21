-- =====================================================================
-- Refatrix ERP · 0061_customer_branches_and_stage_fix
--   (1) customers.branch_count : 고객 지점 수
--   (2) 게시(posted) 인보이스가 있는데 단계가 거래중(60) 미만인 고객을
--       거래중으로 자동 보정(전진만). 단계 이력/미팅 로그도 함께 정리.
-- =====================================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS branch_count INT;

DO $$
DECLARE tgt BIGINT;
BEGIN
  SELECT id INTO tgt FROM stages WHERE sort_order = 60 AND deleted_at IS NULL ORDER BY id LIMIT 1;
  IF tgt IS NULL THEN RETURN; END IF;

  DROP TABLE IF EXISTS _cfix;
  CREATE TEMP TABLE _cfix AS
    SELECT c.id, c.stage_id AS old_stage
      FROM customers c
     WHERE c.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM sales_invoices i
                    WHERE i.customer_id = c.id AND i.status = 'posted' AND i.deleted_at IS NULL)
       AND COALESCE((SELECT s.sort_order FROM stages s WHERE s.id = c.stage_id), -1) < 60;

  -- 열린 단계 이력 닫기 → 거래중 이력 열기
  UPDATE customer_stage_history h SET left_at = CURRENT_DATE
   WHERE h.left_at IS NULL AND h.customer_id IN (SELECT id FROM _cfix);
  INSERT INTO customer_stage_history (customer_id, stage_id, entered_at)
    SELECT id, tgt, CURRENT_DATE FROM _cfix;

  -- 보정 내역을 미팅 로그로 남김
  INSERT INTO customer_meetings (customer_id, meeting_date, note, stage_before, stage_after)
    SELECT id, CURRENT_DATE, '자동 보정: 매출(게시 인보이스) 보유 → 거래중', old_stage, tgt FROM _cfix;

  -- 고객 현재 단계 갱신
  UPDATE customers SET stage_id = tgt, stage_since = CURRENT_DATE WHERE id IN (SELECT id FROM _cfix);

  DROP TABLE _cfix;
END $$;
