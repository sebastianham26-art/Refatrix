// =====================================================================
// WBR 주간(월~금) 실적 집계 — /api/salesperf/summary?from&to  (실 PostgreSQL + 실 라우트)
//
//   신고(디렉터 2026-09-04): "WBR 수금내역이 월~금 반제내역을 기록해야 하는데 실제보다 적다."
//   확인된 원인 2가지:
//     ⓐ 카드가 «월» 단위로 집계돼 주간 회의의 월~금과 맞지 않았다.
//     ⓑ 수금 실적이 transactions(현금 거래) 기준이라 **NC(비현금) 반제가 통째로 빠졌다**
//        → 수금/정산 화면의 반제내역보다 항상 적게 나온다.
//
//   확인하는 것:
//     · from/to 를 주면 매출·수금 «실적»만 그 기간, 목표/계획은 «월» 그대로
//     · 수금 실적 = 반제(allocations) 합계 = 현금 + NC  (수금/정산 화면과 같은 정의)
//     · 전주 대비(prevActual/momPct) · 팀 필터 · 기간 검증 400 · 기존 호출 회귀(무변경)
//
//   실행: TEST_PG_URL=postgres://... node --test test/wbr_week_range.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, prevRange, mondayToFriday, isYmd, addDays } from '../src/weekRange.js';

// ── ① 순수 로직(DB 불필요) ───────────────────────────────────────────────────
test('mondayToFriday — 요일별로 그 주의 월~금', () => {
  const WEEK = { from: '2026-08-31', to: '2026-09-04', days: 5 };   // 2026-08-31(월) ~ 09-04(금)
  assert.deepEqual(mondayToFriday('2026-08-31'), WEEK);   // 월
  assert.deepEqual(mondayToFriday('2026-09-02'), WEEK);   // 수
  assert.deepEqual(mondayToFriday('2026-09-04'), WEEK);   // 금
  assert.deepEqual(mondayToFriday('2026-09-05'), WEEK);   // 토 → 그 주
  assert.deepEqual(mondayToFriday('2026-09-06'), WEEK);   // 일 → 그 주(다음 주가 아니다)
  assert.deepEqual(mondayToFriday('2026-09-07'), { from: '2026-09-07', to: '2026-09-11', days: 5 });
  // 월말·연말 경계 — 주가 달을 걸쳐도 그대로
  assert.deepEqual(mondayToFriday('2026-12-31'), { from: '2026-12-28', to: '2027-01-01', days: 5 });
  assert.deepEqual(mondayToFriday('2026-03-01'), { from: '2026-02-23', to: '2026-02-27', days: 5 });
});

test('parseRange — 잘못된 값은 전부 null (SQL 에 절대 안 들어간다)', () => {
  assert.deepEqual(parseRange('2026-09-01', '2026-09-05'), { from: '2026-09-01', to: '2026-09-05', days: 5 });
  assert.equal(parseRange('2026-09-05', '2026-09-01'), null);      // 역순
  assert.equal(parseRange('2026-02-30', '2026-03-05'), null);      // 없는 날짜
  assert.equal(parseRange('2026-9-1', '2026-09-05'), null);        // 0 패딩 없음
  assert.equal(parseRange('2026-09-01', null), null);              // 한쪽만
  assert.equal(parseRange("2026-09-01'; DROP TABLE users;--", '2026-09-05'), null);
  assert.equal(parseRange('2026-01-01', '2026-12-31'), null);      // 31일 초과
  assert.ok(parseRange('2026-09-01', '2026-10-01'));               // 31일 = 허용
  assert.equal(isYmd('2026-02-29'), false);                        // 2026은 평년
});

