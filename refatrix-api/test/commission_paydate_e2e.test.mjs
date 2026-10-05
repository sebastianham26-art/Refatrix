// =====================================================================
// 커미션 「수금일 판정」(0250) 종단 검증 — 실 PostgreSQL (0001~0250 전체 적용)
//   디렉터 결정(2026-10-05): 인보이스 발행기간은 상관없고 수금되는 기간이 중요하다.
//     · 기간(10/1~ · 수금 4% · 수금일 판정) 안에 들어온 수금액(ex-IVA) × 4% 가 적립된다.
//     · 그 인보이스가 미수 없이 완납되면 적립분이 지급 확정된다(완납월 = 반제 완료월).
//   + 성과급(매출목표 100%↑ 6,000 / 120%↑ 10,000 / 미달 0) · 상세 팝업용 목록(payments·collection_targets)
//   실행: TEST_PG_URL=postgres://... node --test test/commission_paydate_e2e.test.mjs
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
const TAG = 'PAYDTEST';
const TODAY = '2026-10-05';

async function boot() {
  ({ query } = await import('../src/db.js'));
  commissionRoutes = (await import('../src/routes/commissionRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  const U = `(SELECT id FROM users WHERE login_id LIKE 'paydtest%')`;
  await query(`DELETE FROM bonus_payouts WHERE user_id IN ${U} OR confirmed_by IN ${U} OR updated_by IN ${U}`);
  await query(`DELETE FROM bonus_tiers WHERE user_id IN ${U}`);
  await query(`DELETE FROM bonus_targets WHERE user_id IN ${U}`);
  await query(`DELETE FROM bonus_plans WHERE user_id IN ${U}`);
  await query(`DELETE FROM commission_payment_allocations WHERE payment_id IN (SELECT id FROM commission_payments WHERE agent_id IN ${U})`);
  await query(`DELETE FROM commission_payouts WHERE agent_id IN ${U}`);
  await query(`DELETE FROM commission_payments WHERE agent_id IN ${U}`);
  await query(`DELETE FROM commission_customer_rates WHERE user_id IN ${U}`);
  await query(`DELETE FROM commission_agent_periods WHERE user_id IN ${U}`);
  await query(`DELETE FROM commission_agents WHERE user_id IN ${U}`);
  await query(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo LIKE '%${TAG}%')`);
  await query(`DELETE FROM sales_payments WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM sales_invoices WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM commission_batches WHERE settle_ym IN ('2026-08','2026-09','2026-10','2026-11') OR confirmed_by IN ${U}`);
  await query(`DELETE FROM audit_log WHERE user_id IN ${U}`);
  await query(`DELETE FROM user_page_access WHERE user_id IN ${U}`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM users WHERE login_id LIKE 'paydtest%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'paydtest_dir');
  ID.rep = await mkUser(`${TAG}오스카`, 'sales', 'paydtest_rep');     // 수금일 판정 4% (10/1~)
  ID.rep2 = await mkUser(`${TAG}팔로미노`, 'sales', 'paydtest_rep2'); // 매출 3% (~10/31) → 수금일 판정 3% (11/1~)
  ID.rep3 = await mkUser(`${TAG}종전`, 'sales', 'paydtest_rep3');     // 발행일 판정(종전) 4% (10/1~)
  for (const u of [ID.rep, ID.rep2, ID.rep3]) {
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'commission','anywhere','view') ON CONFLICT DO NOTHING`, [u]);
  }
  ID.acc = Number((await query(
    `INSERT INTO accounts (name, type, currency, open_balance, created_by) VALUES ($1,'bank','MXN',0,$2) RETURNING id`,
    [`${TAG}은행`, ID.dir])).rows[0].id);
  const mkCust = async (n, owner) => Number((await query(
    `INSERT INTO customers (name, code, credit_days, owner_id, phone, created_by) VALUES ($1,$2,30,$3,'+52 81 1234 5678',$4) RETURNING id`,
    [`${TAG}${n}`, `${TAG}-${n}`, owner, ID.dir])).rows[0].id);
  ID.cA = await mkCust('고객A', ID.rep);
  ID.cB = await mkCust('고객B', ID.rep);
  ID.cP = await mkCust('고객P', ID.rep2);
  ID.cQ = await mkCust('고객Q', ID.rep3);

  for (const [u, rows] of [
    [ID.rep, [['2026-10-01', null, 'collection', 4, 'payment']]],
    [ID.rep2, [['2026-07-01', '2026-10-31', 'revenue', 3, 'invoice'], ['2026-11-01', null, 'collection', 3, 'payment']]],
    [ID.rep3, [['2026-10-01', null, 'collection', 4, 'invoice']]],
  ]) {
    await query(`INSERT INTO commission_agents (user_id, default_rate, active, created_by, updated_by) VALUES ($1,4,true,$2,$2)`, [u, ID.dir]);
    for (const r of rows) {
      await query(`INSERT INTO commission_agent_periods (user_id, start_date, end_date, basis, rate, match_on, created_by, updated_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, [u, r[0], r[1], r[2], r[3], r[4], ID.dir]);
    }
  }

  const mkInv = async (o) => Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,$3,30,$4,$5,$6,$7,'posted',$8,$9,$10) RETURNING id`,
    [o.sat, o.cust, o.date, o.due, o.sub, o.sub * 0.16, o.sub * 1.16, ID.dir, `${TAG} ${o.sat}`, ID.dir])).rows[0].id);
  const pay = async (cust, date, allocs) => {
    const amt = allocs.reduce((s, a) => s + a[1], 0);
    const p = Number((await query(
      `INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, memo, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [cust, date, ID.acc, amt, `${TAG} 수금 ${date}`, ID.dir])).rows[0].id);
    for (const [inv, a] of allocs) await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,$3)`, [p, inv, a]);
    return p;
  };

  // ── Oscar(rep) ──
  // A: 9/10 발행 10,000 · 9/20 에 절반(5,800) · 10/03 나머지(5,800) → 10월 완납. 커미션 = 5,000 × 4% = 200 (9월 수금분은 기간 전)
  ID.A = await mkInv({ sat: 'PDT-A', cust: ID.cA, date: '2026-09-10', due: '2026-10-10', sub: 10000 });
  // B: 9/15 발행 10,000 · 10/04 에 3,480 부분수금 → 적립 3,000 × 4% = 120 (완납 대기) · 남은 7,000 걷으면 +280
  ID.B = await mkInv({ sat: 'PDT-B', cust: ID.cB, date: '2026-09-15', due: '2026-09-25', sub: 10000 });
  // C: 10/02 발행 2,000 · 10/04 완납 → 80
  ID.C = await mkInv({ sat: 'PDT-C', cust: ID.cA, date: '2026-10-02', due: '2026-11-01', sub: 2000 });
  // D: 8/01 발행 · 8/20 완납 → 기간 전 수금 → 커미션 대상 아님(목록에서 빠짐)
  ID.D = await mkInv({ sat: 'PDT-D', cust: ID.cA, date: '2026-08-01', due: '2026-08-31', sub: 5000 });
  // E: 10/03 발행 · 미수 → 걷으면 3,000 × 4% = 120
  ID.E = await mkInv({ sat: 'PDT-E', cust: ID.cB, date: '2026-10-03', due: '2026-11-02', sub: 3000 });
  await pay(ID.cA, '2026-08-20', [[ID.D, 5800]]);
  await pay(ID.cA, '2026-09-20', [[ID.A, 5800]]);
  await pay(ID.cA, '2026-10-03', [[ID.A, 5800]]);
  await pay(ID.cB, '2026-10-04', [[ID.B, 3480]]);
  await pay(ID.cA, '2026-10-04', [[ID.C, 2320]]);

  // ── 팔로미노(rep2) — 10/15 발행(매출 기간) 11/05 수금 → 매출 커미션 300 만, 수금 커미션 중복 없음
  ID.P = await mkInv({ sat: 'PDT-P', cust: ID.cP, date: '2026-10-15', due: '2026-11-14', sub: 10000 });
  // P2: 6/20 발행(어떤 기간에도 속하지 않음) 11/05 수금 → 수금일 판정 3% = 150
  ID.P2 = await mkInv({ sat: 'PDT-P2', cust: ID.cP, date: '2026-06-20', due: '2026-07-20', sub: 5000 });
  await pay(ID.cP, '2026-11-05', [[ID.P, 11600], [ID.P2, 5800]]);

  // ── 종전(rep3) — 9/10 발행 10/03 완납 → 발행일 판정이라 커미션 없음(종전 동작 보존)
  ID.Q = await mkInv({ sat: 'PDT-Q', cust: ID.cQ, date: '2026-09-10', due: '2026-10-10', sub: 10000 });
  await pay(ID.cQ, '2026-10-03', [[ID.Q, 11600]]);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(commissionRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.rep = app.jwt.sign({ sub: ID.rep });
  tok.rep3 = app.jwt.sign({ sub: ID.rep3 });
}

const get = (who, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[who] } });
const post = (who, url, body) => app.inject({ method: 'POST', url, payload: body, headers: { authorization: 'Bearer ' + tok[who] } });
const lineOf = (d, inv) => d.groups.flatMap((g) => g.lines).find((l) => Number(l.invoice_id) === Number(inv));

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 커미션 내역 — 기간 전 발행분도 기간 안 수금분만큼 적립 · 완납 시 확정', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.rep}`)).json();
  const A = lineOf(d, ID.A), B = lineOf(d, ID.B), C = lineOf(d, ID.C), D = lineOf(d, ID.D), E = lineOf(d, ID.E);
  assert.equal(A.mode, 'payment');
  assert.equal(A.confirmed, 200, 'A: 10월 수금 5,800 → ex-IVA 5,000 × 4%');
  assert.equal(A.recognized, true);
  assert.equal(A.settle_ym, '2026-10');
  assert.equal(A.collected_base, 5000);
  assert.equal(B.recognized, false, 'B: 잔액 남음 → 지급 확정 아님');
  assert.equal(B.accrued, 120);
  assert.equal(B.potential, 280);
  assert.equal(B.expected, 400);
  assert.equal(C.confirmed, 80);
  assert.equal(E.accrued, 0);
  assert.equal(E.expected, 120, 'E: 미수 3,000 × 4%');
  assert.equal(D, undefined, 'D: 기간 전 완납 → 목록에서 빠짐');
  assert.equal(d.summary.total_confirmed, 280);
});

