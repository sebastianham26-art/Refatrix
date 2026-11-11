// =====================================================================
// Refatrix ERP · pfInventory.js — REFATRIX Platform 「재고연관성」 (2026-11-11)
//   GET /api/pf-catalog/purchases   CTR 제품별 구매(발주) 이력
//   GET /api/pf-catalog/stock       CTR 제품별 재고
//   (pfCatalogRoutes.js · pf-catalog 세션 토큰) — 화면: 플랫폼 SYD 카탈로그 개발우선순위 「📦 재고연관성」
//
//   구매이력 — 원천 = 구매 › 구매내역(purchase_orders · purchase_order_lines, CTR 본사 발주)
//     · 발주 기준 · 취소(status='cancelled') · 삭제 발주 제외 · 기간 제한 없음
//     · po_qty = 발주 수량 누계 · po_count = 발주 건수(같은 발주 여러 줄 = 1건)
//     · first_po_at / last_po_at = 발주일(order_date) 최소 / 최대
//     · received_qty = 입고된 수량 · open_qty = 미입고 잔량(qty − received_qty, 0 미만은 0) — v_backorder 와 같은 정의
//     · 발주 줄이 제품과 연결되지 않았으면(product_id 없음) input_code 를 대문자·영숫자로 맞춰 CTR 코드와 맞춰 본다.
//       그래도 못 찾은 줄은 unmatched[] 로 따로 알려 준다(합산하지 않음).
//     · 발주한 CTR 만 보낸다(목록에 없으면 「구매이력 없음」).
//   재고 — 원천 = 제품 마스터 현재고(products.stock_qty, 창고 전체 합계 · 재고내역/재고이동이 움직이는 값)
//     · total_qty    = 실물 재고 전체
//     · reserved_qty = 미결(작성중·확정) · 미만료(또는 포장지시 출력) 견적의 예약(apartado) — 견적 화면 Disponible 과 같은 조건
//     · stock_qty    = 가용 재고 = max(0, total − reserved)
//     · 운송 중(수입 선적)은 넣지 않는다 — transit_qty 는 참고로 따로 보낸다(/perf 의 transit_qty 와 같은 값)
//     · 대상 CTR 코드 전부(재고 0 포함 · has_stock 으로 구분)
//   코드 = products.code(CTR 신규 코드) · 대상 = pfCatalog.TARGET_SQL(PRO · 키트 제외).
//   가격 · 원가 · 금액은 내보내지 않는다.
// =====================================================================
import { query } from './db.js';
import { TARGET_SQL } from './pfCatalog.js';
import { parseCodes } from './pfPerf.js';

const CACHE_MS = Number(process.env.PF_INV_CACHE_MS || 5 * 60 * 1000);
const r3 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 1000) / 1000;

const codeCond = (codes, params) => {
  if (!codes || !codes.length) return '';
  params.push(codes);
  return ` AND upper(btrim(p.code)) = ANY($${params.length}::text[])`;
};

