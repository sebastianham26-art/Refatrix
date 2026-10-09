// =====================================================================
// Refatrix ERP · waSend.js — WhatsApp Cloud API 발송 (오늘 요약 자동 보고용)
//   디렉터 요청(2026-08-01): 멕시코 기준 매일 05:00 에 전일 「오늘 요약」을
//   디렉터 WhatsApp 으로 자동 발송.
//
//   ── 필요한 Railway 환경변수 (전부 있어야 발송 활성) ──
//   · WHATSAPP_TOKEN        Meta(WhatsApp Business Cloud API) 영구 토큰
//   · WHATSAPP_PHONE_ID     발신 전화번호 ID (Meta Business 관리자에서 확인)
//   · DAILY_SUMMARY_WA_TO   수신 번호(국가코드 포함 숫자만, 예: 528112345678 — 구 형식 521… 도 발송 시 52… 로 보정)
//   ── 선택 ──
//   · WHATSAPP_TEMPLATE       승인된 템플릿 이름(24시간 창 밖 폴백용, 본문 {{1}} 1개)
//   · WHATSAPP_TEMPLATE_LANG  템플릿 언어 코드(기본 es_MX)
//   · WHATSAPP_API_VERSION    기본 v20.0
//   · DAILY_WA_ENABLED=0      기능 끄기
//
//   ── 발송 규칙(Meta 정책) ──
//   · 자유 텍스트는 수신자가 최근 24시간 내 이 번호로 메시지를 보낸 경우에만 도달.
//     → 1차: 텍스트 발송 시도. 실패(재참여 필요 등) 시 템플릿이 설정돼 있으면
//       한 줄 헤드라인 파라미터로 템플릿 폴백(템플릿 파라미터는 줄바꿈 불가).
//   · 매일 확실히 받으려면: 디렉터 폰에서 이 비즈니스 번호에 아무 메시지나
//     한 번 보내두거나(24h 창), {{1}} 본문 템플릿을 승인받아 두는 것을 권장.
// =====================================================================

const API_VER = () => process.env.WHATSAPP_API_VERSION || 'v20.0';
const TIMEOUT_MS = 30000;

export function waEnabled() {
  if (process.env.DAILY_WA_ENABLED === '0') return false;
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID && process.env.DAILY_SUMMARY_WA_TO);
}

// 토큰·발신번호만 있으면 임의 수신자 발송 가능(오퍼시트 등 — 수신번호는 호출 시 지정)
export function waApiReady() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
}

// 전화번호 → WhatsApp 수신 형식(숫자만). 멕시코 규칙(2026-10-06 디렉터 지시: 521 → 52):
//   10자리(로컬) → 52+10자리 · 구 형식 521+10자리(13자리) → 52+10자리로 보정 · 52+10자리(12)면 그대로.
//   멕시코는 2019년에 휴대폰 앞 '1'이 폐지됐고, WhatsApp 수신 형식도 52+10자리다.
export function normalizeWaNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) d = '52' + d;
  else if (d.length === 13 && d.startsWith('521')) d = '52' + d.slice(3);
  if (d.length < 11 || d.length > 15) return null;
  return d;
}

export function waConfig() {
  const to = String(process.env.DAILY_SUMMARY_WA_TO || '');
  return {
    enabled: waEnabled(),
    token_set: !!process.env.WHATSAPP_TOKEN,
    phone_id_set: !!process.env.WHATSAPP_PHONE_ID,
    to_masked: to ? (to.slice(0, 3) + '****' + to.slice(-4)) : null,
    template: process.env.WHATSAPP_TEMPLATE || null,
    template_lang: process.env.WHATSAPP_TEMPLATE_LANG || 'es_MX',
  };
}

