// =====================================================================
// 2026-10-19 · 제품·마케팅 › VIO 제품찾기·프로모션 — 홍보 이미지용 사진 중계
//   GET /api/promo-img?u=<https 주소>
//   브라우저 캔버스로 1080×1350 홍보 이미지를 만들 때, 다른 사이트 사진(R2 제품사진 · 위키미디어 차량사진)이
//   CORS 헤더가 없으면 캔버스가 「오염」되어 JPEG 로 내보낼 수 없다. 서버가 대신 받아 같은 출처처럼 돌려준다.
//   허용 호스트만 · 이미지 형식만 · 8MB 이하 · 10초 제한 · 메모리 캐시(최대 200장 / 60MB, 6시간).
//   권한: 제품 화면(products) — VIO 제품찾기와 같다. 마이그레이션 없음.
// =====================================================================
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

export default async function promoImgRoutes(app) {
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
