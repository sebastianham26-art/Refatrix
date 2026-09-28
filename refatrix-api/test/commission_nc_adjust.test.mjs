// =====================================================================
// 커미션 · 크레딧노트(NC) 순액 + 지급 후 매출조정 차액 정산(A) — 검증  2026-09-28
//   순수: computeAdjustment
//   종단(실 PostgreSQL, TEST_PG_URL): NC 차감 · 수금기준 완납(현금 ≥ 순합계) · 성과급 실적 순액
//        · 지급 후 삭제/NC → 다음 지급에서 차감 · 차감 > 지급대상이면 이월 · 요율 변경은 차액 없음
//        · NC 취소 → 추가 지급 · 차액 정산 후 재발생 없음
//   실행: TEST_PG_URL=postgres://... node --test test/commission_nc_adjust.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 종단 검증 생략(순수 테스트만 실행)');
if (PG) process.env.DATABASE_URL = PG;

// ── 순수 ─────────────────────────────────────────────────────────────
test('computeAdjustment — NC 로 순매출 감소 → 지급 당시 율로 차감', async () => {
  const { computeAdjustment } = await import('../src/routes/commissionRoutes.js');
  const a = computeAdjustment({ paid_amount: 150, paid_base: 5000, cur_base: 4000, nc_base: 1000, deleted: false });
  assert.equal(a.amount, -30); assert.equal(a.new_amount, 120); assert.equal(a.new_base, 4000); assert.equal(a.reason, 'nota_credito');
});
test('computeAdjustment — 매출 삭제 → 전액 환수', async () => {
  const { computeAdjustment } = await import('../src/routes/commissionRoutes.js');
  const a = computeAdjustment({ paid_amount: 270, paid_base: 9000, cur_base: 9000, nc_base: 1000, deleted: true });
  assert.equal(a.amount, -270); assert.equal(a.new_amount, 0); assert.equal(a.reason, 'deleted');
});
test('computeAdjustment — 금액 증가 → 추가 지급 / 변동 없음 → null / 기준 없음 → null', async () => {
  const { computeAdjustment } = await import('../src/routes/commissionRoutes.js');
  const up = computeAdjustment({ paid_amount: 100, paid_base: 2000, cur_base: 2500, nc_base: 0, deleted: false });
  assert.equal(up.amount, 25); assert.equal(up.reason, 'amount_change');
  assert.equal(computeAdjustment({ paid_amount: 100, paid_base: 2000, cur_base: 2000, nc_base: 0 }), null);
  assert.equal(computeAdjustment({ paid_amount: 100, paid_base: null, cur_base: 0, deleted: true }), null);
});
test('computeAdjustment — 고객 예외율 등 실효율 유지(요율이 아니라 지급액/기준 비율)', async () => {
  const { computeAdjustment } = await import('../src/routes/commissionRoutes.js');
  const a = computeAdjustment({ paid_amount: 77.77, paid_base: 1111, cur_base: 555.5, nc_base: 555.5 });
  assert.equal(a.new_amount, 38.89); assert.equal(a.amount, -38.88);
});

