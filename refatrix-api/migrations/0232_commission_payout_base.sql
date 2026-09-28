-- =====================================================================
-- Refatrix ERP · 0232_commission_payout_base  (2026-09-28)
-- 커미션 지급 후 매출 조정(삭제·금액수정·크레딧노트) → 다음 지급에서 차액 정산(디렉터 결정 A).
--   지급 시점의 순매출(인보이스 ex-IVA − 적용 NC ex-IVA)을 스냅샷으로 남겨,
--   지금 순매출과 비교해 "지급 당시 실효율 × 차이"만큼 차감/추가한다.
--   요율·기간 변경은 차액을 만들지 않는다(지급 당시 율 고정).
-- =====================================================================

ALTER TABLE commission_payouts ADD COLUMN IF NOT EXISTS base_mxn NUMERIC(15,2);

-- 기존 지급분 백필: 현재 순매출을 지급 시점 기준으로 간주(이후 변동부터 차액 정산).
UPDATE commission_payouts cp
   SET base_mxn = i.subtotal_mxn - COALESCE(n.base, 0)
  FROM sales_invoices i
  LEFT JOIN (
    SELECT invoice_id, SUM(base_mxn) AS base
      FROM notas_credito WHERE status = 'applied'
     GROUP BY invoice_id
  ) n ON n.invoice_id = i.id
 WHERE i.id = cp.invoice_id
   AND cp.paid = true
   AND cp.base_mxn IS NULL;
