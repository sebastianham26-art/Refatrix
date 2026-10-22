// 0292 · 제품 장착 위치 — 읽기 규칙(순수 함수) + 업로드(미리보기·전체 교체)·조회 라우트(실 PostgreSQL)
//   실행: node --import ./test/helpers/stub-auth.mjs --test test/product_positions.test.mjs
//         (라우트 시험은 DATABASE_URL = 전체 마이그레이션 된 빈 DB 일 때만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { parsePosition, splitCodes, buildPositionRows, summarize, mapHeader, lrOf } from '../src/productPositions.js';

test('parsePosition: Position 앞부분이 우선, 없으면 Block · 상/하 · 좌/우 · 스페인어·한국어', () => {
  assert.deepEqual(parsePosition('Front', 'Front Lower LH'), { block: 'front', level: 'lower', side: 'lh' });
  assert.deepEqual(parsePosition('Front', 'Rear Upper RH'), { block: 'rear', level: 'upper', side: 'rh' });
  assert.deepEqual(parsePosition('Rear', 'LH'), { block: 'rear', level: null, side: 'lh' });
  assert.deepEqual(parsePosition('Front', ''), { block: 'front', level: null, side: null });
  assert.deepEqual(parsePosition('', 'Delantera Inferior Izq.'), { block: 'front', level: 'lower', side: 'lh' });
  assert.deepEqual(parsePosition('', '뒤 상 우'), { block: 'rear', level: 'upper', side: 'rh' });
  assert.equal(parsePosition('', 'LH'), null, '앞/뒤를 모르면 버림');
});

