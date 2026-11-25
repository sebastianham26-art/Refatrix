// 2026-11-25 · 제품찾기(/api/products) — 키트는 키트 번호로 칠 때만 나온다 · 구성품 코드·차종으로는 안 나온다 (실 PostgreSQL)
//   실행: PGADMIN_URL=postgres://postgres@localhost:5432/postgres PG_TEMPLATE=<migrations/*.sql 전부 적용한 DB> node test/products_kit_search_pg.test.mjs
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import pg from 'pg';
const ADMIN = process.env.PGADMIN_URL || '';
if (!ADMIN || !process.env.PG_TEMPLATE) { console.log('PGADMIN_URL · PG_TEMPLATE 없음 — 건너뜀'); process.exit(0); }
const DB = 'pmtest_kit1125';
{ const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a.query(`CREATE DATABASE ${DB} TEMPLATE ${process.env.PG_TEMPLATE}`); await a.end(); }
{ const u = new URL(ADMIN); u.pathname = '/' + DB; process.env.DATABASE_URL = u.toString(); }
const { pool, query } = await import('../src/db.js');
const { hashPin } = await import('../src/auth.js');
const productRoutes = (await import('../src/routes/productRoutes.js')).default;
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ✔', name); } catch (e) { fail++; console.log('  ✘', name, '\n     ', e.message.split('\n').slice(0, 6).join('\n      ')); } }

await query(`INSERT INTO users (id,name,login_id,role,pin_hash) OVERRIDING SYSTEM VALUE VALUES (1,'Sebastian','seb','director',$1)
  ON CONFLICT (id) DO UPDATE SET role='director', pin_hash=EXCLUDED.pin_hash`, [hashPin('1234')]);
const prod = async (code, name, app) => Number((await query(`INSERT INTO products (code,name,app,list_price,stock_qty) VALUES ($1,$2,$3,100,5) RETURNING id`, [code, name, app])).rows[0].id);
const A = await prod('CB0011', 'ROTULA', 'NISSAN VERSA 2015'); const B = await prod('CQ0728R', 'HORQUILLA', 'NISSAN VERSA 2015');
const K1 = await prod('K0001', 'KIT VERSA 2015_CB0011_CQ0728R', 'VERSA 2015-2019');
const K2 = await prod('K0012', 'KIT AVEO 2010_CB0011x2', 'AVEO 2010');
const promo = async (no, pid, items) => { const v = Number((await query(`INSERT INTO vio_promos (promo_no, title, product_id) VALUES ($1,'T',$2) RETURNING id`, [no, pid])).rows[0].id);
  let n = 1; for (const [ip, code, qty] of items) await query(`INSERT INTO vio_promo_items (promo_id,line_no,product_id,ctr_code,qty) VALUES ($1,$2,$3,$4,$5)`, [v, n++, ip, code, qty]); };
await promo('K0001', K1, [[A, 'CB0011', 1], [B, 'CQ0728R', 1]]); await promo('K0012', K2, [[A, 'CB0011', 2]]);
// 키트 제품이 아직 안 만들어진 프로모션(product_id NULL) — 영향 없어야
await query(`INSERT INTO vio_promos (promo_no, title) VALUES ('K0099','T')`);

const app = Fastify();
app.decorateRequest('jwtVerify', async function () { this.user = { sub: 1 }; });
app.register(productRoutes); await app.ready();
const codes = async (qs) => { const r = await app.inject({ method: 'GET', url: '/api/products?limit=50&' + qs }); assert.equal(r.statusCode, 200, r.body); const j = r.json(); return { c: j.items.map((x) => x.code).sort(), total: j.total, j }; };

await t('검색어 없음 → 키트 숨김 (total 도 키트 제외)', async () => {
  const { c, total } = await codes(''); assert.deepEqual(c, ['CB0011', 'CQ0728R']); assert.equal(total, 2);
});
await t('구성품 코드로 검색 → 부품만, 키트는 안 나옴', async () => {
  assert.deepEqual((await codes('q=CB0011')).c, ['CB0011']); assert.deepEqual((await codes('q=cq0728')).c, ['CQ0728R']);
});
await t('차종·키트 이름 글자로 검색 → 키트 안 나옴', async () => {
  assert.deepEqual((await codes('q=VERSA')).c, ['CB0011', 'CQ0728R']); assert.deepEqual((await codes('q=KIT')).c, []); assert.deepEqual((await codes('q=AVEO')).c, []);
});
await t('키트 번호로 검색 → 키트 + 구성품 하위 줄(kit.items)', async () => {
  const r = await codes('q=K0001'); assert.deepEqual(r.c, ['K0001']); assert.equal(r.total, 1);
  assert.deepEqual(r.j.items[0].kit.items.map((x) => x.code), ['CB0011', 'CQ0728R']);
  assert.deepEqual((await codes('q=k0012')).c, ['K0012']); assert.deepEqual((await codes('q=K00')).c, ['K0001', 'K0012']);
  assert.deepEqual((await codes('q=0012')).c, ['K0012']);
});
await t('검색어 % · _ 로 키트가 열리지 않음(키트 조건은 글자 그대로 비교)', async () => {
  assert.ok(!(await codes('q=' + encodeURIComponent('%'))).c.some((c) => c.startsWith('K0'))); assert.ok(!(await codes('q=K_001')).c.some((c) => c.startsWith('K0')));
});
await t('kits=1 → 예전처럼 전부', async () => {
  assert.deepEqual((await codes('kits=1')).c, ['CB0011', 'CQ0728R', 'K0001', 'K0012']); assert.deepEqual((await codes('kits=1&q=CB0011')).c, ['CB0011', 'K0001', 'K0012']);
});
await t('정렬·페이지와 같이 (sort=code · offset)', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/products?q=K0&sort=code&dir=desc&limit=1&offset=1' }); const j = r.json();
  assert.deepEqual(j.items.map((x) => x.code), ['K0001']); assert.equal(j.total, 2);
});
await app.close(); await pool.end();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
