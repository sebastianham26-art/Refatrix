// 2026-11-25 · 키트 검색 규칙 (실 PostgreSQL)
//   제품찾기(/api/products) — 구성품 코드로도 키트가 나온다(예전 그대로)
//   가격 마스터 ① 가격표(/api/price-master/table) — 키트는 키트 번호로 찾을 때만
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
const priceMasterRoutes = (await import('../src/routes/priceMasterRoutes.js')).default;
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
app.register(productRoutes); app.register(priceMasterRoutes); await app.ready();
const codes = async (qs) => { const r = await app.inject({ method: 'GET', url: '/api/products?limit=50&' + qs }); assert.equal(r.statusCode, 200, r.body); const j = r.json(); return { c: j.items.map((x) => x.code).sort(), total: j.total, j }; };

const pm = async (qs) => { const r = await app.inject({ method: 'GET', url: '/api/price-master/table?limit=50&' + qs }); assert.equal(r.statusCode, 200, r.body); const j = r.json(); return { c: j.rows.map((x) => x.code).sort(), total: j.kpi.total }; };

console.log('제품찾기 — 예전 그대로');
await t('구성품 코드로 찾으면 부품 + 그 부품이 든 키트', async () => {
  assert.deepEqual((await codes('q=CB0011')).c, ['CB0011', 'K0001', 'K0012']);
  const r = await codes('q=CQ0728R'); assert.deepEqual(r.c, ['CQ0728R', 'K0001']);
  assert.deepEqual(r.j.items.find((x) => x.code === 'K0001').kit.items.map((x) => x.code), ['CB0011', 'CQ0728R']);
});
await t('검색어 없음 · 차종 · 키트 번호 → 키트도 나옴', async () => {
  assert.deepEqual((await codes('')).c, ['CB0011', 'CQ0728R', 'K0001', 'K0012']);
  assert.deepEqual((await codes('q=VERSA')).c, ['CB0011', 'CQ0728R', 'K0001']);
  assert.deepEqual((await codes('q=K0001')).c, ['K0001']);
});

console.log('가격 마스터 ① 가격표 — 키트는 키트 번호로만');
await t('검색어 없음 → 키트 숨김 (KPI 제품 수도 키트 제외)', async () => {
  const r = await pm(''); assert.deepEqual(r.c, ['CB0011', 'CQ0728R']); assert.equal(r.total, 2);
});
await t('구성품 코드 → 부품만 (키트 가격 안 나옴)', async () => {
  assert.deepEqual((await pm('q=CB0011')).c, ['CB0011']); assert.deepEqual((await pm('q=cq0728r')).c, ['CQ0728R']);
});
await t('차종 · KIT 글자 → 키트 안 나옴', async () => {
  assert.deepEqual((await pm('q=VERSA')).c, ['CB0011', 'CQ0728R']); assert.deepEqual((await pm('q=KIT')).c, []);
});
await t('키트 번호 → 키트 (대소문자 · 일부)', async () => {
  const r = await pm('q=K0001'); assert.deepEqual(r.c, ['K0001']); assert.equal(r.total, 1);
  assert.deepEqual((await pm('q=k00')).c, ['K0001', 'K0012']); assert.deepEqual((await pm('q=0012')).c, ['K0012']);
});
await t('% · _ 로 키트가 열리지 않음 · 보기 필터·정렬과 같이', async () => {
  assert.ok(!(await pm('q=' + encodeURIComponent('%'))).c.some((c) => c.startsWith('K0')));
  assert.ok(!(await pm('q=K_001')).c.some((c) => c.startsWith('K0')));
  assert.deepEqual((await pm('q=K0&view=no_fob&sort=code&dir=desc')).c, ['K0001', 'K0012']);
  assert.deepEqual((await pm('view=no_fob')).c, ['CB0011', 'CQ0728R']);
});
await app.close(); await pool.end();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
