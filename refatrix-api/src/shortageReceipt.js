// =====================================================================
// Refatrix ERP · shortageReceipt.js — 부족분 ↔ 발주 ↔ 입고 (0277) · 2026-10-15
//   디렉터 결정
//     ① 부족분은 **입고 시 해소**된다(수입배치 승인 = 재고 등재). 해소 원장 source='receipt' + 배치.
//     ② 해소 전이라도 발주가 잡혀 있으면 「발주됨」으로 보여서, 같은 부족을 또 주문하지 않게 한다.
//     ③ 발주 ↔ 부족 연결은 자동 FIFO — 오래된 발주 잔량이 오래된 부족분부터 덮는다.
//
//   연결은 **저장하지 않고 계산한다**(orderCoverage). 입고가 consumeBackorder 로 오래된 발주부터
//   채우고, 여기 해소도 오래된 부족분부터 하므로 「발주됨(PO-A) → 입고 해소(배치 B)」 가 같은 짝으로 이어진다.
//   발주 삭제·수정·취소 때 되돌릴 저장값이 없어 정합이 깨질 일이 없다.
//
//   살아 있는 견적(작성중·확정)의 부족 행: 발주로 덮이는 계산에는 들어가지만(또 주문하지 않도록),
//   입고로 **해소하지는 않는다** — 입고된 재고는 그 견적의 예약으로 들어가고(자동 예약 보충),
//   견적 부족 행은 quoteShortage.js 가 줄인다. 대신 FIFO 순서에서 그 몫만큼 입고 수량을 차지한다(이중 계산 방지).
// =====================================================================

const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

