// =====================================================================
// Refatrix ERP · leadWaNotify.js — 웹 카달록 **가입신청** WhatsApp 알림 (0268 · 2026-10-12 디렉터 지시)
//
//   디렉터 지시:
//     "가입신청이 접수되면 디렉터가 담당자를 지정하는데, whatsapp으로 자동전송되도록 만들어줘.
//      ① 디렉터에게 가입신청 내용을 발송 ② 디렉터가 담당자를 지정하면 담당자에게 전송"
//
//   두 가지 알림:
//     kind='received'  가입신청 접수 → **팝업 알림 대상자 + 디렉터**(crm_lead_notify_targets · 0210)
//     kind='assigned'  담당자 지정   → **지정된 그 사람**
//
//   ★ 수신자 표를 새로 만들지 않았다. 받는 사람은 팝업 알림 대상과 **같은 명단**이고,
//     번호는 `users.wa_phone`(0165 · 사용자 화면에서 디렉터가 설정)을 쓴다.
//     표를 또 만들면 「팝업은 오는데 WhatsApp 은 안 오는 사람」이 생기고, 그 불일치는
//     아무도 버그로 신고하지 않은 채 신뢰만 깎는다.
//
//   언제: 접수·지정 직후 바로(kick — 응답 뒤, 기다리지 않음) + 60초마다 놓친 건 줍기
//         (최근 24시간 · 시도 3회까지). 원장 유니크 (lead_id, kind, user_id) 가 1회 가드다.
//
//   발송 규칙: **템플릿 우선.** 24시간 창이 「열림」으로 확실할 때만 자유 텍스트를 쓴다.
//     이건 2026-10-08/09 에 두 번 사고가 난 자리다 — Meta 는 창 밖 자유 텍스트도 일단
//     「접수」로 답하고 나중에 131047 로 버리므로, 원장엔 성공·휴대폰엔 미도착이 된다.
//     그래서 공용 sendWaTo 의 규칙(waSend.js:154~)을 그대로 따른다.
//
//   본문 언어: 받는 사람의 `users.lang`(ko|es). 템플릿 **껍데기는 스페인어 한 벌**이고
//     변수 {{1}} 안에 든 내용만 언어가 바뀐다 — nueva_cotizacion 이 쓰는 방식 그대로다.
//     (템플릿을 언어마다 승인받게 하면 디렉터가 Meta 에서 할 일이 두 배가 된다.)
//
//   끄기: 화면 토글 2개(crm_lead_wa_settings) · 전체는 LEAD_WA_ENABLED=0
// =====================================================================
import { query } from './db.js';
import { sendWaTo, waApiReady, normalizeWaNumber, waParam } from './waSend.js';
import { windowState } from './waWebhook.js';

export const MAX_ATTEMPTS = 3;
export const LOOKBACK_HOURS = 24;
export const STALE_CLAIM_MIN = 5;
export const KINDS = ['received', 'assigned'];

let senderOverride = null;                     // 테스트용 — 실제 Meta 호출 없이 무엇이 나갔는지 본다
export function setLeadWaSender(fn) { senderOverride = fn || null; }

export const leadWaEnabled = () => process.env.LEAD_WA_ENABLED !== '0';
/** ① 접수 알림 템플릿. 이름은 Meta 에서 승인받은 것과 같아야 한다(화면 가이드 참고). */
export const leadWaTemplate = () => process.env.LEAD_WA_TEMPLATE || 'nuevo_registro_web';
/** ② 담당자 지정 알림 템플릿. */
export const leadWaAssignTemplate = () => process.env.LEAD_WA_ASSIGN_TEMPLATE || 'registro_web_asignado';
export const leadWaTemplateLang = () =>
  process.env.LEAD_WA_TEMPLATE_LANG || process.env.WHATSAPP_TEMPLATE_LANG || 'es_MX';

export const templateFor = (kind) => (kind === 'assigned' ? leadWaAssignTemplate() : leadWaTemplate());

export const maskPhone = (p) => { const s = String(p || ''); return s ? s.slice(0, 3) + '****' + s.slice(-4) : null; };

// ── 설정 ────────────────────────────────────────────────────────────
//   0268 전 배포에서도 죽지 않는다 — 테이블이 없으면 둘 다 켜진 것으로 본다(기존 기본값).
export async function loadLeadWaSettings(q = query) {
  try {
    const r = (await q(`SELECT notify_received, notify_assigned FROM crm_lead_wa_settings WHERE id=1`)).rows[0];
    if (r) return { notify_received: r.notify_received !== false, notify_assigned: r.notify_assigned !== false };
  } catch (_) { /* 0268 미적용 */ }
  return { notify_received: true, notify_assigned: true };
}

