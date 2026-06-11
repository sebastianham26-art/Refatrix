import { query, withTx } from '../db.js';
import { authGuard, requirePage } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { visibleTeamIds, canViewTeam, canEditTeam } from '../teams.js';
import { pipelineByStage, detectBottleneck, stalledCustomers } from '../pipeline.js';

async function safeLog(args) { try { await logEvent(args); } catch (_) { /* ignore */ } }
function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

export default async function meetingRoutes(app) {
  // 미팅 기록(+ 단계 진전 시 단계 변경 및 이력 갱신)
  // body: { customer_id, meeting_date, note, advance:bool, new_stage_id? }
  app.post('/api/meetings', { preHandler: [authGuard, requirePage('pipeline')] }, async (req, reply) => {
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
              (SELECT to_char(MAX(meeting_date),'YYYY-MM-DD') FROM customer_meetings mm WHERE mm.customer_id=c.id) AS last_meeting
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
        days_in_stage: c.stage_since ? Math.max(0, Math.round((new Date(today) - new Date(c.stage_since)) / 86400000)) : null,
      })),
    };
  });
}
