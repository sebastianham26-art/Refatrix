// =====================================================================
// 2026-10-19 · 제품·마케팅 › VIO 제품찾기·프로모션 — 홍보 이미지용 사진 중계
//   GET /api/promo-img?u=<https 주소>
//   브라우저 캔버스로 1080×1350 홍보 이미지를 만들 때, 다른 사이트 사진(R2 제품사진 · 위키미디어 차량사진)이
//   CORS 헤더가 없으면 캔버스가 「오염」되어 JPEG 로 내보낼 수 없다. 서버가 대신 받아 같은 출처처럼 돌려준다.
//   허용 호스트만 · 이미지 형식만 · 8MB 이하 · 10초 제한 · 메모리 캐시(최대 200장 / 60MB, 6시간).
//   권한: 제품 화면(products) — VIO 제품찾기와 같다. 마이그레이션 없음.
// =====================================================================
import crypto from 'node:crypto';
import { authGuard, requirePage } from '../middleware/authGuard.js';

export const PROMO_IMG_HOSTS = [
  'pub-d34920cb200c42ce91c5cbda135f16d6.r2.dev',   // CTR 제품 사진(R2)
  'upload.wikimedia.org',                           // 차량 사진(위키백과)
  'www.syd.com.mx', 'syd.com.mx',                   // SYD 카탈로그 사진
];
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_MAX_N = 200;
const CACHE_MAX_BYTES = 60 * 1024 * 1024;
const CACHE_TTL_MS = 6 * 3600 * 1000;
const TIMEOUT_MS = 10000;

// 주소 검사 — https + 허용 호스트 + 사용자/포트 없음. 통과하면 URL 객체, 아니면 null
export function allowedUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || (u.port && u.port !== '443')) return null;
  if (!PROMO_IMG_HOSTS.includes(u.hostname.toLowerCase())) return null;
  return u;
}

const cache = new Map();   // href -> { buf, type, at }
let cacheBytes = 0;
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(k); cacheBytes -= e.buf.length; return null; }
  cache.delete(k); cache.set(k, e);   // 최근 사용으로 뒤로
  return e;
}
function cachePut(k, buf, type) {
  if (buf.length > CACHE_MAX_BYTES / 4) return;
  const old = cache.get(k); if (old) { cache.delete(k); cacheBytes -= old.buf.length; }
  cache.set(k, { buf, type, at: Date.now() }); cacheBytes += buf.length;
  while (cache.size > CACHE_MAX_N || cacheBytes > CACHE_MAX_BYTES) {
    const [fk, fe] = cache.entries().next().value; cache.delete(fk); cacheBytes -= fe.buf.length;
  }
}
export function _resetPromoImgCacheForTest() { cache.clear(); cacheBytes = 0; }

// 실제 받기(테스트에서 바꿔 끼울 수 있게 주입)
let fetcher = (url, opt) => fetch(url, opt);
export function _setPromoImgFetcherForTest(fn) { fetcher = fn || ((url, opt) => fetch(url, opt)); }