test('prevRange — 전주 같은 요일 구간(7일 앞) — 주말이 섞이면 안 된다', () => {
  assert.deepEqual(prevRange(mondayToFriday('2026-09-04')), { from: '2026-08-24', to: '2026-08-28' });
  assert.deepEqual(prevRange(parseRange('2026-09-01', '2026-09-30')), { from: '2026-08-02', to: '2026-08-31' });
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

// ── ② 실 PostgreSQL × 실 라우트 ──────────────────────────────────────────────
const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — DB 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

const TAG = 'WKRNG';
const YM = '2026-09';
const WK = { from: '2026-08-31', to: '2026-09-04' };   // 월~금
const PV = { from: '2026-08-24', to: '2026-08-28' };   // 전주 월~금

let query, salesPerfRoutes, Fastify, jwt, app, tok;
const ID = {};

async function boot() {
  ({ query } = await import('../src/db.js'));
  salesPerfRoutes = (await import('../src/routes/salesPerfRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  await cleanup();

  const mkTeam = async (name) => Number((await query(
    `INSERT INTO sales_teams (name, sort_order, is_sales) VALUES ($1,0,true) RETURNING id`, [TAG + name])).rows[0].id);
  ID.tA = await mkTeam('_A'); ID.tB = await mkTeam('_B');

  const mkCust = async (code, teamId) => Number((await query(
    `INSERT INTO customers (code, name, team_id, credit_days) VALUES ($1,$2,$3,30) RETURNING id`,
    [TAG + code, TAG + code, teamId])).rows[0].id);
  ID.cA = await mkCust('_CA', ID.tA); ID.cB = await mkCust('_CB', ID.tB);

  ID.acc = Number((await query(
    `INSERT INTO accounts (name, currency) VALUES ($1,'MXN') RETURNING id`, [TAG + '_ACC'])).rows[0].id);
  ID.dir = Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x','wkrng_dir') RETURNING id`,
    [TAG + '디렉터'])).rows[0].id);

  // 인보이스: subtotal 은 매출 실적(IVA 제외), total 은 수금계획(만기액) 기준
  const mkInv = async (custId, invDate, dueDate, subtotal) => Number((await query(
    `INSERT INTO sales_invoices (customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn, status)
     VALUES ($1,$2,30,$3,$4,0,$4,'posted') RETURNING id`, [custId, invDate, dueDate, subtotal])).rows[0].id);

  // ── 매출 ──
  ID.iWk   = await mkInv(ID.cA, '2026-09-03', '2026-09-30', 1000);  // 이번주(수)
  ID.iWk2  = await mkInv(ID.cB, '2026-09-01', '2026-09-30',  500);  // 이번주(월) · B팀
  ID.iSat  = await mkInv(ID.cA, '2026-09-05', '2026-09-30', 7777);  // 토요일 → 주간 제외, 월에는 포함
  ID.iPrev = await mkInv(ID.cA, '2026-08-26', '2026-09-30',  600);  // 전주(수)

  // ── 수금(반제) ──
  //  ⒜ 현금 반제 — 이번주 안(통장 입금일 09-02)
  const mkPay = async (custId, payDate, amount) => Number((await query(
    `INSERT INTO sales_payments (customer_id, pay_date, account_id, amount) VALUES ($1,$2,$3,$4) RETURNING id`,
    [custId, payDate, ID.acc, amount])).rows[0].id);
  const mkTxn = async (txnDate, amount, invId) => Number((await query(
    `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, sales_invoice_id)
     VALUES ($1,$2,'in',$3,'MXN',1,$3,'4010','actual','payment',true,$4) RETURNING id`,
    [ID.acc, txnDate, amount, invId])).rows[0].id);

  const pWk = await mkPay(ID.cA, '2026-09-02', 300);
  const tWk = await mkTxn('2026-09-02', 300, ID.iWk);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, txn_id, kind) VALUES ($1,$2,300,$3,'cash')`, [pWk, ID.iWk, tWk]);

  //  ⒝ 현금 반제 — B팀(팀 필터 확인용) 이번주
  const pB = await mkPay(ID.cB, '2026-09-04', 120);
  const tB = await mkTxn('2026-09-04', 120, ID.iWk2);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, txn_id, kind) VALUES ($1,$2,120,$3,'cash')`, [pB, ID.iWk2, tB]);

  //  ⒞ 현금 반제 — 기간 밖(전주)
  const pPv = await mkPay(ID.cA, '2026-08-26', 900);
  const tPv = await mkTxn('2026-08-26', 900, ID.iPrev);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, txn_id, kind) VALUES ($1,$2,900,$3,'cash')`, [pPv, ID.iPrev, tPv]);

  //  ⒟ NC(비현금) 반제 — 이번주 적용. **거래(transactions)가 없다** → 종전 카드에서 통째로 빠지던 금액
  ID.nc = Number((await query(
    `INSERT INTO notas_credito (invoice_id, customer_id, concepto, total_mxn, base_mxn, iva_mxn, status, applied_at)
     VALUES ($1,$2,'test',80,80,0,'applied','2026-09-03T12:00:00Z') RETURNING id`, [ID.iWk, ID.cA])).rows[0].id);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, kind, nc_id) VALUES (NULL,$1,80,'nota_credito',$2)`, [ID.iWk, ID.nc]);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(salesPerfRoutes);
  await app.ready();
  tok = app.jwt.sign({ sub: ID.dir });
}

