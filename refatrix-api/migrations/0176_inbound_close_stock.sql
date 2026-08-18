-- =====================================================================
-- Refatrix ERP · 0176_inbound_close_stock
-- 마감(입고) 개편 3종 (2026-08-18):
--   ① 팔렛별 입고 반영 시각(received_at) — 마감이 어떤 팔렛을 반영했는지 기록.
--      적치 중(status='checking'·checked_at 있음) 팔렛이 마감 집계에서 빠지던 버그의
--      재발 방지 + "재마감(추가 입고 반영)"의 이중 반영 방지 기준.
--   ② 마감 즉시 실재고 반영 — 마감 시 products.stock_qty 에 실측 수량을 바로 더한다
--      (디렉터 결정 2026-08-18: 적치·수입원가 승인을 기다리지 않고 판매 대응).
--   ③ 선반영 풀(inbound_prestock) — 마감이 미리 올린 수량을 제품별로 기록해 두고,
--      수입원가 배치 승인 때 그만큼 수량 반영을 건너뛴다(재고 이중 증가 방지).
--      원가·평균원가·재고원장(stock_movements)은 기존대로 승인 시점에 기록된다.
-- =====================================================================

ALTER TABLE inbound_pallets ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS inbound_prestock (
  product_id  BIGINT PRIMARY KEY REFERENCES products(id),
  qty         NUMERIC(15,3) NOT NULL DEFAULT 0,     -- 마감 선반영 잔량(승인 시 차감)
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
