// 커미션 「수금일 판정」(0250) 순수 로직 — computeLine / commissionMode / buildPerf 적립
//   실행: node --test test/commission_paydate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLine, commissionMode, validatePeriods } from '../src/routes/commissionRoutes.js';
import { buildPerf, invMode } from '../src/routes/commissionBonus.js';

test('모드 판정 — 매출 / 발행일(종전) / 수금일 / 기간 없음=수금일', () => {
  assert.equal(commissionMode({ basis: 'revenue', match_on: 'payment' }), 'revenue');
  assert.equal(commissionMode({ basis: 'collection', match_on: 'invoice' }), 'invoice');
  assert.equal(commissionMode({ basis: 'collection' }), 'invoice', 'match_on 없음(0250 전) = 종전');
  assert.equal(commissionMode({ basis: 'collection', match_on: 'payment' }), 'payment');
  assert.equal(commissionMode({ basis: null }), 'payment');
  assert.equal(invMode({ basis: null }), 'payment');
});

test('수금일 판정 — 기간 안 수금분만 적립, 완납 시 확정', () => {
  // 10,000 + IVA = 11,600 · 기간 안 수금 5,800(× 4%) · 완납
  const c = computeLine({ subtotal_mxn: 10000, total_mxn: 11600, paid_amount: 11600, last_pay_date: '2026-10-03', basis: null, pp_amt: 5800, pp_w: 5800 * 4, po_rate: 4 });
  assert.equal(c.mode, 'payment');
  assert.equal(c.accrued, 200);
  assert.equal(c.collected_base, 5000);
  assert.equal(c.recognized, true);
  assert.equal(c.confirmed, 200);
  assert.equal(c.expected, 200);
  assert.equal(c.settleYm, '2026-10');
  assert.equal(c.base, 10000, 'base 는 인보이스 순매출(차액 정산 기준)');
});

test('수금일 판정 — 부분수금은 적립만, 미확정 · 99/100 수금도 미확정', () => {
  const c = computeLine({ subtotal_mxn: 10000, total_mxn: 11600, paid_amount: 3480, last_pay_date: '2026-10-04', basis: null, pp_amt: 3480, pp_w: 3480 * 4, po_rate: 4 });
  assert.equal(c.accrued, 120);
  assert.equal(c.potential, 280);
  assert.equal(c.expected, 400);
  assert.equal(c.recognized, false);
  assert.equal(c.confirmed, 0);
  assert.equal(c.settleYm, null);
  const almost = computeLine({ subtotal_mxn: 100, total_mxn: 100, paid_amount: 99, last_pay_date: '2026-10-04', basis: null, pp_amt: 99, pp_w: 99 * 4, po_rate: 4 });
  assert.equal(almost.recognized, false);
});

test('수금일 판정 — 기간 전 완납(적립 0)은 relevant=false', () => {
  const c = computeLine({ subtotal_mxn: 5000, total_mxn: 5800, paid_amount: 5800, last_pay_date: '2026-08-20', basis: null, pp_amt: 0, pp_w: 0, po_rate: 4 });
  assert.equal(c.relevant, false);
  assert.equal(c.recognized, false);
});

test('고객 예외율은 수금일 판정에도 우선', () => {
  const c = computeLine({ subtotal_mxn: 10000, total_mxn: 11600, paid_amount: 0, basis: null, pp_amt: 0, pp_w: 0, po_rate: 4, cust_rate: 6 });
  assert.equal(c.potential, 600);
  assert.equal(c.rate, 6);
});

test('종전(발행일 판정)·매출 기준은 그대로', () => {
  const inv = computeLine({ subtotal_mxn: 10000, total_mxn: 11600, paid_amount: 11600, last_pay_date: '2026-10-03', basis: 'collection', match_on: 'invoice', rate: 4 });
  assert.equal(inv.confirmed, 400);
  const rev = computeLine({ subtotal_mxn: 10000, total_mxn: 11600, paid_amount: 0, basis: 'revenue', rate: 3, inv_ym: '2026-10' });
  assert.equal(rev.confirmed, 300);
  assert.equal(rev.settleYm, '2026-10');
});

