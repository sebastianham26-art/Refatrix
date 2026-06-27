// =====================================================================
// Refatrix ERP · stageSla.js
//   수주 단계별 SLA(준수율 + 평균 리드타임) 집계 — WBR 스냅샷용.
//   기준(디렉터 확정 경고 기준과 동일):
//    · 오더확정: 견적작성 → 포장출력 ≤ 48시간(벽시계)
//    · 포장    : 포장출력 → 포장완료 ≤ 업무시간 6시간
//    · SAT     : 매출전환 → SAT입력 ≤ 3시간(벽시계)
//    · 정시수금: 완전 수금 시점이 외상만기(due_date) 이내
// =====================================================================
import { workingMinutesBetween } from './workingHours.js';

const H = 3600000;

function reduceStage(rows, fn) {
  let met = 0, sumLead = 0, amount = 0;
  const items = [];
  for (const r of rows) {
    const { ok, lead } = fn(r);
    if (ok) met++;
    sumLead += (Number(lead) || 0);
    amount += (Number(r.amount) || 0);
    items.push({
      customer: r.customer_name || '불특정',
      amount: Math.round((Number(r.amount) || 0) * 100) / 100,
      lead: Math.round((Number(lead) || 0) * 10) / 10,
      ok: !!ok,
    });
  }
  // 금액 큰 순으로 정렬(상위가 위로)
  items.sort((x, y) => (y.amount - x.amount));
  const n = rows.length;
  return {
    n, met,
    rate: n ? Math.round((met / n) * 1000) / 10 : null,
    avg: n ? Math.round((sumLead / n) * 10) / 10 : null,
    amount: Math.round(amount * 100) / 100,   // 해당 단계 코호트 매출액 합(IVA 포함)
    items,                                     // 단계별 개별 내역(고객·금액·리드·준수)
  };
}

export function summarizeSla(c, _now) {
  const order = reduceStage(c.orderConfirm || [], (r) => {
    const lead = (new Date(r.packing_printed_at).getTime() - new Date(r.created_at).getTime()) / H;
    return { ok: lead <= 48, lead };
  });
  const packing = reduceStage(c.packing || [], (r) => {
    const lead = workingMinutesBetween(r.packing_printed_at, r.packed_at) / 60; // 업무시간(시)
    const ok = r.packing_due_at ? (new Date(r.packed_at) <= new Date(r.packing_due_at)) : (lead <= 6);
    return { ok, lead };
  });
  const sat = reduceStage(c.sat || [], (r) => {
    const lead = (new Date(r.sat_entered_at).getTime() - new Date(r.converted_at).getTime()) / H;
    return { ok: lead <= 3, lead };
  });
  const collect = reduceStage(c.collect || [], (r) => {
    const due = String(r.due_date).slice(0, 10);
    const col = String(r.collected_at).slice(0, 10);
    const lateDays = Math.round((new Date(col + 'T00:00:00Z') - new Date(due + 'T00:00:00Z')) / 86400000);
    return { ok: col <= due, lead: Math.max(0, lateDays) };
  });
  return {
    order: { ...order, key: 'order', label: '오더확정 (견적→포장작업게시 48h)', unit: '시간' },
    packing: { ...packing, key: 'packing', label: '포장단계 (포장작업→완료 6h)', unit: '업무시간' },
    sat: { ...sat, key: 'sat', label: '인보이스 (포장완료→SAT발행 3h)', unit: '시간' },
    collect: { ...collect, key: 'collect', label: '정시수금 (외상만기일 내)', unit: '지연일' },
  };
}
