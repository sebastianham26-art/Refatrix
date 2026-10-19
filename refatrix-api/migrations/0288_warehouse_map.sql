-- =====================================================================
-- Refatrix ERP · 0288_warehouse_map  (2026-10-19)
-- 창고 도면 — 구역(사각형) 배치와 구역 안의 랙 열(bay) 목록을 저장한다.
--
--   디렉터 요청: "창고 도면 위에 랙 위치를 표시하고, 랙 번호를 누르면
--                 그 랙에 어떤 SKU 가 몇 개 있는지 보여 달라"
--   · 도면은 한 장(id='main'). zones = [{id,name,type:'storage'|'area',x,y,w,h(도면 대비 %),rows:[[bay,...],...]}]
--   · bay 는 랙 열 이름(예 AA1) — 실제 랙 AA1-1 … AA1-6 이 그 열에 속한다(랙 이름의 마지막 「-숫자」 앞부분).
--   · 수량은 저장하지 않는다 — 랙별 재고(product_rack_stock)를 그때그때 읽는다.
--   · 기존 테이블 변경 없음. 재실행 안전.
-- =====================================================================
CREATE TABLE IF NOT EXISTS warehouse_maps (
  id          TEXT PRIMARY KEY,
  zones       JSONB NOT NULL,
  version     INT NOT NULL DEFAULT 1,
  updated_by  BIGINT REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
