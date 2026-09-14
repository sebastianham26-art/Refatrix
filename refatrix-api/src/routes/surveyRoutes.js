// =====================================================================
// Refatrix ERP · surveyRoutes.js — 「제품·마케팅 › 고객 설문 분석」 (디렉터 요청 2026-09-11)
//
//   설문지(1장 = 응답 1건)를 사진 또는 스캔 PDF 로 올리면
//     ① 서버 큐가 한 장씩 Claude 에 보내 **붉은 번호 + 문항별 답**을 읽고
//     ② 번호로 파일명을 만든다(EXPO26_0137.jpg · 중복 0137-2 · 번호 없음 SIN-NUM_007)
//     ③ 화면이 엑셀·세그먼트 리포트를 만든다(집계는 브라우저 — 200행이면 충분)
//     ④ 서술형 주제 묶기 · 세그먼트 한 줄 해석은 버튼을 눌렀을 때만 AI 호출 → surveys.ai_cache
//
//   ── 권한 ── 열람 requirePage('marketing') · 쓰기 requirePageEdit('marketing') · 설문 삭제는 디렉터
//   ── 환경변수 ── 새로 필요한 것 없음(ANTHROPIC_API_KEY 재사용). 선택: SURVEY_AI_MODEL, SURVEY_AI_CONCURRENCY
//   ── 확정(2026-09-11) ── 검수 단계 없이 AI 결과를 그대로 쓴다. 확신 낮은 칸은 표시만 하고,
//      사람이 고친 칸(edited)은 다시 판독해도 덮어쓰지 않는다.
// =====================================================================
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import {
  clip, normalizeQuestions, buildTemplatePrompt, parseTemplateJson,
  buildPagePrompt, parsePageJson, normRedNumber, normPrefix, pageFileName, normalizeAnswers,
  buildThemePrompt, parseThemeJson, crossSummaryText, buildInsightPrompt, parseInsightJson, zipStream,
} from '../surveyAi.js';
import { normalizeGeo, STATE_NAMES } from '../surveyGeo.js';

const PAGE = 'marketing';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const FILE_MAX = 6 * 1024 * 1024;        // 원본 1장(바이너리) — 사진은 브라우저가 1~2MB 로 줄여 보낸다
const VIEW_MAX = 3 * 1024 * 1024;        // PDF 페이지를 그린 JPEG(판독·화면용)
const THUMB_MAX = 300 * 1024;
const MAX_ATTEMPTS = 4;                  // 일시 오류(429·5xx·시간초과) 자동 재시도
const AI_TIMEOUT_MS = 120000;
const LOCK_NS = 216216;                  // pg_advisory_xact_lock(LOCK_NS, survey_id) — 번호·순번 배정 직렬화

export const AI_MODEL = () => process.env.SURVEY_AI_MODEL || 'claude-sonnet-4-5-20250929';
export const CONCURRENCY = () => Math.min(Math.max(Number(process.env.SURVEY_AI_CONCURRENCY) || 3, 1), 6);
export function aiReady() { return !!process.env.ANTHROPIC_API_KEY; }

function idOf(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }
function d10(v) { if (!v) return null; if (v instanceof Date) return v.toISOString().slice(0, 10); return String(v).slice(0, 10); }
function iso(v) { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
function b64buf(s, max) {
  if (typeof s !== 'string' || !s) return { err: 'no_data' };
  const raw = s.replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw.slice(0, 200))) return { err: 'bad_base64' };
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) return { err: 'no_data' };
  if (buf.length > max) return { err: 'too_large', max };
  return { buf };
}
function isJpeg(buf) { return buf && buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF; }
function isPng(buf) { return buf && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47; }
function isPdf(buf) { return buf && buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-'; }
function isWebp(buf) { return buf && buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP'; }
function sniffOk(mime, buf) {
  if (mime === 'application/pdf') return isPdf(buf);
  if (mime === 'image/jpeg') return isJpeg(buf);
  if (mime === 'image/png') return isPng(buf);
  if (mime === 'image/webp') return isWebp(buf);
  return false;
}

// ── 외부 API(테스트에서 바꿔 끼울 수 있게 export) ─────────────────────
export const surveyAiApi = {
  async call(content, maxTokens = 2000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: AI_MODEL(), max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
        signal: ctrl.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = (data && data.error && data.error.message) || ('http_' + resp.status);
        return { ok: false, status: resp.status, error: 'ai: ' + String(msg).slice(0, 250), transient: resp.status >= 500 || resp.status === 429 || resp.status === 529 };
      }
      const t = (data && Array.isArray(data.content))
        ? data.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
      return { ok: true, text: t };
    } catch (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? 'ai: timeout' : 'ai: network', transient: true };
    } finally { clearTimeout(timer); }
  },
};

// 판독용 첨부 블록 — 화면용 JPEG(PDF 를 그린 것)가 있으면 그것, 없으면 원본(사진/PDF)
export function mediaBlock({ mime, file_data, view_data }) {
  if (view_data && view_data.length) {
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(view_data).toString('base64') } };
  }
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(file_data).toString('base64') } };
  }
  return { type: 'image', source: { type: 'base64', media_type: mime, data: Buffer.from(file_data).toString('base64') } };
}

