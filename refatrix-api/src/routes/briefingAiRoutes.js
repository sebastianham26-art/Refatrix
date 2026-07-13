// =====================================================================
// Refatrix ERP · briefingAiRoutes.js  (Layer 2 — AI 미결 스캐너, opt-in)
//   GET  /api/portal/pending/ai-scan   자유텍스트에서 미결 액션 후보 감지(제안만)
//   POST /api/portal/pending/ai-todo   제안을 디렉터 확인 후 todo 로 등록
//
//   ── 안전·격리 원칙 ──
//   · 기본 OFF. 환경변수 AI_SCAN_ENABLED='1' + ANTHROPIC_API_KEY 가 있어야 동작.
//   · 켜져 있어도 GET 은 최근 자유텍스트만 최소화해 API 로 보냄(고객 DB·금액 미전송).
//     (자유텍스트 자체에 이름이 있을 수 있음 — 상업용 API 약관: 학습 미사용, ZDR 가능.)
//   · AI 는 "감지·제안"만. 자동 실행 없음. 등록은 디렉터가 명시적으로 눌러야 함.
//   · 디렉터 전용.
// =====================================================================
import { query } from '../db.js';
import { authGuard } from '../middleware/authGuard.js';
import { mxTodayStr } from '../workingHours.js';
import { buildPrompt, parseSuggestions } from '../aiScan.js';

const MODEL = process.env.AI_SCAN_MODEL || 'claude-haiku-4-5-20251001';
const SCAN_DAYS = Number(process.env.AI_SCAN_DAYS) || 14;
const MAX_ITEMS = 60;   // API 로 보낼 최대 텍스트 조각 수(비용·프롬프트 크기 제한)

function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d)); t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

// 최근 자유텍스트 수집(최소화) — 일정 내용 / 회의 메모 / 미완 지시.
async function gatherText(mxToday) {
  const from = shiftYmd(mxToday, -SCAN_DAYS);
  const items = [];
  try {
    const rows = (await query(
      `SELECT id, content, to_char(COALESCE(event_at::date, event_date),'YYYY-MM-DD') AS d
         FROM calendar_events
        WHERE deleted_at IS NULL AND content IS NOT NULL AND content <> ''
          AND COALESCE(event_at::date, event_date) >= $1
        ORDER BY COALESCE(event_at::date, event_date) DESC LIMIT 40`, [from])).rows;
    for (const r of rows) items.push({ ref: `cal:${r.id}`, kind: '일정', date: r.d, text: r.content });
  } catch (_) { /* skip */ }
  try {
    const rows = (await query(
      `SELECT id, note, to_char(meeting_date,'YYYY-MM-DD') AS d
         FROM customer_meetings
        WHERE note IS NOT NULL AND note <> '' AND meeting_date >= $1
        ORDER BY meeting_date DESC LIMIT 40`, [from])).rows;
    for (const r of rows) items.push({ ref: `meet:${r.id}`, kind: '회의', date: r.d, text: r.note });
  } catch (_) { /* skip */ }
  try {
    const rows = (await query(
      `SELECT id, note, to_char(created_at::date,'YYYY-MM-DD') AS d
         FROM customer_directives
        WHERE status <> 'done' AND note IS NOT NULL AND note <> ''
        ORDER BY created_at DESC LIMIT 30`)).rows;
    for (const r of rows) items.push({ ref: `dir:${r.id}`, kind: '지시', date: r.d, text: r.note });
  } catch (_) { /* skip */ }
  return items.slice(0, MAX_ITEMS);
}

export default async function briefingAiRoutes(app) {
  // ── AI 스캔(제안만) — 켜져 있고 키 있을 때만 ──
  app.get('/api/portal/pending/ai-scan', { preHandler: [authGuard] }, async (req) => {
    const perm = req.ctx.perm;
    if (perm.role !== 'director') return { enabled: false, reason: 'director_only' };
    if (process.env.AI_SCAN_ENABLED !== '1') return { enabled: false, reason: 'disabled' };
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return { enabled: false, reason: 'no_api_key' };

    const mxToday = mxTodayStr(new Date());
    const items = await gatherText(mxToday);
    if (!items.length) return { enabled: true, scanned: 0, suggestions: [] };

    const prompt = buildPrompt(items);
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await resp.json();
      const txt = (data && Array.isArray(data.content))
        ? data.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
      const suggestions = parseSuggestions(txt, items);
      return { enabled: true, model: MODEL, scanned: items.length, suggestions };
    } catch (e) {
      return { enabled: true, error: true, scanned: items.length, suggestions: [] };
    }
  });

  // ── AI 제안 → 할 일 등록(디렉터 확인) ──
  app.post('/api/portal/pending/ai-todo', { preHandler: [authGuard] }, async (req, reply) => {
    const perm = req.ctx.perm;
    if (perm.role !== 'director') return reply.code(403).send({ error: 'director_only' });
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return reply.code(400).send({ error: 'title_required' });
    const detail = (String(b.detail || '').slice(0, 500)) || null;
    const mxToday = mxTodayStr(new Date());
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due_date)) ? b.due_date : mxToday;
    const tr = (await query(
      `INSERT INTO todos (title, detail, assignee_id, due_date, kind, scope, level, created_by)
       VALUES ($1,$2,$3,$4,'ai_suggest','user','self',$3) RETURNING id`,
      [title.slice(0, 200), detail, perm.userId, due])).rows[0];
    return { ok: true, todo_id: Number(tr.id) };
  });
}
