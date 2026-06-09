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