/** 구매(발주) 이력 — 발주한 CTR 코드만, 코드별 한 줄. */
export async function computePurchases({ codes = null } = {}, exec = query) {
  const params = [];
  const cc = codeCond(codes, params);
  const sql = `
    WITH tgt AS (SELECT p.id, upper(btrim(p.code)) AS code,
                        regexp_replace(upper(p.code), '[^A-Z0-9]', '', 'g') AS norm
                   FROM products p WHERE ${TARGET_SQL}${cc}),
    ln AS (
      SELECT l.id, l.po_id, l.input_code, l.qty, l.received_qty, po.order_date,
             COALESCE(l.product_id,
                      (SELECT t.id FROM tgt t WHERE t.norm = regexp_replace(upper(l.input_code), '[^A-Z0-9]', '', 'g')
                        ORDER BY t.id LIMIT 1)) AS pid,
             (l.product_id IS NULL) AS by_code
        FROM purchase_order_lines l
        JOIN purchase_orders po ON po.id = l.po_id
       WHERE po.deleted_at IS NULL AND po.status <> 'cancelled')
    SELECT t.code,
           SUM(ln.qty) AS po_qty,
           COUNT(DISTINCT ln.po_id) AS po_count,
           COUNT(*) AS line_count,
           to_char(MIN(ln.order_date), 'YYYY-MM-DD') AS first_po_at,
           to_char(MAX(ln.order_date), 'YYYY-MM-DD') AS last_po_at,
           SUM(ln.received_qty) AS received_qty,
           SUM(GREATEST(ln.qty - ln.received_qty, 0)) AS open_qty,
           SUM(CASE WHEN ln.by_code THEN 1 ELSE 0 END) AS by_code_lines
      FROM ln JOIN tgt t ON t.id = ln.pid
     GROUP BY t.code
    HAVING SUM(ln.qty) > 0
     ORDER BY t.code`;
  const rows = (await exec(sql, params)).rows;
  // 제품과 못 맞춘 발주 줄(코드 지정 조회에서는 생략)
  let unmatched = [];
  if (!codes) {
    unmatched = (await exec(`
      SELECT upper(btrim(l.input_code)) AS input_code, SUM(l.qty) AS qty, COUNT(DISTINCT l.po_id) AS po_count
        FROM purchase_order_lines l
        JOIN purchase_orders po ON po.id = l.po_id
       WHERE po.deleted_at IS NULL AND po.status <> 'cancelled' AND l.product_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM products p WHERE ${TARGET_SQL}
                          AND regexp_replace(upper(p.code), '[^A-Z0-9]', '', 'g') = regexp_replace(upper(l.input_code), '[^A-Z0-9]', '', 'g'))
       GROUP BY 1 ORDER BY 1`)).rows.map((r) => ({ input_code: r.input_code, qty: r3(r.qty), po_count: Number(r.po_count) }));
  }
  const items = rows.map((r) => ({
    code: r.code,
    po_qty: r3(r.po_qty),
    po_count: Number(r.po_count),
    first_po_at: r.first_po_at,
    last_po_at: r.last_po_at,
    received_qty: r3(r.received_qty),
    open_qty: r3(r.open_qty),
  }));
  return {
    updated_at: new Date().toISOString(),
    source: '구매 › 구매내역 (CTR 본사 발주) — 발주 기준 · 취소 · 삭제 제외 · 전체 기간',
    count: items.length,
    items,
    unmatched,
  };
}

/** 재고 — 대상 CTR 코드 전부(0 포함). */
export async function computeStock({ codes = null } = {}, exec = query) {
  const params = [];
  const cc = codeCond(codes, params);
  const sql = `
    SELECT upper(btrim(p.code)) AS code,
           COALESCE(p.stock_qty, 0) AS total_qty,
           COALESCE(rs.reserved_qty, 0) AS reserved_qty,
           COALESCE(inc.incoming_qty, 0) AS transit_qty
      FROM products p
      LEFT JOIN (SELECT ql.product_id, SUM(ql.reserved_qty) AS reserved_qty
                   FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
                  WHERE ql.product_id IS NOT NULL
                    AND q.status IN ('draft','confirmed')
                    AND (q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)
                    AND q.deleted_at IS NULL
                  GROUP BY ql.product_id) rs ON rs.product_id = p.id
      LEFT JOIN v_incoming_stock inc ON inc.product_id = p.id
     WHERE ${TARGET_SQL}${cc}
     ORDER BY 1`;
  const by = new Map();
  for (const r of (await exec(sql, params)).rows) {
    const prev = by.get(r.code) || { total: 0, reserved: 0, transit: 0 };
    prev.total += Number(r.total_qty) || 0; prev.reserved += Number(r.reserved_qty) || 0; prev.transit += Number(r.transit_qty) || 0;
    by.set(r.code, prev);
  }
  const items = [];
  for (const [code, v] of by) {
    const total = r3(v.total);
    const reserved = r3(Math.max(0, v.reserved));
    const avail = r3(Math.max(0, total - reserved));
    const o = { code, stock_qty: avail, total_qty: total, reserved_qty: reserved, has_stock: avail > 0 };
    if (v.transit > 0) o.transit_qty = r3(v.transit);
    items.push(o);
  }
  const withStock = items.filter((x) => x.has_stock).length;
  return {
    updated_at: new Date().toISOString(),
    source: '제품 현재고(창고 합계) − 견적 예약 = 가용 재고 · 운송 중 미포함',
    count: items.length,
    count_stock: withStock,
    count_zero: items.length - withStock,
    items,
  };
}

// 전체 조회는 몇 분 묵혀 둔다(화면 30분 주기 · 여러 사람이 동시에 열 때 겹침 방지)
const cache = new Map();
export function clearInventoryCache() { cache.clear(); }
async function cached(key, fn, { codes, fresh }) {
  if (codes && codes.length) return fn({ codes });
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await fn({});
  cache.set(key, { at: Date.now(), data });
  return data;
}
export const loadPurchases = ({ codes = null, fresh = false } = {}) => cached('po', computePurchases, { codes, fresh });
export const loadStock = ({ codes = null, fresh = false } = {}) => cached('stock', computeStock, { codes, fresh });
export { parseCodes };
