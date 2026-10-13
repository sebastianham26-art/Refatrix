// =====================================================================
// Refatrix ERP · metaLeadsRoutes.js — 제품·마케팅 › Meta 광고 문의 (0270)
//   2026-10-13 디렉터 지시: 「제품·마케팅」 메뉴에 들어갈 수 있는 사람은 모두 본다 —
//   그 그룹 화면들의 권한키(PM_KEYS) 중 하나라도 있으면 열람, 그중 하나라도 edit 면 상태 · 메모 · 가져오기. 로직은 src/metaLeads.js.
//
//   GET   /api/meta-leads/status                 토큰 · 페이지 · 마지막 가져오기 · 건수
//   POST  /api/meta-leads/sync {full}            지금 가져오기(백그라운드) — 진행은 status 로
//   GET   /api/meta-leads/list?q&platform&state&tipo&status&demand&from&to   목록(대화 본문 제외)
//   GET   /api/meta-leads/:id                    한 건 + 대화
//   PATCH /api/meta-leads/:id {name,tipo,state,city,phone,vehicles,parts,status,derived_to,note}  사람이 고친 값
//   POST  /api/meta-leads/reextract              저장된 대화에 추출 규칙 다시 적용
//   POST  /api/meta-leads/match {all,id}         0272 · 차종·부품 → CTR 부품번호 × 수량(규칙 + AI) — 진행은 status.match
//   PATCH /api/meta-leads/:id {items:"CQ0271L 2\n…"}  0272 · 사람이 고친 부품번호 × 수량(빈 문자열 = 자동값)
// =====================================================================
import { query } from '../db.js';
import { authGuard, requirePageAny, requirePageEditAny } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import {
  metaLeadsConfigured, metaTokenSource, metaPageId, resolvePage, syncMetaLeads, syncState, reextractAll, internalWaPhones, importWaAppThreads,
} from '../metaLeads.js';
import { META_STATES } from '../metaLeadExtract.js';
import { aiReady, aiModel, aiState, analyzeThreads } from '../metaLeadsAi.js';
import { matchThreads, matchState, kickMatch, parseManualItems } from '../metaLeadsMatch.js';

// 제품·마케팅 그룹 화면들이 쓰는 권한키 — refatrix-nav.js 의 metaleads 와 같은 목록(제품 · 마케팅 · 가격 마스터 · 개발 요청(견적 · 영업 포함))
export const PM_KEYS = ['products', 'marketing', 'pricemaster', 'devrequest', 'quote', 'sales'];
const R = { preHandler: [authGuard, requirePageAny(PM_KEYS)] };
const W = { preHandler: [authGuard, requirePageEditAny(PM_KEYS)] };
const STATUSES = ['nuevo', 'contactado', 'derivado', 'venta', 'descartado'];
const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const ymd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null;

const COLS = `t.id, t.platform, t.thread_id, CASE WHEN t.thread_id LIKE 'wab:%' THEN 'wa_app' END AS source, COALESCE(t.m_name, t.name) AS name, t.username, t.first_at, t.last_at, t.last_in_at, t.msg_count, t.in_count,
  -- 0271 · 우선순위: 사람(m_) > AI(ai_) > 규칙(a_)
  COALESCE(t.m_tipo, t.ai_tipo, t.a_tipo) AS tipo, CASE WHEN t.m_tipo IS NOT NULL THEN 'manual' WHEN t.ai_tipo IS NOT NULL THEN t.ai_tipo_src ELSE NULL END AS tipo_src,
  t.a_tipo_btn AS tipo_btn, COALESCE(t.m_state, t.ai_state, t.a_state) AS state, COALESCE(t.m_city, t.ai_city, t.a_city) AS city,
  COALESCE(t.m_phone, t.ai_phone, t.a_phone) AS phone, t.a_email AS email,
  COALESCE(t.m_vehicles, t.ai_vehicles, t.a_vehicles) AS vehicles, COALESCE(t.m_parts, t.ai_parts, t.a_parts) AS parts,
  CASE WHEN t.m_vehicles IS NULL AND t.m_parts IS NULL THEN t.ai_demand END AS demand,
  COALESCE(t.ai_intent, t.a_intent) AS intent, t.ai_summary AS summary, (t.ai_at IS NOT NULL AND t.ai_error IS NULL AND t.ai_hash IS NOT NULL) AS ai_done,
  -- 0272 · CTR 부품번호 × 수량: 사람 > 자동(규칙 · AI)
  COALESCE(t.m_items, t.ai_items) AS items, (t.m_items IS NOT NULL) AS items_manual, t.items_error,
  t.status, t.derived_to, t.note,
  (t.m_items IS NOT NULL OR t.m_name IS NOT NULL OR t.m_tipo IS NOT NULL OR t.m_state IS NOT NULL OR t.m_city IS NOT NULL OR t.m_phone IS NOT NULL OR t.m_vehicles IS NOT NULL OR t.m_parts IS NOT NULL) AS edited,
  to_char(t.last_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') AS last_mx,
  to_char(t.first_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS first_mx`;

