// =====================================================================
// Refatrix ERP · quoteWaRoutes.js — 견적·매출 추적 › 신규 견적 WhatsApp 알림 (0256)
//   전부 디렉터 전용. 발송 로직은 src/quoteWaNotify.js.
//
//   GET    /api/quote-wa/recipients          수신자 + 24시간 창 + 팀 목록
//   POST   /api/quote-wa/recipients          {name, phone, lang, team_ids[], month_summary: full|no_profit|off}
//   PATCH  /api/quote-wa/recipients/:id      부분 수정(active · team_ids 포함)
//   DELETE /api/quote-wa/recipients/:id      삭제(소프트)
//   GET    /api/quote-wa/status              설정 상태 + 최근 발송 원장(실제 전달 상태)
//   GET    /api/quote-wa/preview?quote_id&lang&summary   보낼 문구(없으면 가장 최근 견적) + 당월 요약(0257)
//   POST   /api/quote-wa/send {quote_id?, recipient_id?}   지금 발송(수동 — 성공 이력 무시)
// =====================================================================
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { waApiReady, normalizeWaNumber } from '../waSend.js';
import { webhookConfigured, explainWaError } from '../waWebhook.js';
import {
  loadQuoteForNotify, buildQuoteText, buildQuoteHeadline, sendQuoteTo, recipientCovers, maskPhone,
  quoteWaEnabled, quoteWaTemplate, quoteWaTemplateLang, MAX_ATTEMPTS, LOOKBACK_HOURS,
  SUMMARY_LEVELS, levelOf, monthSummaryFor, buildMonthSummaryText,
} from '../quoteWaNotify.js';

const G = { preHandler: [authGuard, requireDirector] };
const LANGS = ['ko', 'es'];

const teamIdsOf = (v) => {
  if (v == null) return null;
  const a = (Array.isArray(v) ? v : [v]).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  return a.length ? [...new Set(a)] : null;
};
function recipOut(r) {
  return { id: Number(r.id), name: r.name, phone: r.phone, phone_masked: maskPhone(r.phone), lang: r.lang,
    team_ids: Array.isArray(r.team_ids) ? r.team_ids.map(Number) : [], active: r.active === true, created_at: r.created_at,
    month_summary: levelOf(r) };
}
async function latestQuoteId() {
  const r = (await query(`SELECT id FROM quotes WHERE deleted_at IS NULL AND status NOT IN ('pricelist','cancelled')
                           ORDER BY created_at DESC, id DESC LIMIT 1`)).rows[0];
  return r ? Number(r.id) : null;
}

