// =====================================================================
// 커미션 · 성과급(Bono) 종단 검증 — 실 PostgreSQL (0001~0190 전체 적용)
//   · 수금목표 자동산출(만기도래 + 연체이월) · 달성률 · 구간 성과급
//   · 권한(영업사원=본인만) · 월 확정 스냅샷(동결) · 지급 전표가 성과급까지 반제
//   실행: TEST_PG_URL=postgres://... node --test test/commission_bonus_e2e.test.mjs
//   TEST_PG_URL 없으면 skip.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, commissionRoutes, Fastify, jwt, app;
const tok = {};
const ID = {};
const TAG = 'BONOTEST';
const TODAY = '2026-08-28';

async function boot() {
  ({ query } = await import('../src/db.js'));
  commissionRoutes = (await import('../src/routes/commissionRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  // 정리 (역순)
  await query(`DELETE FROM bonus_payouts WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'bonotest%')`);
  await query(`DELETE FROM bonus_tiers   WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'bonotest%')`);
  await query(`DELETE FROM bonus_targets WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'bonotest%')`);
  await query(`DELETE FROM bonus_plans   WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'bonotest%')`);
  await query(`DELETE FROM commission_payment_allocations WHERE payment_id IN (SELECT id FROM commission_payments WHERE agent_id IN (SELECT id FROM users WHERE login_id LIKE 'bonotest%'))`);
  await query(`DELETE FROM commission_payouts WHERE agent_id IN (SELECT id FROM users WHERE login_id LIKE 'bonotest%')`);
  await query(`DELETE FROM commission_payments WHERE agent_id IN (SELECT id FROM users WHERE login_id LIKE 'bonotest%')`);
  await query(`DELETE FROM commission_agent_periods WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'bonotest%')`);
  await query(`DELETE FROM commission_agents WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'bonotest%')`);
  await query(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo LIKE '%${TAG}%')`);
  await query(`DELETE FROM sales_payments WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM sales_invoice_lines WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo LIKE '%${TAG}%')`);
  await query(`DELETE FROM sales_invoices WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM commission_batches WHERE settle_ym IN ('2026-07','2026-08')`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'bonotest%')`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'bonotest%')`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM users WHERE login_id LIKE 'bonotest%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'bonotest_dir');
  ID.rep = await mkUser(`${TAG}영업`, 'sales', 'bonotest_rep');
  ID.rep2 = await mkUser(`${TAG}영업2`, 'sales', 'bonotest_rep2');
  ID.fin = await mkUser(`${TAG}재무`, 'treasury', 'bonotest_fin');
  for (const u of [ID.rep, ID.rep2, ID.fin]) {
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
                 VALUES ($1,'commission','anywhere',$2) ON CONFLICT DO NOTHING`, [u, u === ID.fin ? 'edit' : 'view']);
  }

  ID.acc = Number((await query(
    `INSERT INTO accounts (name, type, currency, open_balance, created_by) VALUES ($1,'bank','MXN',0,$2) RETURNING id`,
    [`${TAG}은행`, ID.dir])).rows[0].id);

  // 고객: 외상 30일
  ID.cust = Number((await query(
    `INSERT INTO customers (name, code, credit_days, created_by) VALUES ($1,$2,30,$3) RETURNING id`,
    [`${TAG}고객A`, `${TAG}-1`, ID.dir])).rows[0].id);

  // 커미션 대상 + 기간(2026-01-01~ 수금 4%)
  await query(`INSERT INTO commission_agents (user_id, default_rate, active, created_by, updated_by) VALUES ($1,4,true,$2,$2)`, [ID.rep, ID.dir]);
  await query(`INSERT INTO commission_agent_periods (user_id, start_date, end_date, basis, rate, created_by, updated_by)
               VALUES ($1,'2026-01-01',NULL,'collection',4,$2,$2)`, [ID.rep, ID.dir]);

  // 인보이스 2건 (ex-IVA 100,000 / 50,000 · IVA 16%)
  const mkInv = async (o) => Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,$3,30,$4,$5,$6,$7,'posted',$8,$9,$10) RETURNING id`,
    [o.sat, ID.cust, o.date, o.due, o.sub, o.sub * 0.16, o.sub * 1.16, ID.rep, `${TAG} ${o.sat}`, ID.dir])).rows[0].id);
  ID.inv1 = await mkInv({ sat: `${TAG}-F1`, date: '2026-06-10', due: '2026-07-10', sub: 100000 });
  ID.inv2 = await mkInv({ sat: `${TAG}-F2`, date: '2026-07-20', due: '2026-08-19', sub: 50000 });

  // 수금: inv1 은 7/09 전액(116,000) 완납 / inv2 는 미수(연체)
  const pay = Number((await query(
    `INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, memo, created_by)
     VALUES ($1,'2026-07-09',$2,116000,$3,$4) RETURNING id`, [ID.cust, ID.acc, `${TAG} 수금`, ID.dir])).rows[0].id);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,116000)`, [pay, ID.inv1]);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(commissionRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.rep = app.jwt.sign({ sub: ID.rep });
  tok.rep2 = app.jwt.sign({ sub: ID.rep2 });
  tok.fin = app.jwt.sign({ sub: ID.fin });
}

