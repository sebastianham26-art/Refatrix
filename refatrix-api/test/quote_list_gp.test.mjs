// 견적 목록 · 디렉터 전용 매출총이익(2026-09-24, gp2) — 실 PostgreSQL(전체 마이그레이션) + 실 quoteRoutes
//   실행: DATABASE_URL=postgres://…/빈DB node --import ./test/helpers/stub-auth.mjs test/quote_list_gp.test.mjs
//   ※ 환율 · 수입 배치를 직접 넣으므로 빈 시험 DB 에서 돌린다.
import assert from 'node:assert/strict';
import Fastify from 'fastify';
const { query } = await import('../src/db.js');
const { _resetFobBasisForTest } = await import('../src/priceMaster.js');
const { default: quoteRoutes } = await import('../src/routes/quoteRoutes.js');
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✔', n); } catch (e) { fail++; console.log('  ✘', n, '\n     ', e.message.split('\n')[0]); } };
const one = async (s, p = []) => (await query(s, p)).rows[0];
const TAG = 'GP' + Date.now().toString(36).toUpperCase();
const uid = (await one(`INSERT INTO users (name, role, pin_hash) VALUES ('Dir ${TAG}','director','x') RETURNING id`)).id;
const cid = (await one(`INSERT INTO customers (code, name) VALUES ($1, $2) RETURNING id`, ['C' + TAG, 'Cliente ' + TAG])).id;
const prod = async (code, cost, fob = null) => (await one(`INSERT INTO products (code, name, list_price, avg_cost, fob_usd) VALUES ($1,'P',100,$2,$3) RETURNING id`, [code + TAG, cost, fob])).id;
const pA = await prod('A', 40), pB = await prod('B', 70), pF = await prod('F', 0, 2), pN = await prod('N', 0);
// 환율 20 · 전체 평균 부대비율 10% (FOB 금액 1,000 MXN · 부대비 100 MXN) → FOB 1달러당 원가 22 MXN
await query(`INSERT INTO fx_rates (base, quote, rate, rate_date) VALUES ('USD','MXN',20,current_date)`);
const bt = (await one(`INSERT INTO import_batches (import_date, currency, fx_rate, status) VALUES (current_date,'USD',20,'approved') RETURNING id`)).id;
await query(`INSERT INTO import_lines (batch_id, product_id, qty, import_price) VALUES ($1,$2,10,5)`, [bt, pA]);   // 10×5×20 = 1000
await query(`INSERT INTO import_overheads (batch_id, label, amount, currency) VALUES ($1,'flete',100,'MXN')`, [bt]);
_resetFobBasisForTest();
const quote = async (no, status, lines, inv = null) => {
  const q = (await one(`INSERT INTO quotes (quote_no, quote_date, status, customer_id, created_by, subtotal_mxn, total_mxn, total_qty, sku_count, invoice_id)
     VALUES ($1, current_date, $2, $3, $4, 0, 0, 0, 0, $5) RETURNING id`, [no + TAG, status, cid, uid, inv])).id;
  for (const [pid, qty, sub] of lines) await query(`INSERT INTO quote_lines (quote_id, product_id, qty, line_subtotal, final_price) VALUES ($1,$2,$3,$4,$5)`, [q, pid, qty, sub, pid ? sub / qty : 0]);
  return q;
};
// 견적: A 10×60=600(원가 400) · B 2×80=160(원가 140) · F 5개 500(평균원가 0 → FOB 2×22=44 → 220) · N(원가·FOB 없음) · 미등록 코드
const q1 = await quote('Q1', 'confirmed', [[pA, 10, 600], [pB, 2, 160], [pF, 5, 500], [pN, 5, 500], [null, 3, 90]]);
const q2 = await quote('Q2', 'draft', [[pB, 1, 50]]);                        // 손해
const inv = (await one(`INSERT INTO sales_invoices (customer_id, inv_date, status, total_mxn) VALUES ($1, current_date, 'posted', 1160) RETURNING id`, [cid])).id;
await query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, unit_price, line_amount_mxn, applied_unit_cost, cogs_mxn) VALUES ($1,$2,10,100,100,1000,35,350)`, [inv, pA]);
await query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, unit_price, line_amount_mxn, applied_unit_cost, cogs_mxn) VALUES ($1,$2,2,100,100,200,0,0)`, [inv, pF]);   // 동결 원가 0 → FOB 추정 88
const q3 = await quote('Q3', 'converted', [[pA, 10, 999]], inv);
const q4 = await quote('Q4', 'pricelist', [[pA, 1, 100]]);
const q5 = await quote('Q5', 'draft', [[pN, 1, 100], [null, 1, 10]]);
const q6 = await quote('Q6', 'draft', [[pF, 1, 60]]);                        // FOB 만 있는 견적도 보인다

