// =====================================================================
// 선수금(과입금) 관리 종단 검증 — 실 PostgreSQL(0001~0191) + 실 라우트
//
// 배경(디렉터 보고): "반제처리한 게 사라졌고 지금은 선수금 과입금으로 보인다. 어디서 지우나?"
//   → 선수금만 남은 입금건은 배분(allocation)이 0건이라 인보이스 수금내역 어디에도 안 뜨고,
//     거래목록에서는 kind='advance' 라 삭제가 막혀 **손댈 수 있는 화면이 없었다**.
//   이 파일은 그 상태가 어떻게 생기는지 재현하고, 새 관리 경로(조회·배분·취소)를 검증한다.
//
//   실행: TEST_PG_URL=postgres://... node --test test/ar_advance_manage.test.mjs
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
const TAG = 'ADVMAN';
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

async function boot() {
  ({ query } = await import('../src/db.js'));
  financeRoutes = (await import('../src/routes/financeRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  const TAGACC = `SELECT id FROM accounts WHERE name LIKE '${TAG}%'`;
  const TAGPAY = `SELECT id FROM sales_payments WHERE account_id IN (${TAGACC}) OR memo LIKE '%${TAG}%'`;
  await query(`DELETE FROM bank_deposit_payments WHERE payment_id IN (${TAGPAY})`);
  await query(`DELETE FROM bank_deposit_payments WHERE deposit_id IN (SELECT id FROM bank_deposits_pending WHERE payer_memo LIKE '%${TAG}%')`);
  await query(`DELETE FROM bank_deposit_reads WHERE deposit_id IN (SELECT id FROM bank_deposits_pending WHERE payer_memo LIKE '%${TAG}%')`);
  await query(`DELETE FROM bank_deposit_docs  WHERE deposit_id IN (SELECT id FROM bank_deposits_pending WHERE payer_memo LIKE '%${TAG}%')`);
  await query(`UPDATE bank_deposits_pending SET payment_id=NULL WHERE payer_memo LIKE '%${TAG}%' OR account_id IN (${TAGACC})`);
  await query(`DELETE FROM sales_payment_allocations WHERE payment_id IN (${TAGPAY})`);
  await query(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo LIKE '%${TAG}%')`);
  await query(`UPDATE sales_payments SET advance_txn_id=NULL WHERE id IN (${TAGPAY})`);
  await query(`DELETE FROM sales_payments WHERE account_id IN (${TAGACC}) OR memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM bank_deposits_pending WHERE payer_memo LIKE '%${TAG}%' OR account_id IN (${TAGACC})`);
  await query(`DELETE FROM transactions WHERE memo LIKE '%${TAG}%' OR account_id IN (${TAGACC})`);
  await query(`DELETE FROM sales_invoices WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'advman%')`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'advman%')`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM users WHERE login_id LIKE 'advman%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'advman_dir');
  ID.sup = await mkUser(`${TAG}영업지원`, 'sales_support', 'advman_sup');
  ID.fin = await mkUser(`${TAG}재무`, 'treasury', 'advman_fin');
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

const mkInv = async (sat, sub) => Number((await query(
  `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                               status, owner_id, memo, created_by)
   VALUES ($1,$2,'2026-08-01',30,'2026-08-31',$3,$4,$5,'posted',$6,$7,$6) RETURNING id`,
  [sat, ID.cust, sub, r2(sub * 0.16), r2(sub * 1.16), ID.dir, `${TAG} ${sat}`])).rows[0].id);

async function mkDeposit(amount, memo) {
  const r = await post('fin', '/api/bank-deposits', {
    account_id: ID.acc, deposit_date: '2026-08-20', amount,
    payer_memo: `${TAG} ${memo}`, customer_id: ID.cust, file: PNG, file_name: 'cap.png',
  });
  assert.equal(r.statusCode, 200, r.body);
  return Number(r.json().id);
}
const outstanding = async (invId) => Number((await query(
  `SELECT s.total_mxn - COALESCE((SELECT SUM(amount) FROM sales_payment_allocations WHERE invoice_id=s.id),0) AS o
     FROM sales_invoices s WHERE s.id=$1`, [invId])).rows[0].o);
const accountIn = async () => Number((await query(
  `SELECT COALESCE(SUM(amount_mxn),0) AS s FROM transactions
    WHERE account_id=$1 AND direction='in' AND deleted_at IS NULL`, [ID.acc])).rows[0].s);
const txnByKind = async (kind) => (await query(
  `SELECT id, amount_mxn, category_code FROM transactions
    WHERE account_id=$1 AND kind=$2 AND deleted_at IS NULL ORDER BY id`, [ID.acc, kind])).rows;
const advances = async (who = 'sup') => (await get(who, '/api/ar/advances')).json().items;

test('boot', { skip: SKIP }, async () => { await boot(); });

// ---------------------------------------------------------------------
test('① 재현 — 배분을 지우면 선수금만 남은 "보이지 않는" 입금건이 생긴다', { skip: SKIP }, async () => {
  const inv = await mkInv(`${TAG}-F1`, 10000);        // 11,600
  const dep = await mkDeposit(23200, '과입금건');
  // 11,600 배분 + 나머지 11,600 을 선수금으로 확정하며 통지 닫기
  const p = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: dep, allocations: [{ invoice_id: inv, amount: 11600 }], close_deposit: true,
  });
  assert.equal(p.statusCode, 200, p.body);
  assert.equal(p.json().advance, 11600);
  ID.pay1 = Number(p.json().id); ID.inv1 = inv;

  // 그 배분을 지운다 → 헤더는 선수금을 안은 채 남는다(= 반제가 사라지고 선수금만 보이는 상태)
  const al = (await query(`SELECT id FROM sales_payment_allocations WHERE payment_id=$1`, [ID.pay1])).rows[0];
  const d = await del('dir', `/api/ar/allocations/${al.id}`);
  assert.equal(d.statusCode, 200, d.body);
  assert.equal(d.json().payment_deleted, false, '선수금이 있으면 입금 헤더는 남는다');
  assert.equal(await outstanding(ID.inv1), 11600, '인보이스 미수는 복구');

  // 인보이스 드릴다운에는 흔적이 없다 — 사용자가 "사라졌다"고 느끼는 지점
  const hist = (await get('sup', `/api/ar/invoice/${ID.inv1}/payments`)).json();
  assert.equal(hist.payments.length, 0, '수금내역에서 완전히 사라진다');

  // 그런데 선수금 목록에는 잡힌다 — 새로 만든 진입점
  const list = await advances();
  const row = list.find((x) => x.id === ID.pay1);
  assert.ok(row, '선수금 목록에서 찾을 수 있어야 한다');
  assert.equal(row.advance_amount, 11600);
  assert.equal(row.alloc_count, 0);
  assert.equal(row.customer_id, ID.cust);
  assert.equal(row.deposit_id, dep, '어느 통지에서 온 돈인지 추적된다');
});

