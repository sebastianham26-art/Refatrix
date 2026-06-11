import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCashflow, planVsActual, computeOverdue, latePaymentHistory, monthKey, weekKey } from '../src/cashflow.js';

test('monthKey / weekKey', () => {
  assert.equal(monthKey('2026-06-11'), '2026-06');
  // 2026-06-11 is Thursday → ISO week 24
  assert.equal(weekKey('2026-06-11'), '2026-W24');
});

test('aggregateCashflow actual-only with opening balance + cumulative', () => {
  const txns = [
    { direction: 'in', status: 'actual', amount_mxn: 1000, txn_date: '2026-06-05' },
    { direction: 'out', status: 'actual', amount_mxn: 400, txn_date: '2026-06-20' },
    { direction: 'in', status: 'actual', amount_mxn: 2000, txn_date: '2026-07-10' },
    { direction: 'in', status: 'plan', amount_mxn: 9999, txn_date: '2026-07-15', plan_date: '2026-07-15' }, // excluded
  ];
  const rows = aggregateCashflow(txns, { granularity: 'month', includePlan: false, openingBalance: 500 });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { period: '2026-06', inflow: 1000, outflow: 400, net: 600, cumulative: 1100 });
  assert.deepEqual(rows[1], { period: '2026-07', inflow: 2000, outflow: 0, net: 2000, cumulative: 3100 });
});

test('aggregateCashflow includePlan uses plan_date for plan rows', () => {
  const txns = [
    { direction: 'in', status: 'actual', amount_mxn: 1000, txn_date: '2026-06-05' },
    { direction: 'out', status: 'plan', amount_mxn: 700, txn_date: '2026-08-01', plan_date: '2026-08-01' },
  ];
  const rows = aggregateCashflow(txns, { granularity: 'month', includePlan: true, openingBalance: 0 });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].period, '2026-08');
  assert.equal(rows[1].outflow, 700);
  assert.equal(rows[1].cumulative, 300); // 1000 - 700
});

test('planVsActual splits income/expense, plan vs actual', () => {
  const txns = [
    // actual income, planned earlier same month
    { direction: 'in', status: 'actual', amount_mxn: 900, txn_date: '2026-06-20', plan_amount_mxn: 1000, plan_date: '2026-06-10' },
    // plan-only expense (fixed cost)
    { direction: 'out', status: 'plan', amount_mxn: 0, txn_date: '2026-06-06', plan_amount_mxn: 500, plan_date: '2026-06-06', recurring_rule_id: 5 },
  ];
  const r = planVsActual(txns, { granularity: 'month', filter: 'all' });
  // income plan in 2026-06 = 1000, actual in 2026-06 = 900
  const incPlan = r.income.plan.find((x) => x.period === '2026-06');
  const incActual = r.income.actual.find((x) => x.period === '2026-06');
  assert.equal(incPlan.value, 1000);
  assert.equal(incActual.value, 900);
  // expense plan 500, actual none
  const expPlan = r.expense.plan.find((x) => x.period === '2026-06');
  assert.equal(expPlan.value, 500);
  assert.equal(r.expense.actual.find((x) => x.period === '2026-06').value, 0);
});

test('planVsActual filter recurring vs other', () => {
  const txns = [
    { direction: 'out', status: 'plan', amount_mxn: 0, plan_amount_mxn: 500, plan_date: '2026-06-06', txn_date: '2026-06-06', recurring_rule_id: 5 },
    { direction: 'out', status: 'plan', amount_mxn: 0, plan_amount_mxn: 300, plan_date: '2026-06-06', txn_date: '2026-06-06', recurring_rule_id: null },
  ];
  const rec = planVsActual(txns, { filter: 'recurring' });
  assert.equal(rec.expense.plan.find((x) => x.period === '2026-06').value, 500);
  const oth = planVsActual(txns, { filter: 'other' });
  assert.equal(oth.expense.plan.find((x) => x.period === '2026-06').value, 300);
});