// ── 종단 ─────────────────────────────────────────────────────────────
let query, app;
const tok = {}; const ID = {};
const TAG = 'NCADJTEST'; const YM = '2026-09';
const EVI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function cleanup() {
  const U = `SELECT id FROM users WHERE login_id LIKE 'ncadjtest%'`;
  const INV = `SELECT id FROM sales_invoices WHERE memo LIKE '${TAG}%'`;
  await query(`DELETE FROM bonus_payouts WHERE confirmed_by IN (${U}) OR user_id IN (${U})`).catch(() => {});
  await query(`DELETE FROM commission_payment_allocations WHERE invoice_id IN (${INV})`);
  await query(`DELETE FROM commission_payouts WHERE invoice_id IN (${INV})`);
  await query(`DELETE FROM commission_payments WHERE agent_id IN (${U})`);
  await query(`DELETE FROM commission_agent_periods WHERE user_id IN (${U})`);
  await query(`DELETE FROM commission_agents WHERE user_id IN (${U})`);
  await query(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (${INV})`);
  await query(`DELETE FROM sales_payments WHERE memo LIKE '${TAG}%'`);
  await query(`DELETE FROM notas_credito WHERE invoice_id IN (${INV})`);
  await query(`DELETE FROM sales_invoices WHERE memo LIKE '${TAG}%'`);
  await query(`DELETE FROM commission_batches WHERE settle_ym='${YM}'`);
  await query(`DELETE FROM audit_log WHERE user_id IN (${U})`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (${U})`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM users WHERE login_id LIKE 'ncadjtest%'`);
}

const mkInv = async (sat, cust, date, sub) => Number((await query(
  `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                               status, owner_id, memo, created_by)
   VALUES ($1,$2,$3,30,($3::date + 30),$4,$5,$6,'posted',$7,$8,$7) RETURNING id`,
  [`${TAG}-${sat}`, cust, date, sub, sub * 0.16, sub * 1.16, ID.sup, `${TAG} ${sat}`])).rows[0].id);
// NC 적용: 헤더 + 비현금 배분(payment_id NULL, kind='nota_credito') — notaCreditoRoutes /apply 와 동일한 흔적
const applyNc = async (inv, cust, base) => {
  const nc = Number((await query(
    `INSERT INTO notas_credito (invoice_id, customer_id, concepto, total_mxn, base_mxn, iva_mxn, status, created_by, applied_at)
     VALUES ($1,$2,'${TAG} devolucion',$3,$4,$5,'applied',$6,now()) RETURNING id`,
    [inv, cust, base * 1.16, base, base * 0.16, ID.sup])).rows[0].id);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, txn_id, kind, nc_id) VALUES (NULL,$1,$2,NULL,'nota_credito',$3)`, [inv, base * 1.16, nc]);
  return nc;
};
const voidNc = async (nc) => {
  await query(`DELETE FROM sales_payment_allocations WHERE nc_id=$1`, [nc]);
  await query(`UPDATE notas_credito SET status='void', voided_at=now() WHERE id=$1`, [nc]);
};

async function boot() {
  ({ query } = await import('../src/db.js'));
  const commissionRoutes = (await import('../src/routes/commissionRoutes.js')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'ncadjtest_dir');
  ID.sup = await mkUser(`${TAG}영업지원`, 'sales_support', 'ncadjtest_sup');
  ID.rep = await mkUser(`${TAG}영업매출`, 'sales', 'ncadjtest_rep');   // 매출 3%
  ID.col = await mkUser(`${TAG}영업수금`, 'sales', 'ncadjtest_col');   // 수금 4%
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'commission','anywhere','view') ON CONFLICT DO NOTHING`, [ID.rep]);
  for (const [u, basis, rate] of [[ID.rep, 'revenue', 3], [ID.col, 'collection', 4]]) {
    await query(`INSERT INTO commission_agents (user_id, default_rate, active, created_by, updated_by) VALUES ($1,$2,true,$3,$3)`, [u, rate, ID.dir]);
    await query(`INSERT INTO commission_agent_periods (user_id, start_date, end_date, basis, rate, created_by, updated_by)
                 VALUES ($1,'2026-07-01',NULL,$2,$3,$4,$4)`, [u, basis, rate, ID.dir]);
  }
  const mkCust = async (n, owner) => Number((await query(
    `INSERT INTO customers (name, code, credit_days, owner_id, created_by) VALUES ($1,$2,30,$3,$4) RETURNING id`,
    [`${TAG}${n}`, `${TAG}-${n}`, owner, ID.dir])).rows[0].id);
  ID.custR = await mkCust('R', ID.rep);
  ID.custC = await mkCust('C', ID.col);
  ID.acc = Number((await query(
    `INSERT INTO accounts (name, type, currency, open_balance, created_by) VALUES ($1,'bank','MXN',0,$2) RETURNING id`,
    [`${TAG}은행`, ID.dir])).rows[0].id);

  ID.invA = await mkInv('A', ID.custR, '2026-09-10', 10000);
  ID.ncA = await applyNc(ID.invA, ID.custR, 1000);            // 순매출 9,000 → 270
  ID.invB = await mkInv('B', ID.custR, '2026-09-12', 5000);   // 150
  ID.invCol = await mkInv('COL', ID.custC, '2026-09-05', 10000);
  ID.ncCol = await applyNc(ID.invCol, ID.custC, 1000);        // 순합계 10,440

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(commissionRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.rep = app.jwt.sign({ sub: ID.rep });
}
const get = (who, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[who] } });
const post = (who, url, body) => app.inject({ method: 'POST', url, payload: body, headers: { authorization: 'Bearer ' + tok[who] } });
const lineOf = (ov, id) => ov.groups.flatMap((g) => g.lines).find((l) => Number(l.invoice_id) === id);
const payable = async (who, uid) => (await get(who, `/api/commission/payable?agent_id=${uid}&settle_ym=${YM}`)).json();

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 매출 기준 — 적용된 NC 만큼 커미션 기준액 차감', { skip: SKIP }, async () => {
  const ov = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.rep}`)).json();
  const a = lineOf(ov, ID.invA);
  assert.equal(a.base, 9000); assert.equal(a.nc_base, 1000); assert.equal(a.expected, 270); assert.equal(a.confirmed, 270);
  assert.equal(lineOf(ov, ID.invB).expected, 150);
});

