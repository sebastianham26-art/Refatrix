import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { computeRecost, r2 } from '../src/recost.js';

// ---------- 순수 계산 ----------
test('computeRecost: 단가 + 부대비용 1/n → 새 평균원가, 재고가산/소급COGS 분리', () => {
  // 제품 P1: 배치 B1에 100개. 단가 10, 배치 부대비용 200 / 총수량 100 = 2/개 → eff 12
  // 재고 60 남음, 40 팔림(avgBefore 0)
  const res = computeRecost({
    productLines: { 1: [{ batch_id: 10, qty: 100, unit_price_mxn: 10 }] },
    batchOverhead: { 10: 200 },
    batchTotalQty: { 10: 100 },
    productState: { 1: { stock_qty: 60, avg_cost: 0, code: 'P1', name: 'uno' } },
    soldQty: { 1: 40 },
  });
  const p = res.perProduct[1];
  assert.equal(p.newAvg, 12, '새 평균원가 = 10 + 2');
  assert.equal(p.stockAddedMxn, 720, '재고가산 = 60 × 12');
  assert.equal(p.retroCogsMxn, 480, '소급COGS = 40 × 12');
  assert.equal(res.totalRetroCogsMxn, 480);
  assert.equal(res.totalStockAddedMxn, 720);
});

test('computeRecost: 여러 배치 가중평균', () => {
  // P2: B1 50개@8, B2 50개@12 → 평균 10
  const res = computeRecost({
    productLines: { 2: [{ batch_id: 1, qty: 50, unit_price_mxn: 8 }, { batch_id: 2, qty: 50, unit_price_mxn: 12 }] },
    batchOverhead: {}, batchTotalQty: { 1: 50, 2: 50 },
    productState: { 2: { stock_qty: 100, avg_cost: 0 } }, soldQty: { 2: 0 },
  });
  assert.equal(res.perProduct[2].newAvg, 10, '가중평균 10');
});

test('computeRecost: 멱등 — 이미 정정된 원가면 차액 0', () => {
  const res = computeRecost({
    productLines: { 3: [{ batch_id: 1, qty: 100, unit_price_mxn: 12 }] },
    batchOverhead: {}, batchTotalQty: { 1: 100 },
    productState: { 3: { stock_qty: 60, avg_cost: 12 } }, soldQty: { 3: 40 }, // avgBefore already 12
  });
  const p = res.perProduct[3];
  assert.equal(p.shift, 0); assert.equal(p.stockAddedMxn, 0); assert.equal(p.retroCogsMxn, 0);
});

// ---------- 적용(apply) pg-mem 통합: 평균원가·라인·재고이동·정산차액 ----------
function seed() {
  const db = newDb();
  db.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
  db.public.none(`
    CREATE TABLE products (id INT PRIMARY KEY, code TEXT, name TEXT, stock_qty NUMERIC, avg_cost NUMERIC, updated_by INT);
    CREATE TABLE import_batches (id INT PRIMARY KEY, batch_no TEXT, fx_rate NUMERIC, deleted_at TIMESTAMPTZ);
    CREATE TABLE import_lines (batch_id INT, product_id INT, qty NUMERIC, unit_cost_mxn NUMERIC, avg_cost_after NUMERIC, alloc_overhead NUMERIC);
    CREATE TABLE stock_movements (id INT PRIMARY KEY, batch_id INT, product_id INT, move_type TEXT, qty NUMERIC, unit_cost_mxn NUMERIC);
    CREATE TABLE sales_invoices (id INT PRIMARY KEY, status TEXT, deleted_at TIMESTAMPTZ, inv_date DATE);
    CREATE TABLE sales_invoice_lines (id INT PRIMARY KEY, invoice_id INT, product_id INT, qty NUMERIC, applied_unit_cost NUMERIC, cogs_mxn NUMERIC);
    CREATE TABLE cogs_adjustments (id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, doc_id INT, sales_invoice_id INT, product_id INT, sale_date DATE, qty NUMERIC, unit_cost_before NUMERIC, unit_cost_after NUMERIC, diff_mxn NUMERIC, kind TEXT, source TEXT, created_at TIMESTAMPTZ DEFAULT now());
  `);
  db.public.none(`
    INSERT INTO products (id,code,name,stock_qty,avg_cost) VALUES (1,'P1','uno',60,0);
    INSERT INTO import_batches (id,batch_no,fx_rate) VALUES (10,'B-10',1);
    INSERT INTO import_lines (batch_id,product_id,qty,unit_cost_mxn) VALUES (10,1,100,0);
    INSERT INTO stock_movements (id,batch_id,product_id,move_type,qty,unit_cost_mxn) VALUES (1,10,1,'in',100,0);
    INSERT INTO sales_invoices (id,status,inv_date) VALUES (501,'posted','2026-04-10');
    INSERT INTO sales_invoice_lines (id,invoice_id,product_id,qty,applied_unit_cost,cogs_mxn) VALUES (1,501,1,40,0,0);
  `);
  return db.public;
}

