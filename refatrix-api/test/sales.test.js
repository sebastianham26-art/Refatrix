import assert from 'node:assert';
import { computeLine, computeInvoiceTotals, dueDate, isCreditException } from '../src/sales.js';

let passed = 0;
function ok(name, cond, got) { assert.ok(cond, name + (got!==undefined?` (got ${got})`:'')); console.log('  ✓', name); passed++; }
function eq(name, a, b) { ok(name + ` = ${b}`, a === b, a); }

console.log('— 라인 계산(할인·원가) —');
{
  // 정가 850, 할인 10%, 수량 5, 평균원가 420
  const l = computeLine({ qty:5, listPrice:850, discountRate:10, cost:420 });
  eq('판매단가 (850×0.9)', l.unitPrice, 765);
  eq('라인금액 (765×5)', l.lineAmountMxn, 3825);
  eq('적용원가 스냅샷', l.appliedUnitCost, 420);
  eq('COGS (420×5)', l.cogsMxn, 2100);
}
{
  // 할인 0%
  const l = computeLine({ qty:10, listPrice:180, discountRate:0, cost:75 });
  eq('할인0 판매단가', l.unitPrice, 180);
  eq('할인0 라인금액', l.lineAmountMxn, 1800);
  eq('할인0 COGS', l.cogsMxn, 750);
}

console.log('\n— 인보이스 합계(IVA·총액·마진) —');
{
  const lines = [
    computeLine({ qty:5, listPrice:850, discountRate:10, cost:420 }), // 3825 / cogs 2100
    computeLine({ qty:10, listPrice:180, discountRate:0, cost:75 }),   // 1800 / cogs 750
  ];
  const t = computeInvoiceTotals(lines, 16);
  eq('소계 (3825+1800)', t.subtotalMxn, 5625);
  eq('IVA 16% (5625×0.16)', t.ivaMxn, 900);
  eq('총액 (5625+900)', t.totalMxn, 6525);
  eq('COGS 합계 (2100+750)', t.cogsMxn, 2850);
  eq('매출총이익 (5625-2850)', t.grossMarginMxn, 2775);
}

console.log('\n— 예상 입금일 / 예외 판정 —');
eq('입금일 (06-09 + 30일)', dueDate('2026-06-09', 30), '2026-07-09');
eq('입금일 (06-09 + 0일)', dueDate('2026-06-09', 0), '2026-06-09');
eq('월말 넘김 (06-20 + 15일)', dueDate('2026-06-20', 15), '2026-07-05');
ok('외상일 다르면 예외', isCreditException(45, 30) === true);
ok('외상일 같으면 정상', isCreditException(30, 30) === false);

console.log(`\nALL ${passed} ASSERTIONS PASSED`);

import { computeDeleteReversal, computeEditNetEffect } from '../src/sales.js';

console.log('\n— 삭제 되돌림 (미마감) —');
{
  const origLines = [
    { productId: 1, qty: 5,  appliedUnitCost: 420, lineAmountMxn: 3825 }, // cogs 2100
    { productId: 2, qty: 10, appliedUnitCost: 75,  lineAmountMxn: 1800 }, // cogs 750
  ];
  const r = computeDeleteReversal({ origLines, closedMonth: false });
  eq('모드', r.mode, 'retro');
  eq('재고복원 p1', r.stockRestore[1], 5);
  eq('재고복원 p2', r.stockRestore[2], 10);
  eq('COGS 취소 (2100+750)', r.cogsReversal, 2850);
  eq('매출 취소 (3825+1800)', r.salesReversal, 5625);
  eq('정산차액 (미마감=0)', r.varianceMxn, 0);
}

console.log('\n— 삭제 되돌림 (마감: 과거 고정 + 정산차액) —');
{
  const origLines = [
    { productId: 1, qty: 5, appliedUnitCost: 420, lineAmountMxn: 3825 }, // cogs 2100, 매출총이익 1725
  ];
  const r = computeDeleteReversal({ origLines, closedMonth: true });
  eq('모드', r.mode, 'closed');
  eq('재고복원 p1 (현재 시점)', r.stockRestore[1], 5);
  eq('COGS 취소 안함(과거 고정)', r.cogsReversal, 0);
  eq('매출 취소 안함(과거 고정)', r.salesReversal, 0);
  eq('정산차액 = 매출총이익 (3825-2100)', r.varianceMxn, 1725);
}

console.log('\n— 수정 순효과 (미마감) —');
{
  // 원본: p1 5개(원가420, 매출3825). 수정후: p1 8개(현재원가 437.40, 정가850·할인10%→단가765·매출6120)
  const origLines = [{ productId: 1, qty: 5, appliedUnitCost: 420, lineAmountMxn: 3825 }];
  const newLines  = [{ productId: 1, qty: 8, appliedUnitCost: 437.40, lineAmountMxn: 6120 }];
  const r = computeEditNetEffect({ origLines, newLines, closedMonth: false });
  eq('모드', r.mode, 'retro');
  eq('재고 순변화 p1 (+5 -8)', r.stockDelta[1], -3);
  eq('COGS 순증감 (8×437.40 - 5×420)', r.cogsDelta, 1399.2);  // 3499.2 - 2100
  eq('매출 순증감 (6120 - 3825)', r.salesDelta, 2295);
  eq('정산차액 (미마감=0)', r.varianceMxn, 0);
}

console.log('\n— 수정 순효과 (마감: 원본 고정, 신규만 현재 반영) —');
{
  const origLines = [{ productId: 1, qty: 5, appliedUnitCost: 420, lineAmountMxn: 3825 }];   // 과거 고정
  const newLines  = [{ productId: 1, qty: 8, appliedUnitCost: 437.40, lineAmountMxn: 6120 }]; // 현재 반영
  const r = computeEditNetEffect({ origLines, newLines, closedMonth: true });
  eq('모드', r.mode, 'closed');
  eq('재고 순변화 p1 (+5 -8)', r.stockDelta[1], -3);
  eq('신규 COGS 현재 반영 (8×437.40)', r.cogsDelta, 3499.2);
  eq('신규 매출 현재 반영', r.salesDelta, 6120);
  eq('정산차액 = 원본 매출총이익 (3825-2100)', r.varianceMxn, 1725);
}

console.log(`\nALL ${passed} ASSERTIONS PASSED (with reversal/edit)`);
