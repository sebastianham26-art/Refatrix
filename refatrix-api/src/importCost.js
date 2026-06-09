import { round2 } from './permissions.js';

// =====================================================================
// 수입 부대비용 분배 + 소급 재계산 엔진 (순수 함수, DB 비의존)
//
// 핵심 개념
//  - 재고이동 원장(movements)을 시간순으로 "재생(replay)"하며 이동평균을 다시 계산한다.
//  - movements: [{ id, type:'in'|'out', qty, unitCost?, at, invoiceId?, batchId? }]
//      'in'  : 입고. unitCost(그 입고의 단위원가, MXN)로 평균을 갱신.
//      'out' : 판매. 그 시점 평균원가가 적용원가(COGS 단가)가 됨. 평균/수량 갱신.
//  - 부대비용을 특정 입고(batchId)에 단위당 perUnit(MXN)만큼 더하면,
//    그 'in' 이동의 unitCost가 perUnit 올라가고, 이후 평균/판매원가가 바뀐다.
// =====================================================================

// 통화 환산: 기준통화(MXN)면 그대로, 아니면 환율 곱
export function toMxn(amount, currency, fxRate, baseCurrency = 'MXN') {
  const c = currency || 'USD';
  return c === baseCurrency ? Number(amount) : Number(amount) * Number(fxRate);
}

// 부대비용 문서 총액(MXN) — 명세 줄들을 통화별 환산해 합산
export function costDocTotalMxn(lines, fxRate, baseCurrency = 'MXN') {
  return round2(lines.reduce((s, l) => s + toMxn(l.amount, l.currency, fxRate, baseCurrency), 0));
}

// 선택된 입고 건들에 수량 비율로 분배
//  batches: [{ batchId, qty }]  → [{ batchId, qty, ratio, allocMxn }]
export function allocateByQty(totalMxn, batches) {
  const totalQty = batches.reduce((s, b) => s + Number(b.qty), 0);
  let assigned = 0;
  const out = batches.map((b, i) => {
    let alloc;
    if (i === batches.length - 1) {
      alloc = round2(totalMxn - assigned); // 마지막 줄에 잔액 몰아주어 합계 일치(반올림 오차 방지)
    } else {
      alloc = round2(totalQty > 0 ? totalMxn * (Number(b.qty) / totalQty) : 0);
      assigned += alloc;
    }
    return {
      batchId: b.batchId,
      qty: Number(b.qty),
      ratio: totalQty > 0 ? round6(Number(b.qty) / totalQty) : 0,
      allocMxn: alloc,
    };
  });
  return out;
}
function round6(n) { return Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6; }

// ---------------------------------------------------------------------
// 원장 재생: 시간순으로 이동평균을 계산.
//  costDelta: { [batchId]: perUnitMxn }  특정 입고의 단위원가에 더할 부대비용(단위당)
//  반환: { avgCost(최종), stockQty(최종),
//          sales: [{ id, at, qty, unitCostBefore, unitCostAfter }] }
//   - unitCostBefore: costDelta 적용 전(원래) 그 판매의 적용원가
//   - unitCostAfter : costDelta 적용 후 그 판매의 적용원가
// ---------------------------------------------------------------------
function replay(movements, costDelta = {}) {
  const sorted = [...movements].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.id - b.id)));
  let qty = 0, avg = 0;
  const sales = [];
  for (const m of sorted) {
    if (m.type === 'in') {
      const extra = costDelta[m.batchId] || 0;
      const unit = Number(m.unitCost) + extra;
      const newQty = qty + Number(m.qty);
      avg = newQty > 0 ? (qty * avg + Number(m.qty) * unit) / newQty : unit;
      qty = newQty;
    } else if (m.type === 'out') {
      sales.push({ id: m.id, invoiceId: m.invoiceId, at: m.at, qty: Number(m.qty), unitCost: round2(avg) });
      qty = qty - Number(m.qty); // 판매는 평균을 바꾸지 않음
    }
  }
  return { avgCost: round2(avg), stockQty: round3(qty), sales };
}
function round3(n) { return Math.round((Number(n) + Number.EPSILON) * 1e3) / 1e3; }

// ---------------------------------------------------------------------
// 미마감(소급 정정): 원장을 두 번 재생(적용 전/후)해서 차이를 구함.
//  반환: { avgBefore, avgAfter, perUnit,
//          cogsAdjustments: [{ invoiceId, at, qty, unitBefore, unitAfter, diff }],
//          retroCogsTotal }
// ---------------------------------------------------------------------
export function recomputeOpenMonth({ movements, batchId, perUnit }) {
  const before = replay(movements, {});
  const after = replay(movements, { [batchId]: perUnit });
  const beforeById = new Map(before.sales.map((s) => [s.id, s]));
  const cogsAdjustments = [];
  let retro = 0;
  for (const s of after.sales) {
    const b = beforeById.get(s.id);
    const ub = b ? b.unitCost : 0;
    const diff = round2((s.unitCost - ub) * s.qty);
    if (diff !== 0) {
      cogsAdjustments.push({ invoiceId: s.invoiceId, at: s.at, qty: s.qty, unitBefore: round2(ub), unitAfter: round2(s.unitCost), diff });
      retro += diff;
    }
  }
  return {
    avgBefore: before.avgCost, avgAfter: after.avgCost, perUnit: round2(perUnit),
    cogsAdjustments, retroCogsTotal: round2(retro), stockAfter: after.stockQty,
  };
}

// ---------------------------------------------------------------------
// 마감월(차액 분리): 과거는 고정.
//  입고 수량을 '이미 팔린 분'과 '재고 남은 분'으로 나눠:
//   - 남은 분: 현재 재고 평균원가에 가산(stockAdded)
//   - 팔린 분: 정산차액 비용(varianceExpense)
//  입력: batchQty, soldQtyOfBatch(그 입고분 중 이미 팔린 수량),
//        perUnit, curStockQty, curAvg
//  반환: { soldQty, remainingQty, perUnit, stockAddedMxn, varianceExpenseMxn,
//          avgBefore, avgAfter }
// ---------------------------------------------------------------------
export function applyClosedMonth({ batchQty, soldQtyOfBatch, perUnit, curStockQty, curAvg }) {
  const sold = Math.min(Number(soldQtyOfBatch), Number(batchQty));
  const remaining = round3(Number(batchQty) - sold);
  const stockAdded = round2(remaining * perUnit);          // 재고 가산액(남은 분)
  const variance = round2(sold * perUnit);                 // 정산차액(팔린 분)
  // 재고 가산은 현재 재고 전체에 분산되어 평균을 올린다.
  const avgBefore = round2(Number(curAvg));
  const newAvg = Number(curStockQty) > 0
    ? round2((Number(curStockQty) * avgBefore + stockAdded) / Number(curStockQty))
    : avgBefore;
  return {
    soldQty: round3(sold), remainingQty: remaining, perUnit: round2(perUnit),
    stockAddedMxn: stockAdded, varianceExpenseMxn: variance,
    avgBefore, avgAfter: newAvg,
  };
}

// ---------------------------------------------------------------------
// 마감 여부 판정: import_date(YYYY-MM-DD)의 월이 마감목록에 있으면 true
// ---------------------------------------------------------------------
export function isClosedMonth(dateStr, closedPeriods = []) {
  const ym = String(dateStr).slice(0, 7); // 'YYYY-MM'
  return closedPeriods.includes(ym);
}
