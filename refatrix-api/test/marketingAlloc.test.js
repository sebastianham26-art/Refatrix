import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocCost, allocSumByMonth, allocByCustomerMonth, budgetVsAlloc, sumMonths } from '../src/marketingAlloc.js';

test('allocCost = qty * unit', () => {
  assert.equal(allocCost(3, 5000), 15000);
  assert.equal(allocCost(0, 5000), 0);
  assert.equal(allocCost(2.5, 1000), 2500);
});

test('allocSumByMonth aggregates cost', () => {
  const rows = [
    { customer_id: 1, ym: '2026-06', qty: 2, unit_budget: 5000 }, // 10000
    { customer_id: 1, ym: '2026-06', qty: 1, unit_budget: 3000 }, // 3000
    { customer_id: 2, ym: '2026-07', qty: 1, unit_budget: 50000 }, // 50000
  ];
  const s = allocSumByMonth(rows);
  assert.equal(s['2026-06'], 13000);
  assert.equal(s['2026-07'], 50000);
});

test('allocByCustomerMonth groups', () => {
  const rows = [
    { customer_id: 1, ym: '2026-06', qty: 2, unit_budget: 5000 },
    { customer_id: 1, ym: '2026-07', qty: 1, unit_budget: 7000 },
    { customer_id: 2, ym: '2026-06', qty: 1, unit_budget: 1000 },
  ];
  const m = allocByCustomerMonth(rows);
  assert.equal(m[1]['2026-06'], 10000);
  assert.equal(m[1]['2026-07'], 7000);
  assert.equal(m[2]['2026-06'], 1000);
});

test('budgetVsAlloc remaining/over', () => {
  const months = ['2026-06', '2026-07'];
  const budget = { '2026-06': 100000, '2026-07': 50000 };
  const alloc = { '2026-06': 70000, '2026-07': 60000 };
  const r = budgetVsAlloc(months, budget, alloc);
  assert.equal(r['2026-06'].remaining, 30000);
  assert.equal(r['2026-06'].over, 0);
  assert.equal(r['2026-07'].remaining, 0);
  assert.equal(r['2026-07'].over, 10000);
});

test('sumMonths annual total', () => {
  const months = ['2026-06', '2026-07', '2026-08'];
  assert.equal(sumMonths(months, { '2026-06': 100, '2026-07': 200, '2026-09': 999 }), 300);
});
