// =====================================================================
// 거래목록 「거래 후 잔고」 + 「더 보기」 페이지네이션 — 종단 검증 (실 PostgreSQL)  2026-09-30
//   디렉터 요청: "거래목록에 집행금액만 나오고 집행한 금액 후의 잔고도 같이 보이게.
//                나중에 잔고가 틀리면 어디서부터 잘못됐는지 확인이 안 된다."
//   규칙: balance_after = 기초잔액 + 그 거래까지의 승인된 실적 누적(txn_date ASC, id ASC, 계좌 통화)
//         → /api/accounts 의 balance, /api/accounts/:id/ledger 의 balance 와 반드시 일치.
//         예정·미승인·삭제·계좌미지정은 잔고 미반영(null).
//         필터(기간·상태·구분)·페이지(offset)와 무관하게 같은 값.
//   실행: TEST_PG_URL=postgres://... node --test test/txn_balance_after_e2e.test.mjs
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
const TAG = 'BALTEST';

async function cleanup() {
  const U = `SELECT id FROM users WHERE login_id LIKE 'baltest%'`;
  const A = `SELECT id FROM accounts WHERE name LIKE '${TAG}%'`;
  await query(`DELETE FROM transactions WHERE account_id IN (${A}) OR memo LIKE '${TAG}%'`);
  await query(`DELETE FROM user_account_access WHERE user_id IN (${U})`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (${U})`);
  await query(`DELETE FROM audit_log WHERE user_id IN (${U})`).catch(() => {});
  await query(`DELETE FROM accounts WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM users WHERE login_id LIKE 'baltest%'`);
}

async function boot() {
  ({ query } = await import('../src/db.js'));
  const financeRoutes = (await import('../src/routes/financeRoutes.js')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'baltest_dir');
  ID.fin = await mkUser(`${TAG}재무`, 'treasury', 'baltest_fin');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
               VALUES ($1,'transactions','anywhere','edit') ON CONFLICT DO NOTHING`, [ID.fin]);

  const mkAcc = async (name, cur, open) => Number((await query(
    `INSERT INTO accounts (name, type, currency, open_balance, open_date) VALUES ($1,'bank',$2,$3,'2026-01-01') RETURNING id`,
    [name, cur, open])).rows[0].id);
  ID.bbva = await mkAcc(`${TAG} BBVA`, 'MXN', 10000);
  ID.usd = await mkAcc(`${TAG} USD`, 'USD', 500);
  await query(`INSERT INTO user_account_access (user_id, account_id, can_operate, can_detail) VALUES ($1,$2,false,true)`, [ID.fin, ID.bbva]);

  // 거래: (계좌, 일자, 방향, 금액, 상태, 승인, 삭제, 비공개) — 등록 순서를 일부러 날짜와 어긋나게(소급 등록 재현)
  const T = async (acc, date, dir, amt, status = 'actual', approved = true, extra = {}) => {
    const cur = acc === ID.usd ? 'USD' : 'MXN';
    const fx = cur === 'USD' ? 18 : 1;
    const r = await query(
      `INSERT INTO transactions (account_id, txn_date, direction, amount, currency, fx_rate, amount_mxn, status, approved, memo, kind,
                                 deleted_at, is_private, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'general',$11,$12,$13) RETURNING id`,
      [acc, date, dir, amt, cur, fx, amt * fx, status, approved, `${TAG} ${extra.memo || ''}`,
       extra.deleted ? new Date() : null, !!extra.priv, ID.dir]);
    return Number(r.rows[0].id);
  };
  ID.t1 = await T(ID.bbva, '2026-09-01', 'in', 5000);                 // 15,000
  ID.t2 = await T(ID.bbva, '2026-09-03', 'out', 2000);                // 13,000
  ID.t4 = await T(ID.bbva, '2026-09-05', 'out', 1500);                // (t3 소급 등록 후) 14,500
  ID.t3 = await T(ID.bbva, '2026-09-03', 'in', 3000);                 // 같은 날 · 늦게 등록 → id 순서상 t2 뒤: 16,000
  ID.pl = await T(ID.bbva, '2026-09-06', 'out', 999, 'plan', true);   // 예정 — 잔고 미반영
  ID.un = await T(ID.bbva, '2026-09-07', 'out', 777, 'actual', false);// 미승인 — 잔고 미반영
  ID.del = await T(ID.bbva, '2026-09-07', 'out', 555, 'actual', true, { deleted: true }); // 삭제 — 제외
  ID.pv = await T(ID.bbva, '2026-09-08', 'out', 400, 'actual', true, { priv: true });     // 비공개 — 합산엔 포함: 14,100
  ID.t5 = await T(ID.bbva, '2026-09-09', 'in', 100);                  // 14,200
  ID.u1 = await T(ID.usd, '2026-09-02', 'out', 120);                  // USD 380
  ID.u2 = await T(ID.usd, '2026-09-04', 'in', 20.5);                  // USD 400.50

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(financeRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.fin = app.jwt.sign({ sub: ID.fin });
}
const get = async (who, url) => {
  const r = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[who] } });
  assert.equal(r.statusCode, 200, url + ' → ' + r.body);
  return r.json();
};
const byId = (items) => new Map(items.map((t) => [Number(t.id), t]));

if (!SKIP) await boot();

