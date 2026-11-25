// 2026-11-25 · 가격 마스터 ⑤-2 SYD 가격표 — 실 PostgreSQL 종단 테스트
//   실행: PGADMIN_URL=postgres://postgres@localhost:5432/postgres PG_TEMPLATE=<migrations/*.sql 전부 적용한 DB> node test/price_syd_items_pg.test.mjs
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import pg from 'pg';
const ADMIN = process.env.PGADMIN_URL || '';
if (!ADMIN || !process.env.PG_TEMPLATE) { console.log('PGADMIN_URL · PG_TEMPLATE 없음 — 건너뜀'); process.exit(0); }
const DB = 'pmtest_syd1125';
{ const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a.query(`CREATE DATABASE ${DB} TEMPLATE ${process.env.PG_TEMPLATE}`); await a.end(); }
{ const u = new URL(ADMIN); u.pathname = '/' + DB; process.env.DATABASE_URL = u.toString(); }
const { pool, query } = await import('../src/db.js');
const { hashPin } = await import('../src/auth.js');
const priceMasterRoutes = (await import('../src/routes/priceMasterRoutes.js')).default;
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ✔', name); } catch (e) { fail++; console.log('  ✘', name, '\n     ', e.message.split('\n').slice(0, 6).join('\n      ')); } }

await query(`INSERT INTO users (id,name,login_id,role,pin_hash) OVERRIDING SYSTEM VALUE VALUES (1,'Sebastian','seb','director',$1)
  ON CONFLICT (id) DO UPDATE SET role='director', pin_hash=EXCLUDED.pin_hash`, [hashPin('1234')]);
const app = Fastify();
app.decorateRequest('jwtVerify', async function () { this.user = { sub: 1 }; });
app.register(priceMasterRoutes); await app.ready();
const get = async (u) => { const r = await app.inject({ method: 'GET', url: u }); return { status: r.statusCode, ...r.json() }; };

await t('리스트 없음 → list:null · 빈 목록', async () => {
  const d = await get('/api/price-master/syd/items'); assert.equal(d.status, 200, JSON.stringify(d)); assert.equal(d.list, null); assert.equal(d.rows.length, 0);
});

