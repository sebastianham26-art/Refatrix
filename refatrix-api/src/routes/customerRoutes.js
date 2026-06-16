import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { visibleTeamIds, canViewTeam, canEditTeam } from '../teams.js';
import { buildHeaderIndex, parseCustRow, buildCustPreview, CUST_TEMPLATE_HEADERS } from '../customerImport.js';

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

  async function computeNextCode() {
    const rows = (await query(`SELECT code FROM customers WHERE deleted_at IS NULL`)).rows;
    const used = new Set(); let maxn = 0;
    for (const r of rows) { const m = String(r.code || '').match(/^c-?(\d+)$/i); if (m) { const n = parseInt(m[1], 10); used.add(n); if (n > maxn) maxn = n; } }
    let next = maxn + 1; while (used.has(next)) next++;
    return 'C-' + String(next).padStart(4, '0');
  }

  // 다음 고객코드 자동생성(미리보기). 대소문자 무관, 빈 번호 충돌 회피.
  app.get('/api/customers/next-code', { preHandler: [authGuard, requirePage('customers')] }, async () => {
    return { code: await computeNextCode() };
  });

  // 업로드 양식 헤더(프런트가 빈 xlsx 양식 생성에 사용)
  app.get('/api/customers/template', { preHandler: [authGuard, requirePage('customers')] }, async () => {
    return { headers: CUST_TEMPLATE_HEADERS };
  });

  async function resolveRefs() {
    const teams = (await query(`SELECT id, name FROM sales_teams WHERE deleted_at IS NULL AND is_sales=true`)).rows;
    const owners = (await query(`SELECT id, name FROM users WHERE deleted_at IS NULL AND role IN ('sales','director')`)).rows;
    const stages = (await query(`SELECT id, name FROM stages WHERE deleted_at IS NULL`)).rows;
    const existing = (await query(
      `SELECT c.code, c.name, c.rfc, c.customer_type, c.contact, c.phone, c.discount, c.credit_days, c.memo, c.team_id, t.name AS team_name
         FROM customers c LEFT JOIN sales_teams t ON t.id=c.team_id WHERE c.deleted_at IS NULL`)).rows;
    const teamByName = {}; for (const t of teams) teamByName[t.name.toLowerCase()] = t.id;
    const ownerByName = {}; for (const o of owners) ownerByName[o.name.toLowerCase()] = o.id;
    const stageByName = {}; for (const s of stages) stageByName[s.name.toLowerCase()] = s.id;
    const existingByCode = new Set(existing.map((r) => String(r.code).toLowerCase()));
    const existingByCodeData = {}; for (const r of existing) existingByCodeData[String(r.code).toLowerCase()] = r;
    return { teamByName, ownerByName, stageByName, existingByCode, existingByCodeData };
  }

  // 엑셀 업로드 미리보기 — body: { rows: [[...]] } (첫 행 헤더)
  app.post('/api/customers/import/preview', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const all = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!all.length) return reply.code(400).send({ error: 'no_rows' });
    const idx = buildHeaderIndex(all[0]);
    if (idx.name == null) return reply.code(400).send({ error: 'missing_name_column' });
    const parsed = all.slice(1).map((r) => parseCustRow(r, idx)).filter(Boolean);
    const resolve = await resolveRefs();
    const preview = buildCustPreview(parsed, resolve);
    return { ...preview, total: parsed.length };
  });

  // 커밋 — 신규는 코드 자동생성, 기존(코드 일치)은 갱신. 팀 편집권한 확인.
  app.post('/api/customers/import/commit', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const all = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!all.length) return reply.code(400).send({ error: 'no_rows' });
    const idx = buildHeaderIndex(all[0]);
    const parsed = all.slice(1).map((r) => parseCustRow(r, idx)).filter(Boolean);
    const resolve = await resolveRefs();
    const userId = req.ctx.perm.userId;
    let created = 0, updated = 0, skipped = 0;
    for (const p of parsed) {
      if (!p.name || !p.team) { skipped++; continue; }
      const teamId = resolve.teamByName[p.team.toLowerCase()];
      if (!teamId || !canEditTeam(req.ctx.perm, teamId)) { skipped++; continue; }
      const ownerId = p.owner ? (resolve.ownerByName[p.owner.toLowerCase()] || null) : null;
      const stageId = p.stage ? (resolve.stageByName[p.stage.toLowerCase()] || null) : null;
      const isUpdate = p.code && resolve.existingByCode.has(p.code.toLowerCase());
      if (isUpdate) {
        await query(
          `UPDATE customers SET name=$1, rfc=$2, contact=$3, phone=$4, discount=$5, credit_days=$6,
             team_id=$7, stage_id=COALESCE($8,stage_id), owner_id=COALESCE($9,owner_id),
             customer_type=COALESCE($10,customer_type), memo=COALESCE($11,memo), updated_by=$12
           WHERE lower(code)=lower($13) AND deleted_at IS NULL`,
          [p.name, p.rfc, p.contact, p.phone, p.discount, p.credit_days, teamId, stageId, ownerId, p.customer_type, p.memo, userId, p.code]);
        updated++;
      } else {
        let code = p.code, ok = false;
        for (let attempt = 0; attempt < 5 && !ok; attempt++) {
          if (!code || attempt > 0) code = await computeNextCode();
          try {
            await query(
              `INSERT INTO customers (code, name, rfc, contact, phone, discount, credit_days, team_id, stage_id, owner_id, customer_type, memo, stage_since, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $9::bigint IS NOT NULL THEN CURRENT_DATE END, $13)`,
              [code, p.name, p.rfc, p.contact, p.phone, p.discount, p.credit_days, teamId, stageId, ownerId, p.customer_type, p.memo, userId]);
            ok = true; resolve.existingByCode.add(String(code).toLowerCase());
          } catch (e) { if (!String(e.message || '').match(/unique|duplicate/)) throw e; }
        }
        if (ok) created++; else skipped++;
      }
    }
    await safeLog({ userId, action: 'create', target: 'customer_import', detail: { created, updated, skipped } });
    return { ok: true, created, updated, skipped };
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
      `SELECT c.id, c.code, c.name, c.rfc, c.contact, c.phone, c.discount, c.credit_days, c.customer_type,
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
      discount: Number(c.discount), credit_days: c.credit_days, customer_type: c.customer_type,
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
    // 올해 매출목표(고객 월 목표 합) — 매출 목표 메뉴에서 설정되면 채워짐
    const tgt = (await query(
      `SELECT COALESCE(SUM(amount),0) AS yt FROM target_customer_months
        WHERE customer_id=$1 AND ym LIKE to_char(CURRENT_DATE,'YYYY') || '-%'`, [id])).rows[0];
    const yearTarget = Number(tgt.yt) > 0 ? r2(tgt.yt) : null;
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
        discount: Number(c.discount), credit_days: c.credit_days, memo: c.memo, customer_type: c.customer_type,
        constancia_fiscal: c.constancia_fiscal || null,
        team_id: c.team_id, team_name: c.team_name, stage_id: c.stage_id, stage_name: c.stage_name,
        owner_id: c.owner_id, owner_name: c.owner_name, stage_since: c.stage_since_str,
      },
      invoices: invs.map((i) => ({ ...i, total_mxn: r2(i.total_mxn), paid: r2(i.paid), outstanding: r2(i.outstanding) })),
      summary: {
        ytd_actual: r2(ytd.actual),     // 연초~현재 누적 매출실적
        year_target: yearTarget,        // 올해 고객 월 목표 합(매출 목표 메뉴에서 설정)
        year: new Date().getUTCFullYear(),
      },
    };
  });

  // 고객 등록: 코드 서버 자동생성(고정), 팀 지정 필수.
  app.post('/api/customers', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const b = req.body || {};
    if (!b.name) return reply.code(400).send({ error: 'missing_fields' });
    const teamId = b.team_id ? Number(b.team_id) : (req.ctx.perm.teamId || null);
    if (!teamId) return reply.code(400).send({ error: 'team_required' });
    if (!canEditTeam(req.ctx.perm, teamId)) return reply.code(403).send({ error: 'forbidden_team' });
    // 코드 충돌 시 재시도(동시 생성 대비)
    let row, lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = await computeNextCode();
      try {
        row = (await query(
          `INSERT INTO customers (code, name, rfc, contact, phone, discount, credit_days, team_id, stage_id, owner_id, customer_type, memo, stage_since, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $9::bigint IS NOT NULL THEN CURRENT_DATE END, $13) RETURNING id, code`,
          [code, b.name, b.rfc || null, b.contact || null, b.phone || null, Number(b.discount) || 0,
           Number(b.credit_days) || 0, teamId, b.stage_id || null, b.owner_id || null, b.customer_type || null, b.memo || null, req.ctx.perm.userId])).rows[0];
        break;
      } catch (e) { lastErr = e; if (!String(e.message || '').includes('unique') && !String(e.message || '').includes('duplicate')) throw e; }
    }
    if (!row) return reply.code(409).send({ error: 'code_generation_failed' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'create', target: `customer:${row.id}` });
    return { ok: true, id: row.id, code: row.code };
  });

  // 고객 수정
  // 고객 수정에 적용할 필드를 customers에 반영(헬퍼) — 승인 시 재사용
  async function applyCustomerUpdate(id, c, b, userId) {
    let teamId = c.team_id;
    if (b.team_id != null && Number(b.team_id) !== c.team_id) teamId = Number(b.team_id);
    const stageChanged = b.stage_id != null && Number(b.stage_id) !== c.stage_id;
    await query(
      `UPDATE customers SET name=$1, rfc=$2, contact=$3, phone=$4, discount=$5, credit_days=$6,
         team_id=$7, stage_id=$8, owner_id=$9, customer_type=$10, memo=$11, constancia_fiscal=$15,
         stage_since=CASE WHEN $12 THEN CURRENT_DATE ELSE stage_since END, updated_by=$13 WHERE id=$14`,
      [b.name || c.name, b.rfc !== undefined ? b.rfc : c.rfc, b.contact !== undefined ? b.contact : c.contact,
       b.phone !== undefined ? b.phone : c.phone, b.discount != null ? Number(b.discount) : c.discount,
       b.credit_days != null ? Number(b.credit_days) : c.credit_days, teamId,
       b.stage_id != null ? Number(b.stage_id) : c.stage_id, b.owner_id !== undefined ? b.owner_id : c.owner_id,
       b.customer_type !== undefined ? b.customer_type : c.customer_type,
       b.memo !== undefined ? b.memo : c.memo, stageChanged, userId, id,
       b.constancia_fiscal !== undefined ? b.constancia_fiscal : c.constancia_fiscal]);
  }

  app.patch('/api/customers/:id', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const perm = req.ctx.perm;
    const c = (await query(`SELECT * FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canEditTeam(perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const b = req.body || {};
    // 팀 이동 권한 체크(디렉터/양팀 편집권)
    if (b.team_id != null && Number(b.team_id) !== c.team_id) {
      if (!canEditTeam(perm, Number(b.team_id))) return reply.code(403).send({ error: 'forbidden_team_move' });
    }
    // 디렉터: 즉시 반영 / 그 외: 디렉터 승인 대기로 보관
    if (perm.role === 'director') {
      await applyCustomerUpdate(id, c, b, perm.userId);
      await safeLog({ userId: perm.userId, action: 'update', target: `customer:${id}` });
      return { ok: true };
    }
    // 같은 고객에 이미 대기중인 요청이 있으면 갱신(최신으로 덮어씀)
    const proposed = {
      name: b.name, rfc: b.rfc, contact: b.contact, phone: b.phone, discount: b.discount,
      credit_days: b.credit_days, team_id: b.team_id, stage_id: b.stage_id, owner_id: b.owner_id,
      customer_type: b.customer_type, memo: b.memo, constancia_fiscal: b.constancia_fiscal,
    };
    const existing = (await query(`SELECT id FROM customer_change_requests WHERE customer_id=$1 AND status='pending'`, [id])).rows[0];
    if (existing) {
      await query(`UPDATE customer_change_requests SET proposed=$1, requested_by=$2, reason=$3, created_at=now() WHERE id=$4`,
        [JSON.stringify(proposed), perm.userId, b.reason || null, existing.id]);
    } else {
      await query(`INSERT INTO customer_change_requests (customer_id, proposed, requested_by, reason) VALUES ($1,$2,$3,$4)`,
        [id, JSON.stringify(proposed), perm.userId, b.reason || null]);
    }
    await safeLog({ userId: perm.userId, action: 'change_request', target: `customer:${id}` });
    return { ok: true, pending: true };
  });

  // 고객 수정 승인 대기 목록(디렉터)
  app.get('/api/customer-change-requests', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = (await query(
      `SELECT r.id, r.customer_id, r.proposed, r.status, r.reason, r.created_at,
              c.code AS customer_code, c.name AS customer_name,
              u.name AS requested_by_name
         FROM customer_change_requests r
         JOIN customers c ON c.id=r.customer_id
         LEFT JOIN users u ON u.id=r.requested_by
        WHERE r.status=$1 ORDER BY r.created_at DESC`, [status])).rows;
    return {
      items: rows.map((r) => ({
        id: r.id, customer_id: r.customer_id, customer_code: r.customer_code, customer_name: r.customer_name,
        proposed: r.proposed, status: r.status, reason: r.reason,
        requested_by_name: r.requested_by_name, created_at: r.created_at,
      })),
    };
  });

  // 승인 → customers에 반영(디렉터)
  app.post('/api/customer-change-requests/:id/approve', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = (await query(`SELECT * FROM customer_change_requests WHERE id=$1 AND status='pending'`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const c = (await query(`SELECT * FROM customers WHERE id=$1 AND deleted_at IS NULL`, [r.customer_id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'customer_gone' });
    await applyCustomerUpdate(r.customer_id, c, r.proposed, req.ctx.perm.userId);
    await query(`UPDATE customer_change_requests SET status='approved', decided_by=$1, decided_at=now() WHERE id=$2`, [req.ctx.perm.userId, id]);
    await safeLog({ userId: req.ctx.perm.userId, action: 'approve_change', target: `customer:${r.customer_id}` });
    return { ok: true };
  });

  // 반려(디렉터)
  app.post('/api/customer-change-requests/:id/reject', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    const r = (await query(`SELECT id FROM customer_change_requests WHERE id=$1 AND status='pending'`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await query(`UPDATE customer_change_requests SET status='rejected', decided_by=$1, decided_at=now(), reject_reason=$2 WHERE id=$3`,
      [req.ctx.perm.userId, (req.body && req.body.reason) ? String(req.body.reason) : null, id]);
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

  // ===== 고객 증빙서류 (PDF·JPEG 등) — DB 저장 =====
  const ALLOWED_DOC_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  const MAX_DOC_BYTES = 5 * 1024 * 1024; // 5MB

  // 목록 (본문 제외)
  app.get('/api/customers/:id/documents', { preHandler: [authGuard, requirePage('customers')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const rows = (await query(
      `SELECT d.id, d.doc_type, d.file_name, d.mime_type, d.byte_size, to_char(d.uploaded_at,'YYYY-MM-DD') AS uploaded_at, u.name AS uploaded_by_name
         FROM customer_documents d LEFT JOIN users u ON u.id=d.uploaded_by
        WHERE d.customer_id=$1 AND d.deleted_at IS NULL ORDER BY d.uploaded_at DESC, d.id DESC`, [id])).rows;
    return { items: rows.map((r) => ({ ...r, byte_size: Number(r.byte_size) })) };
  });

  // 업로드: { doc_type?, file_name, mime_type, data_base64 }
  app.post('/api/customers/:id/documents', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canEditTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const b = req.body || {};
    const fileName = String(b.file_name || '').trim();
    const mime = String(b.mime_type || '').trim();
    const b64 = String(b.data_base64 || '');
    if (!fileName || !mime || !b64) return reply.code(400).send({ error: 'missing_fields' });
    if (!ALLOWED_DOC_MIME.includes(mime)) return reply.code(400).send({ error: 'unsupported_type', note: 'PDF·JPEG·PNG·WEBP만 업로드할 수 있습니다.' });
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (e) { return reply.code(400).send({ error: 'bad_base64' }); }
    if (!buf.length) return reply.code(400).send({ error: 'empty_file' });
    if (buf.length > MAX_DOC_BYTES) return reply.code(400).send({ error: 'too_large', note: '파일은 5MB 이하만 가능합니다.' });
    const row = (await query(
      `INSERT INTO customer_documents (customer_id, doc_type, file_name, mime_type, byte_size, content, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [id, b.doc_type || null, fileName, mime, buf.length, buf, req.ctx.perm.userId])).rows[0];
    await safeLog({ userId: req.ctx.perm.userId, action: 'create', target: `customer_doc:${row.id}`, detail: { customer_id: id, file_name: fileName } });
    return { ok: true, id: row.id };
  });

  // 다운로드(본문) — 바이너리 반환
  app.get('/api/customers/:id/documents/:docId', { preHandler: [authGuard, requirePage('customers')] }, async (req, reply) => {
    const id = Number(req.params.id), docId = Number(req.params.docId);
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const d = (await query(`SELECT file_name, mime_type, content FROM customer_documents WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL`, [docId, id])).rows[0];
    if (!d) return reply.code(404).send({ error: 'not_found' });
    reply.header('Content-Type', d.mime_type);
    reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(d.file_name)}"`);
    return reply.send(d.content);
  });

  // 삭제(soft)
  app.delete('/api/customers/:id/documents/:docId', { preHandler: [authGuard, requirePageEdit('customers')] }, async (req, reply) => {
    const id = Number(req.params.id), docId = Number(req.params.docId);
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canEditTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const r = (await query(`UPDATE customer_documents SET deleted_at=now() WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL RETURNING id`, [docId, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await safeLog({ userId: req.ctx.perm.userId, action: 'delete', target: `customer_doc:${docId}` });
    return { ok: true };
  });
}
