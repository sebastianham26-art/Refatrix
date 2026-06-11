import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSyd, buildHeaderIndex, parseRow, diffProduct, buildPreview, COLUMN_MAP } from '../src/productImport.js';

test('splitSyd handles single, multiple, spacing', () => {
  assert.deepEqual(splitSyd('1026018'), ['1026018']);
  assert.deepEqual(splitSyd('1026018 // 1026017'), ['1026018', '1026017']);
  assert.deepEqual(splitSyd('6Q0-407-365-A // 1026011 // 48520-15U26'), ['6Q0-407-365-A', '1026011', '48520-15U26']);
  assert.deepEqual(splitSyd('A//B'), ['A', 'B']); // 공백 없는 변형
  assert.deepEqual(splitSyd(null), []);
  assert.deepEqual(splitSyd('  '), []);
});

const HEADER = ['Clave CTR', 'Clave SyD', 'Aplicacion (Maker : Model : Year)', 'Nombre del producto', 'Clave SAT', 'Origen', 'List Price', 'IVA', 'Barcode (EAN13)', 'Fast Movement Location', 'List Price de SYD', 'Precio Cliente de SYD', 'Precio Cliente de CTR'];

test('buildHeaderIndex + parseRow maps file columns', () => {
  const idx = buildHeaderIndex(HEADER);
  assert.equal(idx.code, 0); assert.equal(idx.list_price, 6); assert.equal(idx.list_price_syd, 10);
  const row = ['CB0552L', '6Q0-407-365-A // 1026011', 'VW Bora', 'RÓTULA', null, null, 764.4, null, null, null, 546, null, null];
  const p = parseRow(row, idx);
  assert.equal(p.code, 'CB0552L');
  assert.equal(p.name, 'RÓTULA');
  assert.equal(p.list_price, 764.4);
  assert.equal(p.list_price_syd, 546);
  assert.deepEqual(p.syd_codes, ['6Q0-407-365-A', '1026011']);
  assert.equal(p.iva_rate, null); // 빈값
});

test('parseRow returns null when no code', () => {
  const idx = buildHeaderIndex(HEADER);
  assert.equal(parseRow([null, 'x', '', 'name'], idx), null);
});

test('diffProduct: new vs changed vs same', () => {
  const idx = buildHeaderIndex(HEADER);
  const row = ['CA0032', '48530-3S125', 'NISSAN', 'BRAZO', null, null, 764.4, null, null, null, 546, null, null];
  const p = parseRow(row, idx);
  // new
  assert.equal(diffProduct(p, null).isNew, true);
  // same (existing identical)
  const same = diffProduct(p, { scode: '48530-3S125', app: 'NISSAN', name: 'BRAZO', list_price: 764.4, list_price_syd: 546, sat_code: null, origin: null, iva_rate: null, ean: null, location: null, price_customer_syd: null, price_customer_ctr: null, syd_codes: ['48530-3S125'] });
  assert.equal(same.isNew, false);
  assert.equal(Object.keys(same.changes).length, 0);
  assert.equal(same.syd_changed, false);
  // changed price + name
  const ch = diffProduct(p, { scode: '48530-3S125', app: 'NISSAN', name: 'BRAZO VIEJO', list_price: 700, list_price_syd: 546, syd_codes: ['48530-3S125'] });
  assert.equal(ch.changes.name.to, 'BRAZO');
  assert.equal(ch.changes.list_price.from, 700);
  assert.equal(ch.changes.list_price.to, 764.4);
});

test('diffProduct: stock/avg_cost never in changes (not updatable)', () => {
  const idx = buildHeaderIndex(HEADER);
  const p = parseRow(['X1', 'S1', 'app', 'name', null, null, 100, null, null, null, null, null, null], idx);
  const d = diffProduct(p, { name: 'name', scode: 'S1', app: 'app', list_price: 100, stock_qty: 50, avg_cost: 33, syd_codes: ['S1'] });
  assert.ok(!('stock_qty' in d.changes));
  assert.ok(!('avg_cost' in d.changes));
});

test('diffProduct: syd change detected', () => {
  const idx = buildHeaderIndex(HEADER);
  const p = parseRow(['X1', 'A // B', 'app', 'name', null, null, 100, null, null, null, null, null, null], idx);
  const d = diffProduct(p, { name: 'name', scode: 'A', app: 'app', list_price: 100, syd_codes: ['A'] });
  assert.equal(d.syd_changed, true);
});

test('buildPreview aggregates new/updated/unchanged/errors/duplicates', () => {
  const idx = buildHeaderIndex(HEADER);
  const rows = [
    ['NEW1', 'S1', 'app', 'New One', null, null, 100, null, null, null, null, null, null],
    ['UPD1', 'S2', 'app', 'Updated', null, null, 200, null, null, null, null, null, null],
    ['SAME1', 'S3', 'app', 'Same', null, null, 300, null, null, null, null, null, null],
    ['NONAME', 'S4', 'app', null, null, null, 400, null, null, null, null, null, null],
    ['NEW1', 'S1', 'app', 'Dup', null, null, 100, null, null, null, null, null, null], // duplicate code
  ].map((r) => parseRow(r, idx));
  const existing = {
    UPD1: { name: 'Old', scode: 'S2', app: 'app', list_price: 150, syd_codes: ['S2'] },
    SAME1: { name: 'Same', scode: 'S3', app: 'app', list_price: 300, syd_codes: ['S3'] },
  };
  const pv = buildPreview(rows, existing);
  assert.equal(pv.new_items.length, 1);
  assert.equal(pv.new_items[0].code, 'NEW1');
  assert.equal(pv.updated.length, 1);
  assert.equal(pv.updated[0].code, 'UPD1');
  assert.equal(pv.unchanged, 1);
  assert.equal(pv.errors.length, 1);
  assert.equal(pv.errors[0].code, 'NONAME');
  assert.deepEqual(pv.duplicates, ['NEW1']);
});
