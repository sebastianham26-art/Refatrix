// =====================================================================
// 예정(계획) 라인 삭제 — 실 PostgreSQL 종단 검증 (2026-08-26)
//   대상: POST /api/transactions/plans/delete  (디렉터 전용)
//   요구(디렉터): 재무 > 거래등록 「예정 내역」에서 이미 경과된 건과 앞으로 예정된 건을
//                 **라인 단위로** 삭제한다. 고정비처럼 반복되는 항목도 한 회차만.
//                 마케팅 등 다른 출처도 동일. 삭제하면 **현금흐름에 반영**되어야 한다.
//   실행 조건: TEST_PG_URL(실 Postgres + 전체 마이그레이션). 없으면 skip.
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
const TAG = 'PDTEST';

const today = new Date().toISOString().slice(0, 10);
const ym = (d) => d.slice(0, 7);
function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10);
}
// 이번 달 15일 / 지난달 15일 / 다음 달 15일 (말일 클램프 회피용으로 15일 고정)
const M0 = `${ym(today)}-15`;
const MM1 = `${ym(addMonths(`${ym(today)}-01`, -1))}-15`;
const MP1 = `${ym(addMonths(`${ym(today)}-01`, 1))}-15`;
const MP2 = `${ym(addMonths(`${ym(today)}-01`, 2))}-15`;

async function boot() {
  ({ query } = await import('../src/db.js'));
  financeRoutes = (await import('../src/routes/financeRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  // ── 정리(재실행 멱등) ────────────────────────────────────────────
  await query(`DELETE FROM transactions WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM sales_invoices WHERE memo='${TAG}'`);
  await query(`DELETE FROM customers WHERE code='${TAG}C1'`);
  await query(`DELETE FROM recurring_rules WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'pdtest%')`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'pdtest%')`);
  await query(`DELETE FROM users WHERE login_id LIKE 'pdtest%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'pdtest_dir');
  ID.fin = await mkUser(`${TAG}재무`, 'treasury', 'pdtest_fin');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
               VALUES ($1,'transactions','anywhere','edit') ON CONFLICT DO NOTHING`, [ID.fin]);

  ID.acc = Number((await query(
    `INSERT INTO accounts (name, type, currency, open_balance, open_date, created_by)
     VALUES ($1,'bank','MXN',0,$2,$3) RETURNING id`, [`${TAG}은행`, MM1, ID.dir])).rows[0].id);

  // 고정비 규칙 — 매월 15일 10,000 지출
  ID.rule = Number((await query(
    `INSERT INTO recurring_rules (name, category_code, amount, direction, freq, currency, account_id,
                                  start_date, day_of_month, active, created_by, generated_through, end_month)
     VALUES ($1,'6020',10000,'out','month','MXN',$2,$3,15,true,$4,$5,$6) RETURNING id`,
    [`${TAG}임차료`, ID.acc, MM1, ID.dir, MP2, ym(MP1)])).rows[0].id);

  const mkTxn = async (o) => Number((await query(
    `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn,
        category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date,
        recurring_rule_id, recurring_period, sales_invoice_id)
     VALUES ($1,$2,$3,$4,'MXN',1,$4,$5,$6,'general',true,$7,$8,$7,$9,$10,$11,$12,$13) RETURNING id`,
    [o.account_id === undefined ? ID.acc : o.account_id, o.date, o.dir || 'out', o.amount, o.cat || '6020',
      o.status || 'plan', ID.dir, o.memo, o.status === 'actual' ? null : o.amount,
      o.status === 'actual' ? null : o.date, o.rule || null, o.period || null, o.inv || null])).rows[0].id);

  // ① 고정비 회차 3건(지난달=경과 · 이번달 · 다음달) — [생성]된 예정
  ID.fx0 = await mkTxn({ date: MM1, amount: 10000, memo: `[고정비] ${TAG}임차료`, rule: ID.rule, period: ym(MM1) });
  ID.fx1 = await mkTxn({ date: M0, amount: 10000, memo: `[고정비] ${TAG}임차료`, rule: ID.rule, period: ym(M0) });
  ID.fx2 = await mkTxn({ date: MP1, amount: 10000, memo: `[고정비] ${TAG}임차료`, rule: ID.rule, period: ym(MP1) });
  // ② 마케팅 계획 예정(계좌 미지정 = 마케팅 모듈이 만드는 형태)
  ID.mkt = await mkTxn({ account_id: null, date: M0, amount: 3000, cat: '6070', memo: `[마케팅] ${TAG}전시회 · 일시불` });
  // ③ 수동 예정
  ID.man = await mkTxn({ date: M0, amount: 1500, memo: `${TAG} 수동 예정` });
  // ④ 실적(집행 완료) — 삭제 대상 아님
  ID.act = await mkTxn({ date: MM1, amount: 777, status: 'actual', memo: `${TAG} 실적` });
  // ⑤ 매출 수금 예정(AR) — 삭제 불가
  ID.cust = Number((await query(
    `INSERT INTO customers (code, name, discount, credit_days) VALUES ($1,$1,0,30) RETURNING id`, [`${TAG}C1`])).rows[0].id);
  ID.inv = Number((await query(
    `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn, status, memo, created_by)
     VALUES ($1,$2,$3,30,$4,10000,1600,11600,'posted',$5,$6) RETURNING id`,
    [`${TAG}-A1`, ID.cust, MM1, MP1, TAG, ID.dir])).rows[0].id);
  ID.ar = await mkTxn({ account_id: null, date: MP1, dir: 'in', amount: 11600, cat: '4010',
    memo: `${TAG} 수금예정`, inv: ID.inv });

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(financeRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.fin = app.jwt.sign({ sub: ID.fin });
}

const call = async (who, method, url, body) => app.inject({ method, url, body,
  headers: { authorization: 'Bearer ' + tok[who] } });
const del = (who, ids, reason) => call(who, 'POST', '/api/transactions/plans/delete', { ids, reason });
const pending = async (who = 'dir') => ((await call(who, 'GET', '/api/transactions/pending-plans?all=1')).json().items || [])
  .map((t) => ({ ...t, id: Number(t.id) }));
const alive = async (id) => Number((await query(
  `SELECT COUNT(*)::int AS n FROM transactions WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0].n) === 1;

