// =====================================================================
// Refatrix ERP · wbrMbrRoutes.js — WBR 저장본 → MBR AI 요약 (보관함)
//   POST   /api/wbr/mbr/summaries      선택 스냅샷을 AI 요약 후 저장 (디렉터 전용)
//   GET    /api/wbr/mbr/summaries      요약 목록(메타만) + ai_enabled ('wbr' 열람)
//   GET    /api/wbr/mbr/summaries/:id  요약 1건 전체 ('wbr' 열람)
//   DELETE /api/wbr/mbr/summaries/:id  삭제 (디렉터 전용)
//
//   ── 안전·격리 원칙(briefingAiRoutes 와 동일) ──
//   · ANTHROPIC_API_KEY 가 설정돼 있어야 생성 가능(없으면 503 no_api_key).
//   · API 로는 스냅샷의 숫자 요약·이슈 텍스트·메모만 압축 전송(사진·토큰·고객DB 원본 미전송).
//   · 모델: WBR_MBR_MODEL 환경변수로 교체 가능. 기본 claude-sonnet-4-5.
// =====================================================================
import { query } from '../db.js';
import { authGuard, requirePage, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { buildMbrPrompt, extractText } from '../mbrSummary.js';
import { gatherMonthly, buildReportKo, buildReportEs } from '../monthlyReport.js';

const MODEL = process.env.WBR_MBR_MODEL || 'claude-sonnet-4-5-20250929';
const MAX_SNAPSHOTS = 12;          // 한 번에 요약할 최대 저장본 수(월간이면 4~5건이 보통)
const MAX_OUTPUT_TOKENS = 3000;
const API_TIMEOUT_MS = 120000;

function aiEnabled() {
  if (process.env.WBR_MBR_ENABLED === '0') return false;
  return !!process.env.ANTHROPIC_API_KEY;
}

async function callAnthropic(prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    const data = await resp.json();
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || ('http_' + resp.status);
      return { ok: false, error: msg };
    }
    return { ok: true, text: extractText(data) };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}

