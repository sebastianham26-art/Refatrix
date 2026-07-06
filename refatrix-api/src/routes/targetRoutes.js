import { query } from '../db.js';
import { authGuard, requirePage, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { visibleTeamIds, canViewTeam, canEditTeam } from '../teams.js';
import { monthsHorizon, currentYm, sumByMonth, shortfallByMonth, companyVsTeams, carryoverByMonth, r2 } from '../salesTarget.js';

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
  app.get('/api/targets/overview', { preHandler: [authGuard, requirePage('targets')] }, async (req) => {
    const vis = visibleTeamIds(req.ctx.perm);   // null = 전체(디렉터·영업지원)
    const seeAll = (vis === null);
    const start = String(req.query.start || currentYm());
    const months = monthsHorizon(start, 12);
    const company = (await query(`SELECT ym, amount FROM monthly_targets WHERE ym = ANY($1)`, [months])).rows;
    let teams = (await query(`SELECT id, name, is_sales FROM sales_teams WHERE deleted_at IS NULL AND is_sales=true ORDER BY sort_order, id`)).rows;
    // 자기 가시 팀만 (영업 담당은 소속팀만 — 타 팀 목표 비공개)
    if (!seeAll) teams = teams.filter((t) => vis.includes(Number(t.id)));
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
    if (!canViewTeam(req.ctx.perm, teamId)) return reply.code(403).send({ error: 'forbidden_team' });
    const start = String(req.query.start || currentYm());
    const months = monthsHorizon(start, 12);
    // 고객 한 줄 요약(이름·종류·단계·미수·할인·메모)
    const custs = (await query(
      `SELECT c.id, c.code, c.name, c.customer_type, c.discount, c.memo, s.name AS stage_name,
              COALESCE(ar.outstanding,0) AS outstanding, COALESCE(ar.overdue,0) AS overdue
         FROM customers c
         LEFT JOIN stages s ON s.id=c.stage_id
         LEFT JOIN (
           SELECT i.customer_id,
                  SUM(i.total_mxn - COALESCE(p.paid,0)) AS outstanding,
                  SUM(CASE WHEN i.due_date < CURRENT_DATE THEN (i.total_mxn - COALESCE(p.paid,0)) ELSE 0 END) AS overdue
             FROM sales_invoices i
             LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p ON p.invoice_id=i.id
            WHERE i.status='posted' GROUP BY i.customer_id
         ) ar ON ar.customer_id=c.id
        WHERE c.team_id=$1 AND c.deleted_at IS NULL ORDER BY c.name`, [teamId])).rows;
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
        id: c.id, code: c.code, name: c.name, customer_type: c.customer_type, stage_name: c.stage_name,
        discount: Number(c.discount), memo: c.memo, outstanding: r2(c.outstanding), overdue: r2(c.overdue),
        alloc: allocByCust[c.id] || {}, actual: actualByCust[c.id] || {},
      })),
      can_edit: canEditTeam(req.ctx.perm, teamId),
    };
  });

  // 고객 월 목표 저장(담당자/디렉터). 저장 시 팀 상태 draft로(재승인 필요)
  app.post('/api/targets/customers', { preHandler: [authGuard, requirePageEdit('targets')] }, async (req, reply) => {
    const teamId = Number(req.body?.team_id);
    if (!teamId) return reply.code(400).send({ error: 'team_required' });
    if (!canEditTeam(req.ctx.perm, teamId)) return reply.code(403).send({ error: 'forbidden_team' });
    const rows = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
    // 보안: 넘어온 고객이 정말 이 팀 소속인지 확인
    const ids = [...new Set(rows.map((r) => Number(r.customer_id)))];
    if (ids.length) {
      const ok = (await query(`SELECT id FROM customers WHERE id = ANY($1) AND team_id=$2 AND deleted_at IS NULL`, [ids, teamId])).rows;
      const okSet = new Set(ok.map((r) => Number(r.id)));   // pg bigint→string 이므로 Number로 통일
      for (const r of rows) {
        if (!okSet.has(Number(r.customer_id)) || !/^\d{4}-\d{2}$/.test(r.ym || '')) continue;
        await query(
          `INSERT INTO target_customer_months (customer_id, ym, amount, updated_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (customer_id, ym) DO UPDATE SET amount=$3, updated_by=$4, updated_at=now()`,
          [Number(r.customer_id), r.ym, r2(r.amount || 0), req.ctx.perm.userId]);
      }
    }
    // 편집되면 승인 상태를 draft로 되돌림
    await query(
      `INSERT INTO target_team_status (team_id, status, updated_at) VALUES ($1,'draft',now())
       ON CONFLICT (team_id) DO UPDATE SET status='draft', updated_at=now()`, [teamId]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `target_customers:${teamId}` });
    return { ok: true };
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
