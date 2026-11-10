// =====================================================================
// Refatrix ERP · pfPerf.js — REFATRIX Platform 「CTR 제품별 실적 수량」 (2026-11-10)
//   GET /api/pf-catalog/perf  (pfCatalogRoutes.js · pf-catalog 세션 토큰)
//   화면: 플랫폼 SYD 카탈로그 · 매칭테스트 「📊 견적 n / 매출 n / 운송 n / 백오더 n」
//
//   집계 기준 — 새 기준을 만들지 않고 ERP 화면이 이미 쓰는 정의를 그대로 쓴다(숫자가 어긋나지 않게).
//     quote_qty     견적 — 기간 안(quote_date) 견적 중 매출로 전환되지 않은 것: 작성중 · 확정 · 만료.
//                   전환(converted) · 취소 · 삭제대기 · 삭제 · 가용재고표(pricelist) 는 뺀다.
//                   (quote_open_qty = 그중 지금 살아 있는 작성중 · 확정만 — quoteRoutes open 기준)
//     sold_qty      매출 — 기간 안(inv_date) 게시(posted) · 미삭제 인보이스 수량.
//                   제품목록 sold_qty · customerSold.js 와 같은 정의. ERP 반품은 NC(금액)뿐이라 수량 차감은 없다.
//     transit_qty   운송 중 — 창고›수입입고에 등록된 마감 전 선적(incoming · receiving) = v_incoming_stock.
//                   견적 엑셀 「En tránsito」와 같은 숫자. 고객 배송 도착(인수)은 ERP 에 기록이 없다.
//     backorder_qty 백오더 — 부족분 미해소(stock_shortages open, 잔량 = shortage_qty − resolved_qty).
//                   주문했지만 재고가 없어 출고 못 한 수량 · productStatus 「부족분 미해소」와 같은 정의.
//                   (po_open_qty = 공장 발주 미입고 잔량 v_backorder — ERP 제품목록의 「Backorder」 칸)
//     transit · backorder · po_open 은 「지금 상태」라 기간을 적용하지 않는다.
//
//   코드 = products.code(CTR 신규 코드). 실적은 모두 product_id 로 묶이므로 코드를 바꾼 제품은
//   예전 실적까지 새 코드로 합산된다. 대상 = pfCatalog.TARGET_SQL(PRO · 키트 제외).
//   가격 · 금액 · 고객명은 내보내지 않는다.
//
//   2026-11-10b · 실적이 전혀 없는 코드도 내보낸다(디렉터 요청 — 「실적 없음」과 「아직 못 받음」을 구분).
//     · 실적 있음: has_perf:true  · perf_status:'ok'   + 네 수량 · 선택 필드
//     · 실적 없음: has_perf:false · perf_status:'none' · perf_label:'실적 없음' + 네 수량 0 (선택 필드 생략 → 응답 작게)
//     · ?only=perf 를 붙이면 예전처럼 실적 있는 코드만.
// =====================================================================
import { query } from './db.js';
import { TARGET_SQL } from './pfCatalog.js';

export const PERF_MONTHS_DEFAULT = 12;
export const PERF_CODES_MAX = 3000;
const CACHE_MS = Number(process.env.PF_PERF_CACHE_MS || 10 * 60 * 1000);

const r3 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 1000) / 1000;
const normCode = (s) => String(s == null ? '' : s).trim().toUpperCase();

/** ?months= → 1~120 · 'all'/0 → 0(전체 누적) · 그 밖 → 기본 12 */
export function parseMonths(v) {
  if (v === undefined || v === null || v === '') return PERF_MONTHS_DEFAULT;
  const s = String(v).trim().toLowerCase();
  if (s === 'all' || s === '0') return 0;
  const n = parseInt(s, 10);
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : PERF_MONTHS_DEFAULT;
}

/** ?codes=A,B → 대문자 · 중복 제거 · 최대 PERF_CODES_MAX. 없으면 null(전체). */
export function parseCodes(v) {
  if (v === undefined || v === null) return null;
  const arr = (Array.isArray(v) ? v.join(',') : String(v)).split(/[\s,;|]+/).map(normCode).filter(Boolean);
  if (!arr.length) return null;
  return [...new Set(arr)].slice(0, PERF_CODES_MAX);
}