// 요약 마크다운 → WhatsApp 텍스트(굵게 * 변환 · 헤더 정리 · 길이 제한)
export function mdToWaText(title, md, maxLen = 3800) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [`*${title}*`, ''];
  for (const raw of lines) {
    let t = raw.replace(/\s+$/, '');
    if (!t.trim()) { out.push(''); continue; }
    let m;
    if ((m = /^#{1,4}\s+(.*)$/.exec(t.trim()))) { out.push(`*■ ${m[1]}*`); continue; }
    t = t.replace(/\*\*([^*]+)\*\*/g, '*$1*');           // **굵게** → *굵게*(WA 표기)
    t = t.replace(/^\s*[-*•]\s+/, '• ');
    out.push(t);
  }
  let text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > maxLen) text = text.slice(0, maxLen) + '\n…(이하 생략 — ERP 오늘 요약에서 전체 확인)';
  return text;
}

// 템플릿 폴백용 한 줄 헤드라인(템플릿 파라미터는 줄바꿈·탭 금지)
export function buildWaHeadline(dateLabel, stats) {
  const s = stats || {};
  const n = (v) => Number(v) || 0;
  const parts = [];
  if (n(s.schedule)) parts.push(`일정 ${n(s.schedule)}`);
  if (n(s.todos)) parts.push(`할일 ${n(s.todos)}`);
  if (n(s.quotes)) parts.push(`견적 ${n(s.quotes)}`);
  if (n(s.invoices)) parts.push(`매출 ${n(s.invoices)}`);
  if (n(s.txn_in)) parts.push(`입금 $${n(s.txn_in).toLocaleString('en-US')}`);
  if (n(s.txn_out)) parts.push(`출금 $${n(s.txn_out).toLocaleString('en-US')}`);
  if (n(s.activity)) parts.push(`활동 ${n(s.activity)}건`);
  const body = parts.length ? parts.join(' · ') : '기록 없음';
  return `[Refatrix 오늘 요약] ${dateLabel} — ${body} (상세: ERP 일정>오늘 요약)`.slice(0, 950);
}

