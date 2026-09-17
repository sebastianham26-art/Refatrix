// =====================================================================
// Refatrix ERP · test/product_delete.test.mjs  (2026-09-17)
// 제품 영구 삭제 — 참조 탐색 · 차단 판정 · 정리 · 이력.
//
// 실행: PGURL=postgres://... node --test test/product_delete.test.mjs
//   · PGURL(또는 DATABASE_URL) 이 있으면 실 PostgreSQL 종단 테스트를 돌린다.
//   · 없으면 순수 로직 테스트만 돌고 DB 테스트는 skip 한다.
// 이 스위트는 **자기 스키마(임시 스키마)** 안에서만 돌며, 운영 표를 건드리지 않는다.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import {
  isIdent, countSql, classifyTable, tableLabel, buildDeleteCheck,
  refColumns, scanReferences, purgeReferences, describeCleanup,
  CLEANUP_TABLES, NULLIFY_TABLES,
} from '../src/productDelete.js';

const CONN = process.env.PGURL || process.env.DATABASE_URL || '';   // 전역 URL 을 가리지 않도록 이름을 따로 쓴다

// ── ① 순수 로직 ──────────────────────────────────────────────────────
test('식별자 검사 — 카탈로그에서 온 이름만 통과한다', () => {
  assert.ok(isIdent('quote_lines'));
  assert.ok(!isIdent('quote lines'));
  assert.ok(!isIdent('products; DROP TABLE users'));
  assert.ok(!isIdent('Products'));
  assert.throws(() => countSql('bad name', 'product_id'), /bad_identifier/);
  assert.match(countSql('quote_lines', 'product_id'), /FROM "quote_lines" WHERE "product_id" = \$1 LIMIT 501/);
});

test('분류 — 파생/이력/차단', () => {
  assert.equal(classifyTable('product_syd_codes'), 'cleanup');
  assert.equal(classifyTable('product_change_log'), 'nullify');
  assert.equal(classifyTable('sales_invoice_lines'), 'block');
  assert.equal(classifyTable('표에_없는_새표'), 'block');       // 모르는 표 = 차단(안전한 쪽)
  assert.equal(tableLabel('quote_lines'), '견적 라인');
  assert.equal(tableLabel('tabla_nueva'), 'tabla_nueva');
});

test('판매가 있으면 삭제 불가 — 그리고 이유가 판매라고 말한다', () => {
  const r = buildDeleteCheck({ id: 1, code: 'CB0001', name: 'X', stock_qty: 0 }, [
    { table: 'sales_invoice_lines', column: 'product_id', count: 3, capped: false, kind: 'block', label: '판매(인보이스) 라인' },
  ]);
  assert.equal(r.can_delete, false);
  assert.equal(r.sold_count, 3);
  assert.match(r.reasons.join(' '), /판매 이력/);
});

test('구매만 있어도 삭제 불가', () => {
  const r = buildDeleteCheck({ id: 1, code: 'CB0001', stock_qty: 0 }, [
    { table: 'purchase_order_lines', column: 'product_id', count: 1, capped: false, kind: 'block', label: '구매 발주 라인' },
  ]);
  assert.equal(r.can_delete, false);
  assert.equal(r.purchase_count, 1);
  assert.equal(r.sold_count, 0);
});

test('재고가 남아 있으면 삭제 불가', () => {
  const r = buildDeleteCheck({ id: 1, code: 'CB0001', stock_qty: 4 }, []);
  assert.equal(r.can_delete, false);
  assert.equal(r.blockers[0].table, '__stock__');
  assert.match(r.reasons.join(' '), /재고수량이 4개/);
});

test('파생 데이터만 있으면 삭제 가능 — 함께 정리 목록에 실린다', () => {
  const r = buildDeleteCheck({ id: 1, code: 'CB0001', stock_qty: 0 }, [
    { table: 'product_syd_codes', column: 'product_id', count: 2, capped: false, kind: 'cleanup', label: 'SyD 코드' },
    { table: 'product_change_log', column: 'product_id', count: 5, capped: false, kind: 'nullify', label: '제품 변경 이력' },
  ]);
  assert.equal(r.can_delete, true);
  assert.equal(r.blockers.length, 0);
  assert.deepEqual(r.cleanups.map((c) => c.table), ['product_syd_codes', 'product_change_log']);
});

