// 2026-10-22 · 견적 엑셀 수량열 4종 — 회사 전 화면 공통 정의 (0901b 확정, 이번에 복원)
//
//   Existencia    = products.stock_qty                       창고 실물 현재고
//   Disponible    = max(0, 현재고 − 타 미결·미만료 견적 예약)   고객에게 팔 수 있는 수량
//   En tránsito   = v_incoming_stock                         창고›수입입고에 등록된, 마감 전 선적
//   En producción = max(0, 발주 미입고 잔량 − En tránsito)     발주했지만 아직 안 실린 물량
//
//   발주 미입고 잔량(v_backorder) = En tránsito + En producción.
//   행(row)은 price-list 쿼리의 한 줄 — node-pg 는 NUMERIC 을 문자열로 주므로 전부 Number() 로 정규화한다.
export function plQty(row) {
  const stock = row.stock_qty != null ? Number(row.stock_qty) : null;
  const reserved = Number(row.reserved_qty) || 0;
  const incoming = Number(row.incoming_qty) || 0;
  const backorder = Number(row.backorder_qty) || 0;
  return {
    reserved_qty: reserved,
    avail_qty: stock != null ? Math.max(0, stock - reserved) : null,
    incoming_qty: incoming,
    incoming_eta: row.incoming_eta || null,
    production_qty: Math.max(0, backorder - incoming),
  };
}
