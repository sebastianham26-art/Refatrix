// 2026-11-23 · 가격표 FOB MXN · Total Cost MXN(단순가중평균 실적원가) — 실 PostgreSQL 종단 테스트
//   실행: PGADMIN_URL=postgres://postgres@localhost:5432/postgres PG_TEMPLATE=<전체 마이그레이션 적용 DB> node test/price_table_cost_pg.test.mjs
//   PG_TEMPLATE = migrations/*.sql 을 전부 적용한 DB 이름(CREATE DATABASE … TEMPLATE 로 복제해 씀).
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import pg from 'pg';
const ADMIN = process.env.PGADMIN_URL || '';
if (!ADMIN || !process.env.PG_TEMPLATE) { console.log('PGADMIN_URL · PG_TEMPLATE 없음 — 건너뜀'); process.exit(0); }
const DB = 'pmtest_cost1123';
{ const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a.query(`CREATE DATABASE ${DB} TEMPLATE ${process.env.PG_TEMPLATE || 'template1'}`); await a.end(); }
{ const u = new URL(ADMIN); u.pathname = '/' + DB; process.env.DATABASE_URL = u.toString(); }
const { pool, query } = await import('../src/db.js');
const { hashPin } = await import('../src/auth.js');
const { flatAvgCost } = await import('../src/flatAvgCost.js');
const priceMasterRoutes = (await import('../src/routes/priceMasterRoutes.js')).default;
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ✔', name); } catch (e) { fail++; console.log('  ✘', name, '\n     ', e.message.split('\n').slice(0, 6).join('\n      ')); } }

await query(`INSERT INTO users (id,name,login_id,role,pin_hash) OVERRIDING SYSTEM VALUE VALUES (1,'Sebastian','seb','director',$1)
  ON CONFLICT (id) DO UPDATE SET role='director', pin_hash=EXCLUDED.pin_hash`, [hashPin('1234')]);
const ins = async (code, fob, list, avg) => Number((await query(`INSERT INTO products (code,name,origin,fob_usd,list_price,avg_cost,is_active) VALUES ($1,'X','KR',$2,$3,$4,true) RETURNING id`, [code, fob, list, avg])).rows[0].id);
const A = await ins('AAA1', 10, 900, 999);    // 수입 2회(원가 변동) → 가중평균, 저장값(999) 무시
const B = await ins('BBB1', 5, 400, 150.456); // 수입 없음 → 저장 평균원가
const C = await ins('CCC1', null, 300, 0);    // FOB·원가 없음
const D = await ins('DDD1', 8, 500, 0);       // 삭제·반려·대기·원가제외 배치만 → 원가 없음
await query(`DELETE FROM fx_rates`);
await query(`INSERT INTO fx_rates (base,quote,rate,rate_date) VALUES ('USD','MXN',18.00,'2026-09-01'),('USD','MXN',18.35,'2026-11-20')`);
const batch = async (status, extra = {}) => Number((await query(`INSERT INTO import_batches (status, import_date, fx_rate, deleted_at, exclude_from_cost) VALUES ($1, CURRENT_DATE, 18, $2, $3) RETURNING id`, [status, extra.deleted ? new Date() : null, !!extra.excl])).rows[0].id);
const b1 = await batch('approved'); const b2 = await batch('approved');
const bDel = await batch('approved', { deleted: 1 }); const bRej = await batch('rejected'); const bPen = await batch('pending'); const bEx = await batch('approved', { excl: 1 });
const line = (b, p, q, u) => query(`INSERT INTO import_lines (batch_id,product_id,qty,import_price,unit_cost_mxn) VALUES ($1,$2,$3,1,$4)`, [b, p, q, u]);
await line(b1, A, 100, 200); await line(b2, A, 50, 260);      // (100×200 + 50×260) / 150 = 220
await line(b2, A, 10, null);                                   // 입고단가 미계산 줄은 분모에서 빠짐
for (const b of [bDel, bRej, bPen, bEx]) { await line(b, A, 1000, 9999); await line(b, D, 10, 500); }

