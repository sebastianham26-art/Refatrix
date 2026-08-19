// =====================================================================
// Refatrix ERP · consultRoutes.js — 「영업 > 고객상담」 (디렉터 요청 2026-08-19)
//
//   ① 상담 등록: 업체명 · 담당자 이름 · WhatsApp 전화 · 이메일 · 상담일(달력) ·
//      장소(브라우저 위치정보). 기존 고객을 고르면 customer_id 로 연결(선택).
//   ② 미팅 녹음: 상담에 붙여 업로드(queued) → Whisper 전사(transcribing) →
//      Claude 카테고리 분류 요약(summarizing) → done.
//      done 시 action_items 를 sales_consult_pendings 에 카테고리와 함께 자동 등록.
//      처리 성공 후 오디오 원본은 기본 폐기(CONSULT_KEEP_AUDIO=1 시 보존).
//   ③ 한국어 토글: 요약을 최초 1회만 번역해 summary_json.ko 에 캐시(원문 불변).
//   ④ 기간 인사이트: 선택한 상담들을 묶어 카테고리 불릿 인사이트 생성(scope_key 캐시).
//   ⑤ 감추기(디렉터 특별권한): private_by 가 채워진 상담은 그 사용자에게만 보인다.
//
//   ── 환경변수 (전부 기존 키 재사용) ──
//   · OPENAI_API_KEY / ANTHROPIC_API_KEY
//   · VISIT_STT_MODEL (기본 whisper-1) · VISIT_AI_MODEL (기본 claude-sonnet-4-5)
//   · CONSULT_KEEP_AUDIO=1  전사 후 오디오 보존(기본 폐기)
//   · CONSULT_REC_ENABLED=0 상담 녹음 끄기
//
//   ※ 방문(sales_visits / visitRecRoutes) 경로는 일절 건드리지 않는다.
// =====================================================================
import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { mxTodayStr } from '../workingHours.js';
import {
  clip, buildConsultSummaryPrompt, parseConsultSummaryJson,
  buildConsultTranslatePrompt, parseConsultTranslationJson,
  buildInsightPrompt, parseInsightJson, scopeKeyOf, normCat, CONSULT_CATS,
} from '../consultAi.js';

const PAGE = 'pipeline';                    // 화면 권한키 — 영업활동 권한을 재사용
const STT_MODEL = () => process.env.VISIT_STT_MODEL || 'whisper-1';
const AI_MODEL = () => process.env.VISIT_AI_MODEL || 'claude-sonnet-4-5-20250929';
const KEEP_AUDIO = () => process.env.CONSULT_KEEP_AUDIO === '1';

const AUDIO_B64_MAX = 34 * 1024 * 1024;     // ≈ 25MB 바이너리(Whisper 한도)
const AUDIO_PARTS_MAX = 40;
const DURATION_MAX = 4 * 3600;              // 4시간
const TRANSCRIPT_PROMPT_MAX = 24000;
const STT_TIMEOUT_MS = 300000;
const AI_TIMEOUT_MS = 120000;
const MAX_AUTO_ATTEMPTS = 3;
const LIST_MAX = 500;
const INSIGHT_MAX = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function consultRecEnabled() { return process.env.CONSULT_REC_ENABLED !== '0'; }
export function sttReady() { return !!process.env.OPENAI_API_KEY; }
export function aiReady() { return !!process.env.ANTHROPIC_API_KEY; }

function d10(v) { if (!v) return null; if (v instanceof Date) return v.toISOString().slice(0, 10); return String(v).slice(0, 10); }
function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
function daysBetween(aYmd, bYmd) {
  if (!aYmd || !bYmd) return 0;
  const [ay, am, ad] = String(aYmd).split('-').map(Number);
  const [by, bm, bd] = String(bYmd).split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}
function txt(v, n) { const s = clip(v, n); return s || null; }