const prod = async (code, list) => Number((await query(`INSERT INTO products (code,name,list_price) VALUES ($1,'X',$2) RETURNING id`, [code, list])).rows[0].id);
const P1 = await prod('CQ0728R', 1031); const P2 = await prod('CB0011', 344); const P3 = await prod('CB0012', 400); const PD = await prod('DEL1', 999);
await query(`UPDATE products SET deleted_at = now() WHERE id=$1`, [PD]);
await query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,'54500-8H310'),($2,'1026018'),($3,'1026018'),($4,'K-9647')`, [P1, P2, P3, PD]);
const list = async (d) => Number((await query(`INSERT INTO syd_price_lists (list_date, file_name, code_count) VALUES ($1,'f.xlsx',0) RETURNING id`, [d])).rows[0].id);
const item = (l, code, price, fam, desc) => query(`INSERT INTO syd_price_items (list_id, syd_norm, syd_code, price, familia, descripcion) VALUES ($1, regexp_replace(upper($2),'[^A-Z0-9]','','g'), $2, $3, $4, $5)`, [l, code, price, fam, desc]);
const L1 = await list('2026-09-01'); const L2 = await list('2026-11-01');
await item(L1, '54500-8H310', 700, 'HORQUILLAS', 'HORQUILLA X-TRAIL'); await item(L1, '1026018', 250, 'ROTULAS', 'ROTULA DODGE'); await item(L1, 'K-9647', 300, 'TERMINALES', 'TERMINAL VENTO');
await item(L2, '54500-8H310', 770, 'HORQUILLAS', 'HORQUILLA X-TRAIL');   // +10%
await item(L2, '1026018', 225, 'ROTULAS', 'ROTULA DODGE');               // −10%
await item(L2, 'K-9647', 300, 'TERMINALES', 'TERMINAL VENTO');            // 같음 · 연결 제품 삭제됨 → 연결 없음
await item(L2, 'GY-421', 1500, null, 'AMORTIGUADOR HILUX');               // 신규 · Familia 없음

await t('최신 리스트 기본 · 앞 리스트 비교 · KPI', async () => {
  const d = await get('/api/price-master/syd/items'); assert.equal(d.list.id, L2); assert.equal(d.list.prev_id, L1); assert.equal(d.list.prev_date, '2026-09-01');
  assert.deepEqual(d.kpi, { codes: 4, linked: 2, avg_price: 698.75, up: 1, down: 1, new: 1 });
  const r = Object.fromEntries(d.rows.map((x) => [x.syd_code, x]));
  assert.equal(r['54500-8H310'].price, 770); assert.equal(r['54500-8H310'].prev_price, 700); assert.equal(r['54500-8H310'].change, 0.1);
  assert.deepEqual(r['54500-8H310'].ctr_codes, ['CQ0728R']); assert.equal(r['54500-8H310'].ctr_list, 1031); assert.equal(r['54500-8H310'].ratio, 1.339);
  assert.deepEqual(r['1026018'].ctr_codes, ['CB0011', 'CB0012']); assert.equal(r['1026018'].ctr_list, 400); assert.equal(r['1026018'].change, -0.1);
  assert.deepEqual(r['K-9647'].ctr_codes, []); assert.equal(r['K-9647'].change, 0);
  assert.equal(r['GY-421'].is_new, true); assert.equal(r['GY-421'].prev_price, null); assert.equal(r['GY-421'].descripcion, 'AMORTIGUADOR HILUX');
  assert.deepEqual(d.familias.map((f) => f.v).sort(), ['HORQUILLAS', 'ROTULAS', 'TERMINALES', '__none__']);
});
await t('옛 리스트 선택 → 비교 대상 없음(신규·변동 —)', async () => {
  const d = await get('/api/price-master/syd/items?list_id=' + L1); assert.equal(d.list.prev_id, null); assert.equal(d.kpi.codes, 3); assert.equal(d.kpi.new, null);
  assert.ok(d.rows.every((r) => r.change == null && r.is_new === false));
});
await t('보기: linked · unlinked · up · down · new · same', async () => {
  const codes = async (v) => (await get('/api/price-master/syd/items?view=' + v)).rows.map((r) => r.syd_code).sort();
  assert.deepEqual(await codes('linked'), ['1026018', '54500-8H310']); assert.deepEqual(await codes('unlinked'), ['GY-421', 'K-9647']);
  assert.deepEqual(await codes('up'), ['54500-8H310']); assert.deepEqual(await codes('down'), ['1026018']);
  assert.deepEqual(await codes('new'), ['GY-421']); assert.deepEqual(await codes('same'), ['K-9647']);
});
await t('검색: 코드(기호 무시) · 품명 · CTR 코드 · Familia(없음) · 기호만이면 전체 아님', async () => {
  const codes = async (qs) => (await get('/api/price-master/syd/items?' + qs)).rows.map((r) => r.syd_code).sort();
  assert.deepEqual(await codes('q=545008h'), ['54500-8H310']); assert.deepEqual(await codes('q=dodge'), ['1026018']);
  assert.deepEqual(await codes('q=CB0012'), ['1026018']); assert.deepEqual(await codes('familia=__none__'), ['GY-421']);
  assert.deepEqual(await codes('familia=ROTULAS'), ['1026018']); assert.deepEqual(await codes('q=' + encodeURIComponent('%')), []);
  assert.deepEqual(await codes('q=--'), []);
});
await t('정렬: price desc · chg asc · ratio · 페이지', async () => {
  let d = await get('/api/price-master/syd/items?sort=price&dir=desc'); assert.deepEqual(d.rows.map((r) => r.syd_code), ['GY-421', '54500-8H310', 'K-9647', '1026018']);
  d = await get('/api/price-master/syd/items?sort=chg&dir=asc'); assert.deepEqual(d.rows.map((r) => r.syd_code).slice(0, 3), ['1026018', 'K-9647', '54500-8H310']);
  d = await get('/api/price-master/syd/items?sort=ratio&dir=desc'); assert.equal(d.rows[0].syd_code, '1026018');
  d = await get('/api/price-master/syd/items?sort=price&dir=desc&offset=1&limit=2'); assert.deepEqual(d.rows.map((r) => r.syd_code), ['54500-8H310', 'K-9647']); assert.equal(d.total, 4);
});
await t('코드 이력: 리스트별 가격(없으면 null) · 연결 CTR', async () => {
  let d = await get('/api/price-master/syd/items/history?code=1026018');
  assert.deepEqual(d.history.map((h) => [h.list_date, h.price]), [['2026-11-01', 225], ['2026-09-01', 250]]); assert.deepEqual(d.ctr.map((c) => c.code), ['CB0011', 'CB0012']);
  d = await get('/api/price-master/syd/items/history?code=gy421'); assert.equal(d.code, 'GY-421'); assert.deepEqual(d.history.map((h) => h.price), [1500, null]);
  assert.equal((await get('/api/price-master/syd/items/history?code=--')).status, 400);
});
await t('없는 list_id → 404', async () => { assert.equal((await get('/api/price-master/syd/items?list_id=99999')).status, 404); });
await app.close(); await pool.end();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
