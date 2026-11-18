// 0327 · 제품 무게 · 개별 박스 사이즈 + 견적 대략 총무게 · 사이즈 — 실 PostgreSQL 시험
//   DATABASE_URL=postgres://… node --test test/product_dims_e2e.test.mjs
//   임시 스키마에 최소 표(users · products · quotes · quote_lines)를 만들고 0327 을 그대로 적용한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  tableToRows, parseNum, parseDimsCell, headerField, previewDims, applyDims, exportDims,
  aggregateLines, estimateShipment, SHIP_SELECT, SHIP_JOIN, shipFromRow, dimsReady, _resetDimsReady,
} from '../src/productDims.js';
import { classifyTable } from '../src/productDelete.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0327_product_dims.sql'), 'utf8');
const url = process.env.DATABASE_URL;
const SCHEMA = 'dims_t_' + process.pid;

test('표 해석 — 머리글 · 단위 · 빈칸 · 지우기 · 중복 · 오류', () => {
  const t = [
    ['Clave CTR', 'Peso (kg)', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)', 'Producto'],
    ['cb0458', 0.85, 32, 12, 9, 'x'],
    ['CS1045', '1,5', '', '', '', ''],          // 소수점 쉼표 · 사이즈는 그대로
    ['CR0490', '-', 20, 10, 5, ''],             // 무게 지우기
    ['CB0458', '', 33, '', '', ''],             // 중복 → 마지막 줄 값이 덮음(무게는 앞줄 유지)
    ['BAD1', 'abc', 0, 1, 1, ''],               // 오류
    ['', 1, 1, 1, 1, ''],                       // 코드 없음 → 건너뜀
    ['EMPTY1', '', '', '', '', ''],             // 바꿀 것 없음
  ];
  const r = tableToRows(t);
  assert.equal(r.headerless, false);
  assert.deepEqual(r.columns.sort(), ['box_h_cm', 'box_l_cm', 'box_w_cm', 'weight_kg']);
  const by = Object.fromEntries(r.rows.map((x) => [x.code, x.set]));
  assert.deepEqual(by.CB0458, { weight_kg: 0.85, box_l_cm: 33, box_w_cm: 12, box_h_cm: 9 });
  assert.deepEqual(by.CS1045, { weight_kg: 1.5 });
  assert.deepEqual(by.CR0490, { weight_kg: null, box_l_cm: 20, box_w_cm: 10, box_h_cm: 5 });
  assert.equal(r.dup, 1);
  assert.equal(r.errors.length, 1); assert.equal(r.errors[0].code, 'BAD1'); assert.equal(r.errors[0].row, 6);
  assert.ok(!by.EMPTY1);
});

test('표 해석 — 그램 · mm · 한 칸 사이즈 · 한국어/스페인어 머리글 · 머리글 없음', () => {
  assert.deepEqual(headerField('Peso (g)'), { field: 'weight_kg', scale: 0.001 });
  assert.deepEqual(headerField('Largo (mm)'), { field: 'box_l_cm', scale: 0.1 });
  assert.equal(headerField('무게').field, 'weight_kg');
  assert.equal(headerField('가로').field, 'box_l_cm');
  assert.equal(headerField('세로').field, 'box_w_cm');
  assert.equal(headerField('높이').field, 'box_h_cm');
  assert.equal(headerField('Medidas (cm)').field, 'dims');
  assert.equal(headerField('Producto'), null);
  const r = tableToRows([['CTR', 'Peso (g)', 'Medidas (cm)'], ['AA0001', 850, '30 x 20 x 10'], ['AA0002', '1200', '30x20']]);
  assert.deepEqual(r.rows[0].set, { weight_kg: 0.85, box_l_cm: 30, box_w_cm: 20, box_h_cm: 10 });
  assert.equal(r.errors.length, 1);   // 30x20 → 3개 아님
  const mm = tableToRows([['코드', '가로(mm)', '세로(mm)', '높이(mm)'], ['AA0003', 305, 120, 95]]);
  assert.deepEqual(mm.rows[0].set, { box_l_cm: 30.5, box_w_cm: 12, box_h_cm: 9.5 });
  const hl = tableToRows([['AB1234', 2, 10, 10, 10], ['AB1235', '', 5, 5, 5]]);
  assert.equal(hl.headerless, true);
  assert.deepEqual(hl.rows.map((x) => x.code), ['AB1234', 'AB1235']);
  assert.equal(parseNum('1,234.5', 'weight_kg').error != null, true);   // 500 kg 넘음
  assert.equal(parseNum('900', 'weight_kg').error != null, true);
  assert.deepEqual(parseNum('0.4 kg', 'weight_kg'), { value: 0.4 });
  assert.deepEqual(parseDimsCell('-'), { clear: true });
});

