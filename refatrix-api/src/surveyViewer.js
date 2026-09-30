// =====================================================================
// Refatrix ERP · surveyViewer.js — 고객 설문 결과 「외부 열람 계정」 (2026-09-30)
//
//   ERP 계정과 분리된 **열람 전용** 계정(survey_viewers). 아이디+비밀번호로 로그인하면
//   허락된 설문의 **익명 집계**(surveyPublic.js)만 받는다. 화면: mx_survey_analysis.html (스페인어).
//
//   ── 보안 ──
//     · 토큰 {sub:'sv:<id>', typ:'survey_viewer', tv} — authGuard 가 typ 을 보고 **ERP API 전부 401**.
//     · 비밀번호 scrypt(auth.js hashPin) · 5회 실패 → 15분 잠금 · 없는 아이디도 같은 응답(계정 유무 노출 안 함)
//     · 정지·비밀번호 변경·삭제 → token_version 증가 → 이미 나간 토큰도 즉시 무효
//     · 관리(계정 만들기·권한·정지)는 **디렉터만**
// =====================================================================
import { query } from './db.js';
import { hashPin, verifyPin } from './auth.js';
import { logEvent } from './audit.js';
import { authGuard, requireDirector } from './middleware/authGuard.js';
import { buildPublicSurveyData } from './surveyPublic.js';

export const SV_TYP = 'survey_viewer';
const MAX_FAIL = 5;
const LOCK_MIN = 15;
const TOKEN_TTL = '8h';
const LOGIN_RE = /^[a-z0-9._@-]{3,60}$/;

function idOf(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }
function cleanLogin(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function cleanName(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 80) || null; }
function passErr(p) {
  const s = String(p == null ? '' : p);
  if (s.length < 8) return 'password_short';
  if (s.length > 100) return 'password_long';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return 'password_weak';
  return null;
}
function ids(list) { return [...new Set((Array.isArray(list) ? list : []).map(idOf).filter(Boolean))]; }
const iso = (v) => (v ? new Date(v).toISOString() : null);

function viewerOut(r) {
  return {
    id: Number(r.id), login: r.login, name: r.name || null, active: !!r.active,
    survey_ids: (r.survey_ids || []).map(Number), last_login_at: iso(r.last_login_at),
    locked: !!(r.locked_until && new Date(r.locked_until) > new Date()), created_at: iso(r.created_at),
  };
}

// 열람 토큰 가드 — ERP 토큰은 여기서 받지 않는다
async function viewerGuard(req, reply) {
  try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'unauthorized' }); }
  const u = req.user || {};
  if (u.typ !== SV_TYP) return reply.code(401).send({ error: 'unauthorized' });
  const vid = idOf(String(u.sub || '').replace(/^sv:/, ''));
  const v = vid && (await query(`SELECT id, login, name, survey_ids, active, token_version FROM survey_viewers WHERE id=$1`, [vid])).rows[0];
  if (!v || !v.active || Number(v.token_version) !== Number(u.tv)) return reply.code(401).send({ error: 'unauthorized' });
  req.viewer = { id: Number(v.id), login: v.login, name: v.name, surveyIds: (v.survey_ids || []).map(Number) };
}

async function allowedSurveys(surveyIds) {
  if (!surveyIds.length) return [];
  return (await query(
    `SELECT id, title, to_char(survey_date,'YYYY-MM-DD') AS survey_date FROM surveys
      WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL ORDER BY survey_date DESC NULLS LAST, id DESC`, [surveyIds])).rows
    .map((s) => ({ id: Number(s.id), title: s.title, date: s.survey_date }));
}