test('② 지급 대상(10월 반제 완료월) = 완납된 A 200 + C 80', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/commission/payable?agent_id=${ID.rep}&settle_ym=2026-10`)).json();
  assert.equal(d.commission_total, 280);
  assert.deepEqual(d.lines.map((l) => l.sat_no).sort(), ['PDT-A', 'PDT-C']);
  const b = (await get('dir', '/api/commission/batches')).json();
  const oct = b.items.find((x) => x.settle_ym === '2026-10');
  assert.ok(oct && oct.confirmed >= 280);
});

test('③ 실적 — 10월 적립 400(200+120+80) · 지급확정 280 · 완납대기 120', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/commission/performance?agent_id=${ID.rep}&from=2026-10&to=2026-10&today=${TODAY}`)).json();
  const m = d.months[0];
  assert.equal(m.commission, 280);
  assert.equal(m.commission_accrued, 400);
  assert.equal(d.totals.commission_pending, 120);
  assert.equal(d.totals.commission_pending_potential, 280);
  assert.equal(d.totals.commission_pending_open, 8120);
  // 수금 내역(팝업) — 10월 수금 3건, 9월 분은 없음
  assert.equal(d.payments.length, 3);
  const pB = d.payments.find((p) => Number(p.invoice_id) === ID.B);
  assert.equal(pB.amount, 3000);
  assert.equal(pB.commission_accrued, 120);
  assert.equal(pB.invoice_fully_paid, false);
  assert.equal(pB.invoice_open_total, 8120);
  assert.equal(pB.phone, '+52 81 1234 5678');
  const pA = d.payments.find((p) => Number(p.invoice_id) === ID.A);
  assert.equal(pA.closes_invoice, true);
  // 수금(현금) 실적 = 5,000 + 3,000 + 2,000
  assert.equal(m.collection.actual, 10000);
  assert.equal(d.totals.collection_cash, 10000);
});