// 현금흐름(예정 포함·자동전개 포함)에서 이 테스트 계좌 기준 총 유출
async function cfOutflow(proj = 1) {
  const r = (await call('dir', 'GET',
    `/api/cashflow?granularity=month&includePlan=1&proj=${proj}&accounts=${ID.acc}`)).json();
  return (r.rows || []).reduce((s, x) => s + Number(x.outflow || 0), 0);
}
// 계좌미지정(마케팅·AR) 포함 전체 — 계좌 필터 없이
async function cfAll(proj = 1) {
  const r = (await call('dir', 'GET', `/api/cashflow?granularity=month&includePlan=1&proj=${proj}`)).json();
  return { out: (r.rows || []).reduce((s, x) => s + Number(x.outflow || 0), 0),
    inflow: (r.rows || []).reduce((s, x) => s + Number(x.inflow || 0), 0) };
}

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 예정 목록 준비 — 고정비 3회차·마케팅·수동·AR 이 모두 보이고, 실적은 안 보인다', { skip: SKIP }, async () => {
  const items = await pending();
  const mine = items.filter((t) => String(t.memo || '').includes(TAG));
  assert.equal(mine.length, 6, '고정비3 + 마케팅 + 수동 + AR 수금예정 = 6건');
  assert.ok(!mine.some((t) => t.id === ID.act), '실적은 예정 목록에 없음');
  const fx = mine.filter((t) => t.source === 'recurring');
  assert.equal(fx.length, 3);
  assert.ok(mine.find((t) => t.id === ID.fx0).overdue, '지난달 회차는 경과 표시');
  // 삭제 가능 플래그
  assert.equal(mine.find((t) => t.id === ID.mkt).can_delete, true);
  assert.equal(mine.find((t) => t.id === ID.ar).can_delete, false, 'AR 은 삭제 불가');
});

test('② 고정비 회차 1건만 삭제 — 나머지 회차·규칙은 그대로', { skip: SKIP }, async () => {
  const before = await cfOutflow(1);
  const res = await del('dir', [ID.fx1], '이번 달 임차료 면제분');
  assert.equal(res.statusCode, 200);
  const d = res.json();
  assert.equal(d.deleted, 1);
  assert.deepEqual(d.deleted_ids, [ID.fx1]);
  assert.equal(d.skipped.length, 0);

  assert.equal(await alive(ID.fx1), false, '삭제된 회차');
  assert.equal(await alive(ID.fx0), true, '지난달 회차 유지');
  assert.equal(await alive(ID.fx2), true, '다음달 회차 유지');
  const rule = (await query(`SELECT active, deleted_at FROM recurring_rules WHERE id=$1`, [ID.rule])).rows[0];
  assert.equal(rule.active, true); assert.equal(rule.deleted_at, null);

  const items = await pending();
  assert.ok(!items.some((t) => t.id === ID.fx1), '예정 목록에서 사라짐');
  assert.equal(items.filter((t) => t.source === 'recurring' && String(t.memo).includes(TAG)).length, 2);

  // ★ 현금흐름 반영: 정확히 10,000 감소
  const after = await cfOutflow(1);
  assert.equal(Math.round(before - after), 10000, '현금흐름 유출이 삭제액만큼 감소');
});

test('③ 삭제한 고정비 회차는 자동전개로도 되살아나지 않는다', { skip: SKIP }, async () => {
  const withProj = await cfOutflow(1);
  const noProj = await cfOutflow(0);
  assert.equal(Math.round(withProj), Math.round(noProj),
    '이번 달 회차를 지웠는데 자동전개가 같은 달을 다시 채우면 두 값이 달라진다');
  // 자동전개 경로 자체(월 예산 예측)에서도 이번 달 규칙 전개가 없어야 함
  const fc = (await call('dir', 'GET', `/api/cashflow/month?month=${ym(M0)}&forecast=1&proj=1`)).json();
  const txt = JSON.stringify(fc);
  assert.ok(!txt.includes(`${TAG}임차료`) || !txt.includes('"pj":1'),
    '삭제한 회차가 자동전개로 다시 나타나면 안 됨');
});