test('① 행마다 거래 후 잔고 — 일자·등록순 누적, 소급 등록 거래는 날짜 자리에 끼워 계산', { skip: SKIP }, async () => {
  const d = await get('dir', `/api/transactions?account_id=${ID.bbva}`);
  assert.equal(d.balance_after, true);
  const m = byId(d.items);
  assert.equal(m.get(ID.t1).balance_after, 15000);
  assert.equal(m.get(ID.t2).balance_after, 13000);
  assert.equal(m.get(ID.t3).balance_after, 16000, '같은 날 늦게 등록된 거래는 id 순서상 뒤');
  assert.equal(m.get(ID.t4).balance_after, 14500, '9/5 거래는 9/3 소급분까지 반영');
  assert.equal(m.get(ID.pv).balance_after, 14100);
  assert.equal(m.get(ID.t5).balance_after, 14200);
});

test('② 예정·미승인은 null, 삭제 거래는 목록에도 합산에도 없다', { skip: SKIP }, async () => {
  const m = byId((await get('dir', `/api/transactions?account_id=${ID.bbva}`)).items);
  assert.equal(m.get(ID.pl).balance_after, null);
  assert.equal(m.get(ID.un).balance_after, null);
  assert.equal(m.has(ID.del), false);
});

test('③ 가장 최근 실적 행의 잔고 = 재무/계좌 잔액 = 원장 closing (세 화면 같은 공식)', { skip: SKIP }, async () => {
  const acc = (await get('dir', '/api/accounts')).items.find((a) => Number(a.id) === ID.bbva);
  const led = await get('dir', `/api/accounts/${ID.bbva}/ledger`);
  const m = byId((await get('dir', `/api/transactions?account_id=${ID.bbva}`)).items);
  assert.equal(acc.balance, 14200);
  assert.equal(led.closing, 14200);
  assert.equal(m.get(ID.t5).balance_after, acc.balance);
  // 원장의 행별 잔고와도 1:1 일치
  for (const r of led.items) assert.equal(m.get(r.id).balance_after, r.balance, 'ledger row ' + r.id);
});

test('④ USD 계좌는 USD 기준 잔고(MXN 환산 아님), 소수점 보존', { skip: SKIP }, async () => {
  const m = byId((await get('dir', `/api/transactions?account_id=${ID.usd}`)).items);
  assert.equal(m.get(ID.u1).balance_after, 380);
  assert.equal(m.get(ID.u2).balance_after, 400.5);
});

test('⑤ 필터(기간·구분·상태)와 전체 계좌 목록에서도 같은 값', { skip: SKIP }, async () => {
  const f = byId((await get('dir', `/api/transactions?account_id=${ID.bbva}&from=2026-09-05&direction=out&status=actual`)).items);
  assert.equal(f.get(ID.t4).balance_after, 14500, '기간 필터로 과거가 잘려도 누적은 전 이력');
  const all = byId((await get('dir', `/api/transactions?from=2026-09-01&to=2026-09-30`)).items);
  assert.equal(all.get(ID.t3).balance_after, 16000);
  assert.equal(all.get(ID.u2).balance_after, 400.5, '계좌별로 따로 누적');
});

test('⑥ 페이지네이션 복원: limit/offset/has_more, 페이지가 달라도 잔고 값 동일', { skip: SKIP }, async () => {
  const p1 = await get('dir', `/api/transactions?account_id=${ID.bbva}&limit=3&offset=0`);
  const p2 = await get('dir', `/api/transactions?account_id=${ID.bbva}&limit=3&offset=3`);
  const p3 = await get('dir', `/api/transactions?account_id=${ID.bbva}&limit=3&offset=6`);
  assert.equal(p1.items.length, 3); assert.equal(p1.has_more, true);
  assert.equal(p2.has_more, true);
  assert.equal(p3.items.length, 2); assert.equal(p3.has_more, false);
  const ids = [...p1.items, ...p2.items, ...p3.items].map((t) => Number(t.id));
  assert.equal(new Set(ids).size, 8, '누락·중복 없음 (삭제 1건 제외 8건)');
  const m = byId([...p1.items, ...p2.items, ...p3.items]);
  assert.equal(m.get(ID.t1).balance_after, 15000, '마지막 페이지의 첫 거래도 기초잔액부터 정확');
  // 파라미터 없으면 종전과 같은 기본 200
  const d = await get('dir', `/api/transactions?account_id=${ID.bbva}`);
  assert.equal(d.limit, 200); assert.equal(d.offset, 0); assert.equal(d.has_more, false);
});

test('⑦ 비디렉터: 비공개 행은 안 보이지만 잔고 값은 계좌 잔액 기준 그대로(건너뛰어 보임)', { skip: SKIP }, async () => {
  const m = byId((await get('fin', `/api/transactions?account_id=${ID.bbva}`)).items);
  assert.equal(m.has(ID.pv), false, '비공개 숨김');
  assert.equal(m.get(ID.t5).balance_after, 14200, '재무/계좌 잔액과 같은 값');
  const all = byId((await get('fin', `/api/transactions`)).items);
  assert.equal([...all.values()].some((t) => Number(t.account_id) === ID.usd), false, '열람권 없는 계좌는 목록에 없음');
});

test('⑧ 엑셀 내보내기에도 balance_after 가 실린다', { skip: SKIP }, async () => {
  const d = await get('dir', `/api/transactions/export?account_id=${ID.bbva}`);
  const m = byId(d.items);
  assert.equal(m.get(ID.t4).balance_after, 14500);
  assert.equal(m.get(ID.pl).balance_after, null);
});

test('정리', { skip: SKIP }, async () => {
  await cleanup();
  await app.close();
  const { pool } = await import('../src/db.js');
  await pool.end();
});
