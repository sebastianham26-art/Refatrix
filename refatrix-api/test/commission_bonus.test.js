import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ymOf, monthEnd, addMonth, monthRange, daysInMonth, elapsedRatio,
  pickTier, nextTier, validateBonusPlan, buildPerf,
} from '../src/routes/commissionBonus.js';

// ── 날짜 유틸 ────────────────────────────────────────────────────────
test('월 유틸: 말일·다음달·범위·윤년', () => {
  assert.equal(monthEnd('2026-02'), '2026-02-28');
  assert.equal(monthEnd('2024-02'), '2024-02-29');
  assert.equal(monthEnd('2026-08'), '2026-08-31');
  assert.equal(addMonth('2026-12', 1), '2027-01');
  assert.equal(addMonth('2026-01', -1), '2025-12');
  assert.deepEqual(monthRange('2026-06', '2026-08'), ['2026-06', '2026-07', '2026-08']);
  assert.deepEqual(monthRange('2026-08', '2026-06'), []);       // from>to → 빈 배열
  assert.equal(daysInMonth('2026-08'), 31);
  assert.equal(ymOf('2026-08-28'), '2026-08');
});

test('월 경과율: 지난달=1 · 미래=0 · 당월=경과일/총일수', () => {
  assert.equal(elapsedRatio('2026-07', '2026-08-28'), 1);
  assert.equal(elapsedRatio('2026-09', '2026-08-28'), 0);
  assert.equal(Math.round(elapsedRatio('2026-08', '2026-08-28') * 1000) / 1000, Math.round(28 / 31 * 1000) / 1000);
});

// ── 구간 판정 ────────────────────────────────────────────────────────
const TIERS = [{ min_rate: 80, amount: 2000 }, { min_rate: 100, amount: 5000 }, { min_rate: 120, amount: 10000 }];

test('pickTier: 가장 높은 충족 구간 하나만 · 최저 미만은 미지급', () => {
  assert.equal(pickTier(TIERS, 79.9), null);
  assert.equal(pickTier(TIERS, 80).amount, 2000);
  assert.equal(pickTier(TIERS, 99.9).amount, 2000);
  assert.equal(pickTier(TIERS, 100).amount, 5000);
  assert.equal(pickTier(TIERS, 119.99).amount, 5000);
  assert.equal(pickTier(TIERS, 120).amount, 10000);
  assert.equal(pickTier(TIERS, 500).amount, 10000);   // 상한 없음(cap 미도입)
  assert.equal(pickTier(TIERS, null), null);          // 목표 0 → 달성률 없음 → 미지급
  assert.equal(pickTier([], 150), null);
});

test('nextTier: 아직 못 넘은 다음 구간', () => {
  assert.equal(nextTier(TIERS, 85).min_rate, 100);
  assert.equal(nextTier(TIERS, 100).min_rate, 120);
  assert.equal(nextTier(TIERS, 130), null);
  assert.equal(nextTier(TIERS, null).min_rate, 80);
});

// ── 정책 검증 ────────────────────────────────────────────────────────
test('validateBonusPlan: 정상 · 중복구간 · 종료월 역전 · 매출기준 목표 누락', () => {
  const ok = validateBonusPlan({ basis: 'collection', start_month: '2026-06', end_month: '2026-08', tiers: TIERS, targets: {} });
  assert.equal(ok.ok, true);
  assert.equal(ok.plan.basis, 'collection');
  assert.equal(ok.tiers[0].min_rate, 80);              // 정렬됨

  assert.equal(validateBonusPlan({ basis: 'revenue', start_month: '2026-06', tiers: [{ min_rate: 100, amount: 1 }, { min_rate: 100, amount: 2 }] }).error, 'dup_tier');
  assert.equal(validateBonusPlan({ basis: 'revenue', start_month: '2026-08', end_month: '2026-06', tiers: TIERS }).error, 'end_before_start');
  assert.equal(validateBonusPlan({ basis: 'revenue', start_month: '2026-06', end_month: '2026-07', tiers: TIERS, targets: { '2026-06': 100 } }).error, 'missing_targets');
  assert.equal(validateBonusPlan({ basis: 'revenue', start_month: '2026-06', tiers: [] }).error, 'no_tiers');
  // 수금 기준은 목표를 시스템이 산출하므로 목표 입력이 없어도 통과
  assert.equal(validateBonusPlan({ basis: 'collection', start_month: '2026-06', end_month: '2026-07', tiers: TIERS }).ok, true);
  // 미사용은 검증 없이 통과
  assert.equal(validateBonusPlan({ enabled: false }).ok, true);
  // 적용기간 밖 목표는 버려진다
  const t = validateBonusPlan({ basis: 'revenue', start_month: '2026-06', end_month: '2026-06', tiers: TIERS, targets: { '2026-05': 1, '2026-06': 100 } });
  assert.deepEqual(Object.keys(t.targets), ['2026-06']);
});