// ── 설문 1건 ─────────────────────────────────────────────────────────
async function getSurvey(id, withTemplate = false) {
  const sid = idOf(id);
  if (!sid) return null;
  const r = (await query(
    `SELECT id, title, code_prefix, to_char(survey_date,'YYYY-MM-DD') AS survey_date, questions, number_hint,
            template_mime, (template_data IS NOT NULL) AS has_template, ai_cache,
            created_by, created_at, updated_at${withTemplate ? ', template_data' : ''}
       FROM surveys WHERE id=$1 AND deleted_at IS NULL`, [sid])).rows[0];
  return r || null;
}
function qList(s) { return Array.isArray(s && s.questions) ? s.questions : []; }

async function pageCounts(sid) {
  const r = (await query(
    `SELECT COUNT(*)::int AS total,
            SUM(CASE WHEN status='done' THEN 1 ELSE 0 END)::int AS done,
            SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END)::int AS queued,
            SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END)::int AS processing,
            SUM(CASE WHEN status='error' THEN 1 ELSE 0 END)::int AS error,
            SUM(CASE WHEN status='done' AND red_number IS NULL THEN 1 ELSE 0 END)::int AS nonum,
            SUM(CASE WHEN dup_idx > 1 THEN 1 ELSE 0 END)::int AS dup,
            SUM(CASE WHEN status='done' AND cardinality(low_conf) > 0 THEN 1 ELSE 0 END)::int AS lowconf,
            to_char(MAX(processed_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_processed
       FROM survey_pages WHERE survey_id=$1`, [sid])).rows[0] || {};
  const n = (k) => Number(r[k] || 0);
  return { total: n('total'), done: n('done'), queued: n('queued'), processing: n('processing'), error: n('error'),
    nonum: n('nonum'), dup: n('dup'), lowconf: n('lowconf'), last_processed: r.last_processed || null };
}

// 같은 번호 안에서 비어 있는 가장 작은 순번(1, 2, 3…) — 자기 자신은 뺀다
async function freeDupIdx(q, sid, redNumber, selfId) {
  const rows = (await q(
    `SELECT dup_idx FROM survey_pages WHERE survey_id=$1 AND red_number=$2 AND id<>$3`,
    [sid, redNumber, selfId])).rows;
  const used = new Set(rows.map((r) => Number(r.dup_idx)));
  let i = 1; while (used.has(i)) i++;
  return i;
}

function pageOut(r, prefix) {
  return {
    id: Number(r.id), seq: Number(r.seq), orig_name: r.orig_name, mime: r.mime,
    file_bytes: r.file_bytes != null ? Number(r.file_bytes) : null,
    red_number: r.red_number || null, red_raw: r.red_raw || null, dup_idx: Number(r.dup_idx || 1),
    file_name: pageFileName({ prefix, red_number: r.red_number, dup_idx: r.dup_idx, seq: r.seq, mime: r.mime, status: r.status }),
    status: r.status, error: r.error || null, attempts: Number(r.attempts || 0),
    answers: r.answers || null, others: r.others || {}, geo: r.geo || {}, low_conf: r.low_conf || [], edited: r.edited || {},
    notes: r.ai_notes || null, has_view: !!r.has_view, has_thumb: !!r.has_thumb,
    uploaded_by: r.uploaded_by_name || null, created_at: iso(r.created_at), processed_at: iso(r.processed_at),
  };
}

// =====================================================================
// 판독 큐 — 단일 인스턴스, 동시 CONCURRENCY() 장
// =====================================================================
let running = 0;
let pausedUntil = 0;

async function claimNext() {
  return (await query(
    `UPDATE survey_pages SET status='processing', attempts = attempts + 1
      WHERE id = (SELECT p.id FROM survey_pages p JOIN surveys s ON s.id = p.survey_id AND s.deleted_at IS NULL
                   WHERE p.status = 'queued' ORDER BY p.id FOR UPDATE OF p SKIP LOCKED LIMIT 1)
      RETURNING id, survey_id, mime, attempts`)).rows[0] || null;
}

async function markFail(id, error, transient, attempts) {
  const requeue = transient && Number(attempts) < MAX_ATTEMPTS;
  await query(`UPDATE survey_pages SET status=$2, error=$3 WHERE id=$1`,
    [id, requeue ? 'queued' : 'error', String(error || 'error').slice(0, 300)]);
  return requeue;
}