export default async function quoteWaRoutes(app) {
  app.get('/api/quote-wa/recipients', G, async () => {
    let rows;
    try {
      rows = (await query(
        `SELECT r.*, i.last_at AS inbound_at, (i.last_at > now() - interval '24 hours') AS window_open
           FROM quote_wa_recipients r LEFT JOIN wa_inbound i ON i.wa_from = r.phone
          WHERE r.deleted_at IS NULL ORDER BY r.id`)).rows;
    } catch { rows = (await query(`SELECT * FROM quote_wa_recipients WHERE deleted_at IS NULL ORDER BY id`)).rows; }
    const teams = (await query(`SELECT id, name FROM sales_teams WHERE deleted_at IS NULL ORDER BY sort_order, id`)).rows
      .map((t) => ({ id: Number(t.id), name: t.name }));
    const hook = webhookConfigured();
    return { items: rows.map((r) => ({ ...recipOut(r), inbound_at: r.inbound_at || null,
      window_open: hook ? r.window_open === true : null })), teams, webhook: hook };
  });

  app.post('/api/quote-wa/recipients', G, async (req, reply) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    const phone = normalizeWaNumber(b.phone);
    if (!name) return reply.code(400).send({ error: 'name_required' });
    if (!phone) return reply.code(400).send({ error: 'bad_phone' });
    const lang = LANGS.includes(b.lang) ? b.lang : 'ko';
    const dup = (await query(`SELECT id FROM quote_wa_recipients WHERE phone=$1 AND deleted_at IS NULL`, [phone])).rows[0];
    if (dup) return reply.code(409).send({ error: 'duplicate_phone', id: Number(dup.id) });
    if (b.month_summary != null && !SUMMARY_LEVELS.includes(b.month_summary)) return reply.code(400).send({ error: 'bad_month_summary' });
    const r = (await query(
      `INSERT INTO quote_wa_recipients (name, phone, lang, team_ids, month_summary, created_by) VALUES ($1,$2,$3,$4::bigint[],$5,$6) RETURNING *`,
      [name, phone, lang, teamIdsOf(b.team_ids), b.month_summary || 'full', req.ctx.perm.userId])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `quote_wa_recipient:${r.id}`, detail: { to: maskPhone(phone) } });
    return recipOut(r);
  });

  app.patch('/api/quote-wa/recipients/:id', G, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {};
    const sets = []; const args = [];
    const put = (col, v, cast = '') => { args.push(v); sets.push(`${col}=$${args.length}${cast}`); };
    if (b.name != null) { const nm = String(b.name).trim().slice(0, 80); if (!nm) return reply.code(400).send({ error: 'name_required' }); put('name', nm); }
    if (b.phone != null) {
      const p = normalizeWaNumber(b.phone); if (!p) return reply.code(400).send({ error: 'bad_phone' });
      const dup = (await query(`SELECT id FROM quote_wa_recipients WHERE phone=$1 AND deleted_at IS NULL AND id<>$2`, [p, id])).rows[0];
      if (dup) return reply.code(409).send({ error: 'duplicate_phone', id: Number(dup.id) });
      put('phone', p);
    }
    if (b.lang != null) { if (!LANGS.includes(b.lang)) return reply.code(400).send({ error: 'bad_lang' }); put('lang', b.lang); }
    if ('team_ids' in b) put('team_ids', teamIdsOf(b.team_ids), '::bigint[]');
    if (typeof b.active === 'boolean') put('active', b.active);
    if (b.month_summary != null) { if (!SUMMARY_LEVELS.includes(b.month_summary)) return reply.code(400).send({ error: 'bad_month_summary' }); put('month_summary', b.month_summary); }
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    args.push(id);
    const r = (await query(`UPDATE quote_wa_recipients SET ${sets.join(', ')}, updated_at=now()
                             WHERE id=$${args.length} AND deleted_at IS NULL RETURNING *`, args)).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return recipOut(r);
  });

  app.delete('/api/quote-wa/recipients/:id', G, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`UPDATE quote_wa_recipients SET deleted_at=now(), active=false WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `quote_wa_recipient:${id}` });
    return { ok: true };
  });

  app.get('/api/quote-wa/status', G, async () => {
    const SEL = `SELECT s.quote_id, q.quote_no, COALESCE(c.name, q.guest_name) AS customer_name, s.recipient_id, r.name,
                        s.to_masked, s.status, s.error, s.attempts, s.sent_at, s.updated_at`;
    const FROM = `FROM quote_wa_sends s JOIN quotes q ON q.id = s.quote_id LEFT JOIN customers c ON c.id = q.customer_id
                  LEFT JOIN quote_wa_recipients r ON r.id = s.recipient_id`;
    let rows;
    try {
      rows = (await query(
        `${SEL}, m.status AS dlv_status, m.delivered_at, m.read_at, m.failed_at, m.error_code AS dlv_code,
                 m.error_title AS dlv_title, m.error_detail AS dlv_detail
           ${FROM} LEFT JOIN wa_message_status m ON m.message_id = s.message_id
          ORDER BY s.updated_at DESC LIMIT 40`)).rows;
    } catch { rows = (await query(`${SEL} ${FROM} ORDER BY s.updated_at DESC LIMIT 40`)).rows; }
    return {
      enabled: quoteWaEnabled(), api_ready: waApiReady(), template: quoteWaTemplate(), template_lang: quoteWaTemplateLang(),
      template_set: !!process.env.QUOTE_WA_TEMPLATE,
      webhook: webhookConfigured(), max_attempts: MAX_ATTEMPTS, lookback_hours: LOOKBACK_HOURS,
      recent: rows.map((x) => {
        const o = { ...x, quote_id: Number(x.quote_id), recipient_id: Number(x.recipient_id), attempts: Number(x.attempts) };
        if (x.dlv_status === 'failed') o.dlv_reason = explainWaError(x.dlv_code, x.dlv_title) + (x.dlv_detail ? ` — ${x.dlv_detail}` : '');
        return o;
      }),
    };
  });

  app.get('/api/quote-wa/preview', G, async (req, reply) => {
    const id = Number(req.query.quote_id) || await latestQuoteId();
    if (!id) return reply.code(404).send({ error: 'no_quote' });
    const qt = await loadQuoteForNotify(id);
    if (!qt) return reply.code(404).send({ error: 'not_found' });
    const lang = LANGS.includes(req.query.lang) ? req.query.lang : 'ko';
    const level = SUMMARY_LEVELS.includes(req.query.summary) ? req.query.summary : 'full';
    let text = buildQuoteText(qt, lang); let summary = null;
    if (level !== 'off') {   // 미리보기 = 전사 범위(팀 범위 수신자는 그 팀 숫자로 나간다)
      summary = await monthSummaryFor({ team_ids: null });
      const add = buildMonthSummaryText(summary, lang, level); if (add) text += '\n\n' + add;
    }
    return { quote_id: qt.id, quote_no: qt.quote_no, lang, summary_level: level, text, headline: buildQuoteHeadline(qt, lang), quote: qt,
      month: summary ? summary.ym : null };
  });

  // 수동 발송 — 견적 미지정이면 가장 최근 견적. 수신자 미지정이면 그 견적 범위에 드는 사용 중 수신자 전부.
  app.post('/api/quote-wa/send', G, async (req, reply) => {
    const b = req.body || {};
    if (!waApiReady()) return reply.code(400).send({ error: 'wa_not_configured' });
    const id = Number(b.quote_id) || await latestQuoteId();
    if (!id) return reply.code(404).send({ error: 'no_quote' });
    const qt = await loadQuoteForNotify(id);
    if (!qt || qt.deleted) return reply.code(404).send({ error: 'not_found' });
    let rc;
    if (b.recipient_id) {
      const r = (await query(`SELECT id, name, phone, lang, team_ids, created_at, month_summary FROM quote_wa_recipients WHERE id=$1 AND deleted_at IS NULL`, [Number(b.recipient_id)])).rows[0];
      if (!r) return reply.code(404).send({ error: 'recipient_not_found' });
      rc = [r];
    } else {
      rc = (await query(`SELECT id, name, phone, lang, team_ids, created_at, month_summary FROM quote_wa_recipients WHERE active AND deleted_at IS NULL ORDER BY id`)).rows
        .filter((r) => recipientCovers(r, qt));
      if (!rc.length) return reply.code(400).send({ error: 'no_recipients' });
    }
    const results = []; const summaryCache = {};
    for (const r of rc) results.push({ name: r.name, ...(await sendQuoteTo(qt, r, { force: true, summaryCache })) });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `quote:${qt.id}`, detail: { quote_wa_manual_send: results.length } });
    return { quote_no: qt.quote_no, results };
  });
}
