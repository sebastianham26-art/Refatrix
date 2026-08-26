// =====================================================================
// 예정 행 [계획 수정] 의 「자금출처 계좌」 변경 — 실 PostgreSQL 종단 검증 (2026-08-26)
//   요구(디렉터): "거래목록에서 클릭해 수정할 때, **어느 은행계좌에서 출금되는지** 도 고칠 수 있어야 한다."
//   대상: PATCH /api/transactions/:id/plan  (account_id 지원 — 2026-07-29 v3 에서 유실됐던 기능 복구)
//   확정 정책: 고정비 회차의 계좌를 개별 지정하면 **예외로 보존**(plan_account_manual, 0184).
//             규칙을 다시 저장해도 그 회차의 계좌는 안 덮인다. 금액·계정과목은 계속 규칙을 따른다.
//   실행 조건: TEST_PG_URL(실 Postgres + 전체 마이그레이션 0184 포함). 없으면 skip.
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
const TAG = 'PAETEST';

async function boot() {
  ({ query } = await import('../src/db.js'));
  financeRoutes = (await import('../src/routes/financeRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  await query(`DELETE FROM transactions WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM sales_invoices WHERE memo='${TAG}'`);
  await query(`DELETE FROM customers WHERE code='${TAG}C1'`);
  await query(`DELETE FROM recurring_rules WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM user_account_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'paetest%')`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'paetest%')`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'paetest%')`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);   // users 보다 먼저(accounts.created_by FK)
  await query(`DELETE FROM users WHERE login_id LIKE 'paetest%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'paetest_dir');
  ID.fin = await mkUser(`${TAG}재무`, 'treasury', 'paetest_fin');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
               VALUES ($1,'transactions','anywhere','edit') ON CONFLICT DO NOTHING`, [ID.fin]);

  const mkAcc = async (name) => Number((await query(
    `INSERT INTO accounts (name, type, currency, open_balance, created_by)
     VALUES ($1,'bank','MXN',0,$2) RETURNING id`, [name, ID.dir])).rows[0].id);
  ID.bbva = await mkAcc(`${TAG}BBVA`);
  ID.caja = await mkAcc(`${TAG}금고`);
  ID.noop = await mkAcc(`${TAG}운영권한없음`);
  // 재무담당: BBVA·금고는 운영 가능, noop 은 열람만
  for (const a of [ID.bbva, ID.caja]) {
    await query(`INSERT INTO user_account_access (user_id, account_id, can_operate, can_detail)
                 VALUES ($1,$2,true,true) ON CONFLICT DO NOTHING`, [ID.fin, a]);
  }
  await query(`INSERT INTO user_account_access (user_id, account_id, can_operate, can_detail)
               VALUES ($1,$2,false,true) ON CONFLICT DO NOTHING`, [ID.fin, ID.noop]);

  // 고정비 규칙: BBVA 에서 매월 10,000
  ID.rule = Number((await query(
    `INSERT INTO recurring_rules (name, category_code, amount, direction, freq, currency, account_id,
                                  start_date, day_of_month, active, created_by)
     VALUES ($1,'6020',10000,'out','month','MXN',$2,'2026-01-15',15,true,$3) RETURNING id`,
    [`${TAG}임차료`, ID.bbva, ID.dir])).rows[0].id);

  const mkTxn = async (o) => Number((await query(
    `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn,
        category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date,
        recurring_rule_id, sales_invoice_id)
     VALUES ($1,$2,'out',$3,$4,$5,$6,$7,$8,'general',true,$9,$10,$9,$11,$12,$13,$14) RETURNING id`,
    [o.account_id === undefined ? ID.bbva : o.account_id, o.date, o.amount, o.cur || 'MXN', o.fx || 1,
      o.amount * (o.fx || 1), o.cat || '6020', o.status || 'plan', ID.dir, o.memo,
      o.status === 'actual' ? null : o.amount, o.status === 'actual' ? null : o.date,
      o.rule || null, o.inv || null])).rows[0].id);

  ID.fx1 = await mkTxn({ date: '2026-09-15', amount: 10000, memo: `[고정비] ${TAG}임차료`, rule: ID.rule });
  ID.fx2 = await mkTxn({ date: '2026-10-15', amount: 10000, memo: `[고정비] ${TAG}임차료`, rule: ID.rule });
  ID.mkt = await mkTxn({ account_id: null, date: '2026-09-20', amount: 3000, cat: '6070',
    memo: `[마케팅] ${TAG}전시회 · 일시불` });
  ID.usd = await mkTxn({ date: '2026-09-25', amount: 500, cur: 'USD', fx: 18, memo: `${TAG} USD 예정` });
  ID.act = await mkTxn({ date: '2026-08-10', amount: 777, status: 'actual', memo: `${TAG} 실적` });

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(financeRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.fin = app.jwt.sign({ sub: ID.fin });
}

const planEdit = (who, id, body) => app.inject({ method: 'PATCH', url: `/api/transactions/${id}/plan`,
  body, headers: { authorization: 'Bearer ' + tok[who] } });
const ruleSave = (who, id, body) => app.inject({ method: 'PATCH', url: `/api/recurring/${id}`,
  body, headers: { authorization: 'Bearer ' + tok[who] } });
const row = async (id) => (await query(
  `SELECT account_id, amount, plan_amount, amount_mxn, category_code, plan_account_manual, change_count, plan_memo,
          to_char(plan_date,'YYYY-MM-DD') AS plan_date, to_char(txn_date,'YYYY-MM-DD') AS txn_date, fx_rate
     FROM transactions WHERE id=$1`, [id])).rows[0];

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 예정의 출금 계좌를 BBVA → 금고 로 바꾼다', { skip: SKIP }, async () => {
  const before = await row(ID.fx1);
  assert.equal(Number(before.account_id), ID.bbva);
  const res = await planEdit('dir', ID.fx1, { plan_date: '2026-09-15', amount: 10000, account_id: ID.caja, memo: '금고에서 지급' });
  assert.equal(res.statusCode, 200);
  const d = res.json();
  assert.equal(d.account_changed, true);
  assert.equal(d.account_id, ID.caja);
  assert.equal(d.changed, true, '계좌만 바뀌어도 변경으로 집계');

  const after = await row(ID.fx1);
  assert.equal(Number(after.account_id), ID.caja);
  assert.equal(after.plan_account_manual, true, '개별 지정 표식');
  assert.equal(Number(after.change_count), Number(before.change_count) + 1);
  assert.match(String(after.plan_memo), /금고에서 지급/);
  assert.equal(Number(after.amount), 10000, '금액은 그대로');
});