test('splitCodes · lrOf · mapHeader', () => {
  assert.deepEqual(splitCodes('GV1031 // GV1032'), ['GV1031', 'GV1032']);
  assert.deepEqual(splitCodes('CL04770S // CL0477, x; X'), ['CL04770S', 'CL0477']);
  assert.deepEqual(splitCodes('OE Missing'), []);
  assert.deepEqual(lrOf('CQ0340L'), { base: 'CQ0340', s: 'L' }); assert.equal(lrOf('GY2109G'), null);
  const idx = mapHeader(['Row ID', 'VIO Rank', 'Brand', 'Model', 'Model (Generation)', 'Model Years', 'Generation VIO', 'Block', 'Part', 'Position', 'OE', 'x', 'x', 'SYD', 'x', 'x', 'BAW', 'GROB', 'Moog', 'KYB', 'VASLO', 'YOKOMITSU', 'CTR', 'Status', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', '4th CTR']);
  assert.deepEqual([idx.brand, idx.model, idx.gen, idx.years, idx.block, idx.part, idx.position, idx.ctr, idx.status, idx.ctr4], [2, 3, 4, 5, 7, 8, 9, 22, 23, 34]);
});

test('buildPositionRows: L/R 짝은 접미사로 좌우 · 여러 코드 · 4th CTR · 중복 제거 · 요약', () => {
  const known = new Set(['CQ0340L', 'CQ0340R', 'GV1031']);
  const { rows, stats } = buildPositionRows([
    { ctr: 'CQ0340L // CQ0340R', block: 'Front', position: 'Front Lower LH', part: 'CONTROL ARM', brand: 'VW', model: 'Jetta', gen: 'A4', years: '1999-2005', status: 'Confirmed' },
    { ctr: 'CQ0340L // CQ0340R', block: 'Front', position: 'Front Lower LH', part: 'CONTROL ARM', brand: 'VW', model: 'Jetta', gen: 'A4', years: '1999-2005', status: 'Confirmed' },   // 같은 줄 두 번
    { ctr: 'GV1031 // GV1032', block: 'Front', position: 'Front Lower', part: 'CONTROL ARM BUSHING', model: 'Versa', years: '2012-2019' },
    { ctr: '', ctr4: 'GA0127', block: 'Rear', position: 'Rear', part: 'SHOCK', model: 'Aveo', years: '2008' },
    { ctr: '', ctr4: 'X', block: 'Rear', position: 'Rear' },
    { ctr: 'CB0336', block: '', position: 'LH' },     // 앞/뒤 모름
  ], known);
  assert.equal(stats.rows_in, 6); assert.equal(stats.rows_with_code, 5); assert.equal(stats.no_position, 1);
  const r = (c) => rows.filter((x) => x.ctr_code === c);
  assert.equal(r('CQ0340L')[0].side, 'lh'); assert.equal(r('CQ0340L')[0].side_fixed, false);
  assert.equal(r('CQ0340R')[0].side, 'rh'); assert.equal(r('CQ0340R')[0].side_fixed, true, 'LH 줄에 같이 적힌 R 코드 → RH');
  assert.equal(r('CQ0340R').length, 1, '중복 줄은 한 번');
  assert.equal(r('GA0127')[0].src_col, '4th CTR'); assert.equal(r('GA0127')[0].y_from, 2008);
  assert.equal(stats.codes, 5); assert.equal(stats.codes_known, 3);
  assert.deepEqual(stats.unknown_codes, ['GA0127', 'GV1032']);
  assert.equal(stats.side_fixed, 1);
  assert.equal(summarize(r('CQ0340R')).ko, '앞·하·우');
  assert.equal(summarize([{ block: 'front', side: 'lh' }, { block: 'front', level: 'lower', side: 'rh' }, { block: 'rear' }]).ko, '앞/뒤·하·좌/우');
});

const SKIP = !process.env.DATABASE_URL;
test('라우트: 미리보기(저장 안 함) → 반영(전체 교체) → 조회(요약·내역) · 디렉터만 올림', { skip: SKIP }, async () => {
  const { query } = await import('../src/db.js');
  const { default: positionRoutes } = await import('../src/routes/positionRoutes.js');
  const TAG = String(Date.now()).slice(-5);
  const L = 'CQ' + TAG + 'L', R = 'CQ' + TAG + 'R';
  await query(`INSERT INTO products (code, name) VALUES ($1,'HORQUILLA'),($2,'HORQUILLA')`, [L, R]);
  const app = Fastify(); await app.register(positionRoutes); await app.ready();
  const H = { 'x-test-user': '1:director' };
  const body = { file_name: 'test.xlsx', rows: [
    { ctr: L + ' // ' + R, block: 'Front', position: 'Front Lower LH', part: 'CONTROL ARM', brand: 'KIA', model: 'Sportage', gen: 'SL', years: '2011-2016', status: 'Confirmed' },
    { ctr: 'ZZ9999', block: 'Rear', position: 'Rear', part: 'SHOCK', model: 'Aveo', years: '2008-2017' },
  ] };
  try {
    let r = await app.inject({ method: 'POST', url: '/api/products/positions/preview', headers: H, payload: body });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().stats.codes, 3); assert.equal(r.json().stats.codes_known, 2); assert.deepEqual(r.json().stats.unknown_codes, ['ZZ9999']);
    assert.equal(Number((await query(`SELECT count(*) n FROM product_positions`)).rows[0].n), 0, '미리보기는 저장 안 함');
    r = await app.inject({ method: 'POST', url: '/api/products/positions/preview', headers: { 'x-test-user': '5:sales' }, payload: body });
    assert.equal(r.statusCode, 403, '디렉터만');
    r = await app.inject({ method: 'POST', url: '/api/products/positions/commit', headers: H, payload: body });
    assert.equal(r.statusCode, 200, r.body); const b1 = r.json().batch_id;
    // 두 번째 반영 = 전체 교체(예전 줄 삭제)
    r = await app.inject({ method: 'POST', url: '/api/products/positions/commit', headers: H, payload: { rows: body.rows.slice(0, 1) } });
    assert.equal(r.json().removed, 3); assert.ok(r.json().batch_id > b1);
    r = await app.inject({ method: 'POST', url: '/api/products/positions/lookup', headers: { 'x-test-user': '5:sales' }, payload: { codes: [L.toLowerCase(), R, 'ZZ9999'], detail: true } });
    const it = r.json().items;
    assert.equal(it[L].ko, '앞·하·좌'); assert.equal(it[R].ko, '앞·하·우'); assert.equal(it.ZZ9999, undefined, '교체로 사라짐');
    assert.equal(it[R].rows[0].fixed, true); assert.equal(it[R].rows[0].model, 'Sportage'); assert.equal(it[R].rows[0].y_from, 2011);
    r = await app.inject({ method: 'POST', url: '/api/products/positions/lookup', headers: H, payload: { codes: [L] } });
    assert.equal(r.json().items[L].rows, undefined, 'detail 없으면 요약만');
    r = await app.inject({ method: 'GET', url: '/api/products/positions/status', headers: H });
    assert.equal(r.json().ready, true); assert.equal(r.json().current.codes, 2); assert.equal(r.json().last.file_name, null);
    r = await app.inject({ method: 'POST', url: '/api/products/positions/commit', headers: H, payload: { rows: [] } });
    assert.equal(r.statusCode, 400);
  } finally {
    await app.close();
    await query(`DELETE FROM product_position_batches`); await query(`DELETE FROM products WHERE code = ANY($1)`, [[L, R]]);
  }
});

test('실제 원본(REFATRIX_Platform_Export 4th) 규모: 1.9만 줄 → 반영 · 조회', { skip: SKIP || !process.env.POS_XLSX_JSON }, async () => {
  const { readFileSync } = await import('node:fs');
  const { query } = await import('../src/db.js');
  const { default: positionRoutes } = await import('../src/routes/positionRoutes.js');
  const all = JSON.parse(readFileSync(process.env.POS_XLSX_JSON, 'utf-8'));
  const idx = mapHeader(all[0]); const g = (r, k) => (idx[k] == null ? '' : r[idx[k]]);
  const rows = all.slice(1).filter((r) => g(r, 'ctr') || g(r, 'ctr4'))
    .map((r) => ({ ctr: g(r, 'ctr'), ctr4: g(r, 'ctr4'), block: g(r, 'block'), position: g(r, 'position'), part: g(r, 'part'), brand: g(r, 'brand'), model: g(r, 'model'), gen: g(r, 'gen'), years: g(r, 'years'), status: g(r, 'status') }));
  const app = Fastify(); await app.register(positionRoutes); await app.ready();
  try {
    const t0 = Date.now();
    const r = await app.inject({ method: 'POST', url: '/api/products/positions/commit', headers: { 'x-test-user': '1:director' }, payload: { file_name: 'real.xlsx', rows } });
    assert.equal(r.statusCode, 200, r.body.slice(0, 300));
    console.log('   real commit', r.json().stats.rows_saved, 'rows', r.json().stats.codes, 'codes', Date.now() - t0, 'ms', 'payload', Math.round(JSON.stringify({ rows }).length / 1e6 * 10) / 10, 'MB');
    const lk = await app.inject({ method: 'POST', url: '/api/products/positions/lookup', headers: { 'x-test-user': '5:sales' }, payload: { codes: ['CQ0166L', 'CQ0166R', 'GY2109G'], detail: true } });
    const it = lk.json().items;
    assert.equal(it.CQ0166L.ko, '앞·하·좌'); assert.equal(it.CQ0166R.ko, '앞·하·우'); assert.equal(it.GY2109G.ko, '뒤·좌/우');
    assert.ok(it.CQ0166L.rows.some((x) => /Sportage/i.test(x.model)));
  } finally { await app.close(); await query(`DELETE FROM product_position_batches`); }
});
