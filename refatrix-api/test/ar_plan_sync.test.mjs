// =====================================================================
// 「매출 입금예정」(AR plan) 자동 정리 검증 — 실 PostgreSQL(0001~0192) + 실 라우트
//
// 배경(디렉터 보고 2026-09-01): "recar 24,005가 선수금으로 남아있다 — folio 31 은 완납인데."
//   실제로는 선수금이 아니라 **완납된 인보이스의 매출 입금예정 거래**가 거래목록에 남아 있던 것.
//   (선수금은 0.47 뿐이었다.) 이제 반제/취소/NC 때마다 예정을 잔액에 맞춘다.
//
//   실행: TEST_PG_URL=postgres://... node --test test/ar_plan_sync.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, financeRoutes, ncRoutes, Fastify, jwt, app;
const tok = {};
const ID = {};
const TAG = 'ARPLAN';
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

async function boot() {
  ({ query } = await import('../src/db.js'));
  financeRoutes = (await import('../src/routes/financeRoutes.js')).default;
  ncRoutes = (await import('../src/routes/notaCreditoRoutes.js')).default;
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
  await query(`DELETE FROM nota_credito_docs WHERE nc_id IN (SELECT id FROM notas_credito WHERE concepto LIKE '%${TAG}%')`);
  await query(`DELETE FROM notas_credito WHERE concepto LIKE '%${TAG}%'`);
  await query(`UPDATE sales_invoices SET txn_id=NULL WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM transactions WHERE memo LIKE '%${TAG}%' OR account_id IN (${TAGACC})
                 OR sales_invoice_id IN (SELECT id FROM sales_invoices WHERE memo LIKE '%${TAG}%')`);
  await query(`DELETE FROM sales_invoices WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'arplan%')`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'arplan%')`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM users WHERE login_id LIKE 'arplan%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'arplan_dir');
  ID.sup = await mkUser(`${TAG}영업지원`, 'sales_support', 'arplan_sup');
  ID.fin = await mkUser(`${TAG}재무`, 'treasury', 'arplan_fin');
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
  await app.register(ncRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.sup = app.jwt.sign({ sub: ID.sup });
  tok.fin = app.jwt.sign({ sub: ID.fin });
}
const get = (who, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[who] } });
const post = (who, url, body) => app.inject({ method: 'POST', url, payload: body, headers: { authorization: 'Bearer ' + tok[who] } });
const del = (who, url) => app.inject({ method: 'DELETE', url, headers: { authorization: 'Bearer ' + tok[who] } });

// 인보이스 + 발행 시 만들어지는 「매출 입금예정」 plan 거래를 운영과 똑같이 만든다.
async function mkInvoiceWithPlan(sat, sub, due = '2026-08-31') {
  const total = r2(sub * 1.16);
  const inv = Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,'2026-08-01',30,$3,$4,$5,$6,'posted',$7,$8,$7) RETURNING id`,
    [sat, ID.cust, due, sub, r2(sub * 0.16), total, ID.dir, `${TAG} ${sat}`])).rows[0].id);
  const txn = Number((await query(
    `INSERT INTO transactions (txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, owner_id, sales_invoice_id, memo, created_by)
     VALUES ($1,'in',$2,'MXN',1,$2,'4010','plan','invoice',true,$3,$4,$5,$3) RETURNING id`,
    [due, total, ID.dir, inv, `매출 입금예정 (인보이스 #${inv})`])).rows[0].id);
  await query(`UPDATE sales_invoices SET txn_id=$1 WHERE id=$2`, [txn, inv]);
  return { inv, txn, total };
}
// 살아있는 예정 거래 상태 — {alive, amount}
const planState = async (invId) => {
  const r = (await query(
    `SELECT amount_mxn, deleted_at FROM transactions
      WHERE sales_invoice_id=$1 AND status='plan' AND kind='invoice' ORDER BY id LIMIT 1`, [invId])).rows[0];
  return r ? { alive: r.deleted_at == null, amount: r2(Number(r.amount_mxn)) } : null;
};
async function mkDeposit(amount, memo) {
  const r = await post('fin', '/api/bank-deposits', {
    account_id: ID.acc, deposit_date: '2026-08-20', amount,
    payer_memo: `${TAG} ${memo}`, customer_id: ID.cust, file: PNG, file_name: 'c.png',
  });
  assert.equal(r.statusCode, 200, r.body);
  return Number(r.json().id);
}

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 완납하면 매출 입금예정이 사라진다 (RECAR folio 31 시나리오)', { skip: SKIP }, async () => {
  const { inv, total } = await mkInvoiceWithPlan(`${TAG}-F1`, 20693.56);  // 24,004.53
  assert.equal(total, 24004.53);
  assert.deepEqual(await planState(inv), { alive: true, amount: 24004.53 }, '발행 직후엔 예정이 총액으로 서 있다');

  const dep = await mkDeposit(24005, 'ryo_recar 재현');
  const p = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: dep, allocations: [{ invoice_id: inv, amount: 24004.53 }],
  });
  assert.equal(p.statusCode, 200, p.body);
  assert.equal(p.json().advance, 0.47, '센타보 잔여 0.47 은 선수금 — 실제 운영과 동일');

  assert.deepEqual(await planState(inv), { alive: false, amount: 24004.53 }, '완납 → 예정 소프트 삭제');
  ID.inv1 = inv; ID.pay1 = Number(p.json().id);
});

test('② 부분수금이면 예정이 잔액만큼 줄어든다', { skip: SKIP }, async () => {
  const { inv } = await mkInvoiceWithPlan(`${TAG}-F2`, 20000);   // 23,200
  const dep = await mkDeposit(10000, '부분수금');
  const p = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: dep, allocations: [{ invoice_id: inv, amount: 10000 }],
  });
  assert.equal(p.statusCode, 200, p.body);
  assert.deepEqual(await planState(inv), { alive: true, amount: 13200 }, '23,200 − 10,000');
  ID.inv2 = inv;
});

