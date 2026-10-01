// 견적·매출 추적 — 기간 요약(GET /api/quotes/summary) + 제품번호 검색(2026-10-01)
//   실 PostgreSQL(전체 마이그레이션) + 실 quoteRoutes
//   실행: DATABASE_URL=postgres://…/빈DB node --import ./test/helpers/stub-auth.mjs test/quote_summary_search.test.mjs
import assert from 'node:assert/strict';
import Fastify from 'fastify';
const { query } = await import('../src/db.js');
const { _resetFobBasisForTest } = await import('../src/priceMaster.js');
const { codeSearchPattern } = await import('../src/quoteBuild.js');
const { default: quoteRoutes } = await import('../src/routes/quoteRoutes.js');
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✔', n); } catch (e) { fail++; console.log('  ✘', n, '\n     ', e.message.split('\n')[0]); } };
const one = async (s, p = []) => (await query(s, p)).rows[0];
const TAG = 'SM' + Date.now().toString(36).toUpperCase();
const YM = '2031-07', D1 = '2031-07-10', YM2 = '2031-08', D2 = '2031-08-05';   // 다른 시험과 겹치지 않는 먼 기간
const uid = (await one(`INSERT INTO users (name, role, pin_hash) VALUES ('Dir ${TAG}','director','x') RETURNING id`)).id;
const cid = (await one(`INSERT INTO customers (code, name) VALUES ($1, $2) RETURNING id`, ['C' + TAG, 'Cliente ' + TAG])).id;
const prod = async (code, cost, fob = null) => (await one(`INSERT INTO products (code, name, list_price, avg_cost, fob_usd) VALUES ($1,'P',100,$2,$3) RETURNING id`, [code, cost, fob])).id;
const pA = await prod('CS' + TAG + 'A', 40), pB = await prod('CS' + TAG + 'B', 0, 2), pN = await prod('CS' + TAG + 'N', 0);
// 경쟁사 번호: SYD(product_syd_codes) · BAW(product_xref_codes)
await query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,$2)`, [pA, 'SY-' + TAG + '-77']);
await query(`INSERT INTO product_xref_codes (product_id, xref_code, norm_code, brand) VALUES ($1,$2,$3,'BAW')`, [pB, 'BW ' + TAG + '.9', 'BW' + TAG + '9']);
// 환율 20 · 부대비율 10% → FOB 1달러 = 22 MXN
await query(`INSERT INTO fx_rates (base, quote, rate, rate_date) VALUES ('USD','MXN',20,current_date)`);
const bt = (await one(`INSERT INTO import_batches (import_date, currency, fx_rate, status) VALUES (current_date,'USD',20,'approved') RETURNING id`)).id;
await query(`INSERT INTO import_lines (batch_id, product_id, qty, import_price) VALUES ($1,$2,10,5)`, [bt, pA]);
await query(`INSERT INTO import_overheads (batch_id, label, amount, currency) VALUES ($1,'flete',100,'MXN')`, [bt]);
_resetFobBasisForTest();

const quote = async (no, date, status, sub, qty, lines, inv = null) => {
  const q = (await one(`INSERT INTO quotes (quote_no, quote_date, status, customer_id, created_by, subtotal_mxn, total_mxn, total_qty, sku_count, invoice_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6 * 1.16, $7, 1, $8) RETURNING id`, [no + TAG, date, status, cid, uid, sub, qty, inv])).id;
  let n = 0;
  for (const [pid, code, input, lq, ls, resv] of lines) await query(
    `INSERT INTO quote_lines (quote_id, line_no, product_id, ctr_code, input_code, qty, line_subtotal, final_price, reserved_qty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [q, ++n, pid, code, input, lq, ls, lq ? ls / lq : 0, resv || 0]);
  return q;
};
const short = (pid, qid, inv, qty, amtIva, status = 'open', d = D1) => query(
  `INSERT INTO stock_shortages (product_id, customer_id, sales_invoice_id, requested_qty, fulfilled_qty, shortage_qty, shortage_amount_mxn, occurred_at, source_quote_id, status)
   VALUES ($1,$2,$3,$4,0,$4,$5,$6,$7,$8)`, [pid, cid, inv, qty, amtIva, d, qid, status]);

