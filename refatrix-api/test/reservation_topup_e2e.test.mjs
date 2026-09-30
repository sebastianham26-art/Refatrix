// =====================================================================
// 풀린 재고 자동 충당 + stock_flag 실제 배분 기록 — 종단 검증 (실 PostgreSQL)  2026-09-30
//   사례: Q-2026-0280 — 「4개 중 2개만 가능」인데 가용 4, 수주흐름 추이엔 100% 가용.
//   잠그는 것
//     ① 저장 시 stock_flag·avail_stock = 실제 예약 결과(타 견적 예약을 뺀 가용 기준)
//     ② 앞 견적이 풀리면 스위퍼가 부족한 미결 견적을 **접수 순서대로** 채운다
//     ③ 포장지시·만료·삭제 견적은 안 채운다 / 이미 잡힌 예약은 줄이지 않는다
//     ④ 수동 재검증(stamp:false)은 추이 스냅샷을 보존한다
//     ⑤ 0241 마이그레이션은 모순 줄만, 0064 이후 견적만 고친다
//   실행: TEST_PG_URL=postgres://... node --test test/reservation_topup_e2e.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

const TAG = 'TOPUPTEST';
let db, B, P;
const at = (h) => new Date(Date.now() + h * 3600000).toISOString();

async function cleanup() {
  await db.query(`DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM quotes WHERE memo LIKE '${TAG}%')`);
  await db.query(`DELETE FROM quotes WHERE memo LIKE '${TAG}%'`);
  await db.query(`DELETE FROM products WHERE code LIKE '${TAG}%'`);
}
let seq = 0;
async function mkQuote({ qty, created, exp = at(10), packed = null, status = 'draft', rsv = 0, flag = 'ok' }) {
  seq += 1;
  const q = Number((await db.query(
    `INSERT INTO quotes (quote_no, quote_date, status, memo, reserve_expires_at, packing_printed_at, created_at)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6) RETURNING id`,
    [`${TAG}-${seq}`, status, `${TAG} ${seq}`, exp, packed, created])).rows[0].id);
  await db.query(
    `INSERT INTO quote_lines (quote_id, line_no, product_id, ctr_code, qty, reserved_qty, stock_flag, avail_stock)
     VALUES ($1, 1, $2, 'X', $3, $4, $5, NULL)`, [q, P, qty, rsv, flag]);
  return q;
}
const line = async (q) => (await db.query(`SELECT reserved_qty, stock_flag, avail_stock FROM quote_lines WHERE quote_id=$1`, [q])).rows[0];
const n = (v) => (v == null ? null : Number(v));

test('boot', { skip: SKIP }, async () => {
  db = await import('../src/db.js');
  B = await import('../src/quoteBuild.js');
  await cleanup();
  P = Number((await db.query(`INSERT INTO products (code, name, stock_qty) VALUES ($1,'topup',4) RETURNING id`, [`${TAG}-P`])).rows[0].id);
});

let qA, qB, qC;
test('① 저장 — 앞 견적이 2개를 잡고 있으면 뒤 견적(4개)은 2개 예약 · stock_flag=low_stock', { skip: SKIP }, async () => {
  qA = await mkQuote({ qty: 2, created: at(-3) });
  await db.withTx((c) => B.assignReservations(c, qA));
  assert.deepEqual([n((await line(qA)).reserved_qty), (await line(qA)).stock_flag], [2, 'ok']);
  qB = await mkQuote({ qty: 4, created: at(-2) });
  await db.withTx((c) => B.assignReservations(c, qB));
  const b = await line(qB);
  assert.equal(n(b.reserved_qty), 2);
  assert.equal(b.stock_flag, 'low_stock', '예전엔 물리 재고 4 ≥ 4 라서 ok 로 찍혔다(0280 버그)');
  assert.equal(n(b.avail_stock), 2, '그 순간 쓸 수 있던 가용');
});

