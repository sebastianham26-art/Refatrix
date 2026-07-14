// 재주문(구매주기) 지표 공용 계산 — 파이프라인 「거래중」 카드 / 고객 목록 그래프 / 고객 상세에서 공통 사용.
// 첫 주문을 '시드'로 보고 제외하여 첫 주문 수량 왜곡을 제거한다.
import { workingDaysBetween } from './workingHours.js';

function r2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// agg: { total_qty, order_dates, first_qty, first_date:'YYYY-MM-DD', last_date:'YYYY-MM-DD' }
// mxToday: 'YYYY-MM-DD'
// 반환: orders(주문일수), reorder_velocity(②개/영업일), reorder_cycle(③영업일/회), reorder_qty(③개/회)
export function reorderMetrics(agg, mxToday) {
  const total = Number(agg.total_qty) || 0;
  const orders = Number(agg.order_dates) || 0;
  const q0 = Number(agg.first_qty) || 0;
  const first = agg.first_date || null;
  const last = agg.last_date || null;
  if (!first || orders < 1) {
    return { orders: 0, reorder_velocity: null, reorder_cycle: null, reorder_qty: null };
  }
  const wdToday = workingDaysBetween(first, mxToday);
  const reorder_velocity = wdToday ? r2((total - q0) / wdToday) : null;      // ② 재주문 속도
  let reorder_cycle = null, reorder_qty = null;
  if (orders >= 2 && last) {
    const span = workingDaysBetween(first, last);                            // 첫→마지막 영업일
    reorder_cycle = r2(span / (orders - 1));                                 // ③ 영업일/회
    reorder_qty = r2((total - q0) / (orders - 1));                           // ③ 개/회
  }
  return { orders, reorder_velocity, reorder_cycle, reorder_qty };
}

// datesAsc: 오름차순 '주문일(중복 제거)' 배열 → 주문 간 영업일 간격의 중앙값(④). 3회+에서 의미.
export function medianWorkingGap(datesAsc) {
  if (!datesAsc || datesAsc.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < datesAsc.length; i++) gaps.push(workingDaysBetween(datesAsc[i - 1], datesAsc[i]));
  gaps.sort((a, b) => a - b);
  const m = gaps.length >> 1;
  return gaps.length % 2 ? gaps[m] : r2((gaps[m - 1] + gaps[m]) / 2);
}
