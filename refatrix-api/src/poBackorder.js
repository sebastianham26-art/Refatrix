// ─────────────────────────────────────────────────────────────────────────────
// 발주(backorder) ↔ 입고 연동 공용 모듈 · build 20260719a-po-backorder-sync
//
//   backorder = 구매라인(purchase_order_lines) 잔량 Σ(qty - received_qty)  (뷰 v_backorder)
//   · consumeBackorder : 창고 입고(수입배치 승인)가 발생하면 그 수량만큼
//                        해당 SKU의 열린 구매라인 received_qty 를 선입선출(FIFO)로 채움
//                        → backorder 잔량이 자동으로 줄어듦(재고로 등재된 만큼 삭제).
//   · releaseBackorder : 입고를 되돌리는 경우(배치 삭제/안전삭제 등) 최근 소진분부터
//                        역순(LIFO)으로 received_qty 를 되돌림(0 미만 금지).
//
//   호출 규약: 트랜잭션 안에서 q = client.query.bind(client) 를 넘긴다(withTx 관례).
//   구매기록이 없는 SKU 는 아무 것도 하지 않음(leftover 로만 보고) — 재고/원가에 영향 없음.
// ─────────────────────────────────────────────────────────────────────────────

// 열린 구매라인에 입고수량을 FIFO 로 배분해 received_qty 증가. { consumed, leftover } 반환.
export async function consumeBackorder(q, productId, qty) {
  let remain = Number(qty) || 0;
  if (!(remain > 0) || !productId) return { consumed: 0, leftover: Math.max(remain, 0) };
  const lines = (await q(
    `SELECT l.id, l.po_id, (l.qty - l.received_qty) AS open_qty
       FROM purchase_order_lines l
       JOIN purchase_orders p ON p.id = l.po_id
      WHERE l.product_id = $1
        AND p.deleted_at IS NULL
        AND p.status <> 'cancelled'
        AND (l.qty - l.received_qty) > 0
      ORDER BY p.order_date ASC, l.po_id ASC, l.id ASC
      FOR UPDATE OF l`, [productId])).rows;
  let consumed = 0;
  const poIds = new Set();
  for (const ln of lines) {
    if (remain <= 0) break;
    const open = Number(ln.open_qty) || 0;
    if (open <= 0) continue;
    const take = Math.min(open, remain);
    await q(`UPDATE purchase_order_lines SET received_qty = received_qty + $1 WHERE id = $2`, [take, ln.id]);
    consumed += take; remain -= take; poIds.add(Number(ln.po_id));
  }
  if (consumed > 0) await refreshPoStatus(q, [...poIds]);
  return { consumed, leftover: remain };
}

// 입고 되돌림: 최근 발주부터 역순으로 received_qty 감소(0 미만 금지). { released } 반환.
export async function releaseBackorder(q, productId, qty) {
  let remain = Number(qty) || 0;
  if (!(remain > 0) || !productId) return { released: 0 };
  const lines = (await q(
    `SELECT l.id, l.po_id, l.received_qty
       FROM purchase_order_lines l
       JOIN purchase_orders p ON p.id = l.po_id
      WHERE l.product_id = $1
        AND p.deleted_at IS NULL
        AND p.status <> 'cancelled'
        AND l.received_qty > 0
      ORDER BY p.order_date DESC, l.po_id DESC, l.id DESC
      FOR UPDATE OF l`, [productId])).rows;
  let released = 0;
  const poIds = new Set();
  for (const ln of lines) {
    if (remain <= 0) break;
    const rec = Number(ln.received_qty) || 0;
    const give = Math.min(rec, remain);
    if (give <= 0) continue;
    await q(`UPDATE purchase_order_lines SET received_qty = received_qty - $1 WHERE id = $2`, [give, ln.id]);
    released += give; remain -= give; poIds.add(Number(ln.po_id));
  }
  if (released > 0) await refreshPoStatus(q, [...poIds]);
  return { released };
}

// 발주 헤더 상태 정리: 전 라인 완납 → 'received' 승격, 잔량 재발생 → 'received' 를 'recorded' 로 복귀.
//   ('shipped' 등 다른 상태는 완납 승격 외엔 건드리지 않음.)
async function refreshPoStatus(q, poIds) {
  if (!poIds || !poIds.length) return;
  await q(
    `UPDATE purchase_orders p SET status = 'received'
      WHERE p.id = ANY($1) AND p.deleted_at IS NULL AND p.status IN ('recorded','shipped')
        AND NOT EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.po_id = p.id AND l.qty > l.received_qty)`,
    [poIds]);
  await q(
    `UPDATE purchase_orders p SET status = 'recorded'
      WHERE p.id = ANY($1) AND p.deleted_at IS NULL AND p.status = 'received'
        AND EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.po_id = p.id AND l.qty > l.received_qty)`,
    [poIds]);
}