export default async function wbrMbrRoutes(app) {
  // ── 생성: 선택 스냅샷 → AI 요약 → 저장 (디렉터 전용) ──
  app.post('/api/wbr/mbr/summaries', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    if (!aiEnabled()) {
      return reply.code(503).send({ error: 'no_api_key', note: 'Railway 환경변수 ANTHROPIC_API_KEY 를 설정해야 AI 요약을 사용할 수 있습니다.' });
    }
    const b = req.body || {};
    const ids = Array.isArray(b.snapshot_ids)
      ? Array.from(new Set(b.snapshot_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)))
      : [];
    if (!ids.length) return reply.code(400).send({ error: 'no_snapshots' });
    if (ids.length > MAX_SNAPSHOTS) return reply.code(400).send({ error: 'too_many_snapshots', max: MAX_SNAPSHOTS });

    const ph = ids.map((_, i) => '$' + (i + 1)).join(',');
    const rows = (await query(
      `SELECT id, label, data, created_at FROM wbr_snapshots WHERE id IN (${ph})`, ids)).rows;
    if (!rows.length) return reply.code(404).send({ error: 'snapshots_not_found' });
    // 시간순(오래된 → 최신)으로 정렬해 추이가 읽히게 함
    rows.sort((a, c) => new Date(a.created_at) - new Date(c.created_at));

    const snaps = rows.map((r) => ({ id: Number(r.id), label: r.label, data: r.data || {} }));
    const prompt = buildMbrPrompt(snaps);
    const ai = await callAnthropic(prompt);
    if (!ai.ok) return reply.code(502).send({ error: 'ai_failed', detail: ai.error });
    const content = (ai.text || '').trim();
    if (!content) return reply.code(502).send({ error: 'ai_empty' });

    const title = (typeof b.title === 'string' && b.title.trim())
      ? b.title.trim().slice(0, 200)
      : ('MBR 요약 (' + snaps.length + '개 회의)');
    const uid = req.ctx.perm.userId;
    const r = (await query(
      `INSERT INTO wbr_mbr_summaries (title, snapshot_ids, snapshot_labels, model, content_md, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [title, snaps.map((s) => s.id), snaps.map((s) => String(s.label || '').slice(0, 200)), MODEL, content, uid]
    )).rows[0];
    logEvent({ userId: uid, deviceId: req.ctx.deviceId, action: 'wbr_mbr_summary_create', target: `wbr_mbr:${r.id}` });
    return {
      id: Number(r.id), title, model: MODEL, content_md: content,
      snapshot_labels: snaps.map((s) => s.label), created_at: r.created_at,
    };
  });

  // ── 목록(메타만) — 'wbr' 열람 권한. ai_enabled/can_manage 로 프런트 UI 구성 ──
  app.get('/api/wbr/mbr/summaries', { preHandler: [authGuard, requirePage('wbr')] }, async (req) => {
    const rows = (await query(
      `SELECT m.id, m.title, m.snapshot_labels, m.model, m.created_at, u.name AS created_by_name
         FROM wbr_mbr_summaries m
         LEFT JOIN users u ON u.id = m.created_by
        ORDER BY m.created_at DESC`
    )).rows;
    const isDirector = req.ctx.perm.role === 'director';
    return {
      ai_enabled: aiEnabled(),
      can_manage: isDirector,
      items: rows.map((r) => ({
        id: Number(r.id), title: r.title,
        snapshot_labels: Array.isArray(r.snapshot_labels) ? r.snapshot_labels : [],
        model: r.model, created_at: r.created_at, created_by_name: r.created_by_name || null,
      })),
    };
  });

  // ── 1건 전체 — 'wbr' 열람 권한 ──
  app.get('/api/wbr/mbr/summaries/:id', { preHandler: [authGuard, requirePage('wbr')] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(
      `SELECT m.id, m.title, m.snapshot_labels, m.model, m.content_md, m.content_html, m.created_at, u.name AS created_by_name
         FROM wbr_mbr_summaries m LEFT JOIN users u ON u.id = m.created_by
        WHERE m.id=$1`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return {
      id: Number(r.id), title: r.title,
      snapshot_labels: Array.isArray(r.snapshot_labels) ? r.snapshot_labels : [],
      model: r.model, content_md: r.content_md, content_html: r.content_html || null,
      created_at: r.created_at, created_by_name: r.created_by_name || null,
    };
  });

  // ── 형광펜 표시 저장 — 디렉터 전용. content_html(<mark> 포함 렌더 HTML) 저장/해제(null) ──
  app.put('/api/wbr/mbr/summaries/:id/highlights', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {};
    let html = b.content_html;
    if (html != null && typeof html !== 'string') return reply.code(400).send({ error: 'bad_html' });
    if (html != null) {
      if (html.length > 500000) return reply.code(413).send({ error: 'too_large' });
      // 방어: 스크립트/이벤트핸들러 서버측 제거(표시는 <mark> 만 필요)
      html = html.replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
                 .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*\/?\s*>/gi, '')
                 .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
                 .replace(/(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
    }
    const r = (await query(
      `UPDATE wbr_mbr_summaries SET content_html=$1 WHERE id=$2 RETURNING id`, [html || null, id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    logEvent({ userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId, action: 'wbr_mbr_highlight_save', target: `wbr_mbr:${id}` });
    return { ok: true, id };
  });

  // ── 월간 WhatsApp 보고 — 숫자는 SQL 확정치(AI 미사용), 본문 한국어/스페인어 동시 생성 ──
  //   디렉터 전용. ?ym=YYYY-MM. wa.me 원클릭 발송용 텍스트(text_ko/text_es) + 근거 데이터 반환.
  app.get('/api/wbr/mbr/monthly-report', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const ym = String(req.query.ym || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) return reply.code(400).send({ error: 'bad_ym', note: 'ym=YYYY-MM 형식이어야 합니다.' });
    const today = new Date().toISOString().slice(0, 10);
    try {
      const d = await gatherMonthly(query, ym, today);
      logEvent({ userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId, action: 'wbr_monthly_report', target: `wbr_monthly:${ym}` });
      return { ym, data: d, text_ko: buildReportKo(d), text_es: buildReportEs(d) };
    } catch (e) {
      if (e && e.message === 'bad_ym') return reply.code(400).send({ error: 'bad_ym' });
      req.log.error({ err: e }, 'monthly report failed');
      return reply.code(500).send({ error: 'report_failed' });
    }
  });

  // ── 삭제 — 디렉터 전용 ──
  app.delete('/api/wbr/mbr/summaries/:id', { preHandler: [authGuard, requireDirector] }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`DELETE FROM wbr_mbr_summaries WHERE id=$1 RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    logEvent({ userId: req.ctx.perm.userId, deviceId: req.ctx.deviceId, action: 'wbr_mbr_summary_del', target: `wbr_mbr:${id}` });
    return { ok: true, id };
  });
}
