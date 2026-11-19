// =====================================================================
// 구매내역 엑셀(금액 제외) — /api/purchases/lines?export=1 · 실 PostgreSQL 종단 검증 · 2026-11-19
//   디렉터 결정: 구매 화면을 볼 수 있는 사람 모두 다운로드 · 오더번호 · 제품번호 · 수량 · 구매일자 (금액 제외)
//   실행: TEST_PG_URL=postgres://... node --test test/purchase_history_export.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app;
const ID = {};
const TAG = 'PHX';
const tok = {};

async function cleanup() {
  const po = (await query(`SELECT id FROM purchase_orders WHERE ref_no LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM purchase_order_lines WHERE po_id = ANY($1::bigint[])`, [po]);
  await query(`DELETE FROM purchase_orders WHERE id = ANY($1::bigint[])`, [po]);
  await query(`DELETE FROM products WHERE code LIKE '${TAG}%'`);
  const us = (await query(`SELECT id FROM users WHERE login_id LIKE 'phx%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM user_page_access WHERE user_id = ANY($1::bigint[])`, [us]);
  await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [us]);
}
const get = (who, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[who] } });

test('boot', { skip: SKIP }, async () => {
  ({ query } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  const mkU = async (login, role) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,$3,$4) RETURNING id`, [TAG + login, role, hashPin('4321'), login])).rows[0].id);
  ID.dir = await mkU('phx_dir', 'director');
  ID.staff = await mkU('phx_staff', 'sales_support');   // 구매 화면 권한만, 원가 권한 없음
  ID.none = await mkU('phx_none', 'sales_support');     // 구매 화면 권한 없음
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'purchase','anywhere','view')`, [ID.staff]);
  ID.p1 = Number((await query(
    `INSERT INTO products (code, name, stock_qty, avg_cost, list_price, ean) VALUES ('${TAG}-A','PIEZA',5,10,50,$1) RETURNING id`,
    ['77' + String(Math.floor(Math.random() * 1e10)).padStart(11, '0')])).rows[0].id);
  const mkPO = async (ref, date, status = 'recorded') => Number((await query(
    `INSERT INTO purchase_orders (ref_no, order_date, currency, status, created_by) VALUES ($1,$2,'USD',$3,$4) RETURNING id`,
    [ref, date, status, ID.dir])).rows[0].id);
  ID.po1 = await mkPO(`${TAG}-PO1`, '2026-07-03');
  ID.po2 = await mkPO(`${TAG}-PO2`, '2026-11-01');
  ID.poX = await mkPO(`${TAG}-POX`, '2026-08-01', 'cancelled');
  const mkL = (po, code, pid, qty, cost) => query(
    `INSERT INTO purchase_order_lines (po_id, input_code, product_id, qty, unit_cost_usd, amount_usd, received_qty)
     VALUES ($1,$2,$3,$4,$5,$6,0)`, [po, code, pid, qty, cost, Math.round(qty * cost * 100) / 100]);
  await mkL(ID.po1, `${TAG}-A`, ID.p1, 100, 4.2);
  await mkL(ID.po1, `${TAG}-UNM`, null, 7, 1.5);        // 미매칭 코드도 입력 코드로 나와야
  await mkL(ID.po2, `${TAG}-A`, ID.p1, 40, 4.3);
  await mkL(ID.poX, `${TAG}-A`, ID.p1, 999, 4.3);       // 취소 건 — 제외
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register((await import('../src/routes/purchaseRoutes.js')).default);
  await app.ready();
  for (const k of ['dir', 'staff', 'none']) tok[k] = app.jwt.sign({ sub: ID[k] });
});

test('① 화면 권한자(원가 권한 없음) — 다운로드 가능 · 금액 비공개 · 날짜 문자열', { skip: SKIP }, async () => {
  const r = await get('staff', `/api/purchases/lines?q=${TAG}&export=1`);
  assert.equal(r.statusCode, 200);
  const d = r.json();
  assert.equal(d.cost_visible, false);
  assert.equal(d.items.length, 3);
  assert.equal(d.truncated, false);
  assert.equal(d.limit, 50000);
  for (const it of d.items) { assert.equal(it.unit_cost_usd, null); assert.equal(it.amount_usd, null); }
  const unm = d.items.find((x) => x.input_code === `${TAG}-UNM`);
  assert.equal(unm.od, '2026-07-03'); assert.equal(unm.ref_no, `${TAG}-PO1`); assert.equal(unm.qty, 7);
  assert.ok(!d.items.some((x) => x.ref_no === `${TAG}-POX`), '취소 건 제외');
});

test('② 기간 조건 적용', { skip: SKIP }, async () => {
  const d = (await get('staff', `/api/purchases/lines?q=${TAG}&from=2026-10-01&to=2026-11-30&export=1`)).json();
  assert.deepEqual(d.items.map((x) => [x.od, x.ref_no, x.matched_code, x.qty]), [['2026-11-01', `${TAG}-PO2`, `${TAG}-A`, 40]]);
});

test('③ 화면 권한 없음 → 403', { skip: SKIP }, async () => {
  const r = await get('none', `/api/purchases/lines?q=${TAG}&export=1`);
  assert.equal(r.statusCode, 403);
});

test('④ 기존 조회(export 없음) 상한 3000 그대로 · 디렉터 원가 보임', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/purchases/lines?q=${TAG}`)).json();
  assert.equal(d.limit, 1000);
  assert.equal(d.cost_visible, true);
  assert.ok(d.items.every((x) => x.unit_cost_usd != null));
  const d2 = (await get('dir', `/api/purchases/lines?q=${TAG}&limit=99999`)).json();
  assert.equal(d2.limit, 3000);
});

test('⑤ export 결과가 상한에 닿으면 truncated', { skip: SKIP }, async () => {
  const d = (await get('staff', `/api/purchases/lines?q=${TAG}&export=1&limit=2`)).json();
  assert.equal(d.items.length, 2); assert.equal(d.truncated, true);
});

after(async () => { if (!SKIP) { await cleanup(); await app?.close(); const { pool } = await import('../src/db.js'); await pool?.end?.(); } });
