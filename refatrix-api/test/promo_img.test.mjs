// =====================================================================
// 2026-10-19 · GET /api/promo-img — 홍보 이미지용 사진 중계(허용 호스트 · 이미지만 · 크기 · 캐시)
//   실행: node --import ./test/helpers/stub-auth.mjs --test test/promo_img.test.mjs   (DB 불필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
const mod = await import('../src/routes/promoImgRoutes.js');
const { default: promoImgRoutes, allowedUrl, _setPromoImgFetcherForTest, _resetPromoImgCacheForTest } = mod;

const R2 = 'https://pub-d34920cb200c42ce91c5cbda135f16d6.r2.dev/products/CB0336/CB0336_1.webp';
const WIKI = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Nissan_Versa.jpg';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
let calls = [];
function fake(map) {
  _setPromoImgFetcherForTest(async (url) => {
    calls.push(url);
    const r = map(url);
    if (r instanceof Error) throw r;
    const headers = new Map(Object.entries(r.headers || {}));
    return { ok: r.status < 400, status: r.status, url: r.url || url, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      arrayBuffer: async () => (r.body || Buffer.alloc(0)).buffer.slice((r.body || Buffer.alloc(0)).byteOffset, (r.body || Buffer.alloc(0)).byteOffset + (r.body || Buffer.alloc(0)).length) };
  });
}
async function app() { const a = Fastify(); await a.register(promoImgRoutes); await a.ready(); return a; }
const get = (a, u) => a.inject({ method: 'GET', url: '/api/promo-img?u=' + encodeURIComponent(u), headers: { 'x-test-user': '5:sales' } });

test('주소 검사: https · 허용 호스트만 · 사용자정보/포트 거부', () => {
  assert.ok(allowedUrl(R2)); assert.ok(allowedUrl(WIKI)); assert.ok(allowedUrl('https://www.syd.com.mx/Catalogo/fotos/1516049.jpg'));
  assert.equal(allowedUrl('http://upload.wikimedia.org/x.jpg'), null);
  assert.equal(allowedUrl('https://evil.example.com/x.jpg'), null);
  assert.equal(allowedUrl('https://upload.wikimedia.org.evil.com/x.jpg'), null);
  assert.equal(allowedUrl('https://user:pw@upload.wikimedia.org/x.jpg'), null);
  assert.equal(allowedUrl('https://upload.wikimedia.org:8443/x.jpg'), null);
  assert.equal(allowedUrl('https://127.0.0.1/x.jpg'), null);
  assert.equal(allowedUrl(''), null);
});

test('허용 안 된 호스트는 받으러 가지도 않는다(400)', async () => {
  _resetPromoImgCacheForTest(); calls = []; fake(() => ({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG }));
  const a = await app();
  const r = await get(a, 'https://169.254.169.254/latest/meta-data');
  assert.equal(r.statusCode, 400); assert.equal(r.json().error, 'host_not_allowed'); assert.equal(calls.length, 0);
  await a.close();
});

test('이미지를 그대로 돌려주고, 두 번째는 캐시', async () => {
  _resetPromoImgCacheForTest(); calls = []; fake(() => ({ status: 200, headers: { 'content-type': 'image/png; charset=binary', 'content-length': String(PNG.length) }, body: PNG }));
  const a = await app();
  const r1 = await get(a, R2);
  assert.equal(r1.statusCode, 200); assert.equal(r1.headers['content-type'], 'image/png'); assert.equal(r1.headers['x-promo-cache'], 'miss');
  assert.deepEqual(Buffer.from(r1.rawPayload), PNG);
  const r2 = await get(a, R2);
  assert.equal(r2.statusCode, 200); assert.equal(r2.headers['x-promo-cache'], 'hit'); assert.equal(calls.length, 1);
  await a.close();
});

test('이미지가 아니면 415 · 404 는 404 · 그 밖 오류 502 · 시간 초과 502', async () => {
  _resetPromoImgCacheForTest();
  const a = await app();
  fake(() => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>') }));
  let r = await get(a, WIKI); assert.equal(r.statusCode, 415); assert.equal(r.json().error, 'not_image');
  fake(() => ({ status: 404, headers: {} }));
  r = await get(a, WIKI + '?2'); assert.equal(r.statusCode, 404);
  fake(() => ({ status: 503, headers: {} }));
  r = await get(a, WIKI + '?3'); assert.equal(r.statusCode, 502); assert.equal(r.json().error, 'upstream_503');
  fake(() => Object.assign(new Error('aborted'), { name: 'AbortError' }));
  r = await get(a, WIKI + '?4'); assert.equal(r.statusCode, 502); assert.equal(r.json().detail, 'timeout');
  await a.close();
});

test('8MB 넘으면 413 (헤더로 · 실제 크기로)', async () => {
  _resetPromoImgCacheForTest();
  const a = await app();
  fake(() => ({ status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(9 * 1024 * 1024) }, body: PNG }));
  let r = await get(a, WIKI); assert.equal(r.statusCode, 413);
  fake(() => ({ status: 200, headers: { 'content-type': 'image/jpeg' }, body: Buffer.alloc(8 * 1024 * 1024 + 1) }));
  r = await get(a, WIKI + '?big'); assert.equal(r.statusCode, 413);
  await a.close();
});

test('리다이렉트 끝이 허용 밖이면 400', async () => {
  _resetPromoImgCacheForTest();
  const a = await app();
  fake(() => ({ status: 200, url: 'https://evil.example.com/x.png', headers: { 'content-type': 'image/png' }, body: PNG }));
  const r = await get(a, WIKI); assert.equal(r.statusCode, 400); assert.equal(r.json().error, 'redirect_not_allowed');
  await a.close();
});

test('server.js 에 등록되어 있다', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf-8');
  assert.match(src, /import promoImgRoutes from '\.\/routes\/promoImgRoutes\.js'/);
  assert.match(src, /app\.register\(promoImgRoutes\)/);
});
