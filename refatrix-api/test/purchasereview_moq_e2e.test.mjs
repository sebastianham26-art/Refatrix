// =====================================================================
// 구매검토 · 추천발주수량 · MOQ · 별도관리 · inactive (pr-1020moq) — 실 PostgreSQL 종단 검증 · 2026-10-20
//   디렉터 결정:
//   ① CQ0280L/R · CQ1291L/R = 별도관리 — 실구매 필요를 쓰지 않고 구매·판매 의지로 수량 결정(추천 0 · 합계 제외)
//   ② 추천발주수량 = 실구매 필요 + 놓친 수요(최근 6개월) — 놓친 수요도 남는 가용재고·발주로 먼저 채운다
//   ③ MOQ: CN 10 · TR 40 · KR·VN 은 계산값 그대로
//   ④ inactive SKU 는 배지로 표시
//   실행: TEST_PG_URL=postgres://... node --test test/purchasereview_moq_e2e.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app, tok;
const ID = {};
const TAG = 'PRMOQ';
const MANUAL = 'CQ0280L';

async function cleanup() {
  const pids = (await query(`SELECT id FROM products WHERE code LIKE '${TAG}%' OR code = '${MANUAL}'`)).rows.map((r) => Number(r.id));
  const cids = (await query(`SELECT id FROM customers WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM stock_shortages WHERE product_id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM quotes WHERE customer_id = ANY($1::bigint[])`, [cids]);
  await query(`DELETE FROM products WHERE id = ANY($1::bigint[])`, [pids]);
  await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [cids]);
  await query(`DELETE FROM users WHERE login_id LIKE 'prmoq%'`);
}
const get = (url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok } });
const row = async (code) => (await get(`/api/purchases/review?q=${code}`)).json().items.find((x) => x.ctr === code);

