// =====================================================================
// 부족분 ↔ 발주 ↔ 입고 (0277) — 실 PostgreSQL 종단 검증 · 2026-10-15
//   디렉터 결정: 입고 시 해소 · 해소 전 발주가 있으면 「발주됨」 표시(반복 발주 방지) · 발주 연결 자동 FIFO
//   실행: TEST_PG_URL=postgres://... node --test test/shortage_receipt_e2e.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app;
const tok = {};
const ID = {};
const TAG = 'SRTEST';

async function purgeRefs(table, ids) {
  if (!ids.length) return;
  const fks = (await query(
    `SELECT c.conrelid::regclass::text AS t, a.attname AS col
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.confrelid = $1::regclass AND c.contype='f'`, [table])).rows;
  for (let pass = 0; pass < 3; pass++) {
    for (const f of fks) {
      if (f.t === table) continue;
      await query(`DELETE FROM ${f.t} WHERE ${f.col} = ANY($1::bigint[])`, [ids]).catch(() => {});
    }
  }
}
async function cleanup() {
  const pids = (await query(`SELECT id FROM products WHERE code LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  const custIds = (await query(`SELECT id FROM customers WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM offer_sheet_items WHERE product_id = ANY($1::bigint[])`, [pids]).catch(() => {});
  await query(`DELETE FROM offer_sheets WHERE customer_id = ANY($1::bigint[])`, [custIds]).catch(() => {});
  await query(`DELETE FROM stock_shortage_resolutions WHERE shortage_id IN (SELECT id FROM stock_shortages WHERE product_id = ANY($1::bigint[]))`, [pids]);
  await query(`DELETE FROM stock_shortages WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM inbound_prestock WHERE product_id = ANY($1::bigint[])`, [pids]);
  const bIds = (await query(`SELECT id FROM import_batches WHERE batch_no LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM stock_movements WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM import_lines WHERE batch_id = ANY($1::bigint[])`, [bIds]);
  await query(`DELETE FROM import_overheads WHERE batch_id = ANY($1::bigint[])`, [bIds]).catch(() => {});
  await purgeRefs('import_batches', bIds);
  await query(`DELETE FROM import_batches WHERE id = ANY($1::bigint[])`, [bIds]);
  await query(`DELETE FROM purchase_order_lines WHERE po_id IN (SELECT id FROM purchase_orders WHERE ref_no LIKE '${TAG}%')`);
  await query(`DELETE FROM purchase_orders WHERE ref_no LIKE '${TAG}%'`);
  const qIds = (await query(`SELECT id FROM quotes WHERE customer_id = ANY($1::bigint[])`, [custIds])).rows.map((r) => Number(r.id));
  await query(`DELETE FROM quote_lines WHERE quote_id = ANY($1::bigint[])`, [qIds]);
  await purgeRefs('quotes', qIds);
  await query(`DELETE FROM quotes WHERE id = ANY($1::bigint[])`, [qIds]);
  await purgeRefs('products', pids);
  await query(`DELETE FROM products WHERE id = ANY($1::bigint[])`, [pids]);
  await purgeRefs('customers', custIds);
  await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [custIds]);
  const uids = (await query(`SELECT id FROM users WHERE login_id LIKE 'srtest%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [uids]).catch(() => {});
  await purgeRefs('users', uids);
  await query(`DELETE FROM users WHERE login_id LIKE 'srtest%'`);
}

const H = () => ({ authorization: 'Bearer ' + tok.dir });
const get = (url) => app.inject({ method: 'GET', url, headers: H() });
const post = (url, body) => app.inject({ method: 'POST', url, payload: body || {}, headers: H() });
const del = (url) => app.inject({ method: 'DELETE', url, headers: H() });
const review = async () => (await get(`/api/purchases/review?q=${TAG}-X`)).json().items.find((x) => x.product_id === ID.p);
const sh = async (id) => (await query(`SELECT shortage_qty::float AS s, resolved_qty::float AS r, status FROM stock_shortages WHERE id=$1`, [id])).rows[0];
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);

test('boot', { skip: SKIP }, async () => {
  ({ query } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  ID.dir = Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('${TAG}디렉터','director',$1,'srtest_dir') RETURNING id`, [hashPin('4321')])).rows[0].id);
  ID.p = Number((await query(
    `INSERT INTO products (code, name, stock_qty, avg_cost, list_price, ean, is_active) VALUES ($1,'부품',0,100,500,$2,true) RETURNING id`,
    [`${TAG}-X`, '78' + String(Math.floor(Math.random() * 1e10)).padStart(11, '0')])).rows[0].id);
  const mkC = async (n) => Number((await query(
    `INSERT INTO customers (name, code, credit_days, rfc, owner_id, created_by, discount) VALUES ($1,$2,30,$4,$3,$3,0) RETURNING id`,
    [`${TAG}${n}`, `${TAG}-${n}`, ID.dir, `SRT${n}${String(Date.now()).slice(-6)}AB${n}`])).rows[0].id);
  ID.c1 = await mkC('A'); ID.c2 = await mkC('B');
  // 부족 기록: C1 4개(5일 전), C2 3개(3일 전)
  const mkS = async (c, n, d) => Number((await query(
    `INSERT INTO stock_shortages (product_id, customer_id, requested_qty, fulfilled_qty, shortage_qty, shortage_amount_mxn, occurred_at, note)
     VALUES ($1,$2,$3,0,$3,0,$4,'${TAG}') RETURNING id`, [ID.p, c, n, d])).rows[0].id);
  ID.s1 = await mkS(ID.c1, 4, ago(5)); ID.s2 = await mkS(ID.c2, 3, ago(3));
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (r, body, done) => {
    if (!body || !String(body).trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
  });
  for (const f of ['quoteRoutes', 'salesRoutes', 'purchaseRoutes', 'importRoutes', 'stockRoutes', 'importCostRoutes']) {
    await app.register((await import(`../src/routes/${f}.js`)).default);
  }
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  // 진행 중 견적(C1, 2개) — 저장 즉시 부족 행
  const q = await post('/api/quotes', { customer_id: ID.c1, lines: [{ product_id: ID.p, qty: 2 }] });
  assert.equal(q.statusCode, 200, q.body);
  ID.q = q.json().id;
  ID.s3 = Number((await query(`SELECT id FROM stock_shortages WHERE source_quote_id=$1`, [ID.q])).rows[0].id);
});

test('① 발주 전 — 부족 잔여 9 전부 미발주', { skip: SKIP }, async () => {
  const r = await review();
  assert.deepEqual([r.shortage_qty, r.shortage_covered_qty, r.shortage_unordered_qty], [9, 0, 9]);
});

test('② 발주 5개 → 오래된 부족부터 「발주됨」(FIFO) · 미발주 4만 남음', { skip: SKIP }, async () => {
  const po = Number((await query(`INSERT INTO purchase_orders (ref_no, order_date) VALUES ('${TAG}-PO-A', $1) RETURNING id`, [ago(2)])).rows[0].id);
  await query(`INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd) VALUES ($1,$2,'x',5,1,5)`, [po, ID.p]);
  const r = await review();
  assert.deepEqual([r.backorder_qty, r.shortage_covered_qty, r.shortage_unordered_qty], [5, 5, 4]);
  const d = (await get(`/api/purchases/review/${ID.p}/shortages`)).json();
  assert.deepEqual([d.summary.remaining, d.summary.covered, d.summary.unordered], [9, 5, 4]);
  const by = new Map(d.items.map((x) => [x.id, x]));
  assert.deepEqual([by.get(ID.s1).ordered_qty, by.get(ID.s1).unordered_qty], [4, 0]);
  assert.equal(by.get(ID.s1).covers[0].ref_no, `${TAG}-PO-A`);
  assert.deepEqual([by.get(ID.s2).ordered_qty, by.get(ID.s2).unordered_qty], [1, 2]);
  assert.deepEqual([by.get(ID.s3).ordered_qty, by.get(ID.s3).unordered_qty, by.get(ID.s3).live_quote], [0, 2, true]);
  assert.ok(by.get(ID.s3).quote_no);
});

test('③ 입고(수입배치 승인) 6개 → 오래된 부족부터 입고 해소 · 원장에 배치 · 재오퍼 시트 생성', { skip: SKIP }, async () => {
  const b = await post('/api/imports', { batch_no: `${TAG}-B1`, import_date: ago(0), fx_rate: 18,
    lines: [{ product_id: ID.p, qty: 6, import_price: 1 }] });
  assert.equal(b.statusCode, 200, b.body);
  ID.b1 = Number(b.json().id || b.json().batch_id);
  const ap = await post(`/api/imports/${ID.b1}/approve`);
  assert.equal(ap.statusCode, 200, ap.body);
  assert.equal(ap.json().shortage_resolved, 6);
  assert.deepEqual(await sh(ID.s1), { s: 4, r: 4, status: 'resolved' });
  assert.deepEqual(await sh(ID.s2), { s: 3, r: 2, status: 'open' });
  assert.deepEqual(await sh(ID.s3), { s: 2, r: 0, status: 'open' }, '진행 중 견적 행은 입고로 해소하지 않는다');
  const r = await review();
  assert.deepEqual([r.backorder_qty, r.shortage_qty, r.shortage_covered_qty, r.shortage_unordered_qty], [0, 3, 0, 3]);
  const d = (await get(`/api/purchases/review/${ID.p}/shortages`)).json();
  const s1 = d.items.find((x) => x.id === ID.s1);
  assert.equal(s1.resolutions[0].source, 'receipt');
  assert.equal(s1.resolutions[0].batch_no, `${TAG}-B1`);
  const offered = (await query(`SELECT shortage_id, offer_qty::float AS q FROM offer_sheet_items WHERE product_id=$1 ORDER BY shortage_id`, [ID.p])).rows;
  assert.ok(offered.find((o) => Number(o.shortage_id) === ID.s1 && o.q === 4), '입고 해소분도 고객 재오퍼 대상: ' + JSON.stringify(offered));
});

test('④ 창고 입고·원가 승인 대기(선반영) 수량은 「발주됨」으로 덮는다', { skip: SKIP }, async () => {
  await query(`INSERT INTO inbound_prestock (product_id, qty) VALUES ($1, 2)`, [ID.p]);
  const r = await review();
  assert.deepEqual([r.shortage_covered_qty, r.shortage_unordered_qty, r.prestock_qty], [2, 1, 2]);
  const d = (await get(`/api/purchases/review/${ID.p}/shortages`)).json();
  assert.equal(d.items.find((x) => x.id === ID.s2).covers[0].kind, 'prestock');
  await query(`DELETE FROM inbound_prestock WHERE product_id=$1`, [ID.p]);
});

test('⑤ 배치 삭제 → 입고 해소 되돌림(원장 삭제·잔여 복원)', { skip: SKIP }, async () => {
  const r = await del(`/api/stock/batches/${ID.b1}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(await sh(ID.s1), { s: 4, r: 0, status: 'open' });
  assert.deepEqual(await sh(ID.s2), { s: 3, r: 0, status: 'open' });
  const n = (await query(`SELECT COUNT(*)::int n FROM stock_shortage_resolutions WHERE import_batch_id=$1`, [ID.b1])).rows[0].n;
  assert.equal(n, 0);
  const rv = await review();
  assert.deepEqual([rv.backorder_qty, rv.shortage_covered_qty, rv.shortage_unordered_qty], [5, 5, 4], '발주 잔량도 복원되어 다시 「발주됨」');
});

test('⑥ 원가 화면 배치 삭제 → 복원 → 안전삭제: 해소가 따라 되돌려지고 다시 생긴다', { skip: SKIP }, async () => {
  const b = await post('/api/imports', { batch_no: `${TAG}-B2`, import_date: ago(0), fx_rate: 18,
    lines: [{ product_id: ID.p, qty: 4, import_price: 1 }] });
  ID.b2 = Number(b.json().id || b.json().batch_id);
  assert.equal((await post(`/api/imports/${ID.b2}/approve`)).statusCode, 200);
  assert.deepEqual(await sh(ID.s1), { s: 4, r: 4, status: 'resolved' });
  const d1 = await del(`/api/import-batches/${ID.b2}`); assert.equal(d1.statusCode, 200, d1.body);
  assert.deepEqual(await sh(ID.s1), { s: 4, r: 0, status: 'open' });
  const rs = await post(`/api/import-batches/${ID.b2}/restore`); assert.equal(rs.statusCode, 200, rs.body);
  assert.deepEqual(await sh(ID.s1), { s: 4, r: 4, status: 'resolved' });
  const sd = await post(`/api/import-batches/${ID.b2}/safe-delete`); assert.equal(sd.statusCode, 200, sd.body);
  assert.deepEqual(await sh(ID.s1), { s: 4, r: 0, status: 'open' });
});

after(async () => {
  if (SKIP) return;
  try { await cleanup(); } catch (_) {}
  try { await app.close(); } catch (_) {}
  if (globalThis.__refatrixExpirySweeper) clearInterval(globalThis.__refatrixExpirySweeper);
  const { pool } = await import('../src/db.js');
  await pool.end();
});
