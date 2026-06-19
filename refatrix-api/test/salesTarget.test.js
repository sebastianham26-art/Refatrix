import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthsHorizon, currentYm, sumByMonth, shortfallByMonth, customerYearTotals, companyVsTeams, carryoverByMonth, effectiveTargetFor, aggregateCarryover } from '../src/salesTarget.js';

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

test('carryoverByMonth: 디렉터 예시 (10→5미달, 다음달15→14미달, 그다음달11)', () => {
  const months = ['2026-01', '2026-02', '2026-03'];
  const base = { '2026-01': 10, '2026-02': 10, '2026-03': 10 };
  const actual = { '2026-01': 5, '2026-02': 14, '2026-03': 0 };
  const r = carryoverByMonth(months, base, actual);
  assert.equal(r['2026-01'].effective, 10);
  assert.equal(r['2026-01'].addedToNext, 5);
  assert.equal(r['2026-02'].effective, 15);
  assert.equal(r['2026-02'].remaining, 1);
  assert.equal(r['2026-03'].effective, 11);
});

test('carryoverByMonth: 채우면 이월 사라짐 · 초과 무시', () => {
  const months = ['2026-01', '2026-02', '2026-03', '2026-04'];
  const base = { '2026-01': 200000, '2026-02': 200000, '2026-03': 200000, '2026-04': 200000 };
  const actual = { '2026-01': 150000, '2026-02': 250000, '2026-03': 120000, '2026-04': 300000 };
  const r = carryoverByMonth(months, base, actual);
  assert.equal(r['2026-02'].carryIn, 50000);  // 1월 미달 50k 이월
  assert.equal(r['2026-02'].addedToNext, 0);   // 2월 250k 다 채움
  assert.equal(r['2026-03'].carryIn, 0);       // 이월 사라짐
  assert.equal(r['2026-04'].carryIn, 80000);   // 3월 미달 80k
  assert.equal(r['2026-04'].addedToNext, 0);   // 4월 초과(300>280) → 이월 0
});

test('carryoverByMonth: 매년 1월 리셋', () => {
  const months = ['2026-12', '2027-01'];
  const base = { '2026-12': 100, '2027-01': 100 };
  const actual = { '2026-12': 0, '2027-01': 0 };
  const r = carryoverByMonth(months, base, actual);
  assert.equal(r['2026-12'].addedToNext, 100);
  assert.equal(r['2027-01'].carryIn, 0); // 새해 리셋
  assert.equal(r['2027-01'].effective, 100);
});

test('effectiveTargetFor: 그 해 1월부터 replay해 표시월 목표 산출', () => {
  const base = { '2026-01': 10, '2026-02': 10, '2026-03': 10 };
  const actual = { '2026-01': 5, '2026-02': 14 };
  const e = effectiveTargetFor('2026-03', base, actual);
  assert.equal(e.effective, 11); // 1월 미달5 → 2월15(실적14, 미달1) → 3월 10+1=11
});

test('aggregateCarryover: 두 팀 각자 이월 후 합산 (Total)', () => {
  const teamIds = [1, 2];
  const base = {
    1: { '2026-01': 100, '2026-02': 100 },
    2: { '2026-01': 200, '2026-02': 200 },
  };
  const actual = {
    1: { '2026-01': 60, '2026-02': 0 },   // 팀1: 1월 미달40 → 2월목표140
    2: { '2026-01': 200, '2026-02': 0 },  // 팀2: 1월 달성 → 2월목표200
  };
  const r = aggregateCarryover(teamIds, base, actual, ['2026-02']);
  // 팀1 2월 표시목표 140 + 팀2 2월 표시목표 200 = 340
  assert.equal(r.target, 340);
  assert.equal(r.perMonth['2026-02'].effective, 340);
});

test('aggregateCarryover: 단일 팀 선택', () => {
  const base = { 1: { '2026-01': 100, '2026-02': 100 } };
  const actual = { 1: { '2026-01': 60 } };
  const r = aggregateCarryover([1], base, actual, ['2026-02']);
  assert.equal(r.target, 140); // 1월 미달40 이월
});