// ───────── 2026-10-19 · 차량 사진의 자동차 회사 로고·차명 글자·번호판 위치 찾기(지식재산 분쟁 예방) ─────────
//   POST /api/promo-img/marks { image_b64 } → { marks:[{x,y,w,h,kind}] } (0~1 비율, 왼쪽 위 기준)
//   화면이 이 상자를 흐리게 덮어 이미지에 로고가 나오지 않게 한다. AI 키가 없으면 503(화면은 「직접 가리기」 안내).
export const markModel = () => process.env.PROMO_MARK_AI_MODEL || 'claude-sonnet-4-5-20250929';
const MARK_TIMEOUT_MS = 60000;
const MARK_KINDS = ['emblem', 'lettering', 'plate', 'sticker', 'watermark', 'other'];
export const MARK_PROMPT = `You are preparing a car photo for an auto-parts advertisement. To avoid trademark disputes, every vehicle brand mark must be hidden.
Find EVERY visible mark in this photo:
- manufacturer emblems / badges / logos (front grille, hood, trunk/tailgate, wheel center caps, steering wheel, side badges)
- model, trim or engine name lettering on the body (e.g. "VERSA", "SENTRA", "GTI", "4x4")
- license plates (front and rear), dealer plate frames or stickers
- watermarks, photographer credits or any text overlays
Return ONLY JSON, no prose: {"marks":[{"x":0.41,"y":0.52,"w":0.06,"h":0.04,"kind":"emblem"}]}
x,y = top-left corner, w,h = size, all as fractions (0..1) of the image width and height. Each box must fully cover its mark with a small margin.
kind is one of: emblem, lettering, plate, sticker, watermark, other. Include small or partly visible marks. If there are none, return {"marks":[]}.`;
let markCaller = null;
export function _setPromoMarkCallerForTest(fn) { markCaller = fn || null; }
async function callMarkAi(b64, mime) {
  if (markCaller) return markCaller(b64, mime);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), MARK_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: markModel(), max_tokens: 1500, temperature: 0, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } }, { type: 'text', text: MARK_PROMPT }] }] }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: 'ai: ' + String((d.error && d.error.message) || 'http_' + r.status).slice(0, 200) };
    return { ok: true, text: (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'ai: timeout' : 'ai: network' };
  } finally { clearTimeout(t); }
}
// AI 답 → 깨끗한 상자 목록(범위 밖·이상한 값 버림, 최대 30개)
export function parseMarks(text) {
  let j = null;
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { j = JSON.parse(s.slice(a, b + 1)); } catch { j = null; } }
  if (!j || !Array.isArray(j.marks)) return null;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const out = [];
  for (const m of j.marks) {
    let x = Number(m && m.x), y = Number(m && m.y), w = Number(m && m.w), h = Number(m && m.h);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    if (x > 1.5 || y > 1.5 || w > 1.5 || h > 1.5) continue;   // 비율이 아닌 값(픽셀)은 버림
    if (w <= 0 || h <= 0 || w > 0.6 || h > 0.6) continue;     // 사진 반 이상을 덮는 상자는 오답
    x = clamp(x); y = clamp(y); w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
    if (w < 0.003 || h < 0.003) continue;
    out.push({ x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4), kind: MARK_KINDS.includes(m.kind) ? m.kind : 'other' });
    if (out.length >= 30) break;
  }
  return out;
}
const markCache = new Map();   // md5 -> marks (최근 300장)

export default async function promoImgRoutes(app) {
  app.post('/api/promo-img/marks', { preHandler: [authGuard, requirePage('products')], bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const b = req.body || {};
    const mime = String(b.mime || 'image/jpeg').toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return reply.code(400).send({ error: 'bad_image_type' });
    const b64 = String(b.image_b64 || '').replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return reply.code(400).send({ error: 'image_required' });
    if (buf.length > 5 * 1024 * 1024) return reply.code(413).send({ error: 'image_too_large' });
    const key = crypto.createHash('md5').update(buf).digest('hex');
    if (markCache.has(key)) return { marks: markCache.get(key), cached: true };
    if (!markCaller && !process.env.ANTHROPIC_API_KEY) return reply.code(503).send({ error: 'ai_not_configured' });
    const r = await callMarkAi(buf.toString('base64'), mime);
    if (!r.ok) return reply.code(502).send({ error: 'ai_failed', detail: r.error });
    const marks = parseMarks(r.text);
    if (!marks) return reply.code(502).send({ error: 'ai_bad_answer' });
    markCache.set(key, marks); if (markCache.size > 300) markCache.delete(markCache.keys().next().value);
    return { marks, cached: false };
  });

  app.get('/api/promo-img', { preHandler: [authGuard, requirePage('products')] }, async (req, reply) => {
    const u = allowedUrl(req.query.u);
    if (!u) return reply.code(400).send({ error: 'host_not_allowed', hosts: PROMO_IMG_HOSTS });
    const key = u.href;
    const hit = cacheGet(key);
    if (hit) return reply.type(hit.type).header('cache-control', 'private, max-age=86400').header('x-promo-cache', 'hit').send(hit.buf);
    let res;
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      res = await fetcher(key, { signal: ctrl.signal, redirect: 'follow',
        headers: { 'user-agent': 'RefatrixERP/1.0 (promo image builder; +https://refatrix.com)', accept: 'image/*' } });
    } catch (e) {
      clearTimeout(to);
      return reply.code(502).send({ error: 'fetch_failed', detail: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e).slice(0, 120) });
    }
    clearTimeout(to);
    // 리다이렉트 끝 주소도 허용 호스트여야 한다
    if (res.url && !allowedUrl(res.url)) return reply.code(400).send({ error: 'redirect_not_allowed' });
    if (res.status === 404) return reply.code(404).send({ error: 'not_found' });
    if (!res.ok) return reply.code(502).send({ error: 'upstream_' + res.status });
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return reply.code(415).send({ error: 'not_image', type });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) return reply.code(413).send({ error: 'too_large' });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return reply.code(413).send({ error: 'too_large' });
    if (!buf.length) return reply.code(502).send({ error: 'empty' });
    cachePut(key, buf, type);
    return reply.type(type).header('cache-control', 'private, max-age=86400').header('x-promo-cache', 'miss').send(buf);
  });
}
