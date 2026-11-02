// =====================================================================
// Refatrix ERP · test/quote_kit_filter_e2e.test.mjs  (2026-11-02 · kitf)
//
// 견적 작성 화면 「Kit 보기: 전체 / Kit만 / Kit 제외」 — 서버 쪽 검증.
//   · GET /api/quotes/search-code?kit=only|excl   (Kit만은 검색어 없이도 키트 목록)
//   · GET /api/quotes/price-list?kit=only|excl    (기본 · all=1 · top=N 세 갈래 모두)
//   · 키트 = K 로 시작하고 바로 숫자(K0001 …). K 다음이 글자인 코드(KXA-…)는 키트가 아니다.
//   · 키트 줄에 구성품 제품명(kit_items[].name · kit_desc) — 화면 Producto 칸에 쓴다.
//
// 실행: DATABASE_URL=postgres://... node --test --experimental-test-module-mocks test/quote_kit_filter_e2e.test.mjs
//   · 전체 마이그레이션이 적용된 DB 전제(없으면 skip). 시드는 K99xx / ZKF 접두 — 끝에 지운다.
// =====================================================================
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONN = process.env.DATABASE_URL || '';
const skip = !CONN && 'DATABASE_URL 없음';

let app = null, pool = null;
const ids = []; const promoIds = [];

async function boot() {
  if (app) return app;
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: CONN });
  const ins = async (code, name, price = 100) => {
    const r = await pool.query(`INSERT INTO products (code, name, list_price, stock_qty) VALUES ($1,$2,$3,10) RETURNING id`, [code, name, price]);
    ids.push(r.rows[0].id); return r.rows[0].id;
  };
  const a = await ins('ZKF-A1', 'Rotula inferior');
  const b = await ins('ZKF-B1', 'Terminal exterior');
  const c = await ins('ZKF-C1', '');                 // 이름 없는 부품 → CTR 코드로 표시
  await ins('KXA-100', 'K 로 시작하지만 키트 아님');  // K + 글자
  const k1 = await ins('K9901', 'KIT T VERSA 2012-2019_ZKF-A1x2_ZKF-B1', 300);
  const k2 = await ins('K9902', 'KIT T AVEO 2008-2018_ZKF-C1', 100);
  const addKit = async (no, pid, title, items) => {
    const v = await pool.query(`INSERT INTO vio_promos (promo_no, title, years, product_id) VALUES ($1,$2,'2012-2019',$3) RETURNING id`, [no, title, pid]);
    promoIds.push(v.rows[0].id);
    let n = 0;
    for (const [ip, code, qty] of items) await pool.query(
      `INSERT INTO vio_promo_items (promo_id, line_no, product_id, ctr_code, qty) VALUES ($1,$2,$3,$4,$5)`, [v.rows[0].id, ++n, ip, code, qty]);
  };
  await addKit('K9901', k1, 'Nissan Versa', [[a, 'ZKF-A1', 2], [b, 'ZKF-B1', 1]]);
  await addKit('K9902', k2, 'Chevrolet Aveo', [[c, 'ZKF-C1', 1]]);

  mock.module(resolve(HERE, '../src/middleware/authGuard.js'), {
    namedExports: {
      authGuard: async (req) => { req.ctx = { perm: { role: 'director', userId: 1, pageAccess: {} }, isRegistered: true }; },
      requirePage: () => async () => {}, requirePageAny: () => async () => {}, requirePageEdit: () => async () => {},
      requirePageEditAny: () => async () => {}, requireDirector: (req, reply, done) => done(),
    },
  });
  mock.module(resolve(HERE, '../src/audit.js'), { namedExports: { logEvent: async () => {}, logPageView: async () => {} } });
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  app.register((await import('../src/routes/quoteRoutes.js')).default);
  await app.ready();
  return app;
}
const get = async (url) => (await (await boot()).inject({ method: 'GET', url })).json();
const codesOf = (r) => (r.items || []).map((x) => x.ctr_code);

after(async () => {
  if (app) await app.close();
  if (pool) {
    await pool.query(`DELETE FROM vio_promos WHERE id = ANY($1)`, [promoIds]).catch(() => {});
    await pool.query(`DELETE FROM products WHERE id = ANY($1)`, [ids]).catch(() => {});
    await pool.end();
  }
});

