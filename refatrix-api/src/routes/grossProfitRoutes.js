import { query } from '../db.js';
import { authGuard, requirePage } from '../middleware/authGuard.js';
import { logPageView } from '../audit.js';

// ── 매출총이익(SKU별 / 고객별) — 'grossprofit' 페이지 권한(디렉터 자동 우회) ────────────────────
// 가중평균 단일 풀 모델에서, 매출원가(COGS)는 판매 시점 스냅샷(sales_invoice_lines.cogs_mxn /
// applied_unit_cost)으로 동결돼 있다. 따라서 매출총이익은 게시(posted)·미삭제 인보이스 라인을
// (SKU별 또는 고객별로) 합산해 산출한다 — 이후 평균원가를 바꿔도 과거 매출총이익은 변하지 않는다.
//   매출(ex-IVA)  = Σ sil.line_amount_mxn
//   매출원가      = Σ COALESCE(sil.cogs_mxn, sil.qty*sil.applied_unit_cost, 0)
//   매출총이익    = 매출 − 매출원가
//   매출총이익률  = 매출총이익 / 매출 × 100   (매출 0이면 null = 판매없음)

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// 4단계 고정 구간 (판매된 대상[SKU/고객]이 빠짐없이 정확히 한 구간에 들어가도록 구성).
//   t1 우수: ≥21% / t2 양호: 10~20%(10≤m<21) / t3 주의: 0~9%(0≤m<10) / t4 손실: <0%
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

// ★ 파레토 상위 20%(매출총이익 금액 기준) — SKU/고객 공통 계산 헬퍼.
//   판매 대상을 매출총이익(금액) 내림차순으로 정렬해 상위 20%(개수)를 "핵심 소수(vital few)"로 본다.
//   share_pct = 그들이 전체 매출총이익에서 차지하는 비율(손실 대상이 있으면 100% 초과 가능).
export const PARETO_FRACTION = 0.20;
export function computePareto(soldItems, totalProfit) {
  const byProfit = soldItems.slice().sort((a, b) => b.profit - a.profit);
  const cut = byProfit.length ? Math.max(1, Math.ceil(byProfit.length * PARETO_FRACTION)) : 0;
  const arr = byProfit.slice(0, cut);
  const ids = arr.map((x) => x.id);
  const profit = r2(arr.reduce((s, x) => s + x.profit, 0));
  const share = totalProfit > 0 ? r2(profit / totalProfit * 100) : null;
  return {
    ids,
    set: new Set(ids),
    pareto: {
      fraction_pct: Math.round(PARETO_FRACTION * 100),
      count: cut,
      sku_total: soldItems.length,   // 파레토 모집단(판매된 대상) 개수
      profit,
      total_profit: totalProfit,
      share_pct: share,
    },
  };
}

// ══════════ P&L 확장(공헌이익): 커미션 + 매출출고 운반비 ══════════
// 손익 뷰 원칙(디렉터 확정 2026-07-25):
//   · 커미션 인식 시점 = 인보이스 발행 월(수익-비용 대응). 지급 여부 무관, 이미 지급된 건은 지급액으로 동결.
//   · 매출출고 운반비(6160) = 거래등록의 고객 태그分은 그 고객 직접 귀속,
//     미태그分은 기간 매출 비중으로 자동 배분. 실제(actual)·승인(approved) 지출만 집계.
//   · 공헌이익 = 매출총이익 − 커미션 − 운반비.
const FREIGHT_OUT_CODE = '6160';

// ══════════ 기간 필터 (2026-08-21 확장) ══════════
// 3가지를 서로 AND로 조합한다.
//   · from/to    : 달력에서 직접 고른 시작일~종료일 (YYYY-MM-DD)
//   · years=..   : 다중 연도 토글 (예: years=2025,2026)
//   · months=..  : 다중 월 토글  (예: months=1,2,12 → 매년 1·2·12월만)
// years/months 는 중복 선택 가능하며, 둘 다 주면 "선택 연도들 × 선택 월들" 교집합이 된다.