test('④ 상세 팝업용 — 미수·연체 인보이스, 수금목표 구성', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/commission/performance?agent_id=${ID.rep}&from=2026-10&to=2026-10&today=${TODAY}`)).json();
  const iB = d.invoices.find((i) => Number(i.invoice_id) === ID.B);
  assert.ok(iB, '9월 발행이라도 미수가 남으면 목록에 나온다');
  assert.equal(iB.late, true);
  assert.equal(iB.due_gap, 10);
  assert.equal(iB.open_total, 8120);
  assert.equal(iB.commission_total_accrued, 120);
  assert.equal(iB.commission_potential, 280);
  assert.equal(d.totals.late, 7000);
  // 10월 수금목표 = 만기도래(A 10,000) + 연체이월(B 10,000) — C·E 는 11월 만기
  const t = d.collection_targets.filter((x) => x.month === '2026-10');
  const kinds = Object.fromEntries(t.map((x) => [x.sat_no, x.kind]));
  assert.deepEqual(kinds, { 'PDT-A': 'due', 'PDT-B': 'carry' });
  assert.equal(d.months[0].collection.target, t.reduce((s, x) => s + x.target_amount, 0));
  const tB = t.find((x) => x.sat_no === 'PDT-B');
  assert.equal(tB.collected, 3000);
  assert.equal(tB.open_total, 8120);
});

test('⑤ 진척(progress) — 적립/확정/완납대기', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/commission/progress?agent_id=${ID.rep}&ym=2026-10&today=${TODAY}`)).json();
  assert.equal(d.commission.amount, 280);
  assert.equal(d.commission.accrued, 400);
  assert.equal(d.commission.pending, 120);
  assert.equal(d.commission.match_on, 'payment');
});

