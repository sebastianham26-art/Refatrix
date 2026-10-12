// =====================================================================
// Refatrix ERP · leadWaRoutes.js — 고객등록 › 웹 가입 신청 WhatsApp 알림 (0268)
//   전부 디렉터 전용. 발송 로직은 src/leadWaNotify.js.
//
//   GET  /api/crm-lead-wa/status                   설정·템플릿·받는 사람(번호 유무)·최근 발송 원장
//   PUT  /api/crm-lead-wa/settings                 {notify_received, notify_assigned}
//   GET  /api/crm-lead-wa/preview?lead_id&lang&kind  실제로 보낼 문구(한 줄 변수 + 창 안 본문)
//   POST /api/crm-lead-wa/send {lead_id, kind, user_id?}  지금 발송(성공 이력 무시 — 시험·수동)
//   GET  /api/crm-lead-wa/template-guide           Meta 에서 템플릿을 만드는 방법(본문·카테고리·언어)
//
//   ★ 수신자 관리 엔드포인트가 **없다.** 받는 사람은 팝업 알림 대상
//     (`/api/crm-leads/notify-targets`)과 같은 명단이고 번호는 사용자 화면의 `wa_phone` 이다.
//     여기에 또 만들면 두 명단이 갈라진다 — 화면도 그 두 곳으로 안내만 한다.
// =====================================================================
import { query } from '../db.js';
import { authGuard, requireDirector } from '../middleware/authGuard.js';
import { logEvent } from '../audit.js';
import { waApiReady, normalizeWaNumber } from '../waSend.js';
import { webhookConfigured, explainWaError, windowState } from '../waWebhook.js';
import {
  KINDS, MAX_ATTEMPTS, LOOKBACK_HOURS, maskPhone,
  leadWaEnabled, leadWaTemplate, leadWaAssignTemplate, leadWaTemplateLang, templateFor,
  loadLeadWaSettings, loadLeadForNotify, leadRecipients, buildLeadHeadline, buildLeadText,
  sendLeadTo, notifiable,
} from '../leadWaNotify.js';

const G = { preHandler: [authGuard, requireDirector] };
const kindOf = (v) => (KINDS.includes(String(v)) ? String(v) : 'received');

/**
 * Meta 에서 템플릿을 만드는 방법 — **화면이 아니라 여기서 한 번만 정의한다.**
 *   디렉터 지시: "내가 Meta에서 템플릿을 만들수 있도록 가이드해달라는 거야"
 *   본문을 화면에 하드코딩하면 템플릿 이름·변수를 바꿀 때 코드와 안내가 갈라진다.
 *   그래서 **실제로 쓰는 이름·언어·변수 개수를 그대로 읽어** 안내를 만든다.
 */
export function templateGuide() {
  const lang = leadWaTemplateLang();
  const common = {
    category: 'Utility (유틸리티)',
    language: lang,
    language_label: lang === 'es_MX' ? 'Spanish (MEX)' : lang,
    header: '없음 (텍스트 헤더도 넣지 마세요)',
    footer: 'Refatrix ERP',
    buttons: '없음',
    variables: 1,
    sample_hint: '샘플값에는 아래 「예시」를 그대로 붙여 넣으면 됩니다(Meta 가 샘플을 요구합니다).',
  };
  return {
    where: 'WhatsApp Manager › 메시지 템플릿 › 템플릿 만들기',
    note: '카테고리를 「마케팅」으로 만들면 고객 동의가 없는 번호에 못 갑니다 — 직원 알림이므로 반드시 '
      + '「유틸리티」로 만드세요. 승인은 보통 몇 분~수 시간입니다.',
    after: '승인(활성)된 뒤 이름이 아래와 다르면 관리 › 외부 서비스 키 › WhatsApp 에서 '
      + '「가입신청 접수 알림 템플릿명」·「가입신청 담당자 지정 템플릿명」을 바꿔 주세요.',
    items: [
      {
        kind: 'received',
        title: '① 가입신청 접수 → 디렉터·알림 대상자',
        name: leadWaTemplate(),
        ...common,
        body: '🌐 Refatrix — nueva solicitud del catálogo web\n\n{{1}}\n\n'
          + 'Abra el ERP › Clientes › Solicitudes web para asignar un asesor.',
        sample: 'REFACCIONES DEL NORTE · Juan Pérez · 8112345678 · juan@norte.mx · RFC RNO950612BB2 · Monterrey, NL',
      },
      {
        kind: 'assigned',
        title: '② 담당자 지정 → 지정된 담당자',
        name: leadWaAssignTemplate(),
        ...common,
        body: '🙋 Refatrix — se le asignó una solicitud del catálogo web\n\n{{1}}\n\n'
          + 'Abra el ERP › Clientes › Solicitudes web.',
        sample: 'REFACCIONES DEL NORTE · Juan Pérez · 8112345678 · Monterrey, NL · Asignó: Sebastián',
      },
    ],
  };
}

