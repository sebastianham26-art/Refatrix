-- =====================================================================
-- Refatrix ERP · 0276_quote_shortage_on_save
--   2026-10-15 · 부족분을 **견적 저장 즉시** 기록하도록 바꾸면서(src/quoteShortage.js),
--   배포 시점에 이미 열려 있는 견적(작성중·확정, 미삭제)의 부족분을 한 번 소급해 적는다.
--   · 스키마 변경 없음 — 견적 부족 행은 기존 stock_shortages.source_quote_id(0064)로 묶인다.
--   · 견적 × 제품 하나에 한 행. 부족 = 요청수량 − 예약확보(reserved_qty, 요청수량으로 캡).
--   · 발생일 = 견적일. 이미 그 견적·제품의 부족 행이 있으면 건너뛴다(재실행 무해).
--   ※ migrate.js 가 파일마다 BEGIN/COMMIT 으로 감싸므로 트랜잭션 구문은 넣지 않는다.
-- =====================================================================

INSERT INTO stock_shortages
  (product_id, customer_id, sales_invoice_id, requested_qty, fulfilled_qty, shortage_qty,
   shortage_amount_mxn, occurred_at, source_quote_id, note, created_by)
SELECT a.product_id, q.customer_id, NULL, a.qty, a.resv, a.qty - a.resv,
       ROUND((a.amt / NULLIF(a.qty, 0)) * (a.qty - a.resv) * 1.16, 2),
       q.quote_date, q.id,
       '견적 ' || q.quote_no || ' — 재고부족(예약 미확보) · 0276 소급 기록',
       q.created_by
  FROM quotes q
  JOIN (SELECT quote_id, product_id,
               SUM(qty) AS qty,
               SUM(LEAST(GREATEST(COALESCE(reserved_qty, 0), 0), qty)) AS resv,
               SUM(COALESCE(final_price, 0) * qty) AS amt
          FROM quote_lines
         WHERE product_id IS NOT NULL
         GROUP BY quote_id, product_id) a ON a.quote_id = q.id
 WHERE q.status IN ('draft', 'confirmed')
   AND q.deleted_at IS NULL
   AND a.qty > a.resv
   AND NOT EXISTS (SELECT 1 FROM stock_shortages s
                    WHERE s.source_quote_id = q.id AND s.product_id = a.product_id);
