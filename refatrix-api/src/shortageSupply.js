// =====================================================================
// Refatrix ERP · shortageSupply.js — 부족분 세부기록 「SKU별 공급·수요」 (2026-11-11)
//   GET /api/shortages/supply?product_ids=1,2,3[&customer_id=5]   (routes/salesRoutes.js)
//   화면: 영업지원 › 부족분 › 고객별 요약 → 셀 클릭 → 세부 기록 · 부족분 집계 행 펼침
//
//   새 정의를 만들지 않고 견적 엑셀·구매검토가 쓰는 숫자를 그대로 쓴다(화면끼리 숫자가 어긋나지 않게).
//     stock_qty    현재고 = products.stock_qty (수입입고 마감 즉시 반영분 포함 — 0176)
//     avail_qty    가용재고 = max(0, 현재고 − 살아 있는 견적 예약)  (reservations.js ACTIVE_RESERVATION_SQL)
//     purchase_qty 구매 = 발주했지만 아직 안 실린 수량 = max(0, 발주 미입고 − 운송)  (견적 엑셀 En producción)
//     transit_qty  운송 = 창고›수입입고에 등록된 마감 전 선적 = v_incoming_stock      (견적 엑셀 En tránsito)
//     backorder_qty 백오더 = 발주 미입고 잔량 = v_backorder = 구매 + 운송              (제품목록 Backorder)
//
//     cust_open_qty   이 고객의 이 SKU 미해소 부족 잔여 (모든 달 · status open)
//     others_live_qty 다른 고객의 미해소 부족 잔여 중 살아 있는 것(진행 중 견적 · 견적 없는 부족)
//     others_missed_qty 다른 고객의 「놓친 수요」(원 견적 만료·취소·삭제대기·삭제) — 참고 표시만
//     short_cust_qty  백오더 반영 부족(이 고객) = max(0, 이 고객 잔여 − 가용 − 백오더)
//     short_total_qty 백오더 반영 부족(전체)   = max(0, 이 고객 잔여 + 다른 고객(살아 있는) − 가용 − 백오더)
//
//   「지금 상태」 숫자라 저장하지 않고 부를 때마다 다시 계산한다(캐시 없음 · Cache-Control no-store).
// =====================================================================
import { query } from './db.js';
import { ACTIVE_RESERVATION_SQL } from './reservations.js';

export const SUPPLY_IDS_MAX = 500;
const r3 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 1000) / 1000;
const DEAD_ST = new Set(['expired', 'cancelled', 'delete_pending']);

/** ?product_ids=1,2,3 → 양의 정수 · 중복 제거 · 최대 SUPPLY_IDS_MAX. 없으면 []. */
export function parseIds(v) {
  if (v === undefined || v === null) return [];
  const arr = (Array.isArray(v) ? v.join(',') : String(v)).split(/[\s,;|]+/)
    .filter((s) => /^\d+$/.test(s)).map(Number).filter((n) => n > 0);
  return [...new Set(arr)].slice(0, SUPPLY_IDS_MAX);
}

/** 원 견적이 끝난 부족 = 놓친 수요 (구매검토와 같은 기준) */
export function isMissed(r) {
  return r.source_quote_id != null && (!!r.quote_deleted || DEAD_ST.has(r.quote_status));
}

/**
 * 순수 계산 — 제품 행 + 미해소 부족 행 → SKU별 공급·수요.
 * @param {object[]} prodRows  {id, code, name, stock_qty, reserved_qty, po_open_qty, transit_qty, transit_eta}
 * @param {object[]} shRows    {product_id, customer_id, customer_name, remaining_qty, source_quote_id, quote_no, quote_status, quote_deleted}
 * @param {number|null} customerId
 */
