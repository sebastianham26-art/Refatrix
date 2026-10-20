// =====================================================================
// Refatrix ERP · lrPair.js — L/R 짝맞춤 (2026-10-20 · 디렉터 요청)
//   좌우 구분 부품(CTR 코드 끝 L/R: CE0351L ↔ CE0351R)은 대부분 짝으로 팔리고 짝으로 사야 한다.
//   · 견적: L 또는 R 만 들어오면 짝도 넣으라고 안내(재고 표시). **막지 않는다** — 안내만.
//   · 구매검토: 짝을 나란히 보여주고 추천발주수량을 짝 기준으로 맞춘다(purchaseRoutes).
//   짝 규칙은 판매이력 화면(salesTrend.pairCode)과 같다: 영문 2자 + 숫자 + L/R.
// =====================================================================
import { pairCode } from './salesTrend.js';
import { ACTIVE_RESERVATION_SQL } from './reservations.js';

export { pairCode };

/** SQL: 짝 묶음 키 — 짝 규칙에 맞으면 끝의 L/R 을 뗀 코드, 아니면 코드 그대로. alias p 기준. */
export const PAIR_KEY_SQL =
  `(CASE WHEN UPPER(p.code) ~ '^[A-Z]{2}[0-9]+[LR]$' THEN LEFT(UPPER(p.code), LENGTH(p.code) - 1) ELSE UPPER(p.code) END)`;

/**
 * 견적 줄(CTR 코드 목록)에서 짝이 빠진 줄을 찾아 안내를 만든다.
 *   lines: [{ ctr_code, qty }] — 매칭된 줄만 넘긴다.
 *   반환: [{ code, partner, partner_id, partner_name, partner_stock, partner_avail, partner_active, qty }]
 *   짝 제품이 마스터에 없으면 안내하지 않는다(만들 수 없는 짝을 넣으라고 할 수는 없다).
 */
export async function pairHints(exec, lines) {
  const have = new Set();
  const qtyBy = new Map();
  for (const l of lines || []) {
    const c = String(l && l.ctr_code || '').trim().toUpperCase();
    if (!c) continue;
    have.add(c);
    qtyBy.set(c, (qtyBy.get(c) || 0) + (Number(l.qty) || 0));
  }
  const want = new Map();   // partner → code
  for (const c of have) {
    const pc = pairCode(c);
    if (pc && !have.has(pc) && !want.has(pc)) want.set(pc, c);
  }
  if (!want.size) return [];
  const rows = (await exec(
    `SELECT p.id, UPPER(p.code) AS code, p.name, p.stock_qty, p.is_active,
            COALESCE((SELECT SUM(ql.reserved_qty) FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
                       WHERE ql.product_id = p.id AND ql.reserved_qty > 0 AND ${ACTIVE_RESERVATION_SQL}), 0) AS reserved
       FROM products p
      WHERE p.deleted_at IS NULL AND UPPER(p.code) = ANY($1::text[])`, [[...want.keys()]])).rows;
  const out = [];
  for (const r of rows) {
    const code = want.get(r.code);
    const stock = Number(r.stock_qty) || 0;
    out.push({
      code, partner: r.code, partner_id: Number(r.id), partner_name: r.name || null,
      partner_stock: stock, partner_avail: Math.max(0, stock - (Number(r.reserved) || 0)),
      partner_active: r.is_active !== false, qty: qtyBy.get(code) || 0,
    });
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}