async function cleanup() {
  const C = `SELECT id FROM customers WHERE code LIKE '${TAG}%'`;
  const I = `SELECT id FROM sales_invoices WHERE customer_id IN (${C})`;
  await query(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (${I})`);
  await query(`DELETE FROM notas_credito WHERE customer_id IN (${C})`);
  await query(`DELETE FROM sales_payments WHERE customer_id IN (${C})`);
  await query(`DELETE FROM transactions WHERE sales_invoice_id IN (${I})`);
  await query(`DELETE FROM sales_invoices WHERE customer_id IN (${C})`);
  await query(`DELETE FROM customers WHERE code LIKE '${TAG}%'`);
  await query(`DELETE FROM users WHERE login_id LIKE 'wkrng%'`);
  await query(`DELETE FROM sales_teams WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
}

const get = (url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok } });
// 이 테스트가 만든 팀만 보도록 team= 로 좁히거나, 팀 두 개를 각각 조회해 합산한다.
const sumTeams = async (qs) => {
  const a = (await get(`/api/salesperf/summary?team=${ID.tA}&${qs}`)).json();
  const b = (await get(`/api/salesperf/summary?team=${ID.tB}&${qs}`)).json();
  return {
    sales: Number(a.sales.actual) + Number(b.sales.actual),
    prev: Number(a.sales.prevActual || 0) + Number(b.sales.prevActual || 0),
    collect: Number(a.collection.actual) + Number(b.collection.actual),
    nc: Number(a.collection.nc || 0) + Number(b.collection.nc || 0),
    cash: Number(a.collection.cash || 0) + Number(b.collection.cash || 0),
    period: a.period,
  };
};

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 기간을 주면 매출 실적이 그 주(월~금)만 잡힌다 — 토요일 건은 빠진다', { skip: SKIP }, async () => {
  const r = await sumTeams(`ym=${YM}&carry=1&from=${WK.from}&to=${WK.to}`);
  assert.equal(r.sales, 1500, '09-03(1000) + 09-01(500) 만 잡혀야 한다');   // 09-05(토) 7777 은 제외
  assert.deepEqual({ from: r.period.from, to: r.period.to }, WK);
});

test('② 기간을 안 주면 종전 «월» 집계 그대로 (영업 대시보드 회귀)', { skip: SKIP }, async () => {
  const r = await sumTeams(`ym=${YM}&carry=1`);
  assert.equal(r.sales, 9277, '9월 전체 = 1000+500+7777');
  const one = (await get(`/api/salesperf/summary?ym=${YM}&carry=1&team=${ID.tA}`)).json();
  assert.equal(one.period, null, '기간 모드가 아니면 period 는 null');
  assert.equal(one.collection.nc, undefined, '기간 모드가 아니면 nc 분해도 없다(응답 형태 무변경)');
});

