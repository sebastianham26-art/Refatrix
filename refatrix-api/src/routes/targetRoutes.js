import { query } from '../db.js';
import { authGuard, requirePage, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { visibleTeamIds, canViewTeam, canEditTeam } from '../teams.js';
import { monthsHorizon, monthsInclusive, currentYm, sumByMonth, shortfallByMonth, companyVsTeams, carryoverByMonth, r2 } from '../salesTarget.js';
import { stageLabel } from '../stageLabel.js';

async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }

// ===== 이월(carryover)·실적 지원 헬퍼 (salesPerfRoutes와 동일 규칙) =====
// 표시월들에 대해 각 해 1월부터 필요한 모든 'YYYY-MM' (이월 replay용)
function neededMonths(yms) {
  const set = new Set();
  for (const ym of yms) {
    const [y, m] = String(ym).split('-').map(Number);
    if (!y || !m) continue;
    for (let i = 1; i <= m; i++) set.add(`${y}-${String(i).padStart(2, '0')}`);
  }
  return [...set].sort();
}
// 팀별 기본목표(팀월목표 · 없으면 그 팀 고객목표 합)·실적(posted ex-IVA, inv_date 기준)
async function teamBaseActual(teamIds, months) {
  const base = {}, actual = {};
  for (const id of teamIds) { base[id] = {}; actual[id] = {}; }
  if (!teamIds.length || !months.length) return { base, actual };
  const tt = (await query(`SELECT team_id, ym, amount FROM target_team_months WHERE team_id=ANY($1) AND ym=ANY($2)`, [teamIds, months])).rows;
  const ttSet = new Set();
  for (const r of tt) { base[r.team_id][r.ym] = Number(r.amount); ttSet.add(r.team_id + '|' + r.ym); }
  const ct = (await query(
    `SELECT c.team_id, m.ym, COALESCE(SUM(m.amount),0) AS amt
       FROM target_customer_months m JOIN customers c ON c.id=m.customer_id
      WHERE c.team_id=ANY($1) AND m.ym=ANY($2) AND c.deleted_at IS NULL
      GROUP BY c.team_id, m.ym`, [teamIds, months])).rows;
  for (const r of ct) { if (!ttSet.has(r.team_id + '|' + r.ym)) base[r.team_id][r.ym] = Number(r.amt); } // 팀월목표 없을 때만 고객합 사용
  const ac = (await query(
    `SELECT c.team_id, to_char(i.inv_date,'YYYY-MM') AS ym, COALESCE(SUM(i.subtotal_mxn),0) AS a
       FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.status='posted' AND c.team_id=ANY($1) AND to_char(i.inv_date,'YYYY-MM')=ANY($2) AND c.deleted_at IS NULL
      GROUP BY c.team_id, to_char(i.inv_date,'YYYY-MM')`, [teamIds, months])).rows;
  for (const r of ac) actual[r.team_id][r.ym] = Number(r.a);
  return { base, actual };
}