test('① 자동완성 Kit만 — 검색어 없이도 키트 목록(K99xx), 일반 SKU·KXA- 제외', { skip }, async () => {
  const r = await get('/api/quotes/search-code?q=&kit=only');
  const cs = codesOf(r);
  assert.ok(cs.includes('K9901') && cs.includes('K9902'), cs.join(','));
  assert.ok(!cs.includes('KXA-100') && !cs.some((x) => x.startsWith('ZKF')), cs.join(','));
  assert.ok(r.items.every((x) => x.is_kit === true));
});

test('② 자동완성 키트 줄에 구성품 제품명(kit.items[].name · kit_desc)', { skip }, async () => {
  const r = await get('/api/quotes/search-code?q=K990&kit=only');
  const k = r.items.find((x) => x.ctr_code === 'K9901');
  assert.deepEqual(k.kit.items.map((x) => x.name), ['Rotula inferior', 'Terminal exterior']);
  assert.equal(k.kit_desc, 'Rotula inferior ×2 · Terminal exterior');
  const k2 = r.items.find((x) => x.ctr_code === 'K9902');
  assert.equal(k2.kit_desc, 'ZKF-C1', '이름 없는 부품은 CTR 코드');
});

test('③ 자동완성 Kit 제외 — 키트가 빠지고 KXA-(K+글자)는 남는다', { skip }, async () => {
  const cs = codesOf(await get('/api/quotes/search-code?q=K&kit=excl'));
  assert.ok(!cs.includes('K9901') && !cs.includes('K9902'), cs.join(','));
  assert.ok(cs.includes('KXA-100'), cs.join(','));
});

test('④ 자동완성 전체(파라미터 없음) — 종전 그대로 · 빈 검색어는 빈 목록', { skip }, async () => {
  const cs = codesOf(await get('/api/quotes/search-code?q=K'));
  assert.ok(cs.includes('K9901') && cs.includes('KXA-100'));
  assert.deepEqual(codesOf(await get('/api/quotes/search-code?q=')), []);
});

test('⑤ 가격표 Kit만 — 키트만 · kit_items 이름 · kit_desc 줄바꿈', { skip }, async () => {
  const r = await get('/api/quotes/price-list?kit=only');
  assert.deepEqual(codesOf(r).sort(), ['K9901', 'K9902']);
  const k = r.items.find((x) => x.ctr_code === 'K9901');
  assert.equal(k.is_kit, true); assert.equal(k.kit_no, 'K9901');
  assert.deepEqual(k.kit_items, [{ ctr_code: 'ZKF-A1', qty: 2, name: 'Rotula inferior' }, { ctr_code: 'ZKF-B1', qty: 1, name: 'Terminal exterior' }]);
  assert.equal(k.kit_desc, 'Rotula inferior ×2\nTerminal exterior');
});

test('⑥ 가격표 Kit 제외 — 키트 없음, KXA- 포함 · 전체는 둘 다', { skip }, async () => {
  const ex = codesOf(await get('/api/quotes/price-list?kit=excl'));
  assert.ok(!ex.includes('K9901') && !ex.includes('K9902') && ex.includes('KXA-100'));
  const all = codesOf(await get('/api/quotes/price-list'));
  assert.ok(all.includes('K9901') && all.includes('KXA-100') && all.includes('ZKF-A1'));
  const plain = (await get('/api/quotes/price-list')).items.find((x) => x.ctr_code === 'ZKF-A1');
  assert.equal(plain.is_kit, undefined, '일반 SKU 에는 키트 필드 없음');
});

test('⑦ 전체 견적(all=1) · Top N 도 kit 필터 적용', { skip }, async () => {
  const a = codesOf(await get('/api/quotes/price-list?all=1&kit=only'));
  assert.deepEqual(a.sort(), ['K9901', 'K9902']);
  const t = codesOf(await get('/api/quotes/price-list?top=500&kit=excl'));
  assert.ok(!t.includes('K9901'));
});

test('⑧ 순수 함수 — isKitCode · normKitMode · kitDesc', async () => {
  const { isKitCode, normKitMode, kitDesc } = await import('../src/vioPromos.js');
  assert.equal(isKitCode('K0001'), true); assert.equal(isKitCode(' k12 '), true);
  assert.equal(isKitCode('KXA-100'), false); assert.equal(isKitCode('CBKH-26'), false); assert.equal(isKitCode(null), false);
  assert.equal(normKitMode('only'), 'only'); assert.equal(normKitMode('excl'), 'excl'); assert.equal(normKitMode('all'), null); assert.equal(normKitMode(undefined), null);
  assert.equal(kitDesc([{ name: 'A', qty: 2 }, { ctr_code: 'X1', qty: 1 }]), 'A ×2\nX1');
});