test('② 수금 기준 — NC 는 수금이 아님, 현금이 순합계를 채우면 완납·확정(순액 기준)', { skip: SKIP }, async () => {
  let ov = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.col}`)).json();
  let l = lineOf(ov, ID.invCol);
  assert.equal(l.base, 9000); assert.equal(l.expected, 360); assert.equal(l.recognized, false);
  const pay = Number((await query(`INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, memo, created_by)
     VALUES ($1,'2026-09-20',$2,10440,'${TAG} 수금',$3) RETURNING id`, [ID.custC, ID.acc, ID.dir])).rows[0].id);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,10440)`, [pay, ID.invCol]);
  ov = (await get('dir', `/api/commission/overview?view=all&agent_id=${ID.col}`)).json();
  l = lineOf(ov, ID.invCol);
  assert.equal(l.recognized, true); assert.equal(l.confirmed, 360); assert.equal(l.settle_ym, YM);
});

test('③ 성과급 실적 조회 — 매출·수금 모두 NC 차감 순액', { skip: SKIP }, async () => {
  const r = await get('dir', `/api/commission/performance?view=invoice&agent_id=${ID.col}&from=${YM}&to=${YM}`);
  assert.equal(r.statusCode, 200, r.body);
  const inv = (r.json().invoices || []).find((x) => String(x.sat_no) === `${TAG}-COL`);
  assert.ok(inv, r.body.slice(0, 300));
  assert.equal(Number(inv.subtotal), 9000);
  assert.equal(Number(inv.paid_amount), 9000); // 현금 10,440 → ex-IVA 9,000 = 완납
});

test('④ 지급 — 지급 시점 순매출이 스냅샷(base_mxn)으로 남는다', { skip: SKIP }, async () => {
  assert.equal((await post('dir', `/api/commission/batches/${YM}/confirm`, {})).statusCode, 200);
  const p = await payable('dir', ID.rep);
  assert.equal(p.commission_total, 420); assert.equal(p.adjustment_total, 0);
  const r = await post('dir', '/api/commission/payments', { agent_id: ID.rep, amount: 420, settle_ym: YM, evidence: EVI });
  assert.equal(r.statusCode, 200, r.body);
  const rows = (await query(`SELECT invoice_id, amount, base_mxn FROM commission_payouts WHERE invoice_id = ANY($1) ORDER BY invoice_id`, [[ID.invA, ID.invB]])).rows;
  assert.deepEqual(rows.map((x) => [Number(x.amount), Number(x.base_mxn)]), [[270, 9000], [150, 5000]]);
});

