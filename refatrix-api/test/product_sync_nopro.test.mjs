// 2026-09-21 · PRO 로 시작하는 제품은 CRM 제품 전송에서 뺀다.
//
//   순수 로직은 DB 없이 돌고, 실제 SQL(전송 대상 조회 · 화면 건수)은 TEST_PG_URL 이 있을 때
//   실제 PostgreSQL 에서 돈다. products 표만 쓴다.
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/product_sync_nopro.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

const {
  isExcludedCode, EXCLUDED_PREFIXES, EXCLUDE_SQL, SENDABLE_WHERE,
} = await import('../src/productSync.js');

test('PRO 로 시작하면 보내지 않는다 — 대소문자·앞 공백 무관', () => {
  assert.deepEqual(EXCLUDED_PREFIXES, ['PRO']);
  for (const c of ['PRO', 'PRO0001', 'pro-01', ' Pro123', 'PROMO-KIT']) {
    assert.equal(isExcludedCode(c), true, c);
  }
  // 중간·끝에 PRO 가 있는 것, 비슷하지만 다른 것은 보낸다
  for (const c of ['CA0032', 'GV0022', 'XPRO1', 'CBPRO', 'PR0001', 'P-RO1', '', null, undefined]) {
    assert.equal(isExcludedCode(c), false, String(c));
  }
});

test('SQL 조건은 모든 조회 경로가 같은 한 조각을 쓴다', () => {
  assert.equal(EXCLUDE_SQL, ` AND upper(btrim(code)) NOT LIKE 'PRO%'`);
  assert.ok(SENDABLE_WHERE.startsWith(`deleted_at IS NULL AND code IS NOT NULL AND code <> ''`));
  assert.ok(SENDABLE_WHERE.endsWith(EXCLUDE_SQL));
});

const dbTest = PG ? test : test.skip;

dbTest('실 PostgreSQL — 전체·시험·코드 지정 조회와 화면 건수에서 PRO* 가 빠진다', async () => {
  const { query } = await import('../src/db.js');
  const { fetchProducts } = await import('../src/productSync.js');
  const codes = ['ZNP0001', 'ZNP0002', 'PRONP01', 'pronp02', ' PRONP03'];
  const clean = () => query(`DELETE FROM products WHERE btrim(code) = ANY($1)`,
    [codes.map((c) => c.trim())]);
  await clean();
  try {
    for (const c of codes) {
      await query(`INSERT INTO products (code, name, list_price, stock_qty, is_active)
                   VALUES ($1, $2, 100, 5, true)`, [c, 'NOPRO ' + c]);
    }
    // 전체 조회(실전 전송이 쓰는 경로)
    const all = (await fetchProducts()).map((r) => String(r.code).trim());
    assert.ok(all.includes('ZNP0001') && all.includes('ZNP0002'), '일반 제품은 나간다');
    assert.equal(all.filter((c) => /^pro/i.test(c)).length, 0, 'PRO* 는 한 건도 없어야 한다');

    // 시험 전송(앞에서 N건) — 정렬상 PRO 가 앞에 와도 끼지 않는다
    const few = (await fetchProducts({ limit: 5000 })).map((r) => String(r.code).trim());
    assert.equal(few.filter((c) => /^pro/i.test(c)).length, 0);

    // 코드 지정(미리보기·연결 테스트) — PRO* 는 「찾지 못함」
    assert.equal((await fetchProducts({ code: 'PRONP01' })).length, 0);
    assert.equal((await fetchProducts({ code: 'pronp02' })).length, 0);
    assert.equal((await fetchProducts({ code: 'ZNP0001' })).length, 1);

    // 화면 건수(status) — 보낼 건수와 제외 건수
    const sendable = Number((await query(
      `SELECT COUNT(*)::int AS n FROM products WHERE ${SENDABLE_WHERE}`)).rows[0].n);
    const everything = Number((await query(
      `SELECT COUNT(*)::int AS n FROM products WHERE deleted_at IS NULL AND code IS NOT NULL AND code <> ''`)).rows[0].n);
    assert.equal(sendable, all.length, '화면 건수 = 실제로 나가는 건수');
    assert.ok(everything - sendable >= 3, 'PRO* 3건 이상이 제외 건수로 잡힌다');
  } finally {
    await clean();
    const { pool } = await import('../src/db.js');
    await pool.end();
  }
});
