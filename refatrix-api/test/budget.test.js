import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastWorkingDayOfMonth, resolvePlanDate, lineAmount, budgetLimit, groupByCategory, periodSummary } from '../src/budget.js';

test('lastWorkingDayOfMonth: skips weekend', () => {
  // 2026-05-31 is Sunday → last working day = Fri 2026-05-29
  assert.equal(lastWorkingDayOfMonth('2026-05'), '2026-05-29');
  // 2026-02-28 is Saturday → 2026-02-27 Friday
  assert.equal(lastWorkingDayOfMonth('2026-02'), '2026-02-27');
  // 2026-06-30 is Tuesday → itself
  assert.equal(lastWorkingDayOfMonth('2026-06'), '2026-06-30');
  // 2026-01-31 is Saturday → 2026-01-30 Friday
  assert.equal(lastWorkingDayOfMonth('2026-01'), '2026-01-30');
});

test('resolvePlanDate', () => {
  assert.equal(resolvePlanDate({ month: '2026-05', dateUnknown: true }), '2026-05-29');
  assert.equal(resolvePlanDate({ month: '2026-05', dateUnknown: false, planDate: '2026-05-15' }), '2026-05-15');
  // no date given → last working day
  assert.equal(resolvePlanDate({ month: '2026-05', dateUnknown: false }), '2026-05-29');
});

test('lineAmount = qty * price', () => {
  assert.equal(lineAmount(500, 42), 21000);
  assert.equal(lineAmount(3, 99.9), 299.7);
  assert.equal(lineAmount(0, 50), 0);
});

test('budgetLimit 5%', () => {
  assert.equal(budgetLimit(2000000, 5), 100000);
  assert.equal(budgetLimit(1728000), 86400); // default 5%
});

test('groupByCategory: groups + per-cat status totals', () => {
  const items = [
    { category: '인쇄물', amount: 21000, status: 'approved' },
    { category: '인쇄물', amount: 9000, status: 'pending' },
    { category: '행사', amount: 3049, status: 'approved' },
    { category: '디지털', amount: 918, status: 'rejected' },
  ];
  const g = groupByCategory(items);
  const print = g.find((x) => x.category === '인쇄물');
  assert.equal(print.total, 30000);
  assert.equal(print.approved, 21000);
  assert.equal(print.pending, 9000);
  assert.equal(g.find((x) => x.category === '디지털').rejected, 918);
});

test('periodSummary: limit vs approved', () => {
  const s = periodSummary({ limit: 86400, items: [
    { amount: 16000, status: 'approved' },
    { amount: 21000, status: 'approved' },
    { amount: 2660, status: 'pending' },
    { amount: 1250, status: 'rejected' },
  ] });
  assert.equal(s.limit, 86400);
  assert.equal(s.approved, 37000);
  assert.equal(s.pending, 2660);
  assert.equal(s.rejected, 1250);
  assert.equal(s.remaining, 49400);
  assert.equal(s.over_limit, false);
  assert.equal(s.use_pct, 43);
});

test('periodSummary: over limit', () => {
  const s = periodSummary({ limit: 10000, items: [{ amount: 12000, status: 'approved' }] });
  assert.equal(s.over_limit, true);
  assert.equal(s.remaining, -2000);
  assert.equal(s.use_pct, 120);
});
