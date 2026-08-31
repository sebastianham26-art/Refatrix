// =====================================================================
// 수금/정산 「완납일 · 만기 대비 지연」 검증
//   A. 백엔드 종단 — 실 PostgreSQL(0001~0191) + 실 라우트
//      /api/ar/open-list · /api/ar/search · /api/ar/invoice/:id/payments 의
//      settled_date(마지막 반제일) · settled_delay(완납일−만기일) · settled_has_nc
//   B. 프런트 순수 — refatrix-settlement.html 의 표시 헬퍼를 추출해 vm 실행
//
//   실행: TEST_PG_URL=postgres://... node --test test/ar_settled_date.test.mjs
//   TEST_PG_URL 없으면 A 는 skip, B 는 항상 실행.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 백엔드 종단(A) 생략, 프런트(B)만 실행');
if (PG) process.env.DATABASE_URL = PG;

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = resolve(HERE, '..', '..', 'refatrix-settlement.html');

// ---------------------------------------------------------------------
// B. 프런트 순수 — 화면 파일에서 헬퍼를 그대로 뽑아 실행(테스트-코드 드리프트 방지)
// ---------------------------------------------------------------------
function loadFrontHelpers() {
  const src = readFileSync(HTML, 'utf8');
  const names = ['arSettledDate', 'arSettledDelay', 'arSettledDateCell', 'arDelayCell', 'arDelayText', 'arSettledStats'];
  let code = 'function esc(s){return String(s==null?"":s);}\n';
  for (const n of names) {
    const m = new RegExp(`\\n  function ${n}\\(([\\s\\S]*?)\\n  \\}`).exec(src);
    assert.ok(m, `${n} 를 refatrix-settlement.html 에서 찾지 못했습니다`);
    code += `function ${n}(${m[1]}\n}\n`;
  }
  code += `module = { ${names.join(', ')} };`;
  const ctx = { module: null };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.module;
}

const F = loadFrontHelpers();

test('B1. 완납 건만 완납일을 노출한다 (미수 건은 마지막 부분수금일이 와도 숨김)', () => {
  assert.equal(F.arSettledDate({ paid_full: true, settled_date: '2026-08-14' }), '2026-08-14');
  assert.equal(F.arSettledDate({ paid_full: false, settled_date: '2026-08-14' }), null, '미수 건은 표시하지 않는다');
  assert.equal(F.arSettledDate({ paid_full: true, settled_date: null }), null);
});

test('B2. 지연/정시/조기 문구', () => {
  assert.equal(F.arDelayText({ paid_full: true, settled_delay: 12 }), '+12일 지연');
  assert.equal(F.arDelayText({ paid_full: true, settled_delay: 0 }), '정시');
  assert.equal(F.arDelayText({ paid_full: true, settled_delay: -3 }), '-3일 조기');
  assert.equal(F.arDelayText({ paid_full: true, settled_delay: null }), '—', '만기일 없는 인보이스');
  assert.equal(F.arDelayText({ paid_full: false, settled_delay: 12 }), '—', '미수 건은 지연을 계산하지 않는다');
});

test('B3. 지연은 빨강, 정시는 브랜드색, 조기는 흐리게', () => {
  assert.match(F.arDelayCell({ paid_full: true, settled_delay: 12 }), /var\(--expense\)/);
  assert.match(F.arDelayCell({ paid_full: true, settled_delay: 12 }), /\+12일 지연/);
  assert.match(F.arDelayCell({ paid_full: true, settled_delay: 0 }), /var\(--brand\)/);
  assert.match(F.arDelayCell({ paid_full: true, settled_delay: -3 }), /hint/);
});

test('B4. NC 가 섞인 완납 건은 「NC」 칩이 붙는다(현금 100% 아님)', () => {
  const withNc = F.arSettledDateCell({ paid_full: true, settled_date: '2026-08-14', settled_has_nc: true });
  const cash = F.arSettledDateCell({ paid_full: true, settled_date: '2026-08-14', settled_has_nc: false });
  assert.match(withNc, />NC</);
  assert.equal(/>NC</.test(cash), false);
  assert.match(cash, /2026-08-14/);
});

test('B5. 통계 — 평균 지연 · 정시납 비율 (정시=만기일 당일 포함)', () => {
  const list = [
    { paid_full: true, settled_delay: 10 },
    { paid_full: true, settled_delay: 0 },
    { paid_full: true, settled_delay: -4 },
    { paid_full: true, settled_delay: 2 },
    { paid_full: false, settled_delay: 99 },   // 미수 → 제외
    { paid_full: true, settled_delay: null },  // 만기 없음 → 제외
  ];
  const st = F.arSettledStats(list);
  assert.equal(st.n, 4);
  assert.equal(st.avg, 2);              // (10 + 0 - 4 + 2) / 4
  assert.equal(st.onTimePct, 50);       // 0, -4 = 정시 이내 → 2/4
  assert.equal(F.arSettledStats([{ paid_full: false }]), null, '완납이 없으면 통계 없음');
});

