// =====================================================================
// Refatrix ERP · waPromo.js — WhatsApp 마케팅(잠재고객) (0260 · 2026-10-07 디렉터 지시)
//
//   ① 연락처: 이름 · 번호(52+10자리) · 메모. 화면 입력 · 엑셀 대량 · 설문 응답자 가져오기.
//   ② 수신 동의: 설문지에 동의 칸이 없었으므로 모두 unknown 으로 시작 →
//      동의 요청을 딱 한 번(promo_consentimiento 템플릿, 창이 열려 있으면 무료 버튼 메시지) →
//      「Sí, quiero」= yes · 「No, gracias」/BAJA = no. 영업이 전화로 받은 동의는 sales 로 기록.
//      정기 이미지는 yes 에게만 간다.
//   ③ 발송 일정: 날짜·시각(멕시코) + 이미지 + 문구. 같은 승인 템플릿(promo_imagen: 이미지 헤더 + {{1}})으로
//      이미지·문구를 매번 바꿔 보낸다(재승인 불필요). 24시간 창이 열린 사람은 무료 일반 이미지.
//   ④ 받은 메시지: 웹훅으로 들어오는 순간 wa_messages 에 저장(Cloud API 는 지난 대화를 돌려주지 않음).
//      자동응답 규칙(wa_autoreplies)으로 답하고 동의/수신거부/상담 요청을 처리.
//   ⑤ 하루 상한: 동의 요청 + 정기 발송 합계가 PROMO_WA_DAILY_CAP(기본 150)을 넘지 않는다 —
//      Meta 의 「24시간 250명」 한도를 일일자금·견적 알림과 같이 쓰기 때문.
//
//   환경변수(외부 서비스 키 화면): PROMO_CONSENT_TEMPLATE · PROMO_IMAGE_TEMPLATE · PROMO_TEMPLATE_LANG ·
//     PROMO_WA_DAILY_CAP · PROMO_WA_ENABLED=0(끄기)
// =====================================================================
import { query } from './db.js';
import {
  normalizeWaNumber, waApiReady, sendWaText, sendWaButtons, sendWaTemplateBare,
  uploadWaMedia, sendWaImage, sendWaImageTemplate,
} from './waSend.js';

export const MAX_PER_TICK = 60;
export const CAMPAIGN_MAX_ATTEMPTS = 2;
export const AUTOREPLY_COOLDOWN_H = 6;
export const HUMAN_QUIET_H = 2;
export const MEDIA_REUPLOAD_DAYS = 25;   // Meta 미디어 id 는 30일 유효
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function promoCfg() {
  const cap = Number(process.env.PROMO_WA_DAILY_CAP);
  return {
    enabled: process.env.PROMO_WA_ENABLED !== '0',
    cap: Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : 150,
    consentTpl: process.env.PROMO_CONSENT_TEMPLATE || 'promo_consentimiento',
    imageTpl: process.env.PROMO_IMAGE_TEMPLATE || 'promo_imagen',
    lang: process.env.PROMO_TEMPLATE_LANG || process.env.WHATSAPP_TEMPLATE_LANG || 'es_MX',
  };
}

// 창 안(무료)에서 보내는 동의 요청 — 템플릿 본문과 같은 뜻
export const CONSENT_TEXT = 'Gracias por participar en nuestra encuesta de Refatrix. ¿Desea recibir promociones y novedades de autopartes por WhatsApp?';
export const CONSENT_BUTTONS = ['Sí, quiero', 'No, gracias'];

// ── 발송 API (테스트에서 바꿔 끼움) ──
const DEFAULT_API = {
  text: ({ to, text }) => sendWaText(text, to),
  buttons: sendWaButtons,
  bare: sendWaTemplateBare,
  upload: uploadWaMedia,
  image: sendWaImage,
  imageTemplate: sendWaImageTemplate,
};
let api = DEFAULT_API; let apiOverridden = false;
export function setPromoApi(a) { api = a ? { ...DEFAULT_API, ...a } : DEFAULT_API; apiOverridden = !!a; }
export const promoReady = () => waApiReady() || apiOverridden;

