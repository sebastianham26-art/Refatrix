import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import {
  buildAccountAccess, allowedAccountIds, allowedDetailAccountIds,
  canViewAccount, canViewDetail, canOperateAccount, hasAnyOperate,
} from '../src/accountScope.js';
import { calendarArApByDay } from '../src/cashflow.js';

// ───────────────────────── 순수: 계좌 권한 헬퍼 ─────────────────────────
test('buildAccountAccess: 디렉터는 all=true(전체)', () => {
  const a = buildAccountAccess('director', []);
  assert.equal(a.all, true);
  assert.equal(allowedAccountIds({ accountAccess: a }), null);   // null = 전체
  assert.equal(canViewAccount({ accountAccess: a }, 99), true);
  assert.equal(canOperateAccount({ accountAccess: a }, 99), true);
  assert.equal(hasAnyOperate({ accountAccess: a }), true);
});

test('buildAccountAccess: 비디렉터 — view/detail/operate 3계층', () => {
  const a = buildAccountAccess('treasury', [
    { account_id: 1, can_operate: true,  can_detail: true },   // 운영
    { account_id: 2, can_operate: false, can_detail: true },   // 열람
    { account_id: 3, can_operate: false, can_detail: false },  // 잔액만
  ]);
  assert.equal(a.all, false);
  const perm = { accountAccess: a };
  // 잔액(존재) 열람: 1,2,3 모두
  assert.deepEqual([...allowedAccountIds(perm)].sort(), [1, 2, 3]);
  // 거래내역(detail): 1,2 (3은 잔액만 → 제외)
  assert.deepEqual([...allowedDetailAccountIds(perm)].sort(), [1, 2]);
  assert.equal(canViewAccount(perm, 3), true);     // 잔액만 계좌도 존재/잔액은 보임
  assert.equal(canViewDetail(perm, 3), false);     // 거래내역은 안 보임
  assert.equal(canViewDetail(perm, 2), true);
  assert.equal(canOperateAccount(perm, 1), true);
  assert.equal(canOperateAccount(perm, 2), false);
});

test('buildAccountAccess: 디렉터는 all=true(전체 detail 포함)', () => {
  const perm = { accountAccess: buildAccountAccess('director', []) };
  assert.equal(allowedAccountIds(perm), null);
  assert.equal(allowedDetailAccountIds(perm), null);
  assert.equal(canViewDetail(perm, 99), true);
});

test('buildAccountAccess: can_detail 없던 과거행은 detail=true 로 간주', () => {
  const perm = { accountAccess: buildAccountAccess('ops', [{ account_id: 5, can_operate: false }]) };
  assert.equal(canViewDetail(perm, 5), true);   // 하위호환
});

test('buildAccountAccess: 권한 없는 사용자', () => {
  const perm = { accountAccess: buildAccountAccess('viewer', []) };
  assert.deepEqual(allowedAccountIds(perm), []);     // 빈 배열 = 아무 계좌도 없음
  assert.equal(canViewAccount(perm, 1), false);
  assert.equal(canOperateAccount(perm, 1), false);
  assert.equal(hasAnyOperate(perm), false);
});

// ───────────────────────── 순수: 현금흐름 AR/AP 달력 ─────────────────────────
test('calendarArApByDay: AR=미수 인보이스(만기일), AP=예정 지출(계획일)', () => {
  const invoices = [
    { id: 10, customer_name: 'ACME', sat_no: 'A1', due_date: '2026-06-10', outstanding: 1000 },
    { id: 11, customer_name: 'BETA', sat_no: 'B1', due_date: '2026-06-10', outstanding: 500 },
    { id: 12, customer_name: 'GAMMA', sat_no: 'G1', due_date: '2026-06-15', outstanding: 0 },   // 완납 → 제외
    { id: 13, customer_name: 'DELTA', sat_no: 'D1', due_date: '2026-07-01', outstanding: 999 }, // 다른 달 → 제외
  ];
  const planOut = [
    { id: 1, plan_date: '2026-06-10', amount_mxn: 300, account_name: 'BBVA', category_name: '임대료', memo: 'm' },
    { id: 2, plan_date: '2026-06-20', amount_mxn: 200, account_name: 'BBVA' },
  ];
  const { ar, ap } = calendarArApByDay(invoices, planOut, '2026-06');
  assert.equal(ar['2026-06-10'].sum, 1500);            // 1000 + 500
  assert.equal(ar['2026-06-10'].items.length, 2);
  assert.equal(ar['2026-06-15'], undefined);           // 완납 0 제외
  assert.equal(ar['2026-07-01'], undefined);           // 다른 달 제외
  assert.equal(ap['2026-06-10'].sum, 300);
  assert.equal(ap['2026-06-20'].sum, 200);
});

