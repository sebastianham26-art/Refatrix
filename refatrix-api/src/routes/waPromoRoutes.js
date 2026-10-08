// =====================================================================
// Refatrix ERP · waPromoRoutes.js — 제품·마케팅 › WhatsApp 마케팅 (0260)
//   열람 requirePage('marketing') · 쓰기 requirePageEdit('marketing'). 로직은 src/waPromo.js.
//
//   연락처
//   GET    /api/wa-promo/contacts?q&consent&limit        목록 + 상태별 건수
//   POST   /api/wa-promo/contacts {name, phone, memo}    1건 추가
//   POST   /api/wa-promo/contacts/bulk {rows, dry_run}   엑셀 대량(미리보기 → 저장)
//   PATCH  /api/wa-promo/contacts/:id                    이름·메모·동의(영업 확인)·담당·메모·처리 상태
//   DELETE /api/wa-promo/contacts/:id                    삭제(소프트)
//   POST   /api/wa-promo/consent/ask {ids?}              동의 요청 대기열(미확인만 · 1회)
//   GET    /api/wa-promo/survey-sources                  설문 + 이름/전화 문항 추정
//   POST   /api/wa-promo/survey-import {survey_id, name_k, phone_k, company_k?, dry_run}
//   발송 일정
//   GET    /api/wa-promo/campaigns?from&to               일정(이미지 제외) + 결과 집계
//   POST   /api/wa-promo/campaigns {send_at | send_now, caption, image_b64·image_mime·image_name | from_campaign_id, memo_filter, contact_ids?}
//            contact_ids(0261) = 고른 연락처 중 ✅ 동의자에게만 · from_campaign_id = 지난 발송 이미지 다시 쓰기
//   GET    /api/wa-promo/campaigns/recent-images         다시 쓸 이미지 목록(최근 발송)
//   PATCH  /api/wa-promo/campaigns/:id                   예약 상태만 수정 · DELETE = 취소
//   GET    /api/wa-promo/campaigns/:id/image             이미지
//   GET    /api/wa-promo/campaigns/:id/sends             발송 원장(실제 전달 상태)
//   POST   /api/wa-promo/campaigns/:id/test {phone}      한 번호로 시험 발송(동의·상한 무시)
//   받은 메시지
//   GET    /api/wa-promo/conversations?state&assignee    대화 목록(번호별 마지막 메시지)
//   GET    /api/wa-promo/conversations/:phone            대화 내용
//   POST   /api/wa-promo/conversations/:phone/reply {text}   직접 답장(24시간 창 안)
//   POST   /api/wa-promo/conversations/:phone/contact {name} 미등록 번호를 연락처로
//   GET    /api/wa-promo/messages/export?from&to&state   엑셀용 원자료
//   자동응답
//   GET/POST /api/wa-promo/autoreplies · PATCH/DELETE /api/wa-promo/autoreplies/:id
//   설정
//   GET    /api/wa-promo/status                          상한 · 템플릿 · 웹훅 · 품질(가능하면)
//   GET    /api/wa-promo/users                           담당자 선택용
// =====================================================================
import { query } from '../db.js';
import { authGuard, requirePage, requirePageEdit } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { normalizeWaNumber, waApiReady } from '../waSend.js';
import { explainWaError } from '../waWebhook.js';
import {
  promoCfg, promoReady, insertContacts, classifyRows, queueConsentAsk, sentToday, audienceCount,
  sendCampaignTo, manualReply, maskPhone, MAX_IMAGE_BYTES, uploadCampaignImage, targetIdsOf,
} from '../waPromo.js';

const R = { preHandler: [authGuard, requirePage('marketing')] };
const W = { preHandler: [authGuard, requirePageEdit('marketing')] };
const IMG_LIMIT = { preHandler: [authGuard, requirePageEdit('marketing')], bodyLimit: 9 * 1024 * 1024 };
const IMG_MIMES = ['image/jpeg', 'image/png'];
const CONSENTS = ['unknown', 'asked', 'yes', 'no'];
const ACTIONS = ['none', 'consent_yes', 'consent_no', 'lead'];
const idOf = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const localMx = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(s || ''));   // 멕시코 시각 'YYYY-MM-DDTHH:MM'
const MXT = (expr) => `to_char(${expr} AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD"T"HH24:MI')`;