test('② 선수금을 인보이스에 배분 — 계좌 잔액은 그대로, 2030 → 4010 이동', { skip: SKIP }, async () => {
  const inBefore = await accountIn();
  const advBefore = (await txnByKind('advance')).reduce((s, t) => s + Number(t.amount_mxn), 0);
  assert.equal(advBefore, 11600, '선수금 거래가 11,600 으로 서 있다');

  const r = await post('dir', `/api/ar/advances/${ID.pay1}/apply`, {
    allocations: [{ invoice_id: ID.inv1, amount: 11600 }],
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().applied, 11600);
  assert.equal(r.json().advance_left, 0);

  assert.equal(await outstanding(ID.inv1), 0, '인보이스 완납');
  assert.equal(await accountIn(), inBefore, '계좌 입금 합계 불변 — 새 현금을 만들지 않는다');
  assert.equal((await txnByKind('advance')).length, 0, '선수금 거래는 소멸');
  const pays = (await txnByKind('payment')).filter((t) => Number(t.amount_mxn) === 11600);
  assert.equal(pays.length, 1, '같은 금액의 매출수금(4010) 거래가 1건 생김');
  assert.equal(pays[0].category_code, '4010');

  // 선수금 소진 → 목록에서 사라지고, 인보이스 수금내역에는 다시 나타난다
  assert.equal((await advances()).find((x) => x.id === ID.pay1), undefined);
  assert.equal((await get('sup', `/api/ar/invoice/${ID.inv1}/payments`)).json().payments.length, 1);
});

test('③ 부분 배분 — 선수금 잔여가 줄고 2030 거래 금액도 함께 줄어든다', { skip: SKIP }, async () => {
  const inv = await mkInv(`${TAG}-F2`, 20000);        // 23,200
  const dep = await mkDeposit(11600, '부분배분용');
  const p = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: dep, allocations: [], close_deposit: true, memo: `${TAG} 전액선수금`,
  });
  assert.equal(p.statusCode, 200, p.body);
  assert.equal(p.json().advance, 11600);
  const pid = Number(p.json().id);

  const inBefore = await accountIn();
  const r = await post('dir', `/api/ar/advances/${pid}/apply`, { allocations: [{ invoice_id: inv, amount: 5000 }] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().advance_left, 6600);

  assert.equal(await outstanding(inv), 18200, '23,200 − 5,000');
  assert.equal(await accountIn(), inBefore, '잔액 불변');
  const adv = (await txnByKind('advance')).filter((t) => Number(t.amount_mxn) === 6600);
  assert.equal(adv.length, 1, '선수금 거래가 6,600 으로 축소');

  const row = (await advances()).find((x) => x.id === pid);
  assert.equal(row.advance_amount, 6600);
  assert.equal(row.alloc_count, 1);
  assert.equal(row.allocated, 5000);
  ID.pay2 = pid; ID.inv2 = inv;
});

