import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arInvoiceStatus, bucketByDueMonth, arSummary, r2 } from '../src/ar.js';

const TODAY = '2026-06-20';

test('arInvoiceStatus: 미수 + 연체(만기 지남)', () => {
  const s = arInvoiceStatus({ total: 1000, paid: 300, due_date: '2026-06-10' }, TODAY);
  assert.equal(s.outstanding, 700);
  assert.equal(s.open, true);
  assert.equal(s.overdue, true);
  assert.equal(s.overdue_days, 10);   // 6/20 − 6/10
  assert.equal(s.days_to_due, null);
});

test('arInvoiceStatus: 미수 + 만기 전(D-n)', () => {
  const s = arInvoiceStatus({ total: 500, paid: 0, due_date: '2026-06-25' }, TODAY);
  assert.equal(s.outstanding, 500);
  assert.equal(s.open, true);
  assert.equal(s.overdue, false);
  assert.equal(s.days_to_due, 5);
  assert.equal(s.overdue_days, null);
});

test('arInvoiceStatus: 오늘이 만기일이면 D-0, 연체 아님', () => {
  const s = arInvoiceStatus({ total: 500, paid: 0, due_date: TODAY }, TODAY);
  assert.equal(s.overdue, false);
  assert.equal(s.days_to_due, 0);
});

test('arInvoiceStatus: 완납이면 open/overdue 모두 false', () => {
  const s = arInvoiceStatus({ total: 1000, paid: 1000, due_date: '2026-05-01' }, TODAY);
  assert.equal(s.outstanding, 0);
  assert.equal(s.open, false);
  assert.equal(s.overdue, false);
  assert.equal(s.overdue_days, null);
});

test('arInvoiceStatus: 문자열 금액(node-pg) 처리', () => {
  const s = arInvoiceStatus({ total: '1234.50', paid: '34.50', due_date: '2026-07-01' }, TODAY);
  assert.equal(s.outstanding, 1200);
  assert.equal(s.open, true);
});

test('bucketByDueMonth: 만기월별 집계 + 최신월 먼저 + 연체 합', () => {
  const inv = [
    { due_date: '2026-06-10', outstanding: 700, overdue: true },
    { due_date: '2026-06-28', outstanding: 300, overdue: false },
    { due_date: '2026-05-15', outstanding: 1000, overdue: true },
  ];
  const b = bucketByDueMonth(inv);
  assert.equal(b.length, 2);
  assert.equal(b[0].ym, '2026-06');       // 최신 먼저
  assert.equal(b[0].count, 2);
  assert.equal(b[0].outstanding, 1000);
  assert.equal(b[0].overdue, 700);        // 연체분만
  assert.equal(b[1].ym, '2026-05');
  assert.equal(b[1].outstanding, 1000);
  assert.equal(b[1].overdue, 1000);
});

test('arSummary: 건수·총 미수·연체 미수', () => {
  const s = arSummary([
    { outstanding: 700, overdue: true },
    { outstanding: 300, overdue: false },
    { outstanding: 1000, overdue: true },
  ]);
  assert.equal(s.open_count, 3);
  assert.equal(s.outstanding, 2000);
  assert.equal(s.overdue, 1700);
});

test('r2: 반올림', () => {
  assert.equal(r2(1.005), 1.01);
  assert.equal(r2('2.345'), 2.35);
});