test('대략 사이즈 — 1개 = 그 박스 · 여러 개 = 85% 채움 · 큰 박스보다 작지 않게 · 자료 없는 줄', () => {
  const one = estimateShipment(aggregateLines([{ product_id: 1, qty: 1, weight_kg: 2, box_l_cm: 10, box_w_cm: 40, box_h_cm: 20 }]));
  assert.deepEqual(one.dims, { l: 40, w: 20, h: 10 });
  assert.equal(one.weight_kg, 2);
  // 같은 박스 10×10×10 을 100개 → 순부피 100,000 → ÷0.85 = 117,647 → 정육면체 한 변 ≈ 49.0 → 49×49×49
  const many = estimateShipment(aggregateLines([{ product_id: 1, qty: 100, weight_kg: 0.5, box_l_cm: 10, box_w_cm: 10, box_h_cm: 10 }]));
  assert.equal(many.weight_kg, 50);
  assert.deepEqual(many.dims, { l: 49, w: 49, h: 49 });
  assert.equal(many.net_m3, 0.1);
  assert.ok(many.dims.l * many.dims.w * many.dims.h >= 100000 / 0.85);
  // 긴 박스(쇼크 업소버 70×12×12) 2개 + 작은 박스 → 가로는 70 이상
  const long = estimateShipment(aggregateLines([
    { product_id: 1, qty: 2, weight_kg: 3, box_l_cm: 70, box_w_cm: 12, box_h_cm: 12 },
    { product_id: 2, qty: 4, weight_kg: null, box_l_cm: 10, box_w_cm: 8, box_h_cm: 6 },
    { product_id: 3, qty: 5, weight_kg: 1, box_l_cm: null, box_w_cm: null, box_h_cm: null },
    { product_id: null, qty: 3 },
  ]));
  assert.ok(long.dims.l >= 70 && long.dims.w >= 12 && long.dims.h >= 12);
  assert.equal(long.weight_kg, 11);
  assert.equal(long.wt_miss, 1); assert.equal(long.wt_miss_qty, 4);
  assert.equal(long.d_miss, 1); assert.equal(long.d_miss_qty, 5);
  assert.equal(long.unreg, 1); assert.equal(long.unreg_qty, 3);
  const none = estimateShipment(aggregateLines([{ product_id: 1, qty: 2 }]));
  assert.equal(none.nodata, true);
  assert.equal(estimateShipment(aggregateLines([])), null);
});

test('product_dims_log 은 제품 삭제 때 함께 정리되는 표', () => {
  assert.equal(classifyTable('product_dims_log'), 'cleanup');
});

