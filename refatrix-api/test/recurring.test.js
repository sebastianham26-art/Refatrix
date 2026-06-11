import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandRule, clampDay } from '../src/recurring.js';

test('monthly: generates one per month from start through horizon', () => {
  const occ = expandRule({ freq: 'month', start_date: '2026-01-15', day_of_month: 15 }, '2026-01-01', 24);
  // 24개월 지평: 2026-01 ~ 2028-01 → 25개 달
  assert.equal(occ[0].date, '2026-01-15');
  assert.equal(occ[0].period, '2026-01');
  assert.ok(occ.length >= 24 && occ.length <= 25);
});

test('monthly: clamps day 31 to month length (Feb)', () => {
  const occ = expandRule({ freq: 'month', start_date: '2026-01-31', day_of_month: 31 }, '2026-01-01', 3);
  assert.equal(occ[0].date, '2026-01-31');
  assert.equal(occ[1].date, '2026-02-28'); // 2026 not leap
  assert.equal(occ[2].date, '2026-03-31');
});

test('monthly: end_month limits generation', () => {
  const occ = expandRule({ freq: 'month', start_date: '2026-01-10', day_of_month: 10, end_month: '2026-03' }, '2026-01-01', 24);
  assert.deepEqual(occ.map((o) => o.date), ['2026-01-10', '2026-02-10', '2026-03-10']);
});

test('monthly: start in future still generated', () => {
  const occ = expandRule({ freq: 'month', start_date: '2026-06-05', day_of_month: 5 }, '2026-01-01', 24);
  assert.equal(occ[0].date, '2026-06-05');
});

test('weekly: every same weekday from start', () => {
  // 2026-01-02 is Friday. weekday 5 = Fri
  const occ = expandRule({ freq: 'week', start_date: '2026-01-01', weekday: 5 }, '2026-01-01', 1);
  assert.equal(occ[0].date, '2026-01-02');
  assert.equal(occ[1].date, '2026-01-09');
  assert.equal(occ[2].date, '2026-01-16');
  occ.forEach((o) => assert.ok(o.period.startsWith('W')));
});

test('weekly: ~52 per year horizon', () => {
  const occ = expandRule({ freq: 'week', start_date: '2026-01-01', weekday: 1 }, '2026-01-01', 12);
  assert.ok(occ.length >= 51 && occ.length <= 53);
});

test('weekly: end_month limits', () => {
  const occ = expandRule({ freq: 'week', start_date: '2026-01-01', weekday: 5, end_month: '2026-01' }, '2026-01-01', 24);
  // Fridays in Jan 2026: 2,9,16,23,30
  assert.deepEqual(occ.map((o) => o.date), ['2026-01-02', '2026-01-09', '2026-01-16', '2026-01-23', '2026-01-30']);
});

test('periods are unique per occurrence (idempotency key)', () => {
  const occ = expandRule({ freq: 'month', start_date: '2026-01-15', day_of_month: 15 }, '2026-01-01', 12);
  const periods = occ.map((o) => o.period);
  assert.equal(new Set(periods).size, periods.length);
});

test('clampDay basic', () => {
  assert.equal(clampDay(2026, 1, 31), 28); // Feb 2026
  assert.equal(clampDay(2024, 1, 31), 29); // Feb 2024 leap
  assert.equal(clampDay(2026, 0, 15), 15);
});

import { expandBetween } from '../src/recurring.js';

test('expandBetween monthly: only within range', () => {
  const occ = expandBetween({ freq: 'month', start_date: '2026-01-06', day_of_month: 6 }, '2026-06-07', '2026-09-30');
  assert.deepEqual(occ.map((o) => o.date), ['2026-07-06', '2026-08-06', '2026-09-06']);
});

test('expandBetween monthly: from before start clamps to start', () => {
  const occ = expandBetween({ freq: 'month', start_date: '2026-06-06', day_of_month: 6 }, '2026-01-01', '2026-08-31');
  assert.deepEqual(occ.map((o) => o.date), ['2026-06-06', '2026-07-06', '2026-08-06']);
});

test('expandBetween weekly: only within range', () => {
  // Fridays
  const occ = expandBetween({ freq: 'week', start_date: '2026-01-02', weekday: 5 }, '2026-02-01', '2026-02-28');
  assert.deepEqual(occ.map((o) => o.date), ['2026-02-06', '2026-02-13', '2026-02-20', '2026-02-27']);
});

test('expandBetween: end_month caps', () => {
  const occ = expandBetween({ freq: 'month', start_date: '2026-01-10', day_of_month: 10, end_month: '2026-03' }, '2026-01-01', '2026-12-31');
  assert.deepEqual(occ.map((o) => o.date), ['2026-01-10', '2026-02-10', '2026-03-10']);
});

test('expandBetween: empty when from after to', () => {
  const occ = expandBetween({ freq: 'month', start_date: '2026-01-10', day_of_month: 10 }, '2026-09-01', '2026-06-01');
  assert.equal(occ.length, 0);
});
