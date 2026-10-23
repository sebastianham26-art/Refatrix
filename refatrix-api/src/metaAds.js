// =====================================================================
// Refatrix ERP · metaAds.js — Meta 광고 문의를 광고별로 나누기 (0295 · 2026-10-23 디렉터 지시)
//
//   「광고별 고유번호(광고 ID)를 ERP 에 넣으면 그 번호에 광고 이름을 내가 붙이고, 광고별로 고객 문의를 골라 보고 싶다」
//
//   문의가 어느 광고에서 왔는지 — 우선순위:
//     ① 사람이 고른 광고(meta_threads.m_ad_id)
//     ② Meta 웹훅의 광고 출처(meta_ad_touches) — 그 고객이 가장 먼저 누른 광고
//        · WhatsApp(ERP Cloud API 번호): messages[].referral { source_type:'ad', source_id = 광고 ID, headline, ctwa_clid }
//        · Messenger / Instagram: messaging[].referral { source:'ADS', ad_id, ads_context_data.ad_title } (message · postback 안에 올 때도 있음)
//     ③ 광고 등록 때 적은 「구분 문구」가 고객 메시지에 들어 있으면 그 광고(웹훅 기록 전 예전 문의용)
//   Graph API 의 대화 목록(/conversations)에는 광고 정보가 없다 — 그래서 웹훅으로 받아 둔다.
// =====================================================================
import { query } from './db.js';
import { normalizeWaNumber } from './waSend.js';

export const AD_ID_RE = /^[0-9]{5,25}$/;
export const cleanAdId = (v) => { const s = String(v == null ? '' : v).replace(/[\s-]/g, ''); return AD_ID_RE.test(s) ? s : null; };
const cut = (v, n) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, n) : null; };

// ── SQL 조각(meta_threads 별칭 t) — 목록 · 집계가 같은 규칙을 쓰게 한 곳에 ──
export const AD_TOUCH_SQL = `(SELECT x.ad_id FROM meta_ad_touches x WHERE x.platform = t.platform AND x.user_id = t.user_id ORDER BY x.at, x.id LIMIT 1)`;
export const AD_TEXT_SQL = `(SELECT a.ad_id FROM meta_ads a WHERE COALESCE(a.match_text, '') <> '' AND strpos(lower(COALESCE(t.customer_text, '')), lower(a.match_text)) > 0
                             ORDER BY length(a.match_text) DESC, a.ad_id LIMIT 1)`;
export const AD_EXPR = `COALESCE(t.m_ad_id, ${AD_TOUCH_SQL}, ${AD_TEXT_SQL})`;
export const AD_SRC_EXPR = `CASE WHEN t.m_ad_id IS NOT NULL THEN 'manual' WHEN ${AD_TOUCH_SQL} IS NOT NULL THEN 'meta' WHEN ${AD_TEXT_SQL} IS NOT NULL THEN 'texto' END`;

// ── 웹훅 → 광고 출처 기록 ──
async function saveTouch(q, t) {
  if (!t.ad_id || !t.user_id) return false;
  const r = await q(
    `INSERT INTO meta_ad_touches (platform, user_id, ad_id, at, headline, source_url, ref, ctwa_clid, event_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (event_key) DO NOTHING RETURNING id`,
    [t.platform, t.user_id, t.ad_id, t.at.toISOString(), cut(t.headline, 300), cut(t.source_url, 600), cut(t.ref, 200), cut(t.ctwa_clid, 300), t.event_key]);
  return !!(r.rows && r.rows[0]);
}

// WhatsApp 수신 메시지 1건(웹훅 value.messages[i])의 광고 출처
export function waReferralOf(m) {
  const r = m && m.referral;
  if (!r) return null;
  const ad = cleanAdId(r.source_id);
  if (!ad || (r.source_type && String(r.source_type).toLowerCase() !== 'ad')) return null;
  const from = normalizeWaNumber(m.from);
  if (!from) return null;
  const n = Number(m.timestamp);
  return { platform: 'whatsapp', user_id: from, ad_id: ad, at: Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date(),
    headline: r.headline || null, source_url: r.source_url || null, ref: null, ctwa_clid: r.ctwa_clid || null,
    event_key: 'wa:' + (m.id || `${from}:${ad}:${m.timestamp || ''}`) };
}
export async function recordWaReferral(m, q = query) {
  const t = waReferralOf(m);
  if (!t) return false;
  try { return await saveTouch(q, t); } catch (_) { return false; }   // 0295 전이면 테이블 없음
}

// Messenger(object=page) · Instagram(object=instagram) 웹훅 본문의 광고 출처들
export function pageReferralsOf(body) {
  const out = [];
  if (!body || !['page', 'instagram'].includes(body.object) || !Array.isArray(body.entry)) return out;
  const platform = body.object === 'instagram' ? 'instagram' : 'messenger';
  for (const e of body.entry) {
    for (const ev of (e && e.messaging) || []) {
      if (!ev || (ev.message && ev.message.is_echo)) continue;   // 우리 페이지가 보낸 메시지
      const ref = ev.referral || (ev.message && ev.message.referral) || (ev.postback && ev.postback.referral) || null;
      if (!ref) continue;
      const ad = cleanAdId(ref.ad_id);
      if (!ad) continue;
      const user = ev.sender && ev.sender.id ? String(ev.sender.id) : null;
      if (!user || (e.id && user === String(e.id))) continue;
      const ts = Number(ev.timestamp);
      const ctx = ref.ads_context_data || {};
      out.push({ platform, user_id: user, ad_id: ad, at: Number.isFinite(ts) && ts > 0 ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date(),
        headline: ctx.ad_title || null, source_url: ctx.photo_url || ctx.video_url || null, ref: ref.ref || null, ctwa_clid: null,
        event_key: `${platform}:${(ev.message && ev.message.mid) || `${user}:${ad}:${ev.timestamp || ''}`}` });
    }
  }
  return out;
}
export async function applyPageWebhook(body, q = query) {
  const out = { referrals: 0, stored: 0 };
  for (const t of pageReferralsOf(body)) {
    out.referrals++;
    try { if (await saveTouch(q, t)) out.stored++; } catch (_) { /* 0295 전 */ }
  }
  return out;
}

// ── 페이지를 앱 웹훅에 연결(Messenger 광고 출처를 받으려면 한 번) ──
//   POST /{page-id}/subscribed_apps?subscribed_fields=messages,messaging_referrals,messaging_postbacks — 페이지 토큰 · pages_manage_metadata 필요
let postOverride = null;          // 시험용 — (url) => {ok,status,json}
export function setMetaAdsPost(fn) { postOverride = fn || null; }
export const PAGE_FIELDS = 'messages,messaging_referrals,messaging_postbacks';
export async function subscribePage({ pageId, token, version = 'v20.0' }) {
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=${PAGE_FIELDS}&access_token=${encodeURIComponent(token)}`;
  let r;
  if (postOverride) r = await postOverride(url);
  else {
    try { const res = await fetch(url, { method: 'POST' }); const j = await res.json().catch(() => ({})); r = { ok: res.ok && !j.error, status: res.status, json: j }; }
    catch (e) { r = { ok: false, status: 0, json: { error: { message: 'network' } } }; }
  }
  if (r.ok && r.json && r.json.success !== false) return { ok: true };
  const e = (r.json && r.json.error) || {};
  return { ok: false, error: `${e.code ? '#' + e.code + ' ' : ''}${e.message || 'http_' + r.status}`.slice(0, 300) };
}
