// =====================================================================
// Refatrix ERP · metaPageMsgs.js — Messenger 메시지 실시간 기록 · 보내기 (0300 · 2026-10-26)
//
//   고객 포털에서 refaccionaria 가 Facebook(Messenger) 문의 손님과 대화하기 위한 아래층.
//   · 웹훅(object=page)으로 오는 메시지를 meta_page_messages 에 쌓는다
//       손님 → 페이지 : direction=in  · source=customer
//       페이지 → 손님 : 에코(is_echo). 포털이 보낸 것은 보낼 때 이미 mid 로 저장돼 있어 그대로(source=portal),
//                       그 밖(Meta Business Suite 에서 직원이 보냄)은 source=staff
//     ⚠ 직원 답장(에코)을 받으려면 앱 웹훅의 Page 구독에 `message_echoes` 를 켜야 한다(인수인계 참고).
//   · 손님이 쓰거나 우리가 보내면 그 문의의 살아 있는 선점(lead_portal_claims) 만료를 「지금 + 선점 일수」로 늘린다.
//   · 보내기: POST /{page-id}/messages (messaging_type=RESPONSE) — Meta 24시간 창 안에서만.
//   Instagram 은 이번 범위가 아니다(디렉터 결정: Facebook 만).
// =====================================================================
import { query } from './db.js';
import { resolvePage, metaPageId } from './metaLeads.js';

const apiVer = () => process.env.META_GRAPH_VERSION || process.env.WHATSAPP_API_VERSION || 'v20.0';
export const WINDOW_MS = 24 * 3600 * 1000;

let ready = false; let probe = 0;
export async function chatReady(q = query) {
  if (ready) return true;
  if (Date.now() - probe < 30000) return false;
  probe = Date.now();
  try { ready = (await q(`SELECT 1 FROM information_schema.tables WHERE table_name='meta_page_messages'`)).rows.length > 0; }
  catch (_) { ready = false; }
  return ready;
}
export function setChatReady(v) { ready = !!v; probe = Date.now(); }

// 웹훅 본문 → 메시지 목록(Messenger 만 · 글자가 없는 첨부는 「[adjunto]」)
export function pageMessagesOf(body) {
  const out = [];
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return out;
  for (const e of body.entry) {
    const pageId = e && e.id ? String(e.id) : null;
    for (const ev of (e && e.messaging) || []) {
      const m = ev && ev.message; if (!m || !m.mid) continue;
      const echo = !!m.is_echo;
      const psid = String(echo ? (ev.recipient && ev.recipient.id) || '' : (ev.sender && ev.sender.id) || '');
      if (!psid || (pageId && psid === pageId)) continue;
      const ts = Number(ev.timestamp);
      const text = typeof m.text === 'string' && m.text ? m.text.slice(0, 4000)
        : (Array.isArray(m.attachments) && m.attachments.length ? '[adjunto]' : null);
      out.push({ psid, mid: String(m.mid), direction: echo ? 'out' : 'in', source: echo ? 'staff' : 'customer', text,
        at: Number.isFinite(ts) && ts > 0 ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date() });
    }
  }
  return out;
}

export async function claimDays(q = query) {
  try { const r = (await q(`SELECT claim_days FROM lead_portal_settings WHERE id=1`)).rows[0]; return r ? Number(r.claim_days) || 3 : 3; }
  catch (_) { return 3; }
}
// 그 손님(PSID)의 Messenger 문의에 걸린 살아 있는 선점을 늘린다
export async function extendClaimsForPsid(psid, q = query) {
  const days = await claimDays(q);
  await q(`UPDATE lead_portal_claims c SET expires_at = GREATEST(c.expires_at, now() + ($2 || ' days')::interval)
            FROM meta_threads t
           WHERE t.id = c.thread_id AND t.platform = 'messenger' AND t.user_id = $1
             AND c.released_at IS NULL AND c.expires_at > now()`, [psid, String(days)]);
}

export async function savePageMessages(body, q = query) {
  const list = pageMessagesOf(body);
  const out = { messages: list.length, stored: 0 };
  if (!list.length || !(await chatReady(q))) return out;
  const touched = new Set();
  for (const m of list) {
    try {
      const r = await q(
        `INSERT INTO meta_page_messages (psid, mid, direction, source, text, at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (mid) DO NOTHING RETURNING id`, [m.psid, m.mid, m.direction, m.source, m.text, m.at]);
      if (r.rows.length) { out.stored++; touched.add(m.psid); }
    } catch (_) { /* 표 없음 등 — 웹훅은 계속 */ }
  }
  for (const psid of touched) { try { await extendClaimsForPsid(psid, q); } catch (_) {} }
  return out;
}

// ── 보내기 ──
let postOverride = null;               // 시험용 — (url, body) => {ok,status,json}
export function setMessengerPost(fn) { postOverride = fn || null; }
export async function sendMessenger(psid, text) {
  const page = await resolvePage();
  if (!page || page.error) return { ok: false, error: (page && page.error) || 'no_token' };
  const url = `https://graph.facebook.com/${apiVer()}/${encodeURIComponent(metaPageId())}/messages?access_token=${encodeURIComponent(page.token)}`;
  const body = { recipient: { id: String(psid) }, messaging_type: 'RESPONSE', message: { text: String(text) } };
  let r;
  if (postOverride) r = await postOverride(url, body);
  else {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      const j = await res.json().catch(() => ({}));
      r = { ok: res.ok && !j.error, status: res.status, json: j };
    } catch (e) { r = { ok: false, status: 0, json: { error: { message: e && e.name === 'AbortError' ? 'timeout' : 'network' } } }; }
    finally { clearTimeout(t); }
  }
  if (r.ok && r.json && r.json.message_id) return { ok: true, mid: String(r.json.message_id) };
  const e = (r.json && r.json.error) || {};
  return { ok: false, error: `${e.code ? '#' + e.code + ' ' : ''}${e.message || 'http_' + r.status}`.slice(0, 300), code: e.code || null };
}