export async function processPage(row) {
  const pid = Number(row.id);
  if (!aiReady()) { await query(`UPDATE survey_pages SET status='queued', attempts=GREATEST(attempts-1,0) WHERE id=$1`, [pid]); return false; }
  const s = await getSurvey(row.survey_id);
  if (!s) return markFail(pid, 'survey_deleted', false, row.attempts);
  const questions = qList(s);
  if (!questions.length) return markFail(pid, 'no_questions', false, row.attempts);
  const bin = (await query(`SELECT mime, file_data, view_data, edited, red_number, geo FROM survey_pages WHERE id=$1`, [pid])).rows[0];
  if (!bin) return false;

  const out = await surveyAiApi.call([mediaBlock(bin), { type: 'text', text: buildPagePrompt(questions, s.number_hint) }], 2500);
  if (!out.ok) {
    if (out.status === 429 || out.status === 529) pausedUntil = Date.now() + (Number(process.env.SURVEY_AI_PAUSE_MS) || 20000);
    return markFail(pid, out.error, out.transient, row.attempts);
  }
  const p = parsePageJson(out.text, questions);
  if (!p) return markFail(pid, 'ai_parse: 응답을 해석하지 못했습니다', Number(row.attempts) < 2, row.attempts);
  if (p.not_survey) return markFail(pid, 'not_survey: 이 설문지 양식이 아닌 것 같습니다', false, row.attempts);

  // 사람이 고친 칸은 지키고(다시 판독해도 덮어쓰지 않음), 사람이 넣은 번호도 지킨다
  const edited = bin.edited && typeof bin.edited === 'object' ? bin.edited : {};
  const answers = { ...p.answers };
  let low = p.low_conf.slice();
  const prevAns = (await query(`SELECT answers, others FROM survey_pages WHERE id=$1`, [pid])).rows[0] || {};
  const geo = { ...(p.geo || {}) };
  for (const k of Object.keys(edited)) {
    if (k === '_no') continue;
    if (prevAns.answers && Object.prototype.hasOwnProperty.call(prevAns.answers, k)) answers[k] = prevAns.answers[k];
    if (bin.geo && bin.geo[k]) geo[k] = bin.geo[k];          // 사람이 고른 주·도시는 다시 판독해도 지킨다
    low = low.filter((x) => x !== k);
  }
  const keepNo = !!edited._no;
  await withTx(async (c) => {
    const q = c.query.bind(c);
    await q(`SELECT pg_advisory_xact_lock($1, $2)`, [LOCK_NS, Number(row.survey_id)]);
    let red = keepNo ? bin.red_number : p.red_number;
    let dup = 1;
    if (red) dup = await freeDupIdx(q, Number(row.survey_id), red, pid);
    if (keepNo) low = low.filter((x) => x !== '_no');
    await q(
      `UPDATE survey_pages
          SET status='done', error=NULL, answers=$2, others=$3, low_conf=$4, red_number=$5, red_raw=$6,
              dup_idx=$7, ai_notes=$8, ai_model=$9, geo=$10, processed_at=now()
        WHERE id=$1`,
      [pid, JSON.stringify(answers), JSON.stringify(p.others || {}), low, red || null,
        keepNo ? null : p.red_raw, dup, p.notes || null, AI_MODEL(), JSON.stringify(geo)]);
  });
  return true;
}

export async function pump() {
  if (!aiReady()) return 0;
  let started = 0;
  while (running < CONCURRENCY() && Date.now() >= pausedUntil) {
    running++;                            // 자리를 먼저 잡는다 — 동시에 불린 pump 가 한도를 넘지 않게
    let row = null;
    try { row = await claimNext(); } catch (_) { running--; break; }
    if (!row) { running--; break; }
    started++;
    processPage(row)
      .catch((e) => markFail(Number(row.id), 'internal: ' + String(e && e.message).slice(0, 200), false, row.attempts).catch(() => {}))
      .finally(() => { running--; setTimeout(() => { pump().catch(() => {}); }, Date.now() < pausedUntil ? pausedUntil - Date.now() + 50 : 50); });
  }
  return started;
}
// 테스트용 — 큐가 빌 때까지 기다린다
export async function drainForTest(timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    await pump();
    const r = (await query(`SELECT COUNT(*)::int AS n FROM survey_pages WHERE status IN ('queued','processing')`)).rows[0];
    if (!Number(r.n) && running === 0) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((res) => setTimeout(res, 30));
  }
}

