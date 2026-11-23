// =====================================================================
// 계좌와 다른 통화의 거래 — 계좌 잔액·원장 엑셀·거래 후 잔고·자금일보 일치 (실 PostgreSQL)  2026-11-23
//   디렉터 보고: "금고 계좌에서 USD 를 사용한 걸 보면 거래목록엔 MXN 으로 계산되어 있는데,
//                계좌별 엑셀엔 구분이 안 되어 있고 USD 200 지출이 MXN 200 으로 계산되어 있다."
//   규칙(accAmount.js): 잔액은 계좌 통화로 쌓고, 거래 통화가 다르면 계좌 통화로 환산한다.
//     MXN 계좌 + USD 거래 → amount_mxn(거래 당시 환율) / USD 계좌 + MXN 거래 → amount_mxn ÷ 거래일 USD 환율
//   실행: TEST_PG_URL=postgres://... node --test test/acc_currency_mix_e2e.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app, loadActualInputs;
const tok = {};
const ID = {};
const TAG = 'CURMIX';
const FXDATE = '2026-11-02';

async function cleanup() {
  const A = `SELECT id FROM accounts WHERE name LIKE '${TAG}%'`;
  await query(`DELETE FROM transactions WHERE account_id IN (${A}) OR memo LIKE '${TAG}%'`);
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'curmix%')`).catch(() => {});
  await query(`DELETE FROM users WHERE login_id LIKE 'curmix%'`);
}

async function boot() {
  ({ query } = await import('../src/db.js'));
  ({ loadActualInputs } = await import('../src/treasuryDaily.js'));
  const financeRoutes = (await import('../src/routes/financeRoutes.js')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  ID.dir = Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ('${TAG}디렉터','director','x','curmix_dir') RETURNING id`)).rows[0].id);
  const mkAcc = async (name, cur, open) => Number((await query(
    `INSERT INTO accounts (name, type, currency, open_balance, open_date) VALUES ($1,'cash',$2,$3,'2026-01-01') RETURNING id`,
    [name, cur, open])).rows[0].id);
  ID.caja = await mkAcc(`${TAG} 금고`, 'MXN', 10000);
  ID.usd = await mkAcc(`${TAG} USD`, 'USD', 1000);
  // USD 계좌의 MXN 거래 환산용 환율(거래일 이전 최근값을 쓴다)
  await query(`INSERT INTO fx_rates (rate_date, base, quote, rate, source) VALUES ($1,'USD','MXN',20,'test')
               ON CONFLICT (rate_date, base, quote) DO UPDATE SET rate=20`, [FXDATE]);

  const T = async (acc, date, dir, amt, cur, fx) => Number((await query(
    `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, status, approved, memo, kind, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'actual',true,$8,'general',$9) RETURNING id`,
    [acc, date, dir, amt, cur, fx, Math.round(amt * fx * 100) / 100, `${TAG} ${cur}`, ID.dir])).rows[0].id);
  ID.m1 = await T(ID.caja, '2026-11-03', 'out', 500, 'MXN', 1);        // 9,500
  ID.m2 = await T(ID.caja, '2026-11-04', 'out', 200, 'USD', 18.25);    // USD 200 → MXN 3,650 → 5,850 (버그: 9,300)
  ID.m3 = await T(ID.caja, '2026-11-05', 'in', 50, 'USD', 18.4);       // USD 50 → MXN 920 → 6,770
  ID.u1 = await T(ID.usd, '2026-11-03', 'out', 100, 'USD', 18.3);      // USD 900
  ID.u2 = await T(ID.usd, '2026-11-06', 'out', 2000, 'MXN', 1);        // MXN 2,000 ÷ 20 = USD 100 → USD 800 (버그: −1,100)

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(financeRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
}
const get = async (url) => {
  const r = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok.dir } });
  assert.equal(r.statusCode, 200, url + ' → ' + r.body);
  return r.json();
};
const byId = (items) => new Map(items.map((t) => [Number(t.id), t]));

