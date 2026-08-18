-- =====================================================================
-- Refatrix ERP · 0177_inbound_po_applied
-- 마감 → 구매 반영 기록 (2026-08-18 저녁)
--   현장: 마감 시 거의 모든 SKU 가 "구매 발주에서 못 찾음" — 발주번호 표기 차이 또는
--   발주 라인의 product 미매칭(NULL) 때문. 매칭을 관대하게 바꾸면서, 어떤 수량이 이미
--   구매에 반영됐는지를 페어(선적×ORDER NO×제품)별로 기록해 재매칭이 이중 반영하지 않게 한다.
-- =====================================================================

CREATE TABLE IF NOT EXISTS inbound_po_applied (
  shipment_id BIGINT NOT NULL REFERENCES inbound_shipments(id),
  order_no    TEXT NOT NULL,
  product_id  BIGINT NOT NULL REFERENCES products(id),
  qty         NUMERIC(15,3) NOT NULL DEFAULT 0,      -- 이 페어로 구매 received_qty 에 반영된 누적
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shipment_id, order_no, product_id)
);

-- 백필: 이미 입고 반영된(received_at) 팔렛 중, 엄격 매칭(ref_no 정확 일치 + product_id)이
-- 되는 페어는 이전 마감이 이미 구매에 반영했다고 간주하고 실측 수량으로 기록해 둔다.
-- (과대 기록이어도 재매칭은 "부족분만 추가"하므로 이중 반영은 발생하지 않는다.)
INSERT INTO inbound_po_applied (shipment_id, order_no, product_id, qty)
SELECT pl.shipment_id, pl.order_no, pi.product_id,
       SUM(CASE WHEN pi.cartons > 0 THEN ROUND(pi.qty / pi.cartons) * pi.scanned_cartons ELSE pi.qty END)
  FROM inbound_pallets pl
  JOIN inbound_pallet_items pi ON pi.pallet_id = pl.id
 WHERE pl.received_at IS NOT NULL AND pi.product_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM purchase_order_lines l
                 JOIN purchase_orders po ON po.id = l.po_id
                WHERE po.ref_no = pl.order_no AND l.product_id = pi.product_id
                  AND po.deleted_at IS NULL AND po.status <> 'cancelled')
 GROUP BY pl.shipment_id, pl.order_no, pi.product_id
ON CONFLICT (shipment_id, order_no, product_id) DO NOTHING;