test('기간 검증 — match_on 은 수금 기준에서만 payment', () => {
  const v = validatePeriods([
    { start_date: '2026-07-01', end_date: '2026-10-31', basis: 'revenue', rate: 3, match_on: 'payment' },
    { start_date: '2026-11-01', end_date: null, basis: 'collection', rate: 3, match_on: 'payment' },
  ]);
  assert.equal(v.ok, true);
  assert.equal(v.periods[0].match_on, 'invoice');
  assert.equal(v.periods[1].match_on, 'payment');
  assert.equal(validatePeriods([{ start_date: '2026-10-01', basis: 'collection', rate: 4 }]).periods[0].match_on, 'invoice');
});

test('buildPerf — 월별 적립/확정 · 수금 내역 · 완납 대기 · 수금목표 구성', () => {
  const invoices = [
    { id: 1, sat_no: 'A', inv_date: '2026-09-10', due_date: '2026-10-10', subtotal: 10000, total: 11600, customer_id: 7, customer_name: 'X', basis: null, match_on: 'invoice', po_rate: 4 },
    { id: 2, sat_no: 'B', inv_date: '2026-09-15', due_date: '2026-09-25', subtotal: 10000, total: 11600, customer_id: 8, customer_name: 'Y', basis: null, match_on: 'invoice', po_rate: 4 },
  ];
  const allocs = [
    { invoice_id: 1, pay_date: '2026-09-20', amount: 5800, com_rate: null },
    { invoice_id: 1, pay_date: '2026-10-03', amount: 5800, com_rate: 4 },
    { invoice_id: 2, pay_date: '2026-10-04', amount: 3480, com_rate: 4 },
  ];
  const p = buildPerf({ invoices, allocs, months: ['2026-10'], today: '2026-10-05' });
  const m = p.months[0];
  assert.equal(m.commission, 200);
  assert.equal(m.commission_accrued, 320);
  assert.equal(p.totals.commission_pending, 120);
  assert.equal(p.totals.commission_pending_open, 8120);
  assert.equal(p.payments.length, 2);
  assert.equal(p.payments.find((x) => x.invoice_id === 1).closes_invoice, true);
  assert.equal(m.collection.target, 20000);   // A 당월 만기 10,000 + B 연체 이월 10,000
  assert.deepEqual(p.collection_targets.map((x) => x.kind).sort(), ['carry', 'due']);
  const iB = p.invoices.find((x) => x.invoice_id === 2);
  assert.equal(iB.late, true);
  assert.equal(iB.open_total, 8120);
  // 9월 범위에서는 9월 수금(기간 전) 적립 0
  const sep = buildPerf({ invoices, allocs, months: ['2026-09'], today: '2026-10-05' });
  assert.equal(sep.months[0].commission_accrued, 0);
});

test('수금 실적 표시 — 성과급이 매출 기준이면 완납분만 설정이어도 실제 현금 기준', () => {
  const invoices = [{ id: 2, inv_date: '2026-09-15', due_date: '2026-09-25', subtotal: 10000, total: 11600, customer_id: 8, basis: null, po_rate: 4 }];
  const allocs = [{ invoice_id: 2, pay_date: '2026-10-04', amount: 3480, com_rate: 4 }];
  const rev = buildPerf({ invoices, allocs, months: ['2026-10'], today: '2026-10-05', plan: { enabled: true, basis: 'revenue', start_month: '2026-10', partial_credit: false }, tiers: [{ min_rate: 100, amount: 6000 }], targets: { '2026-10': 1 } });
  assert.equal(rev.months[0].collection.actual, 3000);
  const col = buildPerf({ invoices, allocs, months: ['2026-10'], today: '2026-10-05', plan: { enabled: true, basis: 'collection', start_month: '2026-10', partial_credit: false }, tiers: [{ min_rate: 100, amount: 6000 }] });
  assert.equal(col.months[0].collection.actual, 0, '수금 기준 성과급 + 완납분만 → 완납 전엔 0');
});
