-- 재고이동 이벤트 번호: 함께 등록된 입·출고를 하나의 이벤트로 묶어 일괄 수정 가능하게 함
-- 단건 등록 = 1 이벤트, 엑셀 일괄 = 파일 전체가 1 이벤트.

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS event_no BIGINT;
CREATE SEQUENCE IF NOT EXISTS stock_event_seq;

-- 백필 1) 매출 출고: 인보이스 단위로 한 이벤트
UPDATE stock_movements m SET event_no = sub.ev
FROM (
  SELECT sales_invoice_id, nextval('stock_event_seq') AS ev
    FROM stock_movements
   WHERE sales_invoice_id IS NOT NULL AND event_no IS NULL
   GROUP BY sales_invoice_id
) sub
WHERE m.sales_invoice_id = sub.sales_invoice_id AND m.event_no IS NULL;

-- 백필 2) 수입 입고: 배치 단위로 한 이벤트
UPDATE stock_movements m SET event_no = sub.ev
FROM (
  SELECT batch_id, nextval('stock_event_seq') AS ev
    FROM stock_movements
   WHERE batch_id IS NOT NULL AND event_no IS NULL
   GROUP BY batch_id
) sub
WHERE m.batch_id = sub.batch_id AND m.event_no IS NULL;

-- 백필 3) 나머지(수동/기타): 같은 참조·같은 날짜·같은 담당끼리 한 이벤트로 묶음
UPDATE stock_movements m SET event_no = sub.ev
FROM (
  SELECT COALESCE(ref,'') AS rk, moved_at::date AS dk, COALESCE(created_by,0) AS uk,
         nextval('stock_event_seq') AS ev
    FROM stock_movements
   WHERE event_no IS NULL
   GROUP BY COALESCE(ref,''), moved_at::date, COALESCE(created_by,0)
) sub
WHERE COALESCE(m.ref,'') = sub.rk AND m.moved_at::date = sub.dk
  AND COALESCE(m.created_by,0) = sub.uk AND m.event_no IS NULL;

CREATE INDEX IF NOT EXISTS idx_stock_moves_event ON stock_movements (event_no);