// 판매 누적: 게시 인보이스만(삭제 상태·삭제일 제외)
const cus = Number((await query(`INSERT INTO customers (code,name) VALUES ('TCUS1','Cliente') RETURNING id`)).rows[0].id);
const inv = async (status, date, del = false) => Number((await query(`INSERT INTO sales_invoices (customer_id, inv_date, status, deleted_at) VALUES ($1,$2,$3,$4) RETURNING id`, [cus, date, status, del ? new Date() : null])).rows[0].id);
const sl = (i, p, q) => query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, unit_price, line_amount_mxn) VALUES ($1,$2,$3,1,1,$4)`, [i, p, q, q * 300]);
const i1 = await inv('posted', '2026-10-01'); const i2 = await inv('posted', '2026-11-15'); const iD = await inv('deleted', '2026-11-20'); const iX = await inv('posted', '2026-11-21', true);
await sl(i1, A, 30); await sl(i2, A, 12); await sl(i2, B, 4); await sl(iD, A, 500); await sl(iX, A, 700);

const app = Fastify();
app.decorateRequest('jwtVerify', async function () { this.user = { sub: 1 }; });
app.register(priceMasterRoutes); await app.ready();
const get = async (u) => { const r = await app.inject({ method: 'GET', url: u }); return { status: r.statusCode, ...r.json() }; };

await t('FOB MXN = FOB × 최신 환율(18.35) · 환율 없으면 null 아님', async () => {
  const d = await get('/api/price-master/table?limit=50'); assert.equal(d.status, 200, JSON.stringify(d));
  const r = Object.fromEntries(d.rows.map((x) => [x.code, x]));
  assert.equal(d.fx.rate, 18.35);
  assert.equal(r.AAA1.fob_mxn, 183.5); assert.equal(r.BBB1.fob_mxn, 91.75); assert.equal(r.CCC1.fob_mxn, null);
});
await t('Total Cost MXN: 승인 배치 가중평균 220 · 수입 2회 · 150개 · 살아있는 배치만', async () => {
  const d = await get('/api/price-master/table?limit=50'); const r = Object.fromEntries(d.rows.map((x) => [x.code, x]));
  assert.equal(r.AAA1.total_cost_mxn, 220); assert.equal(r.AAA1.cost_basis, 'import'); assert.equal(r.AAA1.cost_batches, 2); assert.equal(r.AAA1.cost_qty, 150);
  const f = await flatAvgCost({ query: (s, p) => query(s, p) }, [A]); assert.equal(f[A], 220);   // 입고 승인 때의 평균원가 식과 일치
});
await t('수입 기록 없음 → 저장 평균원가(stored) · 둘 다 없음 → null · 제외 배치만 → null', async () => {
  const d = await get('/api/price-master/table?limit=50'); const r = Object.fromEntries(d.rows.map((x) => [x.code, x]));
  assert.equal(r.BBB1.total_cost_mxn, 150.46); assert.equal(r.BBB1.cost_basis, 'stored');
  assert.equal(r.CCC1.total_cost_mxn, null); assert.equal(r.CCC1.cost_basis, null);
  assert.equal(r.DDD1.total_cost_mxn, null);
});
await t('정렬 cost desc / asc · fobmxn · 보기 필터와 같이', async () => {
  let d = await get('/api/price-master/table?sort=cost&dir=desc'); assert.deepEqual(d.rows.map((x) => x.code), ['AAA1', 'BBB1', 'CCC1', 'DDD1']);
  d = await get('/api/price-master/table?sort=cost&dir=asc'); assert.deepEqual(d.rows.map((x) => x.code).slice(0, 2), ['BBB1', 'AAA1']);
  d = await get('/api/price-master/table?sort=fobmxn'); assert.equal(d.rows[0].code, 'AAA1');
  d = await get('/api/price-master/table?view=mult_lt&sort=last'); assert.equal(d.status, 200);   // 환율 파라미터 + LATERAL 같이
  d = await get('/api/price-master/table?sort=cost&dir=desc&offset=1&limit=2'); assert.deepEqual(d.rows.map((x) => x.code), ['BBB1', 'CCC1']);
  d = await get('/api/price-master/table?view=no_fob'); assert.deepEqual(d.rows.map((x) => x.code), ['CCC1']); assert.equal(d.kpi.total, 1);
});
await t('판매 누적: 게시 인보이스 합(A 42 · 2건 · 마지막 11-15, B 4, C 0) · 삭제 상태·삭제일 제외 · 정렬 sold', async () => {
  let d = await get('/api/price-master/table?limit=50'); const r = Object.fromEntries(d.rows.map((x) => [x.code, x]));
  assert.equal(r.AAA1.sold_qty, 42); assert.equal(r.AAA1.sold_inv_n, 2); assert.equal(r.AAA1.last_sale, '2026-11-15');
  assert.equal(r.BBB1.sold_qty, 4); assert.equal(r.CCC1.sold_qty, 0); assert.equal(r.CCC1.last_sale, null);
  d = await get('/api/price-master/table?sort=sold&dir=desc'); assert.deepEqual(d.rows.map((x) => x.code).slice(0, 2), ['AAA1', 'BBB1']);
});
await t('총 매출액 · 매출이익액 · 매출이익률 (Total Cost × 판매수량) · KPI 누적', async () => {
  let d = await get('/api/price-master/table?limit=50'); const r = Object.fromEntries(d.rows.map((x) => [x.code, x]));
  // A: 매출 42×300=12600, 원가 42×220=9240 → 이익 3360 · 26.67%
  assert.equal(r.AAA1.sales_mxn, 12600); assert.equal(r.AAA1.gross_profit_mxn, 3360); assert.equal(r.AAA1.gross_margin, 0.2667);
  // B: 매출 1200, 원가 4×150.456=601.824 → 화면 원가 150.46 기준 598.16 · 49.85%
  assert.equal(r.BBB1.sales_mxn, 1200); assert.equal(r.BBB1.gross_profit_mxn, 598.16); assert.equal(r.BBB1.gross_margin, 0.4985);
  assert.equal(r.CCC1.sales_mxn, 0); assert.equal(r.CCC1.gross_profit_mxn, null); assert.equal(r.CCC1.gross_margin, null);
  // KPI: 매출 13800 · 이익 3958.16 · 이익률 3958.16/13800
  assert.equal(d.kpi.sales_mxn, 13800); assert.equal(d.kpi.gross_profit_mxn, 3958.16); assert.equal(d.kpi.gross_margin, 0.2868); assert.equal(d.kpi.sales_nocost_mxn, 0);
  d = await get('/api/price-master/table?sort=gp&dir=desc'); assert.deepEqual(d.rows.map((x) => x.code).slice(0, 2), ['AAA1', 'BBB1']);
  d = await get('/api/price-master/table?sort=gpm&dir=desc'); assert.deepEqual(d.rows.map((x) => x.code).slice(0, 2), ['BBB1', 'AAA1']);
  d = await get('/api/price-master/table?sort=rev&dir=desc'); assert.equal(d.rows[0].code, 'AAA1');
  d = await get('/api/price-master/table?q=BBB1'); assert.equal(d.kpi.sales_mxn, 1200); assert.equal(d.kpi.gross_margin, 0.4985);   // 조건 따라 KPI
});
await t('원가 없는 제품의 매출은 이익률 분모에서 빠지고 sales_nocost 로 알림', async () => {
  const iz = await inv('posted', '2026-11-22'); await sl(iz, C, 2);   // C: 원가 없음, 매출 600
  const d = await get('/api/price-master/table?limit=50');
  assert.equal(d.kpi.sales_mxn, 14400); assert.equal(d.kpi.gross_profit_mxn, 3958.16); assert.equal(d.kpi.gross_margin, 0.2868); assert.equal(d.kpi.sales_nocost_mxn, 600);
  const c = d.rows.find((x) => x.code === 'CCC1'); assert.equal(c.sales_mxn, 600); assert.equal(c.gross_profit_mxn, null);
});
await t('원가 변동: 새 배치(300×50) 승인 → 평균 240 → 이익도 다시 계산', async () => {
  const b3 = await batch('approved'); await line(b3, A, 50, 300);
  const d = await get('/api/price-master/table?q=AAA1'); assert.equal(d.rows[0].total_cost_mxn, 240); assert.equal(d.rows[0].cost_batches, 3); assert.equal(d.rows[0].gross_profit_mxn, 12600 - 42 * 240);
});
await t('환율 없음 → fob_mxn null (원가는 그대로)', async () => {
  await query(`DELETE FROM fx_rates`);
  const d = await get('/api/price-master/table?q=AAA1'); assert.equal(d.rows[0].fob_mxn, null); assert.equal(d.rows[0].total_cost_mxn, 240);
});
await app.close(); await pool.end();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
