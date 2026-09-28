// =====================================================================
// 커미션 수혜자 = 고객마스터 담당자 — 종단 검증 (실 PostgreSQL)  2026-09-28
//   배경: 매출은 영업지원(Maria)이 등록 → sales_invoices.owner_id = 등록자.
//         커미션이 owner_id 로 귀속되어 palomino·Armando 실적이 통째로 빠졌다.
//   규칙: ① 수혜자 = customers.owner_id  ② 이미 지급된 라인은 지급받은 사람으로 동결
//         ③ 고객 담당자 없음 / 커미션 대상 아님 → 제외
//   실행: TEST_PG_URL=postgres://... node --test test/commission_customer_owner_e2e.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app;
const tok = {};
const ID = {};
const TAG = 'OWNTEST';
const YM = '2026-09';
const EVI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function cleanup() {
  const U = `SELECT id FROM users WHERE login_id LIKE 'owntest%'`;
  await query(`DELETE FROM commission_payment_allocations WHERE payment_id IN (SELECT id FROM commission_payments WHERE agent_id IN (${U}))`);
  await query(`DELETE FROM commission_payouts WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo LIKE '${TAG}%')`);
  await query(`DELETE FROM commission_payments WHERE agent_id IN (${U})`);
  await query(`DELETE FROM commission_agent_periods WHERE user_id IN (${U})`);
  await query(`DELETE FROM commission_agents WHERE user_id IN (${U})`);
  await query(`DELETE FROM sales_invoices WHERE memo LIKE '${TAG}%'`);
  await query(`DELETE FROM bonus_payouts WHERE confirmed_by IN (${U}) OR user_id IN (${U})`).catch(() => {});
  await query(`DELETE FROM commission_batches WHERE settle_ym='${YM}'`);
  await query(`DELETE FROM audit_log WHERE user_id IN (${U})`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (${U})`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM sales_teams WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM users WHERE login_id LIKE 'owntest%'`);
}

async function boot() {
  ({ query } = await import('../src/db.js'));
  const commissionRoutes = (await import('../src/routes/commissionRoutes.js')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'owntest_dir');
  ID.sup = await mkUser(`${TAG}영업지원`, 'sales_support', 'owntest_sup'); // 매출 등록자(커미션 대상 아님)
  ID.repA = await mkUser(`${TAG}영업A`, 'sales', 'owntest_repa');
  ID.repB = await mkUser(`${TAG}영업B`, 'sales', 'owntest_repb');
  for (const u of [ID.repA, ID.repB]) {
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
                 VALUES ($1,'commission','anywhere','view') ON CONFLICT DO NOTHING`, [u]);
  }
  for (const u of [ID.repA, ID.repB]) {
    await query(`INSERT INTO commission_agents (user_id, default_rate, active, created_by, updated_by) VALUES ($1,3,true,$2,$2)`, [u, ID.dir]);
    await query(`INSERT INTO commission_agent_periods (user_id, start_date, end_date, basis, rate, created_by, updated_by)
                 VALUES ($1,'2026-07-01',NULL,'revenue',3,$2,$2)`, [u, ID.dir]);
  }
  const mkCust = async (n, owner) => Number((await query(
    `INSERT INTO customers (name, code, credit_days, owner_id, created_by) VALUES ($1,$2,30,$3,$4) RETURNING id`,
    [`${TAG}${n}`, `${TAG}-${n}`, owner, ID.dir])).rows[0].id);
  ID.custA = await mkCust('A', ID.repA);
  ID.custB = await mkCust('B', ID.repB);
  ID.custN = await mkCust('N', null); // 담당자 없음

  // 모든 인보이스는 영업지원이 등록(owner_id = 영업지원) — 운영 실태 재현
  const mkInv = async (sat, cust, date, sub) => Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,$3,30,($3::date + 30),$4,$5,$6,'posted',$7,$8,$7) RETURNING id`,
    [`${TAG}-${sat}`, cust, date, sub, sub * 0.16, sub * 1.16, ID.sup, `${TAG} ${sat}`])).rows[0].id);
  ID.invA1 = await mkInv('A1', ID.custA, '2026-09-17', 10000); // 300
  ID.invA2 = await mkInv('A2', ID.custA, '2026-09-22', 5000);  // 150
  ID.invB1 = await mkInv('B1', ID.custB, '2026-09-23', 2000);  // 60
  ID.invN = await mkInv('N1', ID.custN, '2026-09-23', 1000);   // 담당자 없음 → 제외

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(commissionRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.repA = app.jwt.sign({ sub: ID.repA });
  tok.repB = app.jwt.sign({ sub: ID.repB });
}

