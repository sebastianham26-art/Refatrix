import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLine, validatePeriods, nextDay, allocateFifo, summarizeByMonth } from '../src/routes/commissionRoutes.js';

// ── computeLine: 매출/수금 기준 ──────────────────────────────────────
test('computeLine 매출기준: 발행 즉시 전액 확정(수금 무관)', () => {
  const c = computeLine({ subtotal_mxn: 1000, total_mxn: 1160, rate: 5, cust_rate: null, basis: 'revenue', paid_amount: 0, inv_ym: '2026-02' });
  assert.equal(c.rate, 5);
  assert.equal(c.expected, 50);
  assert.equal(c.confirmed, 50);          // 수금 0 이어도 확정
  assert.equal(c.recognized, true);
  assert.equal(c.settleYm, '2026-02');    // 발행월
  assert.equal(c.basis, 'revenue');
});

test('computeLine 수금기준·미완납: 기대만(확정 0)', () => {
  const c = computeLine({ subtotal_mxn: 2000, total_mxn: 2320, rate: 6, basis: 'collection', paid_amount: 1000 });
  assert.equal(c.expected, 120);
  assert.equal(c.confirmed, 0);
  assert.equal(c.recognized, false);
  assert.equal(c.settleYm, null);
});

test('computeLine 수금기준·완납: 완납월에 전액 확정', () => {
  const c = computeLine({ subtotal_mxn: 3000, total_mxn: 3480, rate: 6, basis: 'collection', paid_amount: 3480, last_pay_date: '2026-06-05' });
  assert.equal(c.expected, 180);
  assert.equal(c.confirmed, 180);
  assert.equal(c.recognized, true);
  assert.equal(c.settleYm, '2026-06');
});

test('computeLine 고객예외율이 기간율보다 우선(기준은 유지)', () => {
  const c = computeLine({ subtotal_mxn: 1000, total_mxn: 1160, rate: 5, cust_rate: 8, basis: 'revenue', inv_ym: '2026-02' });
  assert.equal(c.rate, 8);
  assert.equal(c.expected, 80);
  assert.equal(c.basis, 'revenue');
});

// ── nextDay ─────────────────────────────────────────────────────────
test('nextDay 월말·연말·윤년 경계', () => {
  assert.equal(nextDay('2026-03-31'), '2026-04-01');
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
  assert.equal(nextDay('2026-02-28'), '2026-03-01'); // 2026 평년
  assert.equal(nextDay('2024-02-28'), '2024-02-29'); // 2024 윤년
});

// ── validatePeriods: 연속·무겹침·마지막 열림 ─────────────────────────
const P = (s, e, b, r) => ({ start_date: s, end_date: e, basis: b, rate: r });

test('validatePeriods 정상: 연속 2기간(매출→수금)', () => {
  const v = validatePeriods([P('2026-04-01', null, 'collection', 6), P('2026-01-01', '2026-03-31', 'revenue', 5)]);
  assert.equal(v.ok, true);
  assert.equal(v.periods[0].start_date, '2026-01-01'); // 정렬됨
  assert.equal(v.periods[1].end_date, null);
});

test('validatePeriods 겹침 차단', () => {
  const v = validatePeriods([P('2026-01-01', '2026-04-01', 'revenue', 5), P('2026-04-01', null, 'collection', 6)]);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'overlap');
});

test('validatePeriods 빈틈 차단', () => {
  const v = validatePeriods([P('2026-01-01', '2026-03-30', 'revenue', 5), P('2026-04-01', null, 'collection', 6)]);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'gap');
});

test('validatePeriods 마지막 기간은 반드시 ∞', () => {
  const v = validatePeriods([P('2026-01-01', '2026-12-31', 'revenue', 5)]);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'last_must_be_open');
});

test('validatePeriods 중간 기간 ∞ 금지', () => {
  const v = validatePeriods([P('2026-01-01', null, 'revenue', 5), P('2026-04-01', null, 'collection', 6)]);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'gap_open_middle');
});

test('validatePeriods 빈 집합·잘못된 기준·음수율 차단', () => {
  assert.equal(validatePeriods([]).error, 'no_periods');
  assert.equal(validatePeriods([P('2026-01-01', null, 'x', 5)]).error, 'bad_basis');
  assert.equal(validatePeriods([P('2026-01-01', null, 'revenue', -1)]).error, 'bad_rate');
});

// ── allocateFifo / summarizeByMonth: 기존 동작 회귀 ──────────────────
test('allocateFifo 인보이스 단위 충당(부분충당 없음)', () => {
  const lines = [{ invoice_id: 1, expected: 50, settle_ym: '2026-02' }, { invoice_id: 2, expected: 120, settle_ym: '2026-02' }];
  const a = allocateFifo(lines, 60);
  assert.equal(a.allocs.length, 1);      // 50만 충당, 120은 남은 10<120 이라 멈춤
  assert.equal(a.settled, 50);
  assert.equal(a.leftover, 10);
});

test('summarizeByMonth 월별 확정/지급 합계', () => {
  const s = summarizeByMonth([
    { settle_ym: '2026-02', owner_id: 1, expected: 50, paid: false },
    { settle_ym: '2026-02', owner_id: 2, expected: 120, paid: true },
    { settle_ym: '2026-06', owner_id: 1, expected: 180, paid: false },
  ]);
  const feb = s.find((x) => x.settle_ym === '2026-02');
  assert.equal(feb.confirmed, 170);
  assert.equal(feb.paid, 120);
  assert.equal(feb.unpaid, 50);
  assert.equal(feb.agent_count, 2);
});