const get = (who, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[who] } });
const post = (who, url, body) => app.inject({ method: 'POST', url, payload: body, headers: { authorization: 'Bearer ' + tok[who] } });

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 성과급 정책 저장 — 디렉터만', { skip: SKIP }, async () => {
  const body = {
    enabled: true, basis: 'collection', start_month: '2026-06', end_month: '2026-12',
    include_overdue: true, partial_credit: true,
    tiers: [{ min_rate: 80, amount: 2000 }, { min_rate: 100, amount: 5000 }, { min_rate: 120, amount: 10000 }],
    targets: {},
  };
  assert.equal((await post('rep', `/api/commission/bonus/plans/${ID.rep}`, body)).statusCode, 403, '영업사원은 저장 불가');
  const r = await post('dir', `/api/commission/bonus/plans/${ID.rep}`, body);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().plan.basis, 'collection');

  // 잘못된 정책은 400
  const bad = await post('dir', `/api/commission/bonus/plans/${ID.rep}`, { ...body, tiers: [] });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'no_tiers');
});

test('② 수금목표 자동산출 — 7월=만기도래 100,000 / 8월=만기 50,000 + 연체이월 50,000', { skip: SKIP }, async () => {
  const r = await get('dir', `/api/commission/performance?agent_id=${ID.rep}&from=2026-06&to=2026-08&today=${TODAY}`);
  assert.equal(r.statusCode, 200);
  const by = Object.fromEntries(r.json().months.map((m) => [m.month, m]));
  assert.equal(by['2026-07'].collection.due, 100000);
  assert.equal(by['2026-07'].collection.target, 100000);
  assert.equal(by['2026-07'].collection.actual, 100000);      // 완납 → ex-IVA 100,000
  assert.equal(by['2026-07'].collection.rate, 100);
  assert.equal(by['2026-08'].collection.due, 50000);
  assert.equal(by['2026-08'].collection.carry, 0);            // inv1 은 7월에 완납되어 이월 없음
  assert.equal(by['2026-08'].collection.target, 50000);
  assert.equal(by['2026-08'].collection.actual, 0);
});

test('③ 커미션은 완납월(7월)에 인식 · 성과급은 100% 구간 5,000', { skip: SKIP }, async () => {
  const r = await get('dir', `/api/commission/performance?agent_id=${ID.rep}&from=2026-07&to=2026-07&today=${TODAY}`);
  const m = r.json().months[0];
  assert.equal(m.commission, 4000);         // 100,000 × 4%
  assert.equal(m.bonus.amount, 5000);
  assert.equal(m.bonus.tier, 100);
  assert.equal(m.total, 9000);
});

test('④ 진척(progress) — 이번 달 매출·수금 목표 대비 + 다음 구간 안내', { skip: SKIP }, async () => {
  const r = await get('dir', `/api/commission/progress?agent_id=${ID.rep}&ym=2026-08&today=${TODAY}`);
  const d = r.json();
  assert.equal(d.collection.target, 50000);
  assert.equal(d.collection.actual, 0);
  assert.equal(d.bonus.in_plan, true);
  assert.equal(d.bonus.amount, 0);                       // 0% → 미달
  assert.equal(d.bonus.next_tier.min_rate, 80);
  assert.equal(d.bonus.next_tier.need, 40000);           // 50,000 × 80%
  assert.ok(d.elapsed > 85 && d.elapsed < 95, '8/28 → 경과율 약 90%');
});

test('⑤ 권한 — 영업사원은 남의 실적을 볼 수 없고 본인 것만 나온다', { skip: SKIP }, async () => {
  const mine = await get('rep', `/api/commission/progress?agent_id=${ID.rep}&today=${TODAY}`);
  assert.equal(mine.json().agent_id, ID.rep);
  // 남의 id 를 넣어도 무시하고 본인으로 강제
  const other = await get('rep2', `/api/commission/progress?agent_id=${ID.rep}&today=${TODAY}`);
  assert.equal(other.json().agent_id, ID.rep2);
  const perf = await get('rep2', `/api/commission/performance?agent_id=${ID.rep}&from=2026-06&to=2026-08&today=${TODAY}`);
  assert.equal(perf.json().agent_id, ID.rep2);
  assert.equal(perf.json().totals.revenue, 0);           // rep2 는 매출 없음
  // 정책 목록은 전체열람자 전용
  assert.equal((await get('rep', '/api/commission/bonus/plans')).statusCode, 403);
  assert.equal((await get('fin', '/api/commission/bonus/plans')).statusCode, 200);
});

