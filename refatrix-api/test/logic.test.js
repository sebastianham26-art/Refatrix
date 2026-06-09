import assert from 'node:assert';
import { computeImportCosting } from '../src/cost.js';
import { minimizeProduct, pageAllowed, fieldVisible } from '../src/permissions.js';

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓', name); passed++; }

// --- 이동평균 원가 ---
// 기존 100개 @9, 신규 100개 @ (10*fx=10) + 부대비용 200*fx=200 / 200개 = 1/unit → 단위원가 11
// fx=1 가정. overhead 200, totalQty(이 배치)=100 → perUnit=2 → unitCost=10+2=12
// 새 평균 = (100*9 + 100*12)/200 = 10.5
{
  const r = computeImportCosting({
    lines: [{ product_id: 'A', qty: 100, import_price: 10 }],
    overheads: [{ amount: 200 }],
    fxRate: 1,
    productState: { A: { stock_qty: 100, avg_cost: 9 } },
  });
  ok('단위원가 = 12 (수입단가10 + 부대비용 200/100=2)', r.computedLines[0].unit_cost_mxn === 12);
  ok('새 평균원가 = 10.5', r.newState.A.avg_cost === 10.5);
  ok('재고 = 200', r.newState.A.stock_qty === 200);
}
// 재고 0에서 첫 입고: 평균 = 입고 단위원가
{
  const r = computeImportCosting({
    lines: [{ product_id: 'B', qty: 50, import_price: 4 }],
    overheads: [{ amount: 50 }], fxRate: 2, productState: {},
  });
  // import 4*2=8 + overhead (50*2=100)/50=2 → 10
  ok('첫 입고 단위원가 = 10 (환율2 반영)', r.computedLines[0].unit_cost_mxn === 10);
  ok('첫 입고 평균 = 단위원가 10', r.newState.B.avg_cost === 10);
}
// 부대비용 1/n: 두 SKU 수량 다름 → 같은 단위당 부대비용
{
  const r = computeImportCosting({
    lines: [
      { product_id: 'X', qty: 10, import_price: 100 },
      { product_id: 'Y', qty: 30, import_price: 5 },
    ],
    overheads: [{ amount: 80 }], fxRate: 1, productState: {},
  });
  // perUnit = 80/40 = 2 → X:100+2=102, Y:5+2=7
  ok('1/n 균등배분: X 단위원가 102', r.computedLines[0].unit_cost_mxn === 102);
  ok('1/n 균등배분: Y 단위원가 7', r.computedLines[1].unit_cost_mxn === 7);
}

// --- 항목별 통화 (입고일 환율 하나로 환산) ---
{
  // 수입단가 10 USD, 부대비용 200 USD + 100 MXN, fx 17.40, 수량 100, 재고 0
  const r = computeImportCosting({
    lines: [{ product_id: 'C', qty: 100, import_price: 10, currency: 'USD' }],
    overheads: [{ amount: 200, currency: 'USD' }, { amount: 100, currency: 'MXN' }],
    fxRate: 17.40, baseCurrency: 'MXN', batchCurrency: 'USD', productState: {},
  });
  // 단가 174, 부대비용(3480+100=3580)/100=35.8 → 209.8
  ok('혼합통화: 단위원가 209.80 (USD단가+USD/MXN부대비용)', r.computedLines[0].unit_cost_mxn === 209.8);
}
{
  // MXN 단가는 환율 미적용
  const r = computeImportCosting({
    lines: [{ product_id: 'D', qty: 10, import_price: 100, currency: 'MXN' }],
    overheads: [{ amount: 50, currency: 'MXN' }],
    fxRate: 17.40, baseCurrency: 'MXN', batchCurrency: 'MXN', productState: {},
  });
  // 단가 100, 부대비용 50/10=5 → 105 (환율 곱하지 않음)
  ok('MXN 단가는 환율 미적용: 단위원가 105', r.computedLines[0].unit_cost_mxn === 105);
}

// --- 권한/데이터 최소 전송 ---
const product = { id: 1, code: 'CTR-1', name: 'parte', list_price: 200, discount: 10, stock_qty: 5, avg_cost: 120 };
{
  // 영업: 판매가 보임, 원가/마진 숨김
  const sales = { role: 'sales', fields: new Set(['sale_price']) };
  const m = minimizeProduct(sales, product);
  ok('영업: 판매가(list_price) 보임', m.list_price === 200);
  ok('영업: 원가(avg_cost) 제거', !('avg_cost' in m));
  ok('영업: 마진 없음', !('unit_margin' in m));
}
{
  // 디렉터: 전부 보임 + 마진 계산
  const dir = { role: 'director', fields: new Set() };
  const m = minimizeProduct(dir, product);
  ok('디렉터: 원가 보임', m.avg_cost === 120);
  ok('디렉터: 마진 = 80', m.unit_margin === 80);
  ok('디렉터: 마진율 = 40', m.margin_rate === 40);
}
{
  // 운영지원(ops): 원가 보임, 마진 숨김
  const ops = { role: 'ops', fields: new Set(['unit_cost', 'sale_price']) };
  const m = minimizeProduct(ops, product);
  ok('운영지원: 원가 보임', m.avg_cost === 120);
  ok('운영지원: 마진 숨김', !('unit_margin' in m));
}

// --- 메뉴 접근/기기요구 ---
{
  const sales = { role: 'sales', pages: { record: 'registered_only', sales: 'anywhere' } };
  ok('등록기기 아님 + registered_only → 차단', pageAllowed(sales, 'record', false) === false);
  ok('등록기기 + registered_only → 허용', pageAllowed(sales, 'record', true) === true);
  ok('anywhere → 어디서나 허용', pageAllowed(sales, 'sales', false) === true);
  ok('권한행 없음 → 차단', pageAllowed(sales, 'approve', true) === false);
  ok('settings 는 비디렉터 차단', pageAllowed(sales, 'settings', true) === false);
  ok('home 은 항상 허용', pageAllowed(sales, 'home', false) === true);
  const dir = { role: 'director', pages: {} };
  ok('디렉터는 settings 허용', pageAllowed(dir, 'settings', false) === true);
}

console.log(`\nALL ${passed} ASSERTIONS PASSED`);