// ── 7월 ──
// Q1 전환: 견적 A 10개 1,000 + B 4개 400 → 인보이스 A 6개 600(동결원가 35 → 210) · 부족 A 4개 400 + B 4개 400
const inv1 = (await one(`INSERT INTO sales_invoices (customer_id, inv_date, status, subtotal_mxn, total_mxn) VALUES ($1,$2,'posted',600,696) RETURNING id`, [cid, D1])).id;
await query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, unit_price, line_amount_mxn, applied_unit_cost, cogs_mxn) VALUES ($1,$2,6,100,100,600,35,210)`, [inv1, pA]);
const q1 = await quote('Q1', D1, 'converted', 1400, 14, [[pA, 'CS' + TAG + 'A', 'CS' + TAG + 'A', 10, 1000], [pB, 'CS' + TAG + 'B', 'BW-' + TAG + '-9', 4, 400]], inv1);
await short(pA, q1, inv1, 4, 464);   // 400 × 1.16
await short(pB, q1, inv1, 4, 464);
// Q2 만료: N 5개 500 → 부족 기록 5개 500 (원가·FOB 없음 → 이익 계산에서 빠짐)
const q2 = await quote('Q2', D1, 'expired', 500, 5, [[pN, 'CS' + TAG + 'N', 'CS' + TAG + 'N', 5, 500]]);
await short(pN, q2, null, 5, 580);
// Q3 미결: A 3개 300, 예약 1 → 현재 부족 2개 200 (확정 전이라 실기 합계엔 넣지 않음)
const q3 = await quote('Q3', D1, 'confirmed', 300, 3, [[pA, 'CS' + TAG + 'A', 'CS' + TAG + 'A', 3, 300, 1]]);
// Q4 무효 부족(cancelled)은 실기에서 뺀다 / 가용재고 견적·취소 견적은 대상 아님
const q4 = await quote('Q4', D1, 'expired', 100, 1, [[pA, 'CS' + TAG + 'A', null, 1, 100]]);
await short(pA, q4, null, 1, 116, 'cancelled');
await quote('Q5', D1, 'pricelist', 0, 0, []);
await quote('Q6', D1, 'cancelled', 999, 9, [[pA, 'CS' + TAG + 'A', null, 9, 999]]);
// Q7 삭제된 인보이스로 전환된 견적 — 견적액은 들어가지만 실매출에서는 빠진다
const invD = (await one(`INSERT INTO sales_invoices (customer_id, inv_date, status, subtotal_mxn, total_mxn) VALUES ($1,$2,'deleted',50,58) RETURNING id`, [cid, D1])).id;
await query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, unit_price, line_amount_mxn, applied_unit_cost, cogs_mxn) VALUES ($1,$2,1,50,50,50,40,40)`, [invD, pA]);
await quote('Q7', D1, 'converted', 50, 1, [[pA, 'CS' + TAG + 'A', null, 1, 50]], invD);
// ── 8월 ── 0229 이전(source_quote_id 없음) 부족 기록은 인보이스로 잇는다
const inv8 = (await one(`INSERT INTO sales_invoices (customer_id, inv_date, status, subtotal_mxn, total_mxn) VALUES ($1,$2,'posted',200,232) RETURNING id`, [cid, D2])).id;
await query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, unit_price, line_amount_mxn, applied_unit_cost, cogs_mxn) VALUES ($1,$2,2,100,100,200,0,0)`, [inv8, pB]);   // 동결 0 → FOB 2×2×22 = 88
const q8 = await quote('Q8', D2, 'converted', 300, 3, [[pB, 'CS' + TAG + 'B', null, 3, 300]], inv8);
await short(pB, null, inv8, 1, 116, 'resolved', D2);

const app = Fastify(); app.register(quoteRoutes); await app.ready();
const get = async (url, user = uid + ':director') => {
  const r = await app.inject({ method: 'GET', url, headers: { 'x-test-user': user } });
  assert.equal(r.statusCode, 200, r.body); return JSON.parse(r.body);
};
const S7 = await get('/api/quotes/summary?yms=' + YM);
await t('총 견적액·수량 — 작성중·확정·전환·만료만 (가용재고·취소 제외)', async () => {
  assert.deepEqual(S7.quotes, { n: 5, amt: 2350, qty: 24, sku: 3, lines: 6, open: 1, converted: 2, expired: 2 });
});
await t('실매출 — 전환 인보이스 줄 합(삭제된 인보이스 제외) · 전환율', async () => {
  assert.deepEqual(S7.sales, { invoices: 1, amt: 600, qty: 6, sku: 1, rate: 25.5 });
});
await t('재고부족 실기 — 전환 미확보 800 + 만료 500 (무효 기록 제외) · IVA 제외', async () => {
  assert.equal(S7.lost.amt, 1300); assert.equal(S7.lost.qty, 13); assert.equal(S7.lost.n, 3); assert.equal(S7.lost.sku, 3);
  assert.equal(S7.lost.converted_amt, 800); assert.equal(S7.lost.expired_amt, 500);
});
await t('미결 견적의 현재 부족분은 따로 (200 · 2개)', async () => {
  assert.equal(S7.lost.open_short_amt, 200); assert.equal(S7.lost.open_short_qty, 2);
});
await t('매출총이익 실현 — 600 − 210 = 390', async () => {
  assert.deepEqual(S7.gp.sales, { gp: 390, rev: 600, cost: 210, pct: 65, est: 0, nocost: 0 });
});
await t('실기 이익 — A 400−4×40 = 240, B(FOB) 400−4×2×22 = 224 → 464, N 은 원가 없음', async () => {
  assert.deepEqual(S7.gp.lost, { gp: 464, rev: 800, cost: 336, pct: 58, est: 1, nocost: 1 });
});
await t('8월 — source_quote_id 없는 옛 부족 기록은 인보이스로 잇는다 · 동결원가 0 은 FOB 추정', async () => {
  const S8 = await get('/api/quotes/summary?yms=' + YM2);
  assert.equal(S8.lost.amt, 100); assert.equal(S8.sales.amt, 200);
  assert.equal(S8.gp.sales.gp, 112); assert.equal(S8.gp.sales.est, 1);
});
await t('여러 달 선택 = 합산', async () => {
  const S = await get('/api/quotes/summary?yms=' + YM + ',' + YM2);
  assert.equal(S.quotes.n, 6); assert.equal(S.quotes.amt, 2650); assert.equal(S.sales.amt, 800); assert.equal(S.lost.amt, 1400);
});
await t('잘못된/빈 기간은 빈 응답(전체를 조용히 긁지 않는다)', async () => {
  const S = await get('/api/quotes/summary?yms=2031-13,abc');
  assert.equal(S.empty, true);
});
await t('요약은 디렉터 · 소시오 전용 — 소시오는 이익까지 보고, 그 밖의 역할은 403', async () => {
  // 소시오는 목록과 같은 팀 범위로 본다(시험 소시오는 소속팀이 없어 0건) — 이익 칸은 내려온다
  const S = await get('/api/quotes/summary?yms=' + YM, uid + ':socio');
  assert.equal(S.quotes.n, 0); assert.ok(S.gp && S.gp.sales, '소시오에게 이익 칸이 없음');
  for (const role of ['sales_support', 'sales', 'finance']) {
    const r = await app.inject({ method: 'GET', url: '/api/quotes/summary?yms=' + YM, headers: { 'x-test-user': uid + ':' + role } });
    assert.equal(r.statusCode, 403, role); assert.ok(!r.body.includes('2350'), role + ' 에 숫자 노출');
  }
});
await t('미등록 코드 줄은 입력 코드(정규화) 하나를 SKU 하나로 센다', async () => {
  const qx = await quote('QX', '2031-09-02', 'draft', 30, 3, [[null, null, 'zz-9', 1, 10], [null, null, 'ZZ9', 1, 10], [null, null, 'YY1', 1, 10]]);
  const S = await get('/api/quotes/summary?yms=2031-09');
  assert.equal(S.quotes.sku, 2); assert.equal(S.quotes.lines, 3); assert.equal(S.quotes.qty, 3); assert.ok(qx);
});

// ── 검색 ──
const ids = async (kw) => (await get('/api/quotes?from=&to=&q=' + encodeURIComponent(kw))).items.map((x) => x.id);
await t('codeSearchPattern — 표기 흔들림 제거 · 4자 이상 앞부분 일치 · 영숫자 없으면 null', async () => {
  assert.equal(codeSearchPattern(' ds-1045 s '), 'DS1045S%');
  assert.equal(codeSearchPattern('a-1'), 'A1');
  assert.equal(codeSearchPattern('한글'), null);
});
await t('우리 CTR 번호로 찾는다 (소문자·하이픈 섞여도)', async () => {
  const r = await ids(('cs-' + TAG + '-n').toLowerCase());
  assert.deepEqual(r, [q2]);
});
await t('CTR 번호 앞부분만 쳐도 찾는다', async () => {
  const r = await ids('CS' + TAG);
  for (const q of [q1, q2, q3, q8]) assert.ok(r.includes(q), 'missing ' + q);
});
await t('SYD 번호 → 그 제품이 든 견적', async () => {
  const r = await ids('SY' + TAG + '77');
  for (const q of [q1, q3, q4]) assert.ok(r.includes(q), 'missing ' + q);
  assert.ok(!r.includes(q8));
});
await t('경쟁사(BAW) 번호 → 교차참조 제품이 든 견적', async () => {
  const r = await ids('bw ' + TAG + ' 9');
  assert.ok(r.includes(q1) && r.includes(q8)); assert.ok(!r.includes(q2));
});
await t('걸린 줄을 code_hits 로 내려 준다', async () => {
  const it = (await get('/api/quotes?from=&to=&q=' + encodeURIComponent('BW' + TAG + '9'))).items.find((x) => x.id === q1);
  assert.deepEqual(it.code_hits, [{ ctr: 'CS' + TAG + 'B', input: 'BW-' + TAG + '-9', qty: 4 }]);
});
await t('견적번호 검색은 그대로 (code_hits 는 비어 있음)', async () => {
  const it = (await get('/api/quotes?from=&to=&q=' + encodeURIComponent('Q2' + TAG))).items;
  assert.equal(it.length, 1); assert.equal(it[0].id, q2); assert.deepEqual(it[0].code_hits, []);
});
await t('검색어 없으면 code_hits 필드 자체가 없다', async () => {
  const it = (await get('/api/quotes?from=' + D1 + '&to=' + D1)).items;
  assert.ok(it.length > 0); assert.ok(it.every((x) => !('code_hits' in x)));
});
await app.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
