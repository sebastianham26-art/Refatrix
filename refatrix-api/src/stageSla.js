// =====================================================================
// Refatrix ERP · stageSla.js
//   수주 단계별 "진행/병목" 집계 — WBR.
//   각 단계 = 지금 그 단계에서 다음 행동을 기다리는(아직 안 끝난) 건.
//   지연(병목) 기준(디렉터 확정 경고 기준과 동일):
//    · 오더확정: 견적작성 후 포장출력 전 — 견적+48h(벽시계) 초과 시 지연
//    · 포장    : 포장출력 후 포장완료 전 — 포장마감(업무시간 6h, packing_due_at) 초과 시 지연
//    · SAT     : 매출전환 후 SAT입력 전 — 전환+3h(벽시계) 초과 시 지연
//    · 정시수금: 인보이스 후 미수금 — 외상만기(due_date) 초과 시 지연
//   완료돼 다음 단계로 넘어간 건은 코호트에서 제외된다(쿼리에서).
// =====================================================================
import { workingMinutesBetween } from './workingHours.js';

const H = 3600000;

// rows: 현재 그 단계에 대기 중인 건. fn(r) → { overdue(지연여부), age(경과, 단위는 stage별) }
function reduceStage(rows, fn) {
  let delayed = 0, sumAge = 0, amount = 0;
  const items = [];
  for (const r of rows) {
    const { overdue, age } = fn(r);
    if (overdue) delayed++;
    sumAge += (Number(age) || 0);
    amount += (Number(r.amount) || 0);
    items.push({
      customer: r.customer_name || '불특정',
      amount: Math.round((Number(r.amount) || 0) * 100) / 100,
      age: Math.round((Number(age) || 0) * 10) / 10,
      overdue: !!overdue,
    });
  }
  // 지연건 먼저, 그다음 금액 큰 순
  items.sort((x, y) => (Number(y.overdue) - Number(x.overdue)) || (y.amount - x.amount));
  const n = rows.length;
  return {
    n,                                                   // 현재 대기 건수
    delayed,                                             // 그중 지연(기한 초과) 건수
    rate: n ? Math.round(((n - delayed) / n) * 1000) / 10 : null,  // 기한 내(정상) 비율
    avg: n ? Math.round((sumAge / n) * 10) / 10 : null,           // 평균 경과(단위 stage별)
    amount: Math.round(amount * 100) / 100,
    items,
  };
}

export function summarizeSla(c, now) {
  const NOW = now ? new Date(now).getTime() : Date.now();
  const order = reduceStage(c.order || [], (r) => {
    const start = new Date(r.created_at).getTime();
    const age = (NOW - start) / H;                       // 견적 후 경과(시간)
    return { overdue: (NOW - start) > 48 * H, age };
  });
  const packing = reduceStage(c.packing || [], (r) => {
    const dl = r.packing_due_at ? new Date(r.packing_due_at).getTime()
                                : (new Date(r.packing_printed_at).getTime() + 6 * H);
    const age = workingMinutesBetween(r.packing_printed_at, new Date(NOW)) / 60; // 업무시간 경과(시)
    return { overdue: NOW > dl, age };
  });
  const sat = reduceStage(c.sat || [], (r) => {
    const start = new Date(r.converted_at).getTime();
    const age = (NOW - start) / H;                       // 전환 후 경과(시간)
    return { overdue: (NOW - start) > 3 * H, age };
  });
  const collect = reduceStage(c.collect || [], (r) => {
    const due = new Date(String(r.due_date).slice(0, 10) + 'T00:00:00Z').getTime();
    const lateDays = Math.max(0, Math.floor((NOW - due) / 86400000));  // 만기 후 경과일
    return { overdue: NOW > due, age: lateDays };
  });
  return {
    order:   { ...order,   key: 'order',   label: '오더확정 (견적→포장출력 대기 · 48h 초과 지연)',  unit: '시간' },
    packing: { ...packing, key: 'packing', label: '포장단계 (포장출력→완료 대기 · 6업무h 초과 지연)', unit: '업무시간' },
    sat:     { ...sat,     key: 'sat',     label: '인보이스 (전환→SAT 대기 · 3h 초과 지연)',        unit: '시간' },
    collect: { ...collect, key: 'collect', label: '정시수금 (인보이스→수금 대기 · 만기 초과 지연)',   unit: '지연일' },
  };
}