test('② ★ 고정비 규칙을 다시 저장해도 그 회차의 계좌는 보존된다(금액·계정과목은 규칙을 따름)', { skip: SKIP }, async () => {
  const res = await ruleSave('dir', ID.rule, { amount: 12000, category_code: '6030' });
  assert.equal(res.statusCode, 200);
  const fx1 = await row(ID.fx1);
  const fx2 = await row(ID.fx2);
  assert.equal(Number(fx1.account_id), ID.caja, '예외 지정한 회차의 계좌는 유지');
  assert.equal(Number(fx1.amount), 12000, '금액은 규칙을 따라 갱신');
  assert.equal(fx1.category_code, '6030', '계정과목도 규칙을 따라 갱신');
  assert.equal(Number(fx2.account_id), ID.bbva, '손대지 않은 회차는 규칙 계좌 그대로');
  assert.equal(Number(fx2.amount), 12000);
});

test('③ 규칙의 계좌를 바꾸면 예외 회차만 빼고 동기화된다', { skip: SKIP }, async () => {
  await ruleSave('dir', ID.rule, { account_id: ID.noop });
  assert.equal(Number((await row(ID.fx2)).account_id), ID.noop, '일반 회차는 규칙 계좌로 동기화');
  assert.equal(Number((await row(ID.fx1)).account_id), ID.caja, '예외 회차는 그대로');
  await ruleSave('dir', ID.rule, { account_id: ID.bbva }); // 원복
});

test('④ 계좌 미지정(마케팅 계획)에 계좌를 붙일 수 있다', { skip: SKIP }, async () => {
  assert.equal((await row(ID.mkt)).account_id, null);
  const d = (await planEdit('dir', ID.mkt, { plan_date: '2026-09-20', amount: 3000, account_id: ID.bbva })).json();
  assert.equal(d.account_changed, true);
  assert.equal(Number((await row(ID.mkt)).account_id), ID.bbva);
});

test('⑤ (미지정)으로 되돌릴 수 있다 — account_id: null', { skip: SKIP }, async () => {
  const d = (await planEdit('dir', ID.mkt, { plan_date: '2026-09-20', amount: 3000, account_id: null })).json();
  assert.equal(d.account_changed, true);
  assert.equal(d.account_id, null);
  assert.equal((await row(ID.mkt)).account_id, null);
});

