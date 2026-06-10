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

// 날짜를 YYYY-MM-DD 문자열로 정규화 (Date 객체·ISO 문자열 모두 처리)
export function ymd(v) {
  if (v instanceof Date) {
    const y = v.getUTCFullYear(), m = String(v.getUTCMonth() + 1).padStart(2, '0'), d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

// 예상 입금일 = inv_date + creditDays (YYYY-MM-DD 문자열/Date 입력 모두 허용)
export function dueDate(invDate, creditDays) {
  const d = new Date(ymd(invDate) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(creditDays || 0));
  return d.toISOString().slice(0, 10);
}

// 외상일이 기준(고객 마스터)과 다른지 판정
export function isCreditException(appliedDays, customerDefaultDays) {
  return Number(appliedDays) !== Number(customerDefaultDays);
}

// =====================================================================
// 매출 수정/삭제 되돌림·재적용 계산 (순수 함수)
//  매출 1건의 효과: 재고 -qty(out), COGS=+(qty×appliedUnitCost), 매출(소계)·AR(총액) 발생.
//  - 삭제: 원본 효과를 취소(재고 +복원, COGS·매출·AR 취소).
//  - 수정: 원본 취소 + 새 내용 적용의 합산(순효과).
//  마감월 규칙:
//   · 미마감: 과거(COGS·매출)를 소급 취소/정정. 재고는 원가 스냅샷으로 복원.
//   · 마감:   과거(COGS·매출)는 고정. 재고는 원가 스냅샷으로 복원하되,
//            그로 인한 손익 차액(취소되었어야 할 COGS-매출의 순액)을 현재 시점 "정산차액"으로 인식.
// =====================================================================

// 원본 라인들의 효과 합계 (재고/원가/매출 기준)
//  lines: [{ productId, qty, appliedUnitCost, lineAmountMxn }]
function sumEffect(lines) {
  let cogs = 0, sales = 0;
  const perProduct = {};
  for (const l of lines) {
    const c = round2(Number(l.appliedUnitCost) * Number(l.qty));
    cogs = round2(cogs + c);
    sales = round2(sales + Number(l.lineAmountMxn));
    perProduct[l.productId] = round2((perProduct[l.productId] || 0) + Number(l.qty));
  }
  return { cogs, sales, perProduct };
}

// 삭제 되돌림 계산
//  origLines: 원본 라인, closedMonth: 그 인보이스 달이 마감됐는지
//  반환: { stockRestore:{productId:qty}, cogsReversal, salesReversal, varianceMxn, mode }
export function computeDeleteReversal({ origLines, closedMonth }) {
  const e = sumEffect(origLines);
  if (!closedMonth) {
    // 미마감: 과거 소급 취소 — COGS·매출 모두 원복, 재고 복원
    return { mode: 'retro', stockRestore: e.perProduct, cogsReversal: e.cogs, salesReversal: e.sales, varianceMxn: 0 };
  }
  // 마감: 과거 고정 — 재고만 현재 시점 복원, 손익 순액(매출-COGS=매출총이익)을 정산차액으로
  // 삭제했어야 할 매출총이익만큼이 과거에 남아있으므로, 그 반대 부호를 현재 정산차액으로 인식.
  const variance = round2(e.sales - e.cogs); // 마감으로 되돌리지 못한 매출총이익
  return { mode: 'closed', stockRestore: e.perProduct, cogsReversal: 0, salesReversal: 0, varianceMxn: variance };
}

// 수정 순효과 계산 (원본 취소 + 새 내용 적용)
//  origLines/newLines: [{ productId, qty, appliedUnitCost, lineAmountMxn }]
//   - newLines.appliedUnitCost 는 "현재 평균원가"(수정 적용 시점 스냅샷)
//  반환: { stockDelta:{productId: +복원-신규}, cogsDelta, salesDelta, mode, varianceMxn }
export function computeEditNetEffect({ origLines, newLines, closedMonth }) {
  const o = sumEffect(origLines);
  const n = sumEffect(newLines);
  // 재고 순변화: 원본은 되돌려 +, 신규는 빠져 -
  const stockDelta = {};
  for (const [pid, q] of Object.entries(o.perProduct)) stockDelta[pid] = round2((stockDelta[pid] || 0) + q);
  for (const [pid, q] of Object.entries(n.perProduct)) stockDelta[pid] = round2((stockDelta[pid] || 0) - q);

  if (!closedMonth) {
    return {
      mode: 'retro', stockDelta,
      cogsDelta: round2(n.cogs - o.cogs),   // 매출원가 순증감(소급 반영)
      salesDelta: round2(n.sales - o.sales),
      varianceMxn: 0,
    };
  }
  // 마감: 과거(원본) 고정. 신규분만 현재 시점에 반영, 원본 취소분의 손익은 정산차액으로.
  return {
    mode: 'closed', stockDelta,
    cogsDelta: round2(n.cogs),  // 신규 COGS는 현재 반영
    salesDelta: round2(n.sales),
    varianceMxn: round2(o.sales - o.cogs), // 원본 매출총이익(되돌리지 못한 과거분)을 정산차액으로
  };
}
