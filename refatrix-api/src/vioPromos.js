// =====================================================================
// 0293 · VIO 프로모션(키트) — 번호 · 금액 · 키트 이름 · 견적에서 키트 풀기
//   - 번호: K + 4자리 연번(K0001 …, 연도 없음 · 전체 연번 — 디렉터 결정 2026-10-22)
//   - 금액: 정가 합계 = Σ 부품 정가 × 수량, 할인 적용 금액 = 정가 합계 × (1 − 할인%)
//   - 키트 제품: 코드 = 프로모션 번호, 이름 = KIT T {모델} {연식}_{코드}_{코드}…(수량 2 이상은 코드x2),
//                List price = 정가 합계(할인은 견적에서 고객 할인율로 — 디렉터 결정)
//   - 견적·주문: 키트 줄은 구성 부품 줄로 풀린다(각 부품 재고가 예약·출고). 화면·CRM 수신이 같은 함수.
// =====================================================================
import { query } from './db.js';

export const KIT_PREFIX = 'KIT T';
export const promoNo = (n) => 'K' + String(Math.max(1, Number(n) || 1)).padStart(4, '0');
export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** items:[{list_price, qty}] , discount% → {total_list, total_promo, discount_amt, pieces} */
export function promoTotals(items, discountPct) {
  let total = 0, pieces = 0;
  for (const it of items || []) { const q = Math.max(0, Math.floor(Number(it.qty) || 0)); pieces += q; total += (Number(it.list_price) || 0) * q; }
  const d = Math.min(99.99, Math.max(0, Number(discountPct) || 0));
  const total_list = r2(total), total_promo = r2(total * (1 - d / 100));
  return { total_list, total_promo, discount_amt: r2(total_list - total_promo), pieces, discount_pct: d };
}

/** 'KIA Sportage' 의 모델 부분만 쓰도록 model 을 따로 받는다(없으면 title). */
export function kitName({ model, title, years, items }) {
  const m = String(model || title || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const y = String(years || '').replace(/\s+/g, '').trim();
  const codes = (items || []).map((it) => String(it.ctr_code || it.code || '').toUpperCase() + ((Number(it.qty) || 1) > 1 ? 'x' + Number(it.qty) : '')).filter(Boolean);
  return [KIT_PREFIX + ' ' + [m, y].filter(Boolean).join(' '), ...codes].join('_').slice(0, 250);
}

/** 키트로 만들 수 있는 수량 = min(부품 재고 ÷ 수량) */
export function kitBuildable(items) {
  let n = Infinity;
  for (const it of items || []) { const q = Number(it.qty) || 1; n = Math.min(n, Math.floor(Math.max(0, Number(it.stock_qty) || 0) / q)); }
  return Number.isFinite(n) ? n : 0;
}

// 0293 전(표 없음)에는 조용히 쉰다 — 견적 저장이 키트 때문에 멈추면 안 된다.
let readyFlag = false; let probeAt = 0;
export async function promosReady(q = query) {
  if (readyFlag) return true;
  if (Date.now() - probeAt < 30000) return false;
  probeAt = Date.now();
  try { readyFlag = !!(await q(`SELECT to_regclass('vio_promos') AS t`)).rows[0].t; } catch (_) { readyFlag = false; }
  return readyFlag;
}
export function setPromosReady(v) { readyFlag = !!v; probeAt = Date.now(); }

/** 키트 제품 id/코드 → 구성품. Map(product_id → {promo_no, items:[{product_id, ctr_code, qty}]}) */
export async function kitsFor({ ids = [], codes = [] }, q = query) {
  const out = new Map();
  ids = [...new Set(ids.map(Number).filter(Boolean))]; codes = [...new Set(codes.map((c) => String(c || '').trim().toUpperCase()).filter(Boolean))];
  if ((!ids.length && !codes.length) || !(await promosReady(q))) return out;
  const rows = (await q(
    `SELECT v.product_id, p.code AS kit_code, v.promo_no, i.product_id AS item_pid, i.ctr_code, i.qty, i.line_no
       FROM vio_promos v
       JOIN products p ON p.id = v.product_id AND p.deleted_at IS NULL
       JOIN vio_promo_items i ON i.promo_id = v.id
      WHERE v.product_id = ANY($1::bigint[]) OR upper(p.code) = ANY($2::text[])
      ORDER BY v.product_id, i.line_no`, [ids, codes])).rows;
  for (const r of rows) {
    const k = Number(r.product_id);
    if (!out.has(k)) out.set(k, { product_id: k, kit_code: r.kit_code, promo_no: r.promo_no, items: [] });
    out.get(k).items.push({ product_id: Number(r.item_pid), ctr_code: r.ctr_code, qty: Number(r.qty) });
  }
  return out;
}

/**
 * 견적 입력 줄 중 키트(제품 id 또는 코드가 키트)는 구성 부품 줄로 바꾼다. 키트 n개 → 부품 qty × n.
 * 풀린 줄에는 kit_no(프로모션 번호) · kit_code 가 붙는다(화면 안내용 — 저장은 부품 줄 그대로).
 */
export async function expandKitLines(lines, q = query) {
  const list = Array.isArray(lines) ? lines : [];
  if (!list.length) return list;
  let kits;
  try {
    kits = await kitsFor({ ids: list.map((l) => l && l.product_id).filter(Boolean), codes: list.filter((l) => l && !l.product_id).map((l) => l.code) }, q);
  } catch (_) { return list; }
  if (!kits.size) return list;
  const byCode = new Map([...kits.values()].map((k) => [String(k.kit_code).toUpperCase(), k]));
  const out = [];
  for (const l of list) {
    const k = (l && l.product_id && kits.get(Number(l.product_id))) || (l && !l.product_id && byCode.get(String(l.code || '').trim().toUpperCase()));
    if (!k) { out.push(l); continue; }
    const n = Number(l.qty) || 0;
    for (const it of k.items) out.push({ code: it.ctr_code, product_id: it.product_id, qty: it.qty * n, kit_no: k.promo_no, kit_code: k.kit_code });
  }
  return out;
}
