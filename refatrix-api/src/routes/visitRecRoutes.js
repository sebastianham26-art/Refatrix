// =====================================================================
// Refatrix ERP · visitRecRoutes.js — 방문 상담 녹음 파이프라인 + 영업사원 아침 브리핑
//   (디렉터 요청 2026-08-03)
//
//   ① 상담 녹음: 방문 체크인(sales_visits) 뒤 화면에서 녹음 → 업로드(queued)
//      → 백그라운드 처리: Whisper 전사(transcribing) → Claude 분류 요약(summarizing)
//      → done: 방문 talk_note/insight_note 에 [AI요약] 블록 병합 + action_items 를
//        sales_visit_pendings 에 자동 등록 + 자동 생성 미팅기록([현장방문]) 노트 갱신.
//      처리 성공 시 오디오 원본은 기본 폐기(VISIT_KEEP_AUDIO=1 시 보존).
//
//   ② 아침 브리핑: users.wa_phone 이 설정된 사용자에게 매일 MX 아침(기본 07시)
//      스페인어 WhatsApp 브리핑 — 오늘 일정 · 방문 펜딩(연체/오늘/3일 내) ·
//      ERP 할일 · 어제 방문 요약(녹음 AI 요약 헤드라인).
//      하루 1회 가드(sales_briefing_sends UNIQUE) · 실패 5분 재시도 최대 5회.
//
//   ── 환경변수 ──
//   · OPENAI_API_KEY          Whisper 전사(필수 — 없으면 녹음 처리 실패 안내)
//   · ANTHROPIC_API_KEY       Claude 요약(기존 키 공용)
//   · VISIT_STT_MODEL         기본 whisper-1
//   · VISIT_AI_MODEL          기본 claude-sonnet-4-5-20250929
//   · VISIT_KEEP_AUDIO=1      전사 후 오디오 원본 보존(기본 폐기)
//   · VISIT_REC_ENABLED=0     녹음 기능 끄기
//   · SALES_BRIEFING_HOUR     발송 시각(MX, 기본 7)
//   · SALES_BRIEFING_ENABLED=0  브리핑 끄기
//   · WHATSAPP_TOKEN / WHATSAPP_PHONE_ID  (기존 공용) — 없으면 브리핑 무동작
// =====================================================================
import { query, withTx } from '../db.js';
import { authGuard, requirePage, requirePageEdit, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { mxTodayStr, MX_OFFSET_MIN } from '../workingHours.js';
import { sendWaTo, waApiReady, normalizeWaNumber } from '../waSend.js';
import {
  clip, buildSummaryPrompt, parseSummaryJson, summaryToNotes, mergeNote,
  buildBriefingText, briefingHeadline, esDateLabel,
} from '../visitAi.js';

const STT_MODEL = () => process.env.VISIT_STT_MODEL || 'whisper-1';
const AI_MODEL = () => process.env.VISIT_AI_MODEL || 'claude-sonnet-4-5-20250929';
const KEEP_AUDIO = () => process.env.VISIT_KEEP_AUDIO === '1';
const BRIEF_HOUR = () => Number(process.env.SALES_BRIEFING_HOUR || 7);

const AUDIO_B64_MAX = 34 * 1024 * 1024;   // base64 문자 길이 ≈ 25MB 바이너리(Whisper 한도)
const DURATION_MAX = 2 * 3600;            // 2시간
const TRANSCRIPT_PROMPT_MAX = 24000;      // Claude 프롬프트에 넣는 전사문 최대 길이
const STT_TIMEOUT_MS = 300000;            // 긴 녹음 대비 5분
const AI_TIMEOUT_MS = 120000;
const MAX_AUTO_ATTEMPTS = 3;              // 일시 오류 자동 재시도 상한
const BRIEF_MAX_ATTEMPTS = 5;

export function recEnabled() { return process.env.VISIT_REC_ENABLED !== '0'; }
export function sttReady() { return !!process.env.OPENAI_API_KEY; }
export function aiReady() { return !!process.env.ANTHROPIC_API_KEY; }
export function briefingEnabled() { return process.env.SALES_BRIEFING_ENABLED !== '0' && waApiReady(); }

// ── 날짜 헬퍼(dailyBriefingRoutes 와 동일 규칙) ──
function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
function d10(v) { if (!v) return null; if (v instanceof Date) return v.toISOString().slice(0, 10); return String(v).slice(0, 10); }
function mxDateOf(iso) {
  if (!iso) return null;
  const t = new Date(iso); if (isNaN(t.getTime())) return null;
  return new Date(t.getTime() + MX_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}
function mxHmOf(iso) {
  if (!iso) return null;
  const t = new Date(iso); if (isNaN(t.getTime())) return null;
  const m = new Date(t.getTime() + MX_OFFSET_MIN * 60000);
  return String(m.getUTCHours()).padStart(2, '0') + ':' + String(m.getUTCMinutes()).padStart(2, '0');
}
function mxNowParts() {
  const m = new Date(Date.now() + MX_OFFSET_MIN * 60000);
  return { ymd: m.toISOString().slice(0, 10), hour: m.getUTCHours() };
}
function daysBetween(aYmd, bYmd) {
  if (!aYmd || !bYmd) return 0;
  const [ay, am, ad] = String(aYmd).split('-').map(Number);
  const [by, bm, bd] = String(bYmd).split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

// ── 외부 API 호출(테스트에서 모킹 가능하도록 export) ──
export const ai = {
  // Whisper 전사: base64 → multipart(FormData) → text
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
  // Claude 요약(dailySummaryRoutes 와 동일 패턴)
  async summarize(prompt) {
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
        body: JSON.stringify({ model: AI_MODEL(), max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
        signal: ctrl.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = (data && data.error && data.error.message) || ('http_' + resp.status);
        return { ok: false, error: 'ai: ' + String(msg).slice(0, 250), transient: resp.status >= 500 || resp.status === 429 };
      }
      const txt = (data && Array.isArray(data.content))
        ? data.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
      return { ok: true, text: txt };
    } catch (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? 'ai: timeout' : 'ai: network', transient: true };
    } finally { clearTimeout(timer); }
  },
};

// =====================================================================
// 녹음 처리 큐 (단일 인스턴스 순차 처리)
// =====================================================================
let processing = false;

async function claimNext() {
  // 2단계 클레임(단일 인스턴스 전제 · status 가드로 이중 처리 방지)
  const next = (await query(
    `SELECT id FROM sales_visit_recordings WHERE status='queued' ORDER BY id LIMIT 1`)).rows[0];
  if (!next) return null;
  const row = (await query(
    `UPDATE sales_visit_recordings
        SET status='transcribing', attempts = attempts + 1
      WHERE id = $1 AND status='queued'
      RETURNING id, visit_id, mode, mime, audio_b64, transcript, duration_sec, created_by, attempts`,
    [Number(next.id)])).rows[0];
  return row || null;
}

async function markFailed(id, error, transient, attempts) {
  // 일시 오류(network/timeout/5xx)는 상한 내에서 자동 재큐 — 그 외/상한 초과는 failed(수동 재시도)
  const requeue = transient && Number(attempts) < MAX_AUTO_ATTEMPTS;
  await query(
    `UPDATE sales_visit_recordings SET status=$2, error=$3 WHERE id=$1`,
    [id, requeue ? 'queued' : 'failed', String(error || 'error').slice(0, 400)]);
}

export async function processOne(row) {
  const recId = Number(row.id);
  if (!aiReady()) return markFailed(recId, 'no_anthropic_key', false, row.attempts);

  // 방문·고객 컨텍스트
  const v = (await query(
    `SELECT v.id, v.visit_date, v.place_name, v.met_person, v.talk_note, v.insight_note, v.meeting_id,
            c.name AS customer_name
       FROM sales_visits v LEFT JOIN customers c ON c.id = v.customer_id
      WHERE v.id = $1 AND v.deleted_at IS NULL`, [row.visit_id])).rows[0];
  if (!v) return markFailed(recId, 'visit_not_found', false, row.attempts);

  // ① 전사(이미 전사돼 있으면 건너뜀 — 요약 단계 재시도 시 STT 비용 없음)
  let transcript = String(row.transcript || '').trim();
  if (!transcript) {
    if (!sttReady()) return markFailed(recId, 'no_openai_key', false, row.attempts);
    if (!row.audio_b64) return markFailed(recId, 'no_audio', false, row.attempts);
    const st = await ai.transcribe({ b64: row.audio_b64, mime: row.mime });
    if (!st.ok) return markFailed(recId, st.error, st.transient, row.attempts);
    transcript = st.text;
    if (!transcript) return markFailed(recId, 'empty_transcript', false, row.attempts);
    await query(
      `UPDATE sales_visit_recordings
          SET transcript=$2, status='summarizing', error=NULL,
              audio_b64 = CASE WHEN $3 THEN audio_b64 ELSE NULL END
        WHERE id=$1`, [recId, transcript, KEEP_AUDIO()]);
  } else {
    await query(`UPDATE sales_visit_recordings SET status='summarizing', error=NULL WHERE id=$1`, [recId]);
  }

  // ② Claude 분류 요약
  const prompt = buildSummaryPrompt({
    transcript: clip(transcript, TRANSCRIPT_PROMPT_MAX),
    customerName: v.customer_name, placeName: v.place_name, metPerson: v.met_person,
    visitDate: d10(v.visit_date), mode: row.mode,
  });
  const sm = await ai.summarize(prompt);
  if (!sm.ok) return markFailed(recId, sm.error, sm.transient, row.attempts);
  const summary = parseSummaryJson(sm.text);
  if (!summary) return markFailed(recId, 'ai_parse', false, row.attempts);

  // ③ 반영(트랜잭션): 요약 저장 + 방문 노트 병합 + 펜딩 자동 등록 + 자동 미팅 노트 갱신
  const notes = summaryToNotes(summary);
  await withTx(async (client) => {
    const q = client.query.bind(client);
    await q(
      `UPDATE sales_visit_recordings
          SET status='done', summary_json=$2, error=NULL, processed_at=now()
        WHERE id=$1`, [recId, JSON.stringify(summary)]);
    const newTalk = mergeNote(v.talk_note, notes.talkAppend);
    const newInsight = mergeNote(v.insight_note, notes.insightAppend);
    await q(`UPDATE sales_visits SET talk_note=$2, insight_note=$3 WHERE id=$1`, [v.id, newTalk, newInsight]);
    for (const it of summary.action_items) {
      await q(`INSERT INTO sales_visit_pendings (visit_id, content, due_date) VALUES ($1,$2,$3)`,
        [v.id, it.content, it.due_date]);
    }
    if (v.meeting_id) {
      // 자동 생성 미팅([현장방문] 프리픽스)만 갱신 — 수기 미팅 보호. mergeNote 가 기존 AI 블록을 교체.
      const mrow = (await q(`SELECT note FROM customer_meetings WHERE id=$1`, [v.meeting_id])).rows[0];
      if (mrow && String(mrow.note || '').startsWith('[현장방문]')) {
        const meetAdd = [notes.talkAppend,
          summary.insights ? ('파악: ' + summary.insights) : '',
          summary.action_items.length ? ('펜딩: ' + summary.action_items.map((x) => x.content).join(' · ')) : '']
          .filter(Boolean).join(' / ');
        await q(`UPDATE customer_meetings SET note=$2 WHERE id=$1`,
          [v.meeting_id, mergeNote(mrow.note, clip(meetAdd, 3000))]);
      }
    }
  });
  await logEvent({ userId: Number(row.created_by), action: 'update', target: `visit_recording:${recId}`,
    detail: { visit_id: Number(v.id), action_items: summary.action_items.length } });
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
      try { await processOne(row); } catch (e) { await markFailed(Number(row.id), 'internal: ' + String(e && e.message).slice(0, 200), false, row.attempts).catch(() => {}); }
      n++;
    }
  } finally { processing = false; }
  return n;
}

