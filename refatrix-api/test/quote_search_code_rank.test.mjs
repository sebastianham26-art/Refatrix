// =====================================================================
// Refatrix ERP · test/quote_search_code_rank.test.mjs  (2026-10-28 · sc-1028)
//
// 견적 품목 자동완성(GET /api/quotes/search-code) — 「K00 으로는 K0001 이 안 보인다」 회귀 방지.
//   08-25(sc-0825)에 고쳤던 관련도 정렬 + 50건이 덮어써져 코드순 12건으로 돌아갔던 재발 건.
//
// 실행: DATABASE_URL=postgres://... node --test --experimental-test-module-mocks test/quote_search_code_rank.test.mjs
//   · **전체 마이그레이션이 적용된 DB** 를 전제로 한다(없으면 skip). 시드는 'ZT' 접두로 넣고 끝에 지운다.
// =====================================================================
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONN = process.env.DATABASE_URL || '';
const skip = !CONN && 'DATABASE_URL 없음';

let app = null, pool = null;
const ids = [];
// 운영 증상과 같은 모양: 검색어 'QK9' 가 코드 **중간**에 든 제품 15개(AQK90…, 코드순으로 앞)
//   + 'QK9' 로 **시작**하는 키트 코드(QK9001…). 운영의 'K00' → CK00… vs K0001 과 같은 구조.
const NOISE = Array.from({ length: 15 }, (_, i) => `AQK90${String(i + 10).padStart(2, '0')}`);   // AQK9010…
const KITS = ['QK9001', 'QK9002'];

async function boot() {
  if (app) return app;
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: CONN });
  const ins = async (code, name, extra = '') => {
    const r = await pool.query(`INSERT INTO products (code, name, list_price ${extra ? ', material' : ''})
                                VALUES ($1,$2,100 ${extra ? ',$3' : ''}) RETURNING id`, extra ? [code, name, extra] : [code, name]);
    ids.push(r.rows[0].id); return r.rows[0].id;
  };
  for (const c of NOISE) await ins(c, 'noise ' + c);
  for (const c of KITS) await ins(c, 'VIO kit ' + c);
  // SYD 코드 2개 제품 — 행 복제로 LIMIT 을 갉아먹지 않는지
  const two = await ins('ZTB0336', 'two syd');
  await pool.query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,'ZS-3180'),($1,'ZS-3181')`, [two]);
  // 알루미늄 필터 유지 확인용
  await ins('QK9003', 'alu kit', 'aluminio');

  mock.module(resolve(HERE, '../src/middleware/authGuard.js'), {
    namedExports: {
      authGuard: async (req) => { req.ctx = { perm: { role: 'director', userId: 1, pageAccess: {} }, isRegistered: true }; },
      requirePage: () => async () => {}, requirePageAny: () => async () => {}, requirePageEdit: () => async () => {},
      requirePageEditAny: () => async () => {}, requireDirector: (req, reply, done) => done(),
    },
  });
  mock.module(resolve(HERE, '../src/audit.js'), {
    namedExports: { logEvent: async () => {}, logPageView: async () => {} },
  });
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  app.register((await import('../src/routes/quoteRoutes.js')).default);
  await app.ready();
  return app;
}
const get = async (q) => (await (await boot()).inject({ method: 'GET', url: '/api/quotes/search-code?q=' + encodeURIComponent(q) })).json();

after(async () => {
  if (app) await app.close();
  if (pool) {
    await pool.query(`DELETE FROM product_syd_codes WHERE product_id = ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM products WHERE id = ANY($1)`, [ids]).catch(() => {});
    await pool.end();
  }
});

test('① 짧게 쳐도(QK9) 접두일치 키트 코드가 맨 위 — 코드 중간 일치(AQK90…)에 밀리지 않는다', { skip }, async () => {
  const r = await get('QK9');
  const codes = r.items.map((x) => x.ctr_code);
  assert.deepEqual(codes.slice(0, 3), ['QK9001', 'QK9002', 'QK9003'], codes.join(','));
});

test('② 18건이 12건에서 잘리지 않는다 — 전부 보인다', { skip }, async () => {
  const r = await get('QK9');
  const codes = r.items.map((x) => x.ctr_code);
  for (const c of [...KITS, 'QK9003', ...NOISE]) assert.ok(codes.includes(c), c + ' 누락 · ' + codes.length + '건');
});

test('③ 정확일치는 맨 위 · 대소문자 무관', { skip }, async () => {
  const r = await get('qk9002');
  assert.equal(r.items[0].ctr_code, 'QK9002');
});

test('④ SYD 2코드 제품은 한 줄만 · SYD 로 찾으면 맨 위', { skip }, async () => {
  const r = await get('ZS-318');
  const rows = r.items.filter((x) => x.ctr_code === 'ZTB0336');
  assert.equal(rows.length, 1);
  assert.equal(r.items[0].ctr_code, 'ZTB0336');
  assert.deepEqual(rows[0].syd_codes.sort(), ['ZS-3180', 'ZS-3181']);
});

test('⑤ 「알루미늄만」 필터 유지', { skip }, async () => {
  const r = (await (await boot()).inject({ method: 'GET', url: '/api/quotes/search-code?q=QK9&material=aluminio' })).json();
  assert.deepEqual(r.items.map((x) => x.ctr_code), ['QK9003']);
});
