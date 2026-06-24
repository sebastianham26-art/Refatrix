import { query } from '../db.js';
import { authGuard, requirePage } from '../middleware/authGuard.js';
import { logPageView } from '../audit.js';

// ── 매출총이익(SKU별) — 'grossprofit' 페이지 권한(디렉터 자동 우회) ────────────────────────────────────────────
// 가중평균 단일 풀 모델에서, 매출원가(COGS)는 판매 시점 스냅샷(sales_invoice_lines.cogs_mxn /
// applied_unit_cost)으로 동결돼 있다. 따라서 SKU별 매출총이익은 게시(posted)·미삭제 인보이스
// 라인을 제품별로 합산해 산출한다 — 이후 평균원가를 바꿔도 과거 매출총이익은 변하지 않는다.
//   매출(ex-IVA)  = Σ sil.line_amount_mxn
//   매출원가      = Σ COALESCE(sil.cogs_mxn, sil.qty*sil.applied_unit_cost, 0)
//   매출총이익    = 매출 − 매출원가
//   매출총이익률  = 매출총이익 / 매출 × 100   (매출 0이면 null = 판매없음)

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// 4단계 고정 구간 (모든 "판매된" SKU가 빠짐없이 정확히 한 구간에 들어가도록 구성).
//   t1 우수: ≥21% / t2 양호: 10~20%(10≤m<21) / t3 주의: 0~9%(0≤m<10) / t4 손실: <0%
// (스펙의 "-1% 미만"은 -1~0% 구간이 비어 합계가 안 맞으므로 손실 구간을 0% 미만으로 닫음.)
export const GP_TIERS = [
  { key: 't1', label: '21% 이상',  min: 21,        max: Infinity },
  { key: 't2', label: '10%~20%',   min: 10,        max: 21 },
  { key: 't3', label: '0%~9%',     min: 0,         max: 10 },
  { key: 't4', label: '0% 미만',   min: -Infinity, max: 0 },
];
export function tierOf(marginPct) {
  if (marginPct == null) return null;               // 판매 없음 → 어느 카드에도 안 들어감
  for (const t of GP_TIERS) if (marginPct >= t.min && marginPct < t.max) return t.key;
  return null;
}

// 행 목록 → 4단계 카운트 + 판매없음 카운트
export function summarizeTiers(items) {
  const counts = { t1: 0, t2: 0, t3: 0, t4: 0, no_sales: 0 };
  for (const it of items) {
    if (it.margin_pct == null) { counts.no_sales++; continue; }
    const k = tierOf(it.margin_pct);
    if (k) counts[k]++;
  }
  return counts;
}