// 순수: "1,2,12" 같은 CSV를 검증된 정수 배열(중복 제거·오름차순)로. 범위 밖/비정수는 버린다.
export function parseIntList(raw, min, max) {
  const out = [];
  for (const s of String(raw == null ? '' : raw).split(',')) {
    const t = s.trim();
    if (!/^\d{1,4}$/.test(t)) continue;
    const n = Number(t);
    if (n < min || n > max) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

// 순수: 검증된 정수 배열 → to_char 비교 조건 조각. 값은 이미 정수로 검증돼 인젝션 위험 없음.
export function ymConds(col, p) {
  const c = [];
  if (p.years && p.years.length) {
    c.push(`EXTRACT(YEAR FROM ${col}) IN (${p.years.map((y) => String(Number(y))).join(',')})`);
  }
  if (p.months && p.months.length) {
    c.push(`EXTRACT(MONTH FROM ${col}) IN (${p.months.map((m) => String(Number(m))).join(',')})`);
  }
  return c;
}

function dateRange(req) {
  const from = (req.query.from || '').trim();
  const to = (req.query.to || '').trim();
  return {
    from: /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null,
    to: /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : null,
    years: parseIntList(req.query.years, 1900, 2999),
    months: parseIntList(req.query.months, 1, 12),
  };
}

// 인보이스별 커미션(발행 월 인식). 요율 = 고객 예외율 우선, 없으면 기간율(0143).
// 이미 지급된 건은 지급 시점 금액(commission_payouts.amount)으로 동결(commissionRoutes와 동일 원칙).
async function commissionRows(range) {
  const params = [];
  let where = '';
  if (range.from) { params.push(range.from); where += ` AND i.inv_date >= $${params.length}`; }
  if (range.to)   { params.push(range.to);   where += ` AND i.inv_date <= $${params.length}`; }
  for (const c of ymConds('i.inv_date', range)) where += ` AND ${c}`;
  const rows = (await query(
    `SELECT i.customer_id, to_char(i.inv_date,'YYYY-MM') AS ym, i.subtotal_mxn,
            per.rate AS period_rate, ccr.rate AS cust_rate,
            cp.paid AS payout_paid, cp.amount AS payout_amount
       FROM sales_invoices i
       JOIN commission_agents ca ON ca.user_id = i.owner_id AND ca.active = true
       LEFT JOIN commission_customer_rates ccr ON ccr.user_id = i.owner_id AND ccr.customer_id = i.customer_id
       LEFT JOIN LATERAL (
         SELECT cap.rate FROM commission_agent_periods cap
          WHERE cap.user_id = i.owner_id AND i.inv_date >= cap.start_date
            AND (cap.end_date IS NULL OR i.inv_date <= cap.end_date)
          ORDER BY cap.start_date DESC LIMIT 1) per ON true
       LEFT JOIN commission_payouts cp ON cp.invoice_id = i.id
      WHERE i.status = 'posted' AND i.deleted_at IS NULL AND per.rate IS NOT NULL${where}`, params)).rows;
  return rows.map((r) => ({
    customer_id: Number(r.customer_id),
    ym: r.ym,
    amount: (r.payout_paid === true && r.payout_amount != null)
      ? Number(r.payout_amount)
      : r2(Number(r.subtotal_mxn) * Number(r.cust_rate != null ? r.cust_rate : r.period_rate) / 100),
  }));
}

// 매출출고 운반비(6160) — 실제·승인 지출만.
//   인보이스 배분행(transaction_freight_allocations)이 있는 거래는 배분행 기준(인보이스별 균등분 → 고객),
//   없는 거래는 거래의 customer_id 기준(NULL = 미태그·공통 → 매출비중 배분).
async function freightRows(range) {
  const params = [FREIGHT_OUT_CODE];
  let where = '';
  if (range.from) { params.push(range.from); where += ` AND t.txn_date >= $${params.length}`; }
  if (range.to)   { params.push(range.to);   where += ` AND t.txn_date <= $${params.length}`; }
  for (const c of ymConds('t.txn_date', range)) where += ` AND ${c}`;
  const base = `t.deleted_at IS NULL AND t.status = 'actual' AND t.direction = 'out'
        AND t.approved = true AND t.category_code = $1${where}`;
  const rows = (await query(
    `SELECT x.customer_id, x.ym, SUM(x.amt) AS amt FROM (
       SELECT a.customer_id, to_char(t.txn_date,'YYYY-MM') AS ym, a.amount_mxn AS amt
         FROM transaction_freight_allocations a
         JOIN transactions t ON t.id = a.transaction_id
        WHERE ${base}
       UNION ALL
       SELECT t.customer_id, to_char(t.txn_date,'YYYY-MM') AS ym, t.amount_mxn AS amt
         FROM transactions t
        WHERE ${base}
          AND NOT EXISTS (SELECT 1 FROM transaction_freight_allocations a WHERE a.transaction_id = t.id)
     ) x
     GROUP BY x.customer_id, x.ym`, params)).rows;
  return rows.map((r) => ({
    customer_id: r.customer_id == null ? null : Number(r.customer_id),
    ym: r.ym,
    amount: Number(r.amt),
  }));
}

// 순수: 항목 배열(각 {id, revenue, profit})에 커미션·운반비·공헌이익을 부여한다.
//   keyOf(row) → 항목 id 매핑 함수(고객별=customer_id, 팀별=팀 id 변환).
//   미태그 운반비는 매출 비중으로 배분. 항목에 없는 키의 잔여분은 leftover로 반환.
export function applyPnl(items, commRows, frRows, keyOf) {
  const kf = keyOf || ((r) => r.customer_id);
  const comm = new Map();
  const direct = new Map();
  let untagged = 0;
  for (const c of commRows) {
    const k = kf(c);
    comm.set(k, r2((comm.get(k) || 0) + c.amount));
  }
  for (const f of frRows) {
    const k = f.customer_id == null ? null : kf(f);
    if (k == null) untagged = r2(untagged + f.amount);
    else direct.set(k, r2((direct.get(k) || 0) + f.amount));
  }
  const totalRevenue = items.reduce((s, x) => s + x.revenue, 0);
  for (const it of items) {
    it.commission = comm.get(it.id) || 0;
    it.freight_direct = direct.get(it.id) || 0;
    it.freight_alloc = (untagged > 0 && totalRevenue > 0) ? r2(untagged * it.revenue / totalRevenue) : 0;
    it.freight = r2(it.freight_direct + it.freight_alloc);
    it.contribution = r2(it.profit - it.commission - it.freight);
    it.contrib_pct = it.revenue > 0 ? r2(it.contribution / it.revenue * 100) : null;
    comm.delete(it.id); direct.delete(it.id);
  }
  return { untagged, leftoverComm: comm, leftoverFreight: direct, totalRevenue };
}

// 순수: P&L 합계(항목 + 미배분 잔여 포함)
export function pnlTotals(items, pn) {
  const commission = r2(items.reduce((s, x) => s + (x.commission || 0), 0)
    + [...pn.leftoverComm.values()].reduce((s, v) => s + v, 0));
  const freight = r2(items.reduce((s, x) => s + (x.freight || 0), 0)
    + [...pn.leftoverFreight.values()].reduce((s, v) => s + v, 0)
    + (pn.totalRevenue > 0 ? 0 : pn.untagged));   // 매출 0인 기간엔 미태그분 배분 불가 → 합계에만 포함
  return { commission, freight };
}

// 요청의 from/to(YYYY-MM-DD) + years/months 를 파라미터 배열에 이어 붙여 WHERE 절 조각을 만든다.
function buildDateWhere(req, params) {
  const p = dateRange(req);
  const conds = [];
  if (p.from) { params.push(p.from); conds.push(`si.inv_date >= $${params.length}`); }
  if (p.to)   { params.push(p.to);   conds.push(`si.inv_date <= $${params.length}`); }
  for (const c of ymConds('si.inv_date', p)) conds.push(c);
  return conds.length ? ' AND ' + conds.join(' AND ') : '';
}

export default async function grossProfitRoutes(app) {
  // ── SKU별 매출총이익 전체(자재내역) + 4단계 요약 + (정렬된) 곡선 데이터 ─────────────────────────
  // 옵션: ?from=YYYY-MM-DD&to=YYYY-MM-DD&years=2025,2026&months=1,2 (inv_date 기준). 미지정 시 전체 기간.
  app.get('/api/gross-profit', { preHandler: [authGuard, requirePage('grossprofit')] }, async (req) => {
    const { perm } = req.ctx;
    const params = [];
    const dateWhere = buildDateWhere(req, params);

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

    const P = computePareto(sold, totalProfit);

    await logPageView(perm.userId, 'grossprofit');
    return {
      items,
      sold_count: sold.length,
      summary,
      tiers: GP_TIERS.map((t) => ({ key: t.key, label: t.label })),
      important_ids: P.ids,
      pareto: P.pareto,
      curve: sold.map((x, i) => ({
        rank: i + 1, id: x.id, code: x.code, name: x.name, app: x.app, scode: x.scode,
        margin_pct: x.margin_pct, profit: x.profit, revenue: x.revenue,
        tier: tierOf(x.margin_pct), important: P.set.has(x.id),
      })),
      totals: { revenue: totalRevenue, cogs: totalCogs, profit: totalProfit,
        margin_pct: totalRevenue > 0 ? r2(totalProfit / totalRevenue * 100) : null },
    };
  });

  // ── SKU 드릴다운(자재내역 행 펼치기) — 한 SKU의 판매처(고객)별 내역 ─────────────────────────────
  app.get('/api/gross-profit/sku/:id', { preHandler: [authGuard, requirePage('grossprofit')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_product' });

    const prod = (await query(
      `SELECT id, code, scode, app, name, stock_qty FROM products WHERE id=$1 AND deleted_at IS NULL`, [id]
    )).rows[0];
    if (!prod) return reply.code(404).send({ error: 'not_found' });

    const params = [id];
    const dateWhere = buildDateWhere(req, params);

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

  // ── 고객별 매출총이익 전체(거래 고객) + 4단계 요약 + 파레토 ───────────────────────────────────
  // 각 고객이 산 모든 제품을 합산해 고객 단위 매출/원가/매출총이익/이익률을 낸다.
  // 판매 기록이 있는 고객만 나온다(게시·미삭제 인보이스 기준). 옵션: ?from=&to= (inv_date).
  app.get('/api/gross-profit/by-customer', { preHandler: [authGuard, requirePage('grossprofit')] }, async (req) => {
    const { perm } = req.ctx;
    const params = [];
    const dateWhere = buildDateWhere(req, params);

    const rows = (await query(
      `SELECT cu.id, cu.name,
              SUM(sil.qty)                                                    AS qty,
              COUNT(DISTINCT si.id)                                           AS inv_count,
              COUNT(DISTINCT sil.product_id)                                  AS sku_count,
              SUM(sil.line_amount_mxn)                                        AS revenue,
              SUM(COALESCE(sil.cogs_mxn, sil.qty * sil.applied_unit_cost, 0)) AS cogs,
              MAX(si.inv_date)                                                AS last_date
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id = sil.invoice_id
         JOIN customers cu ON cu.id = si.customer_id
        WHERE si.status = 'posted' AND si.deleted_at IS NULL${dateWhere}
        GROUP BY cu.id, cu.name
        ORDER BY SUM(sil.line_amount_mxn) DESC, cu.name ASC`, params)).rows;

    const items = rows.map((c) => {
      const qty = Number(c.qty), revenue = r2(Number(c.revenue)), cogs = r2(Number(c.cogs));
      const profit = r2(revenue - cogs);
      const invc = Number(c.inv_count || 0);
      return {
        id: Number(c.id),
        name: c.name,
        qty,
        inv_count: invc,
        sku_count: Number(c.sku_count || 0),
        revenue, cogs, profit,
        margin_pct: revenue > 0 ? r2(profit / revenue * 100) : null,
        avg_ticket: invc > 0 ? r2(revenue / invc) : null,   // 거래 1건당 평균 매출
        last_date: c.last_date ? String(c.last_date).slice(0, 10) : null,
      };
    });

    // ── P&L 확장: 커미션(발행 월) + 매출출고 운반비(태그 직접 귀속 / 미태그 매출비중 배분) ──
    const range = dateRange(req);
    const [commR, frR] = await Promise.all([commissionRows(range), freightRows(range)]);
    const pn = applyPnl(items, commR, frR);
    // 이 기간 매출이 없는 고객에 태그된 운반비/커미션 → 0매출 행으로 추가(비용 누락 방지).
    const leftoverIds = [...new Set([...pn.leftoverComm.keys(), ...pn.leftoverFreight.keys()])];
    if (leftoverIds.length) {
      const nm = (await query(`SELECT id, name FROM customers WHERE id = ANY($1)`, [leftoverIds])).rows;
      const nameOf = new Map(nm.map((x) => [Number(x.id), x.name]));
      for (const id of leftoverIds) {
        const cAmt = pn.leftoverComm.get(id) || 0;
        const fAmt = pn.leftoverFreight.get(id) || 0;
        items.push({
          id, name: nameOf.get(id) || ('고객#' + id),
          qty: 0, inv_count: 0, sku_count: 0, revenue: 0, cogs: 0, profit: 0,
          margin_pct: null, avg_ticket: null, last_date: null,
          commission: cAmt, freight_direct: fAmt, freight_alloc: 0, freight: fAmt,
          contribution: r2(-(cAmt + fAmt)), contrib_pct: null,
        });
      }
    }

    const summary = summarizeTiers(items);
    const totalRevenue = r2(items.reduce((s, x) => s + x.revenue, 0));
    const totalCogs = r2(items.reduce((s, x) => s + x.cogs, 0));
    const totalProfit = r2(totalRevenue - totalCogs);
    const sold = items.filter((x) => x.margin_pct != null);
    const P = computePareto(sold, totalProfit);
    const ex = pnlTotals(items, pn);
    const totalContribution = r2(totalProfit - ex.commission - ex.freight);

    await logPageView(perm.userId, 'grossprofit');
    return {
      items,
      cust_count: items.length,
      sold_count: sold.length,
      summary,
      tiers: GP_TIERS.map((t) => ({ key: t.key, label: t.label })),
      important_ids: P.ids,
      pareto: P.pareto,
      totals: { revenue: totalRevenue, cogs: totalCogs, profit: totalProfit,
        margin_pct: totalRevenue > 0 ? r2(totalProfit / totalRevenue * 100) : null,
        commission: ex.commission, freight: ex.freight, freight_untagged: pn.untagged,
        contribution: totalContribution,
        contrib_pct: totalRevenue > 0 ? r2(totalContribution / totalRevenue * 100) : null },
    };
  });

  // ── 고객 드릴다운(고객 행 펼치기) — 한 고객이 산 SKU별 내역 ────────────────────────────────────
  app.get('/api/gross-profit/customer/:id', { preHandler: [authGuard, requirePage('grossprofit')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!id) return reply.code(400).send({ error: 'bad_customer' });

    const cust = (await query(`SELECT id, name FROM customers WHERE id=$1`, [id])).rows[0];
    if (!cust) return reply.code(404).send({ error: 'not_found' });

    const params = [id];
    const dateWhere = buildDateWhere(req, params);

    // SKU별 — 게시·미삭제 인보이스만. 매출원가는 판매 시점 동결 스냅샷.
    const rows = (await query(
      `SELECT p.id, p.code, p.scode, p.app, p.name,
              SUM(sil.qty)                                                    AS qty,
              COUNT(DISTINCT si.id)                                           AS inv_count,
              SUM(sil.line_amount_mxn)                                        AS revenue,
              SUM(COALESCE(sil.cogs_mxn, sil.qty * sil.applied_unit_cost, 0)) AS cogs,
              MAX(si.inv_date)                                                AS last_date
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id = sil.invoice_id
         JOIN products p ON p.id = sil.product_id
        WHERE si.customer_id = $1 AND si.status = 'posted' AND si.deleted_at IS NULL${dateWhere}
        GROUP BY p.id, p.code, p.scode, p.app, p.name
        ORDER BY SUM(sil.line_amount_mxn) DESC, p.code ASC`, params)).rows;

    const bySku = rows.map((p) => {
      const qty = Number(p.qty), revenue = r2(Number(p.revenue)), cogs = r2(Number(p.cogs));
      const profit = r2(revenue - cogs);
      return {
        code: p.code, scode: p.scode || null, app: p.app || null, name: p.name,
        qty, inv_count: Number(p.inv_count || 0),
        revenue, cogs, profit,
        margin_pct: revenue > 0 ? r2(profit / revenue * 100) : null,
        avg_price: qty > 0 ? r2(revenue / qty) : null,
        last_date: p.last_date ? String(p.last_date).slice(0, 10) : null,
      };
    });

    const tQty = bySku.reduce((s, x) => s + x.qty, 0);
    const tRev = r2(bySku.reduce((s, x) => s + x.revenue, 0));
    const tCogs = r2(bySku.reduce((s, x) => s + x.cogs, 0));
    const tProfit = r2(tRev - tCogs);

    return {
      customer: { id: Number(cust.id), name: cust.name },
      by_sku: bySku,
      sku_count: bySku.length,
      total: {
        qty: tQty, revenue: tRev, cogs: tCogs, profit: tProfit,
        margin_pct: tRev > 0 ? r2(tProfit / tRev * 100) : null,
      },
      note: '매출원가(COGS)는 판매 시점에 동결된 적용원가 기준입니다.',
    };
  });

  // ── 팀별 손익 — 고객 소속 팀(customers.team_id, 0030 방식 A) 기준 합산 ─────────────────────────
  //   매출/원가 = 게시 인보이스 라인, 커미션 = 발행 월 인식, 운반비 = 태그 직접 + 미태그 매출비중 배분.
  app.get('/api/gross-profit/by-team', { preHandler: [authGuard, requirePage('grossprofit')] }, async (req) => {
    const { perm } = req.ctx;
    const params = [];
    const dateWhere = buildDateWhere(req, params);

    const rows = (await query(
      `SELECT COALESCE(st.id, 0) AS team_id, COALESCE(st.name, '미지정') AS team_name,
              COUNT(DISTINCT cu.id)                                           AS cust_count,
              COUNT(DISTINCT si.id)                                           AS inv_count,
              SUM(sil.line_amount_mxn)                                        AS revenue,
              SUM(COALESCE(sil.cogs_mxn, sil.qty * sil.applied_unit_cost, 0)) AS cogs
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id = sil.invoice_id
         JOIN customers cu ON cu.id = si.customer_id
         LEFT JOIN sales_teams st ON st.id = cu.team_id
        WHERE si.status = 'posted' AND si.deleted_at IS NULL${dateWhere}
        GROUP BY COALESCE(st.id, 0), COALESCE(st.name, '미지정')
        ORDER BY SUM(sil.line_amount_mxn) DESC`, params)).rows;

    const items = rows.map((t) => {
      const revenue = r2(Number(t.revenue)), cogs = r2(Number(t.cogs));
      const profit = r2(revenue - cogs);
      return {
        id: Number(t.team_id), name: t.team_name,
        cust_count: Number(t.cust_count || 0), inv_count: Number(t.inv_count || 0),
        revenue, cogs, profit,
        margin_pct: revenue > 0 ? r2(profit / revenue * 100) : null,
      };
    });

    // 고객 → 팀 매핑(운반비 태그·커미션을 팀으로 접는 키)
    const cuTeam = new Map((await query(
      `SELECT id, COALESCE(team_id, 0) AS tid FROM customers`)).rows
      .map((x) => [Number(x.id), Number(x.tid)]));
    const range = dateRange(req);
    const [commR, frR] = await Promise.all([commissionRows(range), freightRows(range)]);
    const pn = applyPnl(items, commR, frR, (r) => (cuTeam.has(r.customer_id) ? cuTeam.get(r.customer_id) : 0));
    // 매출 없는 팀에 태그된 잔여분 → 0매출 행 추가
    const leftIds = [...new Set([...pn.leftoverComm.keys(), ...pn.leftoverFreight.keys()])];
    if (leftIds.length) {
      const tn = new Map((await query(`SELECT id, name FROM sales_teams`)).rows.map((x) => [Number(x.id), x.name]));
      tn.set(0, '미지정');
      for (const id of leftIds) {
        const cAmt = pn.leftoverComm.get(id) || 0;
        const fAmt = pn.leftoverFreight.get(id) || 0;
        items.push({
          id, name: tn.get(id) || ('팀#' + id), cust_count: 0, inv_count: 0,
          revenue: 0, cogs: 0, profit: 0, margin_pct: null,
          commission: cAmt, freight_direct: fAmt, freight_alloc: 0, freight: fAmt,
          contribution: r2(-(cAmt + fAmt)), contrib_pct: null,
        });
      }
    }

    const totalRevenue = r2(items.reduce((s, x) => s + x.revenue, 0));
    const totalCogs = r2(items.reduce((s, x) => s + x.cogs, 0));
    const totalProfit = r2(totalRevenue - totalCogs);
    const ex = pnlTotals(items, pn);
    const totalContribution = r2(totalProfit - ex.commission - ex.freight);

    await logPageView(perm.userId, 'grossprofit');
    return {
      items,
      team_count: items.length,
      totals: { revenue: totalRevenue, cogs: totalCogs, profit: totalProfit,
        margin_pct: totalRevenue > 0 ? r2(totalProfit / totalRevenue * 100) : null,
        commission: ex.commission, freight: ex.freight, freight_untagged: pn.untagged,
        contribution: totalContribution,
        contrib_pct: totalRevenue > 0 ? r2(totalContribution / totalRevenue * 100) : null },
      note: '커미션=인보이스 발행 월 인식 · 운반비=태그 직접 귀속+미태그 매출비중 배분 · 팀=고객 소속 팀',
    };
  });

  // ── 월별 손익 추이 — 매출/원가(inv_date 월) · 커미션(발행 월) · 운반비(지출 월) ────────────────
  app.get('/api/gross-profit/by-month', { preHandler: [authGuard, requirePage('grossprofit')] }, async (req) => {
    const { perm } = req.ctx;
    const params = [];
    const dateWhere = buildDateWhere(req, params);

    const revRows = (await query(
      `SELECT to_char(si.inv_date,'YYYY-MM') AS ym,
              COUNT(DISTINCT si.id)                                           AS inv_count,
              SUM(sil.line_amount_mxn)                                        AS revenue,
              SUM(COALESCE(sil.cogs_mxn, sil.qty * sil.applied_unit_cost, 0)) AS cogs
         FROM sales_invoice_lines sil
         JOIN sales_invoices si ON si.id = sil.invoice_id
        WHERE si.status = 'posted' AND si.deleted_at IS NULL${dateWhere}
        GROUP BY to_char(si.inv_date,'YYYY-MM')`, params)).rows;

    const range = dateRange(req);
    const [commR, frR] = await Promise.all([commissionRows(range), freightRows(range)]);

    const byYm = new Map();
    const ensure = (ym) => {
      if (!byYm.has(ym)) byYm.set(ym, { ym, inv_count: 0, revenue: 0, cogs: 0, commission: 0, freight: 0 });
      return byYm.get(ym);
    };
    for (const rrow of revRows) {
      const m = ensure(rrow.ym);
      m.inv_count = Number(rrow.inv_count || 0);
      m.revenue = r2(Number(rrow.revenue));
      m.cogs = r2(Number(rrow.cogs));
    }
    for (const c of commR) { const m = ensure(c.ym); m.commission = r2(m.commission + c.amount); }
    for (const f of frR)   { const m = ensure(f.ym); m.freight = r2(m.freight + f.amount); }

    const items = [...byYm.values()].sort((a, b) => (a.ym > b.ym ? 1 : -1)).map((m) => {
      const profit = r2(m.revenue - m.cogs);
      const contribution = r2(profit - m.commission - m.freight);
      return {
        ...m, profit,
        margin_pct: m.revenue > 0 ? r2(profit / m.revenue * 100) : null,
        contribution,
        contrib_pct: m.revenue > 0 ? r2(contribution / m.revenue * 100) : null,
      };
    });

    const totalRevenue = r2(items.reduce((s, x) => s + x.revenue, 0));
    const totalCogs = r2(items.reduce((s, x) => s + x.cogs, 0));
    const totalProfit = r2(totalRevenue - totalCogs);
    const totalComm = r2(items.reduce((s, x) => s + x.commission, 0));
    const totalFreight = r2(items.reduce((s, x) => s + x.freight, 0));
    const totalContribution = r2(totalProfit - totalComm - totalFreight);

    await logPageView(perm.userId, 'grossprofit');
    return {
      items,
      month_count: items.length,
      totals: { revenue: totalRevenue, cogs: totalCogs, profit: totalProfit,
        margin_pct: totalRevenue > 0 ? r2(totalProfit / totalRevenue * 100) : null,
        commission: totalComm, freight: totalFreight, contribution: totalContribution,
        contrib_pct: totalRevenue > 0 ? r2(totalContribution / totalRevenue * 100) : null },
      note: '매출·원가=인보이스 발행 월 · 커미션=발행 월 인식 · 운반비=실제 지출 월(태그·미태그 모두 포함)',
    };
  });
}