test('⑥ 매출 기간 발행분은 매출 커미션만 — 수금 커미션 중복 없음 / 기간 밖 발행분은 수금일 판정', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.rep2}`)).json();
  const P = lineOf(d, ID.P), P2 = lineOf(d, ID.P2);
  assert.equal(P.basis, 'revenue');
  assert.equal(P.confirmed, 300);
  assert.equal(P.settle_ym, '2026-10');
  assert.equal(P2.mode, 'payment');
  assert.equal(P2.confirmed, 150);
  assert.equal(P2.settle_ym, '2026-11');
  const perf = (await get('dir', `/api/commission/performance?agent_id=${ID.rep2}&from=2026-10&to=2026-11&today=2026-11-10`)).json();
  const by = Object.fromEntries(perf.months.map((m) => [m.month, m]));
  assert.equal(by['2026-10'].commission, 300);
  assert.equal(by['2026-11'].commission, 150);
  assert.equal(by['2026-11'].commission_accrued, 150, '11월 수금 중 P(매출 기간) 분은 적립하지 않는다');
});

test('⑦ 발행일 판정(종전) 사원은 그대로 — 기간 전 발행분은 커미션 없음', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.rep3}`)).json();
  assert.equal(lineOf(d, ID.Q), undefined);
  assert.equal(d.summary.total_confirmed, 0);
});

