// =====================================================================
// 부족분 세부기록 · SKU별 구매·운송·백오더 (20261111sp) — 실 PostgreSQL 종단 검증 · 2026-11-11
//   GET /api/shortages/supply?product_ids=…&customer_id=…
//   가용 = 현재고 − 살아 있는 예약 · 구매 = 발주 미입고 − 운송 · 운송 = v_incoming_stock · 백오더 = v_backorder
//   백오더 반영 부족(이 고객) = max(0, 이 고객 잔여 − 가용 − 백오더)
//   백오더 반영 부족(전체)   = max(0, 이 고객 잔여 + 다른 고객(살아 있는) − 가용 − 백오더)
//   실행: TEST_PG_URL=postgres://... node --test test/shortage_supply_e2e.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app, tok;
const ID = {};
const TAG = 'SHSUP';

async function cleanup() {
  const pids = (await query(`SELECT id FROM products WHERE code LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  const cids = (await query(`SELECT id FROM customers WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM stock_shortages WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM inbound_pallet_items WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM inbound_pallets WHERE order_no LIKE '${TAG}%'`);
  await query(`DELETE FROM inbound_shipments WHERE invoice_no LIKE '${TAG}%'`);
  await query(`DELETE FROM purchase_order_lines WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM purchase_orders WHERE ref_no LIKE '${TAG}%'`);
  await query(`DELETE FROM quote_lines WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM quotes WHERE customer_id = ANY($1::bigint[])`, [cids]);
  await query(`DELETE FROM products WHERE id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [cids]);
  await query(`DELETE FROM users WHERE login_id LIKE 'shsup%'`);
}

const get = (url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok } });

test('boot', { skip: SKIP }, async () => {
  ({ query } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  ID.dir = Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('${TAG}디렉터','director',$1,'shsup_dir') RETURNING id`, [hashPin('4321')])).rows[0].id);
  const mkP = async (code, stock) => Number((await query(
    `INSERT INTO products (code, name, stock_qty, avg_cost, list_price, ean, is_active) VALUES ($1,'RÓTULA',$2,100,500,$3,true) RETURNING id`,
    [code, stock, '78' + String(Math.floor(Math.random() * 1e10)).padStart(11, '0')])).rows[0].id);
  ID.x = await mkP(`${TAG}-X`, 10);
  ID.y = await mkP(`${TAG}-Y`, 0);
  const mkC = async (n) => Number((await query(
    `INSERT INTO customers (name, code, credit_days, rfc, owner_id, created_by, discount) VALUES ($1,$2,30,$3,$4,$4,0) RETURNING id`,
    [`${TAG}${n}`, `${TAG}-${n}`, `SHS${n}${String(Date.now()).slice(-5)}AB1`, ID.dir])).rows[0].id);
  ID.c = await mkC('C'); ID.d = await mkC('D'); ID.e = await mkC('E'); ID.f = await mkC('F');
  const mkQ = async (no, cust, status) => Number((await query(
    `INSERT INTO quotes (quote_no, customer_id, quote_date, status, created_by, reserve_expires_at)
     VALUES ($1,$2,CURRENT_DATE,$3,$4, now() + interval '1 day') RETURNING id`, [no, cust, status, ID.dir])).rows[0].id);
  ID.qC = await mkQ(`${TAG}-QC`, ID.c, 'draft');
  ID.qD = await mkQ(`${TAG}-QD`, ID.d, 'confirmed');
  ID.qE = await mkQ(`${TAG}-QE`, ID.e, 'expired');
  // D 의 살아 있는 견적이 X 재고 3개를 예약 → 가용 7
  await query(`INSERT INTO quote_lines (quote_id, product_id, qty, reserved_qty) VALUES ($1,$2,11,3)`, [ID.qD, ID.x]);
  const mkS = async (pid, cust, qty, quoteId, resolved = 0, status = 'open') => Number((await query(
    `INSERT INTO stock_shortages (product_id, customer_id, requested_qty, fulfilled_qty, shortage_qty, resolved_qty, shortage_amount_mxn, occurred_at, source_quote_id, status)
     VALUES ($1,$2,$3,0,$3,$4,0,CURRENT_DATE,$5,$6) RETURNING id`, [pid, cust, qty, resolved, quoteId, status])).rows[0].id);
  await mkS(ID.x, ID.c, 25, ID.qC);           // C 진행 중 견적 25
  await mkS(ID.x, ID.c, 15, null, 5);         // C 직접 부족 15 중 5 해소 → 10
  await mkS(ID.x, ID.d, 8, ID.qD);            // D 살아 있는 8
  await mkS(ID.x, ID.e, 6, ID.qE);            // E 놓친 수요 6
  await mkS(ID.x, ID.f, 9, null, 9, 'resolved');   // F 해소완료 — 빠져야 함
  await mkS(ID.y, ID.c, 4, null);             // Y: 공급 없음, C 4
  // 발주 30 미입고, 그중 12 선적중
  const po = Number((await query(`INSERT INTO purchase_orders (ref_no, order_date) VALUES ('${TAG}-PO', CURRENT_DATE) RETURNING id`)).rows[0].id);
  await query(`INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd) VALUES ($1,$2,'x',30,1,30)`, [po, ID.x]);
  const sh = Number((await query(`INSERT INTO inbound_shipments (invoice_no, eta, status) VALUES ('${TAG}-INV', DATE '2026-12-05', 'incoming') RETURNING id`)).rows[0].id);
  const pal = Number((await query(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no) VALUES ($1,'${TAG}-PO',1) RETURNING id`, [sh])).rows[0].id);
  await query(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, product_id, input_code, cartons, qty) VALUES ($1,$2,$3,'x',1,12)`, [pal, sh, ID.x]);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register((await import('../src/routes/salesRoutes.js')).default);
  await app.ready();
  tok = app.jwt.sign({ sub: ID.dir });
});

test('① X — 가용 7 · 구매 18 · 운송 12(ETA) · 백오더 30 · 이 고객 35 · 다른 고객 8(1곳) · 놓친 6', { skip: SKIP }, async () => {
  const res = await get(`/api/shortages/supply?product_ids=${ID.x},${ID.y}&customer_id=${ID.c}`);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['cache-control']), /no-store/);
  const x = res.json().items.find((i) => i.product_id === ID.x);
  assert.deepEqual(
    [x.stock_qty, x.reserved_qty, x.avail_qty, x.purchase_qty, x.transit_qty, x.transit_eta, x.backorder_qty],
    [10, 3, 7, 18, 12, '2026-12-05', 30]);
  assert.deepEqual([x.cust_open_qty, x.others_live_qty, x.others_missed_qty, x.others_n], [35, 8, 6, 1]);
  // 백오더 반영: 이 고객 35 − 7 − 30 = 0(−2) · 전체 35 + 8 − 37 = 6
  assert.deepEqual([x.short_cust_qty, x.short_total_qty], [0, 6]);
  assert.equal(x.purchase_qty + x.transit_qty, x.backorder_qty);
  const names = x.others.map((g) => g.customer_name);
  assert.deepEqual(names, [`${TAG}D`, `${TAG}E`]);   // F(해소완료) 제외 · 살아 있는 순
  assert.equal(x.others[1].quotes[0].missed, true);
});

test('② Y — 공급 없음 → 백오더 반영 부족 = 이 고객 잔여 4', { skip: SKIP }, async () => {
  const y = (await get(`/api/shortages/supply?product_ids=${ID.y}&customer_id=${ID.c}`)).json().items[0];
  assert.deepEqual([y.avail_qty, y.purchase_qty, y.transit_qty, y.backorder_qty, y.cust_open_qty, y.short_cust_qty, y.short_total_qty], [0, 0, 0, 0, 4, 4, 4]);
});

test('③ 고객 없이(부족분 집계 탭) — 모든 고객이 다른 고객 몫', { skip: SKIP }, async () => {
  const x = (await get(`/api/shortages/supply?product_ids=${ID.x}`)).json().items[0];
  assert.deepEqual([x.cust_open_qty, x.others_live_qty, x.others_missed_qty, x.short_total_qty], [0, 43, 6, 6]);
});

test('④ 매번 다시 계산 — 선적 마감(운송→재고) 후 다시 부르면 바로 바뀐다', { skip: SKIP }, async () => {
  await query(`UPDATE inbound_shipments SET status='closed' WHERE invoice_no='${TAG}-INV'`).catch(async () => {
    await query(`UPDATE inbound_shipments SET deleted_at=now() WHERE invoice_no='${TAG}-INV'`);
  });
  const x = (await get(`/api/shortages/supply?product_ids=${ID.x}&customer_id=${ID.c}`)).json().items[0];
  assert.deepEqual([x.transit_qty, x.purchase_qty, x.backorder_qty], [0, 30, 30]);
});

test('⑤ product_ids 없음 → 400', { skip: SKIP }, async () => {
  assert.equal((await get(`/api/shortages/supply`)).statusCode, 400);
  assert.equal((await get(`/api/shortages/supply?product_ids=abc`)).statusCode, 400);
});

after(async () => { if (!SKIP) { await cleanup(); await app?.close(); (await import('../src/db.js')).pool?.end?.(); } });
