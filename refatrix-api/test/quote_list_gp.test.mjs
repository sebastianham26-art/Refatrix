// 견적 목록 · 디렉터 전용 매출총이익(2026-09-24) — 실 PostgreSQL(전체 마이그레이션) + 실 quoteRoutes
//   실행: DATABASE_URL=postgres://…/qgp node --import ./test/helpers/stub-auth.mjs test/quote_list_gp.test.mjs
import assert from 'node:assert/strict';
import Fastify from 'fastify';
const { query } = await import('../src/db.js');
const { default: quoteRoutes } = await import('../src/routes/quoteRoutes.js');
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✔', n); } catch (e) { fail++; console.log('  ✘', n, '\n     ', e.message.split('\n')[0]); } };
const one = async (s, p = []) => (await query(s, p)).rows[0];
const TAG = 'GP' + Date.now().toString(36).toUpperCase();
const uid = (await one(`INSERT INTO users (name, role, pin_hash) VALUES ('Dir ${TAG}','director','x') RETURNING id`)).id;
const cid = (await one(`INSERT INTO customers (code, name) VALUES ($1, $2) RETURNING id`, ['C' + TAG, 'Cliente ' + TAG])).id;
const prod = async (code, cost) => (await one(`INSERT INTO products (code, name, list_price, avg_cost) VALUES ($1,'P',100,$2) RETURNING id`, [code + TAG, cost])).id;
const pA = await prod('A', 40), pB = await prod('B', 70), pN = await prod('N', 0);
const quote = async (no, status, lines, inv = null) => {
  const q = (await one(`INSERT INTO quotes (quote_no, quote_date, status, customer_id, created_by, subtotal_mxn, total_mxn, total_qty, sku_count, invoice_id)
     VALUES ($1, current_date, $2, $3, $4, 0, 0, 0, 0, $5) RETURNING id`, [no + TAG, status, cid, uid, inv])).id;
  for (const [pid, qty, sub] of lines) await query(`INSERT INTO quote_lines (quote_id, product_id, qty, line_subtotal, final_price) VALUES ($1,$2,$3,$4,$5)`, [q, pid, qty, sub, pid ? sub / qty : 0]);
  return q;
};
// 견적: A 10개 × 60 = 600 (원가 400) · B 2개 × 80 = 160 (원가 140) · 원가 없는 N 1줄 · 미등록 코드 1줄
const q1 = await quote('Q1', 'confirmed', [[pA, 10, 600], [pB, 2, 160], [pN, 5, 500], [null, 3, 90]]);
// 손해 견적: B 1개 × 50 (원가 70)
const q2 = await quote('Q2', 'draft', [[pB, 1, 50]]);
// 매출전환: 인보이스 실제 금액 · 동결 원가 사용(견적 줄과 다르게 넣어 기준을 확인)
const inv = (await one(`INSERT INTO sales_invoices (customer_id, inv_date, status, total_mxn) VALUES ($1, current_date, 'posted', 1160) RETURNING id`, [cid])).id;
await query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, unit_price, line_amount_mxn, applied_unit_cost, cogs_mxn) VALUES ($1,$2,10,100,100,1000,35,350)`, [inv, pA]);
const q3 = await quote('Q3', 'converted', [[pA, 10, 999]], inv);
const q4 = await quote('Q4', 'pricelist', [[pA, 1, 100]]);
const q5 = await quote('Q5', 'draft', [[pN, 1, 100], [null, 1, 10]]);   // 원가 있는 줄 없음

const app = Fastify(); app.register(quoteRoutes); await app.ready();
const list = async (user) => {
  const r = await app.inject({ method: 'GET', url: '/api/quotes?q=' + TAG, headers: { 'x-test-user': user } });
  assert.equal(r.statusCode, 200, r.body); return Object.fromEntries(JSON.parse(r.body).items.map((x) => [x.id, x]));
};
const D = await list(uid + ':director');
await t('견적: 매출 760 − 원가 540 = 220 · 28.9% · 원가 없는 줄 1개 제외 · 미등록 줄 제외', async () => {
  assert.deepEqual(D[q1].gp, { basis: 'quote', rev: 760, cost: 540, gp: 220, pct: 28.9, nocost: 1 });
});
await t('손해 견적은 음수', async () => { assert.equal(D[q2].gp.gp, -20); assert.equal(D[q2].gp.pct, -40); });
await t('매출전환 = 인보이스 실매출 1000 − 동결 원가 350 (견적 줄 무시)', async () => {
  assert.deepEqual(D[q3].gp, { basis: 'sale', rev: 1000, cost: 350, gp: 650, pct: 65, nocost: 0 });
});
await t('가용재고 견적(pricelist)은 계산 안 함', async () => { assert.equal(D[q4].gp, undefined); });
await t('원가 있는 줄이 없으면 % 없음', async () => { assert.equal(D[q5].gp.pct, null); assert.equal(D[q5].gp.nocost, 1); });
await t('디렉터가 아니면 gp 필드 자체가 없다 (영업지원 · 재무)', async () => {
  for (const role of ['sales_support', 'finance']) {
    const S = await list(uid + ':' + role);
    if (role === 'sales_support') assert.ok(S[q1], role + ' 목록에 견적이 없음');   // 영업은 팀 범위라 안 보일 수 있다
    assert.ok(Object.values(S).every((x) => !('gp' in x)), role + ' 에게 gp 노출');
  }
});
await t('다른 필드는 그대로(회귀)', async () => {
  const S = await list(uid + ':sales_support');
  for (const k of Object.keys(S[q1])) assert.deepEqual(D[q1][k], S[q1][k], k);
});
await app.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
