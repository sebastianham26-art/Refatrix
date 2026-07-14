import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { visibleTeamIds, canViewTeam, canEditTeam } from '../teams.js';
import { pipelineByStage, detectBottleneck, stalledCustomers } from '../pipeline.js';

async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }
function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

export default async function meetingRoutes(app) {
  // 미팅 기록(+ 단계 진전 시 단계 변경 및 이력 갱신)
  // body: { customer_id, meeting_date, note, advance:bool, new_stage_id? }
  app.post('/api/meetings', { preHandler: [authGuard, requirePageEdit('pipeline')] }, async (req, reply) => {
    const b = req.body || {};
    const customerId = Number(b.customer_id);
    if (!customerId || !b.meeting_date) return reply.code(400).send({ error: 'missing_fields' });
    const c = (await query(`SELECT id, team_id, stage_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canEditTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const userId = req.ctx.perm.userId;
    const advance = b.advance === true && b.new_stage_id && Number(b.new_stage_id) !== c.stage_id;
    const newStage = advance ? Number(b.new_stage_id) : null;
    await withTx(async (cx) => {
      await cx.query(
        `INSERT INTO customer_meetings (customer_id, meeting_date, note, stage_before, stage_after, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [customerId, b.meeting_date, b.note || null, c.stage_id, advance ? newStage : c.stage_id, userId]);
      if (advance) {
        // 현재 열린 단계 이력 닫고, 새 단계 이력 열기
        await cx.query(`UPDATE customer_stage_history SET left_at=$2 WHERE customer_id=$1 AND left_at IS NULL`, [customerId, b.meeting_date]);
        await cx.query(`INSERT INTO customer_stage_history (customer_id, stage_id, entered_at, created_by) VALUES ($1,$2,$3,$4)`,
          [customerId, newStage, b.meeting_date, userId]);
        await cx.query(`UPDATE customers SET stage_id=$1, stage_since=$2, updated_by=$3 WHERE id=$4`,
          [newStage, b.meeting_date, userId, customerId]);
      }
    });
    await safeLog({ userId, action: 'create', target: `meeting:${customerId}` });
    return { ok: true, advanced: advance };
  });

  // 고객 미팅 이력
  app.get('/api/meetings', { preHandler: [authGuard, requirePage('pipeline')] }, async (req, reply) => {
    const customerId = Number(req.query.customer_id);
    if (!customerId) return reply.code(400).send({ error: 'customer_required' });
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const rows = (await query(
      `SELECT m.id, to_char(m.meeting_date,'YYYY-MM-DD') AS meeting_date, m.note,
              sb.name AS stage_before, sa.name AS stage_after, u.name AS by_name
         FROM customer_meetings m
         LEFT JOIN stages sb ON sb.id=m.stage_before
         LEFT JOIN stages sa ON sa.id=m.stage_after
         LEFT JOIN users u ON u.id=m.created_by
        WHERE m.customer_id=$1 ORDER BY m.meeting_date DESC, m.id DESC LIMIT 100`, [customerId])).rows;
    return { items: rows.map((m) => ({ ...m, advanced: m.stage_before !== m.stage_after })) };
  });

  // 고객 매출 요약(누적) — 미팅 패널 박스용
  app.get('/api/meetings/sales-summary', { preHandler: [authGuard, requirePage('pipeline')] }, async (req, reply) => {
    const customerId = Number(req.query.customer_id);
    if (!customerId) return reply.code(400).send({ error: 'customer_required' });
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const hdr = (await query(
      `SELECT COUNT(*)::int AS inv_count, COALESCE(SUM(i.total_mxn),0)::numeric AS amount_total,
              to_char(MIN(i.inv_date),'YYYY-MM-DD') AS first_trade
         FROM sales_invoices i WHERE i.customer_id=$1 AND i.status='posted' AND i.deleted_at IS NULL`, [customerId])).rows[0];
    const ln = (await query(
      `SELECT COUNT(DISTINCT sl.product_id)::int AS sku, COALESCE(SUM(sl.qty),0)::numeric AS qty
         FROM sales_invoice_lines sl JOIN sales_invoices i ON i.id=sl.invoice_id
        WHERE i.customer_id=$1 AND i.status='posted' AND i.deleted_at IS NULL`, [customerId])).rows[0];
    const pay = (await query(
      `SELECT COALESCE(SUM(spa.amount),0)::numeric AS collected
         FROM sales_payment_allocations spa JOIN sales_invoices i ON i.id=spa.invoice_id
        WHERE i.customer_id=$1 AND i.status='posted' AND i.deleted_at IS NULL`, [customerId])).rows[0];
    const open = (await query(
      `SELECT COUNT(*)::int AS open_count, COALESCE(SUM(outstanding),0)::numeric AS open_amount FROM (
         SELECT i.id, i.total_mxn - COALESCE(p.paid,0) AS outstanding
           FROM sales_invoices i
           LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) p ON p.invoice_id=i.id
          WHERE i.customer_id=$1 AND i.status='posted' AND i.deleted_at IS NULL
       ) t WHERE outstanding > 0.005`, [customerId])).rows[0];
    return {
      sku: ln.sku || 0, qty: Number(ln.qty) || 0, amount_total: Number(hdr.amount_total) || 0,
      inv_count: hdr.inv_count || 0, first_trade: hdr.first_trade || null,
      open_count: open.open_count || 0, open_amount: r2(open.open_amount), collected: r2(pay.collected),
    };
  });

  // ===== 디렉터 지시·피드백 → 읽음확인 → 완료(F/UP) =====

  app.post('/api/directives', { preHandler: [authGuard, requirePage('pipeline')] }, async (req, reply) => {
    if (req.ctx.perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const b = req.body || {};
    const customerId = Number(b.customer_id);
    if (!customerId || !b.note || !String(b.note).trim()) return reply.code(400).send({ error: 'missing_fields' });
    const c = (await query(`SELECT id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const row = (await query(
      `INSERT INTO customer_directives (customer_id, note, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [customerId, String(b.note).trim(), req.ctx.perm.userId])).rows[0];
    await safeLog({ userId: req.ctx.perm.userId, action: 'create', target: `directive:${row.id}` });
    return { ok: true, id: row.id };
  });

  app.get('/api/directives', { preHandler: [authGuard, requirePage('pipeline')] }, async (req, reply) => {
    const customerId = Number(req.query.customer_id);
    if (!customerId) return reply.code(400).send({ error: 'customer_required' });
    const c = (await query(`SELECT team_id FROM customers WHERE id=$1 AND deleted_at IS NULL`, [customerId])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    if (!canViewTeam(req.ctx.perm, c.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const rows = (await query(
      `SELECT d.id, d.note, d.status, d.done_note,
              to_char(d.created_at,'YYYY-MM-DD HH24:MI') AS created_at, cu.name AS by_name,
              to_char(d.read_at,'YYYY-MM-DD HH24:MI') AS read_at, ru.name AS read_name,
              to_char(d.done_at,'YYYY-MM-DD HH24:MI') AS done_at, du.name AS done_name
         FROM customer_directives d
         LEFT JOIN users cu ON cu.id=d.created_by
         LEFT JOIN users ru ON ru.id=d.read_by
         LEFT JOIN users du ON du.id=d.done_by
        WHERE d.customer_id=$1 ORDER BY d.created_at DESC, d.id DESC`, [customerId])).rows;
    return { items: rows };
  });

  app.post('/api/directives/:id/read', { preHandler: [authGuard, requirePageEdit('pipeline')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const d = (await query(
      `SELECT d.id, d.status, c.team_id FROM customer_directives d JOIN customers c ON c.id=d.customer_id WHERE d.id=$1`, [id])).rows[0];
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (!canEditTeam(req.ctx.perm, d.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    if (d.status === 'open') {
      await query(`UPDATE customer_directives SET status='read', read_by=$1, read_at=now() WHERE id=$2`, [req.ctx.perm.userId, id]);
    }
    await safeLog({ userId: req.ctx.perm.userId, action: 'update', target: `directive_read:${id}` });
    return { ok: true };
  });

  app.post('/api/directives/:id/done', { preHandler: [authGuard, requirePageEdit('pipeline')] }, async (req, reply) => {
    const id = Number(req.params.id);
    const d = (await query(
      `SELECT d.id, d.status, d.read_at, c.team_id FROM customer_directives d JOIN customers c ON c.id=d.customer_id WHERE d.id=$1`, [id])).rows[0];
    if (!d) return reply.code(404).send({ error: 'not_found' });
    if (!canEditTeam(req.ctx.perm, d.team_id)) return reply.code(403).send({ error: 'forbidden_team' });
    const uid = req.ctx.perm.userId;
    await query(
      `UPDATE customer_directives
          SET status='done', done_by=$1, done_at=now(), done_note=$2,
              read_by=COALESCE(read_by,$1), read_at=COALESCE(read_at,now())
        WHERE id=$3`, [uid, req.body?.done_note || null, id]);
    await safeLog({ userId: uid, action: 'update', target: `directive_done:${id}` });
    return { ok: true };
  });

  app.get('/api/directives/board', { preHandler: [authGuard, requirePage('pipeline')] }, async (req, reply) => {
    if (req.ctx.perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const rows = (await query(
      `SELECT d.id, d.status, d.note,
              c.id AS customer_id, c.code, c.name AS customer_name, t.name AS team_name,
              to_char(d.created_at,'YYYY-MM-DD HH24:MI') AS created_at, cu.name AS by_name,
              to_char(d.read_at,'YYYY-MM-DD HH24:MI') AS read_at, ru.name AS read_name,
              to_char(d.done_at,'YYYY-MM-DD HH24:MI') AS done_at, du.name AS done_name, d.done_note
         FROM customer_directives d
         JOIN customers c ON c.id=d.customer_id
         LEFT JOIN sales_teams t ON t.id=c.team_id
         LEFT JOIN users cu ON cu.id=d.created_by
         LEFT JOIN users ru ON ru.id=d.read_by
         LEFT JOIN users du ON du.id=d.done_by
        ORDER BY (d.status='done'), (d.status='read'), d.created_at DESC
        LIMIT 300`)).rows;
    const counts = { open: 0, read: 0, done: 0 };
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    return { items: rows, counts };
  });

  // 파이프라인·병목 분석(팀 가시성). team_id 옵션
  app.get('/api/pipeline', { preHandler: [authGuard, requirePage('pipeline')] }, async (req) => {
    const vis = visibleTeamIds(req.ctx.perm);
    const teamFilter = req.query.team_id ? Number(req.query.team_id) : null;
    const stages = (await query(`SELECT id, name, sort_order FROM stages WHERE deleted_at IS NULL ORDER BY sort_order, id`)).rows;
    const conds = ['c.deleted_at IS NULL']; const params = [];
    if (vis !== null) { if (!vis.length) return { stages, pipeline: [], bottleneck: null, stalled: [], customers: [] };
      params.push(vis); conds.push(`c.team_id = ANY($${params.length})`); }
    if (teamFilter) {
      if (vis !== null && !vis.includes(teamFilter)) return { stages, pipeline: [], bottleneck: null, stalled: [], customers: [] };
      params.push(teamFilter); conds.push(`c.team_id = $${params.length}`);
    }
    const custs = (await query(
      `SELECT c.id, c.code, c.name, c.customer_type, c.stage_id, to_char(c.stage_since,'YYYY-MM-DD') AS stage_since,
              t.name AS team_name, s.name AS stage_name,
              (SELECT to_char(MAX(meeting_date),'YYYY-MM-DD') FROM customer_meetings mm WHERE mm.customer_id=c.id) AS last_meeting,
              (SELECT COUNT(*) FROM customer_directives dd WHERE dd.customer_id=c.id AND dd.status<>'done') AS open_directives,
              (SELECT COUNT(*) FROM sales_invoices si WHERE si.customer_id=c.id AND si.status='posted') AS invoice_count
         FROM customers c
         LEFT JOIN sales_teams t ON t.id=c.team_id
         LEFT JOIN stages s ON s.id=c.stage_id
        WHERE ${conds.join(' AND ')} ORDER BY c.name`, params)).rows;
    const today = new Date().toISOString().slice(0, 10);
    const pipeline = pipelineByStage(stages, custs.map((c) => ({ id: c.id, stage_id: c.stage_id, stage_since: c.stage_since })), today);
    const bottleneck = detectBottleneck(pipeline);
    const stalled = stalledCustomers(pipeline, 30);
    const custById = {}; for (const c of custs) custById[c.id] = c;
    return {
      stages,
      pipeline,
      bottleneck,
      stalled: stalled.map((s) => ({ ...s, customer: custById[s.customer_id] || null })),
      customers: custs.map((c) => ({
        id: c.id, code: c.code, name: c.name, customer_type: c.customer_type,
        stage_id: c.stage_id, stage_name: c.stage_name, stage_since: c.stage_since,
        team_name: c.team_name, last_meeting: c.last_meeting,
        open_directives: Number(c.open_directives) || 0,
        invoice_count: Number(c.invoice_count) || 0,
        days_in_stage: c.stage_since ? Math.max(0, Math.round((new Date(today) - new Date(c.stage_since)) / 86400000)) : null,
      })),
    };
  });
}
