import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeaderIndex, parseCustRow, validateCustRow, buildCustPreview, CUST_TEMPLATE_HEADERS } from '../src/customerImport.js';

test('template headers include key columns', () => {
  assert.ok(CUST_TEMPLATE_HEADERS.includes('고객명'));
  assert.ok(CUST_TEMPLATE_HEADERS.includes('팀'));
  assert.ok(CUST_TEMPLATE_HEADERS.includes('회사종류'));
});

test('parseCustRow maps + coerces numbers', () => {
  const header = ['고객코드', '고객명', '팀', '회사종류', '할인율', '외상일'];
  const idx = buildHeaderIndex(header);
  const r = parseCustRow(['C-0001', '고객가', '01_Monterrey', 'Mayoreo', '5%', '30'], idx);
  assert.equal(r.code, 'C-0001');
  assert.equal(r.name, '고객가');
  assert.equal(r.team, '01_Monterrey');
  assert.equal(r.discount, 5);
  assert.equal(r.credit_days, 30);
});

test('parseCustRow skips empty rows', () => {
  const idx = buildHeaderIndex(['고객명']);
  assert.equal(parseCustRow([''], idx), null);
});

test('validateCustRow flags missing name + bad type', () => {
  assert.deepEqual(validateCustRow({ name: '', customer_type: null }), ['고객명 누락']);
  assert.deepEqual(validateCustRow({ name: 'A', customer_type: 'foo' }), ['회사종류 값 오류']);
  assert.deepEqual(validateCustRow({ name: 'A', customer_type: 'taller' }), []);
});

test('buildCustPreview splits create/update/errors', () => {
  const resolve = {
    teamByName: { '01_monterrey': 1, '02_merida': 2 },
    ownerByName: { '김철수': 5 },
    stageByName: { '01_잠재': 2 },
    existingByCode: new Set(['c-0001']),
  };
  const rows = [
    { code: 'C-0001', name: '기존', team: '01_Monterrey', customer_type: null },     // update
    { code: null, name: '신규', team: '02_Merida', customer_type: 'Mayoreo' },        // create
    { code: null, name: '팀없음', team: '없는팀', customer_type: null },              // error
    { code: null, name: '', team: '01_Monterrey', customer_type: null },             // error (name)
  ];
  const r = buildCustPreview(rows, resolve);
  assert.equal(r.update.length, 1);
  assert.equal(r.create.length, 1);
  assert.equal(r.errors.length, 2);
});
