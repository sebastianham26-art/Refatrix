import { query } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { visibleTeamIds } from '../teams.js';
import { fieldVisible } from '../permissions.js';

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  if (dx === 0 || dy === 0) return null;
  return r2(num / Math.sqrt(dx * dy));
}
// 월의 주차 경계(일요일 시작, 월초/월말로 클램프)
function weeksOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  const out = [];
  let cur = new Date(first);
  cur.setUTCDate(cur.getUTCDate() - cur.getUTCDay()); // 일요일로 back
  let idx = 1;
  while (cur <= last) {
    const ws = new Date(cur), we = new Date(cur); we.setUTCDate(we.getUTCDate() + 6);
    const s = ws < first ? first : ws, e = we > last ? last : we;
    out.push({ label: idx + '주', start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) });
    cur.setUTCDate(cur.getUTCDate() + 7); idx++;
  }
  return out;
}
function prevYm(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); }

// 팀 가시성 조건
function teamArrOf(perm) { const vis = visibleTeamIds(perm); return vis === null ? null : (vis.length ? vis : [-1]); }

// 월 매출목표(전사 또는 팀 가시성 고객목표 합)
async function monthTargetOf(perm, ym) {
  const vis = visibleTeamIds(perm);
  if (vis === null) {
    const r = (await query(`SELECT COALESCE(amount,0) AS a FROM monthly_targets WHERE ym=$1`, [ym])).rows[0];
    let t = r ? Number(r.a) : 0;
    if (!t) t = Number((await query(`SELECT COALESCE(SUM(amount),0) AS a FROM target_customer_months WHERE ym=$1`, [ym])).rows[0].a);
    return t;
  }
  const ta = vis.length ? vis : [-1];
  return Number((await query(
    `SELECT COALESCE(SUM(m.amount),0) AS a FROM target_customer_months m JOIN customers c ON c.id=m.customer_id
      WHERE m.ym=$1 AND c.deleted_at IS NULL AND c.team_id = ANY($2)`, [ym, ta])).rows[0].a);
}
// 월 매출 실적(ex-IVA 소계, posted)
async function monthSalesActual(perm, ym) {
  const ta = teamArrOf(perm);
  let q = `SELECT COALESCE(SUM(i.subtotal_mxn),0) AS a FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
            WHERE i.status='posted' AND to_char(i.inv_date,'YYYY-MM')=$1 AND c.deleted_at IS NULL`;
  const p = [ym];
  if (ta) { p.push(ta); q += ` AND c.team_id = ANY($2)`; }
  return Number((await query(q, p)).rows[0].a);
}