function contactOut(r) {
  return { id: Number(r.id), name: r.name, phone: r.phone, phone_masked: maskPhone(r.phone), memo: r.memo || null,
    source: r.source, source_ref: r.source_ref || null, consent: r.consent, consent_at: r.consent_at || null, consent_via: r.consent_via || null,
    ask_queued: !!r.ask_queued_at && !r.asked_at, asked_at: r.asked_at || null, ask_error: r.ask_error || null,
    inbox_state: r.inbox_state, lead: r.lead === true, assigned_to: r.assigned_to != null ? Number(r.assigned_to) : null,
    assigned_name: r.assigned_name || null, note: r.note || null, last_in_at: r.last_in_at || null, last_out_at: r.last_out_at || null,
    created_at: r.created_at };
}
function dlv(x) {
  const o = { dlv_status: x.dlv_status || null, delivered_at: x.delivered_at || null, read_at: x.read_at || null };
  if (x.dlv_status === 'failed') o.dlv_reason = explainWaError(x.dlv_code, x.dlv_title) + (x.dlv_detail ? ` — ${x.dlv_detail}` : '');
  return o;
}
const DLV_JOIN = (alias) => `LEFT JOIN wa_message_status m ON m.message_id = ${alias}`;
const DLV_COLS = `m.status AS dlv_status, m.delivered_at, m.read_at, m.error_code AS dlv_code, m.error_title AS dlv_title, m.error_detail AS dlv_detail`;

