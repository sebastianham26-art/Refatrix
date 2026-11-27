import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSyd, buildHeaderIndex, parseRow, diffProduct, buildPreview, COLUMN_MAP, parseAppEntry, parseApplications } from '../src/productImport.js';

test('parseAppEntry: maker/model/year', () => {
  assert.deepEqual(parseAppEntry('NISSAN Frontier 4X2 1998-2004'), { app_text: 'NISSAN Frontier 4X2 1998-2004', maker: 'NISSAN', model: 'Frontier 4X2', year_from: 1998, year_to: 2004 });
  assert.deepEqual(parseAppEntry('DODGE, CHRYSLER 200 2011-2014'), { app_text: 'DODGE, CHRYSLER 200 2011-2014', maker: 'DODGE, CHRYSLER', model: '200', year_from: 2011, year_to: 2014 });
  // single year, parentheses in model
  const r = parseAppEntry('DODGE, CHRYSLER Ram 2500 4X2 (Independent Suspension) 1994-1999');
  assert.equal(r.maker, 'DODGE, CHRYSLER');
  assert.equal(r.model, 'Ram 2500 4X2 (Independent Suspension)');
  assert.equal(r.year_from, 1994); assert.equal(r.year_to, 1999);
  // single year only
  const s = parseAppEntry('DODGE, CHRYSLER Imperial 1990');
  assert.equal(s.year_from, 1990); assert.equal(s.year_to, 1990);
});

test('parseApplications: splits by // ', () => {
  const a = parseApplications('JEEP Liberty 2002-2007 // JEEP Liberty 4X4 2002-2007');
  assert.equal(a.length, 2);
  assert.equal(a[0].model, 'Liberty');
  assert.equal(a[1].model, 'Liberty 4X4');
  assert.deepEqual(parseApplications(null), []);
});

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
    UPD1: { name: 'Old', scode: 'S2', app: 'app', list_price: 150, syd_codes: ['S2'], app_texts: ['app'] },
    SAME1: { name: 'Same', scode: 'S3', app: 'app', list_price: 300, syd_codes: ['S3'], app_texts: ['app'] },
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

// 2026-11-27h · 메이커 이름표(대소문자 · 하이픈 · 여러 단어) · 연식 범위 · 두 자리 · 괄호 연식
test('parseAppEntry 11-27h: 메이커 대소문자 · 여러 단어 · 연식 범위', () => {
  const P = (t) => { const r = parseAppEntry(t); return [r.maker, r.model, r.year_from, r.year_to]; };
  assert.deepEqual(P('Nissan Kicks 2017-2024'), ['Nissan', 'Kicks', 2017, 2024]);
  assert.deepEqual(P('Chevrolet Aveo 2018-2024'), ['Chevrolet', 'Aveo', 2018, 2024]);
  assert.deepEqual(P('Mercedes-Benz Clase C 2015-2020'), ['Mercedes-Benz', 'Clase C', 2015, 2020]);
  assert.deepEqual(P('GREAT WALL Poer 2021-2025'), ['GREAT WALL', 'Poer', 2021, 2025]);
  assert.deepEqual(P('LAND ROVER Defender 2020'), ['LAND ROVER', 'Defender', 2020, 2020]);
  assert.deepEqual(P('Ford, Mercury Grand Marquis 2003-2011'), ['Ford, Mercury', 'Grand Marquis', 2003, 2011]);
  assert.deepEqual(P('KIA Rio Sedan 17-24'), ['KIA', 'Rio Sedan', 2017, 2024]);
  assert.deepEqual(P('CHEVROLET Aveo (2018-2024)'), ['CHEVROLET', 'Aveo', 2018, 2024]);
  assert.deepEqual(P('Toyota Hilux 2016-24'), ['Toyota', 'Hilux', 2016, 2024]);
  assert.deepEqual(P('PEUGEOT 3008'), ['PEUGEOT', '3008', null, null], '3008 은 연식이 아니라 모델');
  assert.deepEqual(P('DODGE Ram 2500'), ['DODGE', 'Ram 2500', null, null]);
  assert.deepEqual(P('Versa 2015'), [null, 'Versa', 2015, 2015], '메이커가 없으면 비운다');
  assert.deepEqual(P('MG MG5 2021-2025'), ['MG', 'MG5', 2021, 2025]);
});
