// =====================================================================
// Refatrix ERP · workplanRoutes.js — 직원 업무일지 API (0263, 2026-10-08)
//   등록: portalBoardRoutes.js 끝에서 registerWorkplan(app) 로 붙는다(server.js 무변경).
//   · 누구나: 설정 읽기 · 내 하루 읽기/쓰기 · 팀 업무(전 직원 공유) 읽기 · 내 달력 표식
//   · 디렉터: 설정 저장 · 대상 직원 켜기/끄기 · 발송 상태 · 요약 즉시 발송 · 이미지 미리보기
// =====================================================================
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { normalizeWaNumber, waApiReady } from '../waSend.js';
import {
  isYmd, mxClock, addDays, loadSettings, cleanSettingsInput, saveSettings, isWorkday, isTarget, loadDay, ensureCarry,
  savePlan, saveDone, WpError, loadTeam, teamKpi, loadMarks, summarySvg, summaryText, sendSummary, summaryRecipients,
  maskPhone, nextRuns, DEFAULT_DEPS, startWorkplanWorker, saveDirComment, loadInbox, markInboxSeen, hideDirComments,
} from '../workplan.js';

const MIGRATION_MSG = '업무일지 테이블이 없습니다. 서버에서 npm run migrate 를 실행하세요. (0263_staff_workplan · 0266_workplan_comments)';
const isMig = (e) => e && (e.code === '42P01' || e.code === '42703');

// 공통 래퍼: 마이그레이션 전 503 · 업무 오류(WpError) → 상태코드
const wrap = (fn) => async (req, reply) => {
  try { return await fn(req, reply); }
  catch (e) {
    if (isMig(e)) return reply.code(503).send({ error: 'migration_required', message: MIGRATION_MSG });
    if (e instanceof WpError) return reply.code(e.status).send({ error: e.code, message: e.message !== e.code ? e.message : undefined });
    throw e;
  }
};
const publicSettings = (s) => ({
  plan_deadline: s.plan_deadline, done_deadline: s.done_deadline, workdays: s.workdays,
  remind_enabled: s.remind_enabled, remind_plan_at: s.remind_plan_at, remind_done_at: s.remind_done_at,
  summary_enabled: s.summary_enabled, summary_plan_at: s.summary_plan_at, summary_done_at: s.summary_done_at,
});