// ── 성과 집계 ────────────────────────────────────────────────────────
// 인보이스 2건: 6월 발행(30일 외상 → 7월 만기), 7월 발행(30일 → 8월 만기)
const INV = [
  { id: 1, sat_no: 'A-1', inv_date: '2026-06-10', due_date: '2026-07-10', subtotal: 100000, total: 116000, customer_id: 9, customer_name: 'Cliente A', customer_code: 'C-1', credit_days: 30, basis: 'collection', rate: 4, payout_paid: false, payout_amount: null },
  { id: 2, sat_no: 'A-2', inv_date: '2026-07-20', due_date: '2026-08-19', subtotal: 50000, total: 58000, customer_id: 9, customer_name: 'Cliente A', customer_code: 'C-1', credit_days: 30, basis: 'collection', rate: 4, payout_paid: false, payout_amount: null },
];
const PLAN_COL = { enabled: true, basis: 'collection', start_month: '2026-06', end_month: null, include_overdue: true, partial_credit: true };

test('수금목표 = 당월 만기도래 subtotal(ex-IVA) 합계', () => {
  const p = buildPerf({ invoices: INV, allocs: [], plan: PLAN_COL, tiers: TIERS, targets: {}, months: ['2026-07', '2026-08'], today: '2026-08-28' });
  const jul = p.months[0], aug = p.months[1];
  assert.equal(jul.collection.due, 100000);         // 1번 인보이스 만기
  assert.equal(aug.collection.due, 50000);          // 2번 인보이스 만기
});

test('연체 이월: 7월 만기 미수가 8월 목표에 더해진다 (옵션 끄면 안 더해짐)', () => {
  const on = buildPerf({ invoices: INV, allocs: [], plan: PLAN_COL, tiers: TIERS, targets: {}, months: ['2026-08'], today: '2026-08-28' });
  assert.equal(on.months[0].collection.carry, 100000);
  assert.equal(on.months[0].collection.target, 150000);   // 당월만기 50,000 + 이월 100,000

  const off = buildPerf({ invoices: INV, allocs: [], plan: { ...PLAN_COL, include_overdue: false }, tiers: TIERS, targets: {}, months: ['2026-08'], today: '2026-08-28' });
  assert.equal(off.months[0].collection.target, 50000);
});

test('미래 월은 연체 이월을 더하지 않는다(잠정치)', () => {
  const p = buildPerf({ invoices: INV, allocs: [], plan: PLAN_COL, tiers: TIERS, targets: {}, months: ['2026-09'], today: '2026-08-28' });
  assert.equal(p.months[0].provisional, true);
  assert.equal(p.months[0].collection.carry, 0);
  assert.equal(p.months[0].collection.target, 0);
});

test('부분수금 비례 인정: 총액 충당액을 ex-IVA 로 환산해 수금실적에 반영', () => {
  // 1번 인보이스(총액 116,000)에 7월 58,000 입금 = 절반 → ex-IVA 50,000
  const allocs = [{ invoice_id: 1, pay_date: '2026-07-15', amount: 58000 }];
  const on = buildPerf({ invoices: INV, allocs, plan: PLAN_COL, tiers: TIERS, targets: {}, months: ['2026-07'], today: '2026-08-28' });
  assert.equal(on.months[0].collection.actual, 50000);
  assert.equal(on.months[0].collection.rate, 50);          // 목표 100,000 대비 50%
  assert.equal(on.months[0].bonus.amount, 0);              // 80% 미만 → 미지급

  // 완납 기준(partial_credit=false)이면 미완납분은 실적 0
  const off = buildPerf({ invoices: INV, allocs, plan: { ...PLAN_COL, partial_credit: false }, tiers: TIERS, targets: {}, months: ['2026-07'], today: '2026-08-28' });
  assert.equal(off.months[0].collection.actual, 0);
});

test('완납 시 커미션은 완납월에 인식(수금 기준) · 달성률 100% → 구간 성과급', () => {
  const allocs = [{ invoice_id: 1, pay_date: '2026-07-09', amount: 116000 }];
  const p = buildPerf({ invoices: INV, allocs, plan: PLAN_COL, tiers: TIERS, targets: {}, months: ['2026-07'], today: '2026-08-28' });
  const jul = p.months[0];
  assert.equal(jul.collection.actual, 100000);
  assert.equal(jul.collection.rate, 100);
  assert.equal(jul.commission, 4000);          // 100,000 × 4%
  assert.equal(jul.bonus.amount, 5000);        // 100% 구간
  assert.equal(jul.bonus.tier, 100);
  assert.equal(jul.total, 9000);
});

test('매출 기준: 발행월에 커미션 인식 · 목표는 수동 입력값', () => {
  const inv = INV.map((i) => ({ ...i, basis: 'revenue', rate: 5 }));
  const plan = { enabled: true, basis: 'revenue', start_month: '2026-06', end_month: null, include_overdue: true, partial_credit: true };
  const p = buildPerf({ invoices: inv, allocs: [], plan, tiers: TIERS, targets: { '2026-06': 80000 }, months: ['2026-06'], today: '2026-08-28' });
  assert.equal(p.months[0].revenue.actual, 100000);
  assert.equal(p.months[0].revenue.rate, 125);
  assert.equal(p.months[0].commission, 5000);   // 발행 즉시 100,000 × 5%
  assert.equal(p.months[0].bonus.amount, 10000);// 120% 구간
});