/** 플랫폼 화면이 그대로 보여 줄 수 있는 집계 기준 설명 */
export function perfDefs(months) {
  const per = months ? `최근 ${months}개월` : '전체 누적';
  return {
    quote: `${per} 견적 중 매출로 전환되지 않은 수량(작성중·확정·만료). 전환·취소·삭제 제외`,
    sold: `${per} 매출 확정(게시) 인보이스 수량. 삭제 인보이스 제외`,
    transit: '공장에서 선적되어 창고 입고 마감 전인 수량(수입입고 등록 기준, 현재)',
    backorder: '주문했지만 재고가 없어 출고하지 못한 수량 — 부족분 미해소 잔량(현재)',
  };
}

const QTY4 = ['quote_qty', 'sold_qty', 'transit_qty', 'backorder_qty'];
export const NONE_LABEL = '실적 없음';

/** 네 수량이 모두 0 인지에 따라 표시 상태를 붙인다(합친 뒤에도 다시 부른다). */
function markPerf(o) {
  const has = QTY4.some((k) => Number(o[k]) > 0);
  o.has_perf = has;
  o.perf_status = has ? 'ok' : 'none';
  if (has) delete o.perf_label; else o.perf_label = NONE_LABEL;
  return o;
}

function rowOut(r) {
  const o = {
    code: r.code,
    quote_qty: r3(r.quote_qty), sold_qty: r3(r.sold_qty), transit_qty: r3(r.transit_qty), backorder_qty: r3(r.backorder_qty),
  };
  // 실적 없는 코드는 네 수량(0)과 표시 상태만 — 1만 개가 넘어도 응답이 가볍게
  if (!QTY4.some((k) => o[k] > 0) && !(Number(r.po_open_qty) > 0)) return markPerf(o);
  Object.assign(o, {
    quote_n: Number(r.quote_n || 0), sold_n: Number(r.sold_n || 0),
    quote_open_qty: r3(r.quote_open_qty), po_open_qty: r3(r.po_open_qty),
  });
  if (r.transit_eta) o.transit_eta = String(r.transit_eta).slice(0, 10);
  if (r.last_sold_on) o.last_sold_on = String(r.last_sold_on).slice(0, 10);
  return markPerf(o);
}

// 기간 시작 = 멕시코 오늘 − N개월(그날 포함). $1 = 개월수(0 = 전체 → 시작일 NULL).
const FROM_SQL = `CASE WHEN $1::int > 0
  THEN ((now() AT TIME ZONE 'America/Mexico_City')::date - make_interval(months => $1::int))::date END`;

/**
 * 제품별 실적 — 대상 CTR 코드 전부(실적 없음 포함). onlyPerf 면 네 수량 중 하나라도 > 0 인 코드만.
 * @param {{months?:number, codes?:string[]|null, onlyPerf?:boolean}} opt
 * @returns {Promise<{updated_at:string, period:object, defs:object, items:object[]}>}
 */
