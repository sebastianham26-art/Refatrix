import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { visibleTeamIds } from '../teams.js';
import { logEvent } from '../audit.js';

function d10(d) { if (!d) return null; if (d instanceof Date) return d.toISOString().slice(0, 10); return String(d).slice(0, 10); }
function isoTs(d) { if (!d) return null; if (d instanceof Date) return d.toISOString(); return String(d); }

export default async function portalBoardRoutes(app) {
  // =================== 일정 (Calendar) ===================
  // 보이는 일정: 전사 + 내 팀(scope=team) + 내 개인(scope=personal, owner=me) + 내가 만든 것
  app.get('/api/calendar', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    const mine = String(req.query.mine || '') === '1';
    const vis = visibleTeamIds(perm); // null=전체(디렉터)
    const conds = [`e.deleted_at IS NULL`];
    const args = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { args.push(from); conds.push(`e.event_date >= $${args.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { args.push(to); conds.push(`e.event_date <= $${args.length}`); }

    if (mine) {
      // 내 일정만: 내가 대상(개인)이거나 내가 만든 것
      args.push(perm.userId); const meIdx = args.length;
      conds.push(`(e.owner_id=$${meIdx} OR e.created_by=$${meIdx})`);
    } else if (vis === null) {
      // 디렉터: 전부
    } else {
      const myTeams = vis.length ? vis : [-1];
      args.push(perm.userId); const meIdx = args.length;
      args.push(myTeams); const teamIdx = args.length;
      conds.push(`(e.scope='company' OR (e.scope='team' AND e.team_id = ANY($${teamIdx})) OR (e.scope='personal' AND e.owner_id=$${meIdx}) OR e.created_by=$${meIdx})`);
    }
    const rows = (await query(
      `SELECT e.id, e.event_date, e.event_time, e.content, e.scope, e.team_id, e.owner_id,
              t.name AS team_name, u.name AS owner_name
         FROM calendar_events e
         LEFT JOIN sales_teams t ON t.id=e.team_id
         LEFT JOIN users u ON u.id=e.owner_id
        WHERE ${conds.join(' AND ')}
        ORDER BY e.event_date, e.event_time NULLS FIRST, e.id`, args)).rows;
    return {
      items: rows.map((r) => ({
        id: r.id, date: d10(r.event_date), time: r.event_time || null, content: r.content,
        scope: r.scope, team_id: r.team_id, team_name: r.team_name, owner_id: r.owner_id, owner_name: r.owner_name,
      })),
    };
  });

  app.post('/api/calendar', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const b = req.body || {};
    const scope = ['company', 'team', 'personal'].includes(b.scope) ? b.scope : 'personal';
    if (!b.event_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.event_date))) return reply.code(400).send({ error: 'date_required' });
    if (!b.content || !String(b.content).trim()) return reply.code(400).send({ error: 'content_required' });
    // 전사·팀 일정은 디렉터만
    if ((scope === 'company' || scope === 'team') && perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const teamId = scope === 'team' ? (Number(b.team_id) || null) : null;
    if (scope === 'team' && !teamId) return reply.code(400).send({ error: 'team_required' });
    const ownerId = scope === 'personal' ? (Number(b.owner_id) || perm.userId) : null;
    // 개인 일정을 남에게 지정하는 건 디렉터만(본인 것은 누구나)
    if (scope === 'personal' && ownerId !== perm.userId && perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const r = (await query(
      `INSERT INTO calendar_events (event_date, event_time, content, scope, team_id, owner_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.event_date, b.event_time ? String(b.event_time).trim() : null, String(b.content).trim(), scope, teamId, ownerId, perm.userId])).rows[0];
    await logEvent({ userId: perm.userId, action: 'create', target: `calendar_event:${r.id}`, detail: { scope } });
    return { id: r.id };
  });

  app.delete('/api/calendar/:id', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const e = (await query(`SELECT created_by, owner_id FROM calendar_events WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!e) return reply.code(404).send({ error: 'not_found' });
    // 작성자 본인 또는 디렉터만 삭제
    if (perm.role !== 'director' && Number(e.created_by) !== perm.userId) return reply.code(403).send({ error: 'forbidden' });
    await query(`UPDATE calendar_events SET deleted_at=now() WHERE id=$1`, [id]);
    return { ok: true };
  });

  // =================== 공지 (Notice) ===================
  app.get('/api/notices', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const vis = visibleTeamIds(perm);
    const conds = [`n.deleted_at IS NULL`];
    const args = [];
    if (vis !== null) {
      args.push(perm.role); const rIdx = args.length;
      const myTeams = vis.length ? vis : [-1];
      args.push(myTeams); const tIdx = args.length;
      conds.push(`(n.audience='all' OR (n.audience='role' AND n.audience_role=$${rIdx}) OR (n.audience='team' AND n.team_id = ANY($${tIdx})))`);
    }
    args.push(perm.userId); const meIdx = args.length;
    const rows = (await query(
      `SELECT n.id, n.title, n.body, n.audience, n.audience_role, n.team_id, n.pinned, n.created_at,
              u.name AS author, t.name AS team_name,
              nr.read_at AS my_read_at
         FROM notices n
         LEFT JOIN users u ON u.id=n.created_by
         LEFT JOIN sales_teams t ON t.id=n.team_id
         LEFT JOIN notice_reads nr ON nr.notice_id=n.id AND nr.user_id=$${meIdx}
        WHERE ${conds.join(' AND ')}
        ORDER BY n.pinned DESC, n.created_at DESC`, args)).rows;
    return {
      items: rows.map((r) => ({
        id: r.id, title: r.title, body: r.body, audience: r.audience, audience_role: r.audience_role,
        team_id: r.team_id, team_name: r.team_name, pinned: r.pinned, author: r.author,
        created_at: isoTs(r.created_at), my_read_at: isoTs(r.my_read_at), read: !!r.my_read_at,
      })),
      unread: rows.filter((r) => !r.my_read_at).length,
    };
  });

  app.post('/api/notices', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return reply.code(400).send({ error: 'title_required' });
    const audience = ['all', 'role', 'team'].includes(b.audience) ? b.audience : 'all';
    const audienceRole = audience === 'role' ? (b.audience_role || null) : null;
    const teamId = audience === 'team' ? (Number(b.team_id) || null) : null;
    if (audience === 'role' && !audienceRole) return reply.code(400).send({ error: 'role_required' });
    if (audience === 'team' && !teamId) return reply.code(400).send({ error: 'team_required' });
    const r = (await query(
      `INSERT INTO notices (title, body, audience, audience_role, team_id, pinned, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [String(b.title).trim(), b.body ? String(b.body) : null, audience, audienceRole, teamId, !!b.pinned, perm.userId])).rows[0];
    await logEvent({ userId: perm.userId, action: 'create', target: `notice:${r.id}`, detail: { audience } });
    return { id: r.id };
  });

  // 읽음 확인 — 최초 1회만 기록(이후 호출은 기존 read_at 보존)
  app.post('/api/notices/:id/read', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const exists = (await query(`SELECT id FROM notices WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!exists) return reply.code(404).send({ error: 'not_found' });
    const r = (await query(
      `INSERT INTO notice_reads (notice_id, user_id) VALUES ($1,$2)
       ON CONFLICT (notice_id, user_id) DO NOTHING RETURNING read_at`, [id, perm.userId])).rows[0];
    // 이미 읽은 경우 기존 시각 반환
    const row = r || (await query(`SELECT read_at FROM notice_reads WHERE notice_id=$1 AND user_id=$2`, [id, perm.userId])).rows[0];
    return { read_at: isoTs(row.read_at) };
  });

  // 공지별 읽음 현황(디렉터) — 누가 언제 처음 읽었는지
  app.get('/api/notices/:id/reads', { preHandler: [authGuard, requireDirector] }, async (req) => {
    const id = Number(req.params.id);
    const reads = (await query(
      `SELECT u.id, u.name, nr.read_at FROM notice_reads nr JOIN users u ON u.id=nr.user_id
        WHERE nr.notice_id=$1 ORDER BY nr.read_at`, [id])).rows;
    return { items: reads.map((r) => ({ user_id: r.id, name: r.name, read_at: isoTs(r.read_at) })) };
  });

  app.delete('/api/notices/:id', { preHandler: [authGuard, requireDirector] }, async (req) => {
    await query(`UPDATE notices SET deleted_at=now() WHERE id=$1`, [Number(req.params.id)]);
    return { ok: true };
  });

  // =================== 할 일 (Todo) ===================
  // 디렉터: 전체 / 일반: 내게 배정된 것
  app.get('/api/todos', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const status = req.query.status === 'done' ? 'done' : (req.query.status === 'all' ? null : 'open');
    const conds = [`t.deleted_at IS NULL`];
    const args = [];
    if (perm.role !== 'director') { args.push(perm.userId); conds.push(`t.assignee_id=$${args.length}`); }
    else if (req.query.assignee_id) { args.push(Number(req.query.assignee_id)); conds.push(`t.assignee_id=$${args.length}`); }
    if (status) { args.push(status); conds.push(`t.status=$${args.length}`); }
    const rows = (await query(
      `SELECT t.id, t.title, t.detail, t.assignee_id, t.due_date, t.status, t.done_at, t.done_note, t.created_at, t.kind,
              a.name AS assignee_name, c.name AS created_by_name
         FROM todos t
         LEFT JOIN users a ON a.id=t.assignee_id
         LEFT JOIN users c ON c.id=t.created_by
        WHERE ${conds.join(' AND ')}
        ORDER BY t.status, t.due_date NULLS LAST, t.id DESC`, args)).rows;
    const today = new Date().toISOString().slice(0, 10);
    return {
      items: rows.map((r) => ({
        id: r.id, title: r.title, detail: r.detail, assignee_id: r.assignee_id, assignee_name: r.assignee_name,
        due_date: d10(r.due_date), status: r.status, done_at: isoTs(r.done_at), done_note: r.done_note, kind: r.kind || null,
        created_by_name: r.created_by_name, overdue: r.status === 'open' && r.due_date && d10(r.due_date) < today,
      })),
    };
  });

  // 배정(디렉터만)
  app.post('/api/todos', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return reply.code(400).send({ error: 'title_required' });
    const assignee = Number(b.assignee_id);
    if (!assignee) return reply.code(400).send({ error: 'assignee_required' });
    const due = (b.due_date && /^\d{4}-\d{2}-\d{2}$/.test(String(b.due_date))) ? b.due_date : null;
    const r = (await query(
      `INSERT INTO todos (title, detail, assignee_id, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [String(b.title).trim(), b.detail ? String(b.detail) : null, assignee, due, perm.userId])).rows[0];
    await logEvent({ userId: perm.userId, action: 'create', target: `todo:${r.id}`, detail: { assignee } });
    return { id: r.id };
  });

  // 완료 토글(담당자 본인 또는 디렉터)
  app.post('/api/todos/:id/done', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const b = req.body || {};
    const t = (await query(`SELECT assignee_id, status FROM todos WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (perm.role !== 'director' && Number(t.assignee_id) !== perm.userId) return reply.code(403).send({ error: 'forbidden' });
    const done = b.done !== false; // 기본 완료, done:false면 되돌리기
    if (done) await query(`UPDATE todos SET status='done', done_at=now(), done_note=$2 WHERE id=$1`, [id, b.note ? String(b.note) : null]);
    else await query(`UPDATE todos SET status='open', done_at=NULL, done_note=NULL WHERE id=$1`, [id]);
    return { ok: true, status: done ? 'done' : 'open' };
  });

  app.delete('/api/todos/:id', { preHandler: [authGuard, requireDirector] }, async (req) => {
    await query(`UPDATE todos SET deleted_at=now() WHERE id=$1`, [Number(req.params.id)]);
    return { ok: true };
  });
}
