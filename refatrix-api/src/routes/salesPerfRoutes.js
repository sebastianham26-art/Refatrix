import { query } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { visibleTeamIds } from '../teams.js';
import { fieldVisible } from '../permissions.js';

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
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
  // 상단 요약 3카드
  app.get('/api/salesperf/summary', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const ym = String(req.query.ym || new Date().toISOString().slice(0, 7));
    const ta = teamArrOf(perm);
    const seeSales = fieldVisible(perm, 'sales_amount');
    const seeAr = fieldVisible(perm, 'ar_amount');

    // 카드1 매출목표 대비 실적(ex-IVA)
    const target = await monthTargetOf(perm, ym);
    const actual = await monthSalesActual(perm, ym);
    const prevActual = await monthSalesActual(perm, prevYm(ym));
    const progress = target > 0 ? r2(actual / target * 100) : null;
    const momPct = prevActual > 0 ? r2((actual - prevActual) / prevActual * 100) : (actual > 0 ? null : 0);

    // 카드2 수금계획 대비 실적
    // 계획 = 그 달 due_date 인보이스 합(total_mxn, IVA 포함 = 실제 수금 예정액)
    let pq = `SELECT COALESCE(SUM(i.total_mxn),0) AS a FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
               WHERE i.status='posted' AND to_char(i.due_date,'YYYY-MM')=$1 AND c.deleted_at IS NULL`;
    const pp = [ym]; if (ta) { pp.push(ta); pq += ` AND c.team_id = ANY($2)`; }
    const collectPlan = Number((await query(pq, pp)).rows[0].a);
    // 실적 = 그 달 actual 입금(direction in, status actual, 매출수금 kind)
    let cq = `SELECT COALESCE(SUM(t.amount_mxn),0) AS a FROM transactions t
               WHERE t.status='actual' AND t.direction='in' AND to_char(t.txn_date,'YYYY-MM')=$1
                 AND (t.kind IN ('sales','invoice') OR t.sales_invoice_id IS NOT NULL)`;
    const collectActual = Number((await query(cq, [ym])).rows[0].a);
    const collectProgress = collectPlan > 0 ? r2(collectActual / collectPlan * 100) : null;

    // 카드3 고객 개발(제안=견적 / 협상)
    let stq = `SELECT s.sort_order, COUNT(c.id) AS n
                 FROM stages s LEFT JOIN customers c ON c.stage_id=s.id AND c.deleted_at IS NULL`;
    const sp = [];
    if (ta) { sp.push(ta); stq += ` AND c.team_id = ANY($1)`; }
    stq += ` WHERE s.deleted_at IS NULL AND s.sort_order IN (30,40) GROUP BY s.sort_order`;
    const stRows = (await query(stq, sp)).rows;
    let proposal = 0, negotiation = 0;
    for (const r of stRows) { if (Number(r.sort_order) === 30) proposal = Number(r.n); else if (Number(r.sort_order) === 40) negotiation = Number(r.n); }

    return {
      ym,
      sales: seeSales ? { actual: r2(actual), target: r2(target), progress, prevActual: r2(prevActual), momPct, locked: false }
                      : { progress, momPct, locked: true },
      collection: seeAr ? { actual: r2(collectActual), plan: r2(collectPlan), progress: collectProgress, locked: false }
                        : { progress: collectProgress, locked: true },
      pipeline_dev: { proposal, negotiation, total: proposal + negotiation },
    };
  });

  // 주차별 매출 워터폴(일요일 시작, ex-IVA)
  app.get('/api/salesperf/weekly', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const ym = String(req.query.ym || new Date().toISOString().slice(0, 7));
    const ta = teamArrOf(perm);
    const seeSales = fieldVisible(perm, 'sales_amount');
    const monthTarget = await monthTargetOf(perm, ym);
    const weeks = weeksOfMonth(ym);
    const rows = []; let cum = 0;
    for (const w of weeks) {
      let q = `SELECT COALESCE(SUM(i.subtotal_mxn),0) AS a FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
                WHERE i.status='posted' AND i.inv_date >= $1 AND i.inv_date <= $2 AND c.deleted_at IS NULL`;
      const p = [w.start, w.end];
      if (ta) { p.push(ta); q += ` AND c.team_id = ANY($3)`; }
      const actual = Number((await query(q, p)).rows[0].a);
      cum += actual;
      rows.push({ label: w.label, start: w.start, end: w.end,
        actual: seeSales ? r2(actual) : null, cumActual: seeSales ? r2(cum) : null });
    }
    const progress = monthTarget > 0 ? r2(cum / monthTarget * 100) : null;
    return { ym, weeks: rows, monthTarget: seeSales ? r2(monthTarget) : null, cumActual: seeSales ? r2(cum) : null, progress, locked: !seeSales };
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
}