test('apply 시뮬: 평균원가/라인/재고이동 갱신 + 팔린 40개 소급 COGS 정산차액', () => {
  const pub = seed();
  // computeRecost 입력 구성(실제 prepareRecost 흐름과 동일)
  const res = computeRecost({
    productLines: { 1: [{ batch_id: 10, qty: 100, unit_price_mxn: 10 }] },
    batchOverhead: { 10: 200 }, batchTotalQty: { 10: 100 },
    productState: { 1: { stock_qty: 60, avg_cost: 0 } }, soldQty: { 1: 40 },
  });
  const p = res.perProduct[1];
  // 적용
  pub.none(`UPDATE products SET avg_cost=${p.newAvg} WHERE id=1`);
  for (const le of p.lineEff) {
    pub.none(`UPDATE import_lines SET unit_cost_mxn=${le.eff}, avg_cost_after=${p.newAvg}, alloc_overhead=${r2(le.perUnitOv*le.qty)} WHERE batch_id=${le.batch_id} AND product_id=1`);
    pub.none(`UPDATE stock_movements SET unit_cost_mxn=${le.eff} WHERE batch_id=${le.batch_id} AND product_id=1 AND move_type='in'`);
  }
  if (Math.abs(p.shift) > 0.005 && p.soldQty > 0) {
    const sls = pub.many(`SELECT sil.invoice_id, sil.qty, sil.applied_unit_cost, si.inv_date FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id=sil.invoice_id WHERE sil.product_id=1 AND si.status='posted' AND si.deleted_at IS NULL`);
    for (const s of sls) {
      const diff = r2(Number(s.qty)*p.shift);
      pub.none(`INSERT INTO cogs_adjustments (doc_id, sales_invoice_id, product_id, sale_date, qty, unit_cost_before, unit_cost_after, diff_mxn, kind, source) VALUES (NULL,${s.invoice_id},1,'${s.inv_date instanceof Date ? s.inv_date.toISOString().slice(0,10) : s.inv_date}',${s.qty},${p.avgBefore},${p.newAvg},${diff},'variance','import_recost')`);
    }
  }
  // 검증
  assert.equal(Number(pub.many(`SELECT avg_cost FROM products WHERE id=1`)[0].avg_cost), 12, '평균원가 12');
  assert.equal(Number(pub.many(`SELECT unit_cost_mxn FROM import_lines WHERE batch_id=10 AND product_id=1`)[0].unit_cost_mxn), 12, '라인 원가 12');
  assert.equal(Number(pub.many(`SELECT unit_cost_mxn FROM stock_movements WHERE id=1`)[0].unit_cost_mxn), 12, '재고이동 원가 12');
  const adj = pub.many(`SELECT diff_mxn, kind, source FROM cogs_adjustments WHERE source='import_recost'`);
  assert.equal(adj.length, 1, '정산차액 1건');
  assert.equal(Number(adj[0].diff_mxn), 480, '소급 COGS 480 (40×12)');
  assert.equal(adj[0].kind, 'variance');
  // 재고금액 = 60 × 12 = 720
  const sv = Number(pub.many(`SELECT stock_qty*avg_cost AS v FROM products WHERE id=1`)[0].v);
  assert.equal(sv, 720, '재고금액 720');
});
