// =====================================================================
// 미배분 입금(통지) 부분 배분 종단 검증 — 실 PostgreSQL (0001~0191 전체 적용)
//
// 재현하는 버그: 고객이 인보이스 3건을 한 번에 송금 → 통지 1건.
//   인보이스 1건만 먼저 반제하면 통지가 곧바로 닫히고 남은 돈이 전부 선수금으로 빠져나가
//   인박스에 "잔여"가 남지 않아 나머지 인보이스를 이어서 반제할 수 없었다.
//
//   실행: TEST_PG_URL=postgres://... node --test test/bank_deposit_partial_alloc.test.mjs
//   TEST_PG_URL 없으면 skip.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, financeRoutes, Fastify, jwt, app;
const tok = {};
const ID = {};
const TAG = 'BDPART';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function boot() {
  ({ query } = await import('../src/db.js'));
  financeRoutes = (await import('../src/routes/financeRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  // 정리 (역순) — 두 번째 실행에서도 반드시 성공하도록 참조를 먼저 끊고 지운다.
  //   FK: sales_payments.advance_txn_id → transactions, sales_payment_allocations.txn_id → transactions,
  //       bank_deposits_pending.payment_id → sales_payments (모두 ON DELETE 기본=NO ACTION)
  const TAGACC = `SELECT id FROM accounts WHERE name LIKE '${TAG}%'`;
  const TAGPAY = `SELECT id FROM sales_payments WHERE account_id IN (${TAGACC}) OR memo LIKE '%${TAG}%' OR customer_id IN (SELECT id FROM customers WHERE name LIKE '${TAG}%')`;
  await query(`DELETE FROM bank_deposit_payments WHERE payment_id IN (${TAGPAY})`);
  await query(`DELETE FROM bank_deposit_payments WHERE deposit_id IN (SELECT id FROM bank_deposits_pending WHERE payer_memo LIKE '%${TAG}%')`);
  await query(`DELETE FROM bank_deposit_reads WHERE deposit_id IN (SELECT id FROM bank_deposits_pending WHERE payer_memo LIKE '%${TAG}%')`);
  await query(`DELETE FROM bank_deposit_docs  WHERE deposit_id IN (SELECT id FROM bank_deposits_pending WHERE payer_memo LIKE '%${TAG}%')`);
  await query(`UPDATE bank_deposits_pending SET payment_id=NULL WHERE payer_memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM sales_payment_allocations WHERE payment_id IN (${TAGPAY})`);
  await query(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo LIKE '%${TAG}%')`);
  await query(`UPDATE sales_payments SET advance_txn_id=NULL WHERE id IN (${TAGPAY})`);
  await query(`DELETE FROM sales_payments WHERE account_id IN (${TAGACC}) OR memo LIKE '%${TAG}%' OR customer_id IN (SELECT id FROM customers WHERE name LIKE '${TAG}%')`);
  await query(`DELETE FROM bank_deposits_pending WHERE payer_memo LIKE '%${TAG}%' OR account_id IN (${TAGACC})`);
  await query(`DELETE FROM transactions WHERE memo LIKE '%${TAG}%' OR account_id IN (${TAGACC})`);
  await query(`DELETE FROM sales_invoices WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'bdpart%')`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'bdpart%')`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM users WHERE login_id LIKE 'bdpart%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'bdpart_dir');
  ID.sup = await mkUser(`${TAG}영업지원`, 'sales_support', 'bdpart_sup');
  ID.fin = await mkUser(`${TAG}재무`, 'treasury', 'bdpart_fin');
  for (const u of [ID.sup, ID.fin]) {
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
                 VALUES ($1,'settlement','anywhere','edit') ON CONFLICT DO NOTHING`, [u]);
  }

  ID.acc = Number((await query(
    `INSERT INTO accounts (name, type, currency, open_balance, created_by) VALUES ($1,'bank','MXN',0,$2) RETURNING id`,
    [`${TAG}은행`, ID.dir])).rows[0].id);
  ID.cust = Number((await query(
    `INSERT INTO customers (name, code, credit_days, created_by) VALUES ($1,$2,30,$3) RETURNING id`,
    [`${TAG}고객`, `${TAG}-1`, ID.dir])).rows[0].id);

  // 인보이스 3건 — 총 11,600 + 23,200 + 34,800 = 69,600 (IVA 16% 포함)
  const mkInv = async (sat, sub) => Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,'2026-08-01',30,'2026-08-31',$3,$4,$5,'posted',$6,$7,$6) RETURNING id`,
    [sat, ID.cust, sub, r2(sub * 0.16), r2(sub * 1.16), ID.dir, `${TAG} ${sat}`])).rows[0].id);
  ID.inv1 = await mkInv(`${TAG}-F1`, 10000);   // 11,600
  ID.inv2 = await mkInv(`${TAG}-F2`, 20000);   // 23,200
  ID.inv3 = await mkInv(`${TAG}-F3`, 30000);   // 34,800

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(financeRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.sup = app.jwt.sign({ sub: ID.sup });
  tok.fin = app.jwt.sign({ sub: ID.fin });
}