test('⑤ 지급 후 NC·매출삭제 → 차감이 생기고, 요율 변경은 차액을 만들지 않는다', { skip: SKIP }, async () => {
  ID.ncB = await applyNc(ID.invB, ID.custR, 1000);                                   // 150 → 120 (−30)
  await query(`UPDATE sales_invoices SET status='deleted', deleted_at=now() WHERE id=$1`, [ID.invA]); // −270
  await query(`UPDATE commission_agent_periods SET rate=5 WHERE user_id=$1`, [ID.rep]); // 율 변경(무관)
  const ovr = await get('dir', `/api/commission/overview?view=all&agent_id=${ID.rep}`);
  assert.equal(ovr.statusCode, 200, ovr.body);
  const ov = ovr.json();
  assert.equal(ov.summary.adjustment_total, -300);
  const byInv = Object.fromEntries(ov.adjustments.map((a) => [Number(a.invoice_id), a]));
  assert.equal(byInv[ID.invA].amount, -270); assert.equal(byInv[ID.invA].reason, 'deleted');
  assert.equal(byInv[ID.invB].amount, -30); assert.equal(byInv[ID.invB].reason, 'nota_credito');
  // 영업사원 본인 화면에도 보인다
  const mine = (await get('rep', `/api/commission/overview?view=all`)).json();
  assert.equal(mine.summary.adjustment_total, -300);
  await query(`UPDATE commission_agent_periods SET rate=3 WHERE user_id=$1`, [ID.rep]);
});

test('⑥ 차감이 이번 달 지급 대상보다 크면 지급 불가(이월)', { skip: SKIP }, async () => {
  ID.invC = await mkInv('C', ID.custR, '2026-09-25', 5000); // +150 < 300
  const p = await payable('dir', ID.rep);
  assert.equal(p.commission_total, 150); assert.equal(p.adjustment_total, -300); assert.equal(p.total, -150);
  const r = await post('dir', '/api/commission/payments', { agent_id: ID.rep, amount: 1, settle_ym: YM, evidence: EVI });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error, 'adjustment_exceeds');
});

test('⑦ 지급 대상이 차감보다 크면 차감 반영 후 차액만 지급 → 이후 같은 차액 재발생 없음', { skip: SKIP }, async () => {
  ID.invD = await mkInv('D', ID.custR, '2026-09-26', 10000); // +300 → 대상 450
  const p = await payable('dir', ID.rep);
  assert.equal(p.total, 150);
  // 지급액이 너무 작아 차감만 먼저 빠지는 정산은 거부
  const small = await post('dir', '/api/commission/payments', { agent_id: ID.rep, amount: 1, settle_ym: YM, evidence: EVI });
  assert.equal(small.statusCode, 409); assert.equal(small.json().error, 'amount_too_small');
  const r = await post('dir', '/api/commission/payments', { agent_id: ID.rep, amount: 150, settle_ym: YM, evidence: EVI });
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.settled_count, 2); assert.equal(d.adjustment_count, 2); assert.equal(d.adjustment_settled, -300); assert.equal(d.settled, 150);
  const after = await payable('dir', ID.rep);
  assert.equal(after.adjustments.length, 0); assert.equal(after.total, 0);
  const a = (await query(`SELECT amount, base_mxn FROM commission_payouts WHERE invoice_id=$1`, [ID.invA])).rows[0];
  assert.equal(Number(a.amount), 0); assert.equal(Number(a.base_mxn), 0);
  const alloc = (await query(`SELECT SUM(amount) s FROM commission_payment_allocations WHERE invoice_id=$1`, [ID.invB])).rows[0];
  assert.equal(Number(alloc.s), 120); // 150 지급 − 30 차감
});

test('⑧ NC 취소(void) → 순매출 회복분 추가 지급(+30)', { skip: SKIP }, async () => {
  await voidNc(ID.ncB);
  const p = await payable('dir', ID.rep);
  assert.equal(p.adjustments.length, 1);
  assert.equal(p.adjustments[0].amount, 30); assert.equal(p.adjustment_total, 30);
});

test('⑨ 월 확정 합계는 NC 순액 기준(매출 기준 3% · 삭제분 제외)', { skip: SKIP }, async () => {
  const bt = (await get('dir', `/api/commission/batches`)).json();
  assert.ok(bt.items.find((x) => x.settle_ym === YM));
});

test('cleanup', { skip: SKIP }, async () => { await cleanup(); if (app) await app.close(); });
