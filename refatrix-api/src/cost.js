import { round2 } from './permissions.js';

// 수입 입고 원가 계산(이동평균) — 항목별 통화 기준, 입고일 환율 하나로 환산.
// 입력:
//   lines: [{ product_id, qty, import_price, currency }]   // currency 없으면 batchCurrency 사용
//   overheads: [{ amount, currency }]                       // currency 없으면 batchCurrency 사용
//   fxRate: 입고일 환율 (외화 1단위 -> MXN). MXN 항목에는 적용하지 않음(환율 1).
//   baseCurrency: MXN 등 환산 기준 통화 (기본 'MXN')
//   batchCurrency: 항목에 통화가 없을 때의 기본 통화 (기본 'USD')
//   productState: { [product_id]: { stock_qty, avg_cost } }  현재 재고/평균(MXN)
// 규칙:
//   각 금액을 통화에 따라 MXN 환산(기준통화면 ×1, 외화면 ×fxRate).
//   부대비용 합계(MXN) ÷ 선적 총수량 = 단위당 부대비용 (1/n 균등배분).
//   입고 단위원가 = 수입단가(MXN) + 단위당 부대비용.
//   새 평균 = (기존수량*기존평균 + 입고수량*입고단위원가)/(기존수량+입고수량).
export function computeImportCosting({ lines, overheads = [], fxRate, productState = {}, baseCurrency = 'MXN', batchCurrency = 'USD' }) {
  const fx = Number(fxRate) || 0;
  const toMxn = (amount, cur) => {
    const c = (cur || batchCurrency || baseCurrency);
    return c === baseCurrency ? Number(amount) : Number(amount) * fx; // 기준통화면 환율 미적용
  };

  const totalQty = lines.reduce((s, l) => s + Number(l.qty), 0);
  const overheadMxn = overheads.reduce((s, o) => s + toMxn(o.amount, o.currency), 0);
  const overheadPerUnit = totalQty > 0 ? overheadMxn / totalQty : 0;

  const state = {};
  for (const [k, v] of Object.entries(productState)) {
    state[k] = { stock_qty: Number(v.stock_qty) || 0, avg_cost: Number(v.avg_cost) || 0 };
  }

  const computedLines = lines.map((l) => {
    const pid = l.product_id;
    const cur = state[pid] || { stock_qty: 0, avg_cost: 0 };
    const qty = Number(l.qty);
    const priceMxn = toMxn(l.import_price, l.currency);
    const unitCost = round2(priceMxn + overheadPerUnit);
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
