import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
function seed(){
  const db=newDb(); const pub=db.public;
  pub.none(`
    CREATE TABLE products(id INT PRIMARY KEY, code TEXT, name TEXT, stock_qty NUMERIC, avg_cost NUMERIC, deleted_at TIMESTAMPTZ);
    CREATE TABLE customers(id INT PRIMARY KEY, name TEXT);
    CREATE TABLE sales_invoices(id INT PRIMARY KEY, customer_id INT, status TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_invoice_lines(id INT PRIMARY KEY, invoice_id INT, product_id INT, qty NUMERIC);
    CREATE TABLE import_batches(id INT PRIMARY KEY, batch_no TEXT, import_date DATE, currency TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE import_lines(batch_id INT, product_id INT, qty NUMERIC, unit_cost_mxn NUMERIC);
    INSERT INTO products VALUES (1,'CA0032','BRAZO',50,95,NULL);
    INSERT INTO customers VALUES (100,'Cliente A'),(101,'Cliente B');
    INSERT INTO sales_invoices VALUES (500,100,'posted',NULL),(501,101,'posted',NULL),(502,100,'posted',NULL),(503,100,'deleted',NULL);
    INSERT INTO sales_invoice_lines VALUES (1,500,1,10),(2,501,1,5),(3,502,1,7),(4,503,1,99);
    -- 원가: 배치10 100개@90, 배치11 100개@100 → 가중평균 (100*90+100*100)/200 = 95
    INSERT INTO import_batches VALUES (10,'B-10','2026-03-01','USD',NULL),(11,'B-11','2026-04-01','USD',NULL);
    INSERT INTO import_lines VALUES (10,1,100,90),(11,1,100,100);
  `);
  return pub;
}
function sales(pub,id){
  // pg-mem이 COUNT(DISTINCT)+GROUP BY+ORDER BY SUM에서 버그 → 행 단위로 받아 JS 집계(실제 엔드포인트 SQL은 pglast로 검증)
  const rows=pub.many(`SELECT cu.id AS cid, cu.name AS customer_name, sil.qty AS qty, si.id AS sid
    FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id=sil.invoice_id JOIN customers cu ON cu.id=si.customer_id
    WHERE sil.product_id=${id} AND si.status='posted' AND si.deleted_at IS NULL`);
  const by={};
  rows.forEach(r=>{ const k=r.cid; (by[k]=by[k]||{customer_name:r.customer_name, qty:0, invs:new Set()}); by[k].qty+=Number(r.qty); by[k].invs.add(r.sid); });
  return Object.values(by).map(v=>({customer_name:v.customer_name, qty:v.qty, inv_count:v.invs.size}))
    .sort((a,b)=>b.qty-a.qty || a.customer_name.localeCompare(b.customer_name));
}
function cost(pub,id){
  const rows=pub.many(`SELECT b.batch_no, b.currency, il.qty, il.unit_cost_mxn FROM import_lines il JOIN import_batches b ON b.id=il.batch_id AND b.deleted_at IS NULL WHERE il.product_id=${id} ORDER BY b.id`);
  const lines=rows.map(r=>({qty:Number(r.qty), unit_cost_mxn:r.unit_cost_mxn!=null?Number(r.unit_cost_mxn):null}));
  const sumQty=lines.reduce((s,l)=>s+l.qty,0); const sumAmount=lines.reduce((s,l)=>s+l.qty*(l.unit_cost_mxn||0),0);
  return {sumQty, sumAmount, computed:sumQty>0?sumAmount/sumQty:0};
}
test('판매 고객별 수량(삭제 인보이스 제외, 합산·정렬)', ()=>{
  const pub=seed(); const s=sales(pub,1);
  assert.equal(s.length,2);
  assert.deepEqual(s[0],{customer_name:'Cliente A',qty:17,inv_count:2}); // 10+7, 2건
  assert.deepEqual(s[1],{customer_name:'Cliente B',qty:5,inv_count:1});
  assert.equal(s.reduce((a,b)=>a+b.qty,0),22,'삭제건(99) 제외 총 22');
});
test('원가 가중평균 수식', ()=>{
  const pub=seed(); const c=cost(pub,1);
  assert.equal(c.sumQty,200); assert.equal(c.sumAmount,19000);
  assert.equal(c.computed,95,'(100*90+100*100)/200=95');
});
