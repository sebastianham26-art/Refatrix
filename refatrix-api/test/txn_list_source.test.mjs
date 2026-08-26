// =====================================================================
// 재무 > 거래목록: 마케팅 등 계좌미지정 지출계획 노출 + 「출처」 구분 (2026-08-26)
//   요구(디렉터): "거래목록에 고정비 외에도 마케팅과 같은 지출계획도 나와야 한다."
//   원인: /api/transactions 가 비디렉터에게 `t.account_id = ANY(권한계좌)` 만 걸어
//         **계좌미지정(NULL) 거래가 통째로 제외** → 마케팅 지출계획(계좌 NULL)이 안 보이고
//         계좌가 붙는 고정비만 보였다. (loadCashTxns 는 이미 NULL 예외가 있었음)
//   실행 조건: TEST_PG_URL(실 Postgres + 전체 마이그레이션). 없으면 skip.
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
const TAG = 'TLSTEST';

async function boot() {
  ({ query } = await import('../src/db.js'));
  financeRoutes = (await import('../src/routes/financeRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  await query(`DELETE FROM transactions WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM sales_invoices WHERE memo='${TAG}'`);
  await query(`DELETE FROM customers WHERE code='${TAG}C1'`);
  await query(`DELETE FROM recurring_rules WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM user_account_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'tlstest%')`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'tlstest%')`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'tlstest%')`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);   // users 보다 먼저(accounts.created_by FK)
  await query(`DELETE FROM users WHERE login_id LIKE 'tlstest%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'tlstest_dir');
  ID.fin = await mkUser(`${TAG}재무`, 'treasury', 'tlstest_fin');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
               VALUES ($1,'transactions','anywhere','edit') ON CONFLICT DO NOTHING`, [ID.fin]);

  const mkAcc = async (name) => Number((await query(
    `INSERT INTO accounts (name, type, currency, open_balance, created_by)
     VALUES ($1,'bank','MXN',0,$2) RETURNING id`, [name, ID.dir])).rows[0].id);
  ID.acc = await mkAcc(`${TAG}은행`);
  ID.accHidden = await mkAcc(`${TAG}권한없음`);      // 재무담당에게 권한을 주지 않는 계좌
  await query(`INSERT INTO user_account_access (user_id, account_id, can_operate, can_detail)
               VALUES ($1,$2,true,true) ON CONFLICT DO NOTHING`, [ID.fin, ID.acc]);

  ID.rule = Number((await query(
    `INSERT INTO recurring_rules (name, category_code, amount, direction, freq, currency, account_id,
                                  start_date, day_of_month, active, created_by)
     VALUES ($1,'6020',10000,'out','month','MXN',$2,'2026-01-15',15,true,$3) RETURNING id`,
    [`${TAG}임차료`, ID.acc, ID.dir])).rows[0].id);

  const mkTxn = async (o) => Number((await query(
    `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn,
        category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date,
        recurring_rule_id, sales_invoice_id)
     VALUES ($1,$2,$3,$4,'MXN',1,$4,$5,$6,'general',true,$7,$8,$7,$9,$10,$11,$12) RETURNING id`,
    [o.account_id === undefined ? ID.acc : o.account_id, o.date, o.dir || 'out', o.amount, o.cat || '6020',
      o.status || 'plan', ID.dir, o.memo, o.status === 'actual' ? null : o.amount,
      o.status === 'actual' ? null : o.date, o.rule || null, o.inv || null])).rows[0].id);

  ID.fx = await mkTxn({ date: '2026-09-15', amount: 10000, memo: `[고정비] ${TAG}임차료`, rule: ID.rule });
  ID.mkt = await mkTxn({ account_id: null, date: '2026-09-20', amount: 3000, cat: '6070',
    memo: `[마케팅] ${TAG}전시회 · 일시불 · Expo Guadalajara` });
  ID.man = await mkTxn({ date: '2026-09-05', amount: 1500, memo: `${TAG} 수동 예정` });
  ID.hidden = await mkTxn({ account_id: ID.accHidden, date: '2026-09-06', amount: 999, memo: `${TAG} 권한없는계좌` });

  ID.cust = Number((await query(
    `INSERT INTO customers (code, name, discount, credit_days) VALUES ($1,$1,0,30) RETURNING id`, [`${TAG}C1`])).rows[0].id);
  ID.inv = Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn, status, memo, created_by)
     VALUES ($1,$2,'2026-08-01',30,'2026-09-01',10000,1600,11600,'posted',$3,$4) RETURNING id`,
    [`${TAG}-A1`, ID.cust, TAG, ID.dir])).rows[0].id);
  ID.ar = await mkTxn({ account_id: null, date: '2026-09-01', dir: 'in', amount: 11600, cat: '4010',
    memo: `${TAG} 수금예정`, inv: ID.inv });

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(financeRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.fin = app.jwt.sign({ sub: ID.fin });
}

const list = async (who, qs = '') => ((await app.inject({ method: 'GET', url: '/api/transactions' + qs,
  headers: { authorization: 'Bearer ' + tok[who] } })).json().items || [])
  .filter((t) => String(t.memo || '').includes(TAG))
  .map((t) => ({ ...t, id: Number(t.id) }));
const idsOf = (items) => items.map((t) => t.id).sort((a, b) => a - b);

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 디렉터: 고정비·마케팅·수동·매출수금이 모두 보인다', { skip: SKIP }, async () => {
  const items = await list('dir');
  assert.deepEqual(idsOf(items), [ID.fx, ID.mkt, ID.man, ID.hidden, ID.ar].sort((a, b) => a - b));
});

test('② ★ 재무담당(비디렉터)도 마케팅 지출계획이 보인다 — 이번 수정의 핵심', { skip: SKIP }, async () => {
  const items = await list('fin');
  const got = idsOf(items);
  assert.ok(got.includes(ID.mkt), '계좌미지정 마케팅 지출계획이 목록에 있어야 한다');
  assert.ok(got.includes(ID.ar), '계좌미지정 매출 수금예정도 함께 보인다');
  assert.ok(got.includes(ID.fx), '고정비는 종전대로 보인다');
  assert.ok(!got.includes(ID.hidden), '권한 없는 계좌의 거래는 여전히 안 보인다(회귀 방지)');
});

test('③ 출처(source) 가 항목마다 정확히 분류된다', { skip: SKIP }, async () => {
  const by = Object.fromEntries((await list('dir')).map((t) => [t.id, t.source]));
  assert.equal(by[ID.fx], 'recurring');
  assert.equal(by[ID.mkt], 'marketing', '[마케팅] 메모 접두사 → 마케팅');
  assert.equal(by[ID.man], 'manual');
  assert.equal(by[ID.ar], 'sales');
});

test('④ 계좌 필터: 특정 계좌를 고르면 계좌미지정 건은 빠진다', { skip: SKIP }, async () => {
  const items = await list('dir', `?account_id=${ID.acc}`);
  const got = idsOf(items);
  assert.ok(got.includes(ID.fx));
  assert.ok(!got.includes(ID.mkt), '계좌 지정 조회에 NULL 이 섞이면 안 됨');
  assert.ok(!got.includes(ID.ar));
});

test('⑤ account_id=none — 계좌미지정(마케팅·수금 계획)만 모아 본다', { skip: SKIP }, async () => {
  assert.deepEqual(idsOf(await list('dir', '?account_id=none')), [ID.mkt, ID.ar].sort((a, b) => a - b));
  assert.deepEqual(idsOf(await list('fin', '?account_id=none')), [ID.mkt, ID.ar].sort((a, b) => a - b));
});

test('⑥ 기존 필터(status·direction)와 함께 써도 정상', { skip: SKIP }, async () => {
  const plans = await list('fin', '?status=plan&direction=out');
  const got = idsOf(plans);
  assert.ok(got.includes(ID.mkt));
  assert.ok(got.includes(ID.fx));
  assert.ok(!got.includes(ID.ar), '수입(in)은 제외');
});

test('⑦ 계좌 권한이 하나도 없는 사용자도 회사 공통(계좌미지정) 계획은 본다', { skip: SKIP }, async () => {
  await query(`DELETE FROM user_account_access WHERE user_id=$1`, [ID.fin]);
  const got = idsOf(await list('fin'));
  assert.deepEqual(got, [ID.mkt, ID.ar].sort((a, b) => a - b),
    '권한 계좌 0개여도 빈 배열이 아니라 계좌미지정 건은 나온다');
  await query(`INSERT INTO user_account_access (user_id, account_id, can_operate, can_detail)
               VALUES ($1,$2,true,true) ON CONFLICT DO NOTHING`, [ID.fin, ID.acc]);
});

test('⑧ 디렉터 기준 — 거래목록(예정)과 예정 내역의 대상 집합·출처가 일치한다', { skip: SKIP }, async () => {
  const pp = ((await app.inject({ method: 'GET', url: '/api/transactions/pending-plans?all=1',
    headers: { authorization: 'Bearer ' + tok.dir } })).json().items || [])
    .filter((t) => String(t.memo || '').includes(TAG));
  const ppIds = pp.map((t) => Number(t.id)).sort((a, b) => a - b);
  const tx = await list('dir', '?status=plan');
  assert.deepEqual(idsOf(tx), ppIds, '두 화면의 대상 집합 일치');
  // 출처도 같은 기준(마케팅은 프런트에서 메모로 보정하므로 recurring/sales 만 서버끼리 비교)
  const ppSrc = Object.fromEntries(pp.map((t) => [Number(t.id), t.source]));
  const txSrc = Object.fromEntries(tx.map((t) => [t.id, t.source]));
  assert.equal(txSrc[ID.fx], ppSrc[ID.fx]);
  assert.equal(txSrc[ID.ar], ppSrc[ID.ar]);
});

// ⑨ 알아둘 차이(의도된 현재 동작): 「예정 내역」은 계좌 권한을 보지 않고 전사 예정을 보여주는 반면,
//    「거래목록」은 계좌 권한을 지킨다. 그래서 비디렉터에선 거래목록이 예정 내역의 부분집합이 된다.
test('⑨ 비디렉터: 거래목록은 계좌 권한을 지키므로 예정 내역의 부분집합이다', { skip: SKIP }, async () => {
  const ppIds = ((await app.inject({ method: 'GET', url: '/api/transactions/pending-plans?all=1',
    headers: { authorization: 'Bearer ' + tok.fin } })).json().items || [])
    .filter((t) => String(t.memo || '').includes(TAG)).map((t) => Number(t.id));
  const txIds = idsOf(await list('fin', '?status=plan'));
  assert.ok(txIds.every((id) => ppIds.includes(id)), '부분집합');
  assert.ok(ppIds.includes(ID.hidden) && !txIds.includes(ID.hidden),
    '권한 없는 계좌 건은 거래목록에서만 빠진다');
  assert.ok(txIds.includes(ID.mkt), '마케팅 지출계획은 양쪽 모두에 있다');
});
