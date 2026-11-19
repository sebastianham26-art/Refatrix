// 0327 · 0328 · 제품 무게 · 포장 박스 코드 · 포장 박스 마스터 + 견적 대략 총무게 · 사이즈 — 실 PostgreSQL 시험
//   DATABASE_URL=postgres://… node --test test/product_dims_e2e.test.mjs
//   임시 스키마에 최소 표(users · products · quotes · quote_lines)를 만들고 0327 · 0328 을 그대로 적용한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  tableToRows, parseNum, parseDimsCell, headerField, previewDims, applyDims, exportDims,
  previewBoxes, applyBoxes, exportBoxes,
  aggregateLines, estimateShipment, SHIP_SELECT, SHIP_JOIN, shipFromRow, dimsReady, _resetDimsReady,
} from '../src/productDims.js';
import { classifyTable } from '../src/productDelete.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mig = (f) => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8');
const url = process.env.DATABASE_URL;
const SCHEMA = 'dims_t_' + process.pid;

test('제품 표 해석 — CTR · 무게 · 박스 코드 · 빈칸 · 지우기 · 중복 · 오류 · 가로세로높이 열은 무시', () => {
  const t = [
    ['Clave CTR', 'Peso (kg)', 'Caja', 'Producto', 'Largo caja (cm)'],
    ['cb0458', 0.85, ' caja  3 ', 'x', 99],
    ['CS1045', '1,5', '', '', ''],
    ['CR0490', '-', 'C-12', '', ''],
    ['CB0458', '', 'CAJA 4', '', ''],      // 중복 → 마지막 줄 박스, 무게는 앞줄 유지
    ['BAD1', 'abc', 'X', '', ''],
    ['', 1, 'Y', '', ''],
    ['EMPTY1', '', '', '', ''],
    ['CLR1', '', '-', '', ''],
  ];
  const r = tableToRows(t);
  assert.equal(r.headerless, false);
  assert.deepEqual(r.columns.sort(), ['box_code', 'weight_kg']);
  const by = Object.fromEntries(r.rows.map((x) => [x.code, x.set]));
  assert.deepEqual(by.CB0458, { weight_kg: 0.85, box_code: 'CAJA 4' });
  assert.deepEqual(by.CS1045, { weight_kg: 1.5 });
  assert.deepEqual(by.CR0490, { weight_kg: null, box_code: 'C-12' });
  assert.deepEqual(by.CLR1, { box_code: null });
  assert.equal(r.dup, 1);
  assert.equal(r.errors.length, 1); assert.equal(r.errors[0].code, 'BAD1');
  assert.ok(!by.EMPTY1);
  assert.equal(headerField('박스 명칭').field, 'box_code');
  assert.equal(headerField('포장박스').field, 'box_code');
  assert.equal(headerField('Largo (cm)'), null);            // 제품 업로드는 사이즈를 읽지 않는다
  const hl = tableToRows([['AB1234', 2, 'CAJA 1'], ['AB1235', '', 'caja 2']]);
  assert.equal(hl.headerless, true);
  assert.deepEqual(hl.rows.map((x) => x.set), [{ weight_kg: 2, box_code: 'CAJA 1' }, { box_code: 'CAJA 2' }]);
});

test('박스 표 해석 — 박스 코드 · 가로 · 세로 · 높이 · mm · 한 칸 사이즈 · 설명', () => {
  assert.equal(headerField('Código caja', 'box').field, 'code');
  assert.equal(headerField('가로', 'box').field, 'box_l_cm');
  assert.equal(headerField('세로', 'box').field, 'box_w_cm');
  assert.equal(headerField('높이', 'box').field, 'box_h_cm');
  assert.deepEqual(headerField('Largo (mm)', 'box'), { field: 'box_l_cm', scale: 0.1 });
  const r = tableToRows([['Código caja', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)', 'Descripción', 'Productos'],
    ['caja 3', 32, 12, 9, 'Rótula', 5], ['CAJA 4', '', '', '', '', 0], ['C-12', 'x', 1, 1, '', 0]], 'box');
  assert.deepEqual(r.rows[0], { row: 2, code: 'CAJA 3', set: { box_l_cm: 32, box_w_cm: 12, box_h_cm: 9, description: 'Rótula' } });
  assert.deepEqual(r.rows[1].set, {});                       // 코드만 → 박스 등록
  assert.equal(r.errors.length, 1);
  const m = tableToRows([['Caja', 'Medidas (mm)'], ['A1', '300 x 200 x 100']], 'box');
  assert.deepEqual(m.rows[0].set, { box_l_cm: 30, box_w_cm: 20, box_h_cm: 10 });
  const hl = tableToRows([['CAJA 9', 10, 10, 10, 'chica']], 'box');
  assert.equal(hl.headerless, true); assert.deepEqual(hl.rows[0].set, { box_l_cm: 10, box_w_cm: 10, box_h_cm: 10, description: 'chica' });
  assert.equal(parseNum('900', 'weight_kg').error != null, true);
  assert.deepEqual(parseDimsCell('-'), { clear: true });
});