const get = (who, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[who] } });
const post = (who, url, body) => app.inject({ method: 'POST', url, payload: body, headers: { authorization: 'Bearer ' + tok[who] } });
const invIds = (ov) => ov.groups.flatMap((g) => g.lines.map((l) => Number(l.invoice_id))).sort((a, b) => a - b);

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 영업지원이 등록한 매출도 고객마스터 담당자에게 귀속된다', { skip: SKIP }, async () => {
  const a = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.repA}`)).json();
  assert.deepEqual(invIds(a), [ID.invA1, ID.invA2].sort((x, y) => x - y));
  assert.equal(a.summary.total_confirmed, 450);
  assert.ok(a.groups[0].lines.every((l) => Number(l.agent_id) === ID.repA));
  const b = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.repB}`)).json();
  assert.deepEqual(invIds(b), [ID.invB1]);
  assert.equal(b.summary.total_confirmed, 60);
});

test('② 전체 요약(by_agent)에 등록자(영업지원)는 없고, 담당자 없는 고객 매출은 제외', { skip: SKIP }, async () => {
  const all = (await get('dir', `/api/commission/overview?view=all`)).json();
  const mine = all.by_agent.filter((x) => [ID.repA, ID.repB, ID.sup].includes(Number(x.agent_id)));
  const ids = mine.map((x) => Number(x.agent_id)).sort((x, y) => x - y);
  assert.deepEqual(ids, [ID.repA, ID.repB].sort((x, y) => x - y));
  const lines = all.groups.flatMap((g) => g.lines).map((l) => Number(l.invoice_id));
  assert.ok(!lines.includes(ID.invN), '담당자 없는 고객 인보이스가 섞였다');
});

test('③ 영업사원 로그인 = 본인 담당 고객 매출만', { skip: SKIP }, async () => {
  const a = (await get('repA', `/api/commission/overview?view=all&agent_id=${ID.repB}`)).json(); // 남의 id 넣어도 본인
  assert.deepEqual(invIds(a), [ID.invA1, ID.invA2].sort((x, y) => x - y));
});

test('④ 지급 대상(payable) · 월 확정 합계도 같은 기준', { skip: SKIP }, async () => {
  const p = (await get('dir', `/api/commission/payable?agent_id=${ID.repA}&settle_ym=${YM}`)).json();
  assert.equal(p.commission_total, 450);
  const bt = (await get('dir', `/api/commission/batches`)).json();
  const m = bt.items.find((x) => x.settle_ym === YM);
  assert.ok(m && m.confirmed >= 510, '9월 확정 합계에 담당자 기준 커미션이 빠졌다');
});

test('⑤ 지급(반제) 후 고객 담당을 이관해도 지급분은 원래 사람에게 동결, 미지급분만 새 담당자로', { skip: SKIP }, async () => {
  const cf = await post('dir', `/api/commission/batches/${YM}/confirm`, {});
  assert.equal(cf.statusCode, 200, cf.body);
  const pay = await post('dir', '/api/commission/payments', { agent_id: ID.repA, amount: 300, settle_ym: YM, evidence: EVI });
  assert.equal(pay.statusCode, 200, pay.body);
  assert.equal(pay.json().settled_count, 1); // FIFO: invA1(300)

  await query(`UPDATE customers SET owner_id=$1 WHERE id=$2`, [ID.repB, ID.custA]); // A → B 이관

  const a = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.repA}`)).json();
  assert.deepEqual(invIds(a), [ID.invA1]);
  assert.equal(a.summary.total_paid, 300);
  const b = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.repB}`)).json();
  assert.deepEqual(invIds(b), [ID.invA2, ID.invB1].sort((x, y) => x - y));
  assert.equal(b.summary.total_confirmed, 210);

  // 새 담당자 지급 대상에 이미 지급된 invA1 이 끼지 않는다(이중지급 방지)
  const pb = (await get('dir', `/api/commission/payable?agent_id=${ID.repB}&settle_ym=${YM}`)).json();
  assert.equal(pb.commission_total, 210);
  assert.ok(!pb.lines.some((l) => Number(l.invoice_id) === ID.invA1));
  const pa = (await get('dir', `/api/commission/payable?agent_id=${ID.repA}&settle_ym=${YM}`)).json();
  assert.equal(pa.commission_total, 0);
});