export async function registerWorkplan(app, { startWorker = true } = {}) {
  // ── 설정 ──
  app.get('/api/workplan/settings', { preHandler: [authGuard] }, wrap(async (req) => {
    const s = await loadSettings();
    const clock = mxClock();
    if (req.ctx.perm.role !== 'director') return { settings: publicSettings(s), today: clock.ymd };
    return { settings: s, today: clock.ymd, wa_ready: waApiReady(), next: nextRuns(s, clock) };
  }));
  app.put('/api/workplan/settings', { preHandler: [authGuard, requireDirector] }, wrap(async (req, reply) => {
    const cur = await loadSettings();
    const c = cleanSettingsInput(req.body || {}, cur);
    if (!c.ok) return reply.code(400).send({ error: c.error, field: c.field, message: c.message });
    const s = await saveSettings(c.value, req.ctx.perm.userId);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'workplan_settings' });
    return { ok: true, settings: s, next: nextRuns(s, mxClock()) };
  }));

  // ── 내 하루 ──
  app.get('/api/workplan/me', { preHandler: [authGuard] }, wrap(async (req, reply) => {
    const me = Number(req.ctx.perm.userId);
    const clock = mxClock();
    const date = req.query.date ? String(req.query.date) : clock.ymd;
    if (!isYmd(date)) return reply.code(400).send({ error: 'bad_date' });
    const [s, enabled] = await Promise.all([loadSettings(), isTarget(me)]);
    if (enabled && date === clock.ymd) await ensureCarry(me, date);
    const d = await loadDay(me, date);
    const inbox = await loadInbox(me, date, clock.ymd);   // 디렉터 코멘트(대상에서 빠졌어도 받은 코멘트는 보인다)
    return {
      today: clock.ymd, now_min: clock.min, enabled, workday: isWorkday(s, date), settings: publicSettings(s), ...d, inbox,
      can_plan: enabled && (date >= clock.ymd || !d.day.plan_saved_at),
      can_done: enabled && date <= clock.ymd && (date === clock.ymd || !d.day.done_saved_at),
    };
  }));
  app.put('/api/workplan/plan/:date', { preHandler: [authGuard] }, wrap(async (req, reply) => {
    const me = Number(req.ctx.perm.userId);
    const date = String(req.params.date || '');
    if (!isYmd(date)) return reply.code(400).send({ error: 'bad_date' });
    if (!(await isTarget(me))) return reply.code(403).send({ error: 'not_target', message: '업무일지 대상이 아닙니다.' });
    const clock = mxClock();
    const r = await savePlan({ userId: me, date, items: (req.body || {}).items, clock, settings: await loadSettings() });
    await logEvent({ userId: me, action: r.first ? 'create' : 'update', target: `workplan_plan:${date}` });
    return { ok: true, ...(await loadDay(me, date)) };
  }));
  app.put('/api/workplan/done/:date', { preHandler: [authGuard] }, wrap(async (req, reply) => {
    const me = Number(req.ctx.perm.userId);
    const date = String(req.params.date || '');
    if (!isYmd(date)) return reply.code(400).send({ error: 'bad_date' });
    if (!(await isTarget(me))) return reply.code(403).send({ error: 'not_target', message: '업무일지 대상이 아닙니다.' });
    const b = req.body || {};
    const r = await saveDone({ userId: me, date, items: b.items, extra_done: b.extra_done, clock: mxClock(), settings: await loadSettings() });
    await logEvent({ userId: me, action: r.first ? 'create' : 'update', target: `workplan_done:${date}` });
    return { ok: true, ...(await loadDay(me, date)) };
  }));
  app.get('/api/workplan/marks', { preHandler: [authGuard] }, wrap(async (req, reply) => {
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    if (!isYmd(from) || !isYmd(to) || from > to || addDays(from, 62) < to) return reply.code(400).send({ error: 'bad_range' });
    const me = Number(req.ctx.perm.userId);
    const today = mxClock().ymd;
    const marks = await loadMarks(me, from, to);
    // 지난 날짜에 떴는데 아직 확인 안 한 코멘트는 오늘 칸에도 「새 코멘트」로
    if (today >= from && today <= to && !(marks[today] && marks[today].dir === 'new')
      && Object.keys(marks).some((k) => k < today && marks[k].dir === 'new')) {
      marks[today] = { total: 0, done: 0, partial: 0, plan: false, done_saved: false, ...(marks[today] || {}), dir: 'new' };
    }
    return { today, enabled: await isTarget(me), marks };
  }));

  // ── 디렉터 코멘트 ──
  app.put('/api/workplan/comment', { preHandler: [authGuard, requireDirector] }, wrap(async (req, reply) => {
    const b = req.body || {};
    const targetId = Number(b.user_id);
    const itemId = b.item_id == null || b.item_id === '' ? null : Number(b.item_id);
    if (!Number.isInteger(targetId) || targetId <= 0) return reply.code(400).send({ error: 'bad_user' });
    if (itemId !== null && (!Number.isInteger(itemId) || itemId <= 0)) return reply.code(400).send({ error: 'bad_item' });
    const date = String(b.date || '');
    const r = await saveDirComment({ targetId, date, itemId, body: b.body, directorId: Number(req.ctx.perm.userId), clock: mxClock(), settings: await loadSettings() });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `workplan_comment:${targetId}:${date}${itemId ? ':' + itemId : ''}` });
    return { ok: true, ...r };
  }));
  app.post('/api/workplan/inbox/seen', { preHandler: [authGuard] }, wrap(async (req) => {
    const n = await markInboxSeen(Number(req.ctx.perm.userId), (req.body || {}).dates, mxClock());
    return { ok: true, updated: n };
  }));

  // ── 팀 업무(전 직원 공유) ──
  app.get('/api/workplan/team', { preHandler: [authGuard] }, wrap(async (req, reply) => {
    const clock = mxClock();
    const date = req.query.date ? String(req.query.date) : clock.ymd;
    if (!isYmd(date)) return reply.code(400).send({ error: 'bad_date' });
    const s = await loadSettings();
    const me = Number(req.ctx.perm.userId);
    const isDir = req.ctx.perm.role === 'director';
    // 번호는 공유하지 않는다 · 디렉터 코멘트는 본인과 디렉터만
    const team = (await loadTeam(date)).map(({ wa_phone, lang, ...m }) => (isDir || m.user_id === me ? m : hideDirComments(m)));
    return { date, today: clock.ymd, now_min: clock.min, workday: isWorkday(s, date), settings: publicSettings(s), is_director: isDir,
      kpi: teamKpi(team), members: team };
  }));

  // ── 디렉터: 대상 직원 ──
  app.get('/api/workplan/users', { preHandler: [authGuard, requireDirector] }, wrap(async () => {
    const rows = (await query(`SELECT id, name, role, lang, wa_phone, workplan_enabled FROM users WHERE deleted_at IS NULL ORDER BY name, id`)).rows;
    return { items: rows.map((r) => ({ id: Number(r.id), name: r.name, role: r.role, lang: r.lang,
      phone_masked: maskPhone(normalizeWaNumber(r.wa_phone)), has_phone: !!normalizeWaNumber(r.wa_phone),
      enabled: r.role !== 'director' && !!r.workplan_enabled, director: r.role === 'director' })) };
  }));
  app.put('/api/workplan/users/:id', { preHandler: [authGuard, requireDirector] }, wrap(async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const r = await query(`UPDATE users SET workplan_enabled=$1, updated_by=$2 WHERE id=$3 AND deleted_at IS NULL RETURNING id`, [!!(req.body || {}).enabled, req.ctx.perm.userId, id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `workplan_user:${id}` });
    return { ok: true };
  }));

  // ── 디렉터: WhatsApp 상태 · 즉시 발송 · 미리보기 ──
  app.get('/api/workplan/wa/status', { preHandler: [authGuard, requireDirector] }, wrap(async () => {
    const s = await loadSettings();
    const clock = mxClock();
    const rcpt = await summaryRecipients(s);
    const log = (await query(`SELECT w.kind, to_char(w.work_date,'YYYY-MM-DD') AS work_date, w.user_id, u.name, w.to_masked, w.status,
                                     w.error, w.attempts, w.sent_at, w.updated_at
                                FROM workplan_wa_sends w LEFT JOIN users u ON u.id=w.user_id
                               WHERE w.work_date >= $1 ORDER BY w.updated_at DESC LIMIT 200`, [addDays(clock.ymd, -7)])).rows;
    return {
      wa_ready: waApiReady(), today: clock.ymd, next: nextRuns(s, clock),
      recipients: rcpt.map((r) => ({ id: r.id, name: r.name, lang: r.lang, phone_masked: maskPhone(r.phone) })),
      log: log.map((r) => ({ ...r, user_id: Number(r.user_id), name: r.name || (Number(r.user_id) === 0 ? '디렉터 번호(환경변수)' : null),
        sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null, updated_at: new Date(r.updated_at).toISOString() })),
    };
  }));
  app.post('/api/workplan/wa/send', { preHandler: [authGuard, requireDirector] }, wrap(async (req, reply) => {
    const b = req.body || {};
    const kind = b.kind === 'sum_done' ? 'sum_done' : (b.kind === 'sum_plan' ? 'sum_plan' : null);
    if (!kind) return reply.code(400).send({ error: 'bad_kind' });
    const clock = mxClock();
    const date = b.date ? String(b.date) : clock.ymd;
    if (!isYmd(date) || date > clock.ymd) return reply.code(400).send({ error: 'bad_date' });
    if (!waApiReady()) return reply.code(409).send({ error: 'wa_not_configured', message: 'WhatsApp 환경변수(WHATSAPP_TOKEN·WHATSAPP_PHONE_ID)가 없습니다.' });
    const s = await loadSettings();
    const hm = date === clock.ymd ? `${String(Math.floor(clock.min / 60)).padStart(2, '0')}:${String(clock.min % 60).padStart(2, '0')}` : null;
    const r = await sendSummary({ kind, date, settings: s, force: true, hm, deps: DEFAULT_DEPS });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `workplan_wa:${kind}:${date}` });
    if (r.skipped === 'no_recipients') return reply.code(409).send({ error: 'no_recipients', message: '받는 사람이 없습니다. 설정에서 고르거나 DAILY_SUMMARY_WA_TO 를 확인하세요.' });
    return { ok: r.results.some((x) => x.ok), results: r.results };
  }));
  app.get('/api/workplan/preview', { preHandler: [authGuard, requireDirector] }, wrap(async (req, reply) => {
    const kind = req.query.kind === 'sum_done' ? 'sum_done' : 'sum_plan';
    const clock = mxClock();
    const date = req.query.date ? String(req.query.date) : clock.ymd;
    if (!isYmd(date)) return reply.code(400).send({ error: 'bad_date' });
    const lang = req.query.lang === 'es' ? 'es' : 'ko';
    const team = await loadTeam(date);
    const svg = summarySvg(kind, date, team, lang, null);
    if (req.query.format === 'text') return { text: summaryText(kind, date, team, lang, null) };
    const png = await DEFAULT_DEPS.png(svg);
    if (!png) return reply.header('content-type', 'image/svg+xml; charset=utf-8').send(svg);
    return reply.header('content-type', 'image/png').header('cache-control', 'no-store').send(png);
  }));

  if (startWorker) startWorkplanWorker(app);
}