const app = Fastify(); app.register(quoteRoutes); await app.ready();
const list = async (user) => {
  const r = await app.inject({ method: 'GET', url: '/api/quotes?q=' + TAG, headers: { 'x-test-user': user } });
  assert.equal(r.statusCode, 200, r.body); return Object.fromEntries(JSON.parse(r.body).items.map((x) => [x.id, x]));
};
const D = await list(uid + ':director');
await t('견적: 평균원가 줄 + FOB 추정 줄 — 매출 1,260 − 원가 760 = 500 · 39.7%', async () => {
  assert.deepEqual(D[q1].gp, { basis: 'quote', rev: 1260, cost: 760, gp: 500, pct: 39.7, est: 1, nocost: 1, fx: 20, oh_rate: 0.1 });
});
await t('평균원가 0 · FOB 만 있는 전환 전 견적도 표시(60 − 44 = 16)', async () => {
  assert.equal(D[q6].gp.gp, 16); assert.equal(D[q6].gp.pct, 26.7); assert.equal(D[q6].gp.est, 1);
});
await t('손해 견적은 음수', async () => { assert.equal(D[q2].gp.gp, -20); assert.equal(D[q2].gp.pct, -40); assert.equal(D[q2].gp.est, 0); });
await t('매출전환 = 인보이스 · 동결 원가 0 줄은 FOB 추정 (1,200 − 438 = 762)', async () => {
  assert.deepEqual(D[q3].gp, { basis: 'sale', rev: 1200, cost: 438, gp: 762, pct: 63.5, est: 1, nocost: 0, fx: 20, oh_rate: 0.1 });
});
await t('가용재고 견적(pricelist)은 계산 안 함', async () => { assert.equal(D[q4].gp, undefined); });
await t('원가 · FOB 둘 다 없으면 % 없음', async () => { assert.equal(D[q5].gp.pct, null); assert.equal(D[q5].gp.nocost, 1); });
await t('디렉터가 아니면 gp 필드 자체가 없다 (영업지원 · 재무)', async () => {
  for (const role of ['sales_support', 'finance']) {
    const S = await list(uid + ':' + role);
    if (role === 'sales_support') assert.ok(S[q1], role + ' 목록에 견적이 없음');   // 재무·영업은 팀 범위라 안 보일 수 있다
    assert.ok(Object.values(S).every((x) => !('gp' in x)), role + ' 에게 gp 노출');
  }
});
await t('다른 필드는 그대로(회귀)', async () => {
  const S = await list(uid + ':sales_support');
  for (const k of Object.keys(S[q1])) assert.deepEqual(D[q1][k], S[q1][k], k);
});
await t('fob_usd 컬럼이 없어도(0229 전) 목록이 깨지지 않는다', async () => {
  await query(`ALTER TABLE products RENAME COLUMN fob_usd TO fob_usd_x`);
  try { const X = await list(uid + ':director'); assert.equal(X[q6].gp.pct, null); assert.equal(X[q1].gp.gp, 220); }
  finally { await query(`ALTER TABLE products RENAME COLUMN fob_usd_x TO fob_usd`); }
});
await app.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