// ── 외부 API 호출(테스트에서 모킹 가능하도록 export) ──
export const consultAiApi = {
  async transcribe({ b64, mime }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STT_TIMEOUT_MS);
    try {
      const buf = Buffer.from(String(b64 || ''), 'base64');
      const ext = /mp4|m4a/.test(String(mime)) ? 'mp4' : (/ogg/.test(String(mime)) ? 'ogg' : (/mpeg|mp3/.test(String(mime)) ? 'mp3' : 'webm'));
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'audio.' + ext);
      fd.append('model', STT_MODEL());
      fd.append('response_format', 'json');
      const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: fd,
        signal: ctrl.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = (data && data.error && data.error.message) || ('http_' + resp.status);
        return { ok: false, error: 'stt: ' + String(msg).slice(0, 250), transient: resp.status >= 500 || resp.status === 429 };
      }
      return { ok: true, text: String(data.text || '').trim() };
    } catch (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? 'stt: timeout' : 'stt: network', transient: true };
    } finally { clearTimeout(timer); }
  },
  async summarize(prompt, maxTokens = 1800) {
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
        body: JSON.stringify({ model: AI_MODEL(), max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        signal: ctrl.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = (data && data.error && data.error.message) || ('http_' + resp.status);
        return { ok: false, error: 'ai: ' + String(msg).slice(0, 250), transient: resp.status >= 500 || resp.status === 429 };
      }
      const t = (data && Array.isArray(data.content))
        ? data.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
      return { ok: true, text: t };
    } catch (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? 'ai: timeout' : 'ai: network', transient: true };
    } finally { clearTimeout(timer); }
  },
};

// =====================================================================
// 녹음 처리 큐 (단일 인스턴스 순차 처리 — 방문 큐와 독립)
// =====================================================================
let processing = false;

async function claimNext() {
  const next = (await query(
    `SELECT id FROM sales_consult_recordings WHERE status='queued' ORDER BY id LIMIT 1`)).rows[0];
  if (!next) return null;
  const row = (await query(
    `UPDATE sales_consult_recordings
        SET status='transcribing', attempts = attempts + 1
      WHERE id = $1 AND status='queued'
      RETURNING id, consult_id, mode, mime, audio_b64, transcript, duration_sec, created_by, attempts`,
    [Number(next.id)])).rows[0];
  return row || null;
}

async function markFailed(id, error, transient, attempts) {
  const requeue = transient && Number(attempts) < MAX_AUTO_ATTEMPTS;
  await query(
    `UPDATE sales_consult_recordings SET status=$2, error=$3 WHERE id=$1`,
    [id, requeue ? 'queued' : 'failed', String(error || 'error').slice(0, 400)]);
}