test('④ 삭제 사유는 plan_memo 에 남고 감사로그가 기록된다', { skip: SKIP }, async () => {
  const t = (await query(`SELECT plan_memo, updated_by FROM transactions WHERE id=$1`, [ID.fx1])).rows[0];
  assert.ok(String(t.plan_memo).includes('(계획삭제)'));
  assert.ok(String(t.plan_memo).includes('이번 달 임차료 면제분'));
  assert.equal(Number(t.updated_by), ID.dir);
  const n = Number((await query(
    `SELECT COUNT(*)::int AS n FROM audit_log WHERE target=$1 AND action='delete'`, [`transaction:${ID.fx1}`])).rows[0].n);
  assert.ok(n >= 1, '감사로그 기록');
});

test('⑤ 마케팅·수동 예정 일괄 삭제 → 현금흐름 동반 감소', { skip: SKIP }, async () => {
  const before = (await cfAll(1)).out;
  const d = (await del('dir', [ID.mkt, ID.man], '행사 취소')).json();
  assert.equal(d.deleted, 2);
  assert.equal(await alive(ID.mkt), false);
  assert.equal(await alive(ID.man), false);
  const after = (await cfAll(1)).out;
  assert.equal(Math.round(before - after), 4500, '3,000 + 1,500 감소');
  const items = await pending();
  assert.ok(!items.some((t) => t.id === ID.mkt || t.id === ID.man));
});

test('⑥ 매출 수금 예정은 삭제 불가(sales_linked) — 데이터 불변', { skip: SKIP }, async () => {
  const res = await del('dir', [ID.ar], 'x');
  assert.equal(res.statusCode, 200);
  const d = res.json();
  assert.equal(d.deleted, 0);
  assert.deepEqual(d.skipped, [{ id: ID.ar, error: 'sales_linked' }]);
  assert.equal(await alive(ID.ar), true);
});

test('⑦ 실적(actual)은 이 경로로 지울 수 없다(not_plan)', { skip: SKIP }, async () => {
  const d = (await del('dir', [ID.act])).json();
  assert.equal(d.deleted, 0);
  assert.deepEqual(d.skipped, [{ id: ID.act, error: 'not_plan' }]);
  assert.equal(await alive(ID.act), true);
});

test('⑧ 혼합 요청 — 지울 수 있는 것만 지우고 나머지는 사유와 함께 돌려준다', { skip: SKIP }, async () => {
  const d = (await del('dir', [ID.fx0, ID.ar, ID.act, 99999999], '정리')).json();
  assert.equal(d.deleted, 1);
  assert.deepEqual(d.deleted_ids, [ID.fx0]);
  const errs = Object.fromEntries(d.skipped.map((s) => [s.id, s.error]));
  assert.equal(errs[ID.ar], 'sales_linked');
  assert.equal(errs[ID.act], 'not_plan');
  assert.equal(errs[99999999], 'not_found');
  assert.equal(await alive(ID.fx0), false, '경과된 건도 삭제된다');
});

test('⑨ 재삭제는 멱등(not_found) — 두 번 눌러도 부작용 없음', { skip: SKIP }, async () => {
  const d = (await del('dir', [ID.fx0])).json();
  assert.equal(d.deleted, 0);
  assert.deepEqual(d.skipped, [{ id: ID.fx0, error: 'not_found' }]);
});

test('⑩ 비디렉터(재무담당)는 403 — 목록은 볼 수 있어도 계획 삭제는 불가', { skip: SKIP }, async () => {
  const list = await call('fin', 'GET', '/api/transactions/pending-plans?all=1');
  assert.equal(list.statusCode, 200, '예정 목록 열람은 가능');
  const res = await del('fin', [ID.fx2]);
  assert.equal(res.statusCode, 403);
  assert.equal(await alive(ID.fx2), true, '건드리지 않음');
});

test('⑪ 입력 검증 — 빈 ids 400 · 200건 초과 400 · 중복 id 는 1건으로', { skip: SKIP }, async () => {
  assert.equal((await del('dir', [])).statusCode, 400);
  assert.equal((await del('dir', Array.from({ length: 201 }, (_, i) => i + 1))).statusCode, 400);
  const d = (await del('dir', [ID.fx2, ID.fx2, ID.fx2], '중복')).json();
  assert.equal(d.requested, 1);
  assert.equal(d.deleted, 1);
});

test('⑫ 마무리 — 남은 예정은 AR 1건뿐, 실적·잔액 스트림은 불변', { skip: SKIP }, async () => {
  const items = (await pending()).filter((t) => String(t.memo || '').includes(TAG));
  assert.equal(items.length, 1);
  assert.equal(Number(items[0].id), ID.ar);
  const act = (await query(`SELECT amount, deleted_at FROM transactions WHERE id=$1`, [ID.act])).rows[0];
  assert.equal(Number(act.amount), 777);
  assert.equal(act.deleted_at, null);
});
