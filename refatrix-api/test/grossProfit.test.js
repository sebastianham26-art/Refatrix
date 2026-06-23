// 매출총이익(SKU별) — 구간 판정 순수함수 + 집계 쿼리(pg-mem) 검증.
// 실행: node --test test/*.test.js
import test from 'node:test';
import assert from 'node:assert';
import { newDb } from 'pg-mem';
import { GP_TIERS, tierOf, summarizeTiers } from '../src/routes/grossProfitRoutes.js';

test('GP_TIERS: 4단계가 빈틈/중복 없이 연속(−∞..+∞)을 덮는다', () => {
  assert.equal(GP_TIERS.length, 4);
  // 구간 경계가 인접(t4.max=t3.min=0, t3.max=t2.min=10, t2.max=t1.min=21)
  assert.equal(GP_TIERS[3].max, GP_TIERS[2].min); // 0
  assert.equal(GP_TIERS[2].max, GP_TIERS[1].min); // 10
  assert.equal(GP_TIERS[1].max, GP_TIERS[0].min); // 21
});

test('tierOf: 경계값(21·10·0 포함, 음수=손실, null=판매없음)', () => {
  assert.equal(tierOf(35), 't1');
  assert.equal(tierOf(21), 't1');
  assert.equal(tierOf(20.99), 't2');
  assert.equal(tierOf(10), 't2');
  assert.equal(tierOf(9.99), 't3');
  assert.equal(tierOf(0), 't3');
  assert.equal(tierOf(-0.01), 't4');
  assert.equal(tierOf(null), null);
});

test('summarizeTiers: 카드 합 + 판매없음 = 전체', () => {
  const items = [
    { margin_pct: 40 }, { margin_pct: 22 },     // t1 x2
    { margin_pct: 12 },                          // t2
    { margin_pct: 3 }, { margin_pct: 0 },        // t3 x2
    { margin_pct: -5 },                          // t4
    { margin_pct: null }, { margin_pct: null },  // 판매없음 x2
  ];
  const s = summarizeTiers(items);
  assert.deepEqual(s, { t1: 2, t2: 1, t3: 2, t4: 1, no_sales: 2 });
  assert.equal(s.t1 + s.t2 + s.t3 + s.t4 + s.no_sales, items.length);
});

test('pg-mem: SKU별 매출/원가 집계가 posted·미삭제 인보이스만 모은다', () => {
  const db = newDb();
  db.public.none(`
    CREATE TABLE products(id int primary key, code text, scode text, app text, name text, stock_qty numeric, deleted_at timestamptz);
    CREATE TABLE sales_invoices(id int primary key, status text, deleted_at timestamptz, inv_date date);
    CREATE TABLE sales_invoice_lines(id int primary key, invoice_id int, product_id int, qty numeric, line_amount_mxn numeric, cogs_mxn numeric, applied_unit_cost numeric);
    INSERT INTO products VALUES (1,'A',null,null,'A',10,null),(2,'B',null,null,'B',5,null),(3,'C',null,null,'재고만',7,null),(4,'D',null,null,'삭제',0,now());
    INSERT INTO sales_invoices VALUES (100,'posted',null,'2026-04-10'),(101,'posted',null,'2026-05-10'),(102,'deleted',null,'2026-05-11'),(103,'draft',null,'2026-05-12');
    INSERT INTO sales_invoice_lines VALUES (1,100,1,10,1000,700,70),(2,101,2,10,1000,950,95),(3,102,1,99,9999,1,1),(4,103,2,99,9999,1,1);
  `);
  const rows = db.public.many(`
    SELECT p.id, p.code,
           COALESCE(s.qty,0) AS sold_qty, COALESCE(s.revenue,0) AS revenue, COALESCE(s.cogs,0) AS cogs
      FROM products p
      LEFT JOIN (
        SELECT sil.product_id, SUM(sil.qty) AS qty, SUM(sil.line_amount_mxn) AS revenue,
               SUM(COALESCE(sil.cogs_mxn, sil.qty*sil.applied_unit_cost,0)) AS cogs
          FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id=sil.invoice_id
         WHERE si.status='posted' AND si.deleted_at IS NULL
         GROUP BY sil.product_id
      ) s ON s.product_id=p.id
     WHERE p.deleted_at IS NULL ORDER BY p.code`);
  assert.equal(rows.length, 3); // 삭제제품 제외
  const r2 = (n) => Math.round(Number(n) * 100) / 100;
  const items = rows.map((p) => {
    const sold = Number(p.sold_qty), rev = r2(p.revenue), cogs = r2(p.cogs), profit = r2(rev - cogs);
    return { code: p.code, profit, margin_pct: (sold > 0 && rev > 0) ? r2(profit / rev * 100) : null };
  });
  const A = items.find((x) => x.code === 'A'), B = items.find((x) => x.code === 'B'), C = items.find((x) => x.code === 'C');
  assert.equal(A.profit, 300); assert.equal(A.margin_pct, 30); // t1
  assert.equal(B.margin_pct, 5);                                // t3
  assert.equal(C.margin_pct, null);                             // 판매없음
  assert.deepEqual(summarizeTiers(items), { t1: 1, t2: 0, t3: 1, t4: 0, no_sales: 1 });
});
