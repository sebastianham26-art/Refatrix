// 영업 파이프라인·병목 분석(순수 함수)
function r1(n) { return Math.round(Number(n) * 10) / 10; }

// 일수 차이(YYYY-MM-DD 문자열 또는 Date)
export function daysBetween(from, to) {
  const a = new Date(from + 'T00:00:00Z'); const b = new Date(to + 'T00:00:00Z');
  return Math.max(0, Math.round((b - a) / 86400000));
}

// 단계별 현재 체류 고객 집계
// stages: [{id,name,sort_order}], customers: [{id, stage_id, stage_since}], today: 'YYYY-MM-DD'
// → [{stage_id, name, sort_order, count, avg_days, max_days, customers:[{id,days}]}]
export function pipelineByStage(stages, customers, today) {
  const byStage = {};
  for (const s of stages) byStage[s.id] = { stage_id: s.id, name: s.name, sort_order: s.sort_order, count: 0, totalDays: 0, max_days: 0, customers: [] };
  for (const c of customers) {
    const b = byStage[c.stage_id];
    if (!b) continue;
    const d = c.stage_since ? daysBetween(c.stage_since, today) : 0;
    b.count += 1; b.totalDays += d; if (d > b.max_days) b.max_days = d;
    b.customers.push({ id: c.id, days: d });
  }
  return Object.values(byStage)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((b) => ({ stage_id: b.stage_id, name: b.name, sort_order: b.sort_order, count: b.count,
      avg_days: b.count ? r1(b.totalDays / b.count) : 0, max_days: b.max_days,
      customers: b.customers.sort((x, y) => y.days - x.days) }));
}

// 병목 단계 판정: 최종(거래중) 단계를 제외하고, 평균 체류일이 가장 긴 단계.
// 동률이면 체류 고객 수가 많은 단계. 데이터 없으면 null.
export function detectBottleneck(pipeline) {
  const candidates = pipeline.filter((s) => s.count > 0 && s.sort_order < 60); // 06_거래중(60) 제외
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.avg_days - a.avg_days) || (b.count - a.count));
  const top = candidates[0];
  return { stage_id: top.stage_id, name: top.name, avg_days: top.avg_days, count: top.count };
}

// 정체 고객(특정 단계에서 임계일 초과) — 집중 대상
export function stalledCustomers(pipeline, thresholdDays = 30) {
  const out = [];
  for (const s of pipeline) {
    if (s.sort_order >= 60) continue;
    for (const c of s.customers) if (c.days >= thresholdDays) out.push({ customer_id: c.id, stage_id: s.stage_id, stage_name: s.name, days: c.days });
  }
  return out.sort((a, b) => b.days - a.days);
}

export { r1 };
