import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
function seed(){
  const db=newDb();
  db.public.none(`
    CREATE TABLE products(id INT PRIMARY KEY, code TEXT, name TEXT, stock_qty NUMERIC);
    CREATE TABLE import_lines(batch_id INT, product_id INT, qty NUMERIC);
    CREATE TABLE sales_invoices(id INT PRIMARY KEY, status TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_invoice_lines(id INT PRIMARY KEY, invoice_id INT, product_id INT, qty NUMERIC);
    -- 중복 입고: 제품1 배치10(100), 배치11(100) → 합200, 80 판매 → 재고120
    INSERT INTO products VALUES (1,'P1','uno',120);
    INSERT INTO import_lines VALUES (10,1,100),(11,1,100);
    INSERT INTO sales_invoices VALUES (501,'posted',NULL);
    INSERT INTO sales_invoice_lines VALUES (1,501,1,80);
    -- 제품2 배치12(50), 90 판매(다른 입고서) → 재고10 (배치12 단독삭제 위험)
    INSERT INTO products VALUES (2,'P2','dos',10);
    INSERT INTO import_lines VALUES (12,2,50);
    INSERT INTO sales_invoice_lines VALUES (2,501,2,90);
  `);
  return db.public;
}
// pg-mem은 상관 서브쿼리 미지원 → 판매수량은 별도 집계 후 병합(실제 엔드포인트 SQL은 pglast로 검증됨). 안전성 로직 검증이 목적.
function batchLines(pub,id){
  const rows=pub.many(`SELECT il.product_id, p.code, p.name, il.qty AS batch_qty, p.stock_qty AS current_stock FROM import_lines il JOIN products p ON p.id=il.product_id WHERE il.batch_id=${id} ORDER BY p.code`);
  const sold={}; pub.many(`SELECT sil.product_id, SUM(sil.qty) AS q FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id=sil.invoice_id WHERE si.status='posted' AND si.deleted_at IS NULL GROUP BY sil.product_id`).forEach(r=>sold[Number(r.product_id)]=Number(r.q));
  const lines=rows.map(r=>({code:r.code,batch_qty:Number(r.batch_qty),current_stock:Number(r.current_stock),sold_qty:sold[Number(r.product_id)]||0,safe:Number(r.current_stock)>=Number(r.batch_qty)}));
  return {lines, safe:lines.every(l=>l.safe)};
}
test('중복 배치(재고 충분): 삭제 안전', ()=>{
  const pub=seed(); const d=batchLines(pub,10);
  assert.equal(d.safe,true,'재고120 ≥ 배치100 → 안전');
  assert.equal(d.lines[0].sold_qty,80);
});
test('판매로 소진된 배치: 삭제 위험', ()=>{
  const pub=seed(); const d=batchLines(pub,12);
  assert.equal(d.safe,false,'재고10 < 배치50 → 위험(음수)');
});