export function kindEnabled(set, kind) {
  return kind === 'assigned' ? set.notify_assigned !== false : set.notify_received !== false;
}

// ── 본문 ────────────────────────────────────────────────────────────
/** 한 줄 요약 — 템플릿 변수 {{1}} 에 들어간다. Meta 규칙상 줄바꿈이 못 들어가므로 ` · ` 로 잇는다. */
export function buildLeadHeadline(lead, lang = 'ko', kind = 'received') {
  const L = (ko, es) => (lang === 'es' ? es : ko);
  const name = [lead.nombre, lead.apellido].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
  const where = [lead.ciudad, lead.estado].map((v) => String(v || '').trim()).filter(Boolean).join(', ');
  const bits = [];
  bits.push(String(lead.empresa || '').trim() || L('상호 미기재', 'Sin razón social'));
  if (name) bits.push(name);
  if (lead.telefono) bits.push(String(lead.telefono).trim());
  if (lead.correo) bits.push(String(lead.correo).trim());
  if (lead.rfc) bits.push('RFC ' + String(lead.rfc).trim());
  if (where) bits.push(where);
  if (kind === 'assigned' && lead.assigned_by_name) {
    bits.push(L('지정: ' + lead.assigned_by_name, 'Asignó: ' + lead.assigned_by_name));
  }
  // ⚠ waParam 이 줄바꿈·탭을 지우고 빈 값을 '—' 로 바꾼다(Meta 가 거절하는 형태를 막는다).
  return waParam(bits.join(' · '));
}

/** 창이 열려 있을 때 쓰는 자유 텍스트 — 여기서는 줄바꿈을 쓸 수 있다. */
export function buildLeadText(lead, lang = 'ko', kind = 'received') {
  const L = (ko, es) => (lang === 'es' ? es : ko);
  const row = (k, v) => (String(v || '').trim() ? `${k}: ${String(v).trim()}` : null);
  const name = [lead.nombre, lead.apellido].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
  const head = kind === 'assigned'
    ? L('🙋 웹카달록 가입신청 담당자로 지정되셨습니다', '🙋 Se le asignó una solicitud del catálogo web')
    : L('🌐 웹카달록 가입신청이 접수되었습니다', '🌐 Nueva solicitud del catálogo web');
  const lines = [
    row(L('상호', 'Empresa'), lead.empresa),
    row(L('담당자', 'Contacto'), name),
    row(L('전화', 'Teléfono'), lead.telefono),
    row(L('이메일', 'Correo'), lead.correo),
    row('RFC', lead.rfc),
    row(L('지역', 'Ciudad'), [lead.ciudad, lead.estado].filter(Boolean).join(', ')),
    row(L('메시지', 'Mensaje'), lead.mensaje),
  ].filter(Boolean);
  if (kind === 'assigned' && lead.assigned_by_name) {
    lines.push(row(L('지정', 'Asignó'), lead.assigned_by_name));
  }
  const tail = kind === 'assigned'
    ? L('ERP › 영업 › 고객등록 › 웹 가입 신청 에서 확인하세요.', 'Abra el ERP › Clientes › Solicitudes web.')
    : L('ERP › 영업 › 고객등록 › 웹 가입 신청 에서 담당자를 지정하세요.',
        'Abra el ERP › Clientes › Solicitudes web para asignar un asesor.');
  return `*${head}*\n\n${lines.join('\n')}\n\n${tail}`;
}

// ── 수신자 ──────────────────────────────────────────────────────────
/**
 * 이 가입신청·이 종류에 대해 **WhatsApp 을 받을 사람**.
 *   received  → 팝업 알림 대상자 + 디렉터(항상). `/api/crm-leads/notify-targets` 와 **같은 명단**이다.
 *   assigned  → 지정된 그 사람 한 명.
 * 번호가 없는 사람은 `wa_phone: null` 로 함께 돌려준다 — 화면이 「번호 미등록」을 보여 줘야
 * 디렉터가 사용자 화면에서 채울 수 있다. 조용히 빼면 왜 안 오는지 아무도 모른다.
 */
