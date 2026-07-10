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

// scope='shared' 일정들의 공유 대상자 매핑 { names:{event_id:[name]}, ids:{event_id:[id]} }
async function loadEventTargets(eventIds) {
  if (!eventIds || !eventIds.length) return { names: {}, ids: {} };
  const rows = (await query(
    `SELECT ct.event_id, u.id, u.name
       FROM calendar_event_targets ct JOIN users u ON u.id=ct.user_id
      WHERE ct.event_id = ANY($1) ORDER BY u.name`, [eventIds])).rows;
  const names = {}, ids = {};
  for (const r of rows) {
    (names[r.event_id] = names[r.event_id] || []).push(r.name);
    (ids[r.event_id] = ids[r.event_id] || []).push(Number(r.id));
  }
  return { names, ids };
}

// 요청 본문에서 공유 대상 user_id 배열을 정제(중복/비정수 제거).
function cleanTargetIds(raw) {
  if (!Array.isArray(raw)) return [];
  const set = new Set();
  for (const v of raw) { const n = Number(v); if (Number.isInteger(n) && n > 0) set.add(n); }
  return [...set];
}

// 일정의 공유 대상자 전체 교체(DELETE 후 INSERT). targetIds 비면 전부 제거.
async function setEventTargets(eventId, targetIds) {
  await query(`DELETE FROM calendar_event_targets WHERE event_id=$1`, [eventId]);
  if (!targetIds.length) return;
  const vals = targetIds.map((_, i) => `($1,$${i + 2})`).join(',');
  await query(
    `INSERT INTO calendar_event_targets (event_id, user_id) VALUES ${vals} ON CONFLICT DO NOTHING`,
    [eventId, ...targetIds]);
}

// 메모 권한 판정용: 일정 1건 로드(삭제 제외).
async function loadEventForPerm(eventId) {
  return (await query(
    `SELECT id, scope, team_id, owner_id, created_by FROM calendar_events WHERE id=$1 AND deleted_at IS NULL`,
    [eventId])).rows[0] || null;
}

// 이 사용자가 해당 일정을 볼 수 있는가(= 메모 '대상자'인가).
// GET /api/calendar 의 가시성 규칙과 동일. director 는 전부.
async function userCanSeeEvent(perm, e) {
  if (!e) return false;
  if (perm.role === 'director') return true;
  const me = Number(perm.userId);
  if (e.created_by != null && Number(e.created_by) === me) return true;
  if (e.scope === 'company') return true;
  if (e.scope === 'personal') return Number(e.owner_id) === me;
  if (e.scope === 'team') {
    const vis = visibleTeamIds(perm); // null=영업지원(전 영업팀 열람)
    if (vis === null) return true;
    return vis.map(Number).includes(Number(e.team_id));
  }
  if (e.scope === 'shared') {
    const t = (await query(
      `SELECT 1 FROM calendar_event_targets WHERE event_id=$1 AND user_id=$2 LIMIT 1`, [e.id, me])).rows[0];
    return !!t;
  }
  return false;
}

