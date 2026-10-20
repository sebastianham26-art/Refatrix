// =====================================================================
// 구매검토 · 놓친 수요 / 실구매 필요 · 가용재고 (pr-1019av) — 실 PostgreSQL 종단 검증 · 2026-10-19
//   배경: CB0089 — 재고 80인데 「미발주 부족 1」. 원인은 SYD 업로드로 개발요청이 자동 개발완료되며
//   만료된 견적(Q-2026-0040)의 수요가 부족분 대장에 적재된 것. 디렉터 결정:
//   ① 원 견적이 만료·취소·삭제된 부족 = 「놓친 수요」 — 미발주·실구매 필요에서 제외, 따로 표시
//   ② 실구매 필요 = 미발주 부족 − 가용재고(현재재고 − 살아 있는 견적 예약) — 재고로 채울 수 있는 부족은 오퍼 대상,
//      다른 견적에 잡힌 재고로 메운 것처럼 보이지 않게(필요한 발주 누락 방지)
//   실행: TEST_PG_URL=postgres://... node --test test/purchasereview_need_e2e.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app;
const ID = {};
let tok;
const TAG = 'PRNEED';

async function cleanup() {
  const pids = (await query(`SELECT id FROM products WHERE code LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  const cids = (await query(`SELECT id FROM customers WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM stock_shortages WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM purchase_order_lines WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM purchase_orders WHERE ref_no LIKE '${TAG}%'`);
  await query(`DELETE FROM quote_lines WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM quotes WHERE customer_id = ANY($1::bigint[])`, [cids]);
  await query(`DELETE FROM products WHERE id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [cids]);
  await query(`DELETE FROM users WHERE login_id LIKE 'prneed%'`);
}

const get = (url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok } });
const row = async (code) => (await get(`/api/purchases/review?q=${code}`)).json().items.find((x) => x.ctr === code);

