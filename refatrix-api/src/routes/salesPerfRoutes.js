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
// 월의 주차 경계(월~일, 월초/월말로 클램프)
function weeksOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  const out = [];
  // 주 시작(월요일) 계산
  let cur = new Date(first);
  const dow = (cur.getUTCDay() + 6) % 7; // 0=월
  cur.setUTCDate(cur.getUTCDate() - dow);
  let idx = 1;
  while (cur <= last) {
    let ws = new Date(cur), we = new Date(cur); we.setUTCDate(we.getUTCDate() + 6);
    const s = ws < first ? first : ws, e = we > last ? last : we;
    out.push({ label: idx + '주', start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) });
    cur.setUTCDate(cur.getUTCDate() + 7); idx++;
  }
  return out;
}

export default async function salesPerfRoutes(app) {
  // 월 요약 3박스: 목표 / 실적 / 달성률 (팀 가시성)
  app.get('/api/salesperf/monthly', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const ym = String(req.query.ym || new Date().toISOString().slice(0, 7));
    const vis = visibleTeamIds(perm);
    const teamArr = vis === null ? null : (vis.length ? vis : [-1]);
    const seeAmt = fieldVisible(perm, 'sales_amount');

    // 목표: 팀 가시성이 전체(디렉터)면 회사 월목표, 아니면 보이는 팀 고객의 고객목표 합
    let target = 0;
    if (vis === null) {
      const r = (await query(`SELECT COALESCE(amount,0) AS a FROM monthly_targets WHERE ym=$1`, [ym])).rows[0];
      target = r ? Number(r.a) : 0;
      if (!target) {
        const r2q = (await query(`SELECT COALESCE(SUM(amount),0) AS a FROM target_customer_months WHERE ym=$1`, [ym])).rows[0];
        target = Number(r2q.a);
      }
    } else {
      const r = (await query(
        `SELECT COALESCE(SUM(m.amount),0) AS a FROM target_customer_months m JOIN customers c ON c.id=m.customer_id
          WHERE m.ym=$1 AND c.deleted_at IS NULL AND c.team_id = ANY($2)`, [ym, teamArr])).rows[0];
      target = Number(r.a);
    }
    // 실적: 해당 월 posted 인보이스 합
    let aq = `SELECT COALESCE(SUM(i.total_mxn),0) AS a FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
               WHERE i.status='posted' AND to_char(i.inv_date,'YYYY-MM')=$1 AND c.deleted_at IS NULL`;
    const ap = [ym];
    if (teamArr) { ap.push(teamArr); aq += ` AND c.team_id = ANY($2)`; }
    const actual = Number((await query(aq, ap)).rows[0].a);
    const progress = target > 0 ? r2(actual / target * 100) : null;

    return seeAmt
      ? { ym, target: r2(target), actual: r2(actual), progress, locked: false }
      : { ym, progress, locked: true };
  });

  // 주차별 목표/실적 워터폴 (팀 가시성). 주 목표 = 월목표 ÷ 주수(균등 분할).
  app.get('/api/salesperf/weekly', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const ym = String(req.query.ym || new Date().toISOString().slice(0, 7));
    const vis = visibleTeamIds(perm);
    const teamArr = vis === null ? null : (vis.length ? vis : [-1]);
    const seeAmt = fieldVisible(perm, 'sales_amount');

    // 월 목표
    let monthTarget = 0;
    if (vis === null) {
      const r = (await query(`SELECT COALESCE(amount,0) AS a FROM monthly_targets WHERE ym=$1`, [ym])).rows[0];
      monthTarget = r ? Number(r.a) : 0;
      if (!monthTarget) monthTarget = Number((await query(`SELECT COALESCE(SUM(amount),0) AS a FROM target_customer_months WHERE ym=$1`, [ym])).rows[0].a);
    } else {
      monthTarget = Number((await query(
        `SELECT COALESCE(SUM(m.amount),0) AS a FROM target_customer_months m JOIN customers c ON c.id=m.customer_id
          WHERE m.ym=$1 AND c.deleted_at IS NULL AND c.team_id = ANY($2)`, [ym, teamArr])).rows[0].a);
    }
    const weeks = weeksOfMonth(ym);
    const wkTarget = weeks.length ? monthTarget / weeks.length : 0;

    // 주차별 실적
    const rows = [];
    let cumT = 0, cumA = 0;
    for (const w of weeks) {
      let q = `SELECT COALESCE(SUM(i.total_mxn),0) AS a FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
                WHERE i.status='posted' AND i.inv_date >= $1 AND i.inv_date <= $2 AND c.deleted_at IS NULL`;
      const p = [w.start, w.end];
      if (teamArr) { p.push(teamArr); q += ` AND c.team_id = ANY($3)`; }
      const actual = Number((await query(q, p)).rows[0].a);
      cumT += wkTarget; cumA += actual;
      rows.push({
        label: w.label, start: w.start, end: w.end,
        target: seeAmt ? r2(wkTarget) : null, actual: seeAmt ? r2(actual) : null,
        cumTarget: seeAmt ? r2(cumT) : null, cumActual: seeAmt ? r2(cumA) : null,
        progress: wkTarget > 0 ? r2(actual / wkTarget * 100) : null,
        cumProgress: cumT > 0 ? r2(cumA / cumT * 100) : null,
      });
    }
    return { ym, weeks: rows, monthTarget: seeAmt ? r2(monthTarget) : null, locked: !seeAmt };
  });
}
