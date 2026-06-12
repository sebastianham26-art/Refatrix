// 마케팅 메뉴판 배분 순수 함수
import { monthsHorizon, currentYm } from './salesTarget.js';
function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

export { monthsHorizon, currentYm };

// 한 배분 줄의 비용 = qty × unit_budget
export function allocCost(qty, unitBudget) {
  return r2((Number(qty) || 0) * (Number(unitBudget) || 0));
}

// 배분 행들 [{customer_id, ym, qty, unit_budget}] → 월별 합 {ym: total}
export function allocSumByMonth(rows) {
  const map = {};
  for (const r of rows) {
    const c = allocCost(r.qty, r.unit_budget);
    map[r.ym] = r2((map[r.ym] || 0) + c);
  }
  return map;
}

// 고객별·월별 합 {customer_id: {ym: total}}
export function allocByCustomerMonth(rows) {
  const map = {};
  for (const r of rows) {
    const c = allocCost(r.qty, r.unit_budget);
    (map[r.customer_id] ||= {});
    map[r.customer_id][r.ym] = r2((map[r.customer_id][r.ym] || 0) + c);
  }
  return map;
}

// 전체 예산(byMonth) 대비 배분 합(byMonth) → 월별 {budget, allocated, remaining, over}
export function budgetVsAlloc(months, budgetByMonth, allocByMonth) {
  const out = {};
  for (const ym of months) {
    const budget = r2(budgetByMonth[ym] || 0);
    const allocated = r2(allocByMonth[ym] || 0);
    const diff = r2(budget - allocated);
    out[ym] = { budget, allocated, remaining: diff > 0 ? diff : 0, over: diff < 0 ? -diff : 0 };
  }
  return out;
}

// 연간 합(months 범위 내)
export function sumMonths(months, byMonth) {
  let s = 0;
  for (const ym of months) s = r2(s + (byMonth[ym] || 0));
  return s;
}

export { r2 };
