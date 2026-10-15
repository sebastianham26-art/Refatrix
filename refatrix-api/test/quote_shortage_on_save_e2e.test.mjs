// =====================================================================
// 견적 부족분 — 저장 즉시 기록 · 견적 삭제해도 보존 · 견적번호 노출 (실 PostgreSQL) · 2026-10-15
//   실행: TEST_PG_URL=postgres://... node --test test/quote_shortage_on_save_e2e.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app, computeQuoteSummary;
const tok = {};
const ID = {};
const TAG = 'QSTEST';

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
  const P = `SELECT id FROM products WHERE code LIKE '${TAG}%'`;
  const custIds = (await query(`SELECT id FROM customers WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  const invIds = custIds.length ? (await query(`SELECT id FROM sales_invoices WHERE customer_id = ANY($1::bigint[])`, [custIds])).rows.map((r) => Number(r.id)) : [];
  await query(`DELETE FROM stock_shortage_resolutions WHERE shortage_id IN (SELECT id FROM stock_shortages WHERE product_id IN (${P}))`);
  await query(`DELETE FROM stock_shortages WHERE product_id IN (${P})`);
  if (invIds.length) {
    await query(`UPDATE sales_invoices SET txn_id=NULL WHERE id = ANY($1::bigint[])`, [invIds]).catch(() => {});
    await purgeRefs('sales_invoice_lines', (await query(`SELECT id FROM sales_invoice_lines WHERE invoice_id = ANY($1::bigint[])`, [invIds])).rows.map((r) => Number(r.id)));
    await purgeRefs('sales_invoices', invIds);
    await query(`DELETE FROM sales_invoice_lines WHERE invoice_id = ANY($1::bigint[])`, [invIds]);
    await query(`DELETE FROM sales_invoices WHERE id = ANY($1::bigint[])`, [invIds]);
  }
  const qIds = (await query(`SELECT id FROM quotes WHERE customer_id = ANY($1::bigint[]) OR memo LIKE '${TAG}%'`, [custIds])).rows.map((r) => Number(r.id));
  await query(`DELETE FROM quote_lines WHERE quote_id = ANY($1::bigint[])`, [qIds]);
  await purgeRefs('quotes', qIds);
  await query(`DELETE FROM quotes WHERE id = ANY($1::bigint[])`, [qIds]);
  await query(`DELETE FROM stock_movements WHERE product_id IN (${P})`);
  await purgeRefs('products', (await query(P)).rows.map((r) => Number(r.id)));
  await query(`DELETE FROM products WHERE code LIKE '${TAG}%'`);
  await purgeRefs('customers', custIds);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  const uids = (await query(`SELECT id FROM users WHERE login_id LIKE 'qstest%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [uids]).catch(() => {});
  await purgeRefs('users', uids);
  await query(`DELETE FROM users WHERE login_id LIKE 'qstest%'`);
}

const H = () => ({ authorization: 'Bearer ' + tok.dir });
const get = (url) => app.inject({ method: 'GET', url, headers: H() });
const post = (url, body) => app.inject({ method: 'POST', url, payload: body || {}, headers: H() });
const put = (url, body) => app.inject({ method: 'PUT', url, payload: body || {}, headers: H() });
const del = (url) => app.inject({ method: 'DELETE', url, headers: H() });
const rowsOf = async (qid) => (await query(
  `SELECT id, product_id, requested_qty::float AS req, fulfilled_qty::float AS ful, shortage_qty::float AS sh,
          resolved_qty::float AS res, status, sales_invoice_id, note, to_char(occurred_at,'YYYY-MM-DD') AS occ
     FROM stock_shortages WHERE source_quote_id=$1 ORDER BY id`, [qid])).rows;

test('boot', { skip: SKIP }, async () => {
  ({ query } = await import('../src/db.js'));
  ({ computeQuoteSummary } = await import('../src/quoteSummary.js'));
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  ID.dir = Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('${TAG}디렉터','director',$1,'qstest_dir') RETURNING id`, [hashPin('4321')])).rows[0].id);
  const mkP = async (code, stock) => Number((await query(
    `INSERT INTO products (code, name, stock_qty, avg_cost, list_price, ean) VALUES ($1,$2,$3,100,500,$4) RETURNING id`,
    [code, code + ' 부품', stock, '76' + String(Math.floor(Math.random() * 1e10)).padStart(11, '0')])).rows[0].id);
  ID.p1 = await mkP(`${TAG}-P1`, 5);
  ID.p2 = await mkP(`${TAG}-P2`, 5);
  ID.p3 = await mkP(`${TAG}-P3`, 2);
  ID.cust = Number((await query(
    `INSERT INTO customers (name, code, credit_days, rfc, owner_id, created_by, discount) VALUES ($1,$2,30,'XAXX010101000',$3,$3,0) RETURNING id`,
    [`${TAG}고객`, `${TAG}-C`, ID.dir])).rows[0].id);
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (r, body, done) => {
    if (!body || !String(body).trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
  });
  for (const f of ['quoteRoutes', 'salesRoutes']) await app.register((await import(`../src/routes/${f}.js`)).default);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
});

test('① 견적 저장 즉시 부족분 기록(전환 전) — 수정하면 같은 행이 따라가고, 부족이 없어져도 지우지 않는다', { skip: SKIP }, async () => {
  const r = await post('/api/quotes', { customer_id: ID.cust, memo: TAG, lines: [{ product_id: ID.p1, qty: 8 }] });
  assert.equal(r.statusCode, 200, r.body);
  ID.qA = r.json().id; ID.qAno = r.json().quote_no;
  let rows = await rowsOf(ID.qA);
  assert.equal(rows.length, 1, '저장하자마자 1행');
  assert.deepEqual([rows[0].req, rows[0].ful, rows[0].sh, rows[0].status, rows[0].sales_invoice_id], [8, 5, 3, 'open', null]);
  assert.match(rows[0].note, new RegExp(ID.qAno));
  ID.rowA = rows[0].id; const occ = rows[0].occ;

  // 수량을 10 으로 → 같은 행이 5 로
  assert.equal((await put(`/api/quotes/${ID.qA}`, { customer_id: ID.cust, lines: [{ product_id: ID.p1, qty: 10 }] })).statusCode, 200);
  rows = await rowsOf(ID.qA);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, ID.rowA); assert.equal(rows[0].sh, 5); assert.equal(rows[0].occ, occ, '최초 발생일 유지');
  // 수량 4 → 부족 없음 → 행은 남고 정리(cancelled)
  await put(`/api/quotes/${ID.qA}`, { customer_id: ID.cust, lines: [{ product_id: ID.p1, qty: 4 }] });
  rows = await rowsOf(ID.qA);
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'cancelled');
  // 다시 9 → 같은 행이 open 4
  await put(`/api/quotes/${ID.qA}`, { customer_id: ID.cust, lines: [{ product_id: ID.p1, qty: 9 }] });
  rows = await rowsOf(ID.qA);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, ID.rowA);
  assert.deepEqual([rows[0].sh, rows[0].status], [4, 'open']);
});

test('② 부족분 원장에 견적번호 · 견적 삭제해도 기록 보존(삭제 표시)', { skip: SKIP }, async () => {
  let l = (await get(`/api/shortages?status=all&product_id=${ID.p1}`)).json().items;
  const it = l.find((x) => Number(x.id) === Number(ID.rowA));
  assert.equal(it.quote_no, ID.qAno); assert.equal(it.source_quote_id, Number(ID.qA)); assert.equal(it.quote_deleted, false);

  assert.equal((await post(`/api/quotes/${ID.qA}/delete-request`, { reason: 'test' })).statusCode, 200);
  assert.equal((await post(`/api/quotes/${ID.qA}/delete-approve`)).statusCode, 200);
  const rows = await rowsOf(ID.qA);
  assert.equal(rows.length, 1, '견적 삭제 후에도 부족 기록은 그대로');
  assert.equal(rows[0].status, 'open'); assert.equal(rows[0].sh, 4);
  assert.match(rows[0].note, /견적 삭제됨/);
  l = (await get(`/api/shortages?status=open&product_id=${ID.p1}`)).json().items;
  const it2 = l.find((x) => Number(x.id) === Number(ID.rowA));
  assert.equal(it2.quote_no, ID.qAno); assert.equal(it2.quote_deleted, true);
});

test('③ 전환 — 새로 INSERT 하지 않고 같은 행을 실제 출고로 맞춤 · 자기 출고분으로 해소되지 않음', { skip: SKIP }, async () => {
  const r = await post('/api/quotes', { customer_id: ID.cust, memo: TAG, lines: [{ product_id: ID.p2, qty: 8 }] });
  ID.qB = r.json().id; ID.qBno = r.json().quote_no;
  let rows = await rowsOf(ID.qB);
  assert.equal(rows.length, 1); assert.equal(rows[0].sh, 3);
  await query(`INSERT INTO quote_packing_docs (quote_id, file_data, uploaded_at) VALUES ($1,'data:x',now())`, [ID.qB]);
  const cv = await post(`/api/quotes/${ID.qB}/convert`, { seller_id: ID.dir });
  assert.equal(cv.statusCode, 200, cv.body);
  ID.invB = Number(cv.json().invoice_id);
  rows = await rowsOf(ID.qB);
  assert.equal(rows.length, 1, '전환이 부족 행을 두 번 만들지 않는다');
  assert.deepEqual([rows[0].req, rows[0].ful, rows[0].sh, rows[0].res, rows[0].status, Number(rows[0].sales_invoice_id)],
    [8, 5, 3, 0, 'open', ID.invB]);
  const iss = (await get(`/api/sales/${ID.invB}/issues`)).json();
  assert.equal(iss.shortages[0].quote_no, ID.qBno);
  // 견적 목록 배지(인보이스 기준)
  const ql = (await get('/api/quotes?q=' + encodeURIComponent(ID.qBno))).json().items.find((x) => x.id === ID.qB);
  assert.equal(ql.shortage_cnt, 1);
});

test('④ 살아 있는 견적의 부족 행은 다른 판매로 해소되지 않는다 · 전환된 견적의 행은 해소된다', { skip: SKIP }, async () => {
  const r = await post('/api/quotes', { customer_id: ID.cust, memo: TAG, lines: [{ product_id: ID.p3, qty: 6 }] });
  ID.qC = r.json().id;
  assert.equal((await rowsOf(ID.qC))[0].sh, 6 - 2);
  await query(`UPDATE products SET stock_qty = stock_qty + 10 WHERE id IN ($1,$2)`, [ID.p3, ID.p2]);
  const s = await post('/api/sales', { customer_id: ID.cust, inv_date: new Date().toISOString().slice(0, 10), seller_id: ID.dir,
    lines: [{ product_id: ID.p3, qty: 3 }, { product_id: ID.p2, qty: 2 }] });
  assert.equal(s.statusCode, 200, s.body);
  ID.invD = Number(s.json().id);
  assert.equal((await rowsOf(ID.qC))[0].res, 0, '미결 견적 C 의 부족은 그대로');
  const b = (await rowsOf(ID.qB))[0];
  assert.deepEqual([b.res, b.status], [2, 'open'], '전환된 견적 B 의 잔여 3 중 2 해소');
});

test('⑤ 인보이스 삭제 — 견적 부족 행은 지우지 않고 인보이스만 끊은 뒤 견적 현재 상태로 다시 맞춘다', { skip: SKIP }, async () => {
  const d1 = await del(`/api/sales/${ID.invD}`); assert.equal(d1.statusCode, 200, d1.body);
  const d = await del(`/api/sales/${ID.invB}`); assert.equal(d.statusCode, 200, d.body);
  const q = (await query(`SELECT status FROM quotes WHERE id=$1`, [ID.qB])).rows[0];
  assert.equal(q.status, 'confirmed');
  const rows = await rowsOf(ID.qB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sales_invoice_id, null);
  assert.equal(rows[0].res, 0);
  assert.equal(rows[0].status, rows[0].sh > 0 ? 'open' : 'cancelled');
});

test('⑥ 만료·취소 견적 복제 → 원본 부족 행은 정리(보존), 복제본에 새 행', { skip: SKIP }, async () => {
  await query(`UPDATE quotes SET status='expired' WHERE id=$1`, [ID.qC]);
  await query(`UPDATE products SET stock_qty = 0 WHERE id=$1`, [ID.p3]);
  const r = await post(`/api/quotes/${ID.qC}/clone`);
  assert.equal(r.statusCode, 200, r.body);
  const src = await rowsOf(ID.qC);
  assert.equal(src.length, 1); assert.equal(src[0].status, 'cancelled'); assert.match(src[0].note, /복제 견적/);
  const cl = await rowsOf(r.json().id);
  assert.equal(cl.length, 1); assert.deepEqual([cl[0].sh, cl[0].status], [6, 'open']);
  ID.qClone = r.json().id;
});

test('⑦ 견적·매출 요약 — 미결 견적의 부족은 「실기」에 넣지 않는다', { skip: SKIP }, async () => {
  const ym = new Date().toISOString().slice(0, 7);
  const before = await computeQuoteSummary({ yms: [ym], scope: null });
  await post(`/api/quotes/${ID.qClone}/status`, { status: 'cancelled' });
  assert.match((await rowsOf(ID.qClone))[0].note, /견적 취소/);
  assert.equal((await rowsOf(ID.qClone))[0].status, 'open', '취소해도 기록 유지');
  assert.ok(before && typeof before === 'object');
  const src = readFileSync(new URL('../src/quoteSummary.js', import.meta.url), 'utf8');
  assert.match(src, /qs\.status IN \('converted','expired'\)/);
});

test('⑧ 0276 소급 — 열린 견적 부족을 한 번만 적는다', { skip: SKIP }, async () => {
  const q = Number((await query(
    `INSERT INTO quotes (quote_no, customer_id, status, created_by, memo) VALUES ($1,$2,'draft',$3,$4) RETURNING id`,
    [`${TAG}-MIG`, ID.cust, ID.dir, TAG])).rows[0].id);
  await query(`INSERT INTO quote_lines (quote_id, line_no, product_id, ctr_code, qty, reserved_qty, list_price, final_price)
               VALUES ($1,1,$2,'x',7,2,500,400),($1,2,$2,'x',3,3,500,400)`, [q, ID.p1]);
  const sql = readFileSync(new URL('../migrations/0276_quote_shortage_on_save.sql', import.meta.url), 'utf8');
  await query(sql); await query(sql);
  const rows = await rowsOf(q);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].req, rows[0].ful, rows[0].sh], [10, 5, 5]);
  const amt = Number((await query(`SELECT shortage_amount_mxn FROM stock_shortages WHERE id=$1`, [rows[0].id])).rows[0].shortage_amount_mxn);
  assert.equal(amt, 2320);
});

after(async () => {
  if (SKIP) return;
  try { await cleanup(); } catch (_) {}
  try { await app.close(); } catch (_) {}
  const { pool } = await import('../src/db.js');
  if (globalThis.__refatrixExpirySweeper) clearInterval(globalThis.__refatrixExpirySweeper);
  await pool.end();
});
