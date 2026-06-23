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

test('pg-mem: SKU 드릴다운 — 판매처(고객)별 매출/원가/이익 집계(posted·미삭제, 매출 내림차순)', () => {
  const db = newDb();
  db.public.none(`
    CREATE TABLE products(id int primary key, code text, scode text, app text, name text, stock_qty numeric, deleted_at timestamptz);
    CREATE TABLE customers(id int primary key, name text);
    CREATE TABLE sales_invoices(id int primary key, status text, deleted_at timestamptz, inv_date date, customer_id int);
    CREATE TABLE sales_invoice_lines(id int primary key, invoice_id int, product_id int, qty numeric, line_amount_mxn numeric, cogs_mxn numeric, applied_unit_cost numeric);
    INSERT INTO products VALUES (1,'A','SyD-1','Tsuru 1992-2017 // Sentra','A',10,null);
    INSERT INTO customers VALUES (10,'Cliente Norte'),(20,'Cliente Sur');
    INSERT INTO sales_invoices VALUES
      (100,'posted',null,'2026-04-10',10),
      (101,'posted',null,'2026-05-10',20),
      (102,'posted',null,'2026-05-15',10),
      (103,'deleted',null,'2026-05-16',20),
      (104,'draft', null,'2026-05-17',10);
    INSERT INTO sales_invoice_lines VALUES
      (1,100,1,5,500,300,60),
      (2,101,1,3,450,330,110),
      (3,102,1,2,200,140,70),
      (4,103,1,99,9999,1,1),
      (5,104,1,99,9999,1,1);
  `);
  const rows = db.public.many(`
    SELECT cu.name AS customer_name,
           SUM(sil.qty) AS qty,
           SUM(sil.line_amount_mxn) AS revenue,
           SUM(COALESCE(sil.cogs_mxn, sil.qty*sil.applied_unit_cost,0)) AS cogs
      FROM sales_invoice_lines sil
      JOIN sales_invoices si ON si.id=sil.invoice_id
      JOIN customers cu ON cu.id=si.customer_id
     WHERE sil.product_id=1 AND si.status='posted' AND si.deleted_at IS NULL
     GROUP BY cu.id, cu.name
     ORDER BY SUM(sil.line_amount_mxn) DESC, cu.name ASC`);
  const r2 = (n) => Math.round(Number(n) * 100) / 100;
  const by = rows.map((c) => {
    const qty = Number(c.qty), rev = r2(c.revenue), cogs = r2(c.cogs), profit = r2(rev - cogs);
    return { customer_name: c.customer_name, qty, revenue: rev, cogs, profit, margin_pct: rev > 0 ? r2(profit / rev * 100) : null };
  });
  // 삭제(103)·미게시(104) 제외. 고객 2명. Norte = 100+102 합산(매출 700), Sur = 450.
  assert.equal(by.length, 2);
  assert.equal(by[0].customer_name, 'Cliente Norte'); // 매출 큰 순
  assert.equal(by[0].qty, 7);
  assert.equal(by[0].revenue, 700);
  assert.equal(by[0].cogs, 440);
  assert.equal(by[0].profit, 260);
  assert.equal(by[1].customer_name, 'Cliente Sur');
  assert.equal(by[1].revenue, 450);
  // 합계
  const tRev = r2(by.reduce((s, x) => s + x.revenue, 0));
  const tProfit = r2(by.reduce((s, x) => s + x.profit, 0));
  assert.equal(tRev, 1150);
  assert.equal(tProfit, 380);
});

test('파레토 상위 20%: 개수 = ceil(판매SKU수 × 0.2), 이익 금액 내림차순', () => {
  const sold = [];
  for (let i = 0; i < 10; i++) sold.push({ id: i + 1, profit: 100 - i * 10 });
  const cut = Math.max(1, Math.ceil(sold.length * 0.20));
  const imp = sold.slice().sort((a, b) => b.profit - a.profit).slice(0, cut);
  assert.equal(cut, 2);
  assert.deepEqual(imp.map((x) => x.id), [1, 2]);
  const share = imp.reduce((s, x) => s + x.profit, 0) / sold.reduce((s, x) => s + x.profit, 0) * 100;
  assert.equal(Math.round(share * 10) / 10, 34.5);
});
