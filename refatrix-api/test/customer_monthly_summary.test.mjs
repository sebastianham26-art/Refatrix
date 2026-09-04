// =====================================================================
// 고객 「월별 견적 · 매출 · 수금」 요약 검증 — 실 PostgreSQL + 실 라우트(app.inject)
//
//   GET /api/customers/:id/monthly-summary?year=YYYY
//   확인하는 것:
//     · 견적 = 취소·가격표(pricelist)·삭제 제외, ex-IVA 소계, quote_date 월
//     · 매출 = status='posted' 만, ex-IVA 소계, inv_date 월
//     · 수금 = 현금 배분만(kind='nota_credito' 제외), pay_date 월,
//              실입금액을 **그 인보이스 IVA율**로 나눈 ex-IVA 환산액(8% 국경지대 포함)
//     · 선수금(advance)은 수금 칸에 들어가지 않고 따로 나온다
//     · 연도 목록 · 합계 · 전환율 · 미수/연체 · 팀 권한(403) · 잘못된 연도(400)
//     · 결제 지연 = 완납일 − 만기일 · **완납된 달**의 행에 · 건수 단순평균 · 미완납 제외
//       (평균·중앙값·정시율·최장·분포·실제 결제일수 vs 약정 외상일·아직 안 낸 연체)
//
//   실행: TEST_PG_URL=postgres://... node --test test/customer_monthly_summary.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, customerRoutes, Fastify, jwt, app;
const tok = {};
const ID = {};
const TAG = 'CMSUM';
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function boot() {
  ({ query } = await import('../src/db.js'));
  customerRoutes = (await import('../src/routes/customerRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  const CUSTS = `SELECT id FROM customers WHERE name LIKE '${TAG}%'`;
  const INVS = `SELECT id FROM sales_invoices WHERE customer_id IN (${CUSTS})`;
  const PAYS = `SELECT id FROM sales_payments WHERE customer_id IN (${CUSTS})`;
  await query(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (${INVS}) OR payment_id IN (${PAYS})`);
  try { await query(`DELETE FROM nota_credito_docs WHERE nc_id IN (SELECT id FROM notas_credito WHERE customer_id IN (${CUSTS}))`); } catch (_) {}
  try { await query(`DELETE FROM notas_credito WHERE customer_id IN (${CUSTS})`); } catch (_) {}
  await query(`DELETE FROM sales_payments WHERE customer_id IN (${CUSTS})`);
  await query(`DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM quotes WHERE customer_id IN (${CUSTS}))`);
  await query(`DELETE FROM quotes WHERE customer_id IN (${CUSTS})`);
  await query(`UPDATE sales_invoices SET txn_id=NULL WHERE customer_id IN (${CUSTS})`);
  await query(`DELETE FROM transactions WHERE sales_invoice_id IN (${INVS})`);
  await query(`DELETE FROM sales_invoice_lines WHERE invoice_id IN (${INVS})`);
  await query(`DELETE FROM sales_invoices WHERE customer_id IN (${CUSTS})`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'cmsum%')`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'cmsum%')`);
  await query(`DELETE FROM users WHERE login_id LIKE 'cmsum%'`);
  await query(`DELETE FROM sales_teams WHERE name LIKE '${TAG}%'`);

  const mkTeam = async (n) => Number((await query(
    `INSERT INTO sales_teams (name) VALUES ($1) RETURNING id`, [`${TAG}${n}`])).rows[0].id);
  ID.t1 = await mkTeam('T1');
  ID.t2 = await mkTeam('T2');

  const mkUser = async (name, role, login, teamId) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id, team_id) VALUES ($1,$2,'x',$3,$4) RETURNING id`,
    [name, role, login, teamId])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'cmsum_dir', null);
  ID.s1 = await mkUser(`${TAG}영업1`, 'sales', 'cmsum_s1', ID.t1);
  ID.s2 = await mkUser(`${TAG}영업2`, 'sales', 'cmsum_s2', ID.t2);
  for (const u of [ID.s1, ID.s2]) {
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
                 VALUES ($1,'customers','anywhere','view') ON CONFLICT DO NOTHING`, [u]);
  }

  ID.cust = Number((await query(
    `INSERT INTO customers (name, code, credit_days, team_id, owner_id, created_by)
     VALUES ($1,$2,30,$3,$4,$4) RETURNING id`,
    [`${TAG}고객A`, `${TAG}-A`, ID.t1, ID.dir])).rows[0].id);
  ID.cust2 = Number((await query(
    `INSERT INTO customers (name, code, credit_days, team_id, owner_id, created_by)
     VALUES ($1,$2,30,$3,$4,$4) RETURNING id`,
    [`${TAG}고객B`, `${TAG}-B`, ID.t2, ID.dir])).rows[0].id);

  // ── 견적 ────────────────────────────────────────────────────────────
  const mkQuote = async (no, date, status, sub, opt = {}) => {
    const id = Number((await query(
      `INSERT INTO quotes (quote_no, customer_id, quote_date, discount_rate, iva_rate, status,
                           subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, created_by)
       VALUES ($1,$2,$3,0,16,$4,$5,$6,$7,0,0,$8) RETURNING id`,
      [`${TAG}-${no}`, ID.cust, date, status, sub, r2(sub * 0.16), r2(sub * 1.16), ID.dir])).rows[0].id);
    if (opt.deleted) await query(`UPDATE quotes SET deleted_at=now() WHERE id=$1`, [id]);
    return id;
  };
  await mkQuote('Q1', '2026-03-05', 'draft', 1000);
  await mkQuote('Q2', '2026-03-20', 'confirmed', 2000);
  await mkQuote('Q3', '2026-03-25', 'cancelled', 9999);          // 제외
  await mkQuote('Q4', '2026-03-28', 'pricelist', 0);             // 제외(가격표)
  await mkQuote('Q5', '2026-03-30', 'confirmed', 4444, { deleted: true }); // 제외(삭제)
  await mkQuote('Q6', '2026-04-10', 'converted', 3000);
  await mkQuote('Q7', '2026-04-12', 'expired', 500);
  await mkQuote('Q8', '2025-05-01', 'confirmed', 777);           // 다른 해 → 연도 목록에만

  // ── 매출(인보이스) ──────────────────────────────────────────────────
  const mkInv = async (sat, date, sub, status = 'posted', ivaRate = 16, due = null) => Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, iva_rate,
                                 subtotal_mxn, iva_mxn, total_mxn, status, owner_id, memo, created_by)
     VALUES ($1,$2,$3,30,$4,$5,$6,$7,$8,$9,$10,$11,$10) RETURNING id`,
    [sat, ID.cust, date, due, ivaRate, sub, r2(sub * ivaRate / 100), r2(sub * (1 + ivaRate / 100)),
      status, ID.dir, `${TAG} ${sat}`])).rows[0].id);
  ID.inv1 = await mkInv(`${TAG}-I1`, '2026-04-15', 2500, 'posted', 16, '2026-05-15'); // total 2900
  ID.inv2 = await mkInv(`${TAG}-I2`, '2026-05-02', 1000, 'posted', 16, '2026-06-01'); // total 1160
  ID.inv3 = await mkInv(`${TAG}-I3`, '2026-07-01', 1000, 'posted', 8, '2026-08-01');  // total 1080 (국경 8%)
  ID.invDel = await mkInv(`${TAG}-ID`, '2026-05-10', 5000, 'deleted');                // 제외

  // ── 수금 ────────────────────────────────────────────────────────────
  ID.acc = Number((await query(
    `SELECT id FROM accounts ORDER BY id LIMIT 1`)).rows[0]?.id
    || (await query(`INSERT INTO accounts (name, type, currency, open_balance, created_by)
                     VALUES ($1,'bank','MXN',0,$2) RETURNING id`, [`${TAG}은행`, ID.dir])).rows[0].id);
  const mkPay = async (date, amount, advance = 0) => Number((await query(
    `INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, advance_amount, memo, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ID.cust, date, ID.acc, amount, advance, `${TAG} pago`, ID.dir])).rows[0].id);
  const alloc = async (payId, invId, amount, kind = 'cash') => query(
    `INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, kind) VALUES ($1,$2,$3,$4)`,
    [payId, invId, amount, kind]);

  const p1 = await mkPay('2026-05-20', 1160);            // inv2 완납 → ex 1000
  await alloc(p1, ID.inv2, 1160);
  const p2 = await mkPay('2026-06-01', 1450, 290);       // inv1 부분 1160 + 선수금 290
  await alloc(p2, ID.inv1, 1160);
  const p3 = await mkPay('2026-07-20', 1080);            // inv3(8%) 완납 → ex 1000
  await alloc(p3, ID.inv3, 1080);
  const p4 = await mkPay('2026-08-05', 500);             // 비현금 반제 — 수금에서 빠져야 한다
  await alloc(p4, ID.inv1, 500, 'nota_credito');

  // ── 결제 지연 전용 고객 C (기존 고객 A 의 기대값을 건드리지 않으려고 분리) ─────
  ID.cust3 = Number((await query(
    `INSERT INTO customers (name, code, credit_days, team_id, owner_id, created_by)
     VALUES ($1,$2,30,$3,$4,$4) RETURNING id`,
    [`${TAG}고객C`, `${TAG}-C`, ID.t1, ID.dir])).rows[0].id);
  const mkInvC = async (sat, date, due, sub) => Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, iva_rate,
                                 subtotal_mxn, iva_mxn, total_mxn, status, owner_id, memo, created_by)
     VALUES ($1,$2,$3,30,$4,16,$5,$6,$7,'posted',$8,$9,$8) RETURNING id`,
    [sat, ID.cust3, date, due, sub, r2(sub * 0.16), r2(sub * 1.16), ID.dir, `${TAG} ${sat}`])).rows[0].id);
  const payC = async (date, amount, invId) => {
    const pid = Number((await query(
      `INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, advance_amount, memo, created_by)
       VALUES ($1,$2,$3,$4,0,$5,$6) RETURNING id`,
      [ID.cust3, date, ID.acc, amount, `${TAG} pago`, ID.dir])).rows[0].id);
    await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, kind)
                 VALUES ($1,$2,$3,'cash')`, [pid, invId, amount]);
  };
  //  지연 +20 (3월 완납) · 정시 0 (3월) · 조기 −12 (5월) · +76 (6월) · 조기 −12 (7월) · 미완납 연체 1건
  ID.c1 = await mkInvC(`${TAG}-C1`, '2026-01-10', '2026-02-09', 1000); await payC('2026-03-01', 1160, ID.c1);
  ID.c2 = await mkInvC(`${TAG}-C2`, '2026-02-01', '2026-03-03', 2000); await payC('2026-03-03', 2320, ID.c2);
  ID.c3 = await mkInvC(`${TAG}-C3`, '2026-05-02', '2026-06-01', 1000); await payC('2026-05-20', 1160, ID.c3);
  ID.c4 = await mkInvC(`${TAG}-C4`, '2026-03-01', '2026-03-31',  500); await payC('2026-06-15',  580, ID.c4);
  ID.c5 = await mkInvC(`${TAG}-C5`, '2026-07-01', '2026-08-01', 1000); await payC('2026-07-20', 1160, ID.c5);
  ID.c6 = await mkInvC(`${TAG}-C6`, '2026-04-01', '2026-05-01', 1000);   // 미완납 — 평균에서 빠져야 한다


  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(customerRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.s1 = app.jwt.sign({ sub: ID.s1 });
  tok.s2 = app.jwt.sign({ sub: ID.s2 });
}
const get = (who, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[who] } });
const M = (d, n) => d.months.find((m) => m.month === n);

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 견적 — 취소·가격표·삭제는 빠지고 ex-IVA 소계로 월별 합산된다', { skip: SKIP }, async () => {
  const r = await get('dir', `/api/customers/${ID.cust}/monthly-summary?year=2026`);
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.locked, false);
  assert.equal(M(d, 3).quote_count, 2, '3월 = draft + confirmed 두 건(취소·가격표·삭제 제외)');
  assert.equal(M(d, 3).quote_amount, 3000);
  assert.equal(M(d, 4).quote_count, 2, '4월 = converted + expired');
  assert.equal(M(d, 4).quote_amount, 3500);
  assert.equal(M(d, 4).quote_converted_amount, 3000, '전환분은 따로 센다');
  assert.equal(M(d, 1).quote_count, 0);
  assert.equal(M(d, 1).quote_amount, 0);
});

test('② 매출 — posted 만, ex-IVA 소계, 인보이스일 월', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/customers/${ID.cust}/monthly-summary?year=2026`)).json();
  assert.equal(M(d, 4).sales_amount, 2500);
  assert.equal(M(d, 4).sales_amount_incl, 2900, 'IVA 포함액도 참고로 준다');
  assert.equal(M(d, 5).sales_amount, 1000, '5월의 deleted 인보이스 5,000 은 빠진다');
  assert.equal(M(d, 5).sales_count, 1);
  assert.equal(M(d, 7).sales_amount, 1000);
});

