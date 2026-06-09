import assert from 'node:assert';
import {
  toMxn, costDocTotalMxn, allocateByQty,
  recomputeOpenMonth, applyClosedMonth, isClosedMonth,
} from '../src/importCost.js';

let passed = 0;
function ok(name, cond, got) { assert.ok(cond, name + (got!==undefined?` (got ${got})`:'')); console.log('  ✓', name); passed++; }
function eq(name, a, b) { ok(name + ` = ${b}`, a === b, a); }

console.log('— 통화 환산 / 총액 / 분배 —');
eq('USD 환산 (10 × 17.40)', toMxn(10,'USD',17.40), 174);
eq('MXN 환산(환율 미적용)', toMxn(100,'MXN',17.40), 100);
eq('부대비용 총액 (200USD+100MXN, fx17.40)', costDocTotalMxn([{amount:200,currency:'USD'},{amount:100,currency:'MXN'}],17.40), 3580);

{
  const a = allocateByQty(5220, [{batchId:'B1',qty:100},{batchId:'B2',qty:200}]);
  eq('분배 B1 (100/300 × 5220)', a[0].allocMxn, 1740);
  eq('분배 B2 (잔액)', a[1].allocMxn, 3480);
  eq('합계 일치', a[0].allocMxn + a[1].allocMxn, 5220);
  ok('비율 B1 ≈ 0.3333', Math.abs(a[0].ratio - 0.333333) < 1e-5, a[0].ratio);
}
{
  // 반올림 잔액 처리: 100 ÷ 3
  const a = allocateByQty(100, [{batchId:'x',qty:1},{batchId:'y',qty:1},{batchId:'z',qty:1}]);
  eq('3분할 합계가 정확히 100', a[0].allocMxn + a[1].allocMxn + a[2].allocMxn, 100);
}

console.log('\n— 마감월(차액 분리): 브레이크 패드 예시 —');
{
  // 입고 100개 중 60 팔림/40 재고, 단위당 17.40, 현재 재고 40·평균 420
  const r = applyClosedMonth({ batchQty:100, soldQtyOfBatch:60, perUnit:17.40, curStockQty:40, curAvg:420 });
  eq('재고 남은 수량', r.remainingQty, 40);
  eq('재고 가산액 (40 × 17.40)', r.stockAddedMxn, 696);
  eq('정산차액 비용 (60 × 17.40)', r.varianceExpenseMxn, 1044);
  eq('평균원가 변경 후 ((40×420+696)/40)', r.avgAfter, 437.40);
}

console.log('\n— 미마감(소급 정정): 단일 배치(깨끗한 케이스) —');
{
  // 오일필터: 06-01 입고 200@75(B2), 06-04 판매30, 06-06 판매20.  부대비용 단위당 17.40
  const movements = [
    { id:1, type:'in',  at:'2026-06-01', qty:200, unitCost:75, batchId:'B2' },
    { id:2, type:'out', at:'2026-06-04', qty:30, invoiceId:101 },
    { id:3, type:'out', at:'2026-06-06', qty:20, invoiceId:102 },
  ];
  const r = recomputeOpenMonth({ movements, batchId:'B2', perUnit:17.40 });
  eq('평균원가 변경 전', r.avgBefore, 75);
  eq('평균원가 변경 후 (75+17.40)', r.avgAfter, 92.40);
  eq('소급 COGS 정정 합계 (50 × 17.40)', r.retroCogsTotal, 870);
  eq('정정 대상 판매 건수', r.cogsAdjustments.length, 2);
  eq('판매1 차액 (30 × 17.40)', r.cogsAdjustments[0].diff, 522);
  eq('판매2 차액 (20 × 17.40)', r.cogsAdjustments[1].diff, 348);
  eq('판매1 단가 전→후', r.cogsAdjustments[0].unitAfter, 92.40);
}

console.log('\n— 미마감(소급 정정): 혼합 재고(평균이 부분만 오름) —');
{
  // 06-01 입고 100@70(A, 대상아님), 06-02 입고 100@80(B, 대상 +20/단위), 06-05 판매50
  const movements = [
    { id:1, type:'in',  at:'2026-06-01', qty:100, unitCost:70, batchId:'A' },
    { id:2, type:'in',  at:'2026-06-02', qty:100, unitCost:80, batchId:'B' },
    { id:3, type:'out', at:'2026-06-05', qty:50, invoiceId:201 },
  ];
  const r = recomputeOpenMonth({ movements, batchId:'B', perUnit:20 });
  // 변경 전 평균=(7000+8000)/200=75; 후 평균=(7000+10000)/200=85 (대상이 절반이라 +20→평균은 +10)
  eq('혼합: 평균 변경 전', r.avgBefore, 75);
  eq('혼합: 평균 변경 후', r.avgAfter, 85);
  eq('혼합: 판매 차액 ((85-75)×50)', r.cogsAdjustments[0].diff, 500);
  eq('혼합: 소급 COGS 합계', r.retroCogsTotal, 500);
}

console.log('\n— 마감 판정 —');
ok('2026-05 가 마감목록에 있음', isClosedMonth('2026-05-12', ['2026-05']) === true);
ok('2026-06 은 미마감', isClosedMonth('2026-06-03', ['2026-05']) === false);

console.log(`\nALL ${passed} ASSERTIONS PASSED`);