export async function processOne(row) {
  const recId = Number(row.id);
  if (!aiReady()) return markFailed(recId, 'no_anthropic_key', false, row.attempts);

  const c = (await query(
    `SELECT id, consult_date, company_name, contact_name, place_label
       FROM sales_consults WHERE id = $1 AND deleted_at IS NULL`, [row.consult_id])).rows[0];
  if (!c) return markFailed(recId, 'consult_not_found', false, row.attempts);

  // ① 전사(이미 있으면 건너뜀 — 요약 재시도 시 STT 비용 없음). 다중 구간은 '|' 구분.
  let transcript = String(row.transcript || '').trim();
  if (!transcript) {
    if (!sttReady()) return markFailed(recId, 'no_openai_key', false, row.attempts);
    if (!row.audio_b64) return markFailed(recId, 'no_audio', false, row.attempts);
    const partList = String(row.audio_b64).split('|').filter(Boolean);
    const texts = [];
    for (const p of partList) {
      const st = await consultAiApi.transcribe({ b64: p, mime: row.mime });
      if (!st.ok) return markFailed(recId, st.error, st.transient, row.attempts);
      if (st.text) texts.push(st.text);
    }
    transcript = texts.join('\n').trim();
    if (!transcript) return markFailed(recId, 'empty_transcript', false, row.attempts);
    await query(
      `UPDATE sales_consult_recordings
          SET transcript=$2, status='summarizing', error=NULL,
              audio_b64 = CASE WHEN $3 THEN audio_b64 ELSE NULL END
        WHERE id=$1`, [recId, transcript, KEEP_AUDIO()]);
  } else {
    await query(`UPDATE sales_consult_recordings SET status='summarizing', error=NULL WHERE id=$1`, [recId]);
  }

  // ② Claude 카테고리 분류 요약
  const prompt = buildConsultSummaryPrompt({
    transcript: clip(transcript, TRANSCRIPT_PROMPT_MAX),
    companyName: c.company_name, contactName: c.contact_name,
    placeLabel: c.place_label, consultDate: d10(c.consult_date), mode: row.mode,
  });
  const sm = await consultAiApi.summarize(prompt);
  if (!sm.ok) return markFailed(recId, sm.error, sm.transient, row.attempts);
  const summary = parseConsultSummaryJson(sm.text);
  if (!summary) return markFailed(recId, 'ai_parse', false, row.attempts);

  // ③ 반영: 요약 저장 + 펜딩 자동 등록(카테고리 포함)
  await withTx(async (client) => {
    const q = client.query.bind(client);
    await q(
      `UPDATE sales_consult_recordings
          SET status='done', summary_json=$2, error=NULL, processed_at=now()
        WHERE id=$1`, [recId, JSON.stringify(summary)]);
    // 같은 녹음의 재처리로 인한 중복을 막기 위해 AI 등록분(ai_rec 표식)만 먼저 제거
    await q(`DELETE FROM sales_consult_pendings WHERE consult_id=$1 AND source_rec_id=$2`, [Number(c.id), recId]);
    for (const it of summary.action_items) {
      await q(
        `INSERT INTO sales_consult_pendings (consult_id, content, category, due_date, source_rec_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [Number(c.id), it.content, it.category, it.due_date, recId]);
    }
  });
  await logEvent({
    userId: Number(row.created_by), action: 'update', target: `consult_recording:${recId}`,
    detail: { consult_id: Number(c.id), action_items: summary.action_items.length },
  });
  return true;
}

export async function processQueueTick(max = 3) {
  if (processing) return 0;
  processing = true;
  let n = 0;
  try {
    for (let i = 0; i < max; i++) {
      const row = await claimNext();
      if (!row) break;
      try { await processOne(row); } catch (e) {
        await markFailed(Number(row.id), 'internal: ' + String(e && e.message).slice(0, 200), false, row.attempts).catch(() => {});
      }
      n++;
    }
  } finally { processing = false; }
  return n;
}

// =====================================================================
// 가시성 — 감추기(private_by)는 그 사용자에게만. 비디렉터는 본인 상담만.
// =====================================================================
export function visibilityCond(perm, params) {
  const conds = ['c.deleted_at IS NULL'];
  params.push(Number(perm.userId));
  const me = `$${params.length}`;
  conds.push(`(c.private_by IS NULL OR c.private_by = ${me})`);
  if (perm.role !== 'director') conds.push(`c.created_by = ${me}`);
  return conds;
}

// 상담 1건 접근(본인 또는 디렉터 · 남이 숨긴 건 제외)
async function ownConsult(perm, consultId) {
  const id = Number(consultId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const params = [];
  const conds = visibilityCond(perm, params);
  params.push(id);
  conds.push(`c.id = $${params.length}`);
  return (await query(
    `SELECT c.id, c.created_by, c.company_name, c.private_by
       FROM sales_consults c WHERE ${conds.join(' AND ')}`, params)).rows[0] || null;
}

// 상담 목록 + 요약 + 펜딩 (표·카테고리 정리·인사이트 공용)
export async function buildConsultList(perm, opts = {}) {
  const mxToday = mxTodayStr(new Date());
  const to = DATE_RE.test(String(opts.to)) ? String(opts.to) : mxToday;
  let from = DATE_RE.test(String(opts.from)) ? String(opts.from) : shiftYmd(to, -29);
  if (daysBetween(to, from) < 0) from = to;

  const params = [];
  const conds = visibilityCond(perm, params);
  params.push(from); conds.push(`c.consult_date >= $${params.length}`);
  params.push(to); conds.push(`c.consult_date <= $${params.length}`);
  if (perm.role === 'director' && opts.userId) {
    params.push(Number(opts.userId)); conds.push(`c.created_by = $${params.length}`);
  }
  if (opts.q) {
    params.push(`%${String(opts.q).trim()}%`);
    conds.push(`(c.company_name ILIKE $${params.length} OR c.contact_name ILIKE $${params.length})`);
  }

  const rows = (await query(
    `SELECT c.id, c.consult_date, c.company_name, c.customer_id, c.contact_name, c.wa_phone, c.email,
            c.geo_lat, c.geo_lng, c.geo_accuracy, c.place_label, c.note,
            c.private_by, c.private_at, c.created_by, c.created_at,
            u.name AS by_name, u.login_id AS by_login
       FROM sales_consults c
       LEFT JOIN users u ON u.id = c.created_by
      WHERE ${conds.join(' AND ')}
      ORDER BY c.consult_date DESC, c.id DESC
      LIMIT ${LIST_MAX}`, params)).rows;
  const ids = rows.map((r) => Number(r.id));

  const pendByConsult = {};
  const recByConsult = {};
  if (ids.length) {
    const pend = (await query(
      `SELECT id, consult_id, content, category, due_date, done
         FROM sales_consult_pendings WHERE consult_id = ANY($1)
        ORDER BY done ASC, (due_date IS NULL) ASC, due_date ASC, id ASC`, [ids])).rows;
    for (const p of pend) {
      (pendByConsult[Number(p.consult_id)] ||= []).push({
        id: Number(p.id), content: p.content, category: normCat(p.category), due_date: d10(p.due_date),
        done: !!p.done,
        overdue: (!p.done && p.due_date && daysBetween(mxToday, d10(p.due_date)) > 0) ? daysBetween(mxToday, d10(p.due_date)) : 0,
      });
    }
    const recs = (await query(
      `SELECT id, consult_id, status, duration_sec, summary_json FROM sales_consult_recordings
        WHERE consult_id = ANY($1) ORDER BY id ASC`, [ids])).rows;
    for (const r of recs) {
      const cid = Number(r.consult_id);
      const cur = recByConsult[cid] || {};
      cur.rec_status = r.status;
      cur.duration_sec = r.duration_sec != null ? Number(r.duration_sec) : cur.duration_sec;
      if (r.status === 'done' && r.summary_json) {
        cur.rec_id = Number(r.id);
        try { cur.summary = typeof r.summary_json === 'string' ? JSON.parse(r.summary_json) : r.summary_json; } catch (_) {}
      }
      recByConsult[cid] = cur;
    }
  }

  const items = rows.map((r) => {
    const cid = Number(r.id);
    const rec = recByConsult[cid] || {};
    const pendings = pendByConsult[cid] || [];
    const total = pendings.length;
    const done = pendings.filter((p) => p.done).length;
    const overdue = pendings.filter((p) => p.overdue > 0).length;
    const s = rec.summary || null;
    return {
      id: cid,
      consult_date: d10(r.consult_date),
      company_name: r.company_name,
      customer_id: r.customer_id != null ? Number(r.customer_id) : null,
      contact_name: r.contact_name || null,
      wa_phone: r.wa_phone || null,
      email: r.email || null,
      geo_lat: r.geo_lat != null ? Number(r.geo_lat) : null,
      geo_lng: r.geo_lng != null ? Number(r.geo_lng) : null,
      geo_accuracy: r.geo_accuracy != null ? Number(r.geo_accuracy) : null,
      place_label: r.place_label || null,
      note: r.note || null,
      created_by: Number(r.created_by),
      by_name: r.by_name || null,
      by_login: r.by_login || null,
      is_private: r.private_by != null,
      private_by: r.private_by != null ? Number(r.private_by) : null,
      rec_id: rec.rec_id != null ? rec.rec_id : null,
      rec_status: rec.rec_status || null,
      duration_sec: rec.duration_sec != null ? rec.duration_sec : null,
      has_ai: !!s,
      summary: s,
      headline: s ? clip(s.resumen, 160) : null,
      pend_total: total, pend_done: done, pend_overdue: overdue,
      fup: !total ? 'none' : (done === total ? 'done' : (overdue ? 'overdue' : 'open')),
      pendings,
    };
  });
  return { mx_today: mxToday, from, to, categories: CONSULT_CATS, items };
}

// =====================================================================
// 라우트
// =====================================================================
export default async function consultRoutes(app) {
  // ── 카테고리 목록(화면 렌더용) ──
  app.get('/api/consults/categories', { preHandler: [authGuard, requirePage(PAGE)] },
    async () => ({ items: CONSULT_CATS }));

  // ── 목록(표 · 카테고리 정리 · 인사이트 공용) ──
  app.get('/api/consults', { preHandler: [authGuard, requirePage(PAGE)] }, async (req) => {
    const out = await buildConsultList(req.ctx.perm, {
      from: req.query.from, to: req.query.to, userId: req.query.user_id, q: req.query.q,
    });
    return { ...out, is_director: req.ctx.perm.role === 'director', me: Number(req.ctx.perm.userId) };
  });

  // ── 상담 등록 ──
  app.post('/api/consults', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const b = req.body || {};
    const company = txt(b.company_name, 200);
    if (!company) return reply.code(400).send({ error: 'company_required' });
    const date = DATE_RE.test(String(b.consult_date)) ? String(b.consult_date) : mxTodayStr(new Date());
    const lat = b.geo_lat == null || b.geo_lat === '' ? null : Number(b.geo_lat);
    const lng = b.geo_lng == null || b.geo_lng === '' ? null : Number(b.geo_lng);
    const acc = b.geo_accuracy == null || b.geo_accuracy === '' ? null : Number(b.geo_accuracy);
    if ((lat != null && !Number.isFinite(lat)) || (lng != null && !Number.isFinite(lng))) {
      return reply.code(400).send({ error: 'bad_geo' });
    }
    const custId = b.customer_id ? Number(b.customer_id) : null;
    const r = (await query(
      `INSERT INTO sales_consults
         (consult_date, company_name, customer_id, contact_name, wa_phone, email,
          geo_lat, geo_lng, geo_accuracy, place_label, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [date, company, Number.isInteger(custId) && custId > 0 ? custId : null,
        txt(b.contact_name, 200), txt(b.wa_phone, 40), txt(b.email, 200),
        lat, lng, acc != null && Number.isFinite(acc) ? acc : null,
        txt(b.place_label, 300), txt(b.note, 4000), perm.userId])).rows[0];
    const id = Number(r.id);
    // 수기 펜딩(선택)
    for (const p of (Array.isArray(b.pendings) ? b.pendings : []).slice(0, 20)) {
      const content = txt(p && p.content, 300);
      if (!content) continue;
      await query(
        `INSERT INTO sales_consult_pendings (consult_id, content, category, due_date) VALUES ($1,$2,$3,$4)`,
        [id, content, normCat(p && p.category), (p && DATE_RE.test(String(p.due_date))) ? String(p.due_date) : null]);
    }
    await logEvent({ userId: perm.userId, action: 'create', target: `consult:${id}`, detail: { company, date } });
    return { id, consult_date: date, company_name: company };
  });

  // ── 상담 수정(본인 또는 디렉터) ──
  app.patch('/api/consults/:id', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const c = await ownConsult(perm, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const sets = []; const params = [Number(c.id)];
    const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (b.company_name !== undefined) {
      const v = txt(b.company_name, 200);
      if (!v) return reply.code(400).send({ error: 'company_required' });
      put('company_name', v);
    }
    if (b.consult_date !== undefined) {
      if (!DATE_RE.test(String(b.consult_date))) return reply.code(400).send({ error: 'bad_date' });
      put('consult_date', String(b.consult_date));
    }
    if (b.contact_name !== undefined) put('contact_name', txt(b.contact_name, 200));
    if (b.wa_phone !== undefined) put('wa_phone', txt(b.wa_phone, 40));
    if (b.email !== undefined) put('email', txt(b.email, 200));
    if (b.place_label !== undefined) put('place_label', txt(b.place_label, 300));
    if (b.note !== undefined) put('note', txt(b.note, 4000));
    if (b.customer_id !== undefined) {
      const n = b.customer_id ? Number(b.customer_id) : null;
      put('customer_id', Number.isInteger(n) && n > 0 ? n : null);
    }
    if (b.geo_lat !== undefined && b.geo_lng !== undefined) {
      const lat = Number(b.geo_lat), lng = Number(b.geo_lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return reply.code(400).send({ error: 'bad_geo' });
      put('geo_lat', lat); put('geo_lng', lng);
      put('geo_accuracy', Number.isFinite(Number(b.geo_accuracy)) ? Number(b.geo_accuracy) : null);
    }
    if (!sets.length) return { ok: true, id: Number(c.id), unchanged: true };
    sets.push('updated_at = now()');
    await query(`UPDATE sales_consults SET ${sets.join(', ')} WHERE id = $1`, params);
    await logEvent({ userId: perm.userId, action: 'update', target: `consult:${c.id}` });
    return { ok: true, id: Number(c.id) };
  });

  // ── 상담 삭제(소프트) ──
  app.delete('/api/consults/:id', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const c = await ownConsult(perm, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    await query(`UPDATE sales_consults SET deleted_at = now() WHERE id = $1`, [Number(c.id)]);
    await logEvent({ userId: perm.userId, action: 'delete', target: `consult:${c.id}` });
    return { ok: true, id: Number(c.id) };
  });

  // ── 감추기(디렉터 특별권한) — 켜면 나(디렉터)에게만 보인다 ──
  app.post('/api/consults/:id/private', { preHandler: [authGuard, requirePage(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const row = (await query(
      `SELECT id, private_by FROM sales_consults WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // 다른 디렉터가 숨긴 건은 건드릴 수 없다(그 사람에게만 보이는 상태 유지)
    if (row.private_by != null && Number(row.private_by) !== Number(perm.userId)) {
      return reply.code(403).send({ error: 'hidden_by_other' });
    }
    const value = !!(req.body && req.body.value);
    await query(
      `UPDATE sales_consults SET private_by = $2, private_at = CASE WHEN $2 IS NULL THEN NULL ELSE now() END WHERE id = $1`,
      [id, value ? Number(perm.userId) : null]);
    await logEvent({ userId: perm.userId, action: 'update', target: `consult:${id}`, detail: { private: value } });
    return { ok: true, id, is_private: value };
  });

  // ── 펜딩 추가 / 완료 토글 ──
  app.post('/api/consults/:id/pendings', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const c = await ownConsult(perm, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const content = txt(b.content, 300);
    if (!content) return reply.code(400).send({ error: 'content_required' });
    const r = (await query(
      `INSERT INTO sales_consult_pendings (consult_id, content, category, due_date) VALUES ($1,$2,$3,$4) RETURNING id`,
      [Number(c.id), content, normCat(b.category), DATE_RE.test(String(b.due_date)) ? String(b.due_date) : null])).rows[0];
    return { ok: true, id: Number(r.id) };
  });

  app.patch('/api/consults/pendings/:pid', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const pid = Number(req.params.pid);
    if (!Number.isInteger(pid) || pid <= 0) return reply.code(400).send({ error: 'bad_id' });
    const params = [pid];
    const conds = visibilityCond(perm, params);
    const row = (await query(
      `SELECT p.id FROM sales_consult_pendings p JOIN sales_consults c ON c.id = p.consult_id
        WHERE p.id = $1 AND ${conds.join(' AND ')}`, params)).rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    if (b.done !== undefined) {
      const done = !!b.done;
      await query(
        `UPDATE sales_consult_pendings
            SET done=$2, done_at = CASE WHEN $2 THEN now() ELSE NULL END, done_by = CASE WHEN $2 THEN $3 ELSE NULL END
          WHERE id=$1`, [pid, done, Number(perm.userId)]);
    }
    if (b.category !== undefined) {
      await query(`UPDATE sales_consult_pendings SET category=$2 WHERE id=$1`, [pid, normCat(b.category)]);
    }
    return { ok: true, id: pid };
  });

  // ── 미팅 녹음 업로드 → 큐 등록 ──
  app.post('/api/consults/:id/recordings',
    { bodyLimit: 48 * 1024 * 1024, preHandler: [authGuard, requirePageEdit(PAGE)] },
    async (req, reply) => {
      const perm = req.ctx.perm;
      if (!consultRecEnabled()) return reply.code(503).send({ error: 'rec_disabled' });
      const c = await ownConsult(perm, req.params.id);
      if (!c) return reply.code(404).send({ error: 'not_found' });
      const b = req.body || {};
      const urls = Array.isArray(b.data_urls) && b.data_urls.length ? b.data_urls : (b.data_url ? [b.data_url] : []);
      if (!urls.length || urls.length > AUDIO_PARTS_MAX) return reply.code(400).send({ error: 'bad_audio' });
      const RE = /^data:((?:audio|video)\/[\w.+-]+)(?:;codecs=[^;]*)?;base64,([A-Za-z0-9+/=]+)$/;
      let mime = null; const parts = []; let totalB64 = 0;
      for (const u of urls) {
        const m = RE.exec(String(u || ''));
        if (!m) return reply.code(400).send({ error: 'bad_audio' });
        if (!mime) mime = m[1];
        parts.push(m[2]); totalB64 += m[2].length;
      }
      if (totalB64 > AUDIO_B64_MAX) return reply.code(400).send({ error: 'too_large', max_mb: 25 });
      const dur = Number(b.duration_sec) || null;
      if (dur && dur > DURATION_MAX) return reply.code(400).send({ error: 'too_long', max_sec: DURATION_MAX });
      const mode = b.mode === 'memo' ? 'memo' : 'full';
      const r = (await query(
        `INSERT INTO sales_consult_recordings (consult_id, mode, mime, duration_sec, size_bytes, audio_b64, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [Number(c.id), mode, mime, dur, Math.round(totalB64 * 3 / 4), parts.join('|'), perm.userId])).rows[0];
      await logEvent({ userId: perm.userId, action: 'create', target: `consult_recording:${r.id}`,
        detail: { consult_id: Number(c.id), mode, duration_sec: dur, parts: parts.length } });
      setTimeout(() => { processQueueTick().catch(() => {}); }, 100);
      return { id: Number(r.id), status: 'queued', stt_ready: sttReady(), ai_ready: aiReady() };
    });

  // ── 상담의 녹음 목록·상태(폴링용) ──
  app.get('/api/consults/:id/recordings', { preHandler: [authGuard, requirePage(PAGE)] }, async (req, reply) => {
    const c = await ownConsult(req.ctx.perm, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const rows = (await query(
      `SELECT id, mode, mime, duration_sec, size_bytes, status, error, attempts, transcript, summary_json, created_at, processed_at
         FROM sales_consult_recordings WHERE consult_id=$1 ORDER BY id DESC`, [Number(c.id)])).rows;
    return {
      stt_ready: sttReady(), ai_ready: aiReady(),
      items: rows.map((r) => {
        let summary = null;
        if (r.summary_json) { try { summary = typeof r.summary_json === 'string' ? JSON.parse(r.summary_json) : r.summary_json; } catch (_) {} }
        return {
          id: Number(r.id), mode: r.mode, duration_sec: r.duration_sec != null ? Number(r.duration_sec) : null,
          status: r.status, error: r.error, attempts: Number(r.attempts),
          transcript: clip(r.transcript, 8000) || null, summary,
          created_at: r.created_at, processed_at: r.processed_at,
        };
      }),
    };
  });

  // ── 실패 건 수동 재시도 ──
  app.post('/api/consults/recordings/:rid/retry', { preHandler: [authGuard, requirePageEdit(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const rid = Number(req.params.rid);
    if (!Number.isInteger(rid) || rid <= 0) return reply.code(400).send({ error: 'bad_id' });
    const params = [rid];
    const conds = visibilityCond(perm, params);
    const row = (await query(
      `SELECT r.id, r.status FROM sales_consult_recordings r JOIN sales_consults c ON c.id = r.consult_id
        WHERE r.id = $1 AND ${conds.join(' AND ')}`, params)).rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.status !== 'failed') return reply.code(409).send({ error: 'not_failed', status: row.status });
    await query(`UPDATE sales_consult_recordings SET status='queued', error=NULL WHERE id=$1`, [rid]);
    setTimeout(() => { processQueueTick().catch(() => {}); }, 100);
    return { ok: true, id: rid, status: 'queued' };
  });

  // ── AI 요약 한국어 번역([🇰🇷 한국어] 토글) — 최초 1회만 Claude, 이후 캐시 ──
  app.post('/api/consults/recordings/:rid/translate', { preHandler: [authGuard, requirePage(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const rid = Number(req.params.rid);
    if (!Number.isInteger(rid) || rid <= 0) return reply.code(400).send({ error: 'bad_id' });
    const params = [rid];
    const conds = visibilityCond(perm, params);
    const row = (await query(
      `SELECT r.id, r.status, r.summary_json FROM sales_consult_recordings r JOIN sales_consults c ON c.id = r.consult_id
        WHERE r.id = $1 AND ${conds.join(' AND ')}`, params)).rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    let summary = null;
    if (row.summary_json) { try { summary = typeof row.summary_json === 'string' ? JSON.parse(row.summary_json) : row.summary_json; } catch (_) {} }
    if (!summary || !summary.resumen) return reply.code(409).send({ error: 'no_summary', status: row.status });
    const force = !!(req.body && req.body.force);
    if (summary.ko && !force) return { id: rid, ko: summary.ko, cached: true };
    if (!aiReady()) return reply.code(503).send({ error: 'no_anthropic_key' });
    const tr = await consultAiApi.summarize(buildConsultTranslatePrompt(summary));
    if (!tr.ok) return reply.code(502).send({ error: tr.error || 'ai_error' });
    const ko = parseConsultTranslationJson(tr.text, summary);
    if (!ko) return reply.code(502).send({ error: 'ai_parse' });
    await query(`UPDATE sales_consult_recordings SET summary_json=$2 WHERE id=$1`,
      [rid, JSON.stringify({ ...summary, ko })]);
    await logEvent({ userId: perm.userId, action: 'update', target: `consult_recording:${rid}`, detail: { translate: 'ko' } });
    return { id: rid, ko, cached: false };
  });

  // ── 선택한 상담들 → 기간 인사이트(카테고리 불릿) · scope_key 캐시 ──
  app.post('/api/consults/insights', { preHandler: [authGuard, requirePage(PAGE)] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const b = req.body || {};
    const rawIds = Array.isArray(b.ids) ? b.ids : [];
    const ids = Array.from(new Set(rawIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))).slice(0, INSIGHT_MAX);
    if (!ids.length) return reply.code(400).send({ error: 'no_selection' });

    // 볼 수 있는 것만 (남이 숨긴 건 자동 제외)
    const params = [];
    const conds = visibilityCond(perm, params);
    params.push(ids); conds.push(`c.id = ANY($${params.length})`);
    const rows = (await query(
      `SELECT c.id, c.consult_date, c.company_name, u.name AS by_name
         FROM sales_consults c LEFT JOIN users u ON u.id = c.created_by
        WHERE ${conds.join(' AND ')} ORDER BY c.consult_date ASC, c.id ASC`, params)).rows;
    if (!rows.length) return reply.code(404).send({ error: 'not_found' });
    const visibleIds = rows.map((r) => Number(r.id));
    const key = scopeKeyOf(visibleIds);

    const force = !!b.force;
    if (!force) {
      const cached = (await query(
        `SELECT insight_json FROM sales_consult_insights WHERE scope_key = $1`, [key])).rows[0];
      if (cached && cached.insight_json) {
        let ins = null;
        try { ins = typeof cached.insight_json === 'string' ? JSON.parse(cached.insight_json) : cached.insight_json; } catch (_) {}
        if (ins) return { scope_key: key, count: visibleIds.length, insight: ins, cached: true };
      }
    }
    if (!aiReady()) return reply.code(503).send({ error: 'no_anthropic_key' });

    // 요약·펜딩을 붙여 프롬프트 입력 구성
    const recs = (await query(
      `SELECT consult_id, summary_json FROM sales_consult_recordings
        WHERE consult_id = ANY($1) AND status='done' AND summary_json IS NOT NULL ORDER BY id ASC`, [visibleIds])).rows;
    const sByConsult = {};
    for (const r of recs) {
      try { sByConsult[Number(r.consult_id)] = typeof r.summary_json === 'string' ? JSON.parse(r.summary_json) : r.summary_json; } catch (_) {}
    }
    const pend = (await query(
      `SELECT consult_id, content, category, due_date FROM sales_consult_pendings
        WHERE consult_id = ANY($1) AND done = FALSE ORDER BY id ASC`, [visibleIds])).rows;
    const pByConsult = {};
    for (const p of pend) {
      (pByConsult[Number(p.consult_id)] ||= []).push({ content: p.content, category: normCat(p.category), due_date: d10(p.due_date) });
    }
    const items = rows.map((r) => {
      const s = sByConsult[Number(r.id)] || {};
      return {
        id: Number(r.id), date: d10(r.consult_date), company: r.company_name, by_name: r.by_name,
        resumen: s.resumen || '', insights: s.insights || '',
        bullets: Array.isArray(s.bullets) ? s.bullets : [],
        action_items: pByConsult[Number(r.id)] || [],
      };
    });
    const hasContent = items.some((x) => x.resumen || x.insights || x.bullets.length || x.action_items.length);
    if (!hasContent) return reply.code(409).send({ error: 'no_content' });

    const from = items[0].date, to = items[items.length - 1].date;
    const out = await consultAiApi.summarize(buildInsightPrompt(items, { from, to }), 2500);
    if (!out.ok) return reply.code(502).send({ error: out.error || 'ai_error' });
    const insight = parseInsightJson(out.text);
    if (!insight) return reply.code(502).send({ error: 'ai_parse' });
    await query(
      `INSERT INTO sales_consult_insights (scope_key, consult_ids, insight_json, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (scope_key) DO UPDATE SET insight_json = $3, created_by = $4, created_at = now()`,
      [key, visibleIds.join(','), JSON.stringify(insight), Number(perm.userId)]);
    await logEvent({ userId: perm.userId, action: 'create', target: `consult_insight:${key}`, detail: { count: visibleIds.length } });
    return { scope_key: key, count: visibleIds.length, insight, cached: false, from, to };
  });

  // ── 스케줄러: 상담 녹음 큐(60초) + 기동 시 스턱 복구 ──
  if (!globalThis.__refatrixConsultRecScheduler) {
    globalThis.__refatrixConsultRecScheduler = setInterval(() => { processQueueTick().catch(() => {}); }, 60000);
    setTimeout(async () => {
      try { await query(`UPDATE sales_consult_recordings SET status='queued' WHERE status IN ('transcribing','summarizing')`); } catch (_) {}
      processQueueTick().catch(() => {});
    }, 20000);
  }
}