const settingsOut = (s) => ({ notify_received: s.notify_received !== false, notify_assigned: s.notify_assigned !== false });

export default async function leadWaRoutes(app) {
  // 0268 미적용 배포에서도 화면이 뜨게 — 원장 테이블이 없으면 빈 목록을 돌려준다.
  async function recentSends(limit = 30) {
    try {
      return (await query(
        `SELECT s.id, s.lead_id, s.kind, s.user_id, u.name AS user_name, s.to_masked, s.status,
                s.message_id, s.error, s.attempts, s.sent_at, s.updated_at,
                l.empresa, l.crm_lead_code,
                st.status AS dlv_status, st.error_code AS dlv_code, st.error_title AS dlv_title,
                st.error_detail AS dlv_detail
           FROM crm_lead_wa_sends s
           LEFT JOIN users u ON u.id = s.user_id
           LEFT JOIN crm_web_leads l ON l.id = s.lead_id
           LEFT JOIN wa_message_status st ON st.message_id = s.message_id
          ORDER BY s.updated_at DESC LIMIT $1`, [limit])).rows;
    } catch (_) { return null; }     // 0268(또는 0253) 미적용
  }

  app.get('/api/crm-lead-wa/status', G, async () => {
    const rows = await recentSends();
    const set = await loadLeadWaSettings();
    // 받는 사람 명단 + 번호 유무. **번호가 없는 사람을 숨기지 않는다** — 안 보여 주면
    //   「왜 나는 안 와요」가 원인 불명으로 남는다.
    let targets = [];
    try {
      targets = (await query(
        `SELECT u.id, u.name, u.role, u.wa_phone, COALESCE(u.lang,'ko') AS lang
           FROM users u
          WHERE u.deleted_at IS NULL AND u.role <> 'viewer'
            AND (u.role = 'director' OR EXISTS (SELECT 1 FROM crm_lead_notify_targets t WHERE t.user_id = u.id))
          ORDER BY (u.role='director') DESC, u.name`)).rows;
    } catch (_) { targets = []; }
    const withWin = [];
    for (const t of targets) {
      const p = normalizeWaNumber(t.wa_phone);
      const ws = p ? await windowState(p) : { open: null };
      withWin.push({ id: Number(t.id), name: t.name, role: t.role, lang: t.lang,
        wa_phone_masked: maskPhone(p), has_phone: !!p, window_open: ws.open });
    }
    return {
      migrated: rows !== null,
      enabled: leadWaEnabled(),
      api_ready: waApiReady(),
      webhook: webhookConfigured(),
      template: leadWaTemplate(), template_set: !!process.env.LEAD_WA_TEMPLATE,
      assign_template: leadWaAssignTemplate(), assign_template_set: !!process.env.LEAD_WA_ASSIGN_TEMPLATE,
      template_lang: leadWaTemplateLang(),
      settings: settingsOut(set),
      max_attempts: MAX_ATTEMPTS, lookback_hours: LOOKBACK_HOURS,
      targets: withWin,
      no_phone_count: withWin.filter((t) => !t.has_phone).length,
      recent: (rows || []).map((x) => {
        const o = { ...x, lead_id: Number(x.lead_id), user_id: Number(x.user_id), attempts: Number(x.attempts) };
        if (x.dlv_status === 'failed') {
          o.dlv_reason = explainWaError(x.dlv_code, x.dlv_title) + (x.dlv_detail ? ` — ${x.dlv_detail}` : '');
        }
        return o;
      }),
    };
  });

  app.get('/api/crm-lead-wa/template-guide', G, async () => templateGuide());

  app.put('/api/crm-lead-wa/settings', G, async (req, reply) => {
    const b = req.body || {};
    const bool = (v, cur) => (v === undefined ? cur : v === true || v === 'true' || v === 1 || v === '1');
    const cur = await loadLeadWaSettings();
    const next = {
      notify_received: bool(b.notify_received, cur.notify_received),
      notify_assigned: bool(b.notify_assigned, cur.notify_assigned),
    };
    try {
      await query(
        `INSERT INTO crm_lead_wa_settings (id, notify_received, notify_assigned, updated_by, updated_at)
         VALUES (1,$1,$2,$3,now())
         ON CONFLICT (id) DO UPDATE SET notify_received=$1, notify_assigned=$2, updated_by=$3, updated_at=now()`,
        [next.notify_received, next.notify_assigned, req.ctx.perm.userId]);
    } catch (_) {
      return reply.code(503).send({ error: 'migration_required',
        note: '0268_lead_wa_notify 마이그레이션이 필요합니다. Railway 콘솔에서 npm run migrate 를 실행하세요.' });
    }
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: 'crm_lead_wa:settings', detail: next });
    return { ok: true, settings: next };
  });

  app.get('/api/crm-lead-wa/preview', G, async (req, reply) => {
    const kind = kindOf(req.query.kind);
    let id = Number(req.query.lead_id) || 0;
    if (!id) {
      try {
        id = Number((await query(
          `SELECT id FROM crm_web_leads WHERE status NOT IN ('dismissed','done')
            ORDER BY received_at DESC LIMIT 1`)).rows[0]?.id || 0);
      } catch (_) { id = 0; }
    }
    if (!id) return reply.code(404).send({ error: 'no_lead', note: '미리 볼 가입신청이 없습니다.' });
    const lead = await loadLeadForNotify(id);
    if (!lead) return reply.code(404).send({ error: 'no_lead' });
    const lang = req.query.lang === 'es' ? 'es' : 'ko';
    return {
      lead_id: Number(lead.id), kind, lang, empresa: lead.empresa || null,
      template: templateFor(kind), template_lang: leadWaTemplateLang(),
      // 창 밖(대부분의 경우) 템플릿 {{1}} 에 들어가는 값
      headline: buildLeadHeadline(lead, lang, kind),
      // 창이 열려 있을 때만 쓰는 자유 문구
      text: buildLeadText(lead, lang, kind),
    };
  });

  app.post('/api/crm-lead-wa/send', G, async (req, reply) => {
    const b = req.body || {};
    const kind = kindOf(b.kind);
    const id = Number(b.lead_id) || 0;
    if (!id) return reply.code(400).send({ error: 'lead_required', note: '보낼 가입신청을 고르세요.' });
    const lead = await loadLeadForNotify(id);
    if (!lead) return reply.code(404).send({ error: 'no_lead' });
    if (!notifiable(lead)) {
      return reply.code(409).send({ error: 'lead_closed',
        note: '이미 닫힌 신청입니다(처리 완료·무시). 알림을 보내면 사람을 헛되게 부릅니다.' });
    }
    if (!waApiReady()) {
      return reply.code(409).send({ error: 'wa_not_configured',
        note: 'WhatsApp 토큰·발신번호가 설정되지 않았습니다. 관리 › 외부 서비스 키에서 넣어 주세요.' });
    }
    let users = await leadRecipients(lead, kind);
    if (b.user_id) users = users.filter((u) => Number(u.id) === Number(b.user_id));
    if (!users.length) {
      return reply.code(409).send({ error: 'no_recipient',
        note: kind === 'assigned'
          ? '담당자가 지정되지 않은 신청입니다.'
          : '받는 사람이 없습니다 — 관리 › 연동관리 › 팝업 알림 대상에서 지정하세요.' });
    }
    // force: 성공 이력·시도 상한을 무시한다(사람이 직접 누른 것이므로).
    const out = [];
    for (const u of users) out.push(await sendLeadTo(lead, kind, u, { force: true }));
    await logEvent({ userId: req.ctx.perm.userId, action: 'update', target: `crm_lead_wa:${id}`,
      detail: { kind, manual: true, sent: out.filter((r) => r.ok).length, total: out.length } });
    return { ok: true, lead_id: id, kind, results: out };
  });
}
