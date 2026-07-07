-- =====================================================================
-- Refatrix ERP · 0125_mktspend_txn_memo
-- 마케팅 지출계획 거래 메모 형식 변경(집행항목 우선):
--   기존 '[마케팅] 활동명 · 집행항목 · 구분 (· 명목)'
--   신규 '[마케팅] 집행항목 · 구분 · 활동명 (· 명목)'
--   → 현금흐름·예정내역의 좁은 메모 칸(22~30자 절단)에서 집행 날짜에 해당하는
--     "세부 집행항목명"이 먼저 보이도록. 이미 생성된 거래(계획·실적 모두)의
--     메모를 현재 계획/항목/라인 데이터 기준으로 재작성한다.
--   멱등: 최신 데이터로 다시 조립하므로 여러 번 실행해도 동일 결과.
-- =====================================================================

UPDATE transactions
   SET memo = sub.new_memo
  FROM (
    SELECT l.txn_id,
           '[마케팅] '
           || left(COALESCE(i.name, '기본 집행'), 80)
           || ' · '
           || CASE l.kind WHEN 'adv' THEN '선지급금'
                          WHEN 'mid' THEN '중도금'
                          WHEN 'fin' THEN '잔금'
                          WHEN 'one' THEN '일시불'
                          ELSE COALESCE(l.kind, '일시불') END
           || ' · '
           || left(COALESCE(p.title, ''), 100)
           || COALESCE(' · ' || left(l.memo, 160), '') AS new_memo
      FROM marketing_spend_lines l
      JOIN marketing_spend_plans p ON p.id = l.plan_id
      LEFT JOIN marketing_spend_items i ON i.id = l.item_id
     WHERE l.txn_id IS NOT NULL
  ) sub
 WHERE sub.txn_id = transactions.id;
