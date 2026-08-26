// =====================================================================
// 재무 > 거래목록 엑셀 내보내기 — 실 PostgreSQL 종단 검증 (2026-08-26)
//   요구(디렉터): "거래목록 페이지를 엑셀로 받을 수 있게. **나만** 받을 수 있으면 된다."
//   대상: GET /api/transactions/export  (requireDirector)
//   핵심: 화면 목록의 LIMIT 200 과 달리 **필터에 걸린 전부**를 준다.
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
const TAG = 'TXETEST';
const BULK = 205;           // 화면 LIMIT 200 을 넘겨야 의미가 있다

async function boot() {
  ({ query } = await import('../src/db.js'));
  financeRoutes = (await import('../src/routes/financeRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  await query(`DELETE FROM transactions WHERE memo LIKE '%${TAG}%'`);
  await query(`DELETE FROM recurring_rules WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM user_account_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'txetest%')`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'txetest%')`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'txetest%')`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM users WHERE login_id LIKE 'txetest%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'txetest_dir');
  ID.fin = await mkUser(`${TAG}재무`, 'treasury', 'txetest_fin');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
               VALUES ($1,'transactions','anywhere','edit') ON CONFLICT DO NOTHING`, [ID.fin]);

  ID.acc = Number((await query(
    `INSERT INTO accounts (name, type, currency, open_balance, created_by)
     VALUES ($1,'bank','MXN',0,$2) RETURNING id`, [`${TAG}은행`, ID.dir])).rows[0].id);
  await query(`INSERT INTO user_account_access (user_id, account_id, can_operate, can_detail)
               VALUES ($1,$2,true,true) ON CONFLICT DO NOTHING`, [ID.fin, ID.acc]);

  ID.rule = Number((await query(
    `INSERT INTO recurring_rules (name, category_code, amount, direction, freq, currency, account_id,
                                  start_date, day_of_month, active, created_by, end_month)
     VALUES ($1,'6020',10000,'out','month','MXN',$2,'2026-01-15',15,true,$3,'2026-01') RETURNING id`,
    [`${TAG}임차료`, ID.acc, ID.dir])).rows[0].id);

  const mkTxn = async (o) => Number((await query(
    `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn,
        category_code, status, kind, approved, owner_id, memo, created_by, plan_amount, plan_date,
        recurring_rule_id, receipt_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'general',$10,$11,$12,$11,$13,$14,$15,$16) RETURNING id`,
    [o.account_id === undefined ? ID.acc : o.account_id, o.date, o.dir || 'out', o.amount, o.cur || 'MXN',
      o.fx || 1, o.amount * (o.fx || 1), o.cat || '6030', o.status || 'actual', o.approved !== false, ID.dir,
      o.memo, o.status === 'plan' ? o.amount : null, o.status === 'plan' ? o.date : null,
      o.rule || null, o.receipt || null])).rows[0].id);

  // 대량(실적 지출) — 화면 200건 제한을 넘기기 위한 물량
  for (let i = 0; i < BULK; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    await mkTxn({ date: `2026-03-${day}`, amount: 100 + i, memo: `${TAG} 대량 ${i}` });
  }
  // 특징 있는 소수 건
  ID.fx = await mkTxn({ date: '2026-04-15', amount: 10000, cat: '6020', status: 'plan',
    memo: `[고정비] ${TAG}임차료`, rule: ID.rule });
  ID.mkt = await mkTxn({ account_id: null, date: '2026-04-20', amount: 3000, cat: '6070', status: 'plan',
    memo: `[마케팅] ${TAG}전시회 · 일시불` });
  ID.usd = await mkTxn({ date: '2026-04-25', amount: 500, cur: 'USD', fx: 18, memo: `${TAG} USD 지출`,
    receipt: 'F-999' });
  ID.inc = await mkTxn({ date: '2026-04-28', dir: 'in', amount: 7000, cat: '4020', memo: `${TAG} 기타수입` });
  ID.unapp = await mkTxn({ date: '2026-04-29', amount: 88, memo: `${TAG} 미승인`, approved: false });

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(financeRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.fin = app.jwt.sign({ sub: ID.fin });
}

const exp = async (who, qs = '') => app.inject({ method: 'GET', url: '/api/transactions/export' + qs,
  headers: { authorization: 'Bearer ' + tok[who] } });
const mine = (res) => (res.json().items || []).filter((t) => String(t.memo || '').includes(TAG));

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① ★ 디렉터 전용 — 재무담당은 403', { skip: SKIP }, async () => {
  const res = await exp('fin');
  assert.equal(res.statusCode, 403);
  assert.equal((await exp('dir')).statusCode, 200);
});

test('② 화면의 200건 제한과 달리 필터에 걸린 전부를 내려준다', { skip: SKIP }, async () => {
  const listed = ((await app.inject({ method: 'GET', url: '/api/transactions?from=2026-03-01&to=2026-03-31',
    headers: { authorization: 'Bearer ' + tok.dir } })).json().items || [])
    .filter((t) => String(t.memo || '').includes(TAG));
  assert.equal(listed.length, 200, '화면 목록은 200건에서 잘린다');
  const all = mine(await exp('dir', '?from=2026-03-01&to=2026-03-31'));
  assert.equal(all.length, BULK, `내보내기는 ${BULK}건 전부`);
  assert.equal((await exp('dir', '?from=2026-03-01&to=2026-03-31')).json().truncated, false);
});

test('③ 화면 필터가 그대로 적용된다 — 상태·구분·기간·계좌', { skip: SKIP }, async () => {
  const plans = mine(await exp('dir', '?status=plan&from=2026-04-01&to=2026-04-30'));
  assert.deepEqual(plans.map((t) => Number(t.id)).sort((a, b) => a - b), [ID.fx, ID.mkt].sort((a, b) => a - b));

  const ins = mine(await exp('dir', '?direction=in&from=2026-04-01&to=2026-04-30'));
  assert.deepEqual(ins.map((t) => Number(t.id)), [ID.inc]);

  const byAcc = mine(await exp('dir', `?account_id=${ID.acc}&from=2026-04-01&to=2026-04-30`));
  assert.ok(!byAcc.some((t) => Number(t.id) === ID.mkt), '계좌 지정 시 계좌미지정 건 제외');

  const none = mine(await exp('dir', '?account_id=none&from=2026-04-01&to=2026-04-30'));
  assert.deepEqual(none.map((t) => Number(t.id)), [ID.mkt], '계좌 미지정만');
});

test('④ 엑셀에 필요한 열이 모두 실려 온다', { skip: SKIP }, async () => {
  const rows = mine(await exp('dir', '?from=2026-04-01&to=2026-04-30'));
  const by = Object.fromEntries(rows.map((t) => [Number(t.id), t]));

  const usd = by[ID.usd];
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.fx_rate, 18);
  assert.equal(usd.amount_mxn, 9000);
  assert.equal(usd.receipt_no, 'F-999');
  assert.equal(usd.account_name, `${TAG}은행`);
  assert.equal(usd.created_by_name, `${TAG}디렉터`);
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(usd.created_at), '등록일시 포맷');
  assert.equal(usd.txn_date, '2026-04-25', '일자는 YYYY-MM-DD 문자열');

  assert.equal(by[ID.fx].source, 'recurring');
  assert.equal(by[ID.fx].rule_name, `${TAG}임차료`);
  assert.equal(by[ID.fx].plan_date, '2026-04-15');
  assert.equal(by[ID.fx].plan_amount, 10000);
  assert.equal(by[ID.mkt].source, 'marketing');
  assert.equal(by[ID.mkt].account_name, null, '계좌 미지정');
  assert.equal(by[ID.inc].direction, 'in');
  assert.equal(by[ID.unapp].approved, false);
});

test('⑤ 최신순 정렬 · 삭제분 제외', { skip: SKIP }, async () => {
  const rows = mine(await exp('dir', '?from=2026-04-01&to=2026-04-30'));
  const dates = rows.map((t) => t.txn_date);
  assert.deepEqual(dates, dates.slice().sort().reverse(), '일자 내림차순');

  await query(`UPDATE transactions SET deleted_at=now() WHERE id=$1`, [ID.unapp]);
  const after = mine(await exp('dir', '?from=2026-04-01&to=2026-04-30'));
  assert.ok(!after.some((t) => Number(t.id) === ID.unapp), '삭제된 거래는 안 나온다');
  await query(`UPDATE transactions SET deleted_at=NULL WHERE id=$1`, [ID.unapp]);
});

test('⑥ 내보내기가 감사로그에 남는다(action=export)', { skip: SKIP }, async () => {
  await exp('dir', '?status=plan');
  const n = Number((await query(
    `SELECT COUNT(*)::int AS n FROM audit_log
      WHERE user_id=$1 AND action='export' AND target='transactions:export'`, [ID.dir])).rows[0].n);
  assert.ok(n >= 1, '감사로그 기록 — action 값이 CHECK 제약을 통과해야 한다');
});

test('⑦ 결과가 없어도 200 · 빈 배열', { skip: SKIP }, async () => {
  const res = await exp('dir', '?from=2000-01-01&to=2000-01-02');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().items, []);
  assert.equal(res.json().count, 0);
});

test('⑧ 응답 메타(count·cap·generated_at)가 채워진다', { skip: SKIP }, async () => {
  const d = (await exp('dir', '?from=2026-03-01&to=2026-03-31')).json();
  assert.equal(d.count, BULK);
  assert.equal(d.cap, 20000);
  assert.ok(!isNaN(Date.parse(d.generated_at)));
});
