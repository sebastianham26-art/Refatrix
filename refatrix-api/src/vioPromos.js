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

// =====================================================================
// 0306 · 견적 줄의 키트 번호(kit_no) — 창고가 구성품을 「키트 단위」로 알아보고 포장하게 (디렉터 지시 2026-10-28)
//   키트는 **키트 번호(K0001…)로 정리한다** — 차종 이름이 아니다. 같은 차종에 키트가 여럿이어도 번호가 다르면 다른 묶음.
//   kit_no 는 표시용 라벨이다. 재고·금액·예약은 지금처럼 구성 부품 줄 그대로.
// =====================================================================
export function normKitNo(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return /^K\d{3,6}$/.test(s) ? s : null;
}

// 0306 전(칸 없음)에는 조용히 쉰다 — 견적 저장이 키트 표시 때문에 멈추면 안 된다.
let kitColFlag = false; let kitColProbe = 0;
export async function kitColReady(q = query) {
  if (kitColFlag) return true;
  if (Date.now() - kitColProbe < 30000) return false;
  kitColProbe = Date.now();
  try {
    kitColFlag = (await q(
      `SELECT 1 FROM information_schema.columns WHERE table_name='quote_lines' AND column_name='kit_no' LIMIT 1`)).rows.length > 0;
  } catch (_) { kitColFlag = false; }
  return kitColFlag;
}
export function setKitColReady(v) { kitColFlag = !!v; kitColProbe = Date.now(); }

/**
 * 키트 구성(comp: [{product_id, qty}]) 대비 견적 줄(lines: [{product_id, qty}])이 몇 세트인가.
 *   sets = 가장 적게 들어 있는 부품 기준(내림), consistent = 모든 부품이 같은 세트 수 · 구성 밖 부품 없음.
 */
export function kitSetCount(comp, lines) {
  if (!Array.isArray(comp) || !comp.length) return { sets: null, consistent: false };
  const have = new Map();
  for (const l of lines || []) { const k = Number(l.product_id); have.set(k, (have.get(k) || 0) + (Number(l.qty) || 0)); }
  const ratios = comp.map((c) => (have.get(Number(c.product_id)) || 0) / (Number(c.qty) || 1));
  const sets = Math.floor(Math.min(...ratios));
  const compIds = new Set(comp.map((c) => Number(c.product_id)));
  const extra = [...have.keys()].some((k) => !compIds.has(k));
  const consistent = !extra && sets > 0 && ratios.every((r) => r === sets);
  return { sets, consistent };
}

/** 키트 번호들 → 구성. Map(kit_no → {kit_no, kit_code, title, years, items:[{product_id, ctr_code, qty}]}) */
export async function kitCompositions(nos, q = query) {
  const out = new Map();
  const list = [...new Set((nos || []).map(normKitNo).filter(Boolean))];
  if (!list.length || !(await promosReady(q))) return out;
  const rows = (await q(
    `SELECT v.promo_no, v.title, v.years, p.code AS kit_code, i.product_id, i.ctr_code, i.qty, i.line_no
       FROM vio_promos v
       LEFT JOIN products p ON p.id = v.product_id
       JOIN vio_promo_items i ON i.promo_id = v.id
      WHERE upper(v.promo_no) = ANY($1::text[])
      ORDER BY v.promo_no, i.line_no`, [list])).rows;
  for (const r of rows) {
    const k = String(r.promo_no).toUpperCase();
    if (!out.has(k)) out.set(k, { kit_no: k, kit_code: r.kit_code || k, title: r.title || '', years: r.years || '', items: [] });
    out.get(k).items.push({ product_id: Number(r.product_id), ctr_code: r.ctr_code, qty: Number(r.qty) });
  }
  return out;
}

/**
 * 견적 줄(kit_no 가 붙은 것) → 키트 요약 목록. **키트 번호 순서**로 정렬.
 *   [{kit_no, kit_code, title, years, sets, consistent, sku, pieces, items:[구성 {ctr_code, qty}]}]
 *   구성(vio_promos)이 지워졌으면 견적 줄로 items 를 만들고 sets=null.
 */
export async function kitSummaries(lines, q = query) {
  const by = new Map();
  for (const l of lines || []) {
    const k = normKitNo(l && l.kit_no); if (!k || !l.product_id) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push({ product_id: Number(l.product_id), ctr_code: l.ctr_code || '', qty: Number(l.qty) || 0 });
  }
  if (!by.size) return [];
  let comps = new Map();
  try { comps = await kitCompositions([...by.keys()], q); } catch (_) { comps = new Map(); }
  const out = [];
  for (const [k, ls] of by) {
    const comp = comps.get(k);
    const { sets, consistent } = kitSetCount(comp ? comp.items : null, ls);
    const items = comp ? comp.items.map((c) => ({ ctr_code: c.ctr_code, qty: c.qty }))
      : ls.map((x) => ({ ctr_code: x.ctr_code, qty: x.qty }));
    out.push({ kit_no: k, kit_code: comp ? comp.kit_code : k, title: comp ? comp.title : '', years: comp ? comp.years : '',
      sets, consistent, sku: new Set(ls.map((x) => x.product_id)).size, pieces: ls.reduce((s, x) => s + x.qty, 0), items });
  }
  out.sort((a, b) => a.kit_no.localeCompare(b.kit_no, 'en', { numeric: true }));
  return out;
}

/** 저장된 견적 줄에 kit_no 를 찍는다 — INSERT 문(네 경로)을 건드리지 않으려고 뒤에 UPDATE 로. */
export async function stampKitNos(c, quoteId, lines) {
  if (!Array.isArray(lines) || !lines.some((l) => l && normKitNo(l.kit_no))) return;
  if (!(await kitColReady())) return;
  for (const l of lines) {
    const k = normKitNo(l && l.kit_no); if (!k) continue;
    await c.query(`UPDATE quote_lines SET kit_no=$1 WHERE quote_id=$2 AND line_no=$3`, [k, quoteId, l.line_no]);
  }
}