test('③ 수금 — 실입금액을 그 인보이스 IVA율로 나눈 ex-IVA 환산 (16% · 8%)', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/customers/${ID.cust}/monthly-summary?year=2026`)).json();
  assert.equal(M(d, 5).collect_amount_incl, 1160, '5월 실입금');
  assert.equal(M(d, 5).collect_amount, 1000, '1,160 ÷ 1.16');
  assert.equal(M(d, 6).collect_amount_incl, 1160);
  assert.equal(M(d, 6).collect_amount, 1000);
  assert.equal(M(d, 7).collect_amount_incl, 1080, '국경지대 8% 인보이스');
  assert.equal(M(d, 7).collect_amount, 1000, '1,080 ÷ 1.08 — 인보이스별 세율을 쓴다');
});

test('④ 비현금 반제(nota_credito)는 수금이 아니다 · 선수금도 수금 칸에 안 들어간다', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/customers/${ID.cust}/monthly-summary?year=2026`)).json();
  assert.equal(M(d, 8).collect_amount_incl, 0, '8월 500 은 nota_credito 배분 — 수금 0');
  assert.equal(M(d, 8).collect_amount, 0);
  assert.equal(M(d, 6).advance_amount_incl, 290, '선수금은 따로 표시');
  assert.equal(M(d, 6).collect_amount_incl, 1160, '선수금 290 은 수금에 안 섞인다');
});

