// =====================================================================
// Refatrix ERP · 수입 원가 정정(재가) 계산 — 순수 함수(단위 테스트 가능)
//   · 배치별 라인 단가(MXN) + 배치별 부대비용 1/n(수량 비율)로 제품별 새 평균원가 계산.
//   · 차액(shift = newAvg − avgBefore)을
//       - 남은 재고분  → 재고 가산(평균원가 상향)
//       - 이미 팔린 분 → 소급 COGS(이번 달 정산차액)
//     으로 분리. shift 기준이라 재적용해도 멱등(두 번 눌러도 중복 기장 없음).
// =====================================================================

export function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// 입력:
//   productLines: { [pid]: [{ batch_id, qty, unit_price_mxn }] }  // 그 제품의 모든 수입 라인(정정 단가, MXN)
//   batchOverhead: { [batch_id]: amount_mxn }                     // 배치별 부대비용 총액(MXN)
//   batchTotalQty: { [batch_id]: total_qty }                      // 배치 총수량(1/n 기준)
//   productState:  { [pid]: { stock_qty, avg_cost, code, name } }
//   soldQty:       { [pid]: qty_sold }
export function computeRecost({ productLines, batchOverhead = {}, batchTotalQty = {}, productState = {}, soldQty = {} }) {
  const perProduct = {};
  let totalStockAdded = 0, totalRetroCogs = 0;
  for (const pid of Object.keys(productLines)) {
    const lines = productLines[pid] || [];
    let tQty = 0, tCost = 0;
    const lineEff = [];
    for (const ln of lines) {
      const ov = Number(batchOverhead[ln.batch_id] || 0);
      const btq = Number(batchTotalQty[ln.batch_id] || 0);
      const perUnitOv = btq > 0 ? ov / btq : 0;
      const eff = r2(Number(ln.unit_price_mxn || 0) + perUnitOv);
      lineEff.push({ batch_id: ln.batch_id, qty: Number(ln.qty), eff, perUnitOv: r2(perUnitOv) });
      tQty += Number(ln.qty);
      tCost += Number(ln.qty) * eff;
    }
    const newAvg = tQty > 0 ? r2(tCost / tQty) : 0;
    const st = productState[pid] || {};
    const avgBefore = r2(Number(st.avg_cost || 0));
    const remainingQty = Number(st.stock_qty || 0);
    const sold = Number(soldQty[pid] || 0);
    const shift = r2(newAvg - avgBefore);
    const stockAddedMxn = r2(remainingQty * shift);
    const retroCogsMxn = r2(sold * shift);
    totalStockAdded += stockAddedMxn;
    totalRetroCogs += retroCogsMxn;
    perProduct[pid] = {
      product_id: Number(pid), code: st.code || null, name: st.name || null,
      totalQty: tQty, avgBefore, newAvg, shift,
      remainingQty, soldQty: sold, stockAddedMxn, retroCogsMxn, lineEff,
    };
  }
  return { perProduct, totalStockAddedMxn: r2(totalStockAdded), totalRetroCogsMxn: r2(totalRetroCogs) };
}
