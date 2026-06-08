import { round2 } from './permissions.js';

// 수입 입고 원가 계산(이동평균).
// 입력:
//   lines: [{ product_id, qty, import_price }]
//   overheads: [{ amount }]   (모두 batch 통화 기준)
//   fxRate: 입고일 환율 (원통화 -> MXN)
//   productState: { [product_id]: { stock_qty, avg_cost } }  현재 재고/평균(MXN)
// 규칙:
//   부대비용 합계(MXN) ÷ 선적 총수량 = 단위당 부대비용 (1/n 균등배분)
//   입고 단위원가 = import_price*fx + 단위당 부대비용
//   새 평균 = (기존수량*기존평균 + 입고수량*입고단위원가)/(기존수량+입고수량)
// 반환:
//   computedLines: [{ product_id, qty, unit_cost_mxn, alloc_overhead, avg_cost_after }]
//   newState: { [product_id]: { stock_qty, avg_cost } }   갱신 후
export function computeImportCosting({ lines, overheads = [], fxRate, productState = {} }) {
  const fx = Number(fxRate) || 0;
  const totalQty = lines.reduce((s, l) => s + Number(l.qty), 0);
  const overheadMxn = overheads.reduce((s, o) => s + Number(o.amount), 0) * fx;
  const overheadPerUnit = totalQty > 0 ? overheadMxn / totalQty : 0;

  // 갱신 상태 복사 (배치 내 같은 SKU 여러 줄도 순차 반영)
  const state = {};
  for (const [k, v] of Object.entries(productState)) {
    state[k] = { stock_qty: Number(v.stock_qty) || 0, avg_cost: Number(v.avg_cost) || 0 };
  }

  const computedLines = lines.map((l) => {
    const pid = l.product_id;
    const cur = state[pid] || { stock_qty: 0, avg_cost: 0 };
    const qty = Number(l.qty);
    const unitCost = round2(Number(l.import_price) * fx + overheadPerUnit);
    const newQty = cur.stock_qty + qty;
    const newAvg = newQty > 0
      ? round2((cur.stock_qty * cur.avg_cost + qty * unitCost) / newQty)
      : unitCost;
    state[pid] = { stock_qty: newQty, avg_cost: newAvg };
    return {
      product_id: pid,
      qty,
      unit_cost_mxn: unitCost,
      alloc_overhead: round2(overheadPerUnit * qty),
      avg_cost_after: newAvg,
    };
  });

  return { computedLines, newState: state };
}
