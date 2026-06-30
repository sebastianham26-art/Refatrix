import { query } from './db.js';

// 포장완료(packed) 3조건이 처음 모두 충족되면 quotes.packed_at 을 정확히 한 번 기록.
//   ① 즉시재고(in_stock) 라인 전부 스캔 완료(packing_box_line 합 >= required)
//   ② 박스 1개 이상 (사진은 선택 — 더 이상 필수 아님)
//   ③ 종이 포장지시서 업로드(quote_packing_docs)
// 재호출 안전(WHERE packed_at IS NULL 가드). 재고·매출엔 영향 없음(packed_at 기록만).
export async function maybeMarkPacked(quoteId, exec = query) {
  const id = Number(quoteId);
  if (!id) return false;
  const cur = (await exec(`SELECT packed_at FROM quotes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
  if (!cur || cur.packed_at) return false;                                  // 이미 packed 거나 없음
  const doc = (await exec(`SELECT 1 FROM quote_packing_docs WHERE quote_id=$1`, [id])).rows[0];
  if (!doc) return false;                                                   // ③ 미충족
  // ① 스캔 완료 — 즉시재고 라인 required vs scanned
  const lines = (await exec(
    `SELECT l.qty, l.product_id, l.reserved_qty, p.stock_qty
       FROM quote_lines l LEFT JOIN products p ON p.id=l.product_id
      WHERE l.quote_id=$1`, [id])).rows;
  const req = [];
  for (const l of lines) {
    if (!l.product_id) continue;
    const qty = Number(l.qty) || 0;
    const phys = l.stock_qty != null ? Number(l.stock_qty) : 0;
    const ful = Math.max(0, Math.min(Number(l.reserved_qty) || 0, phys));
    if (ful < qty) continue;
    req.push({ product_id: Number(l.product_id), required: qty });
  }
  if (!req.length) return false;
  const scanned = {};
  (await exec(`SELECT product_id, SUM(qty)::int AS s FROM packing_box_line WHERE quote_id=$1 GROUP BY product_id`, [id]))
    .rows.forEach((r) => { scanned[Number(r.product_id)] = Number(r.s) || 0; });
  if (!req.every((l) => (scanned[l.product_id] || 0) >= l.required)) return false;
  // ② 박스 1개 이상(사진은 선택 — 필수 아님)
  const boxes = (await exec(`SELECT id FROM packing_box WHERE quote_id=$1`, [id])).rows;
  if (!boxes.length) return false;
  // 3조건 충족 → 한 번만 기록
  const r = (await exec(`UPDATE quotes SET packed_at=now() WHERE id=$1 AND packed_at IS NULL RETURNING packed_at`, [id])).rows[0];
  return !!r;
}
