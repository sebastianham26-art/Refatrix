// =====================================================================
// Refatrix ERP · salesTrendRoutes.js (2026-10-16 · 구매 › 판매 이력·주기)
//   전체 카탈로그 SKU별 월별 판매 흐름 · 판매 주기 · 수요유형 · 예측 · 구매 제안.
//   디렉터 결정(2026-10-16): 디렉터 · 소시오 전용(화면 권한과 무관 — requireRoles) ·
//     ERP 매출(posted 인보이스)만 · 견적 부족은 별도 열(예측 포함은 화면에서 선택) · 리드타임 기본 4개월.
//   순수 읽기(쓰기 없음 · 마이그레이션 없음). 계산은 src/salesTrend.js.
// =====================================================================
import { gzipSync } from 'node:zlib';
import { query } from '../db.js';
import { authGuard, requireRoles, DIR_SOCIO } from '../middleware/authGuard.js';
import { mxToday } from '../priceMaster.js';
import { monthKeys, analyzeSku, partKind, pairCode, DEFAULT_LEAD, DEFAULT_SAFE } from '../salesTrend.js';

const ONLY = requireRoles(DIR_SOCIO);
const MONTH_OPTS = [12, 24, 36];

export function windowFor(monthsParam, today = mxToday()) {
  const n = MONTH_OPTS.includes(Number(monthsParam)) ? Number(monthsParam) : 24;
  const curYm = today.slice(0, 7);
  const months = monthKeys(curYm, n);
  return { n, curYm, months, from: months[0] + '-01', to: today };
}
function numParam(v, def, lo, hi) {
  const x = Number(v);
  return Number.isFinite(x) && v !== '' && v != null ? Math.min(hi, Math.max(lo, x)) : def;
}

// 월별 판매(posted · 미삭제) — product_id × ym.
const SQL_SALES = `
  SELECT sil.product_id, to_char(si.inv_date,'YYYY-MM') AS ym, SUM(sil.qty) AS qty
    FROM sales_invoice_lines sil
    JOIN sales_invoices si ON si.id = sil.invoice_id
   WHERE si.status = 'posted' AND si.deleted_at IS NULL
     AND si.inv_date >= $1::date AND si.inv_date <= $2::date
   GROUP BY sil.product_id, to_char(si.inv_date,'YYYY-MM')`;
// 못 판 수량(월별) = 부족분 − 판매로 해소된 몫. 취소 제외. 견적·매출 부족 모두.
const SQL_LOST = `
  SELECT sh.product_id, to_char(sh.occurred_at,'YYYY-MM') AS ym,
         SUM(GREATEST(sh.shortage_qty - COALESCE(rs.qty,0), 0)) AS qty
    FROM stock_shortages sh
    LEFT JOIN (SELECT shortage_id, SUM(qty) AS qty FROM stock_shortage_resolutions
                WHERE source IN ('sale','scan') GROUP BY shortage_id) rs ON rs.shortage_id = sh.id
   WHERE sh.status <> 'cancelled'
     AND sh.occurred_at >= $1::date AND sh.occurred_at <= $2::date
   GROUP BY sh.product_id, to_char(sh.occurred_at,'YYYY-MM')`;

function seriesMap(rows, months) {
  const pos = new Map(months.map((m, i) => [m, i]));
  const by = new Map();
  for (const r of rows) {
    const i = pos.get(r.ym); if (i === undefined) continue;
    const k = Number(r.product_id);
    if (!by.has(k)) by.set(k, new Array(months.length).fill(0));
    by.get(k)[i] += Number(r.qty) || 0;
  }
  return by;
}
const zeros = (n) => new Array(n).fill(0);