// ───────────────────────── 통합(pg-mem): 핵심 SQL 검증 ─────────────────────────
function freshDb() {
  const db = newDb();
  db.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
  // to_char(date,'YYYY-MM') / 'YYYY-MM-DD' 최소 구현
  db.public.registerFunction({
    name: 'to_char', args: ['timestamptz', 'text'], returns: 'text', implementation: (d, fmt) => {
      if (d == null) return null;
      const iso = new Date(d).toISOString();
      return fmt === 'YYYY-MM' ? iso.slice(0, 7) : iso.slice(0, 10);
    },
  });
  db.public.none(`
    CREATE TABLE users (id INT PRIMARY KEY, role TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE accounts (id INT PRIMARY KEY, name TEXT, currency TEXT, open_balance NUMERIC, deleted_at TIMESTAMPTZ);
    CREATE TABLE user_page_access (user_id INT, page_key TEXT, device_req TEXT, access TEXT);
    CREATE TABLE user_account_access (id SERIAL PRIMARY KEY, user_id INT, account_id INT, can_operate BOOLEAN, UNIQUE(user_id, account_id));
  `);
  db.public.none(`
    INSERT INTO users (id, role) VALUES (1,'director'),(2,'treasury'),(3,'sales_support'),(4,'viewer');
    INSERT INTO accounts (id, name, currency, open_balance) VALUES (10,'BBVA','MXN',0),(11,'Banorte','MXN',0),(12,'USD-Acc','USD',0);
    -- 재무(transactions) 화면 권한: 사용자 2,3 만(4는 없음, 1은 디렉터라 시드 대상 아님)
    INSERT INTO user_page_access (user_id, page_key, access) VALUES (2,'transactions','edit'),(3,'transactions','view'),(4,'customers','view');
  `);
  return db;
}

test('시드(0066): 대상 사용자 = 비디렉터 + transactions 권한자(2,3)만', () => {
  const db = freshDb();
  // 시드 대상자 선별 술어(프로덕션 WHERE 절과 동일 의미). 교차곱은 CROSS JOIN(프로덕션)이 담당.
  const targets = db.public.many(
    `SELECT id FROM users
      WHERE deleted_at IS NULL AND role <> 'director'
        AND id IN (SELECT user_id FROM user_page_access WHERE page_key='transactions')
      ORDER BY id`).map((r) => Number(r.id));
  assert.deepEqual(targets, [2, 3]);   // 1(디렉터)·4(권한없음) 제외
  const accts = db.public.many(`SELECT id FROM accounts WHERE deleted_at IS NULL ORDER BY id`).map((r) => Number(r.id));
  assert.deepEqual(accts, [10, 11, 12]);
  // 교차곱 시드를 명시 삽입(=프로덕션 CROSS JOIN 결과)하고 검증.
  for (const u of targets) for (const a of accts) {
    db.public.none(`INSERT INTO user_account_access (user_id, account_id, can_operate) VALUES (${u},${a},false)
                    ON CONFLICT (user_id, account_id) DO NOTHING`);
  }
  const n = db.public.one(`SELECT COUNT(*) AS c FROM user_account_access`);
  assert.equal(Number(n.c), 6);   // 2 users × 3 accounts
  const op = db.public.one(`SELECT COUNT(*) AS c FROM user_account_access WHERE can_operate=true`);
  assert.equal(Number(op.c), 0);  // operate 자동 부여 0
});

test('시드(0066): ON CONFLICT 으로 재실행 시 중복 없음', () => {
  const db = freshDb();
  const ins = () => { for (const u of [2, 3]) for (const a of [10, 11, 12]) {
    db.public.none(`INSERT INTO user_account_access (user_id, account_id, can_operate) VALUES (${u},${a},false)
                    ON CONFLICT (user_id, account_id) DO NOTHING`);
  } };
  ins(); ins();   // 두 번 실행
  const n = db.public.one(`SELECT COUNT(*) AS c FROM user_account_access`);
  assert.equal(Number(n.c), 6);
});

test('계좌 필터: 권한 계좌만 조회(IN 동등 — 프로덕션은 ANY($1))', () => {
  const db = freshDb();
  const rows = db.public.many(
    `SELECT id FROM accounts WHERE deleted_at IS NULL AND id IN (10,12) ORDER BY id`);
  assert.deepEqual(rows.map((r) => Number(r.id)), [10, 12]);
});