test('④ 가드 — 선수금 초과 · 남의 고객 인보이스 · 미수 초과 · 빈 배분', { skip: SKIP }, async () => {
  const over = await post('dir', `/api/ar/advances/${ID.pay2}/apply`, { allocations: [{ invoice_id: ID.inv2, amount: 9999 }] });
  assert.equal(over.statusCode, 400);
  assert.equal(over.json().error, 'exceeds_advance');
  assert.equal(over.json().advance, 6600);

  const empty = await post('dir', `/api/ar/advances/${ID.pay2}/apply`, { allocations: [] });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error, 'no_allocations');

  // 다른 고객의 인보이스
  const other = Number((await query(
    `INSERT INTO customers (name, code, credit_days, created_by) VALUES ($1,$2,30,$3) RETURNING id`,
    [`${TAG}타고객`, `${TAG}-2`, ID.dir])).rows[0].id);
  const foreign = Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,'2026-08-01',30,'2026-08-31',10000,1600,11600,'posted',$3,$4,$3) RETURNING id`,
    [`${TAG}-FX`, other, ID.dir, `${TAG} FX`])).rows[0].id);
  const bad = await post('dir', `/api/ar/advances/${ID.pay2}/apply`, { allocations: [{ invoice_id: foreign, amount: 100 }] });
  assert.equal(bad.statusCode, 409);
  assert.equal(bad.json().detail[0].error, 'not_customer_invoice');

  // 인보이스 미수(18,200)보다 크게 — 선수금(6,600) 안이라도 거부
  const inv3 = await mkInv(`${TAG}-F3`, 1000);   // 1,160
  const overInv = await post('dir', `/api/ar/advances/${ID.pay2}/apply`, { allocations: [{ invoice_id: inv3, amount: 5000 }] });
  assert.equal(overInv.statusCode, 409);
  assert.equal(overInv.json().detail[0].error, 'over_outstanding');
});

test('⑤ 권한 — 배분은 디렉터 전용, 조회는 settlement 권한자', { skip: SKIP }, async () => {
  const r = await post('sup', `/api/ar/advances/${ID.pay2}/apply`, { allocations: [{ invoice_id: ID.inv2, amount: 100 }] });
  assert.equal(r.statusCode, 403, '영업지원은 배분 불가');
  assert.equal((await get('sup', '/api/ar/advances')).statusCode, 200, '조회는 가능');
  assert.ok((await advances('sup')).length > 0);
});

test('⑥ 입금 취소 — 선수금 소멸 · 반제 복구 · 통지 인박스 복귀', { skip: SKIP }, async () => {
  const invBefore = await outstanding(ID.inv2);
  assert.equal(invBefore, 18200);
  const inBefore = await accountIn();

  const r = await del('dir', `/api/ar/payments/${ID.pay2}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().deposit_reopened, true, '연결된 통지가 인박스로 복귀');
  assert.equal(r.json().advance, 6600);

  assert.equal(await outstanding(ID.inv2), 23200, '배분했던 5,000 도 함께 복구');
  assert.equal((await advances()).find((x) => x.id === ID.pay2), undefined, '선수금 목록에서 사라짐');
  // 이 입금건이 만든 거래(배분 5,000 + 선수금 잔여 6,600)가 통째로 계좌에서 빠진다
  assert.equal(r2(inBefore - await accountIn()), 11600, '입금 총액만큼 계좌에서 빠짐');
  assert.equal((await txnByKind('advance')).filter((t) => Number(t.amount_mxn) === 6600).length, 0, '축소돼 있던 선수금 거래도 취소');

  // 복귀한 통지는 잔여 전액으로 다시 반제 가능하다
  const inbox = (await get('sup', '/api/bank-deposits?status=pending')).json().items;
  const back = inbox.find((x) => Number(x.amount) === 11600 && String(x.payer_memo || '').includes('부분배분용'));
  assert.ok(back, '통지가 인박스에 다시 보인다');
  assert.equal(back.remaining, 11600, '잔여가 전액으로 복구');
});

test('⑦ 선수금 0 인 입금건은 목록에 뜨지 않는다 (회귀)', { skip: SKIP }, async () => {
  const inv = await mkInv(`${TAG}-F4`, 10000);
  const dep = await mkDeposit(11600, '정상반제');
  const p = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: dep, allocations: [{ invoice_id: inv, amount: 11600 }],
  });
  assert.equal(p.statusCode, 200, p.body);
  assert.equal(p.json().advance, 0);
  assert.equal((await advances()).find((x) => x.id === Number(p.json().id)), undefined);
});

test('cleanup', { skip: SKIP }, async () => {
  const { pool } = await import('../src/db.js');
  await app.close();
  await pool.end();
});