// ---------------------------------------------------------------------
// A. 백엔드 종단
// ---------------------------------------------------------------------
let query, financeRoutes, Fastify, jwt, app;
const tok = {};
const ID = {};
const TAG = 'ARSETTLE';
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function boot() {
  ({ query } = await import('../src/db.js'));
  financeRoutes = (await import('../src/routes/financeRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  const TAGACC = `SELECT id FROM accounts WHERE name LIKE '${TAG}%'`;
  const TAGPAY = `SELECT id FROM sales_payments WHERE account_id IN (${TAGACC}) OR memo LIKE '%${TAG}%'`;
  await query(`DELETE FROM bank_deposit_payments WHERE payment_id IN (${TAGPAY})`);
  await query(`DELETE FROM sales_payment_allocations WHERE payment_id IN (${TAGPAY})`);
  await query(`DELETE FROM sales_payment_allocations WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE memo LIKE '%${TAG}%')`);
  await query(`UPDATE sales_payments SET advance_txn_id=NULL WHERE id IN (${TAGPAY})`);
  await query(`DELETE FROM sales_payments WHERE account_id IN (${TAGACC}) OR memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM nota_credito_docs WHERE nc_id IN (SELECT id FROM notas_credito WHERE concepto LIKE '%${TAG}%')`);
  await query(`DELETE FROM notas_credito WHERE concepto LIKE '%${TAG}%'`);
  await query(`DELETE FROM transactions WHERE memo LIKE '%${TAG}%' OR account_id IN (${TAGACC})`);
  await query(`DELETE FROM sales_invoices WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'arsettle%')`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM users WHERE login_id LIKE 'arsettle%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'arsettle_dir');
  ID.sup = await mkUser(`${TAG}영업지원`, 'sales_support', 'arsettle_sup');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
               VALUES ($1,'settlement','anywhere','edit') ON CONFLICT DO NOTHING`, [ID.sup]);

  ID.acc = Number((await query(
    `INSERT INTO accounts (name, type, currency, open_balance, created_by) VALUES ($1,'bank','MXN',0,$2) RETURNING id`,
    [`${TAG}은행`, ID.dir])).rows[0].id);
  ID.cust = Number((await query(
    `INSERT INTO customers (name, code, credit_days, created_by) VALUES ($1,$2,30,$3) RETURNING id`,
    [`${TAG}고객`, `${TAG}-1`, ID.dir])).rows[0].id);

  // 만기 전부 2026-07-31 로 통일 → 지연 계산이 한눈에 검증된다.
  const mkInv = async (sat, sub) => Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,'2026-07-01',30,'2026-07-31',$3,$4,$5,'posted',$6,$7,$6) RETURNING id`,
    [sat, ID.cust, sub, r2(sub * 0.16), r2(sub * 1.16), ID.dir, `${TAG} ${sat}`])).rows[0].id);

  // 반제(현금) 헬퍼 — 라우트를 타지 않고 직접 넣어 날짜를 자유롭게 만든다.
  const payCash = async (invId, amount, payDate) => {
    const pid = Number((await query(
      `INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, memo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ID.cust, payDate, ID.acc, amount, `${TAG} 수금`, ID.dir])).rows[0].id);
    await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, kind) VALUES ($1,$2,$3,'cash')`, [pid, invId, amount]);
    return pid;
  };

  // ① 지연 완납: 만기 7/31 · 완납 8/12 → +12일
  ID.late = await mkInv(`${TAG}-LATE`, 10000);
  await payCash(ID.late, 5000, '2026-07-20');     // 부분수금(중간 날짜 — 완납일이 아니다)
  await payCash(ID.late, 6600, '2026-08-12');     // 이 날 100% 채워짐
  // ② 조기 완납: 완납 7/28 → -3일
  ID.early = await mkInv(`${TAG}-EARLY`, 10000);
  await payCash(ID.early, 11600, '2026-07-28');
  // ③ 정시 완납: 완납 7/31 → 0
  ID.ontime = await mkInv(`${TAG}-ONTIME`, 10000);
  await payCash(ID.ontime, 11600, '2026-07-31');
  // ④ 미수(부분수금만): settled 는 화면에서 감춰진다
  ID.open = await mkInv(`${TAG}-OPEN`, 10000);
  await payCash(ID.open, 3000, '2026-08-01');
  // ⑤ NC 혼합 완납: 현금 8/05 + NC 8/20 적용 → 완납일 8/20 · has_nc
  ID.nc = await mkInv(`${TAG}-NC`, 10000);
  await payCash(ID.nc, 10000, '2026-08-05');
  const ncId = Number((await query(
    `INSERT INTO notas_credito (invoice_id, customer_id, concepto, total_mxn, base_mxn, iva_mxn, status, created_by, approved_by, approved_at, applied_at)
     VALUES ($1,$2,$3,1600,1379.31,220.69,'applied',$4,$4,'2026-08-18','2026-08-20') RETURNING id`,
    [ID.nc, ID.cust, `${TAG} 조기입금 할인`, ID.dir])).rows[0].id);
  await query(`INSERT INTO sales_payment_allocations (invoice_id, amount, kind, nc_id) VALUES ($1,1600,'nota_credito',$2)`, [ID.nc, ncId]);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(financeRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.sup = app.jwt.sign({ sub: ID.sup });
}
const get = (who, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[who] } });
const byId = (items, id) => items.find((x) => x.id === id);

test('A. boot', { skip: SKIP }, async () => { await boot(); });

test('A1. open-list(완납 포함) — 완납일 = 마지막 반제일, 지연 = 완납일 − 만기일', { skip: SKIP }, async () => {
  const r = await get('sup', '/api/ar/open-list?closed=1');
  assert.equal(r.statusCode, 200, r.body);
  const items = r.json().items;

  const late = byId(items, ID.late);
  assert.equal(late.paid_full, true);
  assert.equal(late.settled_date, '2026-08-12', '중간 부분수금(7/20)이 아니라 100% 채운 날');
  assert.equal(late.settled_delay, 12);
  assert.equal(late.settled_has_nc, false);

  assert.equal(byId(items, ID.early).settled_date, '2026-07-28');
  assert.equal(byId(items, ID.early).settled_delay, -3, '조기 완납은 음수');
  assert.equal(byId(items, ID.ontime).settled_delay, 0, '만기 당일은 0');
});

test('A2. NC 혼합 완납 — 완납일은 NC 적용일, has_nc=true', { skip: SKIP }, async () => {
  const items = (await get('sup', '/api/ar/open-list?closed=1')).json().items;
  const nc = byId(items, ID.nc);
  assert.equal(nc.paid_full, true);
  assert.equal(nc.settled_date, '2026-08-20', 'NC 적용일(applied_at)이 마지막 반제일');
  assert.equal(nc.settled_delay, 20);
  assert.equal(nc.settled_has_nc, true, '현금 100%가 아님을 화면이 드러낼 수 있어야 한다');
});

test('A3. 미수 건 — 서버는 마지막 부분수금일을 주지만 완납이 아니므로 화면은 숨긴다', { skip: SKIP }, async () => {
  const items = (await get('sup', '/api/ar/open-list?closed=1')).json().items;
  const op = byId(items, ID.open);
  assert.equal(op.paid_full, false);
  assert.equal(op.settled_date, '2026-08-01');
  assert.equal(F.arSettledDate(op), null, '프런트 헬퍼가 미수 건을 걸러낸다');
  assert.equal(F.arDelayText(op), '—');
});

test('A4. 기본 목록(미수만)은 완납 건을 그대로 제외한다 — 회귀', { skip: SKIP }, async () => {
  const items = (await get('sup', '/api/ar/open-list')).json().items;
  assert.equal(byId(items, ID.late), undefined);
  assert.ok(byId(items, ID.open), '미수 건은 남는다');
});

test('A5. 검색(/api/ar/search)에도 같은 값이 실린다', { skip: SKIP }, async () => {
  const r = await get('sup', `/api/ar/search?q=${encodeURIComponent(TAG)}`);
  assert.equal(r.statusCode, 200, r.body);
  const late = byId(r.json().items, ID.late);
  assert.equal(late.settled_date, '2026-08-12');
  assert.equal(late.settled_delay, 12);
});

test('A6. 수금내역 드릴다운 요약에도 완납일·지연이 들어간다', { skip: SKIP }, async () => {
  const r = await get('sup', `/api/ar/invoice/${ID.late}/payments`);
  assert.equal(r.statusCode, 200, r.body);
  const inv = r.json().invoice;
  assert.equal(inv.paid_full, true);
  assert.equal(inv.settled_date, '2026-08-12');
  assert.equal(inv.settled_delay, 12);
  assert.equal(r.json().payments.length, 2, '부분수금 2건이 모두 보인다');
});

test('A7. 만기일 없는 인보이스는 지연이 null (완납일만)', { skip: SKIP }, async () => {
  const id = Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn,
                                 status, owner_id, memo, created_by)
     VALUES ($1,$2,'2026-07-01',0,NULL,10000,1600,11600,'posted',$3,$4,$3) RETURNING id`,
    [`${TAG}-NODUE`, ID.cust, ID.dir, `${TAG} NODUE`])).rows[0].id);
  const pid = Number((await query(
    `INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, memo, created_by)
     VALUES ($1,'2026-08-09',$2,11600,$3,$4) RETURNING id`, [ID.cust, ID.acc, `${TAG} 수금`, ID.dir])).rows[0].id);
  await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount, kind) VALUES ($1,$2,11600,'cash')`, [pid, id]);

  const it = byId((await get('sup', '/api/ar/open-list?closed=1')).json().items, id);
  assert.equal(it.settled_date, '2026-08-09');
  assert.equal(it.settled_delay, null);
  assert.equal(F.arDelayText(it), '—');
});

test('A. cleanup', { skip: SKIP }, async () => {
  const { pool } = await import('../src/db.js');
  await app.close();
  await pool.end();
});
