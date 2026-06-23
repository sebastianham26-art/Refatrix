-- 0068: 매출 출고 stock_movements의 moved_at을 인보이스 일자(inv_date)로 보정.
--   과거: 매출 'out' 이동에 moved_at을 안 넣어 now()(입력 시점)로 기록됨 →
--   과거월(예: 4월) 인보이스를 나중에 입력하면 그 출고가 입력월(예: 6월)로 잡혀 재고이동에서 안 보임.
--   수입 입고를 0059에서 import_date로 보정한 것과 동일한 취지의 매출 버전.
--   move_type='out' 이며 일자가 다른 것만 보정(되돌리기 이동 'in'은 건드리지 않음).
UPDATE stock_movements m
   SET moved_at = si.inv_date
  FROM sales_invoices si
 WHERE m.sales_invoice_id = si.id
   AND m.move_type = 'out'
   AND si.inv_date IS NOT NULL
   AND m.moved_at::date <> si.inv_date;
