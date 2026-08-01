// =====================================================================
// Refatrix ERP · waSend.js — WhatsApp Cloud API 발송 (오늘 요약 자동 보고용)
//   디렉터 요청(2026-08-01): 멕시코 기준 매일 05:00 에 전일 「오늘 요약」을
//   디렉터 WhatsApp 으로 자동 발송.
//
//   ── 필요한 Railway 환경변수 (전부 있어야 발송 활성) ──
//   · WHATSAPP_TOKEN        Meta(WhatsApp Business Cloud API) 영구 토큰
//   · WHATSAPP_PHONE_ID     발신 전화번호 ID (Meta Business 관리자에서 확인)
//   · DAILY_SUMMARY_WA_TO   수신 번호(국가코드 포함 숫자만, 예: 5218112345678)
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

export async function sendWaText(text) {
  return callGraph({
    messaging_product: 'whatsapp',
    to: String(process.env.DAILY_SUMMARY_WA_TO),
    type: 'text',
    text: { body: String(text || '').slice(0, 4096), preview_url: false },
  });
}

export async function sendWaTemplate(param) {
  const name = process.env.WHATSAPP_TEMPLATE;
  if (!name) return { ok: false, code: null, error: 'no_template' };
  return callGraph({
    messaging_product: 'whatsapp',
    to: String(process.env.DAILY_SUMMARY_WA_TO),
    type: 'template',
    template: {
      name,
      language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'es_MX' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: String(param || '').replace(/[\n\t]+/g, ' ').slice(0, 1024) }] }],
    },
  });
}

// 요약 1건 발송: ① 자유 텍스트 → ② 실패 시(24h 창 밖 등) 템플릿 헤드라인 폴백
export async function sendDailySummaryWa({ dateLabel, content_md, stats }) {
  if (!waEnabled()) return { ok: false, mode: null, error: 'wa_not_configured' };
  const text = mdToWaText(`📋 Refatrix 오늘 요약 · ${dateLabel}`, content_md);
  const first = await sendWaText(text);
  if (first.ok) return { ok: true, mode: 'text', message_id: first.message_id };
  const fb = await sendWaTemplate(buildWaHeadline(dateLabel, stats));
  if (fb.ok) return { ok: true, mode: 'template', message_id: fb.message_id, text_error: first.error };
  return { ok: false, mode: null, error: `text: ${first.error}` + (fb.error !== 'no_template' ? ` / template: ${fb.error}` : ''), code: first.code };
}