test('대략 사이즈 — 1개 = 그 박스 · 여러 개 = 85% 채움 · 박스 코드 없음 / 사이즈 미입력 구분', () => {
  const one = estimateShipment(aggregateLines([{ product_id: 1, qty: 1, weight_kg: 2, box_code: 'A', box_l_cm: 10, box_w_cm: 40, box_h_cm: 20 }]));
  assert.deepEqual(one.dims, { l: 40, w: 20, h: 10 });
  const many = estimateShipment(aggregateLines([{ product_id: 1, qty: 100, weight_kg: 0.5, box_code: 'A', box_l_cm: 10, box_w_cm: 10, box_h_cm: 10 }]));
  assert.equal(many.weight_kg, 50); assert.deepEqual(many.dims, { l: 49, w: 49, h: 49 });
  const mix = estimateShipment(aggregateLines([
    { product_id: 1, qty: 2, weight_kg: 3, box_code: 'LARGA', box_l_cm: 70, box_w_cm: 12, box_h_cm: 12 },
    { product_id: 2, qty: 4, weight_kg: null, box_code: 'NUEVA', box_l_cm: null },
    { product_id: 3, qty: 5, weight_kg: 1, box_code: null },
    { product_id: null, qty: 3 },
  ]));
  assert.ok(mix.dims.l >= 70);
  assert.equal(mix.weight_kg, 11);
  assert.deepEqual([mix.d_nobox, mix.d_nobox_qty, mix.d_nosize, mix.d_nosize_qty, mix.d_miss], [1, 5, 1, 4, 2]);
  assert.deepEqual(mix.nosize_boxes, ['NUEVA']);
  assert.equal(mix.unreg, 1);
  assert.equal(estimateShipment(aggregateLines([{ product_id: 1, qty: 2 }])).nodata, true);
  assert.equal(estimateShipment(aggregateLines([])), null);
});

test('product_dims_log 은 제품 삭제 때 함께 정리되는 표', () => {
  assert.equal(classifyTable('product_dims_log'), 'cleanup');
});