test('⑥ account_id 를 안 보내면 기존 계좌 유지 — 구프런트 하위호환', { skip: SKIP }, async () => {
  await planEdit('dir', ID.mkt, { plan_date: '2026-09-20', amount: 3000, account_id: ID.caja });
  const d = (await planEdit('dir', ID.mkt, { plan_date: '2026-09-21', amount: 3200 })).json();
  assert.equal(d.account_changed, false);
  const r = await row(ID.mkt);
  assert.equal(Number(r.account_id), ID.caja, '계좌 불변');
  assert.equal(Number(r.amount), 3200, '금액·날짜는 반영');
  assert.equal(r.plan_date, '2026-09-21');
});

test('⑦ 같은 계좌로 다시 저장하면 account_changed=false (멱등)', { skip: SKIP }, async () => {
  const d = (await planEdit('dir', ID.mkt, { plan_date: '2026-09-21', amount: 3200, account_id: ID.caja })).json();
  assert.equal(d.account_changed, false);
  assert.equal(d.changed, false, '아무것도 안 바뀌면 변경 아님');
});

test('⑧ 존재하지 않는 계좌 → 400 bad_account_id, 데이터 불변', { skip: SKIP }, async () => {
  const before = await row(ID.fx2);
  const res = await planEdit('dir', ID.fx2, { plan_date: '2026-10-15', amount: 12000, account_id: 99999999 });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'bad_account_id');
  assert.deepEqual(await row(ID.fx2), before);
});

test('⑨ 운영권한 없는 계좌로 옮기려 하면 403 account_not_operable', { skip: SKIP }, async () => {
  const before = await row(ID.fx2);
  const res = await planEdit('fin', ID.fx2, { plan_date: '2026-10-15', amount: 12000, account_id: ID.noop });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'account_not_operable');
  assert.deepEqual(await row(ID.fx2), before, '거부 시 아무것도 안 바뀐다');
  // 권한 있는 계좌로는 재무담당도 바꿀 수 있다
  const ok = await planEdit('fin', ID.fx2, { plan_date: '2026-10-15', amount: 12000, account_id: ID.caja });
  assert.equal(ok.statusCode, 200);
  assert.equal(Number((await row(ID.fx2)).account_id), ID.caja);
});

test('⑩ 실적(actual)은 이 경로로 계좌를 못 바꾼다 — 409 not_plan', { skip: SKIP }, async () => {
  const before = await row(ID.act);
  const res = await planEdit('dir', ID.act, { amount: 777, account_id: ID.caja });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'not_plan');
  assert.deepEqual(await row(ID.act), before);
});

test('⑪ USD 예정: 계좌만 바꿔도 환율·환산액이 망가지지 않는다', { skip: SKIP }, async () => {
  const d = (await planEdit('dir', ID.usd, { plan_date: '2026-09-25', amount: 500, fx_rate: 18, account_id: ID.caja })).json();
  assert.equal(d.account_changed, true);
  const r = await row(ID.usd);
  assert.equal(Number(r.fx_rate), 18);
  assert.equal(Number(r.amount_mxn), 9000);
  assert.equal(Number(r.account_id), ID.caja);
});

test('⑫ 현금흐름 은행계좌별 집계가 새 계좌로 옮겨간다', { skip: SKIP }, async () => {
  const sum = async (accId) => {
    const r = (await app.inject({ method: 'GET',
      url: `/api/cashflow?granularity=month&includePlan=1&proj=0&accounts=${accId}`,
      headers: { authorization: 'Bearer ' + tok.dir } })).json();
    return (r.rows || []).reduce((s, x) => s + Number(x.outflow || 0), 0);
  };
  const before = { bbva: await sum(ID.bbva), caja: await sum(ID.caja) };
  // fx2(12,000)를 금고 → BBVA 로 되돌린다
  await planEdit('dir', ID.fx2, { plan_date: '2026-10-15', amount: 12000, account_id: ID.bbva });
  const after = { bbva: await sum(ID.bbva), caja: await sum(ID.caja) };
  assert.equal(Math.round(after.bbva - before.bbva), 12000, 'BBVA 유출 +12,000');
  assert.equal(Math.round(before.caja - after.caja), 12000, '금고 유출 −12,000');
});

test('⑬ 감사로그에 계좌 변경 전/후가 남는다', { skip: SKIP }, async () => {
  const n = (await query(
    `SELECT COUNT(*)::int AS n FROM audit_log
      WHERE target=$1 AND action='update' AND detail::text LIKE '%account_changed%'`, [`transaction:${ID.fx1}`])).rows[0];
  assert.ok(Number(n.n) >= 1);
});