export default async function grossProfitRoutes(app) {
  // SKU별 매출총이익 전체(자재내역) + 4단계 요약 + (정렬된) 곡선 데이터.
  // 옵션: ?from=YYYY-MM-DD&to=YYYY-MM-DD (inv_date 기준 기간 한정). 미지정 시 전체 기간.
  app.get('/api/gross-profit', { preHandler: [authGuard, requirePage('grossprofit')] }, async (req) => {
    const { perm } = req.ctx;
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();

    const dateConds = [];
    const params = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { params.push(from); dateConds.push(`si.inv_date >= $${params.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to))   { params.push(to);   dateConds.push(`si.inv_date <= $${params.length}`); }
    const dateWhere = dateConds.length ? ' AND ' + dateConds.join(' AND ') : '';

    // 모든 제품을 가져오되(자재내역 전부), 판매 집계는 LEFT JOIN(판매 없는 SKU도 표시).
    const rows = (await query(
      `SELECT p.id, p.code, p.scode, p.app, p.name, p.stock_qty,
              COALESCE(s.qty, 0)      AS sold_qty,
              COALESCE(s.revenue, 0)  AS revenue,
              COALESCE(s.cogs, 0)     AS cogs,
              COALESCE(s.inv_count,0) AS inv_count
         FROM products p
         LEFT JOIN (
           SELECT sil.product_id,
                  SUM(sil.qty)                                                     AS qty,
                  SUM(sil.line_amount_mxn)                                         AS revenue,
                  SUM(COALESCE(sil.cogs_mxn, sil.qty * sil.applied_unit_cost, 0))  AS cogs,
                  COUNT(DISTINCT si.id)                                            AS inv_count
             FROM sales_invoice_lines sil
             JOIN sales_invoices si ON si.id = sil.invoice_id
            WHERE si.status = 'posted' AND si.deleted_at IS NULL${dateWhere}
            GROUP BY sil.product_id
         ) s ON s.product_id = p.id
        WHERE p.deleted_at IS NULL
        ORDER BY p.code ASC`, params)).rows;

    // node-pg는 NUMERIC/BIGINT를 문자열로 반환 → 모두 Number()로 정규화.
    const items = rows.map((p) => {
      const sold = Number(p.sold_qty);
      const revenue = r2(Number(p.revenue));
      const cogs = r2(Number(p.cogs));
      const profit = r2(revenue - cogs);
      const hasSale = sold > 0 && revenue > 0;
      return {
        id: Number(p.id),
        code: p.code,
        scode: p.scode || null,
        app: p.app || null,
        name: p.name,
        stock_qty: Number(p.stock_qty || 0),
        sold_qty: sold,
        inv_count: Number(p.inv_count || 0),
        revenue, cogs, profit,
        margin_pct: hasSale ? r2(profit / revenue * 100) : null,
      };
    });

    const summary = summarizeTiers(items);

    // 곡선용(판매된 SKU만, 이익률 높은→낮은 순) — 프런트는 이걸 그대로 그려 우하향 곡선을 만든다.
    const sold = items.filter((x) => x.margin_pct != null)
      .sort((a, b) => b.margin_pct - a.margin_pct || b.profit - a.profit);

    const totalRevenue = r2(items.reduce((s, x) => s + x.revenue, 0));
    const totalCogs = r2(items.reduce((s, x) => s + x.cogs, 0));
    const totalProfit = r2(totalRevenue - totalCogs);

    // ★ 중요 = 파레토 상위 20%: 판매 SKU를 매출총이익(금액) 내림차순으로 정렬해 상위 20%(개수).
    //   = 전체 매출총이익에서 가장 큰 비율을 차지하는 "핵심 소수(vital few)".
    const PARETO_FRACTION = 0.20;
    const byProfit = sold.slice().sort((a, b) => b.profit - a.profit);
    const cut = byProfit.length ? Math.max(1, Math.ceil(byProfit.length * PARETO_FRACTION)) : 0;
    const importantArr = byProfit.slice(0, cut);
    const importantIds = importantArr.map((x) => x.id);
    const importantSet = new Set(importantIds);
    const importantProfit = r2(importantArr.reduce((s, x) => s + x.profit, 0));
    const paretoSharePct = totalProfit > 0 ? r2(importantProfit / totalProfit * 100) : null;

    await logPageView(perm.userId, 'grossprofit');
    return {
      items,
      sold_count: sold.length,
      summary,
      tiers: GP_TIERS.map((t) => ({ key: t.key, label: t.label })),
      important_ids: importantIds,
      // 파레토 요약: 상위 20% SKU 개수 + 그들이 전체 매출총이익에서 차지하는 비율
      pareto: {
        fraction_pct: Math.round(PARETO_FRACTION * 100),
        count: cut,
        sku_total: sold.length,
        profit: importantProfit,
        total_profit: totalProfit,
        share_pct: paretoSharePct,
      },
      curve: sold.map((x, i) => ({
        rank: i + 1, id: x.id, code: x.code, name: x.name, app: x.app, scode: x.scode,
        margin_pct: x.margin_pct, profit: x.profit, revenue: x.revenue,
        tier: tierOf(x.margin_pct), important: importantSet.has(x.id),
      })),
      totals: { revenue: totalRevenue, cogs: totalCogs, profit: totalProfit,
        margin_pct: totalRevenue > 0 ? r2(totalProfit / totalRevenue * 100) : null },
    };
  });

  // ── SKU 드릴다운(자재내역 행 펼치기) — 디렉터 전용 ─────────────────────────────
  // 한 SKU의 ① 적용차종(전체) ② 판매처(고객)별 매출/원가/매출총이익/이익률을 반환.
  // 기간(from/to)은 자재내역 화면의 연도 토글과 동일하게 inv_date 기준으로 한정.
  app.get('/api/gross-profit/sku/:id', { preHandler: [authGuard, requirePage('grossprofit')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_product' });

    const prod = (await query(
      `SELECT id, code, scode, app, name, stock_qty FROM products WHERE id=$1 AND deleted_at IS NULL`, [id]
    )).rows[0];
    if (!prod) return reply.code(404).send({ error: 'not_found' });

    // 기간 필터 — 첫 파라미터가 product_id($1)이므로 날짜는 $2부터.
    const params = [id];
    const dateConds = [];
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { params.push(from); dateConds.push(`si.inv_date >= $${params.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to))   { params.push(to);   dateConds.push(`si.inv_date <= $${params.length}`); }
    const dateWhere = dateConds.length ? ' AND ' + dateConds.join(' AND ') : '';

    // 판매처(고객)별 — 게시·미삭제 인보이스만. 매출원가는 판매 시점 동결 스냅샷.
    const rows = (await query(
      `SELECT cu.name AS customer_name,
              SUM(sil.qty)                                                    AS qty,
              COUNT(DISTINCT si.id)                                           AS inv_count,
              SUM(sil.line_amount_mxn)                                        AS revenue,
              SUM(COALESCE(sil.cogs_mxn, sil.qty * sil.applied_unit_cost, 0)) AS cogs,
              MAX(si.inv_date)                                                AS last_date
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id = sil.invoice_id
         JOIN customers cu ON cu.id = si.customer_id
        WHERE sil.product_id = $1 AND si.status = 'posted' AND si.deleted_at IS NULL${dateWhere}
        GROUP BY cu.id, cu.name
        ORDER BY SUM(sil.line_amount_mxn) DESC, cu.name ASC`, params)).rows;

    const byCustomer = rows.map((c) => {
      const qty = Number(c.qty), revenue = r2(Number(c.revenue)), cogs = r2(Number(c.cogs));
      const profit = r2(revenue - cogs);
      return {
        customer_name: c.customer_name,
        qty, inv_count: Number(c.inv_count || 0),
        revenue, cogs, profit,
        margin_pct: revenue > 0 ? r2(profit / revenue * 100) : null,
        avg_price: qty > 0 ? r2(revenue / qty) : null,
        last_date: c.last_date ? String(c.last_date).slice(0, 10) : null,
      };
    });

    const tQty = byCustomer.reduce((s, x) => s + x.qty, 0);
    const tRev = r2(byCustomer.reduce((s, x) => s + x.revenue, 0));
    const tCogs = r2(byCustomer.reduce((s, x) => s + x.cogs, 0));
    const tProfit = r2(tRev - tCogs);

    return {
      product: {
        id: Number(prod.id), code: prod.code, scode: prod.scode || null,
        app: prod.app || null, name: prod.name, stock_qty: Number(prod.stock_qty || 0),
      },
      by_customer: byCustomer,
      customer_count: byCustomer.length,
      total: {
        qty: tQty, revenue: tRev, cogs: tCogs, profit: tProfit,
        margin_pct: tRev > 0 ? r2(tProfit / tRev * 100) : null,
      },
      note: '매출원가(COGS)는 판매 시점에 동결된 적용원가 기준입니다.',
    };
  });
}