test('모르는 표에 행이 있으면 차단하고 이름을 그대로 보여 준다', () => {
  const r = buildDeleteCheck({ id: 1, code: 'CB0001', stock_qty: 0 }, [
    { table: 'tabla_nueva', column: 'product_id', count: 1, capped: false, kind: 'block', label: 'tabla_nueva' },
  ]);
  assert.equal(r.can_delete, false);
  assert.match(r.reasons.join(' '), /tabla_nueva 1건/);
});

test('정리 요약 문장', () => {
  assert.equal(describeCleanup({ product_syd_codes: 2 }, { product_change_log: 3 }),
    'SyD 코드 2건 · 제품 변경 이력 3건(연결 해제)');
  assert.equal(describeCleanup({}, {}), null);
});

// ── ② 실 PostgreSQL 종단 ─────────────────────────────────────────────
const dbTest = CONN ? test : test.skip;

dbTest('실 DB — 참조 탐색 · 차단 · 삭제 · 코드 재사용', async (t) => {
  const pool = new pg.Pool({ connectionString: CONN });
  const q = (s, p) => pool.query(s, p);
  const SCHEMA = 'pdel_test';
  let client = null;
  t.after(async () => {
    if (client) client.release();
    await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  // 운영 스키마를 축소 재현 — FK 있는 표, FK 없는 표(finder_quote_lines), 컬럼명이 다른 FK 까지.
  await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await q(`CREATE SCHEMA ${SCHEMA}`);
  const c = await pool.connect();
  client = c;
  await c.query(`SET search_path TO ${SCHEMA}`);

  await c.query(`
    CREATE TABLE products (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code TEXT UNIQUE NOT NULL, name TEXT, stock_qty NUMERIC NOT NULL DEFAULT 0,
      deleted_at TIMESTAMPTZ);
    CREATE TABLE product_syd_codes (id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id), syd_code TEXT);
    CREATE TABLE product_applications (id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id), app_text TEXT);
    CREATE TABLE product_change_log (id BIGSERIAL PRIMARY KEY, product_id BIGINT REFERENCES products(id), code TEXT,
      action TEXT NOT NULL CHECK (action IN ('create','update','delete')), source TEXT, changes JSONB);
    CREATE TABLE product_status_log (id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id), code TEXT, action TEXT);
    CREATE TABLE sales_invoice_lines (id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id), qty NUMERIC);
    CREATE TABLE quote_lines (id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id), qty NUMERIC);
    CREATE TABLE purchase_order_lines (id BIGSERIAL PRIMARY KEY, product_id BIGINT NOT NULL REFERENCES products(id), qty NUMERIC);
    CREATE TABLE finder_quote_lines (id BIGSERIAL PRIMARY KEY, product_id BIGINT, qty NUMERIC);          -- FK 없음(운영과 동일)
    CREATE TABLE offer_sheet_items (id BIGSERIAL PRIMARY KEY, sku_id BIGINT REFERENCES products(id), qty NUMERIC); -- 컬럼명이 다른 FK
  `);
  const exec = (s, p) => c.query(s, p);

  const mk = async (code) => Number((await exec(`INSERT INTO products (code,name) VALUES ($1,$1) RETURNING id`, [code])).rows[0].id);

  // 탐색이 세 경로를 다 잡는가
  const cols = await refColumns(exec);
  const names = cols.map((x) => `${x.table}.${x.column}`);
  assert.ok(names.includes('finder_quote_lines.product_id'), 'FK 없는 표도 잡아야 한다');
  assert.ok(names.includes('offer_sheet_items.sku_id'), '컬럼명이 다른 FK 도 잡아야 한다');
  assert.ok(!names.some((n) => n.startsWith('products.')), 'products 자신은 제외');

  // ① 판매가 있는 제품 → 차단
  const sold = await mk('CB-SOLD');
  await exec(`INSERT INTO sales_invoice_lines (product_id, qty) VALUES ($1, 2)`, [sold]);
  let refs = await scanReferences(exec, sold, cols);
  let chk = buildDeleteCheck((await exec(`SELECT id,code,name,stock_qty FROM products WHERE id=$1`, [sold])).rows[0], refs);
  assert.equal(chk.can_delete, false);
  assert.equal(chk.sold_count, 1);

  // ② 구매만 있는 제품 → 차단
  const bought = await mk('CB-BOUGHT');
  await exec(`INSERT INTO purchase_order_lines (product_id, qty) VALUES ($1, 5)`, [bought]);
  refs = await scanReferences(exec, bought, cols);
  assert.equal(buildDeleteCheck({ id: bought, code: 'CB-BOUGHT', stock_qty: 0 }, refs).can_delete, false);

  // ③ FK 가 없는 표(제품찾기 견적)도 차단한다 — DB 는 못 막으므로 우리가 막는다
  const finder = await mk('CB-FINDER');
  await exec(`INSERT INTO finder_quote_lines (product_id, qty) VALUES ($1, 1)`, [finder]);
  refs = await scanReferences(exec, finder, cols);
  assert.equal(buildDeleteCheck({ id: finder, code: 'CB-FINDER', stock_qty: 0 }, refs).can_delete, false);

  // ④ 재고만 남은 제품 → 차단
  const stocked = await mk('CB-STOCK');
  await exec(`UPDATE products SET stock_qty=7 WHERE id=$1`, [stocked]);
  refs = await scanReferences(exec, stocked, cols);
  assert.equal(buildDeleteCheck((await exec(`SELECT id,code,name,stock_qty FROM products WHERE id=$1`, [stocked])).rows[0], refs).can_delete, false);

  // ⑤ 깨끗한 제품(파생 데이터·이력만) → 삭제되고, 이력은 코드와 함께 남고, 코드를 다시 쓸 수 있다
  const clean = await mk('CB-CLEAN');
  await exec(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,'S1'), ($1,'S2')`, [clean]);
  await exec(`INSERT INTO product_applications (product_id, app_text) VALUES ($1,'NISSAN VERSA')`, [clean]);
  await exec(`INSERT INTO product_status_log (product_id, code, action) VALUES ($1,'CB-CLEAN','deactivate')`, [clean]);
  await exec(`INSERT INTO product_change_log (product_id, code, action, source) VALUES ($1,'CB-CLEAN','create','import')`, [clean]);
  refs = await scanReferences(exec, clean, cols);
  chk = buildDeleteCheck((await exec(`SELECT id,code,name,stock_qty FROM products WHERE id=$1`, [clean])).rows[0], refs);
  assert.equal(chk.can_delete, true);
  assert.ok(chk.cleanups.find((x) => x.table === 'product_syd_codes' && x.count === 2));

  await exec('BEGIN');
  const { cleaned, nulled } = await purgeReferences(exec, clean, refs);
  const del = await exec(`DELETE FROM products WHERE id=$1`, [clean]);
  await exec(`INSERT INTO product_change_log (product_id, code, action, source, changes)
              VALUES (NULL,$1,'delete','manual',$2)`,
  ['CB-CLEAN', JSON.stringify({ _deleted: { from: 'CB-CLEAN', to: null } })]);
  await exec('COMMIT');

  assert.equal(del.rowCount, 1);
  assert.equal(cleaned.product_syd_codes, 2);
  assert.equal(cleaned.product_status_log, 1);
  assert.equal(nulled.product_change_log, 1);
  assert.equal(Number((await exec(`SELECT COUNT(*)::int n FROM products WHERE id=$1`, [clean])).rows[0].n), 0);
  assert.equal(Number((await exec(`SELECT COUNT(*)::int n FROM product_syd_codes WHERE product_id=$1`, [clean])).rows[0].n), 0);
  // 이력 2줄(연결 끊긴 create + 새 delete)이 코드로 남는다
  assert.equal(Number((await exec(`SELECT COUNT(*)::int n FROM product_change_log WHERE code='CB-CLEAN' AND product_id IS NULL`)).rows[0].n), 2);
  // 같은 코드 재등록 가능
  const again = await mk('CB-CLEAN');
  assert.ok(again > 0);

  // ⑥ 점검을 건너뛰고 지우면 FK 가 막는다 = 우리 판정이 유일한 방어선이 아니다(이중 안전장치)
  await exec('BEGIN');
  await assert.rejects(() => exec(`DELETE FROM products WHERE id=$1`, [sold]), (e) => e.code === '23503');
  await exec('ROLLBACK');
});

test('정리/연결해제 표 목록이 서로 겹치지 않는다', () => {
  for (const t of Object.keys(CLEANUP_TABLES)) assert.ok(!(t in NULLIFY_TABLES), t);
});

// ── ③ 마이그레이션 0222 ──────────────────────────────────────────────
dbTest('실 DB — 0222 가 0141 스키마(create/update 만 허용)에 멱등으로 적용된다', async (t) => {
  const pool = new pg.Pool({ connectionString: CONN });
  const SCHEMA = 'pdel_mig_test';
  let client = null;
  t.after(async () => {
    if (client) client.release();
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  const c = await pool.connect();
  client = c;
  await c.query(`SET search_path TO ${SCHEMA}`);

  // 0141 그대로(action 은 create/update 만, product_id 는 NULL 허용)
  await c.query(`
    CREATE TABLE products (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code TEXT UNIQUE);
    CREATE TABLE product_change_log (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      product_id BIGINT REFERENCES products(id), code TEXT,
      action TEXT NOT NULL CHECK (action IN ('create','update')),
      source TEXT NOT NULL DEFAULT 'manual', changes JSONB,
      changed_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);

  await assert.rejects(
    () => c.query(`INSERT INTO product_change_log (code, action) VALUES ('X','delete')`),
    (e) => e.code === '23514', '적용 전에는 delete 가 막힌다');

  const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0222_product_delete_log.sql'), 'utf-8');
  await c.query(sql);
  await c.query(sql);                                   // 멱등 — 두 번 돌려도 안전

  await c.query(`INSERT INTO product_change_log (product_id, code, action, source, changes)
                 VALUES (NULL,'X','delete','manual','{"_deleted":{"from":"X","to":null}}'::jsonb)`);
  assert.equal(Number((await c.query(`SELECT COUNT(*)::int n FROM product_change_log WHERE action='delete'`)).rows[0].n), 1);
  await assert.rejects(
    () => c.query(`INSERT INTO product_change_log (code, action) VALUES ('X','purge')`),
    (e) => e.code === '23514', '아무 값이나 허용하지는 않는다');
});

// ── ④ 이력 문장 ──────────────────────────────────────────────────────
test('삭제 이력 한 줄 요약(describeRow)', async () => {
  const { describeRow } = await import('../src/productHistory.js');
  const line = describeRow({
    kind: 'master', action: 'delete', source: 'manual',
    changes: { _deleted: { from: 'CB0001 로툴라', to: null }, _removed: { from: null, to: 'SyD 코드 2건' }, _reason: { from: null, to: '코드 오등록' } },
  });
  assert.match(line, /제품 삭제\(영구\)/);
  assert.match(line, /CB0001 로툴라/);
  assert.match(line, /사유: 코드 오등록/);
  assert.match(line, /함께 정리: SyD 코드 2건/);
  // 기존 동작 회귀
  assert.match(describeRow({ kind: 'status', action: 'deactivate', reason: '단종' }), /판매 중단/);
  assert.match(describeRow({ kind: 'master', action: 'create', source: 'import', changes: { name: { from: null, to: 'A' } } }), /제품 신규 등록/);
});