// =====================================================================
export default async function surveyRoutes(app) {
  // ── 목록 ──
  app.get('/api/surveys', { preHandler: [authGuard, requirePage(PAGE)] }, async () => {
    const rows = (await query(
      `SELECT s.id, s.title, s.code_prefix, to_char(s.survey_date,'YYYY-MM-DD') AS survey_date, s.created_at,
              jsonb_array_length(s.questions) AS q_count,
              COUNT(p.id)::int AS total,
              SUM(CASE WHEN p.status='done' THEN 1 ELSE 0 END)::int AS done,
              SUM(CASE WHEN p.status='error' THEN 1 ELSE 0 END)::int AS error
         FROM surveys s LEFT JOIN survey_pages p ON p.survey_id = s.id
        WHERE s.deleted_at IS NULL
        GROUP BY s.id ORDER BY s.created_at DESC, s.id DESC`)).rows;
    return {
      ai_ready: aiReady(), model: AI_MODEL(),
      items: rows.map((r) => ({ id: Number(r.id), title: r.title, code_prefix: r.code_prefix, survey_date: r.survey_date,
        q_count: Number(r.q_count || 0), total: Number(r.total || 0), done: Number(r.done || 0), error: Number(r.error || 0),
        created_at: iso(r.created_at) })),
    };
  });

  // ── 생성 ──
  app.post('/api/surveys', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const b = req.body || {};
    const title = clip(b.title, 200);
    const prefix = normPrefix(b.code_prefix);
    if (!title) return reply.code(400).send({ error: 'no_title' });
    if (!prefix) return reply.code(400).send({ error: 'no_prefix' });
    const date = DATE_RE.test(String(b.survey_date || '')) ? b.survey_date : null;
    const r = (await query(
      `INSERT INTO surveys (title, code_prefix, survey_date, created_by, updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING id`,
      [title, prefix, date, Number(req.ctx.perm.userId)])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `survey:${r.id}`, detail: { title, prefix } });
    return { ok: true, id: Number(r.id) };
  });

  // ── 1건 ──
  app.get('/api/surveys/:id', { preHandler: [authGuard, requirePage(PAGE)] }, async (req, reply) => {
    const s = await getSurvey(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const perm = req.ctx.perm;
    const lvl = (perm.pageAccess && perm.pageAccess[PAGE]) || 'edit';
    return {
      id: Number(s.id), title: s.title, code_prefix: s.code_prefix, survey_date: s.survey_date,
      questions: qList(s), number_hint: s.number_hint || '', has_template: !!s.has_template,
      template_mime: s.template_mime || null, ai_cache: s.ai_cache || null,
      counts: await pageCounts(Number(s.id)),
      ai_ready: aiReady(), model: AI_MODEL(),
      can_edit: perm.role === 'director' || lvl === 'edit', is_director: perm.role === 'director',
    };
  });

  // ── 저장(제목·접두어·날짜·문항) ──
  app.put('/api/surveys/:id', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const s = await getSurvey(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const title = b.title !== undefined ? clip(b.title, 200) : s.title;
    const prefix = b.code_prefix !== undefined ? normPrefix(b.code_prefix) : s.code_prefix;
    if (!title) return reply.code(400).send({ error: 'no_title' });
    if (!prefix) return reply.code(400).send({ error: 'no_prefix' });
    const date = b.survey_date === undefined ? s.survey_date : (DATE_RE.test(String(b.survey_date || '')) ? b.survey_date : null);
    let questions = qList(s);
    let changed = false;
    if (b.questions !== undefined) {
      const n = normalizeQuestions(b.questions, qList(s));
      if (n.errors.length) return reply.code(400).send({ error: 'bad_questions', details: n.errors });
      if (!n.questions.length) return reply.code(400).send({ error: 'no_questions' });
      changed = JSON.stringify(n.questions.map((q) => [q.k, q.type, q.options || null, q.min, q.max]))
        !== JSON.stringify(questions.map((q) => [q.k, q.type, q.options || null, q.min, q.max]));
      questions = n.questions;
    }
    const hint = b.number_hint !== undefined ? clip(b.number_hint, 300) : (s.number_hint || '');
    await query(
      `UPDATE surveys SET title=$2, code_prefix=$3, survey_date=$4, questions=$5, number_hint=$6,
              updated_by=$7, updated_at=now() WHERE id=$1`,
      [Number(s.id), title, prefix, date, JSON.stringify(questions), hint || null, Number(req.ctx.perm.userId)]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `survey:${s.id}`, detail: { q: questions.length, schema_changed: changed } });
    const counts = await pageCounts(Number(s.id));
    return { ok: true, questions, schema_changed: changed, needs_reprocess: changed && counts.done > 0, counts };
  });

  // ── 삭제(디렉터) — 응답까지 함께 사라진다(soft: 설문만 표시 제외, 원본은 남김) ──
  app.delete('/api/surveys/:id', { preHandler: [authGuard, requirePage(PAGE), requireDirector] }, async (req, reply) => {
    const s = await getSurvey(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    await query(`UPDATE surveys SET deleted_at=now(), updated_by=$2 WHERE id=$1`, [Number(s.id), Number(req.ctx.perm.userId)]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `survey:${s.id}`, detail: { title: s.title } });
    return { ok: true };
  });

  // ── 빈 양식 저장 + AI 문항 읽기(저장하지 않고 제안만 돌려준다 — 화면에서 확인 후 PUT) ──
  app.post('/api/surveys/:id/template', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const s = await getSurvey(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const mime = String(b.mime || '');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return reply.code(400).send({ error: 'bad_mime' });
    const f = b64buf(b.data_b64, FILE_MAX);
    if (f.err) return reply.code(400).send({ error: f.err });
    if (!sniffOk(mime, f.buf)) return reply.code(400).send({ error: 'bad_file' });
    await query(`UPDATE surveys SET template_mime=$2, template_data=$3, updated_at=now() WHERE id=$1`, [Number(s.id), mime, f.buf]);
    if (b.extract === false) return { ok: true, extracted: false };
    if (!aiReady()) return reply.code(503).send({ error: 'no_anthropic_key', saved: true });
    const out = await surveyAiApi.call([
      { type: 'image', source: { type: 'base64', media_type: mime, data: f.buf.toString('base64') } },
      { type: 'text', text: buildTemplatePrompt() },
    ], 4000);
    if (!out.ok) return reply.code(502).send({ error: out.error || 'ai_error', saved: true });
    const t = parseTemplateJson(out.text);
    if (!t) return reply.code(502).send({ error: 'ai_parse', saved: true });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `survey:${s.id}`, detail: { template_extract: t.questions.length } });
    return { ok: true, extracted: true, proposal: t };
  });

  app.get('/api/surveys/:id/template', { preHandler: [authGuard, requirePage(PAGE)] }, async (req, reply) => {
    const s = await getSurvey(req.params.id, true);
    if (!s || !s.template_data) return reply.code(404).send({ error: 'not_found' });
    reply.header('Content-Type', s.template_mime || 'image/jpeg');
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.send(s.template_data);
  });

  // ── 응답 1장 업로드 → 판독 대기 ──
  app.post('/api/surveys/:id/pages', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const s = await getSurvey(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    if (!qList(s).length) return reply.code(409).send({ error: 'no_questions' });
    const b = req.body || {};
    const mime = String(b.mime || '');
    if (!MIMES.includes(mime)) return reply.code(400).send({ error: 'bad_mime' });
    const f = b64buf(b.file_b64, FILE_MAX);
    if (f.err) return reply.code(f.err === 'too_large' ? 413 : 400).send({ error: f.err, max: f.max });
    if (!sniffOk(mime, f.buf)) return reply.code(400).send({ error: 'bad_file' });
    let view = null; let thumb = null;
    if (b.view_b64) {
      const v = b64buf(b.view_b64, VIEW_MAX);
      if (v.err || !isJpeg(v.buf)) return reply.code(400).send({ error: 'bad_view' });
      view = v.buf;
    }
    if (b.thumb_b64) {
      const t = b64buf(b.thumb_b64, THUMB_MAX);
      if (!t.err && (isJpeg(t.buf) || isPng(t.buf))) thumb = t.buf;
    }
    const sha = crypto.createHash('sha256').update(f.buf).digest('hex');
    const sid = Number(s.id);
    const res = await withTx(async (c) => {
      const q = c.query.bind(c);
      await q(`SELECT pg_advisory_xact_lock($1, $2)`, [LOCK_NS, sid]);
      const same = (await q(`SELECT id, seq FROM survey_pages WHERE survey_id=$1 AND file_sha=$2`, [sid, sha])).rows[0];
      if (same) return { same };
      const seq = Number((await q(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM survey_pages WHERE survey_id=$1`, [sid])).rows[0].n);
      const r = (await q(
        `INSERT INTO survey_pages (survey_id, seq, orig_name, mime, file_data, file_bytes, file_sha, view_data, thumb_data, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [sid, seq, clip(b.orig_name, 200) || null, mime, f.buf, f.buf.length, sha, view, thumb, Number(req.ctx.perm.userId)])).rows[0];
      return { id: Number(r.id), seq };
    });
    if (res.same) return reply.code(409).send({ error: 'same_file', page_id: Number(res.same.id), seq: Number(res.same.seq) });
    setTimeout(() => { pump().catch(() => {}); }, 30);
    return { ok: true, id: res.id, seq: res.seq, status: 'queued', ai_ready: aiReady() };
  });

  // ── 응답 목록(원본 제외) + 진행 카운트 ──
  app.get('/api/surveys/:id/pages', { preHandler: [authGuard, requirePage(PAGE)] }, async (req, reply) => {
    const s = await getSurvey(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const rows = (await query(
      `SELECT p.id, p.seq, p.orig_name, p.mime, p.file_bytes, p.red_number, p.red_raw, p.dup_idx, p.status, p.error,
              p.attempts, p.answers, p.others, p.geo, p.low_conf, p.edited, p.ai_notes,
              (p.view_data IS NOT NULL) AS has_view, (p.thumb_data IS NOT NULL) AS has_thumb,
              p.created_at, p.processed_at, u.name AS uploaded_by_name
         FROM survey_pages p LEFT JOIN users u ON u.id = p.uploaded_by
        WHERE p.survey_id = $1 ORDER BY p.seq`, [Number(s.id)])).rows;
    if (rows.some((r) => r.status === 'queued')) setTimeout(() => { pump().catch(() => {}); }, 10);
    return { counts: await pageCounts(Number(s.id)), ai_ready: aiReady(), items: rows.map((r) => pageOut(r, s.code_prefix)) };
  });

  async function pageWithSurvey(pidRaw) {
    const pid = idOf(pidRaw);
    if (!pid) return null;
    const r = (await query(
      `SELECT p.id, p.survey_id, p.seq, p.mime, p.red_number, p.dup_idx, p.status, p.answers, p.geo, p.low_conf, p.edited,
              s.code_prefix, s.questions
         FROM survey_pages p JOIN surveys s ON s.id = p.survey_id AND s.deleted_at IS NULL
        WHERE p.id = $1`, [pid])).rows[0];
    return r || null;
  }

  // ── 원본 / 화면용 / 썸네일 ──
  app.get('/api/surveys/pages/:pid/file', { preHandler: [authGuard, requirePage(PAGE)] }, async (req, reply) => {
    const p = await pageWithSurvey(req.params.pid);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const d = (await query(`SELECT file_data FROM survey_pages WHERE id=$1`, [Number(p.id)])).rows[0];
    const name = pageFileName({ prefix: p.code_prefix, red_number: p.red_number, dup_idx: p.dup_idx, seq: p.seq, mime: p.mime, status: p.status });
    reply.header('Content-Type', p.mime);
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    return reply.send(d.file_data);
  });
  app.get('/api/surveys/pages/:pid/view', { preHandler: [authGuard, requirePage(PAGE)] }, async (req, reply) => {
    const p = await pageWithSurvey(req.params.pid);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const d = (await query(`SELECT mime, view_data, file_data FROM survey_pages WHERE id=$1`, [Number(p.id)])).rows[0];
    reply.header('Cache-Control', 'private, max-age=600');
    if (d.view_data) { reply.header('Content-Type', 'image/jpeg'); return reply.send(d.view_data); }
    reply.header('Content-Type', d.mime);
    return reply.send(d.file_data);
  });
  app.get('/api/surveys/pages/:pid/thumb', { preHandler: [authGuard, requirePage(PAGE)] }, async (req, reply) => {
    const p = await pageWithSurvey(req.params.pid);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const d = (await query(`SELECT thumb_data FROM survey_pages WHERE id=$1`, [Number(p.id)])).rows[0];
    if (!d || !d.thumb_data) return reply.code(404).send({ error: 'no_thumb' });
    reply.header('Content-Type', isPng(d.thumb_data) ? 'image/png' : 'image/jpeg');
    reply.header('Cache-Control', 'private, max-age=600');
    return reply.send(d.thumb_data);
  });

  // ── 번호·답 고치기(필수 아님 — 눈에 띈 칸만) ──
  app.patch('/api/surveys/pages/:pid', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const p = await pageWithSurvey(req.params.pid);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const questions = Array.isArray(p.questions) ? p.questions : [];
    const edited = { ...(p.edited || {}) };
    let low = Array.isArray(p.low_conf) ? p.low_conf.slice() : [];
    const answers = { ...(p.answers || {}) };
    const geo = { ...(p.geo || {}) };
    let changedKeys = [];
    // 지역 수정: {geo:{q2:{estado:'Nuevo León', ciudad:'Monterrey'}}} — 주는 32개 목록 안이어야 한다
    if (b.geo && typeof b.geo === 'object') {
      for (const q of questions.filter((x) => x.type === 'geo')) {
        if (!Object.prototype.hasOwnProperty.call(b.geo, q.k)) continue;
        const g = b.geo[q.k] || {};
        const est = g.estado == null || g.estado === '' ? null : String(g.estado);
        if (est && !STATE_NAMES.includes(est)) return reply.code(400).send({ error: 'bad_state', k: q.k });
        const ciudad = clip(g.ciudad, 80) || null;
        const prev = (p.geo || {})[q.k] || {};
        geo[q.k] = { estado: est, ciudad, raw: prev.raw || [ciudad, est].filter(Boolean).join(', ') };
        answers[q.k] = est;
        edited[q.k] = true;
        low = low.filter((x) => x !== q.k);
        changedKeys.push(q.k);
      }
    }
    if (b.answers && typeof b.answers === 'object') {
      const qs = questions.filter((q) => Object.prototype.hasOwnProperty.call(b.answers, q.k));
      if (qs.length) {
        const n = normalizeAnswers(b.answers, b.others || {}, [], qs);
        for (const q of qs) {
          const bad = n.low_conf.includes(q.k);
          if (bad) return reply.code(400).send({ error: 'bad_answer', k: q.k });
          answers[q.k] = n.answers[q.k];
          edited[q.k] = true;
          low = low.filter((x) => x !== q.k);
          changedKeys.push(q.k);
        }
      }
    }
    const sid = Number(p.survey_id);
    const result = await withTx(async (c) => {
      const q = c.query.bind(c);
      await q(`SELECT pg_advisory_xact_lock($1, $2)`, [LOCK_NS, sid]);
      let red = p.red_number; let dup = Number(p.dup_idx || 1);
      if (b.red_number !== undefined) {
        const want = b.red_number === null || b.red_number === '' ? null : normRedNumber(b.red_number);
        if (b.red_number && !want) return { err: 'bad_number' };
        if (want && want !== p.red_number) {
          const taken = (await q(`SELECT id FROM survey_pages WHERE survey_id=$1 AND red_number=$2 AND id<>$3 ORDER BY dup_idx LIMIT 1`,
            [sid, want, Number(p.id)])).rows[0];
          if (taken && !b.allow_dup) return { err: 'number_taken', page_id: Number(taken.id) };
          dup = await freeDupIdx(q, sid, want, Number(p.id));
        } else if (want && want === p.red_number && dup > 1) {
          dup = await freeDupIdx(q, sid, want, Number(p.id));   // 앞 번호가 지워졌으면 -2 → 원래 이름으로
        }
        if (!want) dup = 1;
        red = want; edited._no = true; low = low.filter((x) => x !== '_no');
        changedKeys.push('_no');
      }
      await q(`UPDATE survey_pages SET answers=$2, red_number=$3, dup_idx=$4, edited=$5, low_conf=$6, geo=$7 WHERE id=$1`,
        [Number(p.id), JSON.stringify(answers), red, dup, JSON.stringify(edited), low, JSON.stringify(geo)]);
      return { red, dup };
    });
    if (result.err) return reply.code(409).send({ error: result.err, page_id: result.page_id });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `survey_page:${p.id}`, detail: { keys: changedKeys } });
    return {
      ok: true, red_number: result.red, dup_idx: result.dup,
      file_name: pageFileName({ prefix: p.code_prefix, red_number: result.red, dup_idx: result.dup, seq: p.seq, mime: p.mime, status: p.status }),
    };
  });

  // ── 다시 판독(1장) ──
  app.post('/api/surveys/pages/:pid/retry', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const p = await pageWithSurvey(req.params.pid);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    if (p.status === 'processing') return reply.code(409).send({ error: 'processing' });
    await query(`UPDATE survey_pages SET status='queued', error=NULL, attempts=0 WHERE id=$1`, [Number(p.id)]);
    setTimeout(() => { pump().catch(() => {}); }, 30);
    return { ok: true, ai_ready: aiReady() };
  });

  // ── 다시 판독(여러 장) — scope: error(실패만) | all(전체: 문항을 바꾼 뒤) ──
  app.post('/api/surveys/:id/reprocess', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const s = await getSurvey(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const scope = (req.body && req.body.scope) === 'all' ? 'all' : 'error';
    const r = await query(
      `UPDATE survey_pages SET status='queued', error=NULL, attempts=0
        WHERE survey_id=$1 AND status IN (${scope === 'all' ? `'done','error'` : `'error'`}) RETURNING id`, [Number(s.id)]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `survey:${s.id}`, detail: { reprocess: scope, n: r.rowCount } });
    setTimeout(() => { pump().catch(() => {}); }, 30);
    return { ok: true, queued: r.rowCount, ai_ready: aiReady() };
  });

  // ── 지역 다시 정리 (AI 호출 없음) ──
  //   규칙표(주 별칭·도시)를 고치거나, 지역 문항으로 유형을 바꾼 뒤 이미 읽어 둔 답을 다시 맞춘다.
  //   사람이 고친 칸은 건드리지 않는다.
  app.post('/api/surveys/:id/geo-normalize', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const s = await getSurvey(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const geoQs = qList(s).filter((q) => q.type === 'geo');
    if (!geoQs.length) return reply.code(409).send({ error: 'no_geo_question' });
    const rows = (await query(
      `SELECT id, answers, others, geo, edited, low_conf FROM survey_pages WHERE survey_id=$1 AND status='done' ORDER BY seq`,
      [Number(s.id)])).rows;
    let changed = 0; let unresolved = 0;
    for (const r of rows) {
      const answers = { ...(r.answers || {}) };
      const geo = { ...(r.geo || {}) };
      const edited = r.edited || {};
      const low = new Set(r.low_conf || []);
      let touched = false;
      for (const q of geoQs) {
        if (edited[q.k]) { if (!answers[q.k]) unresolved++; continue; }      // 사람이 고른 것은 그대로
        const prev = geo[q.k] || {};
        const src = prev.raw || (r.others || {})[q.k] || answers[q.k] || '';
        if (!src) continue;
        const g = normalizeGeo({ estado: prev.estado || src, ciudad: prev.ciudad || '' });
        const next = { estado: g.estado, ciudad: g.ciudad, raw: prev.raw || String(src).slice(0, 160) };
        const same = (prev.estado || null) === (next.estado || null) && (prev.ciudad || null) === (next.ciudad || null)
          && (prev.raw || '') === (next.raw || '') && (answers[q.k] || null) === (g.estado || null);
        if (!same) touched = true;
        geo[q.k] = next;
        answers[q.k] = g.estado;
        if (g.estado) low.delete(q.k); else { low.add(q.k); unresolved++; }
      }
      if (touched) {
        changed++;
        await query(`UPDATE survey_pages SET answers=$2, geo=$3, low_conf=$4 WHERE id=$1`,
          [Number(r.id), JSON.stringify(answers), JSON.stringify(geo), [...low]]);
      }
    }
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `survey:${s.id}`, detail: { geo_normalize: changed } });
    return { ok: true, scanned: rows.length, changed, unresolved };
  });

  // ── 1장 삭제(중복 등) ──
  app.delete('/api/surveys/pages/:pid', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const p = await pageWithSurvey(req.params.pid);
    if (!p) return reply.code(404).send({ error: 'not_found' });
    await query(`DELETE FROM survey_pages WHERE id=$1`, [Number(p.id)]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `survey_page:${p.id}`, detail: { survey_id: Number(p.survey_id), red_number: p.red_number } });
    return { ok: true };
  });

  // ── AI 요약: 서술형 주제 묶기 + 세그먼트 한 줄 해석 → ai_cache ──
  app.post('/api/surveys/:id/insights', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const s = await getSurvey(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    if (!aiReady()) return reply.code(503).send({ error: 'no_anthropic_key' });
    const questions = qList(s);
    const rows = (await query(
      `SELECT id, answers FROM survey_pages WHERE survey_id=$1 AND status='done' ORDER BY seq`, [Number(s.id)])).rows
      .map((r) => ({ id: Number(r.id), answers: r.answers || {} }));
    if (!rows.length) return reply.code(409).send({ error: 'no_done_pages' });
    const themes = {}; const errors = [];
    for (const q of questions.filter((x) => x.type === 'text')) {
      const items = rows.map((r) => ({ id: r.id, text: String(r.answers[q.k] || '').trim() })).filter((it) => it.text);
      if (items.length < 2) continue;
      const out = await surveyAiApi.call([{ type: 'text', text: buildThemePrompt(q, items) }], 4000);
      const t = out.ok ? parseThemeJson(out.text, items.map((i) => i.id)) : null;
      if (t) themes[q.k] = t; else errors.push({ k: q.k, error: out.ok ? 'ai_parse' : out.error });
    }
    let bullets = null;
    if (questions.some((q) => q.type === 'single' || q.type === 'multi' || q.type === 'scale')) {
      const out = await surveyAiApi.call([{ type: 'text', text: buildInsightPrompt(s.title, crossSummaryText(questions, rows)) }], 1500);
      bullets = out.ok ? parseInsightJson(out.text) : null;
      if (!bullets) errors.push({ k: '_insight', error: out.ok ? 'ai_parse' : out.error });
    }
    const counts = await pageCounts(Number(s.id));
    const cache = {
      generated_at: new Date().toISOString(), model: AI_MODEL(),
      basis: { done: counts.done, last_processed: counts.last_processed },
      themes, bullets: bullets || [], errors,
    };
    await query(`UPDATE surveys SET ai_cache=$2 WHERE id=$1`, [Number(s.id), JSON.stringify(cache)]);
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `survey_insight:${s.id}`, detail: { themes: Object.keys(themes).length, errors: errors.length } });
    return { ok: true, ai_cache: cache };
  });

  // ── 원본 zip(전체 또는 ?ids=1,2,3) — 무압축 스트리밍 ──
  app.get('/api/surveys/:id/zip', { preHandler: [authGuard, requirePage(PAGE)] }, async (req, reply) => {
    const s = await getSurvey(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const ids = String(req.query.ids || '').split(',').map(idOf).filter(Boolean).slice(0, 2000);
    const list = (await query(
      `SELECT id, seq, mime, red_number, dup_idx, status, created_at FROM survey_pages
        WHERE survey_id=$1 ${ids.length ? 'AND id = ANY($2::bigint[])' : ''}
        ORDER BY red_number NULLS LAST, dup_idx, seq`, ids.length ? [Number(s.id), ids] : [Number(s.id)])).rows;
    if (!list.length) return reply.code(404).send({ error: 'no_pages' });
    async function* entries() {
      for (const r of list) {
        const d = (await query(`SELECT file_data FROM survey_pages WHERE id=$1`, [Number(r.id)])).rows[0];
        if (!d) continue;
        yield {
          name: pageFileName({ prefix: s.code_prefix, red_number: r.red_number, dup_idx: r.dup_idx, seq: r.seq, mime: r.mime, status: r.status }),
          data: d.file_data, date: r.created_at,
        };
      }
    }
    const fname = `${normPrefix(s.code_prefix) || 'ENC'}_originales${ids.length ? '_' + list.length : ''}.zip`;
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${fname}"`);
    await logEvent({ userId: req.ctx.perm.userId, action: 'export', target: `survey:${s.id}`, detail: { zip: list.length } });
    return reply.send(Readable.from(zipStream(entries())));
  });

  // ── 스케줄러: 60초마다 큐 확인 + 기동 20초 뒤 멈춘 건 되살리기 ──
  if (!globalThis.__refatrixSurveyScheduler && process.env.NODE_ENV !== 'test') {
    globalThis.__refatrixSurveyScheduler = setInterval(() => { pump().catch(() => {}); }, 60000);
    setTimeout(async () => {
      try { await query(`UPDATE survey_pages SET status='queued' WHERE status='processing'`); } catch (_) {}
      pump().catch(() => {});
    }, 20000);
  }
}
