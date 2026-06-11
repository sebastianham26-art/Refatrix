// 매출 목표 순수 함수
function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function pad2(n) { return String(n).padStart(2, '0'); }

// 시작 'YYYY-MM'부터 n개월 배열
export function monthsHorizon(startYm, n = 12) {
  const [y, m] = String(startYm).slice(0, 7).split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`);
  }
  return out;
}

// 현재(UTC) 기준 이번 달 'YYYY-MM'
export function currentYm(today = new Date()) {
  return `${today.getUTCFullYear()}-${pad2(today.getUTCMonth() + 1)}`;
}

// [{ym, amount}] → {ym: total}
export function sumByMonth(rows) {
  const map = {};
  for (const r of rows) map[r.ym] = r2((map[r.ym] || 0) + (Number(r.amount) || 0));
  return map;
}

// 팀 목표(byMonth) 대비 고객 할당 합(byMonth) → 월별 {target, allocated, shortfall, over}
// months: 표시할 월 배열
export function shortfallByMonth(months, teamByMonth, custByMonth) {
  const out = {};
  for (const ym of months) {
    const target = r2(teamByMonth[ym] || 0);
    const allocated = r2(custByMonth[ym] || 0);
    const diff = r2(target - allocated);
    out[ym] = { target, allocated, shortfall: diff > 0 ? diff : 0, over: diff < 0 ? -diff : 0 };
  }
  return out;
}

// 고객별 연간(특정 연도) 목표 합 — 고객상세 "연말 누적 목표"용
// custMonths: [{customer_id, ym, amount}], year: 숫자
export function customerYearTotals(custMonths, year) {
  const map = {};
  for (const r of custMonths) {
    if (String(r.ym).slice(0, 4) !== String(year)) continue;
    map[r.customer_id] = r2((map[r.customer_id] || 0) + (Number(r.amount) || 0));
  }
  return map;
}

// 전체 합 대비 팀 합 검증(디렉터 화면): 월별 {company, teamSum, shortfall, over}
export function companyVsTeams(months, companyByMonth, teamSumByMonth) {
  const out = {};
  for (const ym of months) {
    const company = r2(companyByMonth[ym] || 0);
    const teamSum = r2(teamSumByMonth[ym] || 0);
    const diff = r2(company - teamSum);
    out[ym] = { company, teamSum, shortfall: diff > 0 ? diff : 0, over: diff < 0 ? -diff : 0 };
  }
  return out;
}

export { r2 };