test('⑤ 합계 · 전환율 · 미수/연체', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/customers/${ID.cust}/monthly-summary?year=2026`)).json();
  const t = d.totals;
  assert.equal(t.quote_count, 4);
  assert.equal(t.quote_amount, 6500);
  assert.equal(t.quote_converted_amount, 3000);
  assert.equal(t.conversion_pct, 46.2, '3,000 / 6,500');
  assert.equal(t.sales_count, 3);
  assert.equal(t.sales_amount, 4500);
  assert.equal(t.collect_amount, 3000);
  assert.equal(t.collect_amount_incl, 3400);
  assert.equal(t.advance_amount_incl, 290);
  // 미수 = (2900−1660) + 0 + 0 = 1240  ※ NC 배분 500 도 잔액을 줄인다
  assert.equal(d.ar.outstanding, 1240);
});

test('⑥ 연도 목록 — 거래가 있는 해가 최신순으로 나온다', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/customers/${ID.cust}/monthly-summary?year=2026`)).json();
  assert.ok(d.years.includes(2026));
  assert.ok(d.years.includes(2025), '2025 견적 한 건 때문에 2025 도 있어야 한다');
  assert.deepEqual(d.years, [...d.years].sort((a, b) => b - a), '최신순');
  const y25 = (await get('dir', `/api/customers/${ID.cust}/monthly-summary?year=2025`)).json();
  assert.equal(y25.year, 2025);
  assert.equal(M(y25, 5).quote_amount, 777);
  assert.equal(y25.totals.sales_amount, 0);
});