export default async function targetRoutes(app) {
  // 목표 페이지 개요: 전체 월 목표 + 팀별 월 목표 + 팀 합 검증 (디렉터 중심, 영업은 자기 팀만)
  // 표시 기간 — 기본은 예전 그대로 **시작월부터 12개월**.
  //   `end`(YYYY-MM)를 주면 **그 달까지** 보여 준다.
  //   커미셔너 계약이 "2027-12 까지의 총액"이라, 12개월 고정이면 오늘(2026-09) 기준
  //   2027-08 까지밖에 못 채운다 — 계약 기간의 마지막 4개월을 입력할 자리가 없었다.
  //
  //   `end` 를 안 보내는 옛 화면/다른 호출은 **동작이 그대로다**(회귀 없음).
  //   상한 24칸: 표가 옆으로 무한정 늘어나면 화면에서 못 쓰고, 쿼리도 무거워진다.
  // 「팀 계획 편집자」인가 — 팀 전체 배분을 손댈 수 있는 사람.
  //   디렉터, 또는 targets 화면에 **수정** 권한이 있고 그 팀을 편집할 수 있는 사람.
  //   커미셔너는 여기에 해당하지 않는다(targets=열람). 대신 아래 「소유 고객」 경로로 쓴다.
  function isTeamEditor(perm, teamId) {
    if (perm?.role === 'director') return true;
    const lvl = (perm?.pageAccess && perm.pageAccess.targets) || 'edit';
    return lvl === 'edit' && canEditTeam(perm, teamId);
  }
  // 그 팀 안에서 **내가 담당(owner_id)인 고객** id 집합.
  //   커미셔너는 팀 권한이 없어도 자기 고객 줄은 보고 쓴다 — 담당 지정이 곧 권한이다.
  async function ownedInTeam(perm, teamId) {
    const rows = (await query(
      `SELECT id FROM customers WHERE team_id=$1 AND owner_id=$2 AND deleted_at IS NULL`,
      [teamId, Number(perm.userId)])).rows;
    return new Set(rows.map((r) => Number(r.id)));   // pg bigint→string 주의
  }

  // ── 담당자별 「계획 총목표」 (0215) ────────────────────────────────
  //   커미셔너 계약은 **본인 고객 전체를 합쳐 2027-12 까지 300만 페소(IVA 제외)** 다.
  //   그 숫자를 화면에 상수로 박으면 사람마다 다른 조건을 줄 수 없고 바꿀 때마다
  //   재배포해야 한다. 행이 없으면 기본값으로 도는 한 줄짜리 등록부를 둔다 —
  //   0215 를 적용하기 전에도 화면은 기본값으로 정상 동작한다.
  const DEFAULT_GOAL = 3000000;
  const DEFAULT_GOAL_END = '2027-12';
  async function loadAgentGoal(userId) {
    try {
      const r = (await query(
        `SELECT goal_amount, to_char(horizon_end,'YYYY-MM') AS hz FROM agent_plan_goals WHERE user_id=$1`,
        [userId])).rows[0];
      if (r) return { goal_amount: Number(r.goal_amount), horizon: r.hz, stored: true };
    } catch (e) { /* 0215 미적용 — 기본값으로 */ }
    return { goal_amount: DEFAULT_GOAL, horizon: DEFAULT_GOAL_END, stored: false };
  }
  // 그 사람이 담당하는 **모든 고객**(팀 무관)의 계획 합계와 실적 합계.
  //   진척은 «이 팀의 이 기간» 이 아니라 «계약 전체» 기준이라야 의미가 있다.
  async function agentProgress(userId) {
    const g = await loadAgentGoal(userId);
    const plan = Number((await query(
      `SELECT COALESCE(SUM(t.amount),0) AS s
         FROM target_customer_months t JOIN customers c ON c.id=t.customer_id
        WHERE c.owner_id=$1 AND c.deleted_at IS NULL AND t.ym <= $2`, [userId, g.horizon])).rows[0].s);
    const actual = Number((await query(
      `SELECT COALESCE(SUM(i.subtotal_mxn),0) AS s
         FROM sales_invoices i JOIN customers c ON c.id=i.customer_id
        WHERE c.owner_id=$1 AND c.deleted_at IS NULL AND i.status='posted'
          AND to_char(i.inv_date,'YYYY-MM') <= $2`, [userId, g.horizon])).rows[0].s);
    return {
      goal_amount: r2(g.goal_amount), horizon: g.horizon, goal_stored: g.stored,
      plan_total: r2(plan), actual_total: r2(actual),
      remaining: r2(Math.max(0, g.goal_amount - plan)),
      reached: plan >= g.goal_amount,
      pct: g.goal_amount > 0 ? Math.round((plan / g.goal_amount) * 1000) / 10 : 0,
    };
  }

  // 그 팀에 담당 고객이 있는 사람들의 진척 목록(팀 계획자용).
  async function teamAgentsProgress(teamId) {
    const owners = (await query(
      `SELECT DISTINCT c.owner_id AS id, u.name
         FROM customers c JOIN users u ON u.id=c.owner_id
        WHERE c.team_id=$1 AND c.deleted_at IS NULL AND c.owner_id IS NOT NULL
        ORDER BY u.name`, [teamId])).rows;
    const out = [];
    for (const o of owners) {
      out.push({ user_id: Number(o.id), name: o.name, ...(await agentProgress(Number(o.id))) });
    }
    return out;
  }

  const MAX_MONTHS = 24;
  function horizonMonths(q) {
    const start = String(q?.start || currentYm()).slice(0, 7);
    const end = String(q?.end || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(end)) {
      const ms = monthsInclusive(start, end);
      if (ms.length) return ms.slice(0, MAX_MONTHS);   // 끝월이 시작월보다 앞이면 빈 배열 → 기본으로 폴백
    }
    return monthsHorizon(start, 12);
  }

  app.get('/api/targets/overview', { preHandler: [authGuard, requirePage('targets')] }, async (req) => {
    const vis = visibleTeamIds(req.ctx.perm);   // null = 전체(디렉터·영업지원)
    const seeAll = (vis === null);
    const months = horizonMonths(req.query);
    const company = (await query(`SELECT ym, amount FROM monthly_targets WHERE ym = ANY($1)`, [months])).rows;
    let teams = (await query(`SELECT id, name, is_sales FROM sales_teams WHERE deleted_at IS NULL AND is_sales=true ORDER BY sort_order, id`)).rows;
    // 자기 가시 팀만 (영업 담당은 소속팀만 — 타 팀 목표 비공개)
    //   + 담당 고객이 있는 팀은 소속팀이 아니어도 목록에 넣는다. 커미셔너의 고객이
    //     `00_CTR Recomendation` 같은 공용 팀에 붙으면, 그 팀이 선택지에 없어서
    //     자기 고객 목표를 넣을 화면 자체에 못 들어가는 일이 생긴다.
    if (!seeAll) {
      const ownTeams = (await query(
        `SELECT DISTINCT team_id FROM customers
          WHERE owner_id=$1 AND team_id IS NOT NULL AND deleted_at IS NULL`,
        [Number(req.ctx.perm.userId)])).rows.map((r) => Number(r.team_id));
      const allowed = new Set([...vis.map(Number), ...ownTeams]);
      teams = teams.filter((t) => allowed.has(Number(t.id)));
    }
    const visibleTeamSet = new Set(teams.map((t) => Number(t.id)));
    const teamMonthsAll = (await query(`SELECT team_id, ym, amount FROM target_team_months WHERE ym = ANY($1)`, [months])).rows;
    const teamMonths = teamMonthsAll.filter((r) => visibleTeamSet.has(Number(r.team_id)));
    const teamSum = sumByMonth(teamMonths.map((r) => ({ ym: r.ym, amount: r.amount })));
    const companyByMonth = sumByMonth(company.map((r) => ({ ym: r.ym, amount: r.amount })));
    const teamByMonthByTeam = {};
    for (const t of teams) teamByMonthByTeam[t.id] = {};
    for (const r of teamMonths) (teamByMonthByTeam[r.team_id] ||= {})[r.ym] = Number(r.amount);
    const statuses = (await query(`SELECT team_id, status FROM target_team_status`)).rows;
    const statusByTeam = {}; for (const s of statuses) statusByTeam[s.team_id] = s.status;
    // 팀별 실적 + 미달분 이월(당월목표) — 표시월들의 각 해 1월부터 replay
    const teamIds = teams.map((t) => Number(t.id));
    const needMs = neededMonths(months);
    const ba = await teamBaseActual(teamIds, needMs);
    const carryByTeam = {};
    for (const tid of teamIds) carryByTeam[tid] = carryoverByMonth(needMs, ba.base[tid] || {}, ba.actual[tid] || {});
    // 전체 = 팀별로 각자 이월 계산 후 월별 합산 (스펙: 전사 단일 이월 아님)
    const carryTotal = {};
    for (const ym of needMs) {
      let b = 0, ci = 0, ef = 0, av = 0, rm = 0;
      for (const tid of teamIds) {
        const e = (carryByTeam[tid] || {})[ym]; if (!e) continue;
        b = r2(b + e.base); ci = r2(ci + e.carryIn); ef = r2(ef + e.effective); av = r2(av + e.actual); rm = r2(rm + e.remaining);
      }
      carryTotal[ym] = { base: b, carryIn: ci, effective: ef, actual: av, remaining: rm };
    }
    return {
      months,
      current_ym: currentYm(),
      carry_months: needMs,
      // 회사 합계·검증은 전체 팀이 보일 때만(타 팀 금액 역산 방지)
      company: seeAll ? companyByMonth : {},
      teams: teams.map((t) => ({
        id: t.id, name: t.name, months: teamByMonthByTeam[t.id] || {}, status: statusByTeam[t.id] || 'draft',
        actuals: ba.actual[Number(t.id)] || {},               // 팀 실적(posted ex-IVA, inv_date)
        carry: carryByTeam[Number(t.id)] || {},               // {ym:{base,carryIn,effective,actual,remaining}}
      })),
      check: seeAll ? companyVsTeams(months, companyByMonth, teamSum) : [],
      carry_total: seeAll ? carryTotal : null,                // 가시 전체 합(디렉터·영업지원만)
    };
  });

  // 전체 월 목표 저장(디렉터)
  app.post('/api/targets/company', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const rows = Array.isArray(req.body?.months) ? req.body.months : [];
    for (const r of rows) {
      if (!/^\d{4}-\d{2}$/.test(r.ym || '')) continue;
      await query(
        `INSERT INTO monthly_targets (ym, amount, updated_by) VALUES ($1,$2,$3)
         ON CONFLICT (ym) DO UPDATE SET amount=$2, updated_by=$3, updated_at=now()`,
        [r.ym, r2(r.amount || 0), req.ctx.perm.userId]);
    }
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: 'target_company' });
    return { ok: true };
  });

  // 팀 월 목표 저장(디렉터)
  app.post('/api/targets/team/:teamId', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const teamId = Number(req.params.teamId);
    const rows = Array.isArray(req.body?.months) ? req.body.months : [];
    for (const r of rows) {
      if (!/^\d{4}-\d{2}$/.test(r.ym || '')) continue;
      await query(
        `INSERT INTO target_team_months (team_id, ym, amount, updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (team_id, ym) DO UPDATE SET amount=$3, updated_by=$4, updated_at=now()`,
        [teamId, r.ym, r2(r.amount || 0), req.ctx.perm.userId]);
    }
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `target_team:${teamId}` });
    return { ok: true };
  });

  // 팀 상세: 그 팀의 고객들(요약 한 줄) + 고객 월 목표 + 팀 목표 대비 부족분 + 실적
  app.get('/api/targets/team/:teamId', { preHandler: [authGuard, requirePage('targets')] }, async (req, reply) => {
    const teamId = Number(req.params.teamId);
    const perm = req.ctx.perm;
    const teamEditor = isTeamEditor(perm, teamId);
    const owned = await ownedInTeam(perm, teamId);
    // 담당 고객이 그 팀에 있으면, 소속팀이 아니어도 그 팀을 연다 —
    //   커미셔너의 고객이 `00_CTR Recomendation` 같은 공용 팀에 붙는 운영을 지원한다.
    if (!canViewTeam(perm, teamId) && owned.size === 0) {
      return reply.code(403).send({ error: 'forbidden_team' });
    }
    const months = horizonMonths(req.query);
    // 고객 한 줄 요약(이름·종류·단계·미수·할인·메모)
    // 팀 계획 권한이 없는 사람(커미셔너)에게는 **자기 담당 고객만** 보인다.
    //   남의 고객 이름·미수·할인·실적이 한 줄이라도 보이면 계약 전제가 깨진다.
    const custs = (await query(
      `SELECT c.id, c.code, c.name, c.customer_type, c.discount, c.memo, s.name AS stage_name,
              c.owner_id, o.name AS owner_name,
              COALESCE(ar.outstanding,0) AS outstanding, COALESCE(ar.overdue,0) AS overdue
         FROM customers c
         LEFT JOIN stages s ON s.id=c.stage_id
         LEFT JOIN users o ON o.id=c.owner_id
         LEFT JOIN (
           SELECT i.customer_id,
                  SUM(i.total_mxn - COALESCE(p.paid,0)) AS outstanding,
                  SUM(CASE WHEN i.due_date < CURRENT_DATE THEN (i.total_mxn - COALESCE(p.paid,0)) ELSE 0 END) AS overdue
             FROM sales_invoices i
             LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p ON p.invoice_id=i.id
            WHERE i.status='posted' GROUP BY i.customer_id
         ) ar ON ar.customer_id=c.id
        WHERE c.team_id=$1 AND c.deleted_at IS NULL
          AND ($2::bigint IS NULL OR c.owner_id=$2) ORDER BY c.name`,
      [teamId, teamEditor ? null : Number(perm.userId)])).rows;
    const custIds = custs.map((c) => c.id);
    const alloc = custIds.length ? (await query(
      `SELECT customer_id, ym, amount FROM target_customer_months WHERE customer_id = ANY($1) AND ym = ANY($2)`,
      [custIds, months])).rows : [];
    const allocByCust = {};
    for (const a of alloc) (allocByCust[a.customer_id] ||= {})[a.ym] = Number(a.amount);
    // 실적: 고객별 월 매출(posted · IVA 제외 subtotal — 목표와 동일 기준)
    const actuals = custIds.length ? (await query(
      `SELECT customer_id, to_char(inv_date,'YYYY-MM') AS ym, SUM(subtotal_mxn) AS amt
         FROM sales_invoices WHERE customer_id = ANY($1) AND status='posted' AND to_char(inv_date,'YYYY-MM') = ANY($2)
        GROUP BY customer_id, to_char(inv_date,'YYYY-MM')`, [custIds, months])).rows : [];
    const actualByCust = {};
    for (const a of actuals) (actualByCust[a.customer_id] ||= {})[a.ym] = Number(a.amt);
    // 팀 목표(월)
    const tm = (await query(`SELECT ym, amount FROM target_team_months WHERE team_id=$1 AND ym = ANY($2)`, [teamId, months])).rows;
    const teamByMonth = {}; for (const r of tm) teamByMonth[r.ym] = Number(r.amount);
    const custSum = sumByMonth(alloc.map((a) => ({ ym: a.ym, amount: a.amount })));
    const st = (await query(`SELECT status, note FROM target_team_status WHERE team_id=$1`, [teamId])).rows[0];
    return {
      months,
      team_id: teamId,
      team_months: teamByMonth,
      status: st?.status || 'draft',
      note: st?.note || null,
      shortfall: shortfallByMonth(months, teamByMonth, custSum),
      cust_sum: custSum,
      actual_sum: sumByMonth(actuals.map((a) => ({ ym: a.ym, amount: a.amt }))),   // 월별 실적 합(IVA 제외)
      customers: custs.map((c) => ({
        id: c.id, code: c.code, name: c.name, customer_type: c.customer_type, stage_name: stageLabel(c.stage_name),
        discount: Number(c.discount), memo: c.memo, outstanding: r2(c.outstanding), overdue: r2(c.overdue),
        owner_id: c.owner_id == null ? null : Number(c.owner_id), owner_name: c.owner_name || null,
        // 줄 단위 편집권 — 팀 계획자는 전부, 그 외에는 **내가 담당인 줄만**.
        can_edit: teamEditor || owned.has(Number(c.id)),
        alloc: allocByCust[c.id] || {}, actual: actualByCust[c.id] || {},
      })),
      can_edit: teamEditor,
      can_edit_own: owned.size > 0,
      team_editor: teamEditor,
      // 본인 담당 고객 전체의 계획 합계 vs 총 매출목표 — 커미셔너 화면의 진척 바.
      my_progress: owned.size > 0 ? await agentProgress(Number(perm.userId)) : null,
      // 팀 계획자에게는 담당자별 진척을 한 표로 — 누가 계약 목표를 못 채웠는지 한눈에.
      agents_progress: teamEditor ? await teamAgentsProgress(teamId) : null,
    };
  });

  // 고객 월 목표 저장(담당자/디렉터). 저장 시 팀 상태 draft로(재승인 필요)
  //   권한은 두 갈래다:
  //     · 팀 계획자(디렉터 / targets=수정) → 그 팀의 모든 고객 줄
  //     · 그 외(커미셔너 등)            → **내가 담당인 고객 줄만**
  //   그래서 가드를 `requirePageEdit` 에서 `requirePage` 로 낮추고, 실제 판정은
  //   줄마다 소유권으로 한다. 열람 권한만 있는 사람이 남의 줄을 건드릴 수는 없다.
  app.post('/api/targets/customers', { preHandler: [authGuard, requirePage('targets')] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const teamId = Number(req.body?.team_id);
    if (!teamId) return reply.code(400).send({ error: 'team_required' });
    const teamEditor = isTeamEditor(perm, teamId);
    const owned = await ownedInTeam(perm, teamId);
    if (!teamEditor && owned.size === 0) return reply.code(403).send({ error: 'forbidden_team' });
    const rows = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
    let saved = 0, skipped = 0;
    // 보안: 넘어온 고객이 정말 이 팀 소속인지 확인
    const ids = [...new Set(rows.map((r) => Number(r.customer_id)))];
    if (ids.length) {
      const ok = (await query(`SELECT id FROM customers WHERE id = ANY($1) AND team_id=$2 AND deleted_at IS NULL`, [ids, teamId])).rows;
      const okSet = new Set(ok.map((r) => Number(r.id)));   // pg bigint→string 이므로 Number로 통일
      for (const r of rows) {
        if (!okSet.has(Number(r.customer_id)) || !/^\d{4}-\d{2}$/.test(r.ym || '')) { skipped += 1; continue; }
        if (!teamEditor && !owned.has(Number(r.customer_id))) { skipped += 1; continue; }   // 남의 담당 고객
        await query(
          `INSERT INTO target_customer_months (customer_id, ym, amount, updated_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (customer_id, ym) DO UPDATE SET amount=$3, updated_by=$4, updated_at=now()`,
          [Number(r.customer_id), r.ym, r2(r.amount || 0), req.ctx.perm.userId]);
        saved += 1;
      }
    }
    // 편집되면 승인 상태를 draft로 되돌림
    await query(
      `INSERT INTO target_team_status (team_id, status, updated_at) VALUES ($1,'draft',now())
       ON CONFLICT (team_id) DO UPDATE SET status='draft', updated_at=now()`, [teamId]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `target_customers:${teamId}` });
    return { ok: true, saved, skipped };
  });

  // 커미셔너 온보딩 게이트 — 「안내서를 먼저 봐야 하는 사람인가」.
  //   계약 총목표를 **고객별로 다 배분하기 전까지** 로그인하면 안내서로 보낸다.
  //   본인 것만 묻는 조회라 페이지 권한을 요구하지 않는다(authGuard 만).
  //
  //   대상은 «안내서 권한(guiacom)이 켜진 비디렉터» 로 좁힌다.
  //   목표 미달만으로 판정하면 목표를 안 쓰는 직원·디렉터까지 안내서로 끌려간다.
  app.get('/api/targets/my-plan-status', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const pages = perm.pages || {};
    const hasGuide = Object.prototype.hasOwnProperty.call(pages, 'guiacom');
    const p = await agentProgress(Number(perm.userId));
    return {
      ...p,
      has_guide: hasGuide,
      needs_guide: hasGuide && perm.role !== 'director' && !p.reached,
    };
  });

  // 담당자별 「계획 총목표」 설정 — 디렉터만.
  //   커미셔너마다 계약 금액·기간이 다를 수 있어 사람 단위로 저장한다.
  app.put('/api/targets/agent-goal', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const uid = Number(req.body?.user_id);
    if (!uid) return reply.code(400).send({ error: 'user_required' });
    const amount = r2(Number(req.body?.goal_amount) || 0);
    if (!(amount >= 0)) return reply.code(400).send({ error: 'bad_amount' });
    const hz = String(req.body?.horizon || DEFAULT_GOAL_END).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(hz)) return reply.code(400).send({ error: 'bad_horizon' });
    try {
      await query(
        `INSERT INTO agent_plan_goals (user_id, goal_amount, horizon_end, updated_by, updated_at)
         VALUES ($1,$2,($3||'-01')::date,$4,now())
         ON CONFLICT (user_id) DO UPDATE SET goal_amount=$2, horizon_end=($3||'-01')::date,
               updated_by=$4, updated_at=now()`,
        [uid, amount, hz, Number(req.ctx.perm.userId)]);
    } catch (e) {
      return reply.code(500).send({ error: 'migration_required',
        note: '서버 업데이트(0215)가 아직 적용되지 않았습니다. Railway 콘솔에서 npm run migrate 를 실행하세요.' });
    }
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `agent_goal:${uid}` });
    return { ok: true, ...(await agentProgress(uid)) };
  });

  // 팀 계획 제출(담당자) → submitted
  app.post('/api/targets/team/:teamId/submit', { preHandler: [authGuard, requirePageEdit('targets')] }, async (req, reply) => {
    const teamId = Number(req.params.teamId);
    if (!canEditTeam(req.ctx.perm, teamId)) return reply.code(403).send({ error: 'forbidden_team' });
    await query(
      `INSERT INTO target_team_status (team_id, status, submitted_by, submitted_at, updated_at)
       VALUES ($1,'submitted',$2,now(),now())
       ON CONFLICT (team_id) DO UPDATE SET status='submitted', submitted_by=$2, submitted_at=now(), updated_at=now()`,
      [teamId, req.ctx.perm.userId]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `target_submit:${teamId}` });
    return { ok: true };
  });

  // 팀 계획 승인/반려(디렉터)
  app.post('/api/targets/team/:teamId/decide', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const teamId = Number(req.params.teamId);
    const approve = req.body?.approve === true;
    const note = req.body?.note || null;
    await query(
      `INSERT INTO target_team_status (team_id, status, note, decided_by, decided_at, updated_at)
       VALUES ($1,$2,$3,$4,now(),now())
       ON CONFLICT (team_id) DO UPDATE SET status=$2, note=$3, decided_by=$4, decided_at=now(), updated_at=now()`,
      [teamId, approve ? 'approved' : 'rejected', note, req.ctx.perm.userId]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `target_decide:${teamId}`, detail: { approve } });
    return { ok: true };
  });
}