export default async function metaLeadsRoutes(app) {
  app.get('/api/meta-leads/status', R, async () => {
    let page = null, pageError = null, pageWarning = null;
    if (metaLeadsConfigured()) { const p = await resolvePage(); if (p.error) pageError = p.error; else { page = p.page; pageWarning = p.warning || null; } }
    let counts = null, last = null, lastOk = null;
    try {
      counts = (await query(`SELECT count(*)::int AS total,
          count(*) FILTER (WHERE platform='messenger')::int AS messenger, count(*) FILTER (WHERE platform='instagram')::int AS instagram,
          count(*) FILTER (WHERE platform='whatsapp')::int AS whatsapp,
          count(*) FILTER (WHERE COALESCE(m_parts, ai_parts, a_parts) IS NOT NULL OR COALESCE(m_vehicles, ai_vehicles, a_vehicles) IS NOT NULL)::int AS demand,
          count(*) FILTER (WHERE COALESCE(m_state, ai_state, a_state) IS NOT NULL)::int AS with_state,
          count(*) FILTER (WHERE COALESCE(m_phone, ai_phone, a_phone) IS NOT NULL)::int AS with_phone,
          count(*) FILTER (WHERE COALESCE(m_tipo, ai_tipo, a_tipo) IS NOT NULL)::int AS with_tipo,
          count(*) FILTER (WHERE status='nuevo')::int AS nuevo,
          count(*) FILTER (WHERE ai_at IS NOT NULL AND ai_error IS NULL)::int AS ai_done,
          count(*) FILTER (WHERE in_count > 0 AND (ai_at IS NULL OR ai_error IS NOT NULL))::int AS ai_pending,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(m_items, ai_items, '[]'::jsonb)) e WHERE e->>'status' = 'ok'))::int AS with_code
        FROM meta_threads`)).rows[0];
      last = (await query(`SELECT id, started_at, finished_at, trigger, full_scan, ok, threads, inserted, by_platform, error FROM meta_sync_runs ORDER BY id DESC LIMIT 1`)).rows[0] || null;
      lastOk = (await query(`SELECT max(finished_at) AS t FROM meta_sync_runs WHERE ok = true`)).rows[0].t || null;
    } catch (_) { return { configured: metaLeadsConfigured(), migrated: false }; }
    // 2026-10-13 · WhatsApp(ERP 번호) 진단 — 「안 들어온다」 때 어디서 막혔는지(받은 메시지 없음 / 전부 사내 번호 / 가져오기 대기)
    let wa = null;
    try {
      const r = (await query(`SELECT m.phone, max(m.at) FILTER (WHERE m.direction = 'in') AS last_in, bool_or(t.id IS NOT NULL) AS listed
                                FROM wa_messages m LEFT JOIN meta_threads t ON t.thread_id = 'wa:' || m.phone
                               GROUP BY m.phone HAVING bool_or(m.direction = 'in')`)).rows;
      const skip = await internalWaPhones();
      const ext = r.filter((x) => !skip.has(x.phone));
      const last = r.reduce((a, x) => (x.last_in && (!a || new Date(x.last_in) > new Date(a)) ? x.last_in : a), null);
      const outN = (await query(`SELECT count(*)::int n FROM wa_messages WHERE direction = 'out'`)).rows[0].n;
      wa = { in_phones: r.length, internal: r.length - ext.length, customers: ext.length, listed: ext.filter((x) => x.listed).length, last_in_at: last, out_msgs: outN };
    } catch (_) { wa = null; }
    return { configured: metaLeadsConfigured(), migrated: true, wa, token_source: metaTokenSource(), page_id: metaPageId(), page, page_error: pageError, page_warning: pageWarning,
      running: syncState.running, progress: syncState.running ? syncState.progress : null, counts, last_run: last, last_ok_at: lastOk,
      auto: process.env.META_LEADS_AUTO !== '0', states: META_STATES,
      ai: { ready: aiReady(), model: aiModel(), running: aiState.running, done: aiState.done, total: aiState.total, errors: aiState.errors, last_error: aiState.last_error, finished_at: aiState.finished_at },
      match: { running: matchState.running, done: matchState.done, total: matchState.total, ai_calls: matchState.ai_calls, errors: matchState.errors, last_error: matchState.last_error, finished_at: matchState.finished_at } };
  });

  app.post('/api/meta-leads/sync', W, async (req, reply) => {
    if (syncState.running) return reply.code(409).send({ error: 'already_running', progress: syncState.progress });
    const full = !!(req.body && req.body.full);
    syncMetaLeads({ full, trigger: 'manual', userId: req.ctx.perm.userId })
      .catch((e) => app.log.warn({ err: String(e && e.message) }, '[meta-leads] sync failed'));
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'meta_leads_sync', detail: { full } });
    return { started: true };
  });

  app.get('/api/meta-leads/list', R, async (req) => {
    const args = []; const conds = ['true'];
    const add = (v) => { args.push(v); return '$' + args.length; };
    const kw = String(req.query.q || '').trim();
    if (kw) { const p = add('%' + kw + '%'); conds.push(`(COALESCE(t.m_name,t.name) ILIKE ${p} OR t.customer_text ILIKE ${p} OR t.note ILIKE ${p} OR COALESCE(t.m_phone,t.ai_phone,t.a_phone) ILIKE ${p} OR t.ai_summary ILIKE ${p} OR COALESCE(t.m_vehicles,t.ai_vehicles,t.a_vehicles) ILIKE ${p} OR COALESCE(t.m_parts,t.ai_parts,t.a_parts) ILIKE ${p})`); }
    if (['messenger', 'instagram', 'whatsapp'].includes(req.query.platform)) conds.push(`t.platform = ${add(req.query.platform)}`);
    if (req.query.state === '__none') conds.push(`COALESCE(t.m_state,t.ai_state,t.a_state) IS NULL`);
    else if (req.query.state) conds.push(`COALESCE(t.m_state,t.ai_state,t.a_state) = ${add(String(req.query.state))}`);
    if (req.query.tipo) conds.push(`COALESCE(t.m_tipo,t.ai_tipo,t.a_tipo,t.a_tipo_btn) ILIKE ${add('%' + String(req.query.tipo) + '%')}`);
    if (STATUSES.includes(req.query.status)) conds.push(`t.status = ${add(req.query.status)}`);
    if (req.query.demand === '1') conds.push(`(COALESCE(t.m_parts,t.ai_parts,t.a_parts) IS NOT NULL OR COALESCE(t.m_vehicles,t.ai_vehicles,t.a_vehicles) IS NOT NULL)`);
    if (ymd(req.query.from)) conds.push(`(t.last_at AT TIME ZONE 'America/Mexico_City')::date >= ${add(req.query.from)}::date`);
    if (ymd(req.query.to)) conds.push(`(t.last_at AT TIME ZONE 'America/Mexico_City')::date <= ${add(req.query.to)}::date`);
    const limit = Math.min(Number(req.query.limit) || 5000, 10000);
    const rows = (await query(`SELECT ${COLS}, left(t.customer_text, 600) AS customer_text FROM meta_threads t WHERE ${conds.join(' AND ')}
                               ORDER BY t.last_at DESC NULLS LAST LIMIT ${limit}`, args)).rows;
    // 0272 · 나온 부품번호의 현재고(요약 · 엑셀의 「재고」)
    const codes = [...new Set(rows.flatMap((r) => (Array.isArray(r.items) ? r.items : []).map((i) => i && i.code).filter(Boolean)))];
    const stock = {};
    if (codes.length) for (const p of (await query(`SELECT code, stock_qty FROM products WHERE code = ANY($1) AND deleted_at IS NULL`, [codes])).rows) stock[p.code] = Number(p.stock_qty) || 0;
    return { items: rows.map((r) => ({ ...r, id: Number(r.id) })), stock };
  });

  app.get('/api/meta-leads/:id', R, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`SELECT ${COLS}, t.messages, COALESCE(t.ai_tipo, t.a_tipo) AS a_tipo, COALESCE(t.ai_state, t.a_state) AS a_state, COALESCE(t.ai_city, t.a_city) AS a_city, COALESCE(t.ai_phone, t.a_phone) AS a_phone, COALESCE(t.ai_vehicles, t.a_vehicles) AS a_vehicles, COALESCE(t.ai_parts, t.a_parts) AS a_parts, t.name AS meta_name, t.ai_error FROM meta_threads t WHERE t.id = $1`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return { ...r, id: Number(r.id) };
  });

  app.patch('/api/meta-leads/:id', W, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {}; const sets = []; const args = [id];
    const put = (col, v) => { args.push(v); sets.push(`${col} = $${args.length}`); };
    // 빈 문자열 = 자동값으로 되돌리기(NULL)
    const MAP = { name: 'm_name', tipo: 'm_tipo', state: 'm_state', city: 'm_city', phone: 'm_phone', vehicles: 'm_vehicles', parts: 'm_parts', derived_to: 'derived_to', note: 'note' };
    for (const [k, col] of Object.entries(MAP)) {
      if (b[k] === undefined) continue;
      const v = b[k] == null ? null : String(b[k]).trim().slice(0, k === 'note' ? 2000 : 300);
      put(col, v || null);
    }
    if (b.status !== undefined) { if (!STATUSES.includes(b.status)) return reply.code(400).send({ error: 'bad_status' }); put('status', b.status); }
    let unknown = [];
    if (b.items !== undefined) {           // 0272 · 「코드 수량」 줄 — 빈 값이면 자동값으로
      const txt = b.items == null ? '' : String(b.items).slice(0, 4000);
      const r = txt.trim() ? await parseManualItems(txt) : { items: null, unknown: [] };
      if (r.unknown.length && !(r.items && r.items.length)) return reply.code(400).send({ error: 'unknown_codes', unknown: r.unknown });
      unknown = r.unknown; args.push(r.items ? JSON.stringify(r.items) : null); sets.push(`m_items = $${args.length}::jsonb`);
    }
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    put('updated_by', req.ctx.perm.userId);
    const r = (await query(`UPDATE meta_threads SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`, args)).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (b.vehicles !== undefined || b.parts !== undefined) matchThreads({ ids: [id] }).catch(() => {});   // 차종 · 부품을 고치면 부품번호 다시
    const out = (await query(`SELECT ${COLS} FROM meta_threads t WHERE t.id = $1`, [id])).rows[0];
    return { ...out, id: Number(out.id), unknown_codes: unknown };
  });

  app.post('/api/meta-leads/reextract', W, async () => ({ updated: await reextractAll() }));

  // 0271 · AI 분석 — all=true 면 전체 다시(규칙 · 모델 바꾼 뒤), 아니면 새로 바뀐 대화만. 백그라운드 — 진행은 status.ai
  app.post('/api/meta-leads/ai', W, async (req, reply) => {
    if (!aiReady()) return reply.code(400).send({ error: 'ai_not_configured' });
    if (aiState.running) return reply.code(409).send({ error: 'already_running' });
    const all = !!(req.body && req.body.all); const id = idOf(req.body && req.body.id);
    analyzeThreads({ all, ids: id ? [id] : null }).catch((e) => app.log.warn({ err: String(e && e.message) }, '[meta-leads] ai failed'));
    return { started: true };
  });

  // 0272 · 부품번호 매칭 — all=true 면 전부 다시(카탈로그 바뀐 뒤), id 면 한 건. 백그라운드(줄 세움) — 진행은 status.match
  app.post('/api/meta-leads/match', W, async (req) => {
    const all = !!(req.body && req.body.all); const id = idOf(req.body && req.body.id);
    if (id) { await matchThreads({ ids: [id] }); const out = (await query(`SELECT ${COLS} FROM meta_threads t WHERE t.id = $1`, [id])).rows[0]; return out ? { ...out, id: Number(out.id) } : { error: 'not_found' }; }
    if (all) matchThreads({ all: true }).catch((e) => app.log.warn({ err: String(e && e.message) }, '[meta-leads] match failed'));
    else kickMatch(app.log);
    return { started: true };
  });

  // 2026-10-13 · WhatsApp 앱 번호(8118250003) 대화 파일 올리기 {threads:[{phone,name,key,messages:[{at,me,text}]}]}
  app.post('/api/meta-leads/import-wa-app', { ...W, bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const th = req.body && req.body.threads;
    if (!Array.isArray(th) || !th.length) return reply.code(400).send({ error: 'no_threads' });
    const r = await importWaAppThreads(th);
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'meta_leads_import_wa_app', detail: r });
    return r;
  });
}