test('⑦ year 를 안 주면 올해', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/customers/${ID.cust}/monthly-summary`)).json();
  assert.equal(d.year, new Date().getFullYear());
  assert.equal(d.months.length, 12);
});

test('⑧ 권한 — 같은 팀 영업은 보이고, 다른 팀은 403', { skip: SKIP }, async () => {
  const ok = await get('s1', `/api/customers/${ID.cust}/monthly-summary?year=2026`);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().locked, false, '매출 금액은 전 직원 공개(영업 대시보드와 동일 기준)');
  assert.equal(ok.json().totals.sales_amount, 4500);
  const no = await get('s2', `/api/customers/${ID.cust}/monthly-summary?year=2026`);
  assert.equal(no.statusCode, 403);
  assert.equal(no.json().error, 'forbidden_team');
});

test('⑨ 잘못된 입력 — 연도·아이디', { skip: SKIP }, async () => {
  assert.equal((await get('dir', `/api/customers/${ID.cust}/monthly-summary?year=1999`)).statusCode, 400);
  assert.equal((await get('dir', `/api/customers/${ID.cust}/monthly-summary?year=abc`)).statusCode, 400);
  assert.equal((await get('dir', `/api/customers/0/monthly-summary`)).statusCode, 400);
  assert.equal((await get('dir', `/api/customers/99999999/monthly-summary`)).statusCode, 404);
});

// ── 결제 지연 (2026-09-04 추가) ───────────────────────────────────────────
test('⑩ 지연 — 완납된 달의 행에 붙고, 그 달 완납 건의 단순평균', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/customers/${ID.cust3}/monthly-summary?year=2026`)).json();
  assert.equal(M(d, 3).settled_count, 2, '3월에 두 건 완납(+20, 정시)');
  assert.equal(M(d, 3).delay_avg, 10, '(20 + 0) / 2');
  assert.equal(M(d, 5).settled_count, 1);
  assert.equal(M(d, 5).delay_avg, -12, '만기 12일 전에 냄 = 조기(음수)');
  assert.equal(M(d, 6).delay_avg, 76);
  assert.equal(M(d, 7).delay_avg, -12);
  assert.equal(M(d, 1).settled_count, 0, '1월은 발행만 있고 완납은 3월 — 발행월이 아니라 완납월에 붙는다');
  assert.equal(M(d, 1).delay_avg, null);
});

