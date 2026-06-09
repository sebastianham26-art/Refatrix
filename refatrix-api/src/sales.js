import { round2 } from './permissions.js';

// =====================================================================
// 매출 인보이스 금액 계산 (순수 함수)
//  - 라인: 판매단가 = 정가 × (1 - 할인율/100), 라인금액 = 판매단가 × 수량
//  - 합계: 소계 = Σ 라인금액, IVA = 소계 × 세율/100, 총액 = 소계 + IVA
//  - 원가: applied_unit_cost(그 시점 평균원가) × 수량 = COGS (라인별)
//  - 예상 입금일 = 인보이스일 + 외상일(credit_days)
// =====================================================================

// 한 라인 계산. cost(평균원가)는 주어지면 COGS도 계산.
export function computeLine({ qty, listPrice, discountRate = 0, cost = null }) {
  const unitPrice = round2(Number(listPrice) * (1 - Number(discountRate) / 100));
  const lineAmount = round2(unitPrice * Number(qty));
  const out = {
    qty: Number(qty),
    listPrice: round2(Number(listPrice)),
    discountRate: Number(discountRate),
    unitPrice,
    lineAmountMxn: lineAmount,
  };
  if (cost != null) {
    out.appliedUnitCost = round2(Number(cost));
    out.cogsMxn = round2(Number(cost) * Number(qty));
  }
  return out;
}

// 인보이스 합계. lines: computeLine 결과 배열. ivaRate %(기본 16)
export function computeInvoiceTotals(lines, ivaRate = 16) {
  const subtotal = round2(lines.reduce((s, l) => s + Number(l.lineAmountMxn), 0));
  const iva = round2(subtotal * Number(ivaRate) / 100);
  const total = round2(subtotal + iva);
  const cogs = round2(lines.reduce((s, l) => s + (l.cogsMxn != null ? Number(l.cogsMxn) : 0), 0));
  const grossMargin = round2(subtotal - cogs); // 매출총이익(ex-IVA 소계 - COGS)
  return { subtotalMxn: subtotal, ivaMxn: iva, totalMxn: total, cogsMxn: cogs, grossMarginMxn: grossMargin };
}

// 예상 입금일 = inv_date + creditDays (YYYY-MM-DD 문자열 입출력)
export function dueDate(invDate, creditDays) {
  const d = new Date(invDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(creditDays || 0));
  return d.toISOString().slice(0, 10);
}

// 외상일이 기준(고객 마스터)과 다른지 판정
export function isCreditException(appliedDays, customerDefaultDays) {
  return Number(appliedDays) !== Number(customerDefaultDays);
}