test('⑥ 월 확정 → 성과급 스냅샷 동결 · 정책을 바꿔도 확정액은 불변', { skip: SKIP }, async () => {
  const c = await post('dir', '/api/commission/batches/2026-07/confirm', {});
  assert.equal(c.statusCode, 200);
  assert.equal(c.json().bonus_snapshots, 1);

  const snap = (await query(`SELECT amount, target_amount, actual_amount, achieved_rate FROM bonus_payouts WHERE user_id=$1 AND settle_ym='2026-07'`, [ID.rep])).rows[0];
  assert.equal(Number(snap.amount), 5000);
  assert.equal(Number(snap.target_amount), 100000);
  assert.equal(Number(snap.achieved_rate), 100);

  // 구간을 올려 잡아도(=계산상 0이 되어도) 확정된 달의 금액은 스냅샷 그대로
  await post('dir', `/api/commission/bonus/plans/${ID.rep}`, {
    enabled: true, basis: 'collection', start_month: '2026-06', end_month: '2026-12',
    include_overdue: true, partial_credit: true,
    tiers: [{ min_rate: 300, amount: 99 }], targets: {},
  });
  const r = await get('dir', `/api/commission/performance?agent_id=${ID.rep}&from=2026-07&to=2026-07&today=${TODAY}`);
  const m = r.json().months[0];
  assert.equal(m.bonus.amount, 5000, '확정 성과급은 동결');
  assert.equal(m.bonus.confirmed, true);

  // 원래 구간으로 복원
  await post('dir', `/api/commission/bonus/plans/${ID.rep}`, {
    enabled: true, basis: 'collection', start_month: '2026-06', end_month: '2026-12',
    include_overdue: true, partial_credit: true,
    tiers: [{ min_rate: 80, amount: 2000 }, { min_rate: 100, amount: 5000 }, { min_rate: 120, amount: 10000 }], targets: {},
  });
});

test('⑦ 지급 대상에 성과급이 포함된다 (커미션 4,000 + 성과급 5,000)', { skip: SKIP }, async () => {
  const r = await get('fin', `/api/commission/payable?agent_id=${ID.rep}&settle_ym=2026-07`);
  const d = r.json();
  assert.equal(d.commission_total, 4000);
  assert.equal(d.bonus.amount, 5000);
  assert.equal(d.total, 9000);
});

test('⑧ 지급 전표 1건이 커미션 + 성과급을 함께 반제한다', { skip: SKIP }, async () => {
  const evidence = 'data:image/png;base64,iVBORw0KGgo=';
  const r = await post('fin', '/api/commission/payments', {
    agent_id: ID.rep, settle_ym: '2026-07', amount: 9000, paid_date: '2026-08-15',
    note: `${TAG} 7월분`, evi_name: 'x.png', evidence,
  });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.commission_settled, 4000);
  assert.equal(d.bonus_settled, 5000);
  assert.equal(d.settled, 9000);
  assert.equal(d.leftover, 0);

  const b = (await query(`SELECT paid, to_char(paid_date,'YYYY-MM-DD') AS d, payment_id FROM bonus_payouts WHERE user_id=$1 AND settle_ym='2026-07'`, [ID.rep])).rows[0];
  assert.equal(b.paid, true);
  assert.equal(b.d, '2026-08-15');
  assert.equal(Number(b.payment_id), Number(d.payment_id));

  // 두 번째 지급 시도 → 남은 것이 없다
  const again = await get('fin', `/api/commission/payable?agent_id=${ID.rep}&settle_ym=2026-07`);
  assert.equal(again.json().total, 0);
  assert.equal(again.json().bonus, null);
});

test('⑨ 성과급 미사용 사원은 커미션만 (기존 동작 보존)', { skip: SKIP }, async () => {
  await post('dir', `/api/commission/bonus/plans/${ID.rep2}`, { enabled: false });
  const r = await get('dir', `/api/commission/progress?agent_id=${ID.rep2}&today=${TODAY}`);
  const d = r.json();
  assert.equal(d.bonus.enabled, false);
  assert.equal(d.bonus.amount, 0);
  assert.equal(d.total_expected, 0);
});

test('⑩ 기존 커미션 화면(overview)이 그대로 동작한다', { skip: SKIP }, async () => {
  const r = await get('dir', `/api/commission/overview?agent_id=${ID.rep}`);
  assert.equal(r.statusCode, 200);
  const s = r.json().summary;
  assert.equal(s.invoice_count, 2);
  assert.equal(s.total_confirmed, 4000);   // 7월 완납분만 확정
  assert.equal(s.total_paid, 4000);
});

test('cleanup', { skip: SKIP }, async () => { if (app) await app.close(); });