// 응답 뒤로 미루는 일(자동응답 발송) — 테스트는 flushPromo() 로 기다린다
const pending = new Set();
function defer(fn) {
  const p = new Promise((r) => setImmediate(r)).then(fn).catch(() => {}).finally(() => pending.delete(p));
  pending.add(p); return p;
}
export async function flushPromo() { while (pending.size) await Promise.all([...pending]); }

// ── 공통 ──
export const maskPhone = (p) => { const s = String(p || ''); return s ? s.slice(0, 3) + '****' + s.slice(-4) : null; };
export function normText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
const hookOn = () => !!(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && process.env.WHATSAPP_APP_SECRET);
// 24시간 창: true/false, 웹훅 미설정이면 null(모름)
export async function windowOpen(phone, q = query) {
  if (!hookOn()) return null;
  try {
    const r = (await q(`SELECT (last_at > now() - interval '24 hours') AS open FROM wa_inbound WHERE wa_from=$1`, [phone])).rows[0];
    return r ? r.open === true : false;
  } catch { return null; }
}
const MX_MIDNIGHT = `(date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') AT TIME ZONE 'America/Mexico_City')`;
export async function sentToday(q = query) {
  return Number((await q(
    `SELECT count(*)::int n FROM wa_messages
      WHERE direction='out' AND source IN ('consent','campaign') AND ok = true AND at >= ${MX_MIDNIGHT}`)).rows[0].n);
}
export async function remainingToday(q = query) { return Math.max(0, promoCfg().cap - await sentToday(q)); }

