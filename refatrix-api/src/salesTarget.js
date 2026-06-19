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

// 매출/수금 목표 미달분 이월 (팀별 · 초과 무시 · 매년 1월 리셋)
// months: 시간순 'YYYY-MM' 배열(한 팀 · 그 해 1월부터 표시월까지 — replay 필요)
// baseByMonth:{ym:기본목표}, actualByMonth:{ym:실적}
//   표시목표 = 기본목표 + 이월 / 이번달 미달분 = max(0, 표시목표 - 실적) / 다음달 이월 = 이번달 미달분
export function carryoverByMonth(months, baseByMonth, actualByMonth) {
  const out = {};
  let carry = 0, curYear = null;
  for (const ym of months) {
    const year = String(ym).slice(0, 4);
    if (year !== curYear) { carry = 0; curYear = year; } // 매년 1월 리셋
    const base = r2(baseByMonth[ym] || 0);
    const carryIn = r2(carry);
    const effective = r2(base + carryIn);
    const actual = r2(actualByMonth[ym] || 0);
    const shortfall = effective - actual > 0 ? r2(effective - actual) : 0; // 초과는 무시
    out[ym] = { base, carryIn, effective, actual, met: actual >= effective, remaining: shortfall, addedToNext: shortfall };
    carry = shortfall; // 다음달 이월 = 이번달 미달분
  }
  return out;
}

// 특정 표시월 ym의 표시목표(이월 포함)만 빠르게 얻기 — 그 해 1월부터 ym까지 replay
export function effectiveTargetFor(ym, baseByMonth, actualByMonth) {
  const year = String(ym).slice(0, 4);
  const [, mm] = String(ym).split('-').map(Number);
  const months = [];
  for (let i = 1; i <= mm; i++) months.push(`${year}-${String(i).padStart(2, '0')}`);
  const r = carryoverByMonth(months, baseByMonth, actualByMonth);
  return r[ym] || { base: 0, carryIn: 0, effective: 0, actual: r2(actualByMonth[ym] || 0), met: false, remaining: 0, addedToNext: 0 };
}

// 여러 팀의 월별 base/actual → 선택월들의 표시목표·실적 합 (팀별로 각자 이월 계산 후 합산)
// teamIds:[...], baseByTeam:{teamId:{ym:base}}, actualByTeam:{teamId:{ym:actual}}, selectedYms:[...]
export function aggregateCarryover(teamIds, baseByTeam, actualByTeam, selectedYms) {
  let target = 0, actual = 0;
  const perMonth = {};
  for (const ym of selectedYms) {
    let mt = 0, ma = 0;
    for (const tid of teamIds) {
      const e = effectiveTargetFor(ym, baseByTeam[tid] || {}, actualByTeam[tid] || {});
      mt = r2(mt + e.effective); ma = r2(ma + e.actual);
    }
    perMonth[ym] = { effective: mt, actual: ma };
    target = r2(target + mt); actual = r2(actual + ma);
  }
  return { target, actual, perMonth };
}

export { r2 };