test('③ 수금 실적 = 그 주의 반제 합계(현금+NC) — «실제보다 적던» 원인이 사라진다', { skip: SKIP }, async () => {
  const r = await sumTeams(`ym=${YM}&carry=1&from=${WK.from}&to=${WK.to}`);
  assert.equal(r.cash, 420, '현금 반제 300 + 120');
  assert.equal(r.nc, 80, 'NC 반제 80 — 거래가 없어 종전 카드에선 통째로 빠졌다');
  assert.equal(r.collect, 500, '수금/정산 반제내역과 같은 합계');
  // 종전 기준(transactions)과 비교 — NC 만큼 적게 나오던 것이 이 테스트의 회귀 가드
  const old = await sumTeams(`ym=${YM}&carry=1`);
  assert.ok(r.collect > 420, 'NC 가 빠지면 420 에 머문다 → 회귀');
  assert.equal(old.nc, 0, '월 집계는 종전대로 transactions 기준(형태 무변경)');
});

test('④ 목표/계획은 기간을 줘도 «월» 기준 그대로', { skip: SKIP }, async () => {
  const wk = (await get(`/api/salesperf/summary?ym=${YM}&carry=1&team=${ID.tA}&from=${WK.from}&to=${WK.to}`)).json();
  const mo = (await get(`/api/salesperf/summary?ym=${YM}&carry=1&team=${ID.tA}`)).json();
  assert.equal(wk.sales.target, mo.sales.target, '매출목표는 월 기준 유지');
  assert.equal(wk.collection.plan, mo.collection.plan, '수금계획(만기액+이월)도 월 기준 유지');
  assert.notEqual(wk.sales.actual, mo.sales.actual, '실적만 달라져야 한다');
});

test('⑤ 전주 대비 — prevActual 은 같은 길이의 직전 기간', { skip: SKIP }, async () => {
  const r = (await get(`/api/salesperf/summary?ym=${YM}&carry=1&team=${ID.tA}&from=${WK.from}&to=${WK.to}`)).json();
  assert.equal(r.sales.prevActual, 600, '전주(08-26) 매출 600');
  assert.equal(r.sales.actual, 1000);
  assert.equal(r.sales.momPct, 66.67, '(1000-600)/600');
  assert.deepEqual({ from: r.period.prev_from, to: r.period.prev_to }, PV);
});

test('⑥ 팀 필터가 기간 집계에도 적용된다', { skip: SKIP }, async () => {
  const b = (await get(`/api/salesperf/summary?ym=${YM}&carry=1&team=${ID.tB}&from=${WK.from}&to=${WK.to}`)).json();
  assert.equal(b.sales.actual, 500, 'B팀 인보이스만');
  assert.equal(b.collection.actual, 120, 'B팀 반제만');
  assert.equal(b.collection.nc, 0, 'NC 는 A팀 고객 건');
});

test('⑦ 잘못된 기간은 400 — 계산도 하지 않는다', { skip: SKIP }, async () => {
  for (const qs of ['from=2026-09-01', 'to=2026-09-05', 'from=2026-09-05&to=2026-09-01',
                    'from=2026-02-30&to=2026-03-05', 'from=2026-01-01&to=2026-12-31',
                    "from=2026-09-01'--&to=2026-09-05"]) {
    const r = await get(`/api/salesperf/summary?ym=${YM}&carry=1&team=${ID.tA}&${qs}`);
    assert.equal(r.statusCode, 400, qs);
    assert.equal(r.json().error, 'bad_range', qs);
  }
});

test('⑧ carry=0(비이월 모드)에서도 기간이 적용된다', { skip: SKIP }, async () => {
  const r = (await get(`/api/salesperf/summary?ym=${YM}&carry=0&from=${WK.from}&to=${WK.to}`)).json();
  // 전체 가시(팀 제한 없음) — 다른 데이터가 섞일 수 있으므로 «최소한 이번주 건은 들어있다» 로 확인
  assert.ok(Number(r.sales.actual) >= 1500, r.sales.actual);
  assert.ok(Number(r.collection.actual) >= 500, r.collection.actual);
  assert.ok(r.period && r.period.basis === 'week');
});

test('cleanup', { skip: SKIP }, async () => {
  await cleanup();
  await app.close();
  const { pool } = await import('../src/db.js');
  await pool.end();
});