async function logOut(q, { phone, contactId = null, kind, body = null, payload = null, source, campaignId = null, ruleId = null, sentBy = null, res }) {
  await q(
    `INSERT INTO wa_messages (direction, phone, contact_id, wamid, kind, body, payload, source, campaign_id, rule_id, sent_by, ok, error)
     VALUES ('out',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [phone, contactId, (res && res.message_id) || null, kind, body, payload, source, campaignId, ruleId, sentBy, !!(res && res.ok),
      res && !res.ok ? String(res.error || 'error').slice(0, 300) : null]);
  if (contactId && res && res.ok) await q(`UPDATE wa_contacts SET last_out_at=now() WHERE id=$1`, [contactId]);
}

// ───────────────────────── ① 연락처 ─────────────────────────
// 엑셀/화면 입력 행 정리: 번호 정규화 · 파일 안 중복 · 이미 등록됨 · 형식 오류
export async function classifyRows(rows, q = query) {
  const out = []; const seen = new Map();
  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i] || {};
    const name = String(r.name || '').trim().slice(0, 120);
    const phone = normalizeWaNumber(r.phone);
    const memo = String(r.memo || '').trim().slice(0, 300) || null;
    const row = { i, name, phone, raw_phone: String(r.phone || '').trim(), memo, status: 'new' };
    if (!phone) row.status = 'bad_phone';
    else if (!name) row.status = 'no_name';
    else if (seen.has(phone)) { row.status = 'dup_in_file'; row.dup_of = seen.get(phone); }
    else seen.set(phone, i);
    out.push(row);
  }
  const phones = out.filter((r) => r.status === 'new').map((r) => r.phone);
  if (phones.length) {
    const ex = new Map((await q(`SELECT id, phone, name FROM wa_contacts WHERE deleted_at IS NULL AND phone = ANY($1::text[])`, [phones])).rows
      .map((x) => [x.phone, x]));
    for (const r of out) if (r.status === 'new' && ex.has(r.phone)) { r.status = 'exists'; r.existing = { id: Number(ex.get(r.phone).id), name: ex.get(r.phone).name }; }
  }
  return out;
}
export async function insertContacts(rows, { source = 'manual', userId = null }, q = query) {
  const cls = await classifyRows(rows, q);
  let added = 0; const ids = [];
  for (const r of cls) {
    if (r.status !== 'new') continue;
    const x = (await q(
      `INSERT INTO wa_contacts (name, phone, memo, source, source_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (phone) WHERE deleted_at IS NULL DO NOTHING RETURNING id`,
      [r.name, r.phone, r.memo, source, (rows[r.i] && rows[r.i].source_ref) || null, userId])).rows[0];
    if (x) { added++; ids.push(Number(x.id)); r.id = Number(x.id); } else r.status = 'exists';
  }
  return { rows: cls, added, ids };
}

// ───────────────────────── ② 동의 요청 ─────────────────────────
export async function queueConsentAsk({ ids = null } = {}, q = query) {
  const args = []; let cond = '';
  if (Array.isArray(ids)) { args.push(ids.map(Number).filter(Boolean)); cond = ` AND id = ANY($1::bigint[])`; }
  const r = await q(
    `UPDATE wa_contacts SET ask_queued_at = now(), ask_error = NULL, updated_at = now()
      WHERE deleted_at IS NULL AND consent = 'unknown' AND asked_at IS NULL AND ask_queued_at IS NULL${cond} RETURNING id`, args);
  return { queued: (r.rows || []).length };
}

async function sendConsentAsk(c, q) {
  const cfg = promoCfg();
  const claim = (await q(`UPDATE wa_contacts SET asked_at = now() WHERE id=$1 AND asked_at IS NULL AND consent='unknown' AND deleted_at IS NULL RETURNING id`, [c.id])).rows[0];
  if (!claim) return { skipped: true };
  const open = await windowOpen(c.phone, q);
  let res; let kind;
  try {
    if (open === true) { kind = 'interactive'; res = await api.buttons({ to: c.phone, text: CONSENT_TEXT, buttons: CONSENT_BUTTONS }); }
    else { kind = 'template'; res = await api.bare({ to: c.phone, name: cfg.consentTpl, lang: cfg.lang }); }
  } catch (e) { res = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
  await logOut(q, { phone: c.phone, contactId: c.id, kind, body: kind === 'template' ? `[${cfg.consentTpl}] ${CONSENT_TEXT}` : CONSENT_TEXT, source: 'consent', res });
  if (res.ok) {
    await q(`UPDATE wa_contacts SET consent = CASE WHEN consent='unknown' THEN 'asked' ELSE consent END, ask_message_id=$2, ask_queued_at=NULL, ask_error=NULL, updated_at=now() WHERE id=$1`,
      [c.id, res.message_id || null]);
  } else {
    // 실패하면 대기열에서 빼고 사유를 남긴다(사람이 보고 다시 요청) — 같은 번호로 계속 두드리지 않는다
    await q(`UPDATE wa_contacts SET asked_at=NULL, ask_queued_at=NULL, ask_error=$2, updated_at=now() WHERE id=$1`, [c.id, String(res.error || 'error').slice(0, 300)]);
  }
  return { ok: !!res.ok };
}
export async function processConsentAsks(budget, q = query) {
  if (budget <= 0) return { sent: 0 };
  const rows = (await q(
    `SELECT id, phone FROM wa_contacts
      WHERE deleted_at IS NULL AND consent='unknown' AND asked_at IS NULL AND ask_queued_at IS NOT NULL
      ORDER BY ask_queued_at, id LIMIT $1`, [budget])).rows;
  let sent = 0, failed = 0;
  for (const c of rows) { const r = await sendConsentAsk({ id: Number(c.id), phone: c.phone }, q); if (r.ok) sent++; else if (!r.skipped) failed++; }
  return { sent, failed };
}

// ───────────────────────── ③ 정기 발송 ─────────────────────────
export const oneLine = (s) => String(s || '').replace(/[\n\t\r]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1000);
// 대상 조건(0261): target_ids 가 있으면 「고른 연락처 중 ✅ 동의자」, 없으면 「✅ 동의 전체(+메모 조건)」.
//   args 는 $2 부터 쓴다($1 = campaign_id).
export const targetIdsOf = (v) => {
  const a = (Array.isArray(v) ? v : []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  return a.length ? [...new Set(a)] : null;
};
const audienceSql = (c, base = 1) => {
  const args = []; let extra = '';
  const ids = targetIdsOf(c.target_ids);
  if (ids) { args.push(ids); extra = ` AND w.id = ANY($${args.length + base}::bigint[])`; }
  else if (c.memo_filter && String(c.memo_filter).trim()) { args.push('%' + String(c.memo_filter).trim() + '%'); extra = ` AND w.memo ILIKE $${args.length + base}`; }
  return { args, extra };
};
// audienceCount('메모') 또는 audienceCount({ memo_filter, target_ids })
export async function audienceCount(spec, q = query) {
  const c = spec && typeof spec === 'object' ? spec : { memo_filter: spec };
  const { args, extra } = audienceSql(c, 0);
  return Number((await q(`SELECT count(*)::int n FROM wa_contacts w WHERE w.deleted_at IS NULL AND w.consent='yes'${extra}`, args)).rows[0].n);
}

export async function uploadCampaignImage(c) {
  return api.upload(c.image, { mime: c.image_mime, filename: c.image_name || `promo_${c.id}.jpg` });
}
async function ensureMedia(c, q) {
  const fresh = c.media_id && c.media_at && (Date.now() - new Date(c.media_at).getTime()) < MEDIA_REUPLOAD_DAYS * 86400000;
  if (fresh) return { ok: true, id: c.media_id };
  const img = (await q(`SELECT id, image, image_mime, image_name FROM wa_campaigns WHERE id=$1`, [c.id])).rows[0];
  const up = await uploadCampaignImage(img);
  if (!up.ok) return up;
  await q(`UPDATE wa_campaigns SET media_id=$2, media_at=now() WHERE id=$1`, [c.id, up.id]);
  return { ok: true, id: up.id };
}

export async function sendCampaignTo(c, ct, mediaId, { q = query, source = 'campaign' } = {}) {
  const cfg = promoCfg();
  const open = await windowOpen(ct.phone, q);
  let res, kind;
  try {
    if (open === true) { kind = 'image'; res = await api.image({ to: ct.phone, mediaId, caption: c.caption }); }
    else { kind = 'template'; res = await api.imageTemplate({ to: ct.phone, mediaId, param: oneLine(c.caption), name: cfg.imageTpl, lang: cfg.lang }); }
  } catch (e) { res = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
  await logOut(q, { phone: ct.phone, contactId: ct.id || null, kind, body: c.caption, payload: mediaId, source, campaignId: c.id, res });
  return { ...res, kind };
}

async function processCampaign(c, budget, q) {
  if (c.status === 'scheduled') {
    const n = await audienceCount(c, q);
    await q(`UPDATE wa_campaigns SET status='sending', started_at=now(), target_n=$2, updated_at=now() WHERE id=$1 AND status='scheduled'`, [c.id, n]);
  }
  const { args, extra } = audienceSql(c);
  const left = (await q(
    `SELECT w.id, w.phone FROM wa_contacts w
      WHERE w.deleted_at IS NULL AND w.consent='yes'${extra}
        AND NOT EXISTS (SELECT 1 FROM wa_campaign_sends s WHERE s.campaign_id=$1 AND s.contact_id=w.id
                         AND (s.sent_at IS NOT NULL OR s.attempts >= ${CAMPAIGN_MAX_ATTEMPTS} OR (s.status='sending' AND s.updated_at > now() - interval '5 minutes')))
      ORDER BY w.id LIMIT ${Math.max(0, budget) + 1}`, [c.id, ...args])).rows;
  if (!left.length) {
    await q(`UPDATE wa_campaigns SET status='done', finished_at=now(), updated_at=now() WHERE id=$1 AND status='sending'`, [c.id]);
    return { sent: 0, done: true };
  }
  if (budget <= 0) return { sent: 0, capped: true };
  const media = await ensureMedia(c, q);
  if (!media.ok) return { sent: 0, error: `upload: ${media.error}` };   // 다음 틱에 다시
  let sent = 0, failed = 0;
  for (const ct of left.slice(0, budget)) {
    const claim = (await q(
      `INSERT INTO wa_campaign_sends (campaign_id, contact_id, status, attempts, updated_at) VALUES ($1,$2,'sending',0,now())
       ON CONFLICT (campaign_id, contact_id) DO UPDATE SET status='sending', updated_at=now()
        WHERE wa_campaign_sends.sent_at IS NULL AND wa_campaign_sends.attempts < ${CAMPAIGN_MAX_ATTEMPTS}
          AND (wa_campaign_sends.status <> 'sending' OR wa_campaign_sends.updated_at < now() - interval '5 minutes')
       RETURNING id`, [c.id, ct.id])).rows[0];
    if (!claim) continue;
    const res = await sendCampaignTo(c, { id: Number(ct.id), phone: ct.phone }, media.id, { q });
    await q(
      `UPDATE wa_campaign_sends SET status=$2, message_id=COALESCE($3, message_id), error=$4, attempts=attempts+1,
              sent_at=CASE WHEN $5 THEN now() ELSE sent_at END, updated_at=now() WHERE id=$1`,
      [claim.id, res.ok ? (res.kind === 'image' ? 'sent_image' : 'sent_template') : 'failed', res.message_id || null,
        res.ok ? null : String(res.error || 'error').slice(0, 300), !!res.ok]);
    if (res.ok) sent++; else failed++;
  }
  if (left.length <= budget) {
    // 이번 틱으로 다 돌았으면 완료(실패 1회 남은 사람은 다음 틱에 1번 더)
    const more = (await q(
      `SELECT 1 FROM wa_contacts w WHERE w.deleted_at IS NULL AND w.consent='yes'${extra}
         AND NOT EXISTS (SELECT 1 FROM wa_campaign_sends s WHERE s.campaign_id=$1 AND s.contact_id=w.id AND (s.sent_at IS NOT NULL OR s.attempts >= ${CAMPAIGN_MAX_ATTEMPTS})) LIMIT 1`,
      [c.id, ...args])).rows.length;
    if (!more) await q(`UPDATE wa_campaigns SET status='done', finished_at=now(), updated_at=now() WHERE id=$1 AND status='sending'`, [c.id]);
  }
  return { sent, failed };
}

export async function runPromoJob({ q = query } = {}) {
  const cfg = promoCfg();
  if (!cfg.enabled) return { skipped: 'disabled' };
  if (!promoReady()) return { skipped: 'wa_not_configured' };
  let budget = Math.min(MAX_PER_TICK, await remainingToday(q));
  const out = { campaigns: [], asks: null, budget };
  const due = (await q(`SELECT id, caption, memo_filter, target_ids, status, media_id, media_at FROM wa_campaigns
                         WHERE status IN ('scheduled','sending') AND send_at <= now() ORDER BY send_at, id`)).rows;
  for (const c of due) {
    const r = await processCampaign({ ...c, id: Number(c.id) }, budget, q);
    out.campaigns.push({ id: Number(c.id), ...r });
    budget -= r.sent || 0;
  }
  out.asks = await processConsentAsks(budget, q);
  return out;
}

export function startWaPromoWorker(app) {
  if (globalThis.__refatrixPromoWorker) return;
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { await runPromoJob({}); }
    catch (e) { app && app.log && app.log.warn({ err: String(e && e.message) }, '[wa-promo] job failed'); }   // 0260 전이면 테이블 없음
    finally { busy = false; }
  };
  globalThis.__refatrixPromoWorker = setInterval(() => { tick(); }, 60000);
  setTimeout(() => { tick(); }, 40000);
}

// ───────────────────────── ④ 받은 메시지 · 자동응답 ─────────────────────────
export function parseInbound(m) {
  const t = String((m && m.type) || '');
  if (t === 'text') return { kind: 'text', body: (m.text && m.text.body) || '', payload: null };
  if (t === 'button') return { kind: 'button', body: (m.button && m.button.text) || '', payload: (m.button && m.button.payload) || null };
  if (t === 'interactive') {
    const i = m.interactive || {};
    const r = i.button_reply || i.list_reply || {};
    return { kind: 'interactive', body: r.title || '', payload: r.id || null };
  }
  if (['image', 'video', 'document', 'audio', 'sticker'].includes(t)) {
    const md = m[t] || {};
    return { kind: t, body: md.caption || (t === 'audio' ? '[audio]' : `[${t}]`), payload: md.id || null };
  }
  if (t === 'location') return { kind: 'location', body: `[ubicación] ${(m.location && (m.location.name || m.location.address)) || ''}`.trim(), payload: null };
  return { kind: t || 'unknown', body: `[${t || 'mensaje'}]`, payload: null };
}

// 규칙 고르기. 동의 규칙은 오해가 없게 좁게 맞춘다:
//   · 동의(yes): 받은 말 = 키워드 (예: 「Sí, quiero」 버튼, 「si」, 「acepto」) — 「no acepto」 같은 문장은 안 걸린다
//   · 수신거부(no): 짧은 말(4자 미만: no)은 그 말만 왔을 때, 긴 말(baja · stop · no gracias)은 문장 어디에 있어도
//   · 그 밖: 키워드가 단어 단위로 들어 있으면
export function pickRule(rules, text) {
  const t = normText(text);
  const fallback = (rules || []).find((r) => r.is_fallback && r.active !== false) || null;
  if (!t) return fallback;
  const pad = ' ' + t + ' ';
  for (const r of rules || []) {
    if (r.is_fallback || r.active === false) continue;
    const kws = (r.keywords || []).map(normText).filter(Boolean);
    let hit = false;
    for (const k of kws) {
      if (r.action === 'consent_yes') hit = t === k;
      else if (r.action === 'consent_no') hit = k.length < 4 ? t === k : pad.includes(' ' + k + ' ');
      else hit = pad.includes(' ' + k + ' ');
      if (hit) break;
    }
    if (hit) return r;
  }
  return fallback;
}

export async function loadRules(q = query) {
  return (await q(`SELECT id, sort, keywords, is_fallback, reply, buttons, action, active FROM wa_autoreplies
                    WHERE deleted_at IS NULL ORDER BY is_fallback, sort, id`)).rows.map((r) => ({ ...r, id: Number(r.id) }));
}

// 웹훅 메시지 1건. 반환 { stored, contact_id, rule_id, action } — 답장 발송은 응답 뒤로 미룬다.
export async function handleInbound(m, q = query) {
  const phone = normalizeWaNumber(m && m.from);
  if (!phone) return { stored: false };
  const p = parseInbound(m);
  const at = (() => { const n = Number(m.timestamp); return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date(); })();
  const ct = (await q(`SELECT id, consent FROM wa_contacts WHERE phone=$1 AND deleted_at IS NULL`, [phone])).rows[0] || null;
  const ins = (await q(
    `INSERT INTO wa_messages (direction, phone, contact_id, wamid, kind, body, payload, source, at)
     VALUES ('in',$1,$2,$3,$4,$5,$6,'inbound',$7)
     ON CONFLICT (wamid) WHERE direction = 'in' AND wamid IS NOT NULL DO NOTHING RETURNING id`,
    [phone, ct ? ct.id : null, m.id || null, p.kind, String(p.body || '').slice(0, 4000), p.payload, at.toISOString()])).rows[0];
  if (!ins) return { stored: false, duplicate: true };
  if (!ct) return { stored: true, contact_id: null };          // 등록 안 된 번호(사내 수신자 등) — 저장만, 자동응답 안 함
  const cid = Number(ct.id);
  const rules = await loadRules(q);
  const rule = pickRule(rules, p.body || p.payload);
  let inbox = 'open';
  if (rule && rule.action === 'consent_yes') {
    await q(`UPDATE wa_contacts SET consent='yes', consent_at=now(), consent_via=$2, ask_queued_at=NULL WHERE id=$1`, [cid, p.kind === 'text' ? 'message' : 'button']);
    inbox = null;
  } else if (rule && rule.action === 'consent_no') {
    await q(`UPDATE wa_contacts SET consent='no', consent_at=now(), consent_via=$2, ask_queued_at=NULL WHERE id=$1`, [cid, p.kind === 'text' ? 'message' : 'button']);
    inbox = null;
  } else if (rule && rule.action === 'lead') {
    await q(`UPDATE wa_contacts SET lead=true WHERE id=$1`, [cid]);
  }
  await q(`UPDATE wa_contacts SET last_in_at=GREATEST(COALESCE(last_in_at, $2::timestamptz), $2::timestamptz),
                  inbox_state = CASE WHEN $3::text IS NULL THEN inbox_state ELSE $3 END, updated_at=now() WHERE id=$1`,
    [cid, at.toISOString(), inbox]);
  if (rule && rule.reply) defer(() => sendAutoReply({ phone, cid, rule }, q));
  return { stored: true, contact_id: cid, rule_id: rule ? rule.id : null, action: rule ? rule.action : null };
}

async function sendAutoReply({ phone, cid, rule }, q) {
  if (!promoReady()) return;
  const recent = (await q(
    `SELECT 1 FROM wa_messages WHERE direction='out' AND contact_id=$1 AND source='autoreply' AND rule_id=$2
        AND at > now() - ($3 || ' hours')::interval LIMIT 1`, [cid, rule.id, String(AUTOREPLY_COOLDOWN_H)])).rows.length;
  if (recent && !['consent_yes', 'consent_no'].includes(rule.action)) return;
  if (rule.is_fallback) {
    const human = (await q(`SELECT 1 FROM wa_messages WHERE direction='out' AND contact_id=$1 AND source='manual' AND at > now() - ($2 || ' hours')::interval LIMIT 1`,
      [cid, String(HUMAN_QUIET_H)])).rows.length;
    if (human) return;      // 사람이 대화 중이면 「그 밖의 말」 자동응답은 끼어들지 않는다
  }
  let res;
  try { res = (rule.buttons || []).length ? await api.buttons({ to: phone, text: rule.reply, buttons: rule.buttons }) : await api.text({ to: phone, text: rule.reply }); }
  catch (e) { res = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
  await logOut(q, { phone, contactId: cid, kind: (rule.buttons || []).length ? 'interactive' : 'text', body: rule.reply, source: 'autoreply', ruleId: rule.id, res });
}

// 사람이 직접 답장(24시간 창 안에서만 — 창 밖은 템플릿만 가능)
export async function manualReply({ phone, text, userId }, q = query) {
  const to = normalizeWaNumber(phone);
  if (!to) return { ok: false, error: 'bad_phone' };
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'empty' };
  const open = await windowOpen(to, q);
  if (open === false) return { ok: false, error: 'window_closed' };
  const ct = (await q(`SELECT id FROM wa_contacts WHERE phone=$1 AND deleted_at IS NULL`, [to])).rows[0];
  let res;
  try { res = await api.text({ to, text: body.slice(0, 4096) }); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
  await logOut(q, { phone: to, contactId: ct ? Number(ct.id) : null, kind: 'text', body, source: 'manual', sentBy: userId, res });
  return res.ok ? { ok: true, message_id: res.message_id || null } : { ok: false, error: res.error };
}
