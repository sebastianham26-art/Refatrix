// =====================================================================
// Refatrix ERP · metaAssignRoutes.js — Meta 광고 문의 영업사원 배분 · 하루 목표 · 메모 · 실적 (0329 · 2026-11-19)
//   metaLeadsRoutes 안에서 등록(server.js 라우트 목록 변경 없음). 로직은 src/metaAssign.js
//
//   설정 · 배분 (디렉터 · 소시오)
//   GET  /api/meta-assign/config                    설정 · 대상자(오늘 할당/대화함) · 고를 수 있는 직원 · 나눌 문의 수 · 내 상태
//   PUT  /api/meta-assign/config {auto, mode:'share'|'target', default_target, pool_days, work_start, work_end, members:[{user_id, daily_target, share_pct, active}]}
//        mode='share'(0330) = 비율(%)대로 남김없이 · 'target' = 하루 목표(건)까지
//   POST /api/meta-assign/run                       지금 자동 분배(시간 · 자동 꺼짐과 관계없이)
//   POST /api/meta-leads/:id/assign {user_id|null}  사람이 직접 맡김 · 풀기
//   실적
//   GET  /api/meta-assign/perf?from&to&user          사람별 · 팀(디렉터 · 소시오) — 그 밖은 내 것만
//   GET  /api/meta-assign/list?from&to&user&state&q   전체 할당 목록(디렉터 · 소시오 · 1119b 「영업 할당 · 실적」 화면)
//   내 할당 (이 화면 접근 권한이면 누구나 — 자기 것)
//   GET  /api/meta-assign/mine?scope=today|open|week|month|need&user=  (user 는 디렉터 · 소시오만 · need = 0331 답장 필요)
//   POST /api/meta-leads/:id/called {note?}         「📞 전화함」 = 대화함(담당자 · 디렉터)
//   고객별 메모
//   GET  /api/meta-leads/:id/notes · POST {text} · DELETE /api/meta-leads/:id/notes/:nid (쓴 사람 · 디렉터)
// =====================================================================
import { query } from '../db.js';
import { DIR_SOCIO } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { NEED_SQL, unreadSql, replyReady } from '../metaReply.js';   // 0331 · 답장 필요
import {
  assignReady, getSettings, getMembers, assignThread, autoDistribute, refreshDone, markCalled, performance, poolCandidates,
} from '../metaAssign.js';

const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const ymd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null;
const isAdmin = (req) => DIR_SOCIO.includes(req.ctx.perm.role);
const mxToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

// 상세 화면용 — 담당 · 열린 할당 · 메모
export async function assignInfoFor(threadId) {
  if (!(await assignReady())) return null;
  const t = (await query(`SELECT t.assigned_to, u.name AS assigned_name, t.assigned_at FROM meta_threads t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.id=$1`, [threadId])).rows[0];
  if (!t) return null;
  const a = (await query(`SELECT id, user_id, how, day, assigned_at, done_at, done_how FROM meta_assignments WHERE thread_id=$1 AND ended_at IS NULL ORDER BY assigned_at DESC LIMIT 1`, [threadId])).rows[0];
  const notes = (await query(`SELECT n.id, n.user_id, u.name AS user_name, n.text, n.at FROM meta_lead_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.thread_id=$1 ORDER BY n.at, n.id`, [threadId])).rows
    .map((n) => ({ ...n, id: Number(n.id), user_id: n.user_id != null ? Number(n.user_id) : null }));
  return { assigned_to: t.assigned_to != null ? Number(t.assigned_to) : null, assigned_name: t.assigned_name || null, assigned_at: t.assigned_at,
    current: a ? { ...a, id: Number(a.id), user_id: Number(a.user_id), day: a.day ? new Date(a.day).toISOString().slice(0, 10) : null } : null, notes };
}
// 목록용 — id → {to, name}
export async function assignMap(ids) {
  const m = new Map();
  if (!ids.length || !(await assignReady())) return m;
  for (const r of (await query(`SELECT t.id, t.assigned_to, u.name FROM meta_threads t JOIN users u ON u.id = t.assigned_to WHERE t.id = ANY($1::bigint[])`, [ids])).rows)
    m.set(Number(r.id), { to: Number(r.assigned_to), name: r.name });
  return m;
}
// 목록 필터 SQL(t 별칭) — assignee = 사용자 id | __none | __me
export function assigneeCond(v, userId, add) {
  if (!v) return null;
  if (v === '__none') return `t.assigned_to IS NULL`;
  if (v === '__me') return `t.assigned_to = ${add(Number(userId) || 0)}`;
  const id = idOf(v); return id ? `t.assigned_to = ${add(id)}` : null;
}
// 답장 · 상태 변경 뒤 바로 대화함 확인(기다리지 않음)
export function kickDone(threadId) { refreshDone({ threadIds: [threadId] }).catch(() => {}); }

