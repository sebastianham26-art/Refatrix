-- 0059: 기존 수입 입고 재고이동(stock_movements) 보정
--  · moved_at : 시스템 등록일(now) → 수입입고에서 지정한 import_date(재고 등재일)
--  · ref      : 'batch:#' → 매입 인보이스 번호(referencia)  (인보이스 있는 라인만)
-- 향후 입고는 importRoutes 승인 로직에서 처음부터 올바르게 기록됨. 이 마이그레이션은 과거분 일괄 교정.

UPDATE stock_movements sm
   SET moved_at = ib.import_date::timestamptz
  FROM import_batches ib
 WHERE sm.batch_id = ib.id
   AND ib.import_date IS NOT NULL;

UPDATE stock_movements sm
   SET ref = il.invoice_no
  FROM import_lines il
 WHERE sm.batch_id = il.batch_id
   AND sm.product_id = il.product_id
   AND il.invoice_no IS NOT NULL
   AND btrim(il.invoice_no) <> '';