test('boot', { skip: SKIP }, async () => {
  ({ query } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  ID.dir = Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('${TAG}디렉터','director',$1,'prmoq_dir') RETURNING id`, [hashPin('4321')])).rows[0].id);
  const mkP = async (code, stock, origin, active = true) => Number((await query(
    `INSERT INTO products (code, name, stock_qty, avg_cost, list_price, ean, is_active, origin, inactive_reason)
     VALUES ($1,'PIEZA',$2,100,500,$3,$4,$5,$6) RETURNING id`,
    [code, stock, '77' + String(Math.floor(Math.random() * 1e10)).padStart(11, '0'), active, origin, active ? null : '단종'])).rows[0].id);
  ID.cn = await mkP(`${TAG}-CN`, 0, 'China');     // 표기 섞임 — CN 으로 인식해야
  ID.tr = await mkP(`${TAG}-TR`, 0, 'TR');
  ID.kr = await mkP(`${TAG}-KR`, 2, 'KR');
  ID.vn = await mkP(`${TAG}-VN`, 0, 'Vietnam');
  ID.stk = await mkP(`${TAG}-STK`, 80, 'CN');      // CB0089 모양 — 재고 충분
  ID.man = await mkP(MANUAL, 0, 'CN');
  ID.ina = await mkP(`${TAG}-IN`, 0, 'CN', false);
  ID.c = Number((await query(
    `INSERT INTO customers (name, code, credit_days, rfc, owner_id, created_by, discount) VALUES ($1,$2,30,$3,$4,$4,0) RETURNING id`,
    [`${TAG}고객`, `${TAG}-C`, `PRM${String(Date.now()).slice(-6)}AB1`, ID.dir])).rows[0].id);
  const mkQ = async (no, status, daysAgo) => Number((await query(
    `INSERT INTO quotes (quote_no, customer_id, quote_date, status, created_by) VALUES ($1,$2,CURRENT_DATE - $3::int,$4,$5) RETURNING id`,
    [no, ID.c, daysAgo, status, ID.dir])).rows[0].id);
  ID.qLive = await mkQ(`${TAG}-Q1`, 'draft', 0);
  ID.qExpNew = await mkQ(`${TAG}-Q2`, 'expired', 30);
  ID.qExpOld = await mkQ(`${TAG}-Q3`, 'expired', 240);   // 6개월 넘음
  const mkS = (pid, qty, qid) => query(
    `INSERT INTO stock_shortages (product_id, customer_id, requested_qty, fulfilled_qty, shortage_qty, shortage_amount_mxn, occurred_at, source_quote_id, note)
     VALUES ($1,$2,$3,0,$3,0,CURRENT_DATE,$4,'${TAG}')`, [pid, ID.c, qty, qid]);
  await mkS(ID.cn, 3, ID.qLive);          // 3 → MOQ 10
  await mkS(ID.tr, 50, ID.qLive);         // 50 > MOQ 40
  await mkS(ID.kr, 3, ID.qLive);          // KR: 3 + 최근 놓친 4 − 재고 2 = 5 (6개월 넘은 5 는 제외)
  await mkS(ID.kr, 4, ID.qExpNew);
  await mkS(ID.kr, 5, ID.qExpOld);
  await mkS(ID.vn, 3, ID.qLive);          // VN: MOQ 없음 → 3
  await mkS(ID.stk, 1, ID.qExpNew);       // 재고 80 — 추천 0
  await mkS(ID.man, 5, ID.qLive);         // 별도관리 — 추천 0, 합계 제외
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register((await import('../src/routes/purchaseRoutes.js')).default);
  await app.ready();
  tok = app.jwt.sign({ sub: ID.dir });
});

test('① CN — 계산 3 → MOQ 10 으로 올림 (원산지 표기 China 도 CN)', { skip: SKIP }, async () => {
  const r = await row(`${TAG}-CN`);
  assert.deepEqual([r.origin_code, r.moq, r.need_qty, r.rec_raw_qty, r.rec_qty], ['CN', 10, 3, 3, 10]);
});

test('② TR — 계산 50 > MOQ 40 → 50 그대로', { skip: SKIP }, async () => {
  const r = await row(`${TAG}-TR`);
  assert.deepEqual([r.origin_code, r.moq, r.rec_qty], ['TR', 40, 50]);
});

test('③ KR — 실구매 1 + 최근 6개월 놓친 수요 4 = 5 · 6개월 넘은 놓친 수요는 제외 · MOQ 없음', { skip: SKIP }, async () => {
  const r = await row(`${TAG}-KR`);
  assert.deepEqual([r.need_qty, r.shortage_missed_qty, r.missed6_qty, r.moq, r.rec_qty], [1, 9, 4, 0, 5]);
});

test('④ VN — MOQ 없음 → 계산값 그대로', { skip: SKIP }, async () => {
  const r = await row(`${TAG}-VN`);
  assert.deepEqual([r.origin_code, r.moq, r.rec_qty], ['VN', 0, 3]);
});

test('⑤ 재고 충분(CB0089 모양) — 놓친 수요가 있어도 재고로 채워져 추천 0 (MOQ 로 올리지 않음)', { skip: SKIP }, async () => {
  const r = await row(`${TAG}-STK`);
  assert.deepEqual([r.missed6_qty, r.rec_raw_qty, r.rec_qty], [1, 0, 0]);
});

test('⑥ 별도관리 CQ0280L — manual · 추천 0 · 실구매 필요는 참고값으로 남김', { skip: SKIP }, async () => {
  const r = await row(MANUAL);
  assert.deepEqual([r.manual, r.need_qty, r.rec_qty], [true, 5, 0]);
  const d = (await get(`/api/purchases/review?q=${MANUAL}`)).json();
  assert.deepEqual([d.summary.total_need, d.summary.total_rec], [0, 0], '별도관리 품목은 상단 합계에서 제외');
});

test('⑦ inactive 배지 데이터 · 합계 · 추천순 정렬', { skip: SKIP }, async () => {
  const r = await row(`${TAG}-IN`);
  assert.deepEqual([r.is_active, r.inactive_reason], [false, '단종']);
  assert.equal((await row(`${TAG}-CN`)).is_active, true);
  const d = (await get(`/api/purchases/review?q=${TAG}&sort=rec&dir=desc`)).json();
  assert.deepEqual([d.summary.total_rec, d.summary.rec_skus, d.summary.inactive_skus], [68, 4, 1]);
  assert.deepEqual(d.items.slice(0, 4).map((x) => x.ctr), [`${TAG}-TR`, `${TAG}-CN`, `${TAG}-KR`, `${TAG}-VN`]);
});

after(async () => {
  if (SKIP) return;
  try { await cleanup(); } catch (_) {}
  if (app) await app.close();
  try { (await import('../src/db.js')).pool?.end?.(); } catch (_) {}
});