test('⑪ 지연 요약 — 평균·중앙값·정시율·최장·분포', { skip: SKIP }, async () => {
  const dl = (await get('dir', `/api/customers/${ID.cust3}/monthly-summary?year=2026`)).json().delay;
  assert.equal(dl.settled_count, 5, '미완납 1건은 빠진다');
  assert.equal(dl.avg_delay, 14.4, '(-12 -12 +0 +20 +76) / 5');
  assert.equal(dl.median_delay, 0, '평균은 76 하나에 끌려가지만 중앙값은 정시');
  assert.equal(dl.on_time_count, 3);
  assert.equal(dl.on_time_pct, 60);
  assert.equal(dl.worst.delay, 76);
  assert.equal(dl.worst.sat_no, `${TAG}-C4`);
  assert.equal(dl.worst.due_date, '2026-03-31');
  assert.equal(dl.worst.settled_date, '2026-06-15');
  assert.deepEqual(dl.buckets, { early_ontime: 3, d1_7: 0, d8_30: 1, d30plus: 1 });
});

test('⑫ 지연 — 실제 결제일수 평균과 약정 외상일', { skip: SKIP }, async () => {
  const dl = (await get('dir', `/api/customers/${ID.cust3}/monthly-summary?year=2026`)).json().delay;
  // 인보이스일 → 완납일: 50, 30, 18, 106, 19 일
  assert.equal(dl.avg_actual_days, 44.6);
  assert.equal(dl.avg_credit_days, 30, '약정 30일인데 실제로는 평균 44.6일 걸렸다는 뜻');
});

test('⑬ 지연 — 미완납은 평균에서 빠지고 「아직 안 낸 연체」로 따로 나온다', { skip: SKIP }, async () => {
  const dl = (await get('dir', `/api/customers/${ID.cust3}/monthly-summary?year=2026`)).json().delay;
  assert.equal(dl.open_overdue.count, 1, 'C6(만기 2026-05-01, 미완납)');
  assert.ok(dl.open_overdue.max_days > 0, '오늘 기준 경과일');
  assert.equal(dl.open_overdue.amount, 1160);

  // 고객 A: 부분수금 + NC 로 남은 I1 이 연체로 잡히고, 완납된 두 건만 평균에 들어간다
  const a = (await get('dir', `/api/customers/${ID.cust}/monthly-summary?year=2026`)).json().delay;
  assert.equal(a.settled_count, 2, 'I2 · I3 만 완납');
  assert.equal(a.avg_delay, -12);
  assert.equal(a.open_overdue.count, 1);
  assert.equal(a.open_overdue.amount, 1240);
});

test('⑭ 지연 — 거래가 없는 해는 빈 값(0으로 착각할 값이 안 나온다)', { skip: SKIP }, async () => {
  const dl = (await get('dir', `/api/customers/${ID.cust3}/monthly-summary?year=2024`)).json().delay;
  assert.equal(dl.settled_count, 0);
  assert.equal(dl.avg_delay, null);
  assert.equal(dl.median_delay, null);
  assert.equal(dl.worst, null);
  assert.equal(dl.on_time_pct, null);
});

test('⑮ 회귀 — 기존 고객 상세(/api/customers/:id)가 그대로 동작', { skip: SKIP }, async () => {
  const r = await get('dir', `/api/customers/${ID.cust}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().customer);
  assert.ok(Array.isArray(r.json().invoices));
});