const get = (who, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[who] } });
const post = (who, url, body) => app.inject({ method: 'POST', url, payload: body, headers: { authorization: 'Bearer ' + tok[who] } });
const del = (who, url) => app.inject({ method: 'DELETE', url, headers: { authorization: 'Bearer ' + tok[who] } });
const patch = (who, url, body) => app.inject({ method: 'PATCH', url, payload: body, headers: { authorization: 'Bearer ' + tok[who] } });

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

async function mkDeposit(amount, memo) {
  const r = await post('fin', '/api/bank-deposits', {
    account_id: ID.acc, deposit_date: '2026-08-20', amount,
    payer_memo: `${TAG} ${memo}`, customer_id: ID.cust, file: PNG, file_name: 'cap.png',
  });
  assert.equal(r.statusCode, 200, r.body);
  return Number(r.json().id);
}
const inbox = async () => (await get('sup', '/api/bank-deposits?status=pending')).json().items;
const outstanding = async (invId) => Number((await query(
  `SELECT s.total_mxn - COALESCE((SELECT SUM(amount) FROM sales_payment_allocations WHERE invoice_id=s.id),0) AS o
     FROM sales_invoices s WHERE s.id=$1`, [invId])).rows[0].o);
const accountIn = async () => Number((await query(
  `SELECT COALESCE(SUM(amount_mxn),0) AS s FROM transactions
    WHERE account_id=$1 AND direction='in' AND deleted_at IS NULL`, [ID.acc])).rows[0].s);

test('boot', { skip: SKIP }, async () => { await boot(); });

// ---------------------------------------------------------------------
test('① 버그 재현 시나리오 — 인보이스 1건만 먼저 반제해도 통지에 잔여가 남는다', { skip: SKIP }, async () => {
  // 고객이 인보이스 3건(11,600+23,200+34,800=69,600)을 한 번에 송금 → 통지 1건
  ID.dep = await mkDeposit(69600, '3건 한번에');

  // 인보이스 1건(11,600)만 먼저 반제
  const r = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: ID.dep,
    allocations: [{ invoice_id: ID.inv1, amount: 11600 }], memo: `${TAG} 1차`,
  });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.deposit_closed, false, '통지가 닫히면 안 된다');
  assert.equal(d.advance, 0, '남은 돈이 선수금으로 새어나가면 안 된다');
  assert.equal(d.amount, 11600, '이번 반제 헤더 금액 = 배분한 금액');
  assert.equal(d.deposit_remaining, 58000, '잔여 = 69,600 - 11,600');
  ID.pay1 = d.id;

  // 인박스에 "부분배분 · 잔여 58,000" 으로 남아 있어야 한다 — 이게 원래 안 되던 부분.
  const items = await inbox();
  const row = items.find((x) => x.id === ID.dep);
  assert.ok(row, '통지가 인박스에서 사라지면 안 된다');
  assert.equal(row.partial, true);
  assert.equal(row.allocated_amount, 11600);
  assert.equal(row.remaining, 58000);
  assert.equal(row.alloc_customer_id, ID.cust, '이어서 반제할 고객이 따라와야 한다');

  assert.equal(await outstanding(ID.inv1), 0, 'F1 완납');
  assert.equal(await outstanding(ID.inv2), 23200, 'F2 는 그대로 미수');
});

test('② 잔여로 이어서 반제 — 두 번째 인보이스', { skip: SKIP }, async () => {
  const r = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: ID.dep,
    allocations: [{ invoice_id: ID.inv2, amount: 23200 }], memo: `${TAG} 2차`,
  });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.deposit_closed, false);
  assert.equal(d.deposit_used, 34800);
  assert.equal(d.deposit_remaining, 34800);
  ID.pay2 = d.id;

  const row = (await inbox()).find((x) => x.id === ID.dep);
  assert.equal(row.remaining, 34800);
  assert.equal(await outstanding(ID.inv2), 0);
});

