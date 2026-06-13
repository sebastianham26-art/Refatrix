// 견적 계산 — 순수 함수(단위테스트 우선)
export function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

/**
 * 견적 한 줄 계산.
 *  list_price × (1 - discount/100) = final_price (단가, ex-IVA)
 *  line_subtotal = final_price × qty
 *  line_iva = line_subtotal × iva/100
 *  line_total = line_subtotal + line_iva
 */
export function computeQuoteLine({ listPrice = 0, discountRate = 0, qty = 0, ivaRate = 16 }) {
  const lp = Number(listPrice) || 0;
  const disc = Number(discountRate) || 0;
  const q = Number(qty) || 0;
  const iva = Number(ivaRate) || 0;
  const finalPrice = round2(lp * (1 - disc / 100));
  const lineSubtotal = round2(finalPrice * q);
  const lineIva = round2(lineSubtotal * iva / 100);
  const lineTotal = round2(lineSubtotal + lineIva);
  return { finalPrice, lineSubtotal, lineIva, lineTotal };
}

/** 재고 상태 플래그: 매칭 실패=not_found, 요청>가용=low_stock, 그 외 ok */
export function stockFlag({ matched, qty = 0, availStock = null }) {
  if (!matched) return 'not_found';
  if (availStock != null && Number(qty) > Number(availStock)) return 'low_stock';
  return 'ok';
}

/** 여러 줄 합계 */
export function computeQuoteTotals(lines) {
  let subtotal = 0, iva = 0, total = 0, totalQty = 0;
  for (const l of lines) {
    subtotal = round2(subtotal + (Number(l.lineSubtotal) || 0));
    iva = round2(iva + (Number(l.lineIva) || 0));
    total = round2(total + (Number(l.lineTotal) || 0));
    totalQty = round2(totalQty + (Number(l.qty) || 0));
  }
  return { subtotal, iva, total, totalQty, skuCount: lines.length };
}

/** 견적번호: Q-YYYY-#### (해당 연도 시퀀스) */
export function formatQuoteNo(year, seq) {
  return `Q-${year}-${String(seq).padStart(4, '0')}`;
}