export function buildSupply(prodRows, shRows, customerId = null) {
  const cid = customerId == null ? null : Number(customerId);
  const out = new Map();
  for (const p of prodRows) {
    const stock = r3(p.stock_qty);
    const reserved = r3(p.reserved_qty);
    const po = r3(p.po_open_qty);
    const transit = r3(p.transit_qty);
    out.set(Number(p.id), {
      product_id: Number(p.id), code: p.code, name: p.name,
      stock_qty: stock, reserved_qty: reserved,
      avail_qty: r3(Math.max(0, stock - reserved)),
      purchase_qty: r3(Math.max(0, po - transit)),
      transit_qty: transit, transit_eta: p.transit_eta ? String(p.transit_eta).slice(0, 10) : null,
      backorder_qty: po,
      cust_open_qty: 0, others_live_qty: 0, others_missed_qty: 0,
      others: [],
    });
  }
  // 다른 고객은 고객 단위로 묶어 보여 준다(같은 고객 여러 견적 = 한 줄, 견적번호는 모아서)
  const oth = new Map();
  for (const s of shRows) {
    const o = out.get(Number(s.product_id));
    if (!o) continue;
    const rem = r3(s.remaining_qty);
    if (!(rem > 0)) continue;
    const sCid = s.customer_id == null ? null : Number(s.customer_id);
    if (cid != null && sCid === cid) { o.cust_open_qty = r3(o.cust_open_qty + rem); continue; }
    const missed = isMissed(s);
    if (missed) o.others_missed_qty = r3(o.others_missed_qty + rem);
    else o.others_live_qty = r3(o.others_live_qty + rem);
    const k = o.product_id + ':' + (sCid == null ? 'null' : sCid);
    let g = oth.get(k);
    if (!g) {
      g = { customer_id: sCid, customer_name: s.customer_name || '(고객미상)', live_qty: 0, missed_qty: 0, quotes: [] };
      oth.set(k, g); o.others.push(g);
    }
    if (missed) g.missed_qty = r3(g.missed_qty + rem); else g.live_qty = r3(g.live_qty + rem);
    if (s.quote_no && !g.quotes.some((q) => q.quote_no === s.quote_no)) {
      g.quotes.push({ quote_no: s.quote_no, status: s.quote_deleted ? 'deleted' : (s.quote_status || null), missed });
    }
  }
  for (const o of out.values()) {
    const cover = o.avail_qty + o.backorder_qty;
    o.short_cust_qty = r3(Math.max(0, o.cust_open_qty - cover));
    o.short_total_qty = r3(Math.max(0, o.cust_open_qty + o.others_live_qty - cover));
    o.others_n = o.others.filter((g) => g.live_qty > 0).length;
    o.others.sort((a, b) => (b.live_qty - a.live_qty) || (b.missed_qty - a.missed_qty));
  }
  return [...out.values()];
}

export const PROD_SQL = `
  SELECT p.id, p.code, p.name, p.stock_qty,
         COALESCE(rsv.qty, 0)          AS reserved_qty,
         COALESCE(bo.backorder_qty, 0) AS po_open_qty,
         COALESCE(inc.incoming_qty, 0) AS transit_qty,
         to_char(inc.incoming_eta, 'YYYY-MM-DD') AS transit_eta
    FROM products p
    LEFT JOIN v_backorder bo ON bo.product_id = p.id
    LEFT JOIN v_incoming_stock inc ON inc.product_id = p.id
    LEFT JOIN (SELECT ql.product_id, SUM(ql.reserved_qty) AS qty
                 FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
                WHERE ${ACTIVE_RESERVATION_SQL} AND ql.reserved_qty > 0
                  AND ql.product_id = ANY($1::bigint[])
                GROUP BY ql.product_id) rsv ON rsv.product_id = p.id
   WHERE p.id = ANY($1::bigint[])`;

export const SH_SQL = `
  SELECT sh.product_id, sh.customer_id, c.name AS customer_name,
         (sh.shortage_qty - sh.resolved_qty) AS remaining_qty,
         sh.source_quote_id, qq.quote_no, qq.status AS quote_status, (qq.deleted_at IS NOT NULL) AS quote_deleted
    FROM stock_shortages sh
    LEFT JOIN customers c ON c.id = sh.customer_id
    LEFT JOIN quotes qq ON qq.id = sh.source_quote_id
   WHERE sh.status = 'open'
     AND sh.product_id = ANY($1::bigint[])
     AND (sh.shortage_qty - sh.resolved_qty) > 0
   ORDER BY sh.occurred_at, sh.id`;

/** DB 조회 + 계산. exec 는 테스트용 주입. */
export async function loadSupply({ productIds, customerId = null }, exec = query) {
  const ids = parseIds(productIds);
  if (!ids.length) return [];
  const [p, s] = await Promise.all([exec(PROD_SQL, [ids]), exec(SH_SQL, [ids])]);
  return buildSupply(p.rows, s.rows, customerId);
}