export async function computePerf({ months = PERF_MONTHS_DEFAULT, codes = null, onlyPerf = false } = {}, exec = query) {
  const params = [months];
  let codeCond = '';
  if (codes && codes.length) { params.push(codes); codeCond = ` AND upper(btrim(p.code)) = ANY($2::text[])`; }
  const sql = `
    WITH per AS (SELECT ${FROM_SQL} AS d_from),
    tgt AS (SELECT p.id, upper(btrim(p.code)) AS code FROM products p WHERE ${TARGET_SQL}${codeCond}),
    qt AS (
      SELECT ql.product_id,
             SUM(ql.qty) AS quote_qty,
             COUNT(DISTINCT q.id) AS quote_n,
             SUM(CASE WHEN q.status IN ('draft','confirmed') THEN ql.qty ELSE 0 END) AS quote_open_qty
        FROM quote_lines ql
        JOIN quotes q ON q.id = ql.quote_id
        CROSS JOIN per
       WHERE ql.product_id IN (SELECT id FROM tgt)
         AND q.deleted_at IS NULL
         AND q.status IN ('draft','confirmed','expired')
         AND (per.d_from IS NULL OR q.quote_date >= per.d_from)
       GROUP BY ql.product_id),
    sd AS (
      SELECT sil.product_id,
             SUM(sil.qty) AS sold_qty,
             COUNT(DISTINCT si.id) AS sold_n,
             MAX(si.inv_date) AS last_sold_on
        FROM sales_invoice_lines sil
        JOIN sales_invoices si ON si.id = sil.invoice_id
        CROSS JOIN per
       WHERE sil.product_id IN (SELECT id FROM tgt)
         AND si.status = 'posted' AND si.deleted_at IS NULL
         AND (per.d_from IS NULL OR si.inv_date >= per.d_from)
       GROUP BY sil.product_id),
    bo AS (
      SELECT sh.product_id, SUM(sh.shortage_qty - COALESCE(sh.resolved_qty, 0)) AS backorder_qty
        FROM stock_shortages sh
       WHERE sh.product_id IN (SELECT id FROM tgt)
         AND sh.status = 'open'
         AND (sh.shortage_qty - COALESCE(sh.resolved_qty, 0)) > 0
       GROUP BY sh.product_id)
    SELECT t.code,
           COALESCE(qt.quote_qty, 0) AS quote_qty, COALESCE(qt.quote_n, 0) AS quote_n,
           COALESCE(qt.quote_open_qty, 0) AS quote_open_qty,
           COALESCE(sd.sold_qty, 0) AS sold_qty, COALESCE(sd.sold_n, 0) AS sold_n,
           to_char(sd.last_sold_on, 'YYYY-MM-DD') AS last_sold_on,
           COALESCE(inc.incoming_qty, 0) AS transit_qty, to_char(inc.incoming_eta, 'YYYY-MM-DD') AS transit_eta,
           COALESCE(bo.backorder_qty, 0) AS backorder_qty,
           COALESCE(po.backorder_qty, 0) AS po_open_qty
      FROM tgt t
      LEFT JOIN qt ON qt.product_id = t.id
      LEFT JOIN sd ON sd.product_id = t.id
      LEFT JOIN bo ON bo.product_id = t.id
      LEFT JOIN v_incoming_stock inc ON inc.product_id = t.id
      LEFT JOIN v_backorder po ON po.product_id = t.id
     ${onlyPerf ? `WHERE COALESCE(qt.quote_qty, 0) > 0 OR COALESCE(sd.sold_qty, 0) > 0
        OR COALESCE(inc.incoming_qty, 0) > 0 OR COALESCE(bo.backorder_qty, 0) > 0` : ''}
     ORDER BY t.code`;
  const [rows, per] = await Promise.all([
    exec(sql, params).then((r) => r.rows),
    exec(`SELECT to_char(${FROM_SQL}, 'YYYY-MM-DD') AS d_from,
                 to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d_to`, [months]).then((r) => r.rows[0]),
  ]);
  // 같은 코드가 두 제품 행에 있으면(대소문자 · 공백 차이) 한 줄로 합친다
  const by = new Map();
  for (const r of rows) {
    const o = rowOut(r);
    const prev = by.get(o.code);
    if (!prev) { by.set(o.code, o); continue; }
    for (const k of ['quote_qty', 'sold_qty', 'transit_qty', 'backorder_qty', 'quote_open_qty', 'po_open_qty']) {
      if (prev[k] !== undefined || o[k] !== undefined) prev[k] = r3((prev[k] || 0) + (o[k] || 0));
    }
    for (const k of ['quote_n', 'sold_n']) if (prev[k] !== undefined || o[k] !== undefined) prev[k] = (prev[k] || 0) + (o[k] || 0);
    if (o.transit_eta && (!prev.transit_eta || o.transit_eta < prev.transit_eta)) prev.transit_eta = o.transit_eta;
    if (o.last_sold_on && (!prev.last_sold_on || o.last_sold_on > prev.last_sold_on)) prev.last_sold_on = o.last_sold_on;
    markPerf(prev);
  }
  const items = [...by.values()];
  const withPerf = items.filter((x) => x.has_perf).length;
  const label = months ? `최근 ${months}개월 (${per.d_from} ~ ${per.d_to})` : `전체 누적 (~ ${per.d_to})`;
  return {
    updated_at: new Date().toISOString(),
    period: { months, from: per.d_from || null, to: per.d_to, label, applies_to: ['quote_qty', 'sold_qty'] },
    defs: perfDefs(months),
    count: items.length,
    count_perf: withPerf,            // 실적 있음
    count_none: items.length - withPerf,   // 실적 없음(onlyPerf 면 0)
    only_perf: !!onlyPerf,
    none_label: NONE_LABEL,
    items,
  };
}

// 전체 조회(코드 지정 없음)는 몇 분 묵혀 둔다 — 브라우저마다 3시간에 1번이지만 동시에 열면 겹친다.
const cache = new Map();   // 'months:all|perf' → {at, data}
export function clearPerfCache() { cache.clear(); }
export async function loadPerf({ months = PERF_MONTHS_DEFAULT, codes = null, fresh = false, onlyPerf = false } = {}) {
  if (codes && codes.length) return computePerf({ months, codes, onlyPerf });
  const key = months + (onlyPerf ? ':perf' : ':all');
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await computePerf({ months, onlyPerf });
  cache.set(key, { at: Date.now(), data });
  return data;
}
