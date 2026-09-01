-- =====================================================================
-- Refatrix ERP · 0192_ar_plan_sync_backfill
-- 완납·부분수금된 인보이스의 「매출 입금예정」(AR plan 거래) 소급 정리.
--
-- 배경(디렉터 보고 2026-09-01):
--   "recar, 24,005가 선수금으로 남아있다. folio 31 은 완납인데."
--   → 확인 결과 선수금이 아니라, 완납된 인보이스 #28(folio 31)의 **매출 입금예정 24,004.53**
--     (kind='invoice', status='plan', 계좌 미지정) 이 거래목록에 그대로 남아 있던 것.
--   인보이스 발행 시 총액으로 만들어지는 이 예정 거래는 반제해도 줄지 않았다.
--   /api/cashflow 는 조회 시점에 잔액으로 보정했지만(2026-08-06) 거래목록·예정 내역은
--   원본을 보여주므로 "완납인데 돈이 떠 있는" 것처럼 읽혔다.
--
-- 이제 반제·취소·NC 적용 때마다 라우트가 syncArPlanTxn() 으로 원본을 맞춘다.
-- 이 마이그레이션은 **그 이전에 쌓인 건**을 한 번 정리한다.
--
-- 규칙 (syncArPlanTxn 과 동일):
--   · 잔액 < 0.5  → 예정 소프트 삭제(deleted_at). 반제를 되돌리면 라우트가 다시 살린다.
--   · 잔액 남음   → 예정 금액을 잔액으로 갱신.
--   ※ 소프트 삭제라 sales_invoices.txn_id FK 는 그대로. plan_amount 는 손대지 않는다
--     (AR 예정은 plan_amount 가 NULL 이라 계획대비실적 계획선에 원래 안 잡힌다 — 영향 없음).
-- =====================================================================

WITH os AS (
  SELECT si.id,
         CASE WHEN si.status = 'posted' AND si.deleted_at IS NULL
              THEN ROUND(si.total_mxn - COALESCE(pa.paid, 0), 2)
              ELSE 0 END AS outstanding
    FROM sales_invoices si
    LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid
                 FROM sales_payment_allocations GROUP BY invoice_id) pa
           ON pa.invoice_id = si.id
),
plan AS (
  SELECT DISTINCT ON (t.sales_invoice_id) t.id, t.sales_invoice_id
    FROM transactions t
   WHERE t.status = 'plan' AND t.kind = 'invoice'
     AND t.sales_invoice_id IS NOT NULL AND t.deleted_at IS NULL
   ORDER BY t.sales_invoice_id, t.id
)
UPDATE transactions t
   SET deleted_at = now()
  FROM plan p JOIN os ON os.id = p.sales_invoice_id
 WHERE t.id = p.id AND os.outstanding < 0.5;

WITH os AS (
  SELECT si.id,
         CASE WHEN si.status = 'posted' AND si.deleted_at IS NULL
              THEN ROUND(si.total_mxn - COALESCE(pa.paid, 0), 2)
              ELSE 0 END AS outstanding
    FROM sales_invoices si
    LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid
                 FROM sales_payment_allocations GROUP BY invoice_id) pa
           ON pa.invoice_id = si.id
),
plan AS (
  SELECT DISTINCT ON (t.sales_invoice_id) t.id, t.sales_invoice_id, t.amount_mxn
    FROM transactions t
   WHERE t.status = 'plan' AND t.kind = 'invoice'
     AND t.sales_invoice_id IS NOT NULL AND t.deleted_at IS NULL
   ORDER BY t.sales_invoice_id, t.id
)
UPDATE transactions t
   SET amount = os.outstanding, amount_mxn = os.outstanding
  FROM plan p JOIN os ON os.id = p.sales_invoice_id
 WHERE t.id = p.id
   AND os.outstanding >= 0.5
   AND ABS(COALESCE(p.amount_mxn, 0) - os.outstanding) > 0.005;