test('computeOverdue: past due with outstanding, sorted by days desc, severity', () => {
  const invoices = [
    { id: 1, customer_id: 'c1', customer_name: 'A', due_date: '2026-06-01', total: 1000, paid: 0 },   // 10 days overdue
    { id: 2, customer_id: 'c2', customer_name: 'B', due_date: '2026-05-01', total: 500, paid: 200 },   // 41 days, outstanding 300
    { id: 3, customer_id: 'c3', customer_name: 'C', due_date: '2026-06-20', total: 800, paid: 0 },      // not due yet
    { id: 4, customer_id: 'c4', customer_name: 'D', due_date: '2026-06-01', total: 700, paid: 700 },    // paid full
  ];
  const ov = computeOverdue(invoices, '2026-06-11');
  assert.equal(ov.length, 2);
  assert.equal(ov[0].id, 2); // 41 days first
  assert.equal(ov[0].outstanding, 300);
  assert.equal(ov[0].overdue_days, 41);
  assert.equal(ov[0].severity, 'high');
  assert.equal(ov[1].id, 1);
  assert.equal(ov[1].overdue_days, 10);
  assert.equal(ov[1].severity, 'mid');
});

test('latePaymentHistory: only late, sorted desc', () => {
  const payments = [
    { invoice_id: 1, customer_id: 'c1', customer_name: 'A', due_date: '2026-05-01', pay_date: '2026-05-05', amount: 1000 }, // 4 late
    { invoice_id: 2, customer_id: 'c2', customer_name: 'B', due_date: '2026-05-01', pay_date: '2026-04-28', amount: 500 },  // early, excluded
    { invoice_id: 3, customer_id: 'c3', customer_name: 'C', due_date: '2026-05-01', pay_date: '2026-06-10', amount: 800 },  // 40 late
  ];
  const late = latePaymentHistory(payments);
  assert.equal(late.length, 2);
  assert.equal(late[0].invoice_id, 3);
  assert.equal(late[0].late_days, 40);
  assert.equal(late[1].late_days, 4);
});

import { monthBreakdown } from '../src/cashflow.js';

test('monthBreakdown: actual section + plan section states', () => {
  const txns = [
    // processed: planned in June, now actual in June
    { id: 1, direction: 'out', status: 'actual', txn_date: '2026-06-06', amount_mxn: 60000, plan_date: '2026-06-06', plan_amount_mxn: 63000 },
    // upcoming: plan in June, due date not passed (today 2026-06-11)
    { id: 2, direction: 'out', status: 'plan', txn_date: '2026-06-20', amount_mxn: 8000, plan_date: '2026-06-20', plan_amount_mxn: 8000 },
    // overdue: plan in June, due date passed
    { id: 3, direction: 'in', status: 'plan', txn_date: '2026-06-05', amount_mxn: 5000, plan_date: '2026-06-05', plan_amount_mxn: 5000 },
    // actual income in June, planned in May (not in June plan section)
    { id: 4, direction: 'in', status: 'actual', txn_date: '2026-06-09', amount_mxn: 2000, plan_date: '2026-05-30', plan_amount_mxn: 2000 },
    // different month entirely
    { id: 5, direction: 'out', status: 'plan', txn_date: '2026-07-06', amount_mxn: 1000, plan_date: '2026-07-06', plan_amount_mxn: 1000 },
  ];
  const r = monthBreakdown(txns, '2026-06', '2026-06-11');
  // actual section: ids 1 and 4 (actual in June)
  assert.deepEqual(r.actual.items.map((x) => x.id).sort(), [1, 4]);
  assert.equal(r.actual.subtotal.in, 2000);
  assert.equal(r.actual.subtotal.out, 60000);
  assert.equal(r.actual.subtotal.net, -58000);
  // plan section: ids 1,2,3 (plan_date in June). id4 plan_date is May → excluded. id5 July → excluded
  assert.deepEqual(r.plan.items.map((x) => x.id).sort(), [1, 2, 3]);
  const byId = Object.fromEntries(r.plan.items.map((x) => [x.id, x._state]));
  assert.equal(byId[1], 'processed');
  assert.equal(byId[2], 'upcoming');
  assert.equal(byId[3], 'overdue');
  // out summary: planned 63000+8000=71000, processed 60000 (actual of id1), remaining 8000 (id2), overdue 0
  assert.equal(r.plan.summary.out.planned, 71000);
  assert.equal(r.plan.summary.out.processed, 60000);
  assert.equal(r.plan.summary.out.remaining, 8000);
  assert.equal(r.plan.summary.out.overdue, 0);
  // in summary: planned 5000 (id3), processed 0, remaining 5000, overdue 5000 (id3 past due)
  assert.equal(r.plan.summary.in.planned, 5000);
  assert.equal(r.plan.summary.in.remaining, 5000);
  assert.equal(r.plan.summary.in.overdue, 5000);
});
