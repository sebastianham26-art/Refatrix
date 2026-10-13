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
// =====================================================================
import { query } from '../db.js';
import { authGuard, requirePageAny, requirePageEditAny } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import {
  metaLeadsConfigured, metaTokenSource, metaPageId, resolvePage, syncMetaLeads, syncState, reextractAll,
} from '../metaLeads.js';
import { META_STATES } from '../metaLeadExtract.js';

// 제품·마케팅 그룹 화면들이 쓰는 권한키 — refatrix-nav.js 의 metaleads 와 같은 목록(제품 · 마케팅 · 가격 마스터 · 개발 요청(견적 · 영업 포함))
export const PM_KEYS = ['products', 'marketing', 'pricemaster', 'devrequest', 'quote', 'sales'];
const R = { preHandler: [authGuard, requirePageAny(PM_KEYS)] };
const W = { preHandler: [authGuard, requirePageEditAny(PM_KEYS)] };
const STATUSES = ['nuevo', 'contactado', 'derivado', 'venta', 'descartado'];
const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const ymd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null;

const COLS = `t.id, t.platform, t.thread_id, COALESCE(t.m_name, t.name) AS name, t.username, t.first_at, t.last_at, t.last_in_at, t.msg_count, t.in_count,
  COALESCE(t.m_tipo, t.a_tipo) AS tipo, t.a_tipo_btn AS tipo_btn, COALESCE(t.m_state, t.a_state) AS state, COALESCE(t.m_city, t.a_city) AS city,
  COALESCE(t.m_phone, t.a_phone) AS phone, t.a_email AS email, COALESCE(t.m_vehicles, t.a_vehicles) AS vehicles, COALESCE(t.m_parts, t.a_parts) AS parts,
  t.a_intent AS intent, t.status, t.derived_to, t.note,
  (t.m_name IS NOT NULL OR t.m_tipo IS NOT NULL OR t.m_state IS NOT NULL OR t.m_city IS NOT NULL OR t.m_phone IS NOT NULL OR t.m_vehicles IS NOT NULL OR t.m_parts IS NOT NULL) AS edited,
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
          count(*) FILTER (WHERE COALESCE(m_parts, a_parts) IS NOT NULL OR COALESCE(m_vehicles, a_vehicles) IS NOT NULL)::int AS demand,
          count(*) FILTER (WHERE COALESCE(m_state, a_state) IS NOT NULL)::int AS with_state,
          count(*) FILTER (WHERE COALESCE(m_phone, a_phone) IS NOT NULL)::int AS with_phone,
          count(*) FILTER (WHERE status='nuevo')::int AS nuevo
        FROM meta_threads`)).rows[0];
      last = (await query(`SELECT id, started_at, finished_at, trigger, full_scan, ok, threads, inserted, by_platform, error FROM meta_sync_runs ORDER BY id DESC LIMIT 1`)).rows[0] || null;
      lastOk = (await query(`SELECT max(finished_at) AS t FROM meta_sync_runs WHERE ok = true`)).rows[0].t || null;
    } catch (_) { return { configured: metaLeadsConfigured(), migrated: false }; }
    return { configured: metaLeadsConfigured(), migrated: true, token_source: metaTokenSource(), page_id: metaPageId(), page, page_error: pageError, page_warning: pageWarning,
      running: syncState.running, progress: syncState.running ? syncState.progress : null, counts, last_run: last, last_ok_at: lastOk,
      auto: process.env.META_LEADS_AUTO !== '0', states: META_STATES };
  });

  app.post('/api/meta-leads/sync', W, async (req, reply) => {
    if (!metaLeadsConfigured()) return reply.code(400).send({ error: 'no_token' });
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
    if (kw) { const p = add('%' + kw + '%'); conds.push(`(COALESCE(t.m_name,t.name) ILIKE ${p} OR t.customer_text ILIKE ${p} OR t.note ILIKE ${p} OR COALESCE(t.m_phone,t.a_phone) ILIKE ${p})`); }
    if (['messenger', 'instagram'].includes(req.query.platform)) conds.push(`t.platform = ${add(req.query.platform)}`);
    if (req.query.state === '__none') conds.push(`COALESCE(t.m_state,t.a_state) IS NULL`);
    else if (req.query.state) conds.push(`COALESCE(t.m_state,t.a_state) = ${add(String(req.query.state))}`);
    if (req.query.tipo) conds.push(`COALESCE(t.m_tipo,t.a_tipo,t.a_tipo_btn) ILIKE ${add('%' + String(req.query.tipo) + '%')}`);
    if (STATUSES.includes(req.query.status)) conds.push(`t.status = ${add(req.query.status)}`);
    if (req.query.demand === '1') conds.push(`(COALESCE(t.m_parts,t.a_parts) IS NOT NULL OR COALESCE(t.m_vehicles,t.a_vehicles) IS NOT NULL)`);
    if (ymd(req.query.from)) conds.push(`(t.last_at AT TIME ZONE 'America/Mexico_City')::date >= ${add(req.query.from)}::date`);
    if (ymd(req.query.to)) conds.push(`(t.last_at AT TIME ZONE 'America/Mexico_City')::date <= ${add(req.query.to)}::date`);
    const limit = Math.min(Number(req.query.limit) || 5000, 10000);
    const rows = (await query(`SELECT ${COLS}, left(t.customer_text, 600) AS customer_text FROM meta_threads t WHERE ${conds.join(' AND ')}
                               ORDER BY t.last_at DESC NULLS LAST LIMIT ${limit}`, args)).rows;
    return { items: rows.map((r) => ({ ...r, id: Number(r.id) })) };
  });

  app.get('/api/meta-leads/:id', R, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`SELECT ${COLS}, t.messages, t.a_tipo, t.a_state, t.a_city, t.a_phone, t.a_vehicles, t.a_parts, t.name AS meta_name FROM meta_threads t WHERE t.id = $1`, [id])).rows[0];
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
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    put('updated_by', req.ctx.perm.userId);
    const r = (await query(`UPDATE meta_threads SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`, args)).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const out = (await query(`SELECT ${COLS} FROM meta_threads t WHERE t.id = $1`, [id])).rows[0];
    return { ...out, id: Number(out.id) };
  });

  app.post('/api/meta-leads/reextract', W, async () => ({ updated: await reextractAll() }));
}
