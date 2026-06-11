// 마케팅 예산 순수 함수
function pad2(n) { return String(n).padStart(2, '0'); }
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// 그 달 마지막 워킹데이(월~금) — 'YYYY-MM' → 'YYYY-MM-DD'
// 예측불허 항목의 예정일로 사용.
export function lastWorkingDayOfMonth(monthStr) {
  const [y, m] = String(monthStr).slice(0, 7).split('-').map(Number);
  let d = new Date(Date.UTC(y, m, 0)); // 그 달 마지막 날
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) { // 일(0)·토(6)면 하루씩 당김
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// 항목 예정일 결정: 예측불허면 마지막 워킹데이, 아니면 지정일(없으면 마지막 워킹데이)
export function resolvePlanDate({ month, dateUnknown, planDate }) {
  if (dateUnknown) return lastWorkingDayOfMonth(month);
  if (planDate && /^\d{4}-\d{2}-\d{2}$/.test(planDate)) return planDate;
  return lastWorkingDayOfMonth(month);
}

// 금액 = 수량 × 단가
export function lineAmount(qty, unitPrice) {
  return round2((Number(qty) || 0) * (Number(unitPrice) || 0));
}

// 5% 한도(매출목표 × 비율), 비율 기본 5
export function budgetLimit(salesTarget, pct = 5) {
  return round2((Number(salesTarget) || 0) * (Number(pct) || 0) / 100);
}

// 항목들을 카테고리별로 묶고, 카테고리별·전체 합계(승인상태별)
// items: [{ category, amount, status }]
export function groupByCategory(items) {
  const map = new Map();
  for (const it of items) {
    const cat = it.category || '(미분류)';
    if (!map.has(cat)) map.set(cat, { category: cat, items: [], total: 0, approved: 0, pending: 0, rejected: 0 });
    const g = map.get(cat);
    g.items.push(it);
    const amt = Number(it.amount) || 0;
    g.total = round2(g.total + amt);
    if (it.status === 'approved') g.approved = round2(g.approved + amt);
    else if (it.status === 'rejected') g.rejected = round2(g.rejected + amt);
    else g.pending = round2(g.pending + amt);
  }
  return [...map.values()].sort((a, b) => (a.category < b.category ? -1 : 1));
}

// 기간 집계: 한도 대비 편성(승인+대기)·승인·집행여부
export function periodSummary({ limit, items }) {
  const sum = (f) => round2(items.reduce((s, it) => s + (f(it) ? (Number(it.amount) || 0) : 0), 0));
  const planned = sum(() => true);
  const approved = sum((it) => it.status === 'approved');
  const pending = sum((it) => it.status === 'pending' || !it.status);
  const rejected = sum((it) => it.status === 'rejected');
  const lim = Number(limit) || 0;
  return {
    limit: round2(lim), planned, approved, pending, rejected,
    remaining: round2(lim - approved),           // 한도 대비 남은(승인 기준)
    over_limit: approved > lim,                   // 승인액이 한도 초과?
    use_pct: lim > 0 ? Math.round((approved / lim) * 100) : (approved > 0 ? null : 0),
  };
}

export { round2 };