test('boot', { skip: SKIP }, async () => {
  ({ query } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  ID.dir = Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('${TAG}디렉터','director',$1,'prneed_dir') RETURNING id`, [hashPin('4321')])).rows[0].id);
  const mkP = async (code, stock) => Number((await query(
    `INSERT INTO products (code, name, stock_qty, avg_cost, list_price, ean, is_active) VALUES ($1,'RÓTULA',$2,100,500,$3,true) RETURNING id`,
    [code, stock, '79' + String(Math.floor(Math.random() * 1e10)).padStart(11, '0')])).rows[0].id);
  ID.a = await mkP(`${TAG}-A`, 80);   // CB0089 재현: 재고 80
  ID.b = await mkP(`${TAG}-B`, 5);    // 재고가 모자라 실제로 사야 하는 품목
  ID.c = Number((await query(
    `INSERT INTO customers (name, code, credit_days, rfc, owner_id, created_by, discount) VALUES ($1,$2,30,$3,$4,$4,0) RETURNING id`,
    [`${TAG}고객`, `${TAG}-C`, `PRN${String(Date.now()).slice(-6)}AB1`, ID.dir])).rows[0].id);
  const mkQ = async (no, status) => Number((await query(
    `INSERT INTO quotes (quote_no, customer_id, quote_date, status, created_by) VALUES ($1,$2,CURRENT_DATE,$3,$4) RETURNING id`,
    [no, ID.c, status, ID.dir])).rows[0].id);
  ID.qExp = await mkQ(`${TAG}-Q1`, 'expired');
  ID.qLive = await mkQ(`${TAG}-Q2`, 'draft');
  const mkS = async (pid, qty, quoteId, note) => Number((await query(
    `INSERT INTO stock_shortages (product_id, customer_id, requested_qty, fulfilled_qty, shortage_qty, shortage_amount_mxn, occurred_at, source_quote_id, note)
     VALUES ($1,$2,$3,0,$3,0,CURRENT_DATE,$4,$5) RETURNING id`, [pid, ID.c, qty, quoteId, note])).rows[0].id);
  // A: 만료 견적의 개발완료 수요 1 (CB0089 와 같은 모양)
  ID.sA = await mkS(ID.a, 1, ID.qExp, '개발완료 오퍼·발주 제안 — 개발요청 [devreq:999001] 경쟁사코드 2612754');
  // B: 진행 중 견적 부족 6 + 견적 없는 직접 부족 4 + 만료 견적 부족 3, 발주 잔량 2
  await mkS(ID.b, 6, ID.qLive, `${TAG} live`);
  await mkS(ID.b, 4, null, `${TAG} direct`);
  await mkS(ID.b, 3, ID.qExp, `${TAG} expired`);
  const po = Number((await query(`INSERT INTO purchase_orders (ref_no, order_date) VALUES ('${TAG}-PO', CURRENT_DATE) RETURNING id`)).rows[0].id);
  await query(`INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd) VALUES ($1,$2,'x',2,1,2)`, [po, ID.b]);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register((await import('../src/routes/purchaseRoutes.js')).default);
  await app.ready();
  tok = app.jwt.sign({ sub: ID.dir });
});

test('① CB0089 재현 — 재고 80 · 만료 견적 수요 1 → 미발주 0 · 실구매 0 · 놓친 수요 1', { skip: SKIP }, async () => {
  const r = await row(`${TAG}-A`);
  assert.deepEqual(
    [r.stock_qty, r.shortage_qty, r.shortage_covered_qty, r.shortage_unordered_qty, r.need_qty, r.shortage_missed_qty],
    [80, 1, 0, 0, 0, 1]);
});

test('② 살아 있는 부족 10 · 발주 2 · 재고 5 → 발주됨 2 · 미발주 8 · 실구매 3 · 놓친 수요 3', { skip: SKIP }, async () => {
  const r = await row(`${TAG}-B`);
  assert.deepEqual(
    [r.shortage_qty, r.backorder_qty, r.shortage_covered_qty, r.shortage_unordered_qty, r.need_qty, r.shortage_missed_qty],
    [13, 2, 2, 8, 3, 3]);
  // 부족 잔여 = 발주됨 + 미발주 + 놓친 수요
  assert.equal(r.shortage_qty, r.shortage_covered_qty + r.shortage_unordered_qty + r.shortage_missed_qty);
});

test('③ 상단 합계 · 정렬(need / missed)', { skip: SKIP }, async () => {
  const d = (await get(`/api/purchases/review?q=${TAG}&sort=need&dir=desc`)).json();
  assert.deepEqual([d.summary.total_shortage, d.summary.total_unordered, d.summary.total_need, d.summary.total_missed], [14, 8, 3, 4]);
  assert.equal(d.items[0].ctr, `${TAG}-B`);
  const m = (await get(`/api/purchases/review?q=${TAG}&sort=missed&dir=desc`)).json();
  assert.equal(m.items[0].ctr, `${TAG}-B`);
});

test('④ 드릴다운 — 만료 견적 부족은 「놓친 수요」로 표시 · 요약도 목록과 같은 식', { skip: SKIP }, async () => {
  const a = (await get(`/api/purchases/review/${ID.a}/shortages`)).json();
  assert.deepEqual([a.summary.unordered, a.summary.need, a.summary.missed], [0, 0, 1]);
  const it = a.items.find((x) => x.id === ID.sA);
  assert.equal(it.missed, true);
  assert.equal(it.unordered_qty, 0);
  const b = (await get(`/api/purchases/review/${ID.b}/shortages`)).json();
  assert.deepEqual([b.summary.remaining, b.summary.covered, b.summary.unordered, b.summary.need, b.summary.missed], [13, 2, 8, 3, 3]);
});

test('⑤ 견적 삭제(deleted_at)도 놓친 수요', { skip: SKIP }, async () => {
  await query(`UPDATE quotes SET deleted_at=now() WHERE id=$1`, [ID.qLive]);
  const r = await row(`${TAG}-B`);
  assert.deepEqual([r.shortage_unordered_qty, r.need_qty, r.shortage_missed_qty], [2, 0, 9]);
  await query(`UPDATE quotes SET deleted_at=NULL WHERE id=$1`, [ID.qLive]);
});

test('⑥ 다른 견적이 예약한 재고는 빼지 않는다 — 가용재고 기준(필요한 발주를 빠뜨리지 않음)', { skip: SKIP }, async () => {
  // 진행 중 견적(Q2, 예약 만료 전)이 B 재고 5 중 4개를 예약
  await query(`UPDATE quotes SET reserve_expires_at = now() + interval '1 day' WHERE id=$1`, [ID.qLive]);
  await query(`INSERT INTO quote_lines (quote_id, product_id, qty, reserved_qty) VALUES ($1,$2,4,4)`, [ID.qLive, ID.b]);
  const r = await row(`${TAG}-B`);
  // 미발주 8 − 가용 1 = 7 (현재재고 5 를 다 빼면 3 으로 과소 산정됨)
  assert.deepEqual([r.stock_qty, r.reserved_qty, r.avail_qty, r.shortage_unordered_qty, r.need_qty], [5, 4, 1, 8, 7]);
  const b = (await get(`/api/purchases/review/${ID.b}/shortages`)).json();
  assert.deepEqual([b.summary.reserved, b.summary.avail, b.summary.need], [4, 1, 7]);
  // 예약이 풀리면(만료) 다시 재고 5 전부 가용
  await query(`UPDATE quotes SET reserve_expires_at = now() - interval '1 hour' WHERE id=$1`, [ID.qLive]);
  const r2 = await row(`${TAG}-B`);
  assert.deepEqual([r2.reserved_qty, r2.avail_qty, r2.need_qty], [0, 5, 3]);
  const d = (await get(`/api/purchases/review?q=${TAG}`)).json();
  assert.equal(d.summary.total_avail, 85);
});

after(async () => {
  if (SKIP) return;
  try { await cleanup(); } catch (_) {}
  if (app) await app.close();
  try { (await import('../src/db.js')).pool?.end?.(); } catch (_) {}
});