// =====================================================================
// 아침 브리핑 데이터 수집·발송
// =====================================================================
export async function collectBriefingData(userId) {
  const u = (await query(`SELECT id, name, team_id, wa_phone FROM users WHERE id=$1 AND deleted_at IS NULL`, [userId])).rows[0];
  if (!u) return null;
  const mxToday = mxTodayStr(new Date());
  const mxYesterday = shiftYmd(mxToday, -1);
  const to3 = shiftYmd(mxToday, 3);

  // ① 오늘 일정(회사 + 내 팀 + 개인 + 나에게 공유). tz 경계 대비 ±1일 조회 후 MX 필터.
  const evParams = [userId, shiftYmd(mxToday, -1), shiftYmd(mxToday, 1)];
  let teamCond = 'FALSE';
  if (u.team_id != null) { evParams.push(Number(u.team_id)); teamCond = `(e.scope='team' AND e.team_id=$${evParams.length})`; }
  const evRows = (await query(
    `SELECT e.event_date, e.event_time, e.event_at, e.content
       FROM calendar_events e
      WHERE e.deleted_at IS NULL AND e.event_date >= $2 AND e.event_date <= $3
        AND ( e.scope='company' OR ${teamCond}
           OR (e.scope='personal' AND (e.created_by=$1 OR e.owner_id=$1))
           OR (e.scope='shared' AND (e.created_by=$1 OR e.id IN (
                 SELECT t.event_id FROM calendar_event_targets t WHERE t.user_id=$1))) )
      ORDER BY e.id`, evParams)).rows;
  const schedule = [];
  for (const r of evRows) {
    const iso = r.event_at ? new Date(r.event_at).toISOString() : null;
    const dkey = iso ? mxDateOf(iso) : d10(r.event_date);
    if (dkey !== mxToday) continue;
    schedule.push({ time: iso ? mxHmOf(iso) : (r.event_time ? String(r.event_time).slice(0, 5) : null), content: r.content || '' });
  }
  schedule.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

  // ② 방문 펜딩(미완료) — 연체 / 오늘 / 3일 내
  const pRows = (await query(
    `SELECT p.content, p.due_date, v.place_name
       FROM sales_visit_pendings p JOIN sales_visits v ON v.id = p.visit_id
      WHERE v.deleted_at IS NULL AND v.created_by = $1 AND p.done = FALSE AND p.due_date IS NOT NULL
        AND p.due_date <= $2
      ORDER BY p.due_date ASC, p.id ASC LIMIT 60`, [userId, to3])).rows;
  const pendings = { overdue: [], today: [], upcoming: [] };
  for (const r of pRows) {
    const due = d10(r.due_date);
    const item = { content: r.content, due_date: due, place: r.place_name, overdue: 0 };
    const diff = daysBetween(mxToday, due);
    if (diff > 0) { item.overdue = diff; pendings.overdue.push(item); }
    else if (diff === 0) pendings.today.push(item);
    else pendings.upcoming.push(item);
  }

  // ③ ERP 할일(open · 나에게 배정 · 3일 내 마감 또는 연체)
  let todos = [];
  try {
    const tRows = (await query(
      `SELECT t.title, t.due_date FROM todos t
        WHERE t.deleted_at IS NULL AND t.status='open' AND t.due_date IS NOT NULL AND t.due_date <= $2
          AND (t.assignee_id = $1 OR t.id IN (SELECT a.todo_id FROM todo_assignees a WHERE a.user_id=$1))
        ORDER BY t.due_date ASC LIMIT 20`, [userId, to3])).rows;
    todos = tRows.map((r) => ({ title: r.title, due_date: d10(r.due_date), overdue: daysBetween(mxToday, d10(r.due_date)) > 0 }));
  } catch (_) { /* todos 스키마 부재 시 무시 */ }

  // ④ 어제 방문(녹음 AI 요약 헤드라인 우선, 없으면 수기 대화 노트)
  const vRows = (await query(
    `SELECT v.id, v.place_name, v.talk_note
       FROM sales_visits v
      WHERE v.deleted_at IS NULL AND v.created_by = $1 AND v.visit_date = $2
      ORDER BY v.visited_at ASC LIMIT 20`, [userId, mxYesterday])).rows;
  const sjByVisit = {};
  if (vRows.length) {
    try {
      const recRows = (await query(
        `SELECT id, visit_id, summary_json FROM sales_visit_recordings
          WHERE status='done' AND visit_id = ANY($1) ORDER BY id ASC`,
        [vRows.map((r) => Number(r.id))])).rows;
      for (const r of recRows) sjByVisit[Number(r.visit_id)] = r.summary_json;  // 마지막(최신) 것이 남음
    } catch (_) { /* 0165 미적용 시 무시 */ }
  }
  const yesterdayVisits = vRows.map((r) => {
    let resumen = null;
    const sj = sjByVisit[Number(r.id)];
    if (sj) { try { const s = typeof sj === 'string' ? JSON.parse(sj) : sj; resumen = s && s.resumen; } catch (_) {} }
    return { place: r.place_name, resumen: resumen || clip(r.talk_note, 150) || null };
  });

  return { userId: Number(u.id), name: u.name, wa_phone: u.wa_phone || null, mxToday, schedule, pendings, todos, yesterdayVisits };
}

