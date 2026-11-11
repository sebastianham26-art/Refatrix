// =====================================================================
// Refatrix ERP · waMedia.js — WhatsApp 사진 · 음성 · 동영상 · PDF 보기(0325 · 2026-11-11)
//   2026-11-11 디렉터: 광고 WhatsApp 을 ERP 번호(8128806680)로 받으면 손님이 보낸 사진 · 음성 · PDF 를 ERP 대화창에서 본다.
//   · 웹훅은 미디어 id 만 준다 → Graph GET /{media-id} → 임시 주소(약 5분) → 파일 받기(같은 토큰).
//   · Meta 는 받은 미디어를 약 30일만 보관 → 처음 볼 때(또는 받자마자 미리) 파일을 DB(wa_media_cache)에 저장해 둔다.
//   · 우리가 보낸 사진 · PDF 도 올린 파일을 같은 표에 넣어 대화창에서 다시 본다.
// =====================================================================
import { query } from './db.js';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio', 'sticker'];
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;       // 받을 때 상한(WhatsApp 동영상 16MB · 문서 100MB — 더 크면 못 봄 안내)
const API_VER = () => process.env.WHATSAPP_API_VERSION || 'v20.0';
const TIMEOUT_MS = 30000;

let tableOk = null;
async function cacheReady(q) {
  if (tableOk) return true;
  try { tableOk = !!(await q(`SELECT to_regclass('public.wa_media_cache') AS t`)).rows[0].t; } catch (_) { tableOk = false; }
  return tableOk;
}
export function resetMediaCacheFlag() { tableOk = null; }

// Graph 에서 파일 받기 — 테스트는 setMediaFetcher 로 바꿔 끼운다. 반환 {ok, mime, bytes, error}
async function graphFetch(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return { ok: false, error: 'wa_not_configured' };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r1 = await fetch(`https://graph.facebook.com/${API_VER()}/${encodeURIComponent(mediaId)}`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
    const meta = await r1.json().catch(() => ({}));
    if (!r1.ok || !meta.url) {
      const e = (meta && meta.error) || {};
      // 30일이 지나 Meta 가 지운 미디어 = 100 / 400 · 「does not exist」
      return { ok: false, error: r1.status === 404 || /exist|expired|not found/i.test(e.message || '') || e.code === 100 ? 'media_expired' : (e.message || ('http_' + r1.status)).slice(0, 200) };
    }
    if (meta.file_size && Number(meta.file_size) > MAX_MEDIA_BYTES) return { ok: false, error: 'media_too_large' };
    const r2 = await fetch(meta.url, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
    if (!r2.ok) return { ok: false, error: 'http_' + r2.status };
    const bytes = Buffer.from(await r2.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) return { ok: false, error: 'media_too_large' };
    return { ok: true, mime: String(meta.mime_type || r2.headers.get('content-type') || 'application/octet-stream').split(';')[0], bytes };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(timer); }
}
let fetcher = graphFetch;
export function setMediaFetcher(f) { fetcher = f || graphFetch; }

export async function cacheWaMedia(mediaId, { mime, bytes, filename = null }, q = query) {
  if (!mediaId || !bytes || !(await cacheReady(q))) return false;
  await q(`INSERT INTO wa_media_cache (media_id, mime, size, filename, bytes) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (media_id) DO NOTHING`, [String(mediaId), mime || 'application/octet-stream', bytes.length, filename, bytes]);
  return true;
}

// 미디어 id → {ok, mime, bytes, filename} — 저장본 먼저, 없으면 Meta 에서 받아 저장
const inflight = new Map();
export async function getWaMedia(mediaId, q = query) {
  const id = String(mediaId || ''); if (!id) return { ok: false, error: 'no_media' };
  if (await cacheReady(q)) {
    const c = (await q(`SELECT mime, bytes, filename FROM wa_media_cache WHERE media_id=$1`, [id])).rows[0];
    if (c) return { ok: true, mime: c.mime, bytes: c.bytes, filename: c.filename, cached: true };
  }
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const r = await fetcher(id);
    if (r.ok) await cacheWaMedia(id, { mime: r.mime, bytes: r.bytes }, q).catch(() => {});
    return r;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

// 메시지 1건(wa_messages.id) → 미디어. phone 을 주면 그 번호의 메시지인지도 확인(다른 문의의 파일을 못 보게)
export async function mediaForMessage(messageId, { phone = null } = {}, q = query) {
  const m = (await q(`SELECT id, phone, kind, body, payload FROM wa_messages WHERE id=$1`, [Number(messageId) || 0])).rows[0];
  if (!m || !MEDIA_KINDS.includes(m.kind) || !m.payload) return { ok: false, error: 'not_found', status: 404 };
  if (phone && m.phone !== phone) return { ok: false, error: 'not_found', status: 404 };
  const r = await getWaMedia(m.payload, q);
  if (!r.ok) return { ...r, status: r.error === 'media_expired' ? 410 : 502 };
  const fname = r.filename || (m.kind === 'document' ? String(m.body || '').replace(/^\[document\]$/, '') : '') || `whatsapp_${m.id}`;
  return { ...r, kind: m.kind, filename: fname };
}

// 받자마자 미리 저장(30일 뒤 Meta 가 지워도 남게) — 응답을 막지 않음
export function prefetchWaMedia(mediaId, q = query) {
  if (!mediaId || process.env.WA_MEDIA_PREFETCH === '0' || !process.env.WHATSAPP_TOKEN) return null;
  return getWaMedia(mediaId, q).catch(() => null);
}

// 응답 헤더용 — 한글 · 스페인어 파일 이름
export function contentDisposition(name, inline = true) {
  const n = String(name || 'archivo').replace(/[\r\n"]/g, '').slice(0, 200);
  const ascii = n.replace(/[^\x20-\x7e]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(n)}`;
}