test('실 PostgreSQL — 0327 적용 · 미리보기 · 반영 · 이력 · 다운로드 · 견적 SQL 집계', { skip: !url }, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const c = await pool.connect();
  const exec = c.query.bind(c);
  try {
    await exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}`);
    await exec(`CREATE TABLE users (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT);
      CREATE TABLE products (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, deleted_at TIMESTAMPTZ);
      CREATE TABLE quotes (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, quote_no TEXT);
      CREATE TABLE quote_lines (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, quote_id BIGINT REFERENCES quotes(id),
        product_id BIGINT REFERENCES products(id), qty NUMERIC NOT NULL);
      INSERT INTO users(name) VALUES ('dir');
      INSERT INTO products(code,name) VALUES ('CB0458','Rotula'),('CS1045','Amortiguador'),('CR0490','Terminal'),('ZZ0001','Borrado');
      UPDATE products SET deleted_at = now() WHERE code = 'ZZ0001';`);
    _resetDimsReady();
    assert.equal(await dimsReady(exec), false);       // 0327 전
    await exec(MIG);
    await exec(MIG);                                  // 멱등
    _resetDimsReady();
    assert.equal(await dimsReady(exec), true);

    const table = [['Clave CTR', 'Peso (kg)', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)'],
      ['CB0458', 0.85, 32, 12, 9], ['cs1045', 3.2, 70, 12, 12], ['ZZ0001', 1, 1, 1, 1], ['NOPE99', 1, 1, 1, 1]];
    const parsed = tableToRows(table);
    const pv = await previewDims(exec, parsed.rows);
    assert.equal(pv.items.length, 2);
    assert.deepEqual(pv.unknown.map((u) => u.code).sort(), ['NOPE99', 'ZZ0001']);   // 삭제 제품 = 미등록 취급
    await exec('BEGIN');
    const ap = await applyDims(exec, parsed.rows, { userId: 1 });
    await exec('COMMIT');
    assert.equal(ap.products, 2); assert.equal(ap.fields, 8);
    const p = (await exec(`SELECT code, weight_kg, box_l_cm, dims_updated_by FROM products WHERE code='CB0458'`)).rows[0];
    assert.equal(Number(p.weight_kg), 0.85); assert.equal(Number(p.box_l_cm), 32); assert.equal(Number(p.dims_updated_by), 1);
    // 다시 올리면 동일 · 「-」 지우기 · 빈칸 유지
    const again = await previewDims(exec, parsed.rows);
    assert.equal(again.items.length, 0); assert.equal(again.same, 2);
    const clr = tableToRows([['CTR', 'Peso (kg)', 'Alto (cm)'], ['CB0458', '-', '']]);
    await exec('BEGIN'); const ap2 = await applyDims(exec, clr.rows, { userId: 1 }); await exec('COMMIT');
    assert.equal(ap2.fields, 1);
    const p2 = (await exec(`SELECT weight_kg, box_h_cm FROM products WHERE code='CB0458'`)).rows[0];
    assert.equal(p2.weight_kg, null); assert.equal(Number(p2.box_h_cm), 9);
    const log = (await exec(`SELECT COUNT(*)::int n, COUNT(DISTINCT batch_id)::int b FROM product_dims_log`)).rows[0];
    assert.deepEqual(log, { n: 9, b: 2 });
    // CHECK 제약 — 0 이하 거부
    await assert.rejects(exec(`UPDATE products SET weight_kg = 0 WHERE code='CS1045'`));
    // 다운로드
    const ex = await exportDims(exec);
    assert.equal(ex.items.length, 3);
    assert.deepEqual(ex.stat, { total: 3, weight: 1, dims: 2, both: 1 });

    // 견적 SQL 집계 = JS 집계 (목록 · 상세가 같은 숫자)
    await exec(`UPDATE products SET weight_kg = 0.5, box_l_cm = 10, box_w_cm = 8, box_h_cm = 6 WHERE code='CR0490'`);
    const qid = Number((await exec(`INSERT INTO quotes(quote_no) VALUES ('Q-T1') RETURNING id`)).rows[0].id);
    const pid = Object.fromEntries((await exec(`SELECT id, code FROM products`)).rows.map((r) => [r.code, Number(r.id)]));
    await exec(`INSERT INTO quote_lines(quote_id, product_id, qty) VALUES ($1,$2,2),($1,$3,4),($1,$4,10),($1,NULL,3),($1,$4,0)`,
      [qid, pid.CS1045, pid.CB0458, pid.CR0490]);
    const row = (await exec(`SELECT q.id ${SHIP_SELECT} FROM quotes q ${SHIP_JOIN} WHERE q.id = $1`, [qid])).rows[0];
    const viaSql = shipFromRow(row);
    const lines = (await exec(`SELECT ql.product_id, ql.qty, p.weight_kg, p.box_l_cm, p.box_w_cm, p.box_h_cm
                                 FROM quote_lines ql LEFT JOIN products p ON p.id = ql.product_id WHERE ql.quote_id = $1`, [qid])).rows;
    const viaJs = estimateShipment(aggregateLines(lines));
    assert.deepEqual(viaSql, viaJs);
    assert.equal(viaSql.weight_kg, 11.4);           // 3.2×2 + 0.5×10 (CB0458 무게 지움 → 4개 빠짐)
    assert.equal(viaSql.wt_miss, 1); assert.equal(viaSql.wt_miss_qty, 4);
    assert.equal(viaSql.unreg, 1); assert.equal(viaSql.d_miss, 0);
    assert.ok(viaSql.dims.l >= 70);
    // 무게 · 사이즈 없는 견적 → nodata
    await exec(`UPDATE products SET weight_kg=NULL, box_l_cm=NULL, box_w_cm=NULL, box_h_cm=NULL`);
    const row2 = (await exec(`SELECT q.id ${SHIP_SELECT} FROM quotes q ${SHIP_JOIN} WHERE q.id = $1`, [qid])).rows[0];
    assert.equal(shipFromRow(row2).nodata, true);
    // 줄이 없는 견적
    const q2 = Number((await exec(`INSERT INTO quotes(quote_no) VALUES ('Q-T2') RETURNING id`)).rows[0].id);
    const row3 = (await exec(`SELECT q.id ${SHIP_SELECT} FROM quotes q ${SHIP_JOIN} WHERE q.id = $1`, [q2])).rows[0];
    assert.equal(shipFromRow(row3), null);
  } finally {
    try { await exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } catch (_) {}
    c.release(); await pool.end();
  }
});
