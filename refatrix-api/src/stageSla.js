// =====================================================================
// Refatrix ERP · stageSla.js
//   수주 단계별 "진행/병목" 집계 — WBR·포털 SLA 카드.
//   각 단계 = 지금 그 단계에서 다음 행동을 기다리는(아직 안 끝난) 건.
//   지연(병목) 기준 = process_sla_kpi(업무 프로세스 KPI factor) 와 동일:
//    · 오더확정: 견적작성 후 포장출력 전 — 견적+KPI.order(시간, 벽시계) 초과 시 지연
//    · 포장    : 포장출력 후 포장완료 전 — 인쇄시각+KPI.packing(업무시간) 초과 시 지연
//                (저장된 packing_due_at 무시, 인쇄시각 기준 재계산 → KPI 변경 즉시 반영)
//    · SAT     : 매출전환 후 SAT입력 전 — 전환+KPI.sat(시간, 벽시계) 초과 시 지연
//    · 정시수금: 인보이스 후 미수금 — 외상만기(due_date) 초과 시 지연
//   업무시간 계산은 businessHours.js(월~금 07:30~17:00, UTC-6) — KPI 페이지와 동일 함수.
//   완료돼 다음 단계로 넘어간 건은 코호트에서 제외된다(쿼리에서).
// =====================================================================
import { MX_OFFSET_MIN } from './workingHours.js';
import { bizMinutes } from './businessHours.js';

const H = 3600000;

// rows: 현재 그 단계에 대기 중인 건. fn(r) → { overdue(지연여부), age(경과, 단위는 stage별) }
function reduceStage(rows, fn) {
  let delayed = 0, sumAge = 0, amount = 0;
  const items = [];
  for (const r of rows) {
    const res = fn(r);
    const { overdue, age } = res;
    if (overdue) delayed++;
    sumAge += (Number(age) || 0);
    amount += (Number(r.amount) || 0);
    const item = {
      customer: r.customer_name || '불특정',
      amount: Math.round((Number(r.amount) || 0) * 100) / 100,
      age: Math.round((Number(age) || 0) * 10) / 10,
      overdue: !!overdue,
      sku_count: Number(r.sku_count) || 0,
      total_qty: Math.round((Number(r.total_qty) || 0) * 1000) / 1000,
    };
    if (res.dueRel !== undefined) item.dueRel = res.dueRel;  // 정시수금: 만기 상대일(부호: +지남 / 0당일 / -미도래)
    items.push(item);
  }
  // 정시수금은 만기 상대일 큰 순(가장 많이 지난 것 위), 그 외는 지연건 먼저·금액 큰 순
  if (items.some((it) => it.dueRel !== undefined)) {
    items.sort((x, y) => (Number(y.dueRel) - Number(x.dueRel)) || (y.amount - x.amount));
  } else {
    items.sort((x, y) => (Number(y.overdue) - Number(x.overdue)) || (y.amount - x.amount));
  }
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

// kpi = { order(시간), packing(업무시간), sat(시간) } — process_sla_kpi 값. 없으면 기본 48/6/3.
export function summarizeSla(c, now, kpi) {
  const NOW = now ? new Date(now).getTime() : Date.now();
  const K = {
    order: Number(kpi && kpi.order) > 0 ? Number(kpi.order) : 48,
    packing: Number(kpi && kpi.packing) > 0 ? Number(kpi.packing) : 6,
    sat: Number(kpi && kpi.sat) > 0 ? Number(kpi.sat) : 3,
  };
  const order = reduceStage(c.order || [], (r) => {
    const start = new Date(r.created_at).getTime();
    const age = (NOW - start) / H;                       // 견적 후 경과(시간, 벽시계)
    return { overdue: (NOW - start) > K.order * H, age };
  });
  const packing = reduceStage(c.packing || [], (r) => {
    const printed = new Date(r.packing_printed_at).getTime();
    const age = bizMinutes(printed, NOW) / 60;           // 인쇄 후 경과(업무시간, 재계산)
    return { overdue: age > K.packing, age };
  });
  const sat = reduceStage(c.sat || [], (r) => {
    const start = new Date(r.converted_at).getTime();
    const age = (NOW - start) / H;                       // 전환 후 경과(시간, 벽시계)
    return { overdue: (NOW - start) > K.sat * H, age };
  });
  const collect = reduceStage(c.collect || [], (r) => {
    const dueMs = Date.parse(String(r.due_date).slice(0, 10) + 'T00:00:00Z');
    const todayStr = new Date(NOW + MX_OFFSET_MIN * 60000).toISOString().slice(0, 10); // MX 오늘 날짜
    const todayMs = Date.parse(todayStr + 'T00:00:00Z');
    const dueRel = Math.round((todayMs - dueMs) / 86400000);  // >0 지남(지연중) / 0 당일(기일도래) / <0 외상기간중
    return { overdue: dueRel > 0, age: Math.max(0, dueRel), dueRel };
  });
  return {
    order:   { ...order,   key: 'order',   label: `오더확정 (견적→포장출력 대기 · ${K.order}h 초과 지연)`,      unit: '시간' },
    packing: { ...packing, key: 'packing', label: `포장단계 (포장출력→완료 대기 · ${K.packing}업무h 초과 지연)`, unit: '업무시간' },
    sat:     { ...sat,     key: 'sat',     label: `인보이스 (전환→SAT발행 대기 · ${K.sat}h 초과 지연)`,          unit: '시간' },
    collect: { ...collect, key: 'collect', label: '정시수금 (발행 후 미수금 · 만기 이후 지연중)',                unit: '지연일' },
  };
}