test('⑥ 실적 조회(performance · 성과급 모듈)도 고객마스터 담당자 기준', { skip: SKIP }, async () => {
  const r = await get('dir', `/api/commission/performance?view=invoice&agent_id=${ID.repB}&from=${YM}&to=${YM}`);
  assert.equal(r.statusCode, 200, r.body);
  const body = r.body;
  assert.ok(body.includes(`${TAG}-A2`) && body.includes(`${TAG}-B1`), '담당 이관된 미지급 인보이스가 실적에 없다');
  assert.ok(!body.includes(`${TAG}-N1`));
});

test('⑦ 팀 커미션 수혜자 — 06_Tele 같은 팀의 고객 매출은 담당자 대신 지정한 사람에게', { skip: SKIP }, async () => {
  // 영업지원(sup)을 커미션 대상으로 + 텔레 팀 + 그 팀 고객(담당자는 repB)
  await query(`INSERT INTO commission_agents (user_id, default_rate, active, created_by, updated_by) VALUES ($1,4,true,$2,$2)`, [ID.sup, ID.dir]);
  await query(`INSERT INTO commission_agent_periods (user_id, start_date, end_date, basis, rate, created_by, updated_by)
               VALUES ($1,'2026-07-01',NULL,'revenue',4,$2,$2)`, [ID.sup, ID.dir]);
  ID.team = Number((await query(`INSERT INTO sales_teams (name, sort_order) VALUES ('${TAG}_Tele', 99) RETURNING id`)).rows[0].id);
  ID.custT = Number((await query(
    `INSERT INTO customers (name, code, credit_days, owner_id, team_id, created_by) VALUES ($1,$2,30,$3,$4,$5) RETURNING id`,
    [`${TAG}T`, `${TAG}-T`, ID.repB, ID.team, ID.dir])).rows[0].id);
  const r = await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn, status, owner_id, memo, created_by)
     VALUES ($1,$2,'2026-09-24',30,'2026-10-24',1000,160,1160,'posted',$3,$4,$3) RETURNING id`, [`${TAG}-T1`, ID.custT, ID.sup, `${TAG} T1`]);
  ID.invT = Number(r.rows[0].id);

  // 지정 전: 고객 담당자(repB)에게
  let b = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.repB}`)).json();
  assert.ok(invIds(b).includes(ID.invT));

  // 영업사원은 지정 불가, 디렉터만
  assert.equal((await post('repA', `/api/commission/teams/${ID.team}/beneficiary`, { user_id: ID.sup })).statusCode, 403);
  const ok = await post('dir', `/api/commission/teams/${ID.team}/beneficiary`, { user_id: ID.sup });
  assert.equal(ok.statusCode, 200, ok.body);
  const teams = (await get('dir', '/api/commission/teams')).json();
  const t = teams.items.find((x) => x.id === ID.team);
  assert.equal(t.commission_user_id, ID.sup); assert.equal(t.customer_count, 1);

  // 지정 후: 수혜자(sup)에게, repB 에서는 빠짐 · 성과급 실적 조회도 동일
  const s = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.sup}`)).json();
  assert.deepEqual(invIds(s), [ID.invT]); assert.equal(s.summary.total_confirmed, 40);
  b = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.repB}`)).json();
  assert.ok(!invIds(b).includes(ID.invT));
  const perf = await get('dir', `/api/commission/performance?view=invoice&agent_id=${ID.sup}&from=2026-09&to=2026-09`);
  assert.ok(perf.body.includes(`${TAG}-T1`));

  // 해제 → 다시 고객 담당자 기준
  assert.equal((await post('dir', `/api/commission/teams/${ID.team}/beneficiary`, { user_id: null })).statusCode, 200);
  b = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.repB}`)).json();
  assert.ok(invIds(b).includes(ID.invT));
});

test('cleanup', { skip: SKIP }, async () => { await cleanup(); await app.close(); });