export async function leadRecipients(lead, kind, q = query) {
  if (kind === 'assigned') {
    if (!lead.assigned_to) return [];
    return (await q(
      `SELECT id, name, wa_phone, COALESCE(lang,'es') AS lang FROM users
        WHERE id=$1 AND deleted_at IS NULL`, [lead.assigned_to])).rows;
  }
  return (await q(
    `SELECT u.id, u.name, u.wa_phone, COALESCE(u.lang,'ko') AS lang FROM users u
      WHERE u.deleted_at IS NULL AND u.role <> 'viewer'
        AND (u.role = 'director' OR EXISTS (SELECT 1 FROM crm_lead_notify_targets t WHERE t.user_id = u.id))
      ORDER BY (u.role='director') DESC, u.name`)).rows;
}

export async function loadLeadForNotify(leadId, q = query) {
  return (await q(
    `SELECT l.id, l.crm_lead_code, l.empresa, l.nombre, l.apellido, l.telefono, l.correo, l.rfc,
            l.ciudad, l.estado, l.mensaje, l.status, l.assigned_to, l.received_at,
            ab.name AS assigned_by_name
       FROM crm_web_leads l
       LEFT JOIN users ab ON ab.id = l.assigned_by
      WHERE l.id = $1`, [leadId])).rows[0] || null;
}

/** 닫힌 건에는 보내지 않는다 — 이미 처리가 끝난 신청으로 사람을 부르면 안 된다. */
export const notifiable = (lead) => !!lead && !['dismissed', 'done'].includes(String(lead.status || ''));

// ── 1명에게 1건 ─────────────────────────────────────────────────────
/** force = 성공 이력·시도 상한을 무시한다(시험 발송·수동 재발송). */
export async function sendLeadTo(lead, kind, user, { force = false, q = query } = {}) {
  const phone = normalizeWaNumber(user.wa_phone);
  const claim = (await q(
    `INSERT INTO crm_lead_wa_sends (lead_id, kind, user_id, to_masked, status, attempts, claimed_at, updated_at)
     VALUES ($1, $2, $3, $4, 'sending', 0, now(), now())
     ON CONFLICT (lead_id, kind, user_id) DO UPDATE SET status = 'sending', claimed_at = now(), updated_at = now()
      WHERE ($5 OR (crm_lead_wa_sends.sent_at IS NULL AND crm_lead_wa_sends.attempts < $6))
        AND (crm_lead_wa_sends.status IS DISTINCT FROM 'sending'
             OR crm_lead_wa_sends.claimed_at < now() - ($7 || ' minutes')::interval)
     RETURNING id`,
    [lead.id, kind, user.id, maskPhone(phone), !!force, MAX_ATTEMPTS, String(STALE_CLAIM_MIN)])).rows[0];
  if (!claim) return { user_id: Number(user.id), skipped: 'claimed_or_done' };

  // 번호가 없으면 **시도로 세지 않고** skipped 로 남긴다. attempts 를 올리면 번호를 나중에
  //   채워 넣어도 3회를 넘겨 영원히 안 가는 사람이 생긴다.
  if (!phone) {
    await q(
      `UPDATE crm_lead_wa_sends SET status='skipped', error=$2, claimed_at=NULL, updated_at=now()
        WHERE id=$1`, [claim.id, 'wa_phone 미등록 — 사용자 화면에서 WhatsApp 번호를 넣어 주세요']);
    return { user_id: Number(user.id), ok: false, status: 'skipped', error: 'no_wa_phone' };
  }

  const lang = user.lang === 'es' ? 'es' : 'ko';
  const ws = await windowState(phone, q);
  const sender = senderOverride || sendWaTo;
  let res;
  try {
    res = await sender({
      to: phone,
      text: buildLeadText(lead, lang, kind).slice(0, 4000),
      headline: buildLeadHeadline(lead, lang, kind),
      templateName: templateFor(kind),
      templateLang: leadWaTemplateLang(),
      windowOpen: ws.open,
    });
  } catch (e) { res = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }

  const STATUS = { template: 'sent_template', text: 'sent_text' };
  const status = res.ok ? (STATUS[res.mode] || 'sent_text') : 'failed';
  await q(
    `UPDATE crm_lead_wa_sends SET status=$2, message_id=COALESCE($3, message_id), error=$4,
            attempts = attempts + 1, sent_at = CASE WHEN $5 THEN now() ELSE sent_at END,
            claimed_at = NULL, updated_at = now()
      WHERE id=$1`,
    [claim.id, status, res.message_id || null,
     res.ok ? (res.text_error || null) : (res.error || 'error'), !!res.ok]);
  return { user_id: Number(user.id), ok: !!res.ok, status, error: res.ok ? null : res.error };
}