test('account-access PUT: 전체 교체(DELETE 후 plain INSERT) — UNIQUE 제약과 무관', () => {
  const db = freshDb();
  // 초기: 사용자2 에 계좌10 열람만
  db.public.none(`INSERT INTO user_account_access (user_id, account_id, can_operate) VALUES (2,10,false)`);
  // PUT: 사용자2 권한을 [10 operate, 11 view] 로 교체 (DELETE 후 plain INSERT)
  db.public.none(`DELETE FROM user_account_access WHERE user_id=2`);
  db.public.none(`INSERT INTO user_account_access (user_id, account_id, can_operate) VALUES (2,10,true)`);
  db.public.none(`INSERT INTO user_account_access (user_id, account_id, can_operate) VALUES (2,11,false)`);
  const rows = db.public.many(`SELECT account_id, can_operate FROM user_account_access WHERE user_id=2 ORDER BY account_id`);
  assert.deepEqual(rows.map((r) => [Number(r.account_id), r.can_operate]), [[10, true], [11, false]]);
});

test('account-access PUT: UNIQUE 제약이 없는 테이블에서도 500 없이 동작(회귀)', () => {
  // 프로덕션처럼 UNIQUE(user_id, account_id) 제약이 빠진 테이블 재현
  const db = newDb();
  db.public.none(`CREATE TABLE user_account_access (id SERIAL PRIMARY KEY, user_id INT, account_id INT, can_operate BOOLEAN)`);
  db.public.none(`INSERT INTO user_account_access (user_id, account_id, can_operate) VALUES (2,10,false)`);
  // PUT 경로: DELETE 후 plain INSERT — ON CONFLICT 없으므로 제약과 무관하게 성공해야 함
  db.public.none(`DELETE FROM user_account_access WHERE user_id=2`);
  db.public.none(`INSERT INTO user_account_access (user_id, account_id, can_operate) VALUES (2,10,true)`);
  const r = db.public.one(`SELECT can_operate FROM user_account_access WHERE user_id=2 AND account_id=10`);
  assert.equal(r.can_operate, true);
});

// PATCH 레벨 → 플래그 저장 매핑(잔액만=can_detail false) 검증 + 해석 일관성
test('account-access PATCH: 레벨별 플래그 저장(none/balance/view/operate)', async () => {
  const db = newDb();
  db.public.none(`CREATE TABLE user_account_access (
    id SERIAL PRIMARY KEY, user_id INT, account_id INT,
    can_operate BOOLEAN DEFAULT false, can_detail BOOLEAN NOT NULL DEFAULT true);`);
  const { Pool } = db.adapters.createPg(); const pool = new Pool();
  // PATCH 로직과 동일: DELETE 후 (none 아니면) INSERT
  async function setLevel(uid, acc, level) {
    await pool.query(`DELETE FROM user_account_access WHERE user_id=$1 AND account_id=$2`, [uid, acc]);
    if (level !== 'none') {
      const op = level === 'operate';
      const detail = level === 'view' || level === 'operate';
      await pool.query(`INSERT INTO user_account_access (user_id, account_id, can_operate, can_detail) VALUES ($1,$2,$3,$4)`,
        [uid, acc, op, detail]);
    }
  }
  await setLevel(1, 10, 'operate');
  await setLevel(1, 11, 'view');
  await setLevel(1, 12, 'balance');
  await setLevel(1, 13, 'none');
  const rows = (await pool.query(`SELECT account_id, can_operate, can_detail FROM user_account_access WHERE user_id=1 ORDER BY account_id`)).rows;
  // 13(none)은 행 없음
  assert.deepEqual(rows.map((r) => Number(r.account_id)), [10, 11, 12]);
  const byId = Object.fromEntries(rows.map((r) => [Number(r.account_id), r]));
  assert.equal(byId[10].can_operate, true);  assert.equal(byId[10].can_detail, true);   // 운영
  assert.equal(byId[11].can_operate, false); assert.equal(byId[11].can_detail, true);   // 열람
  assert.equal(byId[12].can_operate, false); assert.equal(byId[12].can_detail, false);  // 잔액만
  // 해석 일관성: buildAccountAccess 가 같은 결론
  const perm = { accountAccess: buildAccountAccess('ops', rows) };
  assert.deepEqual([...allowedAccountIds(perm)].sort(), [10, 11, 12]);   // 잔액 보임
  assert.deepEqual([...allowedDetailAccountIds(perm)].sort(), [10, 11]); // 12(잔액만) 거래내역 제외
});