export default async function waPromoRoutes(app) {
  // ───────── 연락처 ─────────
  app.get('/api/wa-promo/contacts', R, async (req) => {
    const args = []; const conds = ['w.deleted_at IS NULL'];
    const kw = String(req.query.q || '').trim();
    if (kw) { args.push('%' + kw + '%'); const d = kw.replace(/\D/g, ''); conds.push(`(w.name ILIKE $${args.length} OR w.memo ILIKE $${args.length}${d.length >= 3 ? ` OR w.phone LIKE '%${d}%'` : ''})`); }
    if (CONSENTS.includes(req.query.consent)) { args.push(req.query.consent); conds.push(`w.consent = $${args.length}`); }
    if (req.query.queued === '1') conds.push(`w.ask_queued_at IS NOT NULL AND w.asked_at IS NULL`);
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const rows = (await query(
      `SELECT w.*, u.name AS assigned_name FROM wa_contacts w LEFT JOIN users u ON u.id = w.assigned_to
        WHERE ${conds.join(' AND ')} ORDER BY w.created_at DESC, w.id DESC LIMIT ${limit}`, args)).rows;
    const counts = (await query(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE consent='yes')::int yes, count(*) FILTER (WHERE consent='asked')::int asked,
              count(*) FILTER (WHERE consent='unknown')::int unknown, count(*) FILTER (WHERE consent='no')::int no,
              count(*) FILTER (WHERE consent='unknown' AND ask_queued_at IS NOT NULL AND asked_at IS NULL)::int queued,
              count(*) FILTER (WHERE inbox_state='open')::int inbox_open
         FROM wa_contacts WHERE deleted_at IS NULL`)).rows[0];
    return { items: rows.map(contactOut), counts };
  });

  app.post('/api/wa-promo/contacts', W, async (req, reply) => {
    const b = req.body || {};
    const r = await insertContacts([{ name: b.name, phone: b.phone, memo: b.memo }], { source: 'manual', userId: req.ctx.perm.userId });
    const row = r.rows[0];
    if (row.status === 'bad_phone') return reply.code(400).send({ error: 'bad_phone' });
    if (row.status === 'no_name') return reply.code(400).send({ error: 'name_required' });
    if (row.status === 'exists') return reply.code(409).send({ error: 'duplicate_phone', existing: row.existing });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `wa_contact:${row.id}`, detail: { to: maskPhone(row.phone) } });
    return { id: row.id, phone: row.phone };
  });

  app.post('/api/wa-promo/contacts/bulk', W, async (req, reply) => {
    const b = req.body || {};
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 5000) : [];
    if (!rows.length) return reply.code(400).send({ error: 'no_rows' });
    if (b.dry_run !== false) {
      const cls = await classifyRows(rows);
      return { dry_run: true, rows: cls, summary: summarize(cls) };
    }
    const r = await insertContacts(rows, { source: 'excel', userId: req.ctx.perm.userId });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: 'wa_contacts:bulk', detail: { added: r.added, rows: rows.length } });
    return { dry_run: false, added: r.added, rows: r.rows, summary: summarize(r.rows) };
  });

  app.patch('/api/wa-promo/contacts/:id', W, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {}; const sets = []; const args = [];
    const put = (sql, v) => { args.push(v); sets.push(sql.replace('?', '$' + args.length)); };
    if (b.name != null) { const n = String(b.name).trim().slice(0, 120); if (!n) return reply.code(400).send({ error: 'name_required' }); put('name=?', n); }
    if (b.memo !== undefined) put('memo=?', String(b.memo || '').trim().slice(0, 300) || null);
    if (b.note !== undefined) put('note=?', String(b.note || '').trim().slice(0, 1000) || null);
    if (b.phone != null) {
      const p = normalizeWaNumber(b.phone); if (!p) return reply.code(400).send({ error: 'bad_phone' });
      const dup = (await query(`SELECT id FROM wa_contacts WHERE phone=$1 AND deleted_at IS NULL AND id<>$2`, [p, id])).rows[0];
      if (dup) return reply.code(409).send({ error: 'duplicate_phone' });
      put('phone=?', p);
    }
    if (b.consent != null) {
      if (!CONSENTS.includes(b.consent) || b.consent === 'asked') return reply.code(400).send({ error: 'bad_consent' });
      // 본인이 버튼·메시지로 수신거부한 사람은 사람이 되돌릴 수 없다(본인이 다시 「Sí, quiero」를 보내면 자동으로 동의)
      if (b.consent === 'yes') {
        const cur = (await query(`SELECT consent, consent_via FROM wa_contacts WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
        if (cur && cur.consent === 'no' && ['button', 'message'].includes(cur.consent_via)) return reply.code(409).send({ error: 'opted_out' });
      }
      put('consent=?', b.consent);
      sets.push('consent_at=now()'); put('consent_via=?', b.consent === 'unknown' ? null : 'sales'); put('consent_by=?', req.ctx.perm.userId);
      if (b.consent !== 'unknown') sets.push('ask_queued_at=NULL');
    }
    if (b.assigned_to !== undefined) put('assigned_to=?', b.assigned_to ? idOf(b.assigned_to) : null);
    if (b.inbox_state != null) { if (!['none', 'open', 'done'].includes(b.inbox_state)) return reply.code(400).send({ error: 'bad_state' }); put('inbox_state=?', b.inbox_state); }
    if (typeof b.lead === 'boolean') put('lead=?', b.lead);
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    args.push(id);
    const r = (await query(`UPDATE wa_contacts SET ${sets.join(', ')}, updated_at=now() WHERE id=$${args.length} AND deleted_at IS NULL RETURNING *`, args)).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (b.consent != null) await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `wa_contact:${id}`, detail: { consent: b.consent, via: 'sales' } });
    return contactOut(r);
  });

  app.delete('/api/wa-promo/contacts/:id', W, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`UPDATE wa_contacts SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `wa_contact:${id}` });
    return { ok: true };
  });

  app.post('/api/wa-promo/consent/ask', W, async (req) => {
    const b = req.body || {};
    const r = await queueConsentAsk({ ids: Array.isArray(b.ids) ? b.ids : null });
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'wa_contacts:consent_ask', detail: r });
    return { ...r, remaining_today: Math.max(0, promoCfg().cap - await sentToday()), cap: promoCfg().cap };
  });

  // 설문 응답자 가져오기 — 이름·전화 문항은 화면에서 고른다(추정값을 미리 채움)
  app.get('/api/wa-promo/survey-sources', R, async () => {
    const rows = (await query(
      `SELECT s.id, s.title, s.code_prefix, s.questions,
              (SELECT count(*)::int FROM survey_pages p WHERE p.survey_id = s.id AND p.status = 'done') AS done_n
         FROM surveys s WHERE s.deleted_at IS NULL ORDER BY s.id DESC`)).rows;
    return { items: rows.map((s) => {
      const qs = (Array.isArray(s.questions) ? s.questions : []).filter((x) => x && ['text', 'info', 'number'].includes(x.type))
        .map((x) => ({ k: x.k, no: x.no, text: x.text, ko: x.ko || null, type: x.type }));
      const guess = (re) => (qs.find((x) => re.test(`${x.text} ${x.ko || ''}`)) || {}).k || null;
      return { id: Number(s.id), title: s.title, code_prefix: s.code_prefix, done_n: s.done_n, questions: qs,
        guess: { name_k: guess(/nombre|name|이름|성명/i), phone_k: guess(/tel|whats|cel|móvil|movil|전화|휴대/i), company_k: guess(/empresa|taller|refacc|negocio|상호|회사/i) } };
    }) };
  });
  app.post('/api/wa-promo/survey-import', W, async (req, reply) => {
    const b = req.body || {};
    const sid = idOf(b.survey_id); if (!sid) return reply.code(400).send({ error: 'bad_survey' });
    if (!b.phone_k) return reply.code(400).send({ error: 'phone_k_required' });
    const s = (await query(`SELECT id, code_prefix FROM surveys WHERE id=$1 AND deleted_at IS NULL`, [sid])).rows[0];
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const pages = (await query(`SELECT id, red_number, answers FROM survey_pages WHERE survey_id=$1 AND status='done' ORDER BY id`, [sid])).rows;
    const pick = (A, k) => (k && A && A[k] != null ? String(A[k]).trim() : '');
    const rows = pages.map((p) => {
      const A = p.answers || {};
      const company = pick(A, b.company_k), nm = pick(A, b.name_k);
      return { name: nm || company || `Encuesta ${p.red_number || p.id}`, phone: pick(A, b.phone_k),
        memo: [s.code_prefix ? `Encuesta ${s.code_prefix}${p.red_number ? '_' + p.red_number : ''}` : 'Encuesta', company && nm ? company : null].filter(Boolean).join(' · '),
        source_ref: `survey:${sid}:${p.red_number || p.id}` };
    }).filter((r) => r.phone);
    if (b.dry_run !== false) { const cls = await classifyRows(rows); return { dry_run: true, rows: cls, summary: summarize(cls), pages: pages.length }; }
    const r = await insertContacts(rows, { source: 'survey', userId: req.ctx.perm.userId });
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `wa_contacts:survey:${sid}`, detail: { added: r.added } });
    return { dry_run: false, added: r.added, summary: summarize(r.rows), pages: pages.length };
  });

  // ───────── 발송 일정 ─────────
  const CAMP_COLS = `c.id, ${MXT('c.send_at')} AS send_at_mx, c.send_at, c.caption, c.image_mime, c.image_name, octet_length(c.image) AS image_bytes,
                     c.memo_filter, COALESCE(cardinality(c.target_ids), 0) AS target_sel, c.status, c.target_n, c.created_at, c.started_at, c.finished_at, u.name AS created_by_name`;
  async function campaignStats(ids) {
    if (!ids.length) return new Map();
    const rows = (await query(
      `SELECT s.campaign_id, count(*) FILTER (WHERE s.sent_at IS NOT NULL)::int sent,
              count(*) FILTER (WHERE s.sent_at IS NULL AND s.status='failed')::int failed,
              count(*) FILTER (WHERE m.status IN ('delivered','read'))::int delivered,
              count(*) FILTER (WHERE m.status = 'read')::int read,
              count(*) FILTER (WHERE m.status = 'failed')::int dlv_failed
         FROM wa_campaign_sends s ${DLV_JOIN('s.message_id')}
        WHERE s.campaign_id = ANY($1::bigint[]) GROUP BY s.campaign_id`, [ids])).rows;
    const replies = (await query(
      `SELECT s.campaign_id, count(DISTINCT s.contact_id)::int replied FROM wa_campaign_sends s
         JOIN wa_messages i ON i.contact_id = s.contact_id AND i.direction='in' AND i.at > s.sent_at AND i.at < s.sent_at + interval '3 days'
        WHERE s.campaign_id = ANY($1::bigint[]) AND s.sent_at IS NOT NULL GROUP BY s.campaign_id`, [ids])).rows;
    const m = new Map(rows.map((r) => [Number(r.campaign_id), { ...r, replied: 0 }]));
    for (const r of replies) { const o = m.get(Number(r.campaign_id)) || {}; o.replied = r.replied; m.set(Number(r.campaign_id), o); }
    return m;
  }
  app.get('/api/wa-promo/campaigns', R, async (req) => {
    const args = []; const conds = [`c.status <> 'cancelled' OR $1::boolean`]; args.push(req.query.cancelled === '1');
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) { args.push(req.query.from); conds.push(`c.send_at >= ($${args.length}::date::timestamp AT TIME ZONE 'America/Mexico_City')`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) { args.push(req.query.to); conds.push(`c.send_at < (($${args.length}::date + 1)::timestamp AT TIME ZONE 'America/Mexico_City')`); }
    const rows = (await query(`SELECT ${CAMP_COLS} FROM wa_campaigns c LEFT JOIN users u ON u.id=c.created_by
                                WHERE ${conds.map((x) => `(${x})`).join(' AND ')} ORDER BY c.send_at, c.id`, args)).rows;
    const st = await campaignStats(rows.map((r) => Number(r.id)));
    return { items: rows.map((r) => ({ ...r, id: Number(r.id), image_bytes: Number(r.image_bytes), target_sel: Number(r.target_sel), stats: st.get(Number(r.id)) || null })),
      audience_yes: await audienceCount(null) };
  });

  function readImage(b) {
    if (!b.image_b64) return { none: true };
    const mime = String(b.image_mime || '').toLowerCase();
    if (!IMG_MIMES.includes(mime)) return { error: 'bad_image_type' };
    const buf = Buffer.from(String(b.image_b64).replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) return { error: 'bad_image' };
    if (buf.length > MAX_IMAGE_BYTES) return { error: 'image_too_large' };
    return { buf, mime, name: String(b.image_name || '').slice(0, 120) || null };
  }
  app.get('/api/wa-promo/campaigns/recent-images', R, async () => {
    const rows = (await query(
      `SELECT DISTINCT ON (md5(c.image)) c.id, c.caption, c.image_name, ${MXT('c.send_at')} AS send_at_mx
         FROM wa_campaigns c ORDER BY md5(c.image), c.send_at DESC, c.id DESC`)).rows
      .sort((a, b) => String(b.send_at_mx).localeCompare(String(a.send_at_mx))).slice(0, 12);
    return { items: rows.map((r) => ({ id: Number(r.id), caption: r.caption, image_name: r.image_name, send_at_mx: r.send_at_mx })) };
  });
  app.post('/api/wa-promo/campaigns', IMG_LIMIT, async (req, reply) => {
    const b = req.body || {};
    const now = b.send_now === true;
    if (!now && !localMx(b.send_at)) return reply.code(400).send({ error: 'bad_send_at' });
    const caption = String(b.caption || '').trim();
    if (!caption) return reply.code(400).send({ error: 'caption_required' });
    if (caption.length > 900) return reply.code(400).send({ error: 'caption_too_long' });
    let img = readImage(b);
    if (img.error) return reply.code(400).send({ error: img.error });
    if (img.none && b.from_campaign_id) {   // 지난 발송 이미지 다시 쓰기
      const src = (await query(`SELECT image, image_mime, image_name FROM wa_campaigns WHERE id=$1`, [idOf(b.from_campaign_id)])).rows[0];
      if (!src) return reply.code(404).send({ error: 'image_source_not_found' });
      img = { buf: src.image, mime: src.image_mime, name: src.image_name };
    }
    if (img.none) return reply.code(400).send({ error: 'image_required' });
    // 0261 · 고른 연락처 — 그중 ✅ 동의자만 대상. 동의자가 없으면 만들지 않는다.
    let targets = null; let picked = null;
    if (b.contact_ids != null) {
      const ids = targetIdsOf(b.contact_ids);
      if (!ids) return reply.code(400).send({ error: 'no_contacts' });
      if (ids.length > 5000) return reply.code(400).send({ error: 'too_many_contacts' });
      const rows = (await query(`SELECT id, consent FROM wa_contacts WHERE deleted_at IS NULL AND id = ANY($1::bigint[])`, [ids])).rows;
      picked = { selected: ids.length, yes: 0, unknown: 0, asked: 0, no: 0, missing: ids.length - rows.length };
      for (const r of rows) picked[r.consent] = (picked[r.consent] || 0) + 1;
      targets = rows.filter((r) => r.consent === 'yes').map((r) => Number(r.id));
      if (!targets.length) return reply.code(400).send({ error: 'no_consented', picked });
    }
    const r = (await query(
      `INSERT INTO wa_campaigns (send_at, caption, image, image_mime, image_name, memo_filter, target_ids, created_by)
       VALUES (CASE WHEN $8 THEN now() ELSE ($1::timestamp AT TIME ZONE 'America/Mexico_City') END,$2,$3,$4,$5,$6,$7::bigint[],$9)
       RETURNING id, (send_at <= now()) AS past`,
      [now ? null : b.send_at, caption, img.buf, img.mime, img.name, targets ? null : (String(b.memo_filter || '').trim() || null), targets, now, req.ctx.perm.userId])).rows[0];
    await logEvent({ userId: req.ctx.perm.userId, action: 'create', target: `wa_campaign:${r.id}`,
      detail: { send_at: now ? 'now' : b.send_at, targets: targets ? targets.length : null } });
    return { id: Number(r.id), past: r.past === true, audience: await audienceCount({ memo_filter: b.memo_filter, target_ids: targets }), picked,
      remaining_today: Math.max(0, promoCfg().cap - await sentToday()) };
  });
  app.patch('/api/wa-promo/campaigns/:id', IMG_LIMIT, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {}; const sets = []; const args = [];
    const put = (sql, v) => { args.push(v); sets.push(sql.replace(/\?/g, '$' + args.length)); };
    if (b.send_at != null) { if (!localMx(b.send_at)) return reply.code(400).send({ error: 'bad_send_at' }); put(`send_at=(?::timestamp AT TIME ZONE 'America/Mexico_City')`, b.send_at); }
    if (b.caption != null) { const c = String(b.caption).trim(); if (!c) return reply.code(400).send({ error: 'caption_required' }); if (c.length > 900) return reply.code(400).send({ error: 'caption_too_long' }); put('caption=?', c); }
    if (b.memo_filter !== undefined) put('memo_filter=?', String(b.memo_filter || '').trim() || null);
    const img = readImage(b);
    if (img.error) return reply.code(400).send({ error: img.error });
    if (!img.none) { put('image=?', img.buf); put('image_mime=?', img.mime); put('image_name=?', img.name); sets.push('media_id=NULL', 'media_at=NULL'); }
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    args.push(id);
    const r = (await query(`UPDATE wa_campaigns SET ${sets.join(', ')}, updated_at=now() WHERE id=$${args.length} AND status='scheduled' RETURNING id`, args)).rows[0];
    if (!r) return reply.code(409).send({ error: 'not_editable', note: '예약 상태인 발송만 고칠 수 있습니다(발송 중·완료·취소는 불가).' });
    return { ok: true };
  });
  app.delete('/api/wa-promo/campaigns/:id', W, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const r = (await query(`UPDATE wa_campaigns SET status='cancelled', updated_at=now() WHERE id=$1 AND status IN ('scheduled','sending') RETURNING id`, [id])).rows[0];
    if (!r) return reply.code(409).send({ error: 'not_cancellable' });
    await logEvent({ userId: req.ctx.perm.userId, action: 'delete', target: `wa_campaign:${id}` });
    return { ok: true };
  });
  app.get('/api/wa-promo/campaigns/:id/image', R, async (req, reply) => {
    const r = (await query(`SELECT image, image_mime FROM wa_campaigns WHERE id=$1`, [idOf(req.params.id)])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return reply.type(r.image_mime).header('cache-control', 'private, max-age=3600').send(r.image);
  });
  app.get('/api/wa-promo/campaigns/:id/sends', R, async (req) => {
    const rows = (await query(
      `SELECT s.contact_id, w.name, w.phone, s.status, s.error, s.attempts, s.sent_at, s.updated_at, ${DLV_COLS}
         FROM wa_campaign_sends s JOIN wa_contacts w ON w.id = s.contact_id ${DLV_JOIN('s.message_id')}
        WHERE s.campaign_id=$1 ORDER BY s.updated_at DESC`, [idOf(req.params.id)])).rows;
    return { items: rows.map((x) => ({ contact_id: Number(x.contact_id), name: x.name, phone_masked: maskPhone(x.phone), status: x.status,
      error: x.error, attempts: Number(x.attempts), sent_at: x.sent_at, updated_at: x.updated_at, ...dlv(x) })) };
  });
  app.post('/api/wa-promo/campaigns/:id/test', W, async (req, reply) => {
    if (!promoReady()) return reply.code(400).send({ error: 'wa_not_configured' });
    const id = idOf(req.params.id);
    const to = normalizeWaNumber((req.body || {}).phone);
    if (!to) return reply.code(400).send({ error: 'bad_phone' });
    const c = (await query(`SELECT id, caption, image, image_mime, image_name FROM wa_campaigns WHERE id=$1`, [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    // 시험 발송은 매번 새로 올린다(예약분의 media_id 와 섞지 않음)
    const up = await uploadCampaignImage(c);
    if (!up.ok) return reply.code(502).send({ error: 'upload_failed', detail: up.error });
    const res = await sendCampaignTo({ id: Number(c.id), caption: c.caption }, { id: null, phone: to }, up.id, { source: 'test' });
    return res.ok ? { ok: true, kind: res.kind } : reply.code(502).send({ error: 'send_failed', detail: res.error, kind: res.kind });
  });

  // ───────── 받은 메시지 ─────────
  app.get('/api/wa-promo/conversations', R, async (req) => {
    const args = []; const conds = [];
    if (req.query.state === 'open') conds.push(`w.inbox_state = 'open'`);
    else if (req.query.state === 'done') conds.push(`w.inbox_state = 'done'`);
    else if (req.query.state === 'unregistered') conds.push(`w.id IS NULL`);
    if (req.query.assignee) { args.push(idOf(req.query.assignee)); conds.push(`w.assigned_to = $${args.length}`); }
    if (req.query.lead === '1') conds.push(`w.lead = true`);
    const rows = (await query(
      `WITH last AS (
         SELECT DISTINCT ON (phone) phone, id, direction, body, kind, source, at
           FROM wa_messages ORDER BY phone, at DESC, id DESC
       ), cnt AS (
         SELECT phone, count(*) FILTER (WHERE direction='in')::int n_in FROM wa_messages GROUP BY phone
       )
       SELECT last.phone, last.direction, last.body, last.kind, last.source, last.at, cnt.n_in,
              w.id AS contact_id, w.name, w.consent, w.inbox_state, w.lead, w.assigned_to, u.name AS assigned_name,
              i.last_at AS inbound_at, (i.last_at > now() - interval '24 hours') AS window_open
         FROM last JOIN cnt ON cnt.phone = last.phone
         LEFT JOIN wa_contacts w ON w.phone = last.phone AND w.deleted_at IS NULL
         LEFT JOIN users u ON u.id = w.assigned_to
         LEFT JOIN wa_inbound i ON i.wa_from = last.phone
        WHERE cnt.n_in > 0${conds.length ? ' AND ' + conds.join(' AND ') : ''}
        ORDER BY (w.inbox_state = 'open') DESC NULLS LAST, last.at DESC LIMIT 300`, args)).rows;
    return { items: rows.map((r) => ({ phone: r.phone, phone_masked: maskPhone(r.phone), contact_id: r.contact_id != null ? Number(r.contact_id) : null,
      name: r.name || null, consent: r.consent || null, inbox_state: r.inbox_state || null, lead: r.lead === true,
      assigned_to: r.assigned_to != null ? Number(r.assigned_to) : null, assigned_name: r.assigned_name || null,
      last: { direction: r.direction, body: r.body, kind: r.kind, source: r.source, at: r.at }, n_in: r.n_in,
      window_open: r.inbound_at ? r.window_open === true : false, inbound_at: r.inbound_at || null })) };
  });
  app.get('/api/wa-promo/conversations/:phone', R, async (req, reply) => {
    const p = normalizeWaNumber(req.params.phone); if (!p) return reply.code(400).send({ error: 'bad_phone' });
    const msgs = (await query(
      `SELECT x.id, x.direction, x.kind, x.body, x.source, x.campaign_id, x.ok, x.error, x.at, u.name AS sent_by_name, ${DLV_COLS}
         FROM wa_messages x LEFT JOIN users u ON u.id = x.sent_by ${DLV_JOIN('x.wamid')}
        WHERE x.phone=$1 ORDER BY x.at, x.id LIMIT 1000`, [p])).rows;
    const ct = (await query(`SELECT w.*, u.name AS assigned_name FROM wa_contacts w LEFT JOIN users u ON u.id=w.assigned_to WHERE w.phone=$1 AND w.deleted_at IS NULL`, [p])).rows[0];
    const win = (await query(`SELECT last_at, (last_at > now() - interval '24 hours') AS open FROM wa_inbound WHERE wa_from=$1`, [p])).rows[0];
    return { phone: p, contact: ct ? contactOut(ct) : null,
      window: { open: win ? win.open === true : false, last_in_at: win ? win.last_at : null },
      items: msgs.map((x) => ({ id: Number(x.id), direction: x.direction, kind: x.kind, body: x.body, source: x.source,
        campaign_id: x.campaign_id != null ? Number(x.campaign_id) : null, ok: x.ok, error: x.error, at: x.at, sent_by_name: x.sent_by_name || null,
        ...(x.direction === 'out' ? dlv(x) : {}) })) };
  });
  app.post('/api/wa-promo/conversations/:phone/reply', W, async (req, reply) => {
    if (!promoReady()) return reply.code(400).send({ error: 'wa_not_configured' });
    const r = await manualReply({ phone: req.params.phone, text: (req.body || {}).text, userId: req.ctx.perm.userId });
    if (!r.ok) return reply.code(r.error === 'window_closed' ? 409 : 400).send({ error: r.error });
    return r;
  });
  app.post('/api/wa-promo/conversations/:phone/contact', W, async (req, reply) => {
    const r = await insertContacts([{ name: (req.body || {}).name, phone: req.params.phone, memo: (req.body || {}).memo }], { source: 'manual', userId: req.ctx.perm.userId });
    const row = r.rows[0];
    if (row.status !== 'new') return reply.code(row.status === 'exists' ? 409 : 400).send({ error: row.status });
    await query(`UPDATE wa_messages SET contact_id=$1 WHERE phone=$2 AND contact_id IS NULL`, [row.id, row.phone]);
    await query(`UPDATE wa_contacts SET inbox_state='open', last_in_at=(SELECT max(at) FROM wa_messages WHERE phone=$2 AND direction='in') WHERE id=$1`, [row.id, row.phone]);
    return { id: row.id };
  });
  app.get('/api/wa-promo/messages/export', R, async (req) => {
    const args = []; const conds = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) { args.push(req.query.from); conds.push(`x.at >= ($${args.length}::date::timestamp AT TIME ZONE 'America/Mexico_City')`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) { args.push(req.query.to); conds.push(`x.at < (($${args.length}::date + 1)::timestamp AT TIME ZONE 'America/Mexico_City')`); }
    if (req.query.state === 'open') conds.push(`w.inbox_state='open'`);
    if (req.query.direction === 'in') conds.push(`x.direction='in'`);
    const rows = (await query(
      `SELECT ${MXT('x.at')} AS at_mx, x.direction, x.phone, w.name, w.memo, w.consent, w.inbox_state, x.kind, x.source, x.body,
              u.name AS sent_by_name, us.name AS assigned_name, m.status AS dlv_status
         FROM wa_messages x LEFT JOIN wa_contacts w ON w.phone = x.phone AND w.deleted_at IS NULL
         LEFT JOIN users u ON u.id = x.sent_by LEFT JOIN users us ON us.id = w.assigned_to
         ${DLV_JOIN('x.wamid')}
        ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY x.phone, x.at, x.id LIMIT 50000`, args)).rows;
    await logEvent({ userId: req.ctx.perm.userId, action: 'export', target: 'wa_messages', detail: { rows: rows.length } });
    return { items: rows };
  });

  // ───────── 자동응답 ─────────
  const ruleOut = (r) => ({ id: Number(r.id), sort: r.sort, keywords: r.keywords || [], is_fallback: r.is_fallback === true, reply: r.reply,
    buttons: r.buttons || [], action: r.action, active: r.active === true });
  const cleanList = (v, max, len) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((s) => String(s || '').trim()).filter(Boolean).slice(0, max).map((s) => s.slice(0, len));
  app.get('/api/wa-promo/autoreplies', R, async () => ({
    items: (await query(`SELECT * FROM wa_autoreplies WHERE deleted_at IS NULL ORDER BY is_fallback, sort, id`)).rows.map(ruleOut) }));
  app.post('/api/wa-promo/autoreplies', W, async (req, reply) => {
    const b = req.body || {};
    const kws = cleanList(b.keywords, 30, 60); const reply1 = String(b.reply || '').trim().slice(0, 1000);
    if (!reply1) return reply.code(400).send({ error: 'reply_required' });
    if (!b.is_fallback && !kws.length) return reply.code(400).send({ error: 'keywords_required' });
    if (b.action && !ACTIONS.includes(b.action)) return reply.code(400).send({ error: 'bad_action' });
    if (b.is_fallback) { const ex = (await query(`SELECT 1 FROM wa_autoreplies WHERE is_fallback AND deleted_at IS NULL`)).rows.length; if (ex) return reply.code(409).send({ error: 'fallback_exists' }); }
    const r = (await query(
      `INSERT INTO wa_autoreplies (sort, keywords, is_fallback, reply, buttons, action, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [Number(b.sort) || 100, kws, !!b.is_fallback, reply1, cleanList(b.buttons, 3, 20), b.action || 'none', req.ctx.perm.userId])).rows[0];
    return ruleOut(r);
  });
  app.patch('/api/wa-promo/autoreplies/:id', W, async (req, reply) => {
    const id = idOf(req.params.id); if (!id) return reply.code(400).send({ error: 'bad_id' });
    const b = req.body || {}; const sets = []; const args = [];
    const put = (col, v) => { args.push(v); sets.push(`${col}=$${args.length}`); };
    if (b.sort != null) put('sort', Number(b.sort) || 100);
    if (b.keywords != null) put('keywords', cleanList(b.keywords, 30, 60));
    if (b.reply != null) { const t = String(b.reply).trim().slice(0, 1000); if (!t) return reply.code(400).send({ error: 'reply_required' }); put('reply', t); }
    if (b.buttons != null) put('buttons', cleanList(b.buttons, 3, 20));
    if (b.action != null) { if (!ACTIONS.includes(b.action)) return reply.code(400).send({ error: 'bad_action' }); put('action', b.action); }
    if (typeof b.active === 'boolean') put('active', b.active);
    if (!sets.length) return reply.code(400).send({ error: 'nothing_to_update' });
    put('updated_by', req.ctx.perm.userId); args.push(id);
    const r = (await query(`UPDATE wa_autoreplies SET ${sets.join(', ')}, updated_at=now() WHERE id=$${args.length} AND deleted_at IS NULL RETURNING *`, args)).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (!r.is_fallback && !(r.keywords || []).length) return reply.code(400).send({ error: 'keywords_required' });
    return ruleOut(r);
  });
  app.delete('/api/wa-promo/autoreplies/:id', W, async (req, reply) => {
    const r = (await query(`UPDATE wa_autoreplies SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [idOf(req.params.id)])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ───────── 설정 · 상태 ─────────
  let qualityCache = { at: 0, v: null };
  async function quality() {
    if (!waApiReady()) return null;
    if (Date.now() - qualityCache.at < 600000) return qualityCache.v;
    let v = null;
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v20.0'}/${process.env.WHATSAPP_PHONE_ID}?fields=quality_rating,verified_name,display_phone_number`,
        { headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }, signal: ctrl.signal });
      clearTimeout(t);
      const d = await r.json().catch(() => ({}));
      if (r.ok) v = { quality_rating: d.quality_rating || null, verified_name: d.verified_name || null, display_phone_number: d.display_phone_number || null };
    } catch { v = null; }
    qualityCache = { at: Date.now(), v }; return v;
  }
  app.get('/api/wa-promo/status', R, async () => {
    const cfg = promoCfg();
    const today = await sentToday();
    const due = (await query(`SELECT count(*)::int n FROM wa_campaigns WHERE status='sending'`)).rows[0].n;
    return { enabled: cfg.enabled, api_ready: promoReady(), cap: cfg.cap, sent_today: today, remaining_today: Math.max(0, cfg.cap - today),
      consent_template: cfg.consentTpl, image_template: cfg.imageTpl, template_lang: cfg.lang,
      webhook: !!(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && process.env.WHATSAPP_APP_SECRET),
      sending_campaigns: due, meta: await quality() };
  });
  app.get('/api/wa-promo/users', R, async () => ({
    items: (await query(`SELECT id, name, role FROM users WHERE deleted_at IS NULL ORDER BY name`)).rows.map((u) => ({ id: Number(u.id), name: u.name, role: u.role })) }));
}

function summarize(rows) {
  const s = { total: rows.length, new: 0, exists: 0, dup_in_file: 0, bad_phone: 0, no_name: 0 };
  for (const r of rows) s[r.status] = (s[r.status] || 0) + 1;
  return s;
}