export default async function surveyViewerRoutes(app) {
  // ───────── 열람자(외부) ─────────
  app.post('/api/survey-viewer/login', async (req, reply) => {
    const b = req.body || {};
    const login = cleanLogin(b.login);
    const pass = String(b.password == null ? '' : b.password);
    if (!login || !pass) return reply.code(400).send({ error: 'credentials_required' });
    const v = (await query(`SELECT * FROM survey_viewers WHERE lower(login)=$1`, [login])).rows[0];
    if (v && v.locked_until && new Date(v.locked_until) > new Date()) {
      return reply.code(429).send({ error: 'locked', retry_after_min: Math.ceil((new Date(v.locked_until) - Date.now()) / 60000) });
    }
    const ok = v ? verifyPin(pass, v.pass_hash) : (verifyPin(pass, 'x:00'), false);
    if (!v || !ok || !v.active) {
      if (v && !ok) {
        await query(
          `UPDATE survey_viewers SET failed_count = failed_count + 1,
                  locked_until = CASE WHEN failed_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
            WHERE id=$1`, [v.id, MAX_FAIL, String(LOCK_MIN)]);
      }
      await logEvent({ userId: null, action: 'login_fail', target: 'survey_viewer:' + login, result: 'denied' }).catch(() => {});
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    await query(`UPDATE survey_viewers SET failed_count=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [v.id]);
    await logEvent({ userId: null, action: 'login', target: 'survey_viewer:' + v.login, result: 'ok' }).catch(() => {});
    const token = await reply.jwtSign({ sub: 'sv:' + v.id, typ: SV_TYP, tv: Number(v.token_version) }, { expiresIn: TOKEN_TTL });
    return { token, name: v.name || v.login, surveys: await allowedSurveys((v.survey_ids || []).map(Number)) };
  });

  app.get('/api/survey-viewer/surveys', { preHandler: [viewerGuard] }, async (req) => ({
    name: req.viewer.name || req.viewer.login, surveys: await allowedSurveys(req.viewer.surveyIds),
  }));

  app.get('/api/survey-viewer/surveys/:id', { preHandler: [viewerGuard] }, async (req, reply) => {
    const sid = idOf(req.params.id);
    if (!sid || !req.viewer.surveyIds.includes(sid)) return reply.code(404).send({ error: 'not_found' });
    const s = (await query(
      `SELECT id, title, to_char(survey_date,'YYYY-MM-DD') AS survey_date, questions, ai_cache
         FROM surveys WHERE id=$1 AND deleted_at IS NULL`, [sid])).rows[0];
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const pages = (await query(`SELECT status, answers, geo FROM survey_pages WHERE survey_id=$1 AND status='done'`, [sid])).rows;
    const up = (await query(`SELECT COUNT(*)::int AS n FROM survey_pages WHERE survey_id=$1`, [sid])).rows[0];
    reply.header('cache-control', 'no-store');
    return buildPublicSurveyData(s, pages, { uploaded: Number(up.n) });
  });

  // ───────── 관리(디렉터) ─────────
  const admin = { preHandler: [authGuard, requireDirector] };

  app.get('/api/surveys/viewers', admin, async () => {
    const rows = (await query(`SELECT * FROM survey_viewers ORDER BY active DESC, lower(login)`)).rows;
    return { items: rows.map(viewerOut) };
  });

  app.post('/api/surveys/viewers', admin, async (req, reply) => {
    const b = req.body || {};
    const login = cleanLogin(b.login);
    if (!LOGIN_RE.test(login)) return reply.code(400).send({ error: 'bad_login' });
    const pe = passErr(b.password);
    if (pe) return reply.code(400).send({ error: pe });
    const dup = (await query(`SELECT 1 FROM survey_viewers WHERE lower(login)=$1`, [login])).rows[0];
    if (dup) return reply.code(409).send({ error: 'login_taken' });
    const r = (await query(
      `INSERT INTO survey_viewers (login, name, pass_hash, survey_ids, created_by) VALUES ($1,$2,$3,$4::bigint[],$5) RETURNING *`,
      [login, cleanName(b.name), hashPin(b.password), ids(b.survey_ids), Number(req.ctx.perm.userId)])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: 'survey_viewer:' + r.id, detail: { login, surveys: r.survey_ids } });
    return { ok: true, item: viewerOut(r) };
  });

  app.patch('/api/surveys/viewers/:vid', admin, async (req, reply) => {
    const vid = idOf(req.params.vid);
    const cur = vid && (await query(`SELECT * FROM survey_viewers WHERE id=$1`, [vid])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const sets = []; const vals = [vid]; let bump = false;
    const add = (sql, v) => { vals.push(v); sets.push(sql.replace('?', '$' + vals.length)); };
    if (b.name !== undefined) add('name=?', cleanName(b.name));
    if (b.survey_ids !== undefined) add('survey_ids=?::bigint[]', ids(b.survey_ids));
    if (b.active !== undefined) { add('active=?', !!b.active); if (!b.active) bump = true; }
    if (b.password !== undefined) {
      const pe = passErr(b.password); if (pe) return reply.code(400).send({ error: pe });
      add('pass_hash=?', hashPin(b.password)); sets.push('failed_count=0', 'locked_until=NULL'); bump = true;
    }
    if (b.unlock) sets.push('failed_count=0', 'locked_until=NULL');
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    if (bump) sets.push('token_version = token_version + 1');
    sets.push('updated_at=now()');
    const r = (await query(`UPDATE survey_viewers SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals)).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'survey_viewer:' + vid,
      detail: { fields: Object.keys(b).filter((k) => k !== 'password'), password_changed: b.password !== undefined } });
    return { ok: true, item: viewerOut(r) };
  });

  app.delete('/api/surveys/viewers/:vid', admin, async (req, reply) => {
    const vid = idOf(req.params.vid);
    const r = vid && (await query(`DELETE FROM survey_viewers WHERE id=$1 RETURNING id, login`, [vid])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: 'survey_viewer:' + vid, detail: { login: r.login } });
    return { ok: true };
  });
}