let shareProbe = null;
async function shareReady() {
  if (shareProbe !== null) return shareProbe;
  try { shareProbe = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name='meta_assign_members' AND column_name='share_pct'`)).rows.length > 0; } catch (_) { shareProbe = false; }
  if (!shareProbe) setTimeout(() => { shareProbe = null; }, 60000);
  return shareProbe;
}

export default async function metaAssignRoutes(app, { R, pmKeys = [] }) {
  const need = async (reply) => { if (await assignReady()) return true; reply.code(503).send({ error: 'migration_required', note: '0329 마이그레이션이 필요합니다(Railway 콘솔 npm run migrate).' }); return false; };
  const admin = (req, reply) => { if (isAdmin(req)) return true; reply.code(403).send({ error: 'director_or_socio_only' }); return false; };

  app.get('/api/meta-assign/config', R, async (req) => {
    if (!(await assignReady())) return { ready: false, is_admin: isAdmin(req) };
    const uid = Number(req.ctx.perm.userId) || null;
    const settings = await getSettings(); const members = await getMembers();
    const me = members.find((m) => m.user_id === uid) || null;
    const out = { ready: true, is_admin: isAdmin(req), settings: isAdmin(req) ? settings : { auto: settings.auto }, me: me ? { ...me } : { user_id: uid, member: false } };
    if (me) out.me.member = me.active;
    // 0331 · 내가 지금 맡은 문의 중 「답장 필요」 · 「새 메시지」
    if (await replyReady()) {
      const r = (await query(`SELECT count(*) FILTER (WHERE ${NEED_SQL})::int AS need, count(*) FILTER (WHERE ${unreadSql('$1')})::int AS unread
                                FROM meta_threads t WHERE t.assigned_to = $1`, [uid || 0])).rows[0];
      out.me.need_n = r.need; out.me.unread_n = r.unread;
    }
    if (isAdmin(req)) {
      out.members = members;
      // page_ok = 이 화면(Meta 광고 문의)을 열 수 있는가 — 견적 · 영업 · 제품 · 마케팅 등 화면 권한 중 하나(디렉터는 항상)
      out.users = (await query(`SELECT u.id, u.name, u.role,
                                       (u.role = 'director' OR EXISTS (SELECT 1 FROM user_page_access p WHERE p.user_id = u.id AND p.page_key = ANY($1::text[]) AND p.device_req <> 'blocked')) AS page_ok
                                  FROM users u WHERE u.deleted_at IS NULL ORDER BY u.name`, [pmKeys])).rows
        .map((u) => ({ id: Number(u.id), name: u.name, role: u.role, page_ok: u.page_ok === true }));
      out.pool = (await poolCandidates()).reduce((a, p) => { a.n++; if (p.waiting) a.waiting++; return a; }, { n: 0, waiting: 0 });
      out.unassigned_open = (await query(`SELECT count(*)::int n FROM meta_threads WHERE assigned_to IS NULL AND status='nuevo'`)).rows[0].n;
    }
    return out;
  });

  app.put('/api/meta-assign/config', R, async (req, reply) => {
    if (!admin(req, reply) || !(await need(reply))) return reply;
    const b = req.body || {}; const uid = req.ctx.perm.userId || null;
    const cur = await getSettings();
    const st = {
      auto: b.auto === undefined ? cur.auto : !!b.auto,
      default_target: clampInt(b.default_target ?? cur.default_target, 0, 500, 20),
      pool_days: clampInt(b.pool_days ?? cur.pool_days, 1, 90, 7),
      work_start: clampInt(b.work_start ?? cur.work_start, 0, 23, 8),
      work_end: clampInt(b.work_end ?? cur.work_end, 1, 24, 19),
    };
    if (st.work_end <= st.work_start) return reply.code(400).send({ error: 'bad_hours' });
    // 0330 · 비율(%) 방식
    const shareCols = await shareReady();
    st.mode = b.mode === undefined ? cur.mode : (b.mode === 'share' ? 'share' : 'target');
    if (st.mode === 'share' && !shareCols) return reply.code(503).send({ error: 'migration_required', note: '0330 마이그레이션이 필요합니다.' });
    if (st.mode === 'share' && Array.isArray(b.members) && b.members.length && !b.members.some((m) => Number(m && m.share_pct) > 0)) return reply.code(400).send({ error: 'share_required' });
    await query(`UPDATE meta_assign_settings SET auto=$1, default_target=$2, pool_days=$3, work_start=$4, work_end=$5, updated_by=$6, updated_at=now() WHERE id=1`,
      [st.auto, st.default_target, st.pool_days, st.work_start, st.work_end, uid]);
    if (shareCols) await query(`UPDATE meta_assign_settings SET mode=$1 WHERE id=1`, [st.mode]);
    if (Array.isArray(b.members)) {
      const seen = new Set();
      for (const m of b.members.slice(0, 200)) {
        const id = idOf(m && m.user_id); if (!id || seen.has(id)) continue; seen.add(id);
        const ok = (await query(`SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL`, [id])).rows.length; if (!ok) continue;
        await query(`INSERT INTO meta_assign_members (user_id, daily_target, active, updated_by) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (user_id) DO UPDATE SET daily_target=EXCLUDED.daily_target, active=EXCLUDED.active, updated_by=EXCLUDED.updated_by, updated_at=now()`,
          [id, clampInt(m.daily_target, 0, 500, st.default_target), m.active !== false, uid]);
        if (shareCols && m.share_pct !== undefined) {
          const pct = Math.max(0, Math.min(100, Math.round(Number(m.share_pct) * 100) / 100 || 0));
          await query(`UPDATE meta_assign_members SET share_pct=$2 WHERE user_id=$1`, [id, pct]);
        }
      }
      // 목록에서 빠진 사람 = 대상 아님(기록 · 실적은 남김)
      await query(`UPDATE meta_assign_members SET active=false, updated_by=$2, updated_at=now() WHERE active AND NOT (user_id = ANY($1::bigint[]))`, [[...seen], uid]);
    }
    await logEvent({ userId: uid, action: 'update', target: 'meta_assign_config', detail: { ...st, members: Array.isArray(b.members) ? b.members.length : undefined } });
    return { ok: true, settings: await getSettings(), members: await getMembers() };
  });

  app.post('/api/meta-assign/run', R, async (req, reply) => {
    if (!admin(req, reply) || !(await need(reply))) return reply;
    await refreshDone();
    const r = await autoDistribute({ force: true });
    await logEvent({ userId: req.ctx.perm.userId || null, action: 'update', target: 'meta_assign_run', detail: { assigned: r.assigned || 0 } });
    return { ...r, members: await getMembers() };
  });

  app.post('/api/meta-leads/:id/assign', R, async (req, reply) => {
    if (!admin(req, reply) || !(await need(reply))) return reply;
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const v = (req.body || {}).user_id;
    const to = v == null || v === '' ? null : idOf(v);
    if (v != null && v !== '' && !to) return reply.code(400).send({ error: 'bad_user' });
    if (to && !(await query(`SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL`, [to])).rows.length) return reply.code(400).send({ error: 'bad_user' });
    const r = await assignThread(id, to, { by: req.ctx.perm.userId || null, how: 'manual' });
    if (!r.ok) return reply.code(404).send({ error: r.error });
    await logEvent({ userId: req.ctx.perm.userId || null, action: 'update', target: `meta_thread:${id}`, detail: { op: 'assign', to } });
    return { ok: true, assign: await assignInfoFor(id) };
  });

  app.get('/api/meta-assign/mine', R, async (req, reply) => {
    if (!(await need(reply))) return reply;
    const uid = isAdmin(req) && idOf(req.query.user) ? idOf(req.query.user) : Number(req.ctx.perm.userId) || 0;
    const scope = ['today', 'open', 'week', 'month', 'need'].includes(req.query.scope) ? req.query.scope : 'today';
    const rr = await replyReady();
    // 0331 · need = 지금 내가 맡은 문의 중 손님이 답해 우리 대답이 필요한 것(맡은 날 · 대화함 여부와 관계없이)
    const cond = scope === 'need' ? (rr ? `a.ended_at IS NULL AND t.assigned_to = a.user_id AND ${NEED_SQL}` : 'false')
      : scope === 'today' ? `a.day = (now() AT TIME ZONE 'America/Mexico_City')::date`
      : scope === 'week' ? `a.day > (now() AT TIME ZONE 'America/Mexico_City')::date - 7`
        : scope === 'month' ? `a.day >= date_trunc('month', (now() AT TIME ZONE 'America/Mexico_City'))::date`
          : `a.done_at IS NULL AND a.ended_at IS NULL`;
    await refreshDone({ q: query }).catch(() => {});
    const rows = (await query(
      `SELECT a.id AS assign_id, a.thread_id AS id, to_char(a.day,'YYYY-MM-DD') AS day, a.how, a.assigned_at, a.done_at, a.done_how, a.ended_at,
              t.platform, COALESCE(t.m_name, t.name) AS name, t.username, COALESCE(t.m_phone, t.ai_phone, t.a_phone) AS phone, t.status,
              t.ai_summary AS summary, left(t.customer_text, 300) AS customer_text, COALESCE(t.m_vehicles, t.ai_vehicles, t.a_vehicles) AS vehicles,
              COALESCE(t.m_parts, t.ai_parts, t.a_parts) AS parts, COALESCE(t.m_state, t.ai_state, t.a_state) AS state,
              to_char(t.last_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS last_mx, t.last_in_at,
              (SELECT n.text FROM meta_lead_notes n WHERE n.thread_id = t.id ORDER BY n.at DESC, n.id DESC LIMIT 1) AS last_note,
              (SELECT count(*)::int FROM meta_lead_notes n WHERE n.thread_id = t.id) AS notes_n
              ${rr ? `, (a.ended_at IS NULL AND t.assigned_to = a.user_id AND ${NEED_SQL}) AS need_reply, t.reply_last_in, t.reply_pending_n, ${unreadSql('$2')} AS unread` : ''}
         FROM meta_assignments a JOIN meta_threads t ON t.id = a.thread_id
        WHERE a.user_id = $1 AND ${cond}
        ORDER BY ${rr ? `(a.ended_at IS NULL AND t.assigned_to = a.user_id AND ${NEED_SQL}) DESC, ` : ''}(a.done_at IS NULL AND a.ended_at IS NULL) DESC, a.assigned_at DESC LIMIT 1000`, rr ? [uid, Number(req.ctx.perm.userId) || 0] : [uid])).rows
      .map((r) => ({ ...r, id: Number(r.id), assign_id: Number(r.assign_id) }));
    const members = await getMembers(); const me = members.find((m) => m.user_id === uid) || null;
    return { user_id: uid, scope, me, items: rows };
  });

  app.get('/api/meta-assign/perf', R, async (req, reply) => {
    if (!(await need(reply))) return reply;
    const today = mxToday();
    const from = ymd(req.query.from) || today; const to = ymd(req.query.to) || today;
    if (to < from) return reply.code(400).send({ error: 'bad_range' });
    const uid = isAdmin(req) ? idOf(req.query.user) : Number(req.ctx.perm.userId) || 0;
    await refreshDone().catch(() => {});
    return { ...(await performance({ from, to, userId: uid })), is_admin: isAdmin(req) };
  });

  // 1119b · 전체 할당 목록(영업 할당 · 실적 화면) — 디렉터 · 소시오
  //   GET /api/meta-assign/list?from&to&user&state=open|done|moved&q
  app.get('/api/meta-assign/list', R, async (req, reply) => {
    if (!admin(req, reply) || !(await need(reply))) return reply;
    const today = mxToday();
    const from = ymd(req.query.from) || today; const to = ymd(req.query.to) || today;
    if (to < from) return reply.code(400).send({ error: 'bad_range' });
    const args = [from, to]; const conds = [`a.day BETWEEN $1::date AND $2::date`];
    const add = (v) => { args.push(v); return '$' + args.length; };
    const uid = idOf(req.query.user); if (uid) conds.push(`a.user_id = ${add(uid)}`);
    if (req.query.state === 'open') conds.push(`a.done_at IS NULL AND a.ended_at IS NULL`);
    else if (req.query.state === 'done') conds.push(`a.done_at IS NOT NULL`);
    else if (req.query.state === 'moved') conds.push(`a.done_at IS NULL AND a.ended_at IS NOT NULL`);
    const rr = await replyReady();
    if (req.query.state === 'need') conds.push(rr ? `a.ended_at IS NULL AND t.assigned_to = a.user_id AND ${NEED_SQL}` : 'false');
    const kw = String(req.query.q || '').trim();
    if (kw) { const p = add('%' + kw + '%'); conds.push(`(COALESCE(t.m_name, t.name) ILIKE ${p} OR COALESCE(t.m_phone, t.ai_phone, t.a_phone) ILIKE ${p} OR t.ai_summary ILIKE ${p} OR t.customer_text ILIKE ${p})`); }
    await refreshDone().catch(() => {});
    const rows = (await query(
      `SELECT a.id AS assign_id, a.thread_id AS id, a.user_id, u.name AS user_name, to_char(a.day,'YYYY-MM-DD') AS day, a.how, a.assigned_at, a.done_at, a.done_how, a.ended_at,
              ub.name AS assigned_by_name,
              t.platform, COALESCE(t.m_name, t.name) AS name, t.username, COALESCE(t.m_phone, t.ai_phone, t.a_phone) AS phone, t.status,
              t.ai_summary AS summary, COALESCE(t.m_vehicles, t.ai_vehicles, t.a_vehicles) AS vehicles, COALESCE(t.m_parts, t.ai_parts, t.a_parts) AS parts,
              COALESCE(t.m_state, t.ai_state, t.a_state) AS state, tu.name AS now_name,
              round(EXTRACT(EPOCH FROM (a.done_at - a.assigned_at)) / 60)::int AS mins,
              (SELECT n.text FROM meta_lead_notes n WHERE n.thread_id = t.id ORDER BY n.at DESC, n.id DESC LIMIT 1) AS last_note,
              (SELECT count(*)::int FROM meta_lead_notes n WHERE n.thread_id = t.id) AS notes_n
              ${rr ? `, (a.ended_at IS NULL AND t.assigned_to = a.user_id AND ${NEED_SQL}) AS need_reply, t.reply_last_in, t.reply_pending_n` : ''}
         FROM meta_assignments a JOIN meta_threads t ON t.id = a.thread_id JOIN users u ON u.id = a.user_id
         LEFT JOIN users ub ON ub.id = a.assigned_by LEFT JOIN users tu ON tu.id = t.assigned_to
        WHERE ${conds.join(' AND ')}
        ORDER BY a.assigned_at DESC LIMIT 3000`, args)).rows
      .map((r) => ({ ...r, id: Number(r.id), assign_id: Number(r.assign_id), user_id: Number(r.user_id) }));
    return { from, to, items: rows };
  });

  app.post('/api/meta-leads/:id/called', R, async (req, reply) => {
    if (!(await need(reply))) return reply;
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const t = (await query(`SELECT assigned_to FROM meta_threads WHERE id=$1`, [id])).rows[0];
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (!isAdmin(req) && Number(t.assigned_to) !== Number(req.ctx.perm.userId)) return reply.code(403).send({ error: 'not_assignee' });
    const r = await markCalled(id);
    const note = String((req.body || {}).note || '').trim().slice(0, 2000);
    if (note) await query(`INSERT INTO meta_lead_notes (thread_id, user_id, text) VALUES ($1,$2,$3)`, [id, req.ctx.perm.userId || null, '📞 ' + note]);
    await query(`UPDATE meta_threads SET status='contactado', updated_by=$2, updated_at=now() WHERE id=$1 AND status='nuevo'`, [id, req.ctx.perm.userId || null]);
    return { ok: true, marked: r.ok, assign: await assignInfoFor(id) };
  });

  app.get('/api/meta-leads/:id/notes', R, async (req, reply) => {
    if (!(await need(reply))) return reply;
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const a = await assignInfoFor(id); if (!a) return reply.code(404).send({ error: 'not_found' });
    return { items: a.notes };
  });
  app.post('/api/meta-leads/:id/notes', R, async (req, reply) => {
    if (!(await need(reply))) return reply;
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const text = String((req.body || {}).text || '').trim();
    if (!text) return reply.code(400).send({ error: 'empty' });
    if (!(await query(`SELECT 1 FROM meta_threads WHERE id=$1`, [id])).rows.length) return reply.code(404).send({ error: 'not_found' });
    await query(`INSERT INTO meta_lead_notes (thread_id, user_id, text) VALUES ($1,$2,$3)`, [id, req.ctx.perm.userId || null, text.slice(0, 2000)]);
    return { ok: true, items: (await assignInfoFor(id)).notes };
  });
  app.delete('/api/meta-leads/:id/notes/:nid', R, async (req, reply) => {
    if (!(await need(reply))) return reply;
    const id = idOf(req.params.id); const nid = idOf(req.params.nid); if (!id || !nid) return reply.code(400).send({ error: 'bad_id' });
    const n = (await query(`SELECT user_id FROM meta_lead_notes WHERE id=$1 AND thread_id=$2`, [nid, id])).rows[0];
    if (!n) return reply.code(404).send({ error: 'not_found' });
    if (!isAdmin(req) && Number(n.user_id) !== Number(req.ctx.perm.userId)) return reply.code(403).send({ error: 'not_author' });
    await query(`DELETE FROM meta_lead_notes WHERE id=$1`, [nid]);
    return { ok: true, items: (await assignInfoFor(id)).notes };
  });
}