test('② 앞 견적이 만료되면 스위퍼가 뒤 견적을 채운다 — 접수 순서대로', { skip: SKIP }, async () => {
  qC = await mkQuote({ qty: 3, created: at(-1) });
  await db.withTx((c) => B.assignReservations(c, qC));
  assert.equal(n((await line(qC)).reserved_qty), 0);
  await db.query(`UPDATE quotes SET reserve_expires_at=$2 WHERE id=$1`, [qA, at(-0.1)]);   // A 풀림 → 2개 자유
  const ch = await B.topUpReservations(db);
  const mine = ch.filter((x) => x.product_id === P);
  assert.deepEqual(mine.map((x) => [x.quote_id, x.before, x.after]), [[qB, 2, 4]], 'B(먼저 접수)가 먼저, C 는 남은 게 없다');
  assert.equal(n((await line(qB)).reserved_qty), 4);
  assert.equal((await line(qB)).stock_flag, 'low_stock', '추이 스냅샷(요청 시점)은 건드리지 않는다');
  assert.equal(n((await line(qC)).reserved_qty), 0);
  // 입고로 재고 +3 → C 가 채워진다
  await db.query(`UPDATE products SET stock_qty=7 WHERE id=$1`, [P]);
  await B.topUpReservations(db);
  assert.equal(n((await line(qC)).reserved_qty), 3);
  assert.equal((await B.topUpReservations(db)).filter((x) => x.product_id === P).length, 0, '두 번 돌려도 그대로');
});

test('③ 포장지시·만료·삭제는 안 채우고, 재고가 줄어도 이미 잡힌 예약은 안 줄인다', { skip: SKIP }, async () => {
  await db.query(`UPDATE products SET stock_qty=20 WHERE id=$1`, [P]);
  const packed = await mkQuote({ qty: 5, created: at(-0.5), packed: at(-0.2) });
  const expired = await mkQuote({ qty: 5, created: at(-0.5), exp: at(-1), status: 'expired' });
  const deleted = await mkQuote({ qty: 5, created: at(-0.5) });
  await db.query(`UPDATE quotes SET deleted_at=now() WHERE id=$1`, [deleted]);
  await B.topUpReservations(db);
  for (const q of [packed, expired, deleted]) assert.equal(n((await line(q)).reserved_qty), 0, 'quote ' + q);
  await db.query(`UPDATE products SET stock_qty=1 WHERE id=$1`, [P]);
  await B.topUpReservations(db);
  assert.equal(n((await line(qB)).reserved_qty), 4); assert.equal(n((await line(qC)).reserved_qty), 3);
});

test('④ 수동 재검증(stamp:false)은 stock_flag 를 보존', { skip: SKIP }, async () => {
  await db.query(`UPDATE products SET stock_qty=30 WHERE id=$1`, [P]);
  const q = await mkQuote({ qty: 2, created: at(-0.1), flag: 'low_stock' });
  await db.withTx((c) => B.assignReservations(c, q, { stamp: false }));
  const l = await line(q);
  assert.equal(n(l.reserved_qty), 2); assert.equal(l.stock_flag, 'low_stock'); assert.equal(l.avail_stock, null);
});

test('⑤ 0241 — 모순 줄만, 예약 제도(0064) 이후 견적만 고친다', { skip: SKIP }, async () => {
  const bad = await mkQuote({ qty: 4, created: at(-5), rsv: 2, flag: 'ok' });
  const fine = await mkQuote({ qty: 4, created: at(-5), rsv: 4, flag: 'ok' });
  const old = await mkQuote({ qty: 4, created: at(-500), exp: null, status: 'converted', rsv: 0, flag: 'ok' });
  const sql = readFileSync(new URL('../migrations/0241_quote_stock_flag_restate.sql', import.meta.url), 'utf8');
  await db.query(sql);
  assert.equal((await line(bad)).stock_flag, 'low_stock');
  assert.equal((await line(fine)).stock_flag, 'ok');
  assert.equal((await line(old)).stock_flag, 'ok', '예약 제도 전 견적(reserved 0 기본값)은 안 건드린다');
});

test('cleanup', { skip: SKIP }, async () => { await cleanup(); await db.pool.end(); });