test('③ 마지막 인보이스로 전액 소진 → 통지 자동 닫힘 · 선수금 0', { skip: SKIP }, async () => {
  const r = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: ID.dep,
    allocations: [{ invoice_id: ID.inv3, amount: 34800 }], memo: `${TAG} 3차`,
  });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.deposit_closed, true, '잔여 0 이면 자동으로 닫힌다');
  assert.equal(d.advance, 0);
  assert.equal(d.deposit_remaining, 0);

  assert.equal((await inbox()).find((x) => x.id === ID.dep), undefined, '닫힌 통지는 인박스에서 사라진다');
  assert.equal(await outstanding(ID.inv3), 0);

  const dep = (await query(`SELECT status, allocated_amount FROM bank_deposits_pending WHERE id=$1`, [ID.dep])).rows[0];
  assert.equal(dep.status, 'allocated');
  assert.equal(Number(dep.allocated_amount), 69600);

  // 이중계상 없음: 이 계좌 입금 거래 합 = 통지 금액 정확히 1회분
  assert.equal(await accountIn(), 69600, '입금 거래 합계 = 통지 금액(이중계상 없음)');
  // 반제 3건이 모두 이 통지에 연결되어 있다
  const links = Number((await query(`SELECT COUNT(*) AS n FROM bank_deposit_payments WHERE deposit_id=$1`, [ID.dep])).rows[0].n);
  assert.equal(links, 3);
});

test('④ 소진된 통지에 더 반제 불가 (deposit_exhausted / not_pending)', { skip: SKIP }, async () => {
  const r = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: ID.dep, allocations: [{ invoice_id: ID.inv1, amount: 1 }],
  });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'deposit_not_pending');
});

test('⑤ 잔여 초과 배분 거부 — 상한은 통지 "잔여"', { skip: SKIP }, async () => {
  const dep = await mkDeposit(11600, '초과테스트');
  // 인보이스 하나를 새로 만들어 미수 확보
  const inv = Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,'2026-08-01',30,'2026-08-31',20000,3200,23200,'posted',$3,$4,$3) RETURNING id`,
    [`${TAG}-F9`, ID.cust, ID.dir, `${TAG} F9`])).rows[0].id);

  // 1차: 5,000 만 배분 → 잔여 6,600
  const a = await post('sup', '/api/ar/payments', { customer_id: ID.cust, deposit_id: dep, allocations: [{ invoice_id: inv, amount: 5000 }] });
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(a.json().deposit_remaining, 6600);

  // 2차: 잔여(6,600)를 넘는 7,000 → 거부. 통지 총액(11,600) 기준이 아니라 잔여 기준이어야 한다.
  const b = await post('sup', '/api/ar/payments', { customer_id: ID.cust, deposit_id: dep, allocations: [{ invoice_id: inv, amount: 7000 }] });
  assert.equal(b.statusCode, 400);
  assert.equal(b.json().error, 'allocations_exceed_deposit');
  assert.equal(b.json().deposit, 6600, '초과 판정 기준은 잔여');

  ID.depPartial = dep; ID.invPartial = inv;
});

test('⑥ 잔여를 선수금으로 확정하고 닫기 (close_deposit)', { skip: SKIP }, async () => {
  const before = await accountIn();
  const r = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: ID.depPartial, allocations: [], close_deposit: true, memo: `${TAG} 잔여선수금`,
  });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.deposit_closed, true);
  assert.equal(d.advance, 6600, '잔여 전액이 선수금');
  assert.equal(d.allocated, 0);
  assert.equal(await accountIn() - before, 6600, '선수금 거래 1건만 추가');

  const dep = (await query(`SELECT status, allocated_amount FROM bank_deposits_pending WHERE id=$1`, [ID.depPartial])).rows[0];
  assert.equal(dep.status, 'allocated');
  assert.equal(Number(dep.allocated_amount), 11600);
});

test('⑦ 센타보 먼지(0.5 미만)는 자동으로 선수금 처리 + 닫힘', { skip: SKIP }, async () => {
  // 인보이스 11,600.32 인데 은행 입금은 11,600 페소 단위 → 반대로 통지가 0.32 더 많은 케이스
  const inv = Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,'2026-08-01',30,'2026-08-31',10000,1600,11600,'posted',$3,$4,$3) RETURNING id`,
    [`${TAG}-F8`, ID.cust, ID.dir, `${TAG} F8`])).rows[0].id);
  const dep = await mkDeposit(11600.32, '센타보먼지');
  const r = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: dep, allocations: [{ invoice_id: inv, amount: 11600 }],
  });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.deposit_closed, true, '0.32 는 잔여로 남기지 않고 자동 정리');
  assert.equal(d.advance, 0.32);
  assert.equal(d.deposit_remaining, 0);
});