export default async function portalBoardRoutes(app) {
  // =================== 일정 (Calendar) ===================
  // 보이는 일정: 회사전체(company) + 내가 지정 대상인/내가 만든 공유(shared) + 내 개인(personal) + (레거시) 내 팀(team) + 내가 만든 것
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
    } else if (perm.role === 'director') {
      // 디렉터: 전부 (역할 기준으로 엄격 판정 — vis===null 은 영업지원도 해당하므로 사용 금지)
    } else {
      // 비디렉터 가시성: 회사전체 + (영업지원은 전 영업팀/그 외는 소속 팀) + 내 개인 + 내가 대상/작성자인 공유 + 내가 만든 것
      args.push(perm.userId); const meIdx = args.length;
      let teamClause;
      if (vis === null) {
        // sales_support: 전 영업팀 공동(team) 일정은 보되, 남의 개인/미지정 공유는 제외
        teamClause = `e.scope='team'`;
      } else {
        const myTeams = vis.length ? vis : [-1];
        args.push(myTeams); const teamIdx = args.length;
        teamClause = `(e.scope='team' AND e.team_id = ANY($${teamIdx}))`;
      }
      conds.push(`(e.scope='company'
        OR ${teamClause}
        OR (e.scope='personal' AND e.owner_id=$${meIdx})
        OR (e.scope='shared' AND (e.created_by=$${meIdx} OR EXISTS (SELECT 1 FROM calendar_event_targets ct WHERE ct.event_id=e.id AND ct.user_id=$${meIdx})))
        OR e.created_by=$${meIdx})`);
    }
    const rows = (await query(
      `SELECT e.id, e.event_date, e.event_time, e.event_at, e.content, e.scope, e.team_id, e.owner_id, e.created_by,
              t.name AS team_name, u.name AS owner_name
         FROM calendar_events e
         LEFT JOIN sales_teams t ON t.id=e.team_id
         LEFT JOIN users u ON u.id=e.owner_id
        WHERE ${conds.join(' AND ')}
        ORDER BY COALESCE(e.event_at, e.event_date::timestamptz), e.event_time NULLS FIRST, e.id`, args)).rows;
    const sharedIds = rows.filter((r) => r.scope === 'shared').map((r) => r.id);
    const tmap = await loadEventTargets(sharedIds);
    return {
      items: rows.map((r) => ({
        id: r.id, date: d10(r.event_date), time: r.event_time || null, at: isoTs(r.event_at), content: r.content,
        scope: r.scope, team_id: r.team_id, team_name: r.team_name, owner_id: r.owner_id, owner_name: r.owner_name,
        created_by: r.created_by != null ? Number(r.created_by) : null,
        target_ids: tmap.ids[r.id] || [], target_names: tmap.names[r.id] || [],
      })),
    };
  });

  app.post('/api/calendar', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const b = req.body || {};
    const scope = ['company', 'team', 'personal', 'shared'].includes(b.scope) ? b.scope : 'personal';
    if (!b.event_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.event_date))) return reply.code(400).send({ error: 'date_required' });
    if (!b.content || !String(b.content).trim()) return reply.code(400).send({ error: 'content_required' });
    // 회사전체·팀 일정은 디렉터만. (개인별 지정 공유는 누구나 가능)
    if ((scope === 'company' || scope === 'team') && perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const teamId = scope === 'team' ? (Number(b.team_id) || null) : null;
    if (scope === 'team' && !teamId) return reply.code(400).send({ error: 'team_required' });
    const ownerId = scope === 'personal' ? (Number(b.owner_id) || perm.userId) : null;
    // 개인 일정을 남에게 지정하는 건 디렉터만(본인 것은 누구나)
    if (scope === 'personal' && ownerId !== perm.userId && perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const targetIds = scope === 'shared' ? cleanTargetIds(b.target_ids) : [];
    // 절대시각: 클라이언트가 입력자 위치(브라우저 시간대) 기준으로 계산해 보낸 ISO 순간.
    let eventAt = null;
    if (b.event_at) { const dd = new Date(b.event_at); if (!Number.isNaN(dd.getTime())) eventAt = dd.toISOString(); }
    const r = (await query(
      `INSERT INTO calendar_events (event_date, event_time, event_at, content, scope, team_id, owner_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.event_date, b.event_time ? String(b.event_time).trim() : null, eventAt, String(b.content).trim(), scope, teamId, ownerId, perm.userId])).rows[0];
    if (scope === 'shared') await setEventTargets(r.id, targetIds);
    await logEvent({ userId: perm.userId, action: 'create', target: `calendar_event:${r.id}`, detail: { scope, targets: targetIds.length } });
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

  // 일정 수정: 작성자 본인 또는 디렉터만. 검증 규칙은 POST와 동일.
  app.patch('/api/calendar/:id', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const b = req.body || {};
    const cur = (await query(`SELECT created_by, scope FROM calendar_events WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (perm.role !== 'director' && Number(cur.created_by) !== perm.userId) return reply.code(403).send({ error: 'forbidden' });
    const scope = ['company', 'team', 'personal', 'shared'].includes(b.scope) ? b.scope : cur.scope;
    if (!b.event_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.event_date))) return reply.code(400).send({ error: 'date_required' });
    if (!b.content || !String(b.content).trim()) return reply.code(400).send({ error: 'content_required' });
    if ((scope === 'company' || scope === 'team') && perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const teamId = scope === 'team' ? (Number(b.team_id) || null) : null;
    if (scope === 'team' && !teamId) return reply.code(400).send({ error: 'team_required' });
    const ownerId = scope === 'personal' ? (Number(b.owner_id) || perm.userId) : null;
    if (scope === 'personal' && ownerId !== perm.userId && perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const targetIds = scope === 'shared' ? cleanTargetIds(b.target_ids) : [];
    let eventAt = null;
    if (b.event_at) { const dd = new Date(b.event_at); if (!Number.isNaN(dd.getTime())) eventAt = dd.toISOString(); }
    await query(
      `UPDATE calendar_events SET event_date=$1, event_time=$2, event_at=$3, content=$4, scope=$5, team_id=$6, owner_id=$7 WHERE id=$8`,
      [b.event_date, b.event_time ? String(b.event_time).trim() : null, eventAt, String(b.content).trim(), scope, teamId, ownerId, id]);
    // scope=shared 이면 대상자 교체. 다른 scope 로 바뀌었으면 기존 대상 매핑 제거.
    if (scope === 'shared') await setEventTargets(id, targetIds);
    else await setEventTargets(id, []);
    await logEvent({ userId: perm.userId, action: 'update', target: `calendar_event:${id}`, detail: { scope, targets: targetIds.length } });
    return { ok: true };
  });

  // =================== 일정 메모(댓글) ===================
  // 목록: 일정을 볼 수 있는 사람(대상자)만 조회.
  app.get('/api/calendar/:id/memos', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const e = await loadEventForPerm(id);
    if (!e) return reply.code(404).send({ error: 'not_found' });
    if (!(await userCanSeeEvent(perm, e))) return reply.code(403).send({ error: 'forbidden' });
    const rows = (await query(
      `SELECT m.id, m.body, m.author_id, m.created_at, m.updated_at, u.name AS author_name, u.role AS author_role
         FROM calendar_event_memos m LEFT JOIN users u ON u.id=m.author_id
        WHERE m.event_id=$1 AND m.deleted_at IS NULL ORDER BY m.created_at, m.id`, [id])).rows;
    return {
      items: rows.map((r) => ({
        id: r.id, body: r.body,
        author_id: r.author_id != null ? Number(r.author_id) : null,
        author_name: r.author_name, author_role: r.author_role,
        created_at: isoTs(r.created_at), updated_at: isoTs(r.updated_at), edited: !!r.updated_at,
      })),
    };
  });

  // 작성: 대상자 누구나. 작성자 본인은 자기 메모 팝업이 안 뜨도록 즉시 seen 처리.
  app.post('/api/calendar/:id/memos', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const b = req.body || {};
    const body = String(b.body || '').trim();
    if (!body) return reply.code(400).send({ error: 'body_required' });
    const e = await loadEventForPerm(id);
    if (!e) return reply.code(404).send({ error: 'not_found' });
    if (!(await userCanSeeEvent(perm, e))) return reply.code(403).send({ error: 'forbidden' });
    const r = (await query(
      `INSERT INTO calendar_event_memos (event_id, author_id, body) VALUES ($1,$2,$3) RETURNING id, created_at`,
      [id, perm.userId, body])).rows[0];
    await query(`INSERT INTO calendar_memo_seen (memo_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [r.id, perm.userId]);
    await logEvent({ userId: perm.userId, action: 'create', target: `calendar_memo:${r.id}`, detail: { event: id } });
    return { ok: true, id: r.id, created_at: isoTs(r.created_at) };
  });

  // 수정: 작성자 본인만(디렉터도 남의 메모는 수정 불가 — 색상=작성자 원칙 유지).
  app.patch('/api/calendar/memos/:memoId', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const memoId = Number(req.params.memoId);
    const b = req.body || {};
    const body = String(b.body || '').trim();
    if (!body) return reply.code(400).send({ error: 'body_required' });
    const m = (await query(`SELECT author_id FROM calendar_event_memos WHERE id=$1 AND deleted_at IS NULL`, [memoId])).rows[0];
    if (!m) return reply.code(404).send({ error: 'not_found' });
    if (Number(m.author_id) !== Number(perm.userId)) return reply.code(403).send({ error: 'forbidden' });
    await query(`UPDATE calendar_event_memos SET body=$1, updated_at=now() WHERE id=$2`, [body, memoId]);
    await logEvent({ userId: perm.userId, action: 'update', target: `calendar_memo:${memoId}` });
    return { ok: true };
  });

  // 삭제: 디렉터만.
  app.delete('/api/calendar/memos/:memoId', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const memoId = Number(req.params.memoId);
    if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const m = (await query(`SELECT id FROM calendar_event_memos WHERE id=$1 AND deleted_at IS NULL`, [memoId])).rows[0];
    if (!m) return reply.code(404).send({ error: 'not_found' });
    await query(`UPDATE calendar_event_memos SET deleted_at=now() WHERE id=$1`, [memoId]);
    await logEvent({ userId: perm.userId, action: 'delete', target: `calendar_memo:${memoId}` });
    return { ok: true };
  });

  // 새 메모 팝업용 — 내가 볼 수 있는 일정에 달린, 내가 안 쓴, 아직 확인 안 한 메모.
  app.get('/api/calendar/memos/unseen', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const vis = visibleTeamIds(perm);
    const args = [];
    args.push(perm.userId); const meIdx = args.length; // $1 = me
    let visClause;
    if (perm.role === 'director') {
      visClause = 'TRUE';
    } else {
      let teamClause;
      if (vis === null) {
        teamClause = `e.scope='team'`;
      } else {
        const myTeams = vis.length ? vis : [-1];
        args.push(myTeams); const teamIdx = args.length;
        teamClause = `(e.scope='team' AND e.team_id = ANY($${teamIdx}))`;
      }
      visClause = `(e.scope='company'
        OR ${teamClause}
        OR (e.scope='personal' AND e.owner_id=$${meIdx})
        OR (e.scope='shared' AND (e.created_by=$${meIdx} OR EXISTS (SELECT 1 FROM calendar_event_targets ct WHERE ct.event_id=e.id AND ct.user_id=$${meIdx})))
        OR e.created_by=$${meIdx})`;
    }
    const rows = (await query(
      `SELECT m.id, m.body, m.created_at, m.author_id, au.name AS author_name,
              e.id AS event_id, e.content AS event_title, e.event_date, e.event_at
         FROM calendar_event_memos m
         JOIN calendar_events e ON e.id=m.event_id AND e.deleted_at IS NULL
         LEFT JOIN users au ON au.id=m.author_id
        WHERE m.deleted_at IS NULL
          AND m.author_id <> $${meIdx}
          AND NOT EXISTS (SELECT 1 FROM calendar_memo_seen s WHERE s.memo_id=m.id AND s.user_id=$${meIdx})
          AND ${visClause}
        ORDER BY m.created_at, m.id
        LIMIT 50`, args)).rows;
    return {
      items: rows.map((r) => ({
        id: r.id, body: r.body, created_at: isoTs(r.created_at),
        author_id: r.author_id != null ? Number(r.author_id) : null, author_name: r.author_name,
        event_id: r.event_id, event_title: r.event_title,
        event_date: d10(r.event_date), event_at: isoTs(r.event_at),
      })),
    };
  });

  // 팝업 확인 → 표시된 메모들을 seen 처리(다음부터 안 뜸).
  app.post('/api/calendar/memos/seen', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    const b = req.body || {};
    const ids = cleanTargetIds(b.memo_ids);
    if (!ids.length) return { ok: true, marked: 0 };
    const vals = ids.map((_, i) => `($${i + 2},$1)`).join(',');
    await query(`INSERT INTO calendar_memo_seen (memo_id, user_id) VALUES ${vals} ON CONFLICT DO NOTHING`, [perm.userId, ...ids]);
    return { ok: true, marked: ids.length };
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
      `SELECT n.id, n.title, n.body, n.audience, n.audience_role, n.team_id, n.pinned, n.is_popup, n.popup_persist, n.created_at,
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
        team_id: r.team_id, team_name: r.team_name, pinned: r.pinned, is_popup: !!r.is_popup, popup_persist: !!r.popup_persist, author: r.author,
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
      `SELECT n.id, n.title, n.body, n.pinned, n.popup_persist, n.created_at, u.name AS author
         FROM notices n
         LEFT JOIN users u ON u.id=n.created_by
         LEFT JOIN notice_reads nr ON nr.notice_id=n.id AND nr.user_id=$${meIdx}
        WHERE ${conds.join(' AND ')}
        ORDER BY n.pinned DESC, n.created_at DESC`, args)).rows;
    return {
      items: rows.map((r) => ({
        id: r.id, title: r.title, body: r.body, pinned: r.pinned, popup_persist: !!r.popup_persist,
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
    const popupPersist = !!b.popup_persist;
    const r = (await query(
      `INSERT INTO notices (title, body, audience, audience_role, team_id, pinned, is_popup, popup_persist, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [String(b.title).trim(), b.body ? String(b.body) : null, audience, audienceRole, teamId, !!b.pinned, isPopup, popupPersist, perm.userId])).rows[0];
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
    const popupPersist = !!b.popup_persist;
    await query(
      `UPDATE notices SET title=$1, body=$2, audience=$3, audience_role=$4, team_id=$5, pinned=$6, is_popup=$7, popup_persist=$8
        WHERE id=$9`,
      [String(b.title).trim(), b.body ? String(b.body) : null, audience, audienceRole, teamId, !!b.pinned, isPopup, popupPersist, id]);
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
    // 제품개발 자동생성 알림(개발검토/개발완료)은 할 일 목록·달력에서 제외
    const conds = [`t.deleted_at IS NULL`, `COALESCE(t.kind,'') NOT IN ('dev_review','dev_complete')`];
    const args = [];
    // 가시성: 디렉터=전체 / 그 외=내가 담당(단일 또는 다중) OR 전체(all) OR 내가 만든 것
    if (perm.role !== 'director') {
      args.push(perm.userId);
      conds.push(`(EXISTS (SELECT 1 FROM todo_assignees ta WHERE ta.todo_id=t.id AND ta.user_id=$${args.length}) OR t.assignee_id=$${args.length} OR t.scope='all' OR t.created_by=$${args.length})`);
    } else if (req.query.assignee_id) {
      args.push(Number(req.query.assignee_id));
      conds.push(`(EXISTS (SELECT 1 FROM todo_assignees ta WHERE ta.todo_id=t.id AND ta.user_id=$${args.length}) OR t.assignee_id=$${args.length})`);
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
    // 다중 담당자 조회(대표 assignee_id 외 추가 담당자 포함)
    const ids = rows.map((r) => Number(r.id));
    const asgMap = {};
    if (ids.length) {
      const arows = (await query(
        `SELECT ta.todo_id, ta.user_id, u.name
           FROM todo_assignees ta JOIN users u ON u.id=ta.user_id
          WHERE ta.todo_id = ANY($1) ORDER BY ta.id`, [ids])).rows;
      for (const a of arows) {
        (asgMap[Number(a.todo_id)] = asgMap[Number(a.todo_id)] || []).push({ id: Number(a.user_id), name: a.name });
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    const todayMs = new Date(today).getTime();
    return {
      items: rows.map((r) => {
        const due = d10(r.due_date);
        const created = d10(r.created_at);
        const daysSince = created ? Math.max(0, Math.round((todayMs - new Date(created).getTime()) / 86400000)) : null;
        // 담당자 목록: 조인 테이블 우선, 없으면 대표 assignee 한 명(레거시)
        let asg = asgMap[Number(r.id)] || [];
        if (!asg.length && r.assignee_id) asg = [{ id: Number(r.assignee_id), name: r.assignee_name }];
        return {
          id: r.id, title: r.title, detail: r.detail,
          assignee_id: r.assignee_id, assignee_name: r.assignee_name,
          assignee_ids: asg.map((x) => x.id), assignee_names: asg.map((x) => x.name),
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
    // 다중 담당자: assignee_ids(배열) 우선, 없으면 legacy assignee_id 단일
    let assigneeIds = Array.isArray(b.assignee_ids) ? b.assignee_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
    if (!assigneeIds.length && b.assignee_id) assigneeIds = [Number(b.assignee_id)];
    assigneeIds = [...new Set(assigneeIds)]; // 중복 제거
    let assignee = assigneeIds.length ? assigneeIds[0] : null;

    if (isDir) {
      // 디렉터: 전체 또는 특정 담당자(여러 명)에게 지시
      if (scope === 'all') { assignee = null; assigneeIds = []; level = level || 'assigned'; }
      else {
        if (!assigneeIds.length) return reply.code(400).send({ error: 'assignee_required' });
        level = level || 'assigned';
      }
    } else {
      // 비디렉터: 전체 배정 불가
      scope = 'user';
      const me = Number(perm.userId);
      const others = assigneeIds.filter((id) => id !== me);
      if (others.length) {
        level = 'coop';        // 타 팀원(여러 명)에게 협조 요청
        assigneeIds = others;
        assignee = others[0];
      } else {
        level = 'self';        // 자가 작성
        assigneeIds = [me];
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
    // 다중 담당자 저장
    for (const uid of assigneeIds) {
      await query(`INSERT INTO todo_assignees (todo_id, user_id) VALUES ($1,$2) ON CONFLICT (todo_id, user_id) DO NOTHING`, [r.id, uid]);
    }
    await logEvent({ userId: perm.userId, action: 'create', target: `todo:${r.id}`, detail: { assignee, assignee_ids: assigneeIds, scope, level } });
    return { id: r.id };
  });

  // 마감일 확정(미정이었던 건 — 담당자/생성자/디렉터)
  app.patch('/api/todos/:id/due', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const b = req.body || {};
    const t = (await query(`SELECT assignee_id, created_by, scope FROM todos WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    const isAssignee = Number(t.assignee_id) === Number(perm.userId)
      || (await query(`SELECT 1 FROM todo_assignees WHERE todo_id=$1 AND user_id=$2`, [id, perm.userId])).rows.length > 0;
    const mine = perm.role === 'director' || isAssignee || Number(t.created_by) === Number(perm.userId) || t.scope === 'all';
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
    const isAssignee = Number(t.assignee_id) === Number(perm.userId)
      || (await query(`SELECT 1 FROM todo_assignees WHERE todo_id=$1 AND user_id=$2`, [id, perm.userId])).rows.length > 0;
    const allowed = perm.role === 'director' || t.scope === 'all' || isAssignee || Number(t.created_by) === Number(perm.userId);
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
    const isAssignee = Number(t.assignee_id) === Number(perm.userId)
      || (await query(`SELECT 1 FROM todo_assignees WHERE todo_id=$1 AND user_id=$2`, [id, perm.userId])).rows.length > 0;
    const allowed = perm.role === 'director' || isAssignee || Number(t.created_by) === Number(perm.userId);
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