export default async function salesTrendRoutes(app) {
  const gate = { preHandler: [authGuard, ONLY] };

  // 목록: 기간 내 활동 SKU(판매·재고·발주잔량·미해소 부족 중 하나라도) — all=1 이면 삭제 안 된 전 SKU.
  app.get('/api/salestrend', gate, async (req, reply) => {
    const w = windowFor(req.query.months);
    const lead = numParam(req.query.lead, DEFAULT_LEAD, 1, 12);
    const safe = numParam(req.query.safe, DEFAULT_SAFE, 0, 6);
    const all = ['1', 'true', 'yes'].includes(String(req.query.all || '').toLowerCase());

    const [prod, sales, lost, first, cust] = await Promise.all([
      query(`SELECT p.id, p.code, p.name, p.app, p.stock_qty, p.is_active,
                    COALESCE(bo.backorder_qty,0) AS backorder_qty,
                    COALESCE(inc.incoming_qty,0) AS incoming_qty, inc.incoming_eta::text AS incoming_eta,
                    COALESCE(sh.qty,0) AS shortage_open,
                    (SELECT string_agg(sc.syd_code, ' · ' ORDER BY sc.syd_code) FROM product_syd_codes sc WHERE sc.product_id = p.id) AS syd
               FROM products p
               LEFT JOIN v_backorder bo ON bo.product_id = p.id
               LEFT JOIN v_incoming_stock inc ON inc.product_id = p.id
               LEFT JOIN (SELECT product_id, SUM(shortage_qty - resolved_qty) AS qty
                            FROM stock_shortages WHERE status = 'open' GROUP BY product_id) sh ON sh.product_id = p.id
              WHERE p.deleted_at IS NULL
              ORDER BY p.code`),
      query(SQL_SALES, [w.from, w.to]),
      query(SQL_LOST, [w.from, w.to]),
      query(`SELECT sil.product_id, to_char(MIN(si.inv_date),'YYYY-MM') AS ym
               FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil.invoice_id
              WHERE si.status = 'posted' AND si.deleted_at IS NULL
              GROUP BY sil.product_id`),
      query(`SELECT sil.product_id, si.customer_id, SUM(sil.qty) AS qty
               FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil.invoice_id
              WHERE si.status = 'posted' AND si.deleted_at IS NULL
                AND si.inv_date >= $1::date AND si.inv_date <= $2::date
              GROUP BY sil.product_id, si.customer_id`, [w.from, w.to]),
    ]);
    const sBy = seriesMap(sales.rows, w.months);
    const lBy = seriesMap(lost.rows, w.months);
    const firstBy = new Map(first.rows.map((r) => [Number(r.product_id), r.ym]));
    const cBy = new Map();     // product → {n, top, tot}
    for (const r of cust.rows) {
      const k = Number(r.product_id), q = Number(r.qty) || 0;
      const o = cBy.get(k) || { n: 0, top: 0, tot: 0 };
      o.n++; o.tot += q; if (q > o.top) o.top = q; cBy.set(k, o);
    }

    const items = [];
    for (const p of prod.rows) {
      const id = Number(p.id);
      const series = sBy.get(id) || zeros(w.n);
      const lostS = lBy.get(id) || zeros(w.n);
      const stock = Number(p.stock_qty) || 0, backorder = Number(p.backorder_qty) || 0;
      const shortOpen = Number(p.shortage_open) || 0;
      const active = series.some((q) => q > 0) || stock !== 0 || backorder > 0 || shortOpen > 0 || lostS.some((q) => q > 0);
      if (!all && !active) continue;
      const a = analyzeSku({ series, lostSeries: lostS, months: w.months, firstSaleYm: firstBy.get(id) || null,
        curYm: w.curYm, stock, backorder, lead, safe });
      const c = cBy.get(id);
      // 목록은 가볍게(전 카탈로그 1만+ SKU): 커버·제안은 화면이 fc·supply 로 계산(같은 공식), 상세 항목은 상세 API 에서.
      items.push({
        product_id: id, code: p.code, name: p.name || '', app: String(p.app || '').slice(0, 160), syd: p.syd || '',
        kind: partKind(p.name, p.code), pair: pairCode(p.code), is_active: p.is_active !== false,
        stock, backorder, incoming: Number(p.incoming_qty) || 0, shortage_open: shortOpen,
        series, lost: lostS.some((q) => q > 0) ? lostS : null,
        top_share: c && c.tot > 0 ? Math.round((c.top / c.tot) * 100) / 100 : null,
        type: a.type, total: a.total, sale_months: a.sale_months, adi: a.adi, cv2: a.cv2, avg6: a.avg6, trend: a.trend,
        since_last: a.since_last, last_ym: a.last_ym, fc: a.fc, fc_lost: a.fc_lost, lost_total: a.lost_total, supply: a.supply,
      });
    }
    const body = { months: w.months, cur_ym: w.curYm, today: w.to, lead, safe, all,
      done_months: w.n - 1, count: items.length, items };
    // 응답이 수 MB(전 카탈로그) → 브라우저가 gzip 을 받으면 압축해서 보낸다(Node 내장 zlib · 새 의존성 없음).
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      return reply.header('Content-Encoding', 'gzip').header('Vary', 'Accept-Encoding')
        .type('application/json; charset=utf-8').send(gzipSync(Buffer.from(JSON.stringify(body)), { level: 6 }));
    }
    return body;
  });

  // 상세: 한 SKU — 월별(판매·못 판 수량) · 고객별 · 인보이스 · L/R 짝.
  app.get('/api/salestrend/:productId', gate, async (req, reply) => {
    const pid = Number(req.params.productId);
    if (!pid) return reply.code(400).send({ error: 'bad_id' });
    const w = windowFor(req.query.months);
    const lead = numParam(req.query.lead, DEFAULT_LEAD, 1, 12);
    const safe = numParam(req.query.safe, DEFAULT_SAFE, 0, 6);
    const prod = (await query(
      `SELECT p.id, p.code, p.name, p.app, p.stock_qty,
              COALESCE(bo.backorder_qty,0) AS backorder_qty,
              COALESCE(inc.incoming_qty,0) AS incoming_qty, inc.incoming_eta::text AS incoming_eta
         FROM products p
         LEFT JOIN v_backorder bo ON bo.product_id = p.id
         LEFT JOIN v_incoming_stock inc ON inc.product_id = p.id
        WHERE p.id = $1`, [pid])).rows[0];
    if (!prod) return reply.code(404).send({ error: 'not_found' });

    const one = async (id, p) => {
      const [s, l, f] = await Promise.all([
        query(`SELECT * FROM (${SQL_SALES}) x WHERE x.product_id = $3`, [w.from, w.to, id]),
        query(`SELECT * FROM (${SQL_LOST}) x WHERE x.product_id = $3`, [w.from, w.to, id]),
        query(`SELECT to_char(MIN(si.inv_date),'YYYY-MM') AS ym
                 FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil.invoice_id
                WHERE si.status = 'posted' AND si.deleted_at IS NULL AND sil.product_id = $1`, [id]),
      ]);
      const series = seriesMap(s.rows, w.months).get(id) || zeros(w.n);
      const lostS = seriesMap(l.rows, w.months).get(id) || zeros(w.n);
      const a = analyzeSku({ series, lostSeries: lostS, months: w.months, firstSaleYm: f.rows[0] ? f.rows[0].ym : null,
        curYm: w.curYm, stock: Number(p.stock_qty) || 0, backorder: Number(p.backorder_qty) || 0, lead, safe });
      return { series, lost: lostS, ...a };
    };
    const main = await one(pid, prod);

    const [cust, inv, syd] = await Promise.all([
      query(`SELECT c.id, c.name, SUM(sil.qty) AS qty, COUNT(DISTINCT si.id) AS inv_n,
                    to_char(MAX(si.inv_date),'YYYY-MM-DD') AS last_date
               FROM sales_invoice_lines sil
               JOIN sales_invoices si ON si.id = sil.invoice_id
               JOIN customers c ON c.id = si.customer_id
              WHERE si.status = 'posted' AND si.deleted_at IS NULL AND sil.product_id = $1
                AND si.inv_date >= $2::date AND si.inv_date <= $3::date
              GROUP BY c.id, c.name
              ORDER BY SUM(sil.qty) DESC, c.name`, [pid, w.from, w.to]),
      query(`SELECT si.id, to_char(si.inv_date,'YYYY-MM-DD') AS inv_date, si.sat_no, c.name AS customer_name,
                    SUM(sil.qty) AS qty, MAX(sil.unit_price) AS unit_price
               FROM sales_invoice_lines sil
               JOIN sales_invoices si ON si.id = sil.invoice_id
               JOIN customers c ON c.id = si.customer_id
              WHERE si.status = 'posted' AND si.deleted_at IS NULL AND sil.product_id = $1
                AND si.inv_date >= $2::date AND si.inv_date <= $3::date
              GROUP BY si.id, si.inv_date, si.sat_no, c.name
              ORDER BY si.inv_date DESC, si.id DESC
              LIMIT 300`, [pid, w.from, w.to]),
      query(`SELECT string_agg(syd_code, ' · ' ORDER BY syd_code) AS syd FROM product_syd_codes WHERE product_id = $1`, [pid]),
    ]);
    const tot = cust.rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);

    // L/R 짝 — 같은 차량에 같이 나가는 제품이라 판매·제안을 나란히 본다.
    let pair = null;
    const pc = pairCode(prod.code);
    if (pc) {
      const pp = (await query(
        `SELECT p.id, p.code, p.name, p.stock_qty, COALESCE(bo.backorder_qty,0) AS backorder_qty
           FROM products p LEFT JOIN v_backorder bo ON bo.product_id = p.id
          WHERE upper(p.code) = $1 AND p.deleted_at IS NULL`, [pc])).rows[0];
      if (pp) {
        const pa = await one(Number(pp.id), pp);
        pair = { product_id: Number(pp.id), code: pp.code, name: pp.name || '', stock: Number(pp.stock_qty) || 0,
          backorder: Number(pp.backorder_qty) || 0, total: pa.total, fc: pa.fc, type: pa.type, cover: pa.cover, suggest: pa.suggest };
      }
    }

    return {
      months: w.months, cur_ym: w.curYm, today: w.to, lead, safe,
      product: {
        id: Number(prod.id), code: prod.code, name: prod.name || '', app: prod.app || '', syd: syd.rows[0]?.syd || '',
        kind: partKind(prod.name, prod.code), stock: Number(prod.stock_qty) || 0, backorder: Number(prod.backorder_qty) || 0,
        incoming: Number(prod.incoming_qty) || 0, incoming_eta: prod.incoming_eta || null,
      },
      ...main,
      customers: cust.rows.map((r) => ({ id: Number(r.id), name: r.name, qty: Number(r.qty) || 0, inv_n: Number(r.inv_n) || 0,
        last_date: r.last_date, share: tot > 0 ? Math.round((Number(r.qty) / tot) * 1000) / 1000 : 0 })),
      invoices: inv.rows.map((r) => ({ id: Number(r.id), inv_date: r.inv_date, sat_no: r.sat_no || null,
        customer_name: r.customer_name, qty: Number(r.qty) || 0, unit_price: r.unit_price == null ? null : Number(r.unit_price) })),
      pair,
    };
  });
}