let _ready = false;
/** 0277 적용 여부(배포 직후 마이그레이션 전에도 입고 승인은 멈추지 않게) */
export async function receiptReady(q) {
  if (_ready) return true;
  try {
    const r = (await q(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='stock_shortage_resolutions' AND column_name='import_batch_id'`)).rows[0];
    if (r) _ready = true;
  } catch (_) { /* 미적용 취급 */ }
  return _ready;
}

const LIVE_JOIN = `LEFT JOIN quotes lq ON lq.id = sh.source_quote_id
                     AND lq.status IN ('draft','confirmed') AND lq.deleted_at IS NULL`;

/**
 * 입고(배치 승인) 수량으로 그 제품의 미해소 부족분을 오래된 것부터 해소한다.
 * @returns {Promise<{resolved:number, entries:number, skipped?:string}>}
 */
export async function resolveShortagesOnReceipt(q, { productId, qty, batchId, batchNo = null, userId = null }) {
  let left = r3(qty);
  if (!(left > 0) || !productId || !batchId) return { resolved: 0, entries: 0 };
  if (!(await receiptReady(q))) return { resolved: 0, entries: 0, skipped: 'not_migrated' };
  const rows = (await q(
    `SELECT sh.id, sh.shortage_qty, sh.resolved_qty, (lq.id IS NOT NULL) AS live
       FROM stock_shortages sh ${LIVE_JOIN}
      WHERE sh.product_id=$1 AND sh.status='open' AND sh.shortage_qty - sh.resolved_qty > 0
      ORDER BY sh.occurred_at, sh.id
      FOR UPDATE OF sh`, [productId])).rows;
  let resolved = 0; let entries = 0;
  const tag = `입고 해소 (수입배치 ${batchNo || '#' + batchId})`;
  for (const sh of rows) {
    if (left <= 0) break;
    const remaining = r3(Number(sh.shortage_qty) - Number(sh.resolved_qty));
    if (remaining <= 0) continue;
    const take = Math.min(remaining, left);
    left = r3(left - take);
    if (sh.live) continue;      // 살아 있는 견적 몫 — 수량만 차지하고 해소는 견적 예약 쪽에서
    await q(
      `INSERT INTO stock_shortage_resolutions (shortage_id, qty, source, import_batch_id, resolved_by, note)
       VALUES ($1,$2,'receipt',$3,$4,$5)`, [sh.id, take, batchId, userId, tag]);
    const fully = r3(remaining - take) <= 0;
    await q(
      `UPDATE stock_shortages SET resolved_qty = resolved_qty + $1
         ${fully ? `, status='resolved', resolved_at=now(), resolved_by=$3` : ''}
        WHERE id=$2`, fully ? [take, sh.id, userId] : [take, sh.id]);
    resolved = r3(resolved + take); entries++;
  }
  return { resolved, entries };
}

/** 배치 삭제·되돌림: 그 배치가 만든 입고 해소를 전부 되돌린다. */
export async function reverseReceiptResolutions(q, batchId, userId = null) {
  if (!batchId || !(await receiptReady(q))) return { reversed: 0, rows: 0 };
  const rows = (await q(
    `DELETE FROM stock_shortage_resolutions WHERE import_batch_id=$1 RETURNING shortage_id, qty`, [batchId])).rows;
  let reversed = 0;
  for (const r of rows) {
    reversed = r3(reversed + Number(r.qty));
    await q(
      `UPDATE stock_shortages
          SET resolved_qty = GREATEST(resolved_qty - $1, 0),
              status = CASE WHEN status='resolved' THEN 'open' ELSE status END,
              resolved_at = CASE WHEN status='resolved' THEN NULL ELSE resolved_at END,
              resolved_by = CASE WHEN status='resolved' THEN NULL ELSE resolved_by END
        WHERE id=$2 AND status <> 'cancelled'`, [r.qty, r.shortage_id]);
  }
  return { reversed, rows: rows.length };
}

/** 배치의 제품별 입고 수량(이동원장 'in')으로 해소 — 승인·복원 공용 */
export async function resolveBatchReceipt(q, batchId, userId = null) {
  if (!batchId || !(await receiptReady(q))) return { resolved: 0, entries: 0 };
  const b = (await q(`SELECT batch_no FROM import_batches WHERE id=$1`, [batchId])).rows[0];
  const mv = (await q(
    `SELECT product_id, SUM(ABS(qty)) AS qty FROM stock_movements
      WHERE batch_id=$1 AND move_type='in' AND product_id IS NOT NULL GROUP BY product_id ORDER BY product_id`, [batchId])).rows;
  let resolved = 0; let entries = 0;
  for (const m of mv) {
    const o = await resolveShortagesOnReceipt(q, { productId: Number(m.product_id), qty: Number(m.qty),
      batchId, batchNo: b && b.batch_no, userId });
    resolved = r3(resolved + o.resolved); entries += o.entries;
  }
  return { resolved, entries };
}

/**
 * 제품 하나의 부족분 ↔ 열린 발주 FIFO 짝 계산.
 * @returns {Promise<{rows:Array, po:Array, remaining:number, covered:number, unordered:number, backorder:number}>}
 *   po: 덮는 쪽(오래된 순) — kind 'prestock'(창고 입고·승인 대기) 먼저, 그다음 열린 발주 라인
 *   rows: 미해소 부족 행(오래된 순) + ordered(발주로 덮인 수량) + covers:[{po_id, ref_no, order_date, qty}]
 */
export async function orderCoverage(q, productId) {
  const po = (await q(
    `SELECT l.id AS line_id, p.id AS po_id, p.ref_no, to_char(p.order_date,'YYYY-MM-DD') AS order_date, p.status,
            (l.qty - l.received_qty) AS open_qty
       FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id
      WHERE l.product_id=$1 AND p.deleted_at IS NULL AND p.status <> 'cancelled' AND (l.qty - l.received_qty) > 0
      ORDER BY p.order_date ASC, l.po_id ASC, l.id ASC`, [productId])).rows
    .map((r) => ({ kind: 'po', line_id: Number(r.line_id), po_id: Number(r.po_id), ref_no: r.ref_no, order_date: r.order_date,
      status: r.status, open_qty: Number(r.open_qty) || 0 }));
  // 창고 마감으로 이미 들어왔지만 수입원가 배치 승인 전인 수량(0176 선반영) — 발주 잔량에서는 빠졌으나
  //   아직 입고 해소 전이다. 맨 앞(가장 먼저 도착)에 두어 「미발주」로 잘못 보이지 않게 한다.
  let pre = 0;
  try { pre = Number((await q(`SELECT qty FROM inbound_prestock WHERE product_id=$1`, [productId])).rows[0]?.qty) || 0; } catch (_) { pre = 0; }
  if (pre > 0) po.unshift({ kind: 'prestock', line_id: null, po_id: 0, ref_no: '창고 입고(원가 승인 대기)', order_date: null, status: 'received', open_qty: pre });
  const sh = (await q(
    `SELECT sh.id, sh.shortage_qty - sh.resolved_qty AS remaining, (lq.id IS NOT NULL) AS live
       FROM stock_shortages sh ${LIVE_JOIN}
      WHERE sh.product_id=$1 AND sh.status='open' AND sh.shortage_qty - sh.resolved_qty > 0
      ORDER BY sh.occurred_at, sh.id`, [productId])).rows
    .map((r) => ({ id: Number(r.id), remaining: Number(r.remaining) || 0, live: !!r.live, ordered: 0, covers: [] }));
  let pi = 0; let poLeft = po.length ? po[0].open_qty : 0;
  for (const row of sh) {
    let need = row.remaining;
    while (need > 0 && pi < po.length) {
      if (poLeft <= 0) { pi++; poLeft = pi < po.length ? po[pi].open_qty : 0; continue; }
      const take = Math.min(need, poLeft);
      row.ordered = r3(row.ordered + take);
      const last = row.covers[row.covers.length - 1];
      if (last && last.po_id === po[pi].po_id && last.kind === po[pi].kind) last.qty = r3(last.qty + take);
      else row.covers.push({ kind: po[pi].kind, po_id: po[pi].po_id, ref_no: po[pi].ref_no, order_date: po[pi].order_date, qty: take });
      need = r3(need - take); poLeft = r3(poLeft - take);
    }
  }
  const remaining = r3(sh.reduce((s, r) => s + r.remaining, 0));
  const backorder = r3(po.reduce((s, r) => s + r.open_qty, 0));
  const covered = r3(Math.min(remaining, backorder));
  return { rows: sh, po, remaining, covered, unordered: r3(remaining - covered), backorder };
}