test('⑧ 기간 설정 — match_on 저장·조회 · 매출 기준에는 적용 안 됨', { skip: SKIP }, async () => {
  const r = await post('dir', `/api/commission/agents/${ID.rep3}/periods`, {
    active: true, periods: [{ start_date: '2026-10-01', end_date: null, basis: 'collection', rate: 4, match_on: 'payment' }],
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().periods[0].match_on, 'payment');
  const a = (await get('dir', '/api/commission/agents')).json();
  assert.equal(a.match_on_ready, true);
  assert.equal(a.items.find((x) => Number(x.user_id) === ID.rep3).periods[0].match_on, 'payment');
  // 이제 Q(9/10 발행, 10/03 완납) 도 대상
  const d = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.rep3}`)).json();
  assert.equal(lineOf(d, ID.Q).confirmed, 400);
  // 매출 기준에 payment 를 넣어도 invoice 로 저장
  const r2 = await post('dir', `/api/commission/agents/${ID.rep3}/periods`, {
    active: true, periods: [{ start_date: '2026-10-01', end_date: null, basis: 'revenue', rate: 4, match_on: 'payment' }],
  });
  assert.equal(r2.json().periods[0].match_on, 'invoice');
  // 영업사원 본인 조건에도 노출
  const my = (await get('rep', '/api/commission/my-periods')).json();
  assert.equal(my.periods[0].match_on, 'payment');
});

test('⑨ 성과급 — 매출목표 100%↑ 6,000 / 120%↑ 10,000 / 미달 0', { skip: SKIP }, async () => {
  const plan = (targets) => ({
    enabled: true, basis: 'revenue', start_month: '2026-10', end_month: '2026-10', include_overdue: true, partial_credit: false,
    tiers: [{ min_rate: 0, amount: 0 }, { min_rate: 100, amount: 6000 }, { min_rate: 120, amount: 10000 }], targets,
  });
  const run = async (t) => {
    assert.equal((await post('dir', `/api/commission/bonus/plans/${ID.rep}`, plan({ '2026-10': t }))).statusCode, 200);
    return (await get('dir', `/api/commission/performance?agent_id=${ID.rep}&from=2026-10&to=2026-10&today=${TODAY}`)).json().months[0].bonus;
  };
  // 10월 매출 = C 2,000 + E 3,000 = 5,000
  assert.equal((await run(5001)).amount, 0, '99.98% → 미달');
  assert.equal((await run(5000)).amount, 6000, '100%');
  assert.equal((await run(4200)).amount, 6000, '119%');
  const b = await run(4166.67);
  assert.equal(b.amount, 10000, '120% 이상');
  const b2 = await run(10000);
  assert.equal(b2.next_tier.min_rate, 100);
  assert.equal(b2.next_tier.need, 5000);
});

test('⑩ 지급 → 동결 · 영업사원은 본인 것만', { skip: SKIP }, async () => {
  await post('dir', '/api/commission/batches/2026-10/confirm', {});
  const ev = 'data:image/png;base64,iVBORw0KGgo=';
  const r = await post('dir', '/api/commission/payments', { agent_id: ID.rep, settle_ym: '2026-10', amount: 280, evidence: ev, paid_date: '2026-11-15' });
  assert.equal(r.statusCode, 200, JSON.stringify(r.json()));
  assert.equal(r.json().commission_settled, 280);
  // 기준 순매출(base_mxn)은 인보이스 순매출 — 지급 후 조정 차액이 잘못 생기지 않는다
  const adj = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.rep}`)).json();
  assert.equal(adj.adjustments.length, 0);
  assert.equal(lineOf(adj, ID.A).paid, true);
  const mine = (await get('rep', `/api/commission/performance?agent_id=${ID.rep3}&from=2026-10&to=2026-10&today=${TODAY}`)).json();
  assert.equal(mine.agent_id, ID.rep);
});

test('teardown', { skip: SKIP }, async () => {
  await app.close();
  const { pool } = await import('../src/db.js');
  await pool.end();
});