// ── 가입신청 1건 → 받을 사람 전부 ───────────────────────────────────
export async function notifyLead(leadId, kind, { q = query, settings = null } = {}) {
  if (!leadWaEnabled()) return { skipped: 'disabled' };
  if (!KINDS.includes(kind)) return { skipped: 'bad_kind' };
  if (!waApiReady() && !senderOverride) return { skipped: 'wa_not_configured' };
  const set = settings || await loadLeadWaSettings(q);
  if (!kindEnabled(set, kind)) return { skipped: 'kind_off' };
  const lead = await loadLeadForNotify(leadId, q);
  if (!notifiable(lead)) return { skipped: 'not_notifiable' };
  const users = await leadRecipients(lead, kind, q);
  const out = [];
  for (const u of users) out.push(await sendLeadTo(lead, kind, u, { q }));
  return { lead_id: Number(lead.id), kind, results: out };
}

/** 응답을 돌려준 뒤 바로(기다리지 않음). 실패해도 60초 줍기가 다시 시도한다. */
export function kickLeadNotify(leadId, kind, app = null) {
  if (!leadId || !leadWaEnabled()) return;
  setTimeout(() => {
    notifyLead(Number(leadId), kind).catch((e) =>
      app && app.log && app.log.warn({ err: String(e && e.message) }, '[lead-wa] kick failed'));
  }, 300);
}

// ── 놓친 건 줍기 ────────────────────────────────────────────────────
//   최근 24시간 가입신청 중, 받을 사람이 있는데 아직 성공 기록도 없고 시도 상한도 안 넘긴 건.
//   ⚠ 'skipped'(번호 미등록)는 attempts 를 올리지 않으므로, 번호를 채우면 다음 tick 에 나간다.
export async function runLeadNotifyJob({ q = query } = {}) {
  if (!leadWaEnabled()) return { skipped: 'disabled' };
  if (!waApiReady() && !senderOverride) return { skipped: 'wa_not_configured' };
  const set = await loadLeadWaSettings(q);
  if (!set.notify_received && !set.notify_assigned) return { skipped: 'all_off' };
  const rows = (await q(
    `SELECT l.id, k.kind
       FROM crm_web_leads l
       CROSS JOIN (SELECT 'received' AS kind UNION ALL SELECT 'assigned') k
      WHERE l.status NOT IN ('dismissed','done')
        AND l.received_at > now() - ($1 || ' hours')::interval
        AND (k.kind = 'received' OR l.assigned_to IS NOT NULL)
        AND EXISTS (
          SELECT 1 FROM users u
           WHERE u.deleted_at IS NULL AND u.role <> 'viewer'
             AND (CASE WHEN k.kind = 'assigned' THEN u.id = l.assigned_to
                       ELSE (u.role = 'director'
                             OR EXISTS (SELECT 1 FROM crm_lead_notify_targets t WHERE t.user_id = u.id)) END)
             AND NOT EXISTS (
               SELECT 1 FROM crm_lead_wa_sends s
                WHERE s.lead_id = l.id AND s.kind = k.kind AND s.user_id = u.id
                  AND (s.sent_at IS NOT NULL OR s.attempts >= $2)))
      ORDER BY l.received_at LIMIT 50`, [String(LOOKBACK_HOURS), MAX_ATTEMPTS])).rows;
  const done = [];
  for (const r of rows) {
    if (!kindEnabled(set, r.kind)) continue;
    done.push(await notifyLead(Number(r.id), r.kind, { q, settings: set }));
  }
  return { checked: rows.length, done };
}

export function startLeadNotifyWorker(app) {
  if (globalThis.__refatrixLeadWaWorker) return;
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { await runLeadNotifyJob({}); }
    // 0268 전이면 테이블이 없다 — 조용히 넘어간다(배포 순서가 어긋나도 서버는 살아 있어야 한다).
    catch (e) { app && app.log && app.log.warn({ err: String(e && e.message) }, '[lead-wa] job failed'); }
    finally { busy = false; }
  };
  globalThis.__refatrixLeadWaWorker = setInterval(() => { tick(); }, 60000);
  setTimeout(() => { tick(); }, 35000);     // 견적 알림(30초)과 겹치지 않게 조금 뒤
}