export async function runSalesBriefingJob({ force = false, userId = null } = {}) {
  if (!force && !briefingEnabled()) return { skipped: 'disabled' };
  const mxToday = mxTodayStr(new Date());
  const params = [];
  let cond = `u.deleted_at IS NULL AND u.wa_phone IS NOT NULL AND u.wa_phone <> ''`;
  if (userId) { params.push(Number(userId)); cond += ` AND u.id = $${params.length}`; }
  const users = (await query(`SELECT u.id FROM users u WHERE ${cond} ORDER BY u.id`, params)).rows;
  const results = [];
  for (const row of users) {
    const uid = Number(row.id);
    const prev = (await query(
      `SELECT id, status, attempts FROM sales_briefing_sends WHERE user_id=$1 AND brief_date=$2`, [uid, mxToday])).rows[0];
    if (!force && prev && (prev.status === 'sent_text' || prev.status === 'sent_template')) { results.push({ user_id: uid, skipped: 'already_sent' }); continue; }
    if (!force && prev && Number(prev.attempts) >= BRIEF_MAX_ATTEMPTS) { results.push({ user_id: uid, skipped: 'max_attempts' }); continue; }

    const data = await collectBriefingData(uid);
    if (!data) { results.push({ user_id: uid, skipped: 'no_user' }); continue; }
    const to = normalizeWaNumber(data.wa_phone);
    if (!to) {
      await upsertSend(uid, mxToday, 'failed', 'bad_number');
      results.push({ user_id: uid, error: 'bad_number' }); continue;
    }
    const out = await sendWaTo({ to, text: buildBriefingText(data), headline: briefingHeadline(data) });
    if (out.ok) {
      await upsertSend(uid, mxToday, out.mode === 'template' ? 'sent_template' : 'sent_text', null);
      results.push({ user_id: uid, ok: true, mode: out.mode });
    } else {
      await upsertSend(uid, mxToday, 'failed', out.error);
      results.push({ user_id: uid, error: out.error });
    }
  }
  return { date: mxToday, results };
}