if (!SKIP) await boot();
after(async () => { if (!SKIP) { await cleanup(); await query(`DELETE FROM fx_rates WHERE source='test' AND rate_date=$1`, [FXDATE]); await app.close(); (await import('../src/db.js')).pool.end(); } });

test('① 금고(MXN) 계좌의 USD 200 지출은 MXN 3,650 으로 빠진다 — 계좌 잔액', { skip: SKIP }, async () => {
  const acc = (await get('/api/accounts')).items.find((a) => Number(a.id) === ID.caja);
  assert.equal(acc.balance, 6770, '10,000 − 500 − 3,650 + 920');
});

test('② 계좌 원장(엑셀용): 수입·지출·잔액은 MXN 환산, 원래 USD 금액·환율은 따로', { skip: SKIP }, async () => {
  const led = await get(`/api/accounts/${ID.caja}/ledger`);
  const m = byId(led.items);
  const r2 = m.get(ID.m2);
  assert.equal(r2.out_amt, 3650);
  assert.equal(r2.balance, 5850);
  assert.equal(r2.converted, true);
  assert.equal(r2.orig_currency, 'USD');
  assert.equal(r2.orig_amount, 200);
  assert.equal(r2.fx_rate, 18.25);
  assert.equal(m.get(ID.m3).in_amt, 920);
  assert.equal(m.get(ID.m1).converted, false, '같은 통화는 환산 표시 없음');
  assert.equal(m.get(ID.m1).out_amt, 500);
  assert.equal(led.closing, 6770);
});

test('③ 원장 기간 조회 — 이월 기초잔액도 환산 기준', { skip: SKIP }, async () => {
  const led = await get(`/api/accounts/${ID.caja}/ledger?from=2026-11-05`);
  assert.equal(led.opening, 5850);
  assert.equal(led.closing, 6770);
});

test('④ 거래목록 「거래 후 잔고」 = 원장 행별 잔고 = 계좌 잔액', { skip: SKIP }, async () => {
  const m = byId((await get(`/api/transactions?account_id=${ID.caja}`)).items);
  const led = await get(`/api/accounts/${ID.caja}/ledger`);
  for (const r of led.items) assert.equal(m.get(r.id).balance_after, r.balance, 'row ' + r.id);
  assert.equal(m.get(ID.m3).balance_after, 6770);
  // 거래목록 원본 표시값은 그대로(USD 200 · MXN 환산 3,650)
  assert.equal(m.get(ID.m2).amount, 200);
  assert.equal(m.get(ID.m2).currency, 'USD');
  assert.equal(m.get(ID.m2).amount_mxn, 3650);
});

test('⑤ USD 계좌의 MXN 지출은 거래일 환율로 USD 환산', { skip: SKIP }, async () => {
  const acc = (await get('/api/accounts')).items.find((a) => Number(a.id) === ID.usd);
  assert.equal(acc.balance, 800, '1,000 − 100 − (2,000 ÷ 20)');
  const led = await get(`/api/accounts/${ID.usd}/ledger`);
  const r = byId(led.items).get(ID.u2);
  assert.equal(r.out_amt, 100);
  assert.equal(r.converted, true);
  assert.equal(r.orig_currency, 'MXN');
  assert.equal(led.closing, 800);
  const m = byId((await get(`/api/transactions?account_id=${ID.usd}`)).items);
  assert.equal(m.get(ID.u2).balance_after, 800);
});

test('⑥ 일일 자금 요약: 금고 USD 지출은 MXN 버킷에 환산액으로 들어간다', { skip: SKIP }, async () => {
  const before = await loadActualInputs('2026-11-04', '2026-11-30', query, [ID.caja]);
  assert.equal(before.base.MXN, 9500, '11/4 이전: 10,000 − 500');
  const t = before.txns.find((x) => Number(x.id) === ID.m2);
  assert.equal(t.amount, 3650);
  assert.equal(t.currency, 'MXN', '계좌 통화 버킷');
  const after5 = await loadActualInputs('2026-11-05', '2026-11-30', query, [ID.caja]);
  assert.equal(after5.base.MXN, 5850);
});