test('⑧ 부분배분 중인 통지는 취소·수정·삭제·수입전환 불가 (has_allocation)', { skip: SKIP }, async () => {
  const inv = Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,'2026-08-01',30,'2026-08-31',10000,1600,11600,'posted',$3,$4,$3) RETURNING id`,
    [`${TAG}-F7`, ID.cust, ID.dir, `${TAG} F7`])).rows[0].id);
  const dep = await mkDeposit(23200, '가드테스트');
  const a = await post('sup', '/api/ar/payments', { customer_id: ID.cust, deposit_id: dep, allocations: [{ invoice_id: inv, amount: 11600 }] });
  assert.equal(a.statusCode, 200, a.body);

  for (const [label, res] of [
    ['void', await post('fin', `/api/bank-deposits/${dep}/void`, {})],
    ['book-income', await post('dir', `/api/bank-deposits/${dep}/book-income`, { amount: 23200 })],
    ['patch', await patch('fin', `/api/bank-deposits/${dep}`, { account_id: ID.acc, deposit_date: '2026-08-20', amount: 30000 })],
    ['delete', await del('fin', `/api/bank-deposits/${dep}`)],
  ]) {
    assert.equal(res.statusCode, 409, `${label} 는 409 여야 함 (${res.body})`);
    assert.equal(res.json().error, 'has_allocation', label);
  }
  ID.depGuard = dep; ID.payGuard = a.json().id; ID.invGuard = inv;
});

test('⑨ 반제 취소 → 통지 잔여가 그만큼 되돌아온다', { skip: SKIP }, async () => {
  const before = (await inbox()).find((x) => x.id === ID.depGuard);
  assert.equal(before.remaining, 11600);

  const r = await del('dir', `/api/ar/payments/${ID.payGuard}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().deposit_reopened, true);

  const after = (await inbox()).find((x) => x.id === ID.depGuard);
  assert.equal(after.remaining, 23200, '취소한 만큼 잔여 복구');
  assert.equal(after.allocated_amount, 0);
  assert.equal(after.partial, false);
  assert.equal(await outstanding(ID.invGuard), 11600, '인보이스 미수 복구');

  // 배분이 0 으로 돌아왔으니 이제 취소·삭제가 다시 가능해야 한다
  const v = await post('fin', `/api/bank-deposits/${ID.depGuard}/void`, {});
  assert.equal(v.statusCode, 200, v.body);
});

test('⑩ 부분배분 통지는 폴링 팝업(unread)을 다시 띄우지 않는다', { skip: SKIP }, async () => {
  const inv = Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,'2026-08-01',30,'2026-08-31',10000,1600,11600,'posted',$3,$4,$3) RETURNING id`,
    [`${TAG}-F6`, ID.cust, ID.dir, `${TAG} F6`])).rows[0].id);
  const dep = await mkDeposit(23200, '알림테스트');

  // 재무가 등록 → 영업지원에게 안읽음으로 보인다
  let un = (await get('sup', '/api/bank-deposits/unread')).json();
  assert.ok(un.items.some((x) => x.id === dep), '새 통지는 안읽음에 뜬다');

  // 일부만 반제 → 안읽음에서 빠진다(잔여가 있어도 팝업은 다시 뜨지 않음)
  const a = await post('sup', '/api/ar/payments', { customer_id: ID.cust, deposit_id: dep, allocations: [{ invoice_id: inv, amount: 11600 }] });
  assert.equal(a.statusCode, 200, a.body);
  un = (await get('sup', '/api/bank-deposits/unread')).json();
  assert.equal(un.items.some((x) => x.id === dep), false, '부분배분 통지는 팝업 대상이 아니다');

  // 그래도 인박스에는 잔여로 남아 있다
  assert.equal((await inbox()).find((x) => x.id === dep).remaining, 11600);
});

test('⑪ 회귀 — 한 번에 여러 인보이스 배분(기존 카트 동작)은 그대로', { skip: SKIP }, async () => {
  const mk = async (sat, sub) => Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,'2026-08-01',30,'2026-08-31',$3,$4,$5,'posted',$6,$7,$6) RETURNING id`,
    [sat, ID.cust, sub, r2(sub * 0.16), r2(sub * 1.16), ID.dir, `${TAG} ${sat}`])).rows[0].id);
  const i1 = await mk(`${TAG}-G1`, 10000), i2 = await mk(`${TAG}-G2`, 20000);
  const dep = await mkDeposit(34800, '한번에2건');
  const r = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: dep,
    allocations: [{ invoice_id: i1, amount: 11600 }, { invoice_id: i2, amount: 23200 }],
  });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.deposit_closed, true);
  assert.equal(d.allocated, 34800);
  assert.equal(d.advance, 0);
  assert.equal(await outstanding(i1), 0);
  assert.equal(await outstanding(i2), 0);
});

test('cleanup', { skip: SKIP }, async () => {
  const { pool } = await import('../src/db.js');
  await app.close();
  await pool.end();
});