test('적용기간 밖의 달은 성과급이 계산되지 않는다', () => {
  const plan = { ...PLAN_COL, start_month: '2026-07', end_month: '2026-07' };
  const p = buildPerf({ invoices: INV, allocs: [], plan, tiers: TIERS, targets: {}, months: ['2026-06', '2026-07', '2026-08'], today: '2026-08-28' });
  assert.equal(p.months[0].bonus.in_plan, false);
  assert.equal(p.months[1].bonus.in_plan, true);
  assert.equal(p.months[2].bonus.in_plan, false);
  assert.equal(p.months[2].bonus.amount, 0);
});

test('지급된 커미션은 지급 시점 금액으로 동결(율을 바꿔도 불변)', () => {
  const inv = [{ ...INV[0], payout_paid: true, payout_amount: 3333 }];
  const allocs = [{ invoice_id: 1, pay_date: '2026-07-09', amount: 116000 }];
  const p = buildPerf({ invoices: inv, allocs, plan: PLAN_COL, tiers: TIERS, targets: {}, months: ['2026-07'], today: '2026-08-28' });
  assert.equal(p.months[0].commission, 3333);
});

test('커미션 기간이 없는 인보이스는 커미션 0 (매출·수금 실적에는 잡힌다)', () => {
  const inv = [{ ...INV[0], basis: null, rate: null }];
  const allocs = [{ invoice_id: 1, pay_date: '2026-07-09', amount: 116000 }];
  const p = buildPerf({ invoices: inv, allocs, plan: PLAN_COL, tiers: TIERS, targets: {}, months: ['2026-07'], today: '2026-08-28' });
  assert.equal(p.months[0].commission, 0);
  assert.equal(p.months[0].collection.actual, 100000);
});

test('고객별 집계: 매출·수금·만기도래·미수·연체·커미션', () => {
  const allocs = [{ invoice_id: 1, pay_date: '2026-07-09', amount: 116000 }];
  const p = buildPerf({ invoices: INV, allocs, plan: PLAN_COL, tiers: TIERS, targets: {}, months: monthRange('2026-06', '2026-08'), today: '2026-08-28' });
  const c = p.customers[0];
  assert.equal(c.customer_name, 'Cliente A');
  assert.equal(c.sales, 150000);        // 6월 100,000 + 7월 50,000
  assert.equal(c.collected, 100000);
  assert.equal(c.due, 150000);          // 7월·8월 만기
  assert.equal(c.open, 50000);          // 2번 인보이스 미수
  assert.equal(c.late, 50000);          // 8/19 만기 → 8/28 기준 연체
  assert.equal(c.commission, 4000);
});

test('인보이스별 상태: 수금완료 · 지연수금 · 연체 · 만기전', () => {
  const inv = [
    { ...INV[0] },                                            // 7/10 만기
    { ...INV[1] },                                            // 8/19 만기 → 연체
    { ...INV[0], id: 3, sat_no: 'A-3', due_date: '2026-09-30' }, // 만기전
  ];
  const allocs = [
    { invoice_id: 1, pay_date: '2026-07-25', amount: 116000 },  // 지연수금 +15일
    { invoice_id: 3, pay_date: '2026-08-01', amount: 116000 },  // 만기 전 수금 → 수금완료
  ];
  const p = buildPerf({ invoices: inv, allocs, plan: PLAN_COL, tiers: TIERS, targets: {}, months: monthRange('2026-06', '2026-08'), today: '2026-08-28' });
  const by = Object.fromEntries(p.invoices.map((r) => [r.invoice_id, r]));
  assert.equal(by[1].status, 'paid_late');
  assert.equal(by[1].late_days, 15);
  assert.equal(by[2].status, 'overdue');
  assert.equal(by[2].late_days, 9);       // 8/19 → 8/28
  assert.equal(by[3].status, 'paid');
});

test('고객 필터: 지정 고객만 집계', () => {
  const inv = [INV[0], { ...INV[1], customer_id: 10, customer_name: 'Cliente B' }];
  const p = buildPerf({ invoices: inv, allocs: [], plan: PLAN_COL, tiers: TIERS, targets: {}, months: ['2026-06', '2026-07'], today: '2026-08-28', customerId: 10 });
  assert.equal(p.months[0].revenue.actual, 0);      // 6월은 A 고객 매출뿐
  assert.equal(p.months[1].revenue.actual, 50000);  // 7월 B 고객
  assert.equal(p.customers.length, 1);
});

test('목표가 0이면 달성률 없음 → 성과급 0 (0 나누기 방지)', () => {
  const p = buildPerf({ invoices: [], allocs: [], plan: PLAN_COL, tiers: TIERS, targets: {}, months: ['2026-07'], today: '2026-08-28' });
  assert.equal(p.months[0].collection.target, 0);
  assert.equal(p.months[0].bonus.rate, null);
  assert.equal(p.months[0].bonus.amount, 0);
});
