import { query, withTx } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { visibleTeamIds, canViewTeam, canEditTeam } from '../teams.js';

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }

export default async function customerRoutes(app) {
  // 팀 목록(고객 배정·필터용 = 영업팀만)
  app.get('/api/teams', { preHandler: [authGuard, requirePage('customers')] }, async () => {
    const rows = (await query(`SELECT id, name, sort_order FROM sales_teams WHERE deleted_at IS NULL AND is_sales=true ORDER BY sort_order, id`)).rows;
    return { items: rows.map((t) => ({ id: t.id, name: t.name })) };
  });

  // 소속 배정용 전체 팀(director 포함) — 팀 권한 관리 화면
  app.get('/api/team-admin/teams', { preHandler: [authGuard, requireDirector] }, async () => {
    const rows = (await query(`SELECT id, name, sort_order, is_sales FROM sales_teams WHERE deleted_at IS NULL ORDER BY sort_order, id`)).rows;
    return { items: rows.map((t) => ({ id: t.id, name: t.name, is_sales: t.is_sales })) };
  });

  // 다음 고객코드 자동생성(C-#### 순번)
  app.get('/api/customers/next-code', { preHandler: [authGuard, requirePage('customers')] }, async () => {
    const row = (await query(
      `SELECT COALESCE(MAX((regexp_replace(code,'\\D','','g'))::int),0) AS maxn
         FROM customers WHERE code ~ '^C-?\\d+$'`)).rows[0];
    const next = (Number(row.maxn) || 0) + 1;
    return { code: 'C-' + String(next).padStart(4, '0') };
  });

  // 고객 단계 목록
  app.get('/api/stages', { preHandler: [authGuard, requirePage('customers')] }, async () => {
    const rows = (await query(`SELECT id, name, sort_order FROM stages WHERE deleted_at IS NULL ORDER BY sort_order, id`)).rows;
    return { items: rows.map((s) => ({ id: s.id, name: s.name })) };
  });

  // 영업 담당(사용자) 목록 — 고객 배정용
  app.get('/api/sales-users', { preHandler: [authGuard, requirePage('customers')] }, async (req) => {
    const vis = visibleTeamIds(req.ctx.perm);
    let where = `deleted_at IS NULL AND role IN ('sales','director')`;
    const params = [];
    if (vis !== null) {
      if (!vis.length) return { items: [] };
      params.push(vis); where += ` AND (team_id = ANY($1) OR team_id IS NULL)`;
    }
    const rows = (await query(`SELECT id, name, team_id FROM users WHERE ${where} ORDER BY name`, params)).rows;
    return { items: rows.map((u) => ({ id: u.id, name: u.name, team_id: u.team_id })) };
  });

  // 고객 목록: 팀 가시성 적용 + 검색 + 미수/연체 요약
  app.get('/api/customers', { preHandler: [authGuard, requirePage('customers')] }, async (req) => {
    const { perm } = req.ctx;
    const vis = visibleTeamIds(perm);
    const q = String(req.query.q || '').trim();
    const teamFilter = req.query.team_id ? Number(req.query.team_id) : null;
    const conds = ['c.deleted_at IS NULL']; const params = [];
    if (vis !== null) {
      if (!vis.length) return { items: [] };
      params.push(vis); conds.push(`c.team_id = ANY($${params.length})`);
    }
    if (teamFilter) {
      if (vis !== null && !vis.includes(teamFilter)) return { items: [] };
      params.push(teamFilter); conds.push(`c.team_id = $${params.length}`);
    }
    if (q) { params.push(`%${q}%`); conds.push(`(c.name ILIKE $${params.length} OR c.code ILIKE $${params.length} OR c.rfc ILIKE $${params.length})`); }
    const rows = (await query(
      `SELECT c.id, c.code, c.name, c.rfc, c.contact, c.phone, c.discount, c.credit_days,
              c.team_id, t.name AS team_name, c.stage_id, s.name AS stage_name,
              c.owner_id, u.name AS owner_name,
              COALESCE(ar.outstanding,0) AS outstanding,
              COALESCE(ar.overdue,0) AS overdue
         FROM customers c
         LEFT JOIN sales_teams t ON t.id=c.team_id
         LEFT JOIN stages s ON s.id=c.stage_id
         LEFT JOIN users u ON u.id=c.owner_id
         LEFT JOIN (
           SELECT i.customer_id,
                  SUM(i.total_mxn - COALESCE(p.paid,0)) AS outstanding,
                  SUM(CASE WHEN i.due_date < CURRENT_DATE THEN (i.total_mxn - COALESCE(p.paid,0)) ELSE 0 END) AS overdue
             FROM sales_invoices i
             LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p
                    ON p.invoice_id=i.id
            WHERE i.status='posted'
            GROUP BY i.customer_id
         ) ar ON ar.customer_id=c.id
        WHERE ${conds.join(' AND ')}
        ORDER BY c.name LIMIT 300`, params)).rows;
    return { items: rows.map((c) => ({
      id: c.id, code: c.code, name: c.name, rfc: c.rfc, contact: c.contact, phone: c.phone,
      discount: Number(c.discount), credit_days: c.credit_days,
      team_id: c.team_id, team_name: c.team_name, stage_id: c.stage_id, stage_name: c.stage_name,
      owner_id: c.owner_id, owner_name: c.owner_name,
      outstanding: r2(c.outstanding), overdue: r2(c.overdue),
    })) };
  });

  // 고객 상세 + 미수/연체 인보이스
  app.get('/api/customers/:id', { preHandler: [authGuard, requirePage('customers')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const c = (await query(
      `SELECT c.*, t.name AS team_name, s.name AS stage_name, u.name AS owner_name,
              to_char(c.stage_since,'YYYY-MM-DD') AS stage_since_str
         FROM customers c
         LEFT JOIN sales_teams t ON t.id=c.team_id
         LEFT JOIN stages s ON s.id=c.stage_id
         LEFT JOIN users u ON u.id=c.owner_id
        WHERE c.id=$1 AND c.deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    // 연초~현재 누적 매출실적(올해, posted 인보이스 합계)
    const ytd = (await query(
      `SELECT COALESCE(SUM(total_mxn),0) AS actual
         FROM sales_invoices
        WHERE customer_id=$1 AND status='posted'
          AND inv_date >= date_trunc('year', CURRENT_DATE)`, [id])).rows[0];
    const invs = (await query(
      `SELECT i.id, to_char(i.inv_date,'YYYY-MM-DD') AS inv_date, to_char(i.due_date,'YYYY-MM-DD') AS due_date,
              i.total_mxn, COALESCE(p.paid,0) AS paid, (i.total_mxn - COALESCE(p.paid,0)) AS outstanding,
              (i.due_date < CURRENT_DATE AND (i.total_mxn - COALESCE(p.paid,0)) > 0) AS overdue
         FROM sales_invoices i
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p ON p.invoice_id=i.id
        WHERE i.customer_id=$1 AND i.status='posted'
        ORDER BY i.inv_date DESC LIMIT 100`, [id])).rows;
    return {
      customer: {
        id: c.id, code: c.code, name: c.name, rfc: c.rfc, contact: c.contact, phone: c.phone,
        discount: Number(c.discount), credit_days: c.credit_days, memo: c.memo,
        team_id: c.team_id, team_name: c.team_name, stage_id: c.stage_id, stage_name: c.stage_name,
        owner_id: c.owner_id, owner_name: c.owner_name, stage_since: c.stage_since_str,
      },
      invoices: invs.map((i) => ({ ...i, total_mxn: r2(i.total_mxn), paid: r2(i.paid), outstanding: r2(i.outstanding) })),
      summary: {
        ytd_actual: r2(ytd.actual),     // 연초~현재 누적 매출실적
        year_target: null,              // 연말 누적 매출목표(매출 목표 기능 후 연결)
        year: new Date().getUTCFullYear(),
      },
    };
  });

  // 고객 등록: 팀 지정 필수. 영업은 자기 팀에만, 디렉터는 전체.
  app.post('/api/customers', { preHandler: [authGuard, requirePage('customers')] }, async (req, reply) => {
    const b = req.body || {};
    if (!b.code || !b.name) return reply.code(400).send({ error: 'missing_fields' });
    // 팀 미지정 시 작성자(영업)의 소속팀으로 자동 지정
    const teamId = b.team_id ? Number(b.team_id) : (req.ctx.perm.teamId || null);
    if (!teamId) return reply.code(400).send({ error: 'team_required' });
    if (!canEditTeam(req.ctx.perm, teamId)) return reply.code(403).send({ error: 'forbidden_team' });
    const dup = (await query(`SELECT id FROM customers WHERE code=$1 AND deleted_at IS NULL`, [b.code])).rows[0];
    if (dup) return reply.code(409).send({ error: 'code_exists' });
    const row = (await query(
      `INSERT INTO customers (code, name, rfc, contact, phone, discount, credit_days, team_id, stage_id, owner_id, memo, stage_since, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $9::bigint IS NOT NULL THEN CURRENT_DATE END, $12) RETURNING id`,
      [b.code, b.name, b.rfc || null, b.contact || null, b.phone || null, Number(b.discount) || 0,
       Number(b.credit_days) || 0, teamId, b.stage_id || null, b.owner_id || null, b.memo || null, req.ctx.perm.userId])).rows[0];
    await safeLog({ userId: req.ctx.perm.userId, action: 'create', target: `customer:${row.id}` });
    return { ok: true, id: row.id };
  });

  // 고객 수정
  app.patch('/api/customers/:id', { preHandler: [authGuard, requirePage('customers')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const c = (await query(`SELECT * FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canEditTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const b = req.body || {};
    // 팀 이동은 디렉터만(또는 양쪽 팀 편집 권한)
    let teamId = c.team_id;
    if (b.team_id != null && Number(b.team_id) !== c.team_id) {
      const newTeam = Number(b.team_id);
      if (!canEditTeam(req.ctx.perm, newTeam)) return reply.code(403).send({ error: 'forbidden_team_move' });
      teamId = newTeam;
    }
    const stageChanged = b.stage_id != null && Number(b.stage_id) !== c.stage_id;
    await query(
      `UPDATE customers SET name=$1, rfc=$2, contact=$3, phone=$4, discount=$5, credit_days=$6,
         team_id=$7, stage_id=$8, owner_id=$9, memo=$10,
         stage_since=CASE WHEN $11 THEN CURRENT_DATE ELSE stage_since END, updated_by=$12 WHERE id=$13`,
      [b.name || c.name, b.rfc !== undefined ? b.rfc : c.rfc, b.contact !== undefined ? b.contact : c.contact,
       b.phone !== undefined ? b.phone : c.phone, b.discount != null ? Number(b.discount) : c.discount,
       b.credit_days != null ? Number(b.credit_days) : c.credit_days, teamId,
       b.stage_id != null ? Number(b.stage_id) : c.stage_id, b.owner_id !== undefined ? b.owner_id : c.owner_id,
       b.memo !== undefined ? b.memo : c.memo, stageChanged, req.ctx.perm.userId, id]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `customer:${id}` });
    return { ok: true };
  });

  // 고객 삭제(디렉터)
  app.delete('/api/customers/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const c = (await query(`SELECT id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    await query(`UPDATE customers SET deleted_at=now(), updated_by=$1 WHERE id=$2`, [req.ctx.perm.userId, id]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'delete', target: `customer:${id}` });
    return { ok: true };
  });

  // ===== 디렉터: 팀 배정 · 상대팀 열람 권한 =====
  // 사용자 목록(팀·권한 보기용)
  app.get('/api/team-admin/users', { preHandler: [authGuard, requireDirector] }, async () => {
    const users = (await query(
      `SELECT u.id, u.name, u.role, u.team_id, t.name AS team_name
         FROM users u LEFT JOIN sales_teams t ON t.id=u.team_id
        WHERE u.deleted_at IS NULL ORDER BY u.name`)).rows;
    const grants = (await query(
      `SELECT a.user_id, a.team_id, a.can_edit, t.name AS team_name
         FROM user_team_access a JOIN sales_teams t ON t.id=a.team_id`)).rows;
    const grantsByUser = {};
    for (const g of grants) (grantsByUser[g.user_id] ||= []).push({ team_id: g.team_id, team_name: g.team_name, can_edit: g.can_edit });
    return { items: users.map((u) => ({ ...u, grants: grantsByUser[u.id] || [] })) };
  });

  // 사용자 소속팀 지정(디렉터)
  app.patch('/api/team-admin/users/:id/team', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const teamId = req.body?.team_id != null ? Number(req.body.team_id) : null;
    await query(`UPDATE users SET team_id=$1, updated_by=$2 WHERE id=$3 AND deleted_at IS NULL`, [teamId, req.ctx.perm.userId, id]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user_team:${id}`, detail: { team_id: teamId } });
    return { ok: true };
  });

  // 상대팀 열람 권한 부여/회수(디렉터)
  app.post('/api/team-admin/users/:id/grant', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const teamId = Number(req.body?.team_id);
    const canEdit = !!req.body?.can_edit;
    if (!teamId) return reply.code(400).send({ error: 'team_required' });
    await query(
      `INSERT INTO user_team_access (user_id, team_id, can_edit, created_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, team_id) DO UPDATE SET can_edit=$3`, [id, teamId, canEdit, req.ctx.perm.userId]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user_team_grant:${id}`, detail: { team_id: teamId, can_edit: canEdit } });
    return { ok: true };
  });

  app.delete('/api/team-admin/users/:id/grant/:teamId', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id), teamId = Number(req.params.teamId);
    await query(`DELETE FROM user_team_access WHERE user_id=$1 AND team_id=$2`, [id, teamId]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'permission_change', target: `user_team_revoke:${id}`, detail: { team_id: teamId } });
    return { ok: true };
  });
}
