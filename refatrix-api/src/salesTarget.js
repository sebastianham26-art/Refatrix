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

// startYm~endYm(포함) 사이 모든 'YYYY-MM' 배열 — 연 경계 안전(수금 이월 replay용)
export function monthsInclusive(startYm, endYm) {
  let [y, m] = String(startYm).slice(0, 7).split('-').map(Number);
  const [ey, em] = String(endYm).slice(0, 7).split('-').map(Number);
  const out = [];
  if (!y || !ey) return out;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${pad2(m)}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// 매출/수금 목표 미달분 이월 (팀별 · 초과 무시)
// opts.annualReset=true(기본): 매년 1월 이월 0 리셋 → "매출목표"(새해 새 목표).
// opts.annualReset=false: 연 넘어가도 이월 유지 → "수금목표"(AR은 반드시 받아야 하므로 미실행분 계속 따라감).
// months: 시간순 'YYYY-MM' 배열(한 팀 · replay 시작월부터 표시월까지)
// baseByMonth:{ym:기본목표}, actualByMonth:{ym:실적}
//   표시목표 = 기본목표 + 이월 / 이번달 미달분 = max(0, 표시목표 - 실적) / 다음달 이월 = 이번달 미달분
export function carryoverByMonth(months, baseByMonth, actualByMonth, opts = {}) {
  const annualReset = opts.annualReset !== false; // 기본 true(매출). 수금은 false로 호출.
  const out = {};
  let carry = 0, curYear = null;
  for (const ym of months) {
    const year = String(ym).slice(0, 4);
    if (year !== curYear) { if (annualReset) carry = 0; curYear = year; } // 매출만 매년 1월 리셋 / 수금은 유지
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

// 특정 표시월 ym의 표시목표(이월 포함)만 빠르게 얻기 — startYm부터 ym까지 replay
// 매출(기본): startYm = 그 해 1월(annualReset=true). 수금: opts.startYm=epoch(최초 만기월) + annualReset=false.
export function effectiveTargetFor(ym, baseByMonth, actualByMonth, opts = {}) {
  const annualReset = opts.annualReset !== false;
  const startYm = opts.startYm || (String(ym).slice(0, 4) + '-01');
  const months = monthsInclusive(startYm, ym);
  const r = carryoverByMonth(months, baseByMonth, actualByMonth, { annualReset });
  return r[ym] || { base: 0, carryIn: 0, effective: 0, actual: r2(actualByMonth[ym] || 0), met: false, remaining: 0, addedToNext: 0 };
}

// 여러 팀의 월별 base/actual → 선택월들의 표시목표·실적 합 (팀별로 각자 이월 계산 후 합산)
// teamIds:[...], baseByTeam:{teamId:{ym:base}}, actualByTeam:{teamId:{ym:actual}}, selectedYms:[...]
export function aggregateCarryover(teamIds, baseByTeam, actualByTeam, selectedYms, opts = {}) {
  let target = 0, actual = 0;
  const perMonth = {};
  for (const ym of selectedYms) {
    let mt = 0, ma = 0;
    for (const tid of teamIds) {
      const e = effectiveTargetFor(ym, baseByTeam[tid] || {}, actualByTeam[tid] || {}, opts);
      mt = r2(mt + e.effective); ma = r2(ma + e.actual);
    }
    perMonth[ym] = { effective: mt, actual: ma };
    target = r2(target + mt); actual = r2(actual + ma);
  }
  return { target, actual, perMonth };
}

export { r2 };