export default async function salesPerfRoutes(app) {
  // 상단 요약 3카드 (ym는 콤마구분 다중 월 가능: 합산)
  app.get('/api/salesperf/summary', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const yms = String(req.query.ym || new Date().toISOString().slice(0, 7)).split(',').map((s) => s.trim()).filter(Boolean);
    const ta = teamArrOf(perm);
    const seeSales = fieldVisible(perm, 'sales_amount');
    const seeAr = fieldVisible(perm, 'ar_amount');
    const multi = yms.length > 1;

    // 카드1 매출목표 대비 실적(ex-IVA) — 선택 월 합산
    let target = 0, actual = 0, prevActual = 0;
    for (const ym of yms) { target += await monthTargetOf(perm, ym); actual += await monthSalesActual(perm, ym); }
    // 전월 대비는 단일 월일 때만
    if (!multi) prevActual = await monthSalesActual(perm, prevYm(yms[0]));
    const progress = target > 0 ? r2(actual / target * 100) : null;
    const momPct = multi ? null : (prevActual > 0 ? r2((actual - prevActual) / prevActual * 100) : (actual > 0 ? null : 0));

    // 카드2 수금: 선택 월들의 due/실적 합
    let collectPlan = 0, collectActual = 0;
    for (const ym of yms) {
      let pq = `SELECT COALESCE(SUM(i.total_mxn),0) AS a FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
                 WHERE i.status='posted' AND to_char(i.due_date,'YYYY-MM')=$1 AND c.deleted_at IS NULL`;
      const pp = [ym]; if (ta) { pp.push(ta); pq += ` AND c.team_id = ANY($2)`; }
      collectPlan += Number((await query(pq, pp)).rows[0].a);
      const cq = `SELECT COALESCE(SUM(t.amount_mxn),0) AS a FROM transactions t
                   WHERE t.status='actual' AND t.direction='in' AND to_char(t.txn_date,'YYYY-MM')=$1
                     AND (t.kind IN ('sales','invoice') OR t.sales_invoice_id IS NOT NULL)`;
      collectActual += Number((await query(cq, [ym])).rows[0].a);
    }
    const collectProgress = collectPlan > 0 ? r2(collectActual / collectPlan * 100) : null;

    // 카드3 고객 개발(제안=견적 / 협상) — 시점 기준(월 무관)
    let stq = `SELECT s.sort_order, COUNT(c.id) AS n
                 FROM stages s LEFT JOIN customers c ON c.stage_id=s.id AND c.deleted_at IS NULL`;
    const sp = [];
    if (ta) { sp.push(ta); stq += ` AND c.team_id = ANY($1)`; }
    stq += ` WHERE s.deleted_at IS NULL AND s.sort_order IN (30,40) GROUP BY s.sort_order`;
    const stRows = (await query(stq, sp)).rows;
    let proposal = 0, negotiation = 0;
    for (const r of stRows) { if (Number(r.sort_order) === 30) proposal = Number(r.n); else if (Number(r.sort_order) === 40) negotiation = Number(r.n); }

    return {
      yms, multi,
      sales: seeSales ? { actual: r2(actual), target: r2(target), progress, prevActual: r2(prevActual), momPct, locked: false }
                      : { progress, momPct, locked: true },
      collection: seeAr ? { actual: r2(collectActual), plan: r2(collectPlan), progress: collectProgress, locked: false }
                        : { progress: collectProgress, locked: true },
      pipeline_dev: { proposal, negotiation, total: proposal + negotiation },
      drilldown: perm.role === 'director' ? true : (perm.dashDrilldown !== false),
    };
  });

  // 주차별 매출 워터폴(일요일 시작, ex-IVA)
  app.get('/api/salesperf/weekly', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const yms = String(req.query.ym || new Date().toISOString().slice(0, 7)).split(',').map((s) => s.trim()).filter(Boolean).sort();
    const ta = teamArrOf(perm);
    const seeSales = fieldVisible(perm, 'sales_amount');
    const multi = yms.length > 1;

    let monthTarget = 0;
    const rows = []; let cum = 0;
    for (const ym of yms) {
      monthTarget += await monthTargetOf(perm, ym);
      const mLbl = Number(ym.split('-')[1]) + '월';
      const weeks = weeksOfMonth(ym);
      for (const w of weeks) {
        let q = `SELECT COALESCE(SUM(i.subtotal_mxn),0) AS a FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
                  WHERE i.status='posted' AND i.inv_date >= $1 AND i.inv_date <= $2 AND c.deleted_at IS NULL`;
        const p = [w.start, w.end];
        if (ta) { p.push(ta); q += ` AND c.team_id = ANY($3)`; }
        const actual = Number((await query(q, p)).rows[0].a);
        cum += actual;
        rows.push({
          label: multi ? (mLbl + ' ' + w.label) : w.label,
          start: w.start, end: w.end,
          actual: seeSales ? r2(actual) : null, cumActual: seeSales ? r2(cum) : null,
        });
      }
    }
    const progress = monthTarget > 0 ? r2(cum / monthTarget * 100) : null;
    return { yms, multi, weeks: rows, monthTarget: seeSales ? r2(monthTarget) : null, cumActual: seeSales ? r2(cum) : null, progress, locked: !seeSales };
  });

  // 고객 파이프라인 보드(6단계, 고객 카드)
  app.get('/api/salesperf/pipeline', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const ta = teamArrOf(perm);
    // 단계(미지정 제외)
    const stages = (await query(`SELECT id, name, sort_order FROM stages WHERE deleted_at IS NULL AND sort_order > 0 ORDER BY sort_order`)).rows;
    // 고객 + 마지막 활동일(미팅 최신)
    let q = `SELECT c.id, c.name, c.stage_id, c.stage_since,
                    (SELECT MAX(m.meeting_date) FROM customer_meetings m WHERE m.customer_id=c.id) AS last_activity
               FROM customers c
              WHERE c.deleted_at IS NULL AND c.stage_id IS NOT NULL`;
    const p = [];
    if (ta) { p.push(ta); q += ` AND c.team_id = ANY($1)`; }
    const custs = (await query(q, p)).rows;
    const today = new Date().toISOString().slice(0, 10);
    const d10 = (d) => { if (!d) return null; if (d instanceof Date) return d.toISOString().slice(0, 10); return String(d).slice(0, 10); };
    const dayDiff = (d) => { const ds = d10(d); if (!ds) return null; const a = new Date(ds + 'T00:00:00Z'), b = new Date(today + 'T00:00:00Z'); return Math.round((b - a) / 86400000); };
    const byStage = {};
    for (const s of stages) byStage[s.id] = [];
    for (const c of custs) {
      if (!byStage[c.stage_id]) continue;
      byStage[c.stage_id].push({
        id: c.id, name: c.name,
        stage_since: d10(c.stage_since),
        days_in_stage: dayDiff(c.stage_since),
        last_activity: d10(c.last_activity),
        activity_days: dayDiff(c.last_activity),
      });
    }
    return {
      total: custs.length,
      stages: stages.map((s) => ({ id: s.id, name: s.name, sort_order: s.sort_order, count: byStage[s.id].length, customers: byStage[s.id] })),
    };
  });

  // 고객 상세 드릴다운: 기본정보·결제·영업성과·매출이력·마케팅활동
  app.get('/api/salesperf/customer/:id', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    // 드릴다운 비활성 사용자는 고객 상세 차단(디렉터는 항상 허용)
    if (perm.role !== 'director' && perm.dashDrilldown === false) {
      return reply.code(403).send({ error: 'drilldown_disabled' });
    }
    const id = Number(req.params.id);
    const ta = teamArrOf(perm);
    const seeSales = fieldVisible(perm, 'sales_amount');
    const seeAr = fieldVisible(perm, 'ar_amount');
    const seeMkt = fieldVisible(perm, 'mkt_amount');
    const year = new Date().getUTCFullYear();

    // 기본정보 (팀 가시성 체크)
    let cq = `SELECT c.id, c.code, c.name, c.rfc, c.contact, c.phone, c.discount, c.credit_days, c.memo,
                     c.stage_since, c.team_id, s.name AS stage_name, t.name AS team_name
                FROM customers c LEFT JOIN stages s ON s.id=c.stage_id LEFT JOIN sales_teams t ON t.id=c.team_id
               WHERE c.id=$1 AND c.deleted_at IS NULL`;
    const cp = [id];
    if (ta) { cp.push(ta); cq += ` AND c.team_id = ANY($2)`; }
    const c = (await query(cq, cp)).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });

    // 결제정보: 미수/연체
    const ar = (await query(
      `SELECT COALESCE(SUM(i.total_mxn - COALESCE(p.paid,0)),0) AS outstanding,
              COALESCE(SUM(CASE WHEN i.due_date < CURRENT_DATE THEN (i.total_mxn - COALESCE(p.paid,0)) ELSE 0 END),0) AS overdue
         FROM sales_invoices i
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p ON p.invoice_id=i.id
        WHERE i.customer_id=$1 AND i.status='posted'`, [id])).rows[0];

    // 영업성과: 올해 목표 vs 실적(ex-IVA)
    const tgt = Number((await query(`SELECT COALESCE(SUM(amount),0) AS a FROM target_customer_months WHERE customer_id=$1 AND ym LIKE $2`, [id, year + '-%'])).rows[0].a);
    const act = Number((await query(`SELECT COALESCE(SUM(subtotal_mxn),0) AS a FROM sales_invoices WHERE customer_id=$1 AND status='posted' AND to_char(inv_date,'YYYY')=$2`, [id, String(year)])).rows[0].a);
    const progress = tgt > 0 ? r2(act / tgt * 100) : null;

    // 매출이력: 최근 인보이스 8건
    const hist = (await query(
      `SELECT to_char(inv_date,'YYYY-MM-DD') AS d, subtotal_mxn, total_mxn, to_char(due_date,'YYYY-MM-DD') AS due, status
         FROM sales_invoices WHERE customer_id=$1 AND status='posted' ORDER BY inv_date DESC, id DESC LIMIT 8`, [id])).rows;

    // 마케팅활동: 올해 활동별 비용
    const mkt = (await query(
      `SELECT ac.name AS activity, COALESCE(SUM(a.qty),0) AS qty, COALESCE(SUM(a.qty*a.unit_budget),0) AS cost
         FROM marketing_alloc a JOIN activity_catalog ac ON ac.id=a.catalog_id
        WHERE a.customer_id=$1 AND a.ym LIKE $2 GROUP BY ac.name HAVING COALESCE(SUM(a.qty),0) > 0 ORDER BY cost DESC`, [id, year + '-%'])).rows;
    const mktTotal = mkt.reduce((s, m) => s + Number(m.cost), 0);

    return {
      basic: { code: c.code, name: c.name, rfc: c.rfc, contact: c.contact, phone: c.phone, discount: Number(c.discount || 0), stage: c.stage_name, team: c.team_name, since: c.stage_since ? (c.stage_since instanceof Date ? c.stage_since.toISOString().slice(0, 10) : String(c.stage_since).slice(0, 10)) : null, memo: c.memo },
      payment: { credit_days: c.credit_days, outstanding: seeAr ? r2(ar.outstanding) : null, overdue: seeAr ? r2(ar.overdue) : null, locked: !seeAr },
      performance: seeSales ? { year, target: r2(tgt), actual: r2(act), progress, locked: false } : { year, progress, locked: true },
      history: hist.map((h) => ({ date: h.d, subtotal: seeSales ? r2(h.subtotal_mxn) : null, total: seeSales ? r2(h.total_mxn) : null, due: h.due, locked: !seeSales })),
      marketing: { items: mkt.map((m) => ({ activity: m.activity, qty: Number(m.qty), cost: seeMkt ? r2(m.cost) : null })), total: seeMkt ? r2(mktTotal) : null, locked: !seeMkt },
    };
  });

  // 마케팅 성과: 고객별 (마케팅 비용 ↔ 매출목표 진척률) 상관관계
  app.get('/api/salesperf/marketing-correlation', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const ta = teamArrOf(perm);
    const seeMkt = fieldVisible(perm, 'mkt_amount');
    const year = String(req.query.year || new Date().getUTCFullYear());

    // 고객별 올해 마케팅비용, 목표, 실적(ex-IVA)
    let q = `SELECT c.id, c.name,
                    COALESCE((SELECT SUM(a.qty*a.unit_budget) FROM marketing_alloc a WHERE a.customer_id=c.id AND a.ym LIKE $1),0) AS mkt_cost,
                    COALESCE((SELECT SUM(m.amount) FROM target_customer_months m WHERE m.customer_id=c.id AND m.ym LIKE $1),0) AS target,
                    COALESCE((SELECT SUM(i.subtotal_mxn) FROM sales_invoices i WHERE i.customer_id=c.id AND i.status='posted' AND to_char(i.inv_date,'YYYY')=$2),0) AS actual
               FROM customers c WHERE c.deleted_at IS NULL`;
    const p = [year + '-%', year];
    if (ta) { p.push(ta); q += ` AND c.team_id = ANY($3)`; }
    const rows = (await query(q, p)).rows;

    // 마케팅비용이 있는 고객만 상관 대상
    const points = rows
      .filter((r) => Number(r.mkt_cost) > 0 && Number(r.target) > 0)
      .map((r) => ({ id: r.id, name: r.name, cost: r2(r.mkt_cost), progress: r2(Number(r.actual) / Number(r.target) * 100) }));
    const corr = pearson(points.map((p) => p.cost), points.map((p) => p.progress));
    // 효율: 진척률 ÷ (비용/1000) 같은 단순 지표 대신, 비용당 실적도 제공
    return {
      year, count: points.length,
      correlation: corr,
      points: seeMkt ? points : points.map((p) => ({ id: p.id, name: p.name, progress: p.progress })),
      locked: !seeMkt,
    };
  });

  // 주간 캘린더용: 한 주(또는 한 달)의 일자별 매출 상세(고객명+금액)
  app.get('/api/salesperf/daily', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const ta = teamArrOf(perm);
    const seeSales = fieldVisible(perm, 'sales_amount');
    const start = String(req.query.start || '');
    const end = String(req.query.end || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return { start, end, days: {}, locked: !seeSales };

    let q = `SELECT to_char(i.inv_date,'YYYY-MM-DD') AS d, c.name AS customer, i.subtotal_mxn AS amt, i.id
               FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
              WHERE i.status='posted' AND i.inv_date >= $1 AND i.inv_date <= $2 AND c.deleted_at IS NULL`;
    const p = [start, end];
    if (ta) { p.push(ta); q += ` AND c.team_id = ANY($3)`; }
    q += ` ORDER BY i.inv_date, i.id`;
    const rows = (await query(q, p)).rows;

    const days = {};
    for (const r of rows) {
      (days[r.d] ||= []).push({ customer: r.customer, amount: seeSales ? r2(r.amt) : null });
    }
    return { start, end, days, locked: !seeSales };
  });
}