test('③ 반제를 되돌리면 예정도 되살아난다', { skip: SKIP }, async () => {
  assert.equal((await planState(ID.inv1)).alive, false);
  const r = await del('dir', `/api/ar/payments/${ID.pay1}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(await planState(ID.inv1), { alive: true, amount: 24004.53 }, '미수가 되살아나면 예정도 복구');
});

test('④ 선수금 배분으로 완납돼도 예정이 정리된다', { skip: SKIP }, async () => {
  const { inv } = await mkInvoiceWithPlan(`${TAG}-F3`, 10000);   // 11,600
  const dep = await mkDeposit(11600, '전액선수금');
  const p = await post('sup', '/api/ar/payments', {
    customer_id: ID.cust, deposit_id: dep, allocations: [], close_deposit: true, memo: `${TAG} adv`,
  });
  assert.equal(p.statusCode, 200, p.body);
  assert.deepEqual(await planState(inv), { alive: true, amount: 11600 }, '아직 배분 전이라 예정 그대로');

  const a = await post('dir', `/api/ar/advances/${Number(p.json().id)}/apply`, {
    allocations: [{ invoice_id: inv, amount: 11600 }],
  });
  assert.equal(a.statusCode, 200, a.body);
  assert.deepEqual(await planState(inv), { alive: false, amount: 11600 }, '선수금 배분으로 완납 → 예정 소멸');
});

test('⑤ NC(비현금)로 마감돼도 예정이 정리되고, NC 취소하면 복구된다', { skip: SKIP }, async () => {
  const { inv } = await mkInvoiceWithPlan(`${TAG}-F4`, 10000);   // 11,600
  const nc = await post('dir', '/api/nc', { invoice_id: inv, concepto: `${TAG} 할인`, base_mxn: 11600 });
  assert.equal(nc.statusCode, 200, nc.body);
  const ncId = Number(nc.json().id);
  // 승인은 서명 증빙이 있어야 통과한다(no_signed_doc) — 운영 절차 그대로.
  await query(`INSERT INTO nota_credito_docs (nc_id, file_name, mime_type, file_data, uploaded_by)
               VALUES ($1,'sign.png','image/png',$2,$3)`, [ncId, PNG, ID.dir]);
  const ap0 = await post('dir', `/api/nc/${ncId}/approve`, {});
  assert.equal(ap0.statusCode, 200, ap0.body);
  const ap = await post('dir', `/api/nc/${ncId}/apply`, {});
  assert.equal(ap.statusCode, 200, ap.body);
  assert.equal((await planState(inv)).alive, false, 'NC 완납 → 예정 소멸');

  const v = await post('dir', `/api/nc/${ncId}/void`, {});
  assert.equal(v.statusCode, 200, v.body);
  assert.deepEqual(await planState(inv), { alive: true, amount: 11600 }, 'NC 취소 → 예정 복구');
});

test('⑥ 0192 백필 — 이미 쌓인 잔류 예정을 한 번에 정리한다', { skip: SKIP }, async () => {
  // 라우트를 우회해 배분만 직접 넣어 "구 데이터"(예정이 안 줄어든 상태)를 만든다.
  const { inv: paidInv } = await mkInvoiceWithPlan(`${TAG}-OLD1`, 10000);    // 11,600 → 전액
  const { inv: partInv } = await mkInvoiceWithPlan(`${TAG}-OLD2`, 20000);    // 23,200 → 5,000만
  const pid = Number((await query(
    `INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, memo, created_by)
     VALUES ($1,'2026-08-26',$2,16600,$3,$4) RETURNING id`, [ID.cust, ID.acc, `${TAG} 구데이터`, ID.dir])).rows[0].id);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, kind) VALUES ($1,$2,11600,'cash')`, [pid, paidInv]);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, kind) VALUES ($1,$2,5000,'cash')`, [pid, partInv]);

  assert.deepEqual(await planState(paidInv), { alive: true, amount: 11600 }, '백필 전: 완납인데 예정이 살아있다');
  assert.deepEqual(await planState(partInv), { alive: true, amount: 23200 }, '백필 전: 부분수금인데 총액 그대로');

  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(resolve(here, '..', 'migrations', '0192_ar_plan_sync_backfill.sql'), 'utf8');
  await query(sql);

  assert.deepEqual(await planState(paidInv), { alive: false, amount: 11600 }, '백필 후: 완납 예정 정리');
  assert.deepEqual(await planState(partInv), { alive: true, amount: 18200 }, '백필 후: 잔액 18,200 으로 축소');

  // 멱등: 두 번 돌려도 결과가 같다
  await query(sql);
  assert.deepEqual(await planState(paidInv), { alive: false, amount: 11600 });
  assert.deepEqual(await planState(partInv), { alive: true, amount: 18200 });
});

test('⑦ 미수 인보이스의 예정은 건드리지 않는다 (회귀)', { skip: SKIP }, async () => {
  const { inv } = await mkInvoiceWithPlan(`${TAG}-OPEN`, 30000);   // 34,800 · 수금 없음
  const here = dirname(fileURLToPath(import.meta.url));
  await query(readFileSync(resolve(here, '..', 'migrations', '0192_ar_plan_sync_backfill.sql'), 'utf8'));
  assert.deepEqual(await planState(inv), { alive: true, amount: 34800 }, '미수 건은 총액 그대로');
});

test('cleanup', { skip: SKIP }, async () => {
  const { pool } = await import('../src/db.js');
  await app.close();
  await pool.end();
});
