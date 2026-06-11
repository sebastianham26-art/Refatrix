import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthsHorizon, currentYm, sumByMonth, shortfallByMonth, customerYearTotals, companyVsTeams } from '../src/salesTarget.js';

test('monthsHorizon 12 months crossing year', () => {
  const m = monthsHorizon('2026-06', 12);
  assert.equal(m.length, 12);
  assert.equal(m[0], '2026-06');
  assert.equal(m[6], '2026-12');
  assert.equal(m[7], '2027-01');
  assert.equal(m[11], '2027-05');
});

test('currentYm', () => {
  assert.equal(currentYm(new Date(Date.UTC(2026, 5, 11))), '2026-06');
});

test('sumByMonth aggregates', () => {
  const s = sumByMonth([{ ym: '2026-06', amount: 100 }, { ym: '2026-06', amount: 50 }, { ym: '2026-07', amount: 200 }]);
  assert.equal(s['2026-06'], 150);
  assert.equal(s['2026-07'], 200);
});

test('shortfallByMonth: under, exact, over', () => {
  const months = ['2026-06', '2026-07', '2026-08'];
  const team = { '2026-06': 1000, '2026-07': 1000, '2026-08': 1000 };
  const cust = { '2026-06': 700, '2026-07': 1000, '2026-08': 1200 };
  const r = shortfallByMonth(months, team, cust);
  assert.equal(r['2026-06'].shortfall, 300);
  assert.equal(r['2026-06'].over, 0);
  assert.equal(r['2026-07'].shortfall, 0);
  assert.equal(r['2026-08'].over, 200);
});

test('customerYearTotals sums only that year', () => {
  const rows = [
    { customer_id: 1, ym: '2026-06', amount: 100 },
    { customer_id: 1, ym: '2026-12', amount: 200 },
    { customer_id: 1, ym: '2027-01', amount: 999 },
    { customer_id: 2, ym: '2026-03', amount: 50 },
  ];
  const t = customerYearTotals(rows, 2026);
  assert.equal(t[1], 300);
  assert.equal(t[2], 50);
});

test('companyVsTeams shortfall', () => {
  const months = ['2026-06'];
  const r = companyVsTeams(months, { '2026-06': 2000000 }, { '2026-06': 1800000 });
  assert.equal(r['2026-06'].shortfall, 200000);
  assert.equal(r['2026-06'].over, 0);
});