test('실 PostgreSQL — 0327 → 0328 · 제품 박스 코드 · 박스 마스터 나중 입력 · 견적 SQL 집계', { skip: !url }, async () => {
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
    await exec(mig('0327_product_dims.sql'));
    _resetDimsReady();
    assert.equal(await dimsReady(exec), false);       // 0327 만 → 아직
    await exec(mig('0328_packing_boxes.sql'));
    await exec(mig('0328_packing_boxes.sql'));        // 멱등
    _resetDimsReady();
    assert.equal(await dimsReady(exec), true);

    // ① 제품 업로드 — 박스 코드만(사이즈는 아직 모름)
    const prod = tableToRows([['Clave CTR', 'Peso (kg)', 'Caja'],
      ['CB0458', 0.85, 'caja 3'], ['CS1045', 3.2, 'LARGA'], ['CR0490', 0.5, 'CAJA 3'], ['ZZ0001', 1, 'X'], ['NOPE99', 1, 'X']]);
    const pv = await previewDims(exec, prod.rows);
    assert.equal(pv.items.length, 3);
    assert.deepEqual(pv.unknown.map((u) => u.code).sort(), ['NOPE99', 'ZZ0001']);
    assert.deepEqual(pv.new_boxes, ['CAJA 3', 'LARGA']);
    await exec('BEGIN'); const ap = await applyDims(exec, prod.rows, { userId: 1 }); await exec('COMMIT');
    assert.equal(ap.products, 3); assert.equal(ap.fields, 6);
    const lg = (await exec(`SELECT field, old_text, new_text, new_value FROM product_dims_log WHERE code='CB0458' ORDER BY field`)).rows;
    assert.deepEqual(lg.map((x) => [x.field, x.new_text, x.new_value == null ? null : Number(x.new_value)]), [['box_code', 'CAJA 3', null], ['weight_kg', null, 0.85]]);
    let bx = await exportBoxes(exec);
    assert.deepEqual(bx.items.map((b) => [b.code, b.products, b.box_l_cm]), [['CAJA 3', 2, null], ['LARGA', 1, null]]);
    assert.deepEqual(bx.stat, { total: 2, sized: 0, nosize: 2, nosize_products: 3 });
    // 다시 올리면 새 박스 아님 · 사이즈 없음으로 안내
    const pv2 = await previewDims(exec, prod.rows);
    assert.equal(pv2.items.length, 0); assert.deepEqual(pv2.new_boxes, []); assert.deepEqual(pv2.nosize_boxes, ['CAJA 3', 'LARGA']);

    // ② 견적 — 박스 사이즈 전: 무게만, 사이즈 미입력
    const qid = Number((await exec(`INSERT INTO quotes(quote_no) VALUES ('Q-T1') RETURNING id`)).rows[0].id);
    const pid = Object.fromEntries((await exec(`SELECT id, code FROM products`)).rows.map((r) => [r.code, Number(r.id)]));
    await exec(`INSERT INTO quote_lines(quote_id, product_id, qty) VALUES ($1,$2,2),($1,$3,4),($1,$4,10),($1,NULL,3),($1,$4,0)`,
      [qid, pid.CS1045, pid.CB0458, pid.CR0490]);
    const sel = `SELECT q.id ${SHIP_SELECT} FROM quotes q ${SHIP_JOIN} WHERE q.id = $1`;
    const s0 = shipFromRow((await exec(sel, [qid])).rows[0]);
    assert.equal(s0.weight_kg, 14.8);                // 3.2×2 + 0.85×4 + 0.5×10
    assert.equal(s0.dims, null);
    assert.equal(s0.d_nosize, 3); assert.equal(s0.d_nosize_qty, 16); assert.equal(s0.d_nobox, 0); assert.equal(s0.unreg, 1);

    // ③ 박스 마스터 나중 입력 → 사이즈 계산
    const box = tableToRows([['Código caja', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)', 'Descripción'],
      ['CAJA 3', 32, 12, 9, 'chica'], ['larga', 70, 12, 12, ''], ['NUEVA', '', '', '', 'sin medidas']], 'box');
    const bp = await previewBoxes(exec, box.rows);
    assert.deepEqual(bp.items.map((x) => [x.code, x.is_new, x.products, x.changes.length]), [['CAJA 3', false, 2, 4], ['LARGA', false, 1, 3], ['NUEVA', true, 0, 1]]);
    await exec('BEGIN'); const ba = await applyBoxes(exec, box.rows, { userId: 1 }); await exec('COMMIT');
    assert.deepEqual([ba.boxes, ba.created, ba.fields], [3, 1, 8]);
    assert.equal((await previewBoxes(exec, box.rows)).same, 3);
    await assert.rejects(exec(`UPDATE packing_boxes SET box_l_cm = 0 WHERE code='CAJA 3'`));
    bx = await exportBoxes(exec);
    assert.deepEqual(bx.stat, { total: 3, sized: 2, nosize: 1, nosize_products: 0 });

    const row = (await exec(sel, [qid])).rows[0];
    const viaSql = shipFromRow(row);
    const lines = (await exec(`SELECT ql.product_id, ql.qty, p.weight_kg, p.box_code, pb.box_l_cm, pb.box_w_cm, pb.box_h_cm
                                 FROM quote_lines ql LEFT JOIN products p ON p.id = ql.product_id
                                 LEFT JOIN packing_boxes pb ON pb.code = p.box_code WHERE ql.quote_id = $1`, [qid])).rows;
    const viaJs = estimateShipment(aggregateLines(lines));
    delete viaJs.nosize_boxes;                       // 목록 SQL 은 박스 이름 목록을 싣지 않는다(상세만)
    assert.deepEqual(viaSql, viaJs);
    assert.ok(viaSql.dims && viaSql.dims.l >= 70);
    assert.equal(viaSql.d_pcs, 16); assert.equal(viaSql.d_miss, 0);
    // 박스 코드 지움 → 박스 코드 없음
    await exec('BEGIN'); await applyDims(exec, tableToRows([['CTR', 'Caja'], ['CR0490', '-']]).rows, { userId: 1 }); await exec('COMMIT');
    const s2 = shipFromRow((await exec(sel, [qid])).rows[0]);
    assert.equal(s2.d_nobox, 1); assert.equal(s2.d_nobox_qty, 10);
    // 다운로드(제품) — 박스 사이즈 참고 칸
    const ex = await exportDims(exec);
    const cb = ex.items.find((x) => x.code === 'CB0458');
    assert.deepEqual([cb.weight_kg, cb.box_code, cb.box_l_cm, cb.box_w_cm, cb.box_h_cm], [0.85, 'CAJA 3', 32, 12, 9]);
    assert.deepEqual(ex.stat, { total: 3, weight: 3, box: 2, sized: 2 });
    const q2 = Number((await exec(`INSERT INTO quotes(quote_no) VALUES ('Q-T2') RETURNING id`)).rows[0].id);
    assert.equal(shipFromRow((await exec(sel, [q2])).rows[0]), null);
  } finally {
    try { await exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } catch (_) {}
    c.release(); await pool.end();
  }
});