async function upsertSend(userId, briefDate, status, error) {
  await query(
    `INSERT INTO sales_briefing_sends (user_id, brief_date, status, error, attempts, sent_at)
     VALUES ($1,$2,$3,$4,1, CASE WHEN $3 LIKE 'sent%' THEN now() ELSE NULL END)
     ON CONFLICT (user_id, brief_date) DO UPDATE SET
       status=$3, error=$4, attempts=sales_briefing_sends.attempts+1,
       sent_at=CASE WHEN $3 LIKE 'sent%' THEN now() ELSE sales_briefing_sends.sent_at END`,
    [userId, briefDate, status, error ? String(error).slice(0, 400) : null]);
}

// =====================================================================
// 라우트
// =====================================================================
export default async function visitRecRoutes(app) {
  // 소유 확인(본인 방문 또는 디렉터)
  async function ownVisit(perm, visitId) {
    const params = [Number(visitId)];
    let cond = 'v.id = $1 AND v.deleted_at IS NULL';
    if (perm.role !== 'director') { params.push(perm.userId); cond += ` AND v.created_by = $${params.length}`; }
    return (await query(`SELECT v.id, v.created_by FROM sales_visits v WHERE ${cond}`, params)).rows[0] || null;
  }

  // ── 녹음 업로드 → 큐 등록 ──
  app.post('/api/visits/:id/recordings',
    { bodyLimit: 48 * 1024 * 1024, preHandler: [authGuard, requirePageEdit('pipeline')] },
    async (req, reply) => {
      const perm = req.ctx.perm;
      if (!recEnabled()) return reply.code(503).send({ error: 'rec_disabled' });
      const v = await ownVisit(perm, req.params.id);
      if (!v) return reply.code(404).send({ error: 'not_found' });
      const b = req.body || {};
      const m = /^data:((?:audio|video)\/[\w.+-]+)(?:;codecs=[^;]*)?;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data_url || ''));
      if (!m) return reply.code(400).send({ error: 'bad_audio' });
      const mime = m[1], b64 = m[2];
      if (b64.length > AUDIO_B64_MAX) return reply.code(400).send({ error: 'too_large', max_mb: 25 });
      const dur = Number(b.duration_sec) || null;
      if (dur && dur > DURATION_MAX) return reply.code(400).send({ error: 'too_long', max_sec: DURATION_MAX });
      const mode = b.mode === 'full' ? 'full' : 'memo';
      const r = (await query(
        `INSERT INTO sales_visit_recordings (visit_id, mode, mime, duration_sec, size_bytes, audio_b64, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [Number(v.id), mode, mime, dur, Math.round(b64.length * 3 / 4), b64, perm.userId])).rows[0];
      await logEvent({ userId: perm.userId, action: 'create', target: `visit_recording:${r.id}`,
        detail: { visit_id: Number(v.id), mode, duration_sec: dur } });
      setTimeout(() => { processQueueTick().catch(() => {}); }, 100);
      return { id: Number(r.id), status: 'queued', stt_ready: sttReady(), ai_ready: aiReady() };
    });

  // ── 방문의 녹음 목록·상태(폴링용) ──
  app.get('/api/visits/:id/recordings', { preHandler: [authGuard, requirePage('pipeline')] }, async (req, reply) => {
    const v = await ownVisit(req.ctx.perm, req.params.id);
    if (!v) return reply.code(404).send({ error: 'not_found' });
    const rows = (await query(
      `SELECT id, mode, mime, duration_sec, size_bytes, status, error, attempts, transcript, summary_json, created_at, processed_at
         FROM sales_visit_recordings WHERE visit_id=$1 ORDER BY id DESC`, [Number(v.id)])).rows;
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
  app.post('/api/visits/recordings/:id/retry', { preHandler: [authGuard, requirePageEdit('pipeline')] }, async (req, reply) => {
    const perm = req.ctx.perm;
    const id = Number(req.params.id);
    const params = [id];
    let cond = 'r.id=$1';
    if (perm.role !== 'director') { params.push(perm.userId); cond += ` AND v.created_by = $${params.length}`; }
    const row = (await query(
      `SELECT r.id, r.status FROM sales_visit_recordings r JOIN sales_visits v ON v.id=r.visit_id
        WHERE ${cond} AND v.deleted_at IS NULL`, params)).rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.status !== 'failed') return reply.code(409).send({ error: 'not_failed', status: row.status });
    await query(`UPDATE sales_visit_recordings SET status='queued', error=NULL WHERE id=$1`, [id]);
    setTimeout(() => { processQueueTick().catch(() => {}); }, 100);
    return { ok: true, id, status: 'queued' };
  });

  // ── 아침 브리핑 미리보기(본인 · 디렉터는 ?user_id=) ──
  app.get('/api/visits/briefing/preview', { preHandler: [authGuard, requirePage('pipeline')] }, async (req, reply) => {
    const perm = req.ctx.perm;
    let uid = perm.userId;
    if (req.query.user_id) {
      if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
      uid = Number(req.query.user_id);
    }
    const data = await collectBriefingData(uid);
    if (!data) return reply.code(404).send({ error: 'not_found' });
    return {
      user_id: data.userId, name: data.name, mx_today: data.mxToday, date_label: esDateLabel(data.mxToday),
      wa_phone_set: !!data.wa_phone, wa_enabled: briefingEnabled(), hour: BRIEF_HOUR(),
      text: buildBriefingText(data),
      counts: {
        schedule: data.schedule.length,
        pend_overdue: data.pendings.overdue.length, pend_today: data.pendings.today.length,
        pend_upcoming: data.pendings.upcoming.length, todos: data.todos.length,
        yesterday_visits: data.yesterdayVisits.length,
      },
    };
  });

  // ── 브리핑 즉시 발송(테스트) — 본인 또는 디렉터 지정 ──
  app.post('/api/visits/briefing/send', { preHandler: [authGuard, requirePageEdit('pipeline')] }, async (req, reply) => {
    const perm = req.ctx.perm;
    let uid = perm.userId;
    const b = req.body || {};
    if (b.user_id) {
      if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
      uid = Number(b.user_id);
    }
    if (!waApiReady()) return reply.code(503).send({ error: 'wa_not_configured' });
    const out = await runSalesBriefingJob({ force: true, userId: uid });
    await logEvent({ userId: perm.userId, action: 'create', target: `sales_briefing:${uid}` });
    return out;
  });

  // ── 브리핑 발송 현황(디렉터) ──
  app.get('/api/visits/briefing/status', { preHandler: [authGuard, requireDirector] }, async () => {
    const mxToday = mxTodayStr(new Date());
    const users = (await query(
      `SELECT id, name, wa_phone FROM users
        WHERE deleted_at IS NULL AND wa_phone IS NOT NULL AND wa_phone <> '' ORDER BY name`)).rows;
    const sends = (await query(
      `SELECT s.user_id, u.name, s.brief_date, s.status, s.error, s.attempts, s.sent_at
         FROM sales_briefing_sends s JOIN users u ON u.id = s.user_id
        WHERE s.brief_date >= $1 ORDER BY s.brief_date DESC, u.name`, [shiftYmd(mxToday, -7)])).rows;
    return {
      enabled: briefingEnabled(), wa_ready: waApiReady(), hour: BRIEF_HOUR(),
      stt_ready: sttReady(), ai_ready: aiReady(),
      recipients: users.map((u) => {
        const p = String(u.wa_phone);
        return { id: Number(u.id), name: u.name, wa_masked: p.length > 6 ? p.slice(0, 3) + '****' + p.slice(-4) : '****' };
      }),
      sends: sends.map((s) => ({
        user_id: Number(s.user_id), name: s.name, brief_date: d10(s.brief_date),
        status: s.status, error: s.error, attempts: Number(s.attempts), sent_at: s.sent_at,
      })),
    };
  });

  // ── 스케줄러: 녹음 큐(60초) + 아침 브리핑(5분, MX BRIEF_HOUR 이후) + 기동 시 스턱 복구 ──
  if (!globalThis.__refatrixVisitRecScheduler) {
    globalThis.__refatrixVisitRecScheduler = setInterval(() => { processQueueTick().catch(() => {}); }, 60000);
    setTimeout(async () => {
      // 서버 재시작으로 중간에 멈춘 건 재큐(단일 인스턴스 전제 — 부팅 시점엔 진행 중 건 없음)
      try { await query(`UPDATE sales_visit_recordings SET status='queued' WHERE status IN ('transcribing','summarizing')`); } catch (_) {}
      processQueueTick().catch(() => {});
    }, 15000);
  }
  if (!globalThis.__refatrixSalesBriefingScheduler) {
    const tick = async () => {
      if (!briefingEnabled()) return;
      if (mxNowParts().hour < BRIEF_HOUR()) return;
      await runSalesBriefingJob({});
    };
    globalThis.__refatrixSalesBriefingScheduler = setInterval(() => { tick().catch(() => {}); }, 300000);
    setTimeout(() => { tick().catch(() => {}); }, 25000);
  }
}
