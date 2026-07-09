import { query } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { visibleTeamIds } from '../teams.js';
import { fieldVisible } from '../permissions.js';
import { effectiveTargetFor, aggregateCarryover, monthsInclusive } from '../salesTarget.js';
import { arInvoiceStatus, bucketByDueMonth, arSummary } from '../ar.js';

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
// team 파라미터를 가시 범위와 교차해 적용 (토글이 모든 섹션에 작동하도록). 'total'/'' → 가시 전체
function effectiveTeamArr(perm, teamParam) {
  const ta = teamArrOf(perm); // null = 전체 가시
  const tp = String(teamParam || '').trim().toLowerCase();
  if (!tp || tp === 'total' || tp === 'all' || !/^\d+$/.test(tp)) return ta;
  const id = Number(tp);
  if (ta === null) return [id];
  return ta.includes(id) ? [id] : [-1];
}

// 월 매출목표(전사 또는 팀 가시성 고객목표 합)
async function monthTargetOf(perm, ym) {
  const vis = visibleTeamIds(perm);
  // 회사 전체 월목표(monthly_targets)가 설정돼 있으면 우선 사용
  if (vis === null) {
    const comp = Number((await query(`SELECT COALESCE(amount,0) AS a FROM monthly_targets WHERE ym=$1`, [ym])).rows[0]?.a || 0);
    if (comp) return comp;
  }
  // 팀별 합산: 각 팀의 팀목표(target_team_months), 없으면 그 팀 고객목표(target_customer_months) 합
  const args = [ym]; let teamFilter = '';
  if (vis !== null) { args.push(vis.length ? vis : [-1]); teamFilter = ' AND t.id = ANY($2)'; }
  const r = await query(
    `SELECT COALESCE(SUM(
        COALESCE(tt.amount,
          (SELECT COALESCE(SUM(m.amount),0) FROM target_customer_months m JOIN customers c ON c.id=m.customer_id
             WHERE m.ym=$1 AND c.team_id=t.id AND c.deleted_at IS NULL))
      ),0) AS a
       FROM sales_teams t
       LEFT JOIN target_team_months tt ON tt.team_id=t.id AND tt.ym=$1
      WHERE COALESCE(t.is_sales,true)=true${teamFilter}`, args);
  return Number(r.rows[0].a);
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

// ===== 팀별 이월(carryover) 지원 헬퍼 =====
// team 파라미터('total'/'all'/'' = 가시 전체, 또는 특정 team_id) → 가시성 내 포함할 팀 목록/범위
async function resolveTeamScope(perm, teamParam) {
  const vis = visibleTeamIds(perm); // null = 전체
  let q = `SELECT id, name FROM sales_teams WHERE COALESCE(is_sales,true)=true`;
  const args = [];
  if (vis !== null) { args.push(vis.length ? vis : [-1]); q += ` AND id = ANY($1)`; }
  q += ` ORDER BY sort_order, id`;
  const teamList = (await query(q, args)).rows.map((t) => ({ id: Number(t.id), name: t.name }));
  const tp = String(teamParam || '').trim().toLowerCase();
  let scopeIds, selected;
  if (tp && tp !== 'total' && tp !== 'all' && /^\d+$/.test(tp)) {
    const one = teamList.filter((t) => t.id === Number(tp));
    scopeIds = one.map((t) => t.id); selected = String(Number(tp));
  } else { scopeIds = teamList.map((t) => t.id); selected = 'total'; }
  return { teamList, scopeIds, selected };
}
// 선택월들에 대해 그 해 1월부터 필요한 모든 'YYYY-MM' (이월 replay용)
function neededMonths(yms) {
  const set = new Set();
  for (const ym of yms) {
    const [y, m] = String(ym).split('-').map(Number);
    for (let i = 1; i <= m; i++) set.add(`${y}-${String(i).padStart(2, '0')}`);
  }
  return [...set].sort();
}
// {team_id:{ym:value}} 맵 빌더
function emptyMap(ids) { const o = {}; for (const id of ids) o[id] = {}; return o; }
// 매출: 기본목표(팀월목표, 없으면 그 팀 고객목표 합)·실적(posted ex-IVA, inv_date)
async function salesBaseActual(scopeIds, months) {
  const base = emptyMap(scopeIds), actual = emptyMap(scopeIds);
  if (!scopeIds.length || !months.length) return { base, actual };
  const tt = (await query(`SELECT team_id, ym, amount FROM target_team_months WHERE team_id=ANY($1) AND ym=ANY($2)`, [scopeIds, months])).rows;
  const ttSet = new Set(); for (const r of tt) { base[r.team_id][r.ym] = Number(r.amount); ttSet.add(r.team_id + '|' + r.ym); }
  const ct = (await query(
    `SELECT c.team_id, m.ym, COALESCE(SUM(m.amount),0) AS amt FROM target_customer_months m JOIN customers c ON c.id=m.customer_id
      WHERE c.team_id=ANY($1) AND m.ym=ANY($2) AND c.deleted_at IS NULL GROUP BY c.team_id, m.ym`, [scopeIds, months])).rows;
  for (const r of ct) { if (!ttSet.has(r.team_id + '|' + r.ym)) base[r.team_id][r.ym] = Number(r.amt); } // 팀월목표 없을 때만 고객합 사용
  const ac = (await query(
    `SELECT c.team_id, to_char(i.inv_date,'YYYY-MM') AS ym, COALESCE(SUM(i.subtotal_mxn),0) AS a
       FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.status='posted' AND c.team_id=ANY($1) AND to_char(i.inv_date,'YYYY-MM')=ANY($2) AND c.deleted_at IS NULL
      GROUP BY c.team_id, to_char(i.inv_date,'YYYY-MM')`, [scopeIds, months])).rows;
  for (const r of ac) actual[r.team_id][r.ym] = Number(r.a);
  return { base, actual };
}
// 수금: 기본목표(그달 만기 인보이스 total_mxn, due_date)·실적(그달 입금 in-transactions)
async function collectBaseActual(scopeIds, months) {
  const base = emptyMap(scopeIds), actual = emptyMap(scopeIds);
  if (!scopeIds.length || !months.length) return { base, actual };
  const bd = (await query(
    `SELECT c.team_id, to_char(i.due_date,'YYYY-MM') AS ym, COALESCE(SUM(i.total_mxn),0) AS a
       FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.status='posted' AND c.team_id=ANY($1) AND to_char(i.due_date,'YYYY-MM')=ANY($2) AND c.deleted_at IS NULL
      GROUP BY c.team_id, to_char(i.due_date,'YYYY-MM')`, [scopeIds, months])).rows;
  for (const r of bd) base[r.team_id][r.ym] = Number(r.a);
  const ad = (await query(
    `SELECT c.team_id, to_char(t.txn_date,'YYYY-MM') AS ym, COALESCE(SUM(t.amount_mxn),0) AS a
       FROM transactions t JOIN sales_invoices i ON i.id=t.sales_invoice_id JOIN customers c ON c.id=i.customer_id
      WHERE t.status='actual' AND t.direction='in' AND c.team_id=ANY($1) AND to_char(t.txn_date,'YYYY-MM')=ANY($2)
        AND (t.kind IN ('sales','invoice') OR t.sales_invoice_id IS NOT NULL)
      GROUP BY c.team_id, to_char(t.txn_date,'YYYY-MM')`, [scopeIds, months])).rows;
  for (const r of ad) actual[r.team_id][r.ym] = Number(r.a);
  return { base, actual };
}

export default async function salesPerfRoutes(app) {
  // 상단 요약 3카드 (ym는 콤마구분 다중 월 가능: 합산)
  // 팀별 × 월별 실적(ex-IVA)·목표 — 매출목표 카드 아래 표시
  app.get('/api/salesperf/team-monthly', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const yms = String(req.query.ym || new Date().toISOString().slice(0, 7)).split(',').map((s) => s.trim()).filter(Boolean);
    if (!fieldVisible(perm, 'sales_amount')) return { months: yms, teams: [], locked: true };
    const vis = visibleTeamIds(perm); // null = 전체
    let teamsQ = `SELECT id, name FROM sales_teams WHERE COALESCE(is_sales,true)=true`;
    const teamsArgs = [];
    if (vis !== null) { teamsArgs.push(vis.length ? vis : [-1]); teamsQ += ` AND id = ANY($1)`; }
    teamsQ += ` ORDER BY sort_order, id`;
    const teams = (await query(teamsQ, teamsArgs)).rows;
    const result = [];
    for (const t of teams) {
      const byMonth = {}; let tA = 0, tT = 0;
      for (const ym of yms) {
        const actual = Number((await query(
          `SELECT COALESCE(SUM(i.subtotal_mxn),0) a FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
            WHERE i.status='posted' AND to_char(i.inv_date,'YYYY-MM')=$1 AND c.team_id=$2 AND c.deleted_at IS NULL`, [ym, t.id])).rows[0].a);
        let target = Number((await query(`SELECT COALESCE(amount,0) a FROM target_team_months WHERE team_id=$1 AND ym=$2`, [t.id, ym])).rows[0]?.a || 0);
        if (!target) target = Number((await query(
          `SELECT COALESCE(SUM(m.amount),0) a FROM target_customer_months m JOIN customers c ON c.id=m.customer_id
            WHERE m.ym=$1 AND c.team_id=$2 AND c.deleted_at IS NULL`, [ym, t.id])).rows[0].a);
        byMonth[ym] = { actual: r2(actual), target: r2(target) };
        tA += actual; tT += target;
      }
      result.push({ team_id: t.id, name: t.name, byMonth, total: { actual: r2(tA), target: r2(tT) } });
    }
    return { months: yms, teams: result };
  });

  // 팀별 월별 실적·목표 끝
  app.get('/api/salesperf/summary', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const yms = String(req.query.ym || new Date().toISOString().slice(0, 7)).split(',').map((s) => s.trim()).filter(Boolean);
    const ta = teamArrOf(perm);
    const seeSales = fieldVisible(perm, 'sales_amount');
    const seeAr = fieldVisible(perm, 'ar_amount');
    const multi = yms.length > 1;

    // 카드1 매출목표 / 카드2 수금 — carry=1이면 팀 토글 + 미달분 이월 적용, 아니면 종전 동작
    const carryMode = String(req.query.carry || '') === '1';
    let teamList = [], selectedTeam = 'total';
    let selScopeIds = null; // 선택 팀 스코프(carry 모드에서 카드3 고객개발에 사용)
    let target = 0, actual = 0, prevActual = 0;
    let collectPlan = 0, collectActual = 0;

    if (carryMode) {
      const scope = await resolveTeamScope(perm, req.query.team);
      teamList = scope.teamList; selectedTeam = scope.selected;
      selScopeIds = scope.scopeIds;
      const months = neededMonths(yms);
      const sba = await salesBaseActual(scope.scopeIds, months);
      const sAgg = aggregateCarryover(scope.scopeIds, sba.base, sba.actual, yms);
      target = sAgg.target; actual = sAgg.actual;
      // 수금: AR은 반드시 받아야 하므로 미실행분은 연이 넘어가도 이월(리셋 없음).
      // → epoch(전 기간 최초 만기월)부터 표시월까지 replay해야 작년 이월이 사라지지 않는다.
      const collectEpoch = (await query(
        `SELECT to_char(MIN(i.due_date),'YYYY-MM') AS ep
           FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
          WHERE i.status='posted' AND i.deleted_at IS NULL AND c.team_id=ANY($1) AND c.deleted_at IS NULL`,
        [scope.scopeIds])).rows[0]?.ep || (String([...yms].sort()[0]).slice(0, 4) + '-01');
      const collectMaxYm = [...yms].sort().slice(-1)[0];
      const collectMonths = monthsInclusive(collectEpoch, collectMaxYm); // epoch→표시월 전체(다년) 로드
      const cba = await collectBaseActual(scope.scopeIds, collectMonths);
      const cAgg = aggregateCarryover(scope.scopeIds, cba.base, cba.actual, yms, { annualReset: false, startYm: collectEpoch });
      collectPlan = cAgg.target; collectActual = cAgg.actual;
      if (!multi) {
        const pYm = prevYm(yms[0]);
        if (String(pYm).slice(0, 4) === String(yms[0]).slice(0, 4)) {
          for (const tid of scope.scopeIds) prevActual = r2(prevActual + (sba.actual[tid]?.[pYm] || 0));
        }
      }
    } else {
      for (const ym of yms) { target += await monthTargetOf(perm, ym); actual += await monthSalesActual(perm, ym); }
      if (!multi) prevActual = await monthSalesActual(perm, prevYm(yms[0]));
      for (const ym of yms) {
        let pq = `SELECT COALESCE(SUM(i.total_mxn),0) AS a FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
                   WHERE i.status='posted' AND to_char(i.due_date,'YYYY-MM')=$1 AND c.deleted_at IS NULL`;
        const pp = [ym]; if (ta) { pp.push(ta); pq += ` AND c.team_id = ANY($2)`; }
        collectPlan += Number((await query(pq, pp)).rows[0].a);
        let cq = `SELECT COALESCE(SUM(t.amount_mxn),0) AS a FROM transactions t
                    LEFT JOIN sales_invoices i ON i.id=t.sales_invoice_id
                    LEFT JOIN customers c ON c.id=i.customer_id
                   WHERE t.status='actual' AND t.direction='in' AND to_char(t.txn_date,'YYYY-MM')=$1
                     AND (t.kind IN ('sales','invoice') OR t.sales_invoice_id IS NOT NULL)`;
        const cp = [ym]; if (ta) { cp.push(ta); cq += ` AND c.team_id = ANY($2)`; }
        collectActual += Number((await query(cq, cp)).rows[0].a);
      }
    }
    const progress = target > 0 ? r2(actual / target * 100) : null;
    const momPct = multi ? null : (prevActual > 0 ? r2((actual - prevActual) / prevActual * 100) : (actual > 0 ? null : 0));
    const collectProgress = collectPlan > 0 ? r2(collectActual / collectPlan * 100) : null;

    // 카드3 고객 개발 — 현재 단계별 고객 수 (고객 화면과 동일 법칙)
    //  · 견적(30)=견적저장 후 아무것도 진행 안됨 · 협상(40)=임의 지정 · 수주(50)=포장작업지시서 발행
    //  · customers.stage_id 의 현재 단계 기준(자동화: 견적저장→견적 / 포장지시서→수주 / SAT→거래중, 전진전용)
    //  · 팀 선택 반영: carry 모드에서 특정 팀을 고르면 그 팀 스코프(selScopeIds)로 거른다.
    const devTeamArr = (carryMode && selectedTeam !== 'total' && selScopeIds) ? selScopeIds : ta;
    let dq = `SELECT
        COUNT(*) FILTER (WHERE s.sort_order=30)::int AS quote_total,
        COUNT(*) FILTER (WHERE s.sort_order=40)::int AS negotiation,
        COUNT(*) FILTER (WHERE s.sort_order=50)::int AS won
      FROM customers c LEFT JOIN stages s ON s.id=c.stage_id
      WHERE c.deleted_at IS NULL`;
    const dp = [];
    if (devTeamArr) { dp.push(devTeamArr); dq += ` AND c.team_id = ANY($1)`; }
    const dr = (await query(dq, dp)).rows[0] || {};
    const devQuote = Number(dr.quote_total) || 0, devNeg = Number(dr.negotiation) || 0, devWon = Number(dr.won) || 0;
    // 지난 7일 단계 변동(진입−이탈) — 영업활동의 고객 단계변화일(customer_stage_history) 기준
    let hq = `SELECT s.sort_order,
                COUNT(*) FILTER (WHERE h.entered_at >= CURRENT_DATE - INTERVAL '7 days')::int AS entered,
                COUNT(*) FILTER (WHERE h.left_at IS NOT NULL AND h.left_at >= CURRENT_DATE - INTERVAL '7 days')::int AS left_cnt
              FROM stages s
              JOIN customer_stage_history h ON h.stage_id=s.id
              JOIN customers c ON c.id=h.customer_id AND c.deleted_at IS NULL
              WHERE s.sort_order IN (30,40,50)`;
    const hp = [];
    if (devTeamArr) { hp.push(devTeamArr); hq += ` AND c.team_id = ANY($1)`; }
    hq += ` GROUP BY s.sort_order`;
    const hRows = (await query(hq, hp)).rows;
    const delta = { 30: 0, 40: 0, 50: 0 };
    for (const r of hRows) delta[Number(r.sort_order)] = (Number(r.entered) || 0) - (Number(r.left_cnt) || 0);

    return {
      yms, multi,
      carry: carryMode, teams: teamList, selectedTeam,
      sales: seeSales ? { actual: r2(actual), target: r2(target), progress, prevActual: r2(prevActual), momPct, locked: false }
                      : { progress, momPct, locked: true },
      collection: seeAr ? { actual: r2(collectActual), plan: r2(collectPlan), progress: collectProgress, locked: false }
                        : { progress: collectProgress, locked: true },
      pipeline_dev: { quote: devQuote, negotiation: devNeg, won: devWon, total: devQuote + devNeg + devWon, delta: { quote: delta[30], negotiation: delta[40], won: delta[50] } },
      drilldown: perm.role === 'director' ? true : (perm.dashDrilldown !== false),
    };
  });

  // 주차별 매출 워터폴(일요일 시작, ex-IVA)
  app.get('/api/salesperf/weekly', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const yms = String(req.query.ym || new Date().toISOString().slice(0, 7)).split(',').map((s) => s.trim()).filter(Boolean).sort();
    const ta = effectiveTeamArr(perm, req.query.team);
    const seeSales = fieldVisible(perm, 'sales_amount');
    const multi = yms.length > 1;
    const carryMode = String(req.query.carry || '') === '1';

    let monthTarget = 0;
    if (carryMode) {
      const scope = await resolveTeamScope(perm, req.query.team);
      const months = neededMonths(yms);
      const sba = await salesBaseActual(scope.scopeIds, months);
      monthTarget = aggregateCarryover(scope.scopeIds, sba.base, sba.actual, yms).target;
    } else {
      for (const ym of yms) monthTarget += await monthTargetOf(perm, ym);
    }
    const rows = []; let cum = 0;
    for (const ym of yms) {
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
    const ta = effectiveTeamArr(perm, req.query.team);
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
    const ta = effectiveTeamArr(perm, req.query.team);
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

  // ===== 담당고객 오픈 인보이스(수금 상세) — 영업 대시보드 수금카드 드릴다운 =====
  // 재무 권한 불필요(authGuard만). 비디렉터는 자기 담당고객(owner_id=본인)만.
  //  query: period=month|all, customer_id?(고객 토글), owner_id?(디렉터 전용)
  app.get('/api/salesperf/open-invoices', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const isDir = perm.role === 'director';
    const seeAr = fieldVisible(perm, 'ar_amount');
    const period = String(req.query.period || 'month').toLowerCase() === 'all' ? 'all' : 'month';
    const today = new Date().toISOString().slice(0, 10);

    // 스코프: 비디렉터=자기 담당고객. 디렉터=전체(+owner_id 필터 가능)
    let ownerId = null;
    if (!isDir) ownerId = perm.userId;
    else if (req.query.owner_id && /^\d+$/.test(String(req.query.owner_id))) ownerId = Number(req.query.owner_id);
    let custId = null;
    if (req.query.customer_id && /^\d+$/.test(String(req.query.customer_id))) custId = Number(req.query.customer_id);

    // 토글용 담당고객 목록(게시 인보이스 보유 고객; custId 필터와 무관)
    const cConds = [`i.status='posted'`, `i.deleted_at IS NULL`, `c.deleted_at IS NULL`];
    const cArgs = [];
    if (ownerId != null) { cArgs.push(ownerId); cConds.push(`c.owner_id = $${cArgs.length}`); }
    const customers = (await query(
      `SELECT c.id, c.name FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
        WHERE ${cConds.join(' AND ')} GROUP BY c.id, c.name ORDER BY c.name`, cArgs)).rows
      .map((r) => ({ id: Number(r.id), name: r.name }));

    // 인보이스 본 목록
    const conds = [`i.status='posted'`, `i.deleted_at IS NULL`, `c.deleted_at IS NULL`];
    const args = [];
    if (ownerId != null) { args.push(ownerId); conds.push(`c.owner_id = $${args.length}`); }
    if (custId != null) { args.push(custId); conds.push(`c.id = $${args.length}`); }
    const rows = (await query(
      `SELECT i.id, i.sat_no, c.id AS customer_id, c.name AS customer_name,
              to_char(i.inv_date,'YYYY-MM-DD') AS inv_date, to_char(i.due_date,'YYYY-MM-DD') AS due_date,
              i.total_mxn AS total, COALESCE(p.paid,0) AS paid
         FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p
                ON p.invoice_id=i.id
        WHERE ${conds.join(' AND ')}
        ORDER BY i.due_date DESC NULLS LAST, i.id DESC`, args)).rows;

    // 반제내역(수금일+금액) — 표시 인보이스만
    const ids = rows.map((r) => Number(r.id));
    const allocByInv = {};
    if (ids.length) {
      const al = (await query(
        `SELECT spa.invoice_id, to_char(sp.pay_date,'YYYY-MM-DD') AS pay_date, spa.amount, sp.memo
           FROM sales_payment_allocations spa JOIN sales_payments sp ON sp.id=spa.payment_id
          WHERE spa.invoice_id = ANY($1) ORDER BY sp.pay_date, spa.id`, [ids])).rows;
      for (const a of al) (allocByInv[a.invoice_id] ||= []).push({ pay_date: a.pay_date, amount: seeAr ? r2(a.amount) : null, memo: a.memo || '' });
    }

    // 상태 계산
    const enriched = rows.map((r) => {
      const st = arInvoiceStatus({ total: r.total, paid: r.paid, due_date: r.due_date }, today);
      const tempSat = !r.sat_no || r.sat_no === '' || String(r.sat_no).startsWith('TMP-');
      return {
        id: Number(r.id), sat_no: r.sat_no || '', temp_sat: tempSat,
        customer_id: Number(r.customer_id), customer_name: r.customer_name,
        inv_date: r.inv_date, due_date: r.due_date,
        total: seeAr ? st.total : null, paid: seeAr ? st.paid : null, outstanding: seeAr ? st.outstanding : null,
        open: st.open, overdue: st.overdue, overdue_days: st.overdue_days, days_to_due: st.days_to_due,
        allocations: allocByInv[r.id] || [],
      };
    });

    // 요약/월버킷은 항상 '오픈(미수)' 기준
    const openSet = enriched.filter((v) => v.open)
      .map((v) => ({ due_date: v.due_date, outstanding: arInvoiceStatus({ total: v.total, paid: v.paid, due_date: v.due_date }, today).outstanding, overdue: v.overdue }));
    const months = bucketByDueMonth(openSet);
    const sumRaw = arSummary(openSet);
    const summary = seeAr ? sumRaw : { open_count: sumRaw.open_count, outstanding: null, overdue: null };

    // period=month → 미수만 / period=all → 전체 게시
    const invoices = period === 'month' ? enriched.filter((v) => v.open) : enriched;

    return {
      period, scope: isDir ? (ownerId != null ? 'owner' : 'all') : 'mine',
      selectedCustomer: custId, customers, summary, months, invoices,
      locked: !seeAr,
    };
  });
}