async function callGraph(payload) {
  // 발송 직전 한 번 더 정규화 — DB·환경변수(DAILY_SUMMARY_WA_TO)에 남은 구 형식 521… 도 52… 로 나간다.
  if (payload && payload.to) { const n = normalizeWaNumber(payload.to); if (n) payload = { ...payload, to: n }; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`https://graph.facebook.com/${API_VER()}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const e = data && data.error ? data.error : {};
      return { ok: false, code: e.code || resp.status, error: (e.message || ('http_' + resp.status)).slice(0, 300) };
    }
    const id = data && data.messages && data.messages[0] && data.messages[0].id;
    return { ok: true, message_id: id || null };
  } catch (e) {
    return { ok: false, code: null, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}

export async function sendWaText(text, to = null) {
  return callGraph({
    messaging_product: 'whatsapp',
    to: String(to || process.env.DAILY_SUMMARY_WA_TO),
    type: 'text',
    text: { body: String(text || '').slice(0, 4096), preview_url: false },
  });
}

export async function sendWaTemplate(param, opts = {}) {
  const name = opts.name || process.env.WHATSAPP_TEMPLATE;
  if (!name) return { ok: false, code: null, error: 'no_template' };
  return callGraph({
    messaging_product: 'whatsapp',
    to: String(opts.to || process.env.DAILY_SUMMARY_WA_TO),
    type: 'template',
    template: {
      name,
      language: { code: opts.lang || process.env.WHATSAPP_TEMPLATE_LANG || 'es_MX' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: String(param || '').replace(/[\n\t]+/g, ' ').slice(0, 1024) }] }],
    },
  });
}

// 임의 수신자 발송(오퍼시트 등): ① 텍스트 → ② 실패 시 템플릿 헤드라인 폴백
//   templateName 우선순위: 인자 > OFFERSHEET_WA_TEMPLATE(호출부에서 지정) > WHATSAPP_TEMPLATE
//   windowOpen === false(웹훅으로 24시간 창이 닫힌 것을 안다) + 템플릿 있음 → 템플릿부터.
//   자유 텍스트는 창 밖이어도 API 가 「접수」하고 나중에 웹훅으로 실패를 알려 오므로, 미리 아는 경우엔 건너뛴다.
export async function sendWaTo({ to, text, headline, templateName = null, templateLang = null, windowOpen = null }) {
  if (!waApiReady()) return { ok: false, mode: null, error: 'wa_not_configured' };
  if (!to) return { ok: false, mode: null, error: 'no_recipient' };
  const tplName = templateName || process.env.WHATSAPP_TEMPLATE;
  // 1009 · 창이 「열림」으로 확실하지 않으면(닫힘·모름) 템플릿 먼저 — 자유 문장은 창 밖이면 API 는 받아도 도착하지 않는다(#131047).
  if (windowOpen !== true && tplName) {
    const t0 = await sendWaTemplate(headline, { to, name: tplName, lang: templateLang });
    if (t0.ok) return { ok: true, mode: 'template', message_id: t0.message_id, text_error: windowOpen === false ? 'window_closed' : null };
    if (windowOpen === false) return { ok: false, mode: null, error: `template ${tplName}: ${t0.error}${t0.code ? ' #' + t0.code : ''} (24시간 창 밖 — 텍스트는 도착하지 않아 보내지 않음)`, code: t0.code };
    const tx = await sendWaText(text, to);
    if (tx.ok) return { ok: true, mode: 'text', message_id: tx.message_id, text_error: `template: ${t0.error}${t0.code ? ' #' + t0.code : ''} — 텍스트로 보냄(24시간 창 밖이면 도착 안 함)` };
    return { ok: false, mode: null, error: `template: ${t0.error} / text: ${tx.error}`, code: t0.code };
  }
  if (windowOpen === false) return { ok: false, mode: null, error: 'no_template (24시간 창 밖 — 템플릿 이름을 설정하세요)' };
  const first = await sendWaText(text, to);
  if (first.ok) return { ok: true, mode: 'text', message_id: first.message_id };
  const fb = await sendWaTemplate(headline, { to, name: templateName || process.env.WHATSAPP_TEMPLATE, lang: templateLang });
  if (fb.ok) return { ok: true, mode: 'template', message_id: fb.message_id, text_error: first.error };
  return { ok: false, mode: null, error: `text: ${first.error}` + (fb.error !== 'no_template' ? ` / template: ${fb.error}` : ''), code: first.code };
}

// 요약 1건 발송: ① 자유 텍스트 → ② 실패 시(24h 창 밖 등) 템플릿 헤드라인 폴백
export async function sendDailySummaryWa({ dateLabel, content_md, stats, windowOpen = true }) {
  if (!waEnabled()) return { ok: false, mode: null, error: 'wa_not_configured' };
  const text = mdToWaText(`📋 Refatrix 오늘 요약 · ${dateLabel}`, content_md);
  if (windowOpen !== true) {   // 1009 · 창 닫힘·모름 → 템플릿 먼저
    const t0 = await sendWaTemplate(buildWaHeadline(dateLabel, stats));
    if (t0.ok) return { ok: true, mode: 'template', message_id: t0.message_id };
    if (windowOpen === false) return { ok: false, mode: null, error: `template: ${t0.error} (24시간 창 밖)`, code: t0.code };
  }
  const first = await sendWaText(text);
  if (first.ok) return { ok: true, mode: 'text', message_id: first.message_id };
  const fb = await sendWaTemplate(buildWaHeadline(dateLabel, stats));
  if (fb.ok) return { ok: true, mode: 'template', message_id: fb.message_id, text_error: first.error };
  return { ok: false, mode: null, error: `text: ${first.error}` + (fb.error !== 'no_template' ? ` / template: ${fb.error}` : ''), code: first.code };
}

// ── 이미지 발송(일일 자금·월간실적, 2026-09-30) ──
//   ① 미디어 업로드(POST /{phone_id}/media, multipart) → media id (30일 유효, 여러 수신자 재사용)
//   ② type:image 메시지(캡션) — 24시간 창 안에서만 도달
//   ③ (선택) 이미지 헤더 템플릿 — 헤더 IMAGE + 본문 {{1}} 로 승인된 템플릿이면 창 밖에서도 도달
export async function uploadWaMedia(buf, { mime = 'image/png', filename = 'report.png' } = {}) {
  if (!waApiReady()) return { ok: false, error: 'wa_not_configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([buf], { type: mime }), filename);
    const resp = await fetch(`https://graph.facebook.com/${API_VER()}/${process.env.WHATSAPP_PHONE_ID}/media`, {
      method: 'POST', headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }, body: form, signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.id) { const e = (data && data.error) || {}; return { ok: false, code: e.code || resp.status, error: (e.message || ('http_' + resp.status)).slice(0, 300) }; }
    return { ok: true, id: String(data.id) };
  } catch (e) {
    return { ok: false, code: null, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}

export async function sendWaImage({ to, mediaId, caption = '' }) {
  return callGraph({ messaging_product: 'whatsapp', to: String(to), type: 'image',
    image: { id: String(mediaId), caption: String(caption || '').slice(0, 1024) } });
}

export async function sendWaImageTemplate({ to, mediaId, param, name, lang = null }) {
  if (!name) return { ok: false, code: null, error: 'no_template' };
  return callGraph({ messaging_product: 'whatsapp', to: String(to), type: 'template',
    template: { name, language: { code: lang || process.env.WHATSAPP_TEMPLATE_LANG || 'es_MX' },
      components: [
        { type: 'header', parameters: [{ type: 'image', image: { id: String(mediaId) } }] },
        { type: 'body', parameters: [{ type: 'text', text: String(param || '').replace(/[\n\t]+/g, ' ').slice(0, 1024) }] },
      ] } });
}

// 0265 · 헤더 이미지(선택) + 본문 변수 여러 개 템플릿(cotizacion_detalle 등). 변수엔 줄바꿈·탭 금지, 빈 값 금지(Meta 규칙).
export const waParam = (v) => {
  const s = String(v == null ? '' : v).replace(/[\n\t\r]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1024);
  return s || '—';
};
export async function sendWaTemplateParams({ to, name, lang = null, mediaId = null, params = [] }) {
  if (!name) return { ok: false, code: null, error: 'no_template' };
  const components = [];
  if (mediaId) components.push({ type: 'header', parameters: [{ type: 'image', image: { id: String(mediaId) } }] });
  components.push({ type: 'body', parameters: (params || []).map((p) => ({ type: 'text', text: waParam(p) })) });
  return callGraph({ messaging_product: 'whatsapp', to: String(to), type: 'template',
    template: { name, language: { code: lang || process.env.WHATSAPP_TEMPLATE_LANG || 'es_MX' }, components } });
}

// ── 0260 · WhatsApp 마케팅(잠재고객) ──
// 변수 없는 템플릿(동의 요청 등). 빠른 답장 버튼은 템플릿에 고정돼 있어 보낼 때 따로 넣지 않는다.
export async function sendWaTemplateBare({ to, name, lang = null }) {
  if (!name) return { ok: false, code: null, error: 'no_template' };
  return callGraph({ messaging_product: 'whatsapp', to: String(to), type: 'template',
    template: { name, language: { code: lang || process.env.WHATSAPP_TEMPLATE_LANG || 'es_MX' } } });
}
// 24시간 창 안 — 선택 버튼(최대 3개, 버튼 글자 20자) 달린 답장
export async function sendWaButtons({ to, text, buttons = [] }) {
  const bs = (Array.isArray(buttons) ? buttons : []).map((b) => String(b || '').trim()).filter(Boolean).slice(0, 3);
  if (!bs.length) return sendWaText(text, to);
  return callGraph({ messaging_product: 'whatsapp', to: String(to), type: 'interactive',
    interactive: { type: 'button', body: { text: String(text || '').slice(0, 1024) },
      action: { buttons: bs.map((t, i) => ({ type: 'reply', reply: { id: `b${i + 1}`, title: t.slice(0, 20) } })) } } });
}
