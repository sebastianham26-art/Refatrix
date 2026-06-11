import { query } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { visibleTeamIds, canViewTeam, canEditTeam } from '../teams.js';
import { monthsHorizon, currentYm, sumByMonth, shortfallByMonth, companyVsTeams, r2 } from '../salesTarget.js';

async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }

export default async function targetRoutes(app) {
  // 목표 페이지 개요: 전체 월 목표 + 팀별 월 목표 + 팀 합 검증 (디렉터 중심, 영업은 자기 팀만)
  app.get('/api/targets/overview', { preHandler: [authGuard, requirePage('targets')] }, async (req) => {
    const start = String(req.query.start || currentYm());
    const months = monthsHorizon(start, 12);
    const company = (await query(`SELECT ym, amount FROM monthly_targets WHERE ym = ANY($1)`, [months])).rows;
    const teams = (await query(`SELECT id, name, is_sales FROM sales_teams WHERE deleted_at IS NULL AND is_sales=true ORDER BY sort_order, id`)).rows;
    const teamMonths = (await query(`SELECT team_id, ym, amount FROM target_team_months WHERE ym = ANY($1)`, [months])).rows;
    const teamSum = sumByMonth(teamMonths.map((r) => ({ ym: r.ym, amount: r.amount })));
    const companyByMonth = sumByMonth(company.map((r) => ({ ym: r.ym, amount: r.amount })));
    const teamByMonthByTeam = {};
    for (const t of teams) teamByMonthByTeam[t.id] = {};
    for (const r of teamMonths) (teamByMonthByTeam[r.team_id] ||= {})[r.ym] = Number(r.amount);
    const statuses = (await query(`SELECT team_id, status FROM target_team_status`)).rows;
    const statusByTeam = {}; for (const s of statuses) statusByTeam[s.team_id] = s.status;
    return {
      months,
      company: companyByMonth,
      teams: teams.map((t) => ({ id: t.id, name: t.name, months: teamByMonthByTeam[t.id] || {}, status: statusByTeam[t.id] || 'draft' })),
      check: companyVsTeams(months, companyByMonth, teamSum),
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
    // 실적: 고객별 월 매출(posted)
    const actuals = custIds.length ? (await query(
      `SELECT customer_id, to_char(inv_date,'YYYY-MM') AS ym, SUM(total_mxn) AS amt
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
      customers: custs.map((c) => ({
        id: c.id, code: c.code, name: c.name, customer_type: c.customer_type, stage_name: c.stage_name,
        discount: Number(c.discount), memo: c.memo, outstanding: r2(c.outstanding), overdue: r2(c.overdue),
        alloc: allocByCust[c.id] || {}, actual: actualByCust[c.id] || {},
      })),
      can_edit: canEditTeam(req.ctx.perm, teamId),
    };
  });

  // 고객 월 목표 저장(담당자/디렉터). 저장 시 팀 상태 draft로(재승인 필요)
  app.post('/api/targets/customers', { preHandler: [authGuard, requirePage('targets')] }, async (req, reply) => {
    const teamId = Number(req.body?.team_id);
    if (!teamId) return reply.code(400).send({ error: 'team_required' });
    if (!canEditTeam(req.ctx.perm, teamId)) return reply.code(403).send({ error: 'forbidden_team' });
    const rows = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
    // 보안: 넘어온 고객이 정말 이 팀 소속인지 확인
    const ids = [...new Set(rows.map((r) => Number(r.customer_id)))];
    if (ids.length) {
      const ok = (await query(`SELECT id FROM customers WHERE id = ANY($1) AND team_id=$2 AND deleted_at IS NULL`, [ids, teamId])).rows;
      const okSet = new Set(ok.map((r) => r.id));
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
  app.post('/api/targets/team/:teamId/submit', { preHandler: [authGuard, requirePage('targets')] }, async (req, reply) => {
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
