import { query } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { visibleTeamIds, canViewTeam, canEditTeam } from '../teams.js';
import { monthsHorizon, currentYm, allocSumByMonth, allocByCustomerMonth, budgetVsAlloc, allocCost, r2 } from '../marketingAlloc.js';

async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }
function isMarketing(perm) { return perm.role === 'director' || perm.role === 'marketing'; }

export default async function marketingRoutes(app) {
  // 메뉴판(활동·단가) 조회 — 모두 보기 가능
  app.get('/api/marketing/menu', { preHandler: [authGuard, requirePage('marketing')] }, async () => {
    const rows = (await query(
      `SELECT id, name, category, unit_budget, unit FROM activity_catalog WHERE deleted_at IS NULL ORDER BY category, name`)).rows;
    return { items: rows.map((r) => ({ id: r.id, name: r.name, category: r.category, unit_budget: Number(r.unit_budget), unit: r.unit })) };
  });

  // 메뉴 항목 작성/수정/삭제 — 마케팅·디렉터
  app.post('/api/marketing/menu', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    if (!isMarketing(req.ctx.perm)) return reply.code(403).send({ error: 'marketing_only' });
    const b = req.body || {};
    if (!b.name) return reply.code(400).send({ error: 'name_required' });
    const row = (await query(
      `INSERT INTO activity_catalog (name, category, category_code, unit_budget, unit) VALUES ($1,$2,'6070',$3,$4) RETURNING id`,
      [b.name, b.category || null, Number(b.unit_budget) || 0, b.unit || null])).rows[0];
    await safeLog({ userId: req.ctx.perm.userId, action: 'create', target: `menu:${row.id}` });
    return { ok: true, id: row.id };
  });
  app.patch('/api/marketing/menu/:id', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    if (!isMarketing(req.ctx.perm)) return reply.code(403).send({ error: 'marketing_only' });
    const id = Number(req.params.id); const b = req.body || {};
    await query(`UPDATE activity_catalog SET name=COALESCE($1,name), category=COALESCE($2,category), unit_budget=COALESCE($3,unit_budget), unit=COALESCE($4,unit) WHERE id=$5`,
      [b.name || null, b.category || null, b.unit_budget != null ? Number(b.unit_budget) : null, b.unit || null, id]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `menu:${id}` });
    return { ok: true };
  });
  app.delete('/api/marketing/menu/:id', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    if (!isMarketing(req.ctx.perm)) return reply.code(403).send({ error: 'marketing_only' });
    const id = Number(req.params.id);
    await query(`UPDATE activity_catalog SET deleted_at=now() WHERE id=$1`, [id]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'delete', target: `menu:${id}` });
    return { ok: true };
  });

  // 개요: 전체 마케팅 월 예산 + 배분 합 + 잔여/초과 + 승인상태 (탑 현황판)
  app.get('/api/marketing/overview', { preHandler: [authGuard, requirePage('marketing')] }, async (req) => {
    const start = String(req.query.start || currentYm());
    const months = monthsHorizon(start, 12);
    const budget = (await query(`SELECT ym, amount FROM marketing_budget_months WHERE ym = ANY($1)`, [months])).rows;
    const budgetByMonth = {}; for (const r of budget) budgetByMonth[r.ym] = Number(r.amount);
    const alloc = (await query(
      `SELECT ym, qty, unit_budget FROM marketing_alloc WHERE ym = ANY($1)`, [months])).rows;
    const allocByMonth = allocSumByMonth(alloc);
    const st = (await query(`SELECT status, note FROM marketing_plan_status WHERE id=1`)).rows[0];
    return {
      months, budget: budgetByMonth,
      check: budgetVsAlloc(months, budgetByMonth, allocByMonth),
      alloc_sum: allocByMonth,
      status: st?.status || 'draft', note: st?.note || null,
    };
  });

  // 전체 마케팅 월 예산 저장 — 마케팅·디렉터
  app.post('/api/marketing/budget', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    if (!isMarketing(req.ctx.perm)) return reply.code(403).send({ error: 'marketing_only' });
    const rows = Array.isArray(req.body?.months) ? req.body.months : [];
    for (const r of rows) {
      if (!/^\d{4}-\d{2}$/.test(r.ym || '')) continue;
      await query(`INSERT INTO marketing_budget_months (ym, amount, updated_by) VALUES ($1,$2,$3)
        ON CONFLICT (ym) DO UPDATE SET amount=$2, updated_by=$3, updated_at=now()`,
        [r.ym, r2(r.amount || 0), req.ctx.perm.userId]);
    }
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: 'marketing_budget' });
    return { ok: true };
  });

  // 고객 목록 + 고객×월 배분 합(팀 가시성). 배분 상세는 customer별로.
  app.get('/api/marketing/customers', { preHandler: [authGuard, requirePage('marketing')] }, async (req) => {
    const vis = visibleTeamIds(req.ctx.perm);
    const start = String(req.query.start || currentYm());
    const months = monthsHorizon(start, 12);
    const conds = ['c.deleted_at IS NULL']; const params = [];
    if (vis !== null) { if (!vis.length) return { months, customers: [] };
      params.push(vis); conds.push(`c.team_id = ANY($${params.length})`); }
    const custs = (await query(
      `SELECT c.id, c.code, c.name, c.customer_type, t.name AS team_name, s.name AS stage_name
         FROM customers c LEFT JOIN sales_teams t ON t.id=c.team_id LEFT JOIN stages s ON s.id=c.stage_id
        WHERE ${conds.join(' AND ')} ORDER BY c.name`, params)).rows;
    const ids = custs.map((c) => c.id);
    const alloc = ids.length ? (await query(
      `SELECT customer_id, ym, qty, unit_budget FROM marketing_alloc WHERE customer_id = ANY($1) AND ym = ANY($2)`, [ids, months])).rows : [];
    const byCust = allocByCustomerMonth(alloc);
    return {
      months,
      customers: custs.map((c) => ({
        id: c.id, code: c.code, name: c.name, customer_type: c.customer_type,
        team_name: c.team_name, stage_name: c.stage_name,
        month_cost: byCust[c.id] || {},
      })),
    };
  });

  // 한 고객의 월별 활동 수량 배분 상세
  app.get('/api/marketing/alloc', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    const customerId = Number(req.query.customer_id);
    if (!customerId) return reply.code(400).send({ error: 'customer_required' });
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const start = String(req.query.start || currentYm());
    const months = monthsHorizon(start, 12);
    const rows = (await query(
      `SELECT catalog_id, ym, qty FROM marketing_alloc WHERE customer_id=$1 AND ym = ANY($2)`, [customerId, months])).rows;
    // {catalog_id: {ym: qty}}
    const grid = {};
    for (const r of rows) { (grid[r.catalog_id] ||= {})[r.ym] = Number(r.qty); }
    return { months, grid, can_edit: isMarketing(req.ctx.perm) };
  });

  // 고객 월별 활동 수량 저장 — 마케팅·디렉터. 저장 시 승인상태 draft로.
  app.post('/api/marketing/alloc', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    if (!isMarketing(req.ctx.perm)) return reply.code(403).send({ error: 'marketing_only' });
    const b = req.body || {};
    const customerId = Number(b.customer_id);
    if (!customerId) return reply.code(400).send({ error: 'customer_required' });
    const rows = Array.isArray(b.items) ? b.items : [];   // [{catalog_id, ym, qty}]
    // 단가 스냅샷
    const menu = (await query(`SELECT id, unit_budget FROM activity_catalog WHERE deleted_at IS NULL`)).rows;
    const unitById = {}; for (const m of menu) unitById[m.id] = Number(m.unit_budget);
    for (const r of rows) {
      if (!/^\d{4}-\d{2}$/.test(r.ym || '') || unitById[r.catalog_id] == null) continue;
      const qty = Number(r.qty) || 0;
      if (qty <= 0) {
        await query(`DELETE FROM marketing_alloc WHERE customer_id=$1 AND ym=$2 AND catalog_id=$3`, [customerId, r.ym, r.catalog_id]);
      } else {
        await query(
          `INSERT INTO marketing_alloc (customer_id, ym, catalog_id, qty, unit_budget, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (customer_id, ym, catalog_id) DO UPDATE SET qty=$4, unit_budget=$5, updated_by=$6, updated_at=now()`,
          [customerId, r.ym, r.catalog_id, qty, unitById[r.catalog_id], req.ctx.perm.userId]);
      }
    }
    await query(`UPDATE marketing_plan_status SET status='draft', updated_at=now() WHERE id=1`);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `marketing_alloc:${customerId}` });
    return { ok: true };
  });

  // 제출(마케팅) → submitted
  app.post('/api/marketing/submit', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    if (!isMarketing(req.ctx.perm)) return reply.code(403).send({ error: 'marketing_only' });
    await query(`UPDATE marketing_plan_status SET status='submitted', submitted_by=$1, submitted_at=now(), updated_at=now() WHERE id=1`, [req.ctx.perm.userId]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: 'marketing_submit' });
    return { ok: true };
  });

  // 승인/반려(디렉터)
  app.post('/api/marketing/decide', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const approve = req.body?.approve === true;
    await query(`UPDATE marketing_plan_status SET status=$1, note=$2, decided_by=$3, decided_at=now(), updated_at=now() WHERE id=1`,
      [approve ? 'approved' : 'rejected', req.body?.note || null, req.ctx.perm.userId]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: 'marketing_decide', detail: { approve } });
    return { ok: true };
  });

  // ===== 메모 게시판(전체 또는 고객별) =====
  app.get('/api/marketing/notes', { preHandler: [authGuard, requirePage('marketing')] }, async (req) => {
    const customerId = req.query.customer_id ? Number(req.query.customer_id) : null;
    const where = customerId ? `customer_id=$1` : `customer_id IS NULL`;
    const params = customerId ? [customerId] : [];
    const rows = (await query(
      `SELECT n.id, n.note, n.author_role, u.name AS author_name, to_char(n.created_at,'YYYY-MM-DD HH24:MI') AS created_at, n.customer_id
         FROM marketing_notes n LEFT JOIN users u ON u.id=n.author_id
        WHERE ${where} AND n.deleted_at IS NULL ORDER BY n.created_at ASC, n.id ASC LIMIT 200`, params)).rows;
    return { items: rows };
  });
  // 메모 작성 — 전원(영업 포함)
  app.post('/api/marketing/notes', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    const b = req.body || {};
    if (!b.note || !String(b.note).trim()) return reply.code(400).send({ error: 'note_required' });
    const customerId = b.customer_id ? Number(b.customer_id) : null;
    const row = (await query(
      `INSERT INTO marketing_notes (customer_id, note, author_id, author_role) VALUES ($1,$2,$3,$4) RETURNING id`,
      [customerId, String(b.note).trim(), req.ctx.perm.userId, req.ctx.perm.role])).rows[0];
    await safeLog({ userId: req.ctx.perm.userId, action: 'create', target: `marketing_note:${row.id}` });
    return { ok: true, id: row.id };
  });
  // 메모 삭제(작성자 또는 디렉터)
  app.delete('/api/marketing/notes/:id', { preHandler: [authGuard, requirePage('marketing')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const n = (await query(`SELECT author_id FROM marketing_notes WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!n) return reply.code(404).send({ error: 'not_found' });
    if (req.ctx.perm.role !== 'director' && Number(n.author_id) !== req.ctx.perm.userId) return reply.code(403).send({ error: 'forbidden' });
    await query(`UPDATE marketing_notes SET deleted_at=now() WHERE id=$1`, [id]);
    return { ok: true };
  });
}
