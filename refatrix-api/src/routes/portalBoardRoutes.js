import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { visibleTeamIds } from '../teams.js';
import { logEvent } from '../audit.js';

function d10(d) { if (!d) return null; if (d instanceof Date) return d.toISOString().slice(0, 10); return String(d).slice(0, 10); }
function isoTs(d) { if (!d) return null; if (d instanceof Date) return d.toISOString(); return String(d); }

// 'users' 대상 공지들의 대상자 매핑 { names:{notice_id:[name]}, ids:{notice_id:[id]} }
async function loadTargets(noticeIds) {
  if (!noticeIds || !noticeIds.length) return { names: {}, ids: {} };
  const rows = (await query(
    `SELECT nt.notice_id, u.id, u.name
       FROM notice_targets nt JOIN users u ON u.id=nt.user_id
      WHERE nt.notice_id = ANY($1) ORDER BY u.name`, [noticeIds])).rows;
  const names = {}, ids = {};
  for (const r of rows) {
    (names[r.notice_id] = names[r.notice_id] || []).push(r.name);
    (ids[r.notice_id] = ids[r.notice_id] || []).push(Number(r.id));
  }
  return { names, ids };
}

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
    // 본인 id 는 가시성·읽음 조인 양쪽에서 쓰므로 먼저 바인딩
    args.push(perm.userId); const meIdx = args.length;
    // 디렉터만 전체 열람. 비디렉터는 대상 필터 적용(sales_support 처럼 전 팀 가시여도 'users'/'role' 은 반드시 필터).
    if (perm.role !== 'director') {
      args.push(perm.role); const rIdx = args.length;
      let teamClause;
      if (vis === null) {
        teamClause = `n.audience='team'`;                 // 전 팀 가시 → 모든 팀 공지 visible
      } else {
        args.push(vis.length ? vis : [-1]); const tIdx = args.length;
        teamClause = `(n.audience='team' AND n.team_id = ANY($${tIdx}))`;
      }
      conds.push(`(n.audience='all'
                 OR (n.audience='role' AND n.audience_role=$${rIdx})
                 OR ${teamClause}
                 OR (n.audience='users' AND n.id IN (SELECT notice_id FROM notice_targets WHERE user_id=$${meIdx})))`);
    }
    const rows = (await query(
      `SELECT n.id, n.title, n.body, n.audience, n.audience_role, n.team_id, n.pinned, n.is_popup, n.created_at,
              u.name AS author, t.name AS team_name,
              nr.read_at AS my_read_at
         FROM notices n
         LEFT JOIN users u ON u.id=n.created_by
         LEFT JOIN sales_teams t ON t.id=n.team_id
         LEFT JOIN notice_reads nr ON nr.notice_id=n.id AND nr.user_id=$${meIdx}
        WHERE ${conds.join(' AND ')}
        ORDER BY n.pinned DESC, n.created_at DESC`, args)).rows;
    // 'users' 대상 공지의 대상자(디렉터 화면 라벨 + 수정 폼 사전선택용) — 별도 조회 후 머지
    const tgt = await loadTargets(rows.filter((r) => r.audience === 'users').map((r) => r.id));
    return {
      items: rows.map((r) => ({
        id: r.id, title: r.title, body: r.body, audience: r.audience, audience_role: r.audience_role,
        team_id: r.team_id, team_name: r.team_name, pinned: r.pinned, is_popup: !!r.is_popup, author: r.author,
        target_names: tgt.names[r.id] || [], target_ids: tgt.ids[r.id] || [],
        created_at: isoTs(r.created_at), my_read_at: isoTs(r.my_read_at), read: !!r.my_read_at,
      })),
      unread: rows.filter((r) => !r.my_read_at).length,
    };
  });

  // 로그인 팝업용 — 나에게 해당되는 '미확인' 공지 중 is_popup=true 만
  app.get('/api/notices/popup', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const vis = visibleTeamIds(perm);
    const conds = [`n.deleted_at IS NULL`, `n.is_popup = true`, `nr.read_at IS NULL`];
    const args = [];
    args.push(perm.userId); const meIdx = args.length;
    if (perm.role !== 'director') {
      args.push(perm.role); const rIdx = args.length;
      let teamClause;
      if (vis === null) {
        teamClause = `n.audience='team'`;
      } else {
        args.push(vis.length ? vis : [-1]); const tIdx = args.length;
        teamClause = `(n.audience='team' AND n.team_id = ANY($${tIdx}))`;
      }
      conds.push(`(n.audience='all'
                 OR (n.audience='role' AND n.audience_role=$${rIdx})
                 OR ${teamClause}
                 OR (n.audience='users' AND n.id IN (SELECT notice_id FROM notice_targets WHERE user_id=$${meIdx})))`);
    }
    const rows = (await query(
      `SELECT n.id, n.title, n.body, n.pinned, n.created_at, u.name AS author
         FROM notices n
         LEFT JOIN users u ON u.id=n.created_by
         LEFT JOIN notice_reads nr ON nr.notice_id=n.id AND nr.user_id=$${meIdx}
        WHERE ${conds.join(' AND ')}
        ORDER BY n.pinned DESC, n.created_at DESC`, args)).rows;
    return {
      items: rows.map((r) => ({
        id: r.id, title: r.title, body: r.body, pinned: r.pinned,
        author: r.author, created_at: isoTs(r.created_at),
      })),
    };
  });

  app.post('/api/notices', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return reply.code(400).send({ error: 'title_required' });
    const audience = ['all', 'role', 'team', 'users'].includes(b.audience) ? b.audience : 'all';
    const audienceRole = audience === 'role' ? (b.audience_role || null) : null;
    const teamId = audience === 'team' ? (Number(b.team_id) || null) : null;
    if (audience === 'role' && !audienceRole) return reply.code(400).send({ error: 'role_required' });
    if (audience === 'team' && !teamId) return reply.code(400).send({ error: 'team_required' });
    // 특정 유저 지정(중복선택): 정수 id 배열로 정규화
    let targetIds = [];
    if (audience === 'users') {
      targetIds = Array.isArray(b.target_ids)
        ? [...new Set(b.target_ids.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))]
        : [];
      if (!targetIds.length) return reply.code(400).send({ error: 'targets_required' });
    }
    const isPopup = b.is_popup === undefined ? true : !!b.is_popup; // 기본 ON
    const r = (await query(
      `INSERT INTO notices (title, body, audience, audience_role, team_id, pinned, is_popup, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [String(b.title).trim(), b.body ? String(b.body) : null, audience, audienceRole, teamId, !!b.pinned, isPopup, perm.userId])).rows[0];
    if (audience === 'users' && targetIds.length) {
      // 존재하는 유저만 INSERT (FK 위반 방지) — 한 건씩, 중복은 UNIQUE 로 무시
      for (const uid of targetIds) {
        await query(
          `INSERT INTO notice_targets (notice_id, user_id)
             SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL)
           ON CONFLICT (notice_id, user_id) DO NOTHING`, [r.id, uid]);
      }
    }
    await logEvent({ userId: perm.userId, action: 'create', target: `notice:${r.id}`, detail: { audience, is_popup: isPopup, targets: targetIds.length } });
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

  // 공지 수정(디렉터) — 제목/내용/대상/고정/팝업 변경 + 대상 재동기화
  app.patch('/api/notices/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const b = req.body || {};
    const exists = (await query(`SELECT id FROM notices WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!exists) return reply.code(404).send({ error: 'not_found' });
    if (!b.title || !String(b.title).trim()) return reply.code(400).send({ error: 'title_required' });
    const audience = ['all', 'role', 'team', 'users'].includes(b.audience) ? b.audience : 'all';
    const audienceRole = audience === 'role' ? (b.audience_role || null) : null;
    const teamId = audience === 'team' ? (Number(b.team_id) || null) : null;
    if (audience === 'role' && !audienceRole) return reply.code(400).send({ error: 'role_required' });
    if (audience === 'team' && !teamId) return reply.code(400).send({ error: 'team_required' });
    let targetIds = [];
    if (audience === 'users') {
      targetIds = Array.isArray(b.target_ids)
        ? [...new Set(b.target_ids.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))]
        : [];
      if (!targetIds.length) return reply.code(400).send({ error: 'targets_required' });
    }
    const isPopup = b.is_popup === undefined ? true : !!b.is_popup;
    await query(
      `UPDATE notices SET title=$1, body=$2, audience=$3, audience_role=$4, team_id=$5, pinned=$6, is_popup=$7
        WHERE id=$8`,
      [String(b.title).trim(), b.body ? String(b.body) : null, audience, audienceRole, teamId, !!b.pinned, isPopup, id]);
    // 대상 재동기화: 모두 비우고, 'users' 면 재삽입
    await query(`DELETE FROM notice_targets WHERE notice_id=$1`, [id]);
    if (audience === 'users' && targetIds.length) {
      for (const uid of targetIds) {
        await query(
          `INSERT INTO notice_targets (notice_id, user_id)
             SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM users WHERE id=$2 AND deleted_at IS NULL)
           ON CONFLICT (notice_id, user_id) DO NOTHING`, [id, uid]);
      }
    }
    await logEvent({ userId: perm.userId, action: 'update', target: `notice:${id}`, detail: { audience, is_popup: isPopup, targets: targetIds.length } });
    return { ok: true, id };
  });

  app.delete('/api/notices/:id', { preHandler: [authGuard, requireDirector] }, async (req) => {
    await query(`UPDATE notices SET deleted_at=now() WHERE id=$1`, [Number(req.params.id)]);
    return { ok: true };
  });

  // =================== 할 일 (Todo) ===================
  // 디렉터: 전체 / 일반: 내게 배정된 것
  // 할 일 배정용 사용자 목록(로그인 누구나 — 협조 요청 대상 선택)
  app.get('/api/todo-users', { preHandler: [authGuard] }, async () => {
    const rows = (await query(
      `SELECT id, name, role FROM users WHERE deleted_at IS NULL ORDER BY name`)).rows;
    return { items: rows.map((r) => ({ id: r.id, name: r.name, role: r.role })) };
  });

  app.get('/api/todos', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const status = req.query.status === 'done' ? 'done' : (req.query.status === 'all' ? null : 'open');
    const conds = [`t.deleted_at IS NULL`];
    const args = [];
    // 가시성: 디렉터=전체 / 그 외=내게 배정 OR 전체(all) OR 내가 만든 것
    if (perm.role !== 'director') {
      args.push(perm.userId);
      conds.push(`(t.assignee_id=$${args.length} OR t.scope='all' OR t.created_by=$${args.length})`);
    } else if (req.query.assignee_id) {
      args.push(Number(req.query.assignee_id));
      conds.push(`(t.assignee_id=$${args.length})`);
    }
    if (status) { args.push(status); conds.push(`t.status=$${args.length}`); }
    const rows = (await query(
      `SELECT t.id, t.title, t.detail, t.assignee_id, t.due_date, t.due_pending, t.scope, t.level,
              t.status, t.done_at, t.done_note, t.created_at, t.created_by, t.kind,
              a.name AS assignee_name, c.name AS created_by_name,
              (SELECT COUNT(*) FROM todo_memos m WHERE m.todo_id=t.id AND m.deleted_at IS NULL) AS memo_count
         FROM todos t
         LEFT JOIN users a ON a.id=t.assignee_id
         LEFT JOIN users c ON c.id=t.created_by
        WHERE ${conds.join(' AND ')}
        ORDER BY t.status, (t.due_date IS NULL), t.due_date, t.id DESC`, args)).rows;
    const today = new Date().toISOString().slice(0, 10);
    const todayMs = new Date(today).getTime();
    return {
      items: rows.map((r) => {
        const due = d10(r.due_date);
        const created = d10(r.created_at);
        const daysSince = created ? Math.max(0, Math.round((todayMs - new Date(created).getTime()) / 86400000)) : null;
        return {
          id: r.id, title: r.title, detail: r.detail,
          assignee_id: r.assignee_id, assignee_name: r.assignee_name,
          scope: r.scope || 'user', level: r.level || 'assigned',
          due_date: due, due_pending: !!r.due_pending,
          status: r.status, done_at: isoTs(r.done_at), done_note: r.done_note, kind: r.kind || null,
          created_by: r.created_by, created_by_name: r.created_by_name,
          created_at: isoTs(r.created_at), days_since: daysSince,
          memo_count: Number(r.memo_count) || 0,
          overdue: r.status === 'open' && due && due < today,
        };
      }),
    };
  });

  // 생성: 디렉터=지시/전체, 비디렉터=자가('self')/협조('coop')
  app.post('/api/todos', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return reply.code(400).send({ error: 'title_required' });
    const isDir = perm.role === 'director';
    let scope = (b.scope === 'all') ? 'all' : 'user';
    let level = b.level;
    let assignee = b.assignee_id ? Number(b.assignee_id) : null;

    if (isDir) {
      // 디렉터: 전체 또는 특정 담당자에게 지시
      if (scope === 'all') { assignee = null; level = level || 'assigned'; }
      else {
        if (!assignee) return reply.code(400).send({ error: 'assignee_required' });
        level = level || 'assigned';
      }
    } else {
      // 비디렉터: 전체 배정 불가
      scope = 'user';
      const me = Number(perm.userId);
      if (assignee && assignee !== me) {
        level = 'coop';   // 타 팀원에게 협조 요청
      } else {
        level = 'self';   // 자가 작성
        assignee = me;
      }
    }
    // 마감: 미정이면 due_pending, 아니면 날짜
    const duePending = b.due_pending === true || b.due_date === 'pending';
    const due = (!duePending && b.due_date && /^\d{4}-\d{2}-\d{2}$/.test(String(b.due_date))) ? b.due_date : null;

    const r = (await query(
      `INSERT INTO todos (title, detail, assignee_id, due_date, due_pending, scope, level, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [String(b.title).trim(), b.detail ? String(b.detail) : null, assignee, due, duePending, scope, level, perm.userId])).rows[0];
    await logEvent({ userId: perm.userId, action: 'create', target: `todo:${r.id}`, detail: { assignee, scope, level } });
    return { id: r.id };
  });

  // 마감일 확정(미정이었던 건 — 담당자/생성자/디렉터)
  app.patch('/api/todos/:id/due', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const b = req.body || {};
    const t = (await query(`SELECT assignee_id, created_by, scope FROM todos WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const mine = perm.role === 'director' || Number(t.assignee_id) === Number(perm.userId) || Number(t.created_by) === Number(perm.userId) || t.scope === 'all';
    if (!mine) return reply.code(403).send({ error: 'forbidden' });
    if (!b.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.due_date))) return reply.code(400).send({ error: 'bad_date' });
    await query(`UPDATE todos SET due_date=$2, due_pending=false, updated_at=now() WHERE id=$1`, [id, b.due_date]);
    return { ok: true, due_date: b.due_date };
  });

  // 릴레이 메모 목록
  app.get('/api/todos/:id/memos', { preHandler: [authGuard] }, async (req, reply) => {
    const id = Number(req.params.id);
    const rows = (await query(
      `SELECT m.id, m.body, m.author_id, m.created_at, u.name AS author_name, u.role AS author_role
         FROM todo_memos m LEFT JOIN users u ON u.id=m.author_id
        WHERE m.todo_id=$1 AND m.deleted_at IS NULL ORDER BY m.created_at, m.id`, [id])).rows;
    return { items: rows.map((r) => ({ id: r.id, body: r.body, author_id: r.author_id, author_name: r.author_name, author_role: r.author_role, created_at: isoTs(r.created_at) })) };
  });

  // 릴레이 메모 작성 (참여자: 담당자/생성자/디렉터, 전체건은 누구나)
  app.post('/api/todos/:id/memos', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const b = req.body || {};
    const body = String(b.body || '').trim();
    if (!body) return reply.code(400).send({ error: 'body_required' });
    const t = (await query(`SELECT assignee_id, created_by, scope FROM todos WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const allowed = perm.role === 'director' || t.scope === 'all' || Number(t.assignee_id) === Number(perm.userId) || Number(t.created_by) === Number(perm.userId);
    if (!allowed) return reply.code(403).send({ error: 'forbidden' });
    const r = (await query(`INSERT INTO todo_memos (todo_id, author_id, body) VALUES ($1,$2,$3) RETURNING id, created_at`, [id, perm.userId, body])).rows[0];
    await query(`UPDATE todos SET updated_at=now() WHERE id=$1`, [id]);
    return { ok: true, id: r.id, created_at: isoTs(r.created_at) };
  });

  // 완료 토글 (담당자/생성자/디렉터, 전체건은 디렉터/생성자)
  app.post('/api/todos/:id/done', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const b = req.body || {};
    const t = (await query(`SELECT assignee_id, created_by, scope, status FROM todos WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const allowed = perm.role === 'director' || Number(t.assignee_id) === Number(perm.userId) || Number(t.created_by) === Number(perm.userId);
    if (!allowed) return reply.code(403).send({ error: 'forbidden' });
    const done = b.done !== false;
    if (done) await query(`UPDATE todos SET status='done', done_at=now(), done_note=$2, updated_at=now() WHERE id=$1`, [id, b.note ? String(b.note) : null]);
    else await query(`UPDATE todos SET status='open', done_at=NULL, done_note=NULL, updated_at=now() WHERE id=$1`, [id]);
    return { ok: true, status: done ? 'done' : 'open' };
  });

  // 삭제 (생성자 또는 디렉터)
  app.delete('/api/todos/:id', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const t = (await query(`SELECT created_by FROM todos WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (perm.role !== 'director' && Number(t.created_by) !== Number(perm.userId)) return reply.code(403).send({ error: 'forbidden' });
    await query(`UPDATE todos SET deleted_at=now() WHERE id=$1`, [id]);
    return { ok: true };
  });
}
