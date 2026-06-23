import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';

function seed(){
  const db=newDb();
  db.public.none(`
    CREATE TABLE products(id INT PRIMARY KEY, code TEXT, name TEXT, stock_qty NUMERIC);
    CREATE TABLE import_batches(id INT PRIMARY KEY, batch_no TEXT, import_date DATE, status TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE import_lines(batch_id INT, product_id INT, qty NUMERIC);
    CREATE TABLE sales_invoices(id INT PRIMARY KEY, status TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_invoice_lines(id INT PRIMARY KEY, invoice_id INT, product_id INT, qty NUMERIC);
    INSERT INTO products VALUES (1,'P1','uno',50),(2,'P2','dos',100),(3,'P3','tres',30);
    -- 제품1: 배치10·11 동일구성(100) = 데이터중복, 150 판매 → 재고50
    INSERT INTO import_batches VALUES (10,'B-10','2026-02-01','approved',NULL),(11,'B-11','2026-03-01','approved',NULL);
    INSERT INTO import_lines VALUES (10,1,100),(11,1,100);
    -- 제품2: 배치12·13 동일구성(60) = 중복, 20 판매 → 재고100
    INSERT INTO import_batches VALUES (12,'B-12','2026-01-05','approved',NULL),(13,'B-13','2026-04-05','approved',NULL);
    INSERT INTO import_lines VALUES (12,2,60),(13,2,60);
    -- 배치14: 제품3 단독(중복 아님)
    INSERT INTO import_batches VALUES (14,'B-14','2026-05-01','approved',NULL);
    INSERT INTO import_lines VALUES (14,3,30);
    INSERT INTO sales_invoices VALUES (501,'posted',NULL);
    INSERT INTO sales_invoice_lines VALUES (1,501,1,150),(2,501,2,20);
  `);
  return db.public;
}
// 엔드포인트 JS 로직 복제
function analyze(pub){
  const rows=pub.many(`SELECT b.id AS batch_id, b.batch_no, b.import_date, il.product_id, il.qty, p.code, p.name
    FROM import_batches b JOIN import_lines il ON il.batch_id=b.id JOIN products p ON p.id=il.product_id
    WHERE b.deleted_at IS NULL AND b.status='approved' ORDER BY b.id, p.code`);
  const byBatch=new Map();
  for(const r of rows){ const bid=Number(r.batch_id);
    if(!byBatch.has(bid)) byBatch.set(bid,{batch_id:bid,batch_no:r.batch_no,lines:[]});
    byBatch.get(bid).lines.push({product_id:Number(r.product_id),code:r.code,qty:Number(r.qty)}); }
  const sig=b=>b.lines.slice().sort((a,c)=>a.product_id-c.product_id).map(l=>l.product_id+':'+l.qty).join('|');
  const groups=new Map();
  for(const b of byBatch.values()){ const s=sig(b); if(!groups.has(s)) groups.set(s,[]); groups.get(s).push(b); }
  const dup=[...groups.values()].filter(a=>a.length>=2);
  const pidSet=new Set(); dup.forEach(a=>a[0].lines.forEach(l=>pidSet.add(l.product_id)));
  const pids=[...pidSet];
  const stockBy={}; pub.many(`SELECT id, stock_qty FROM products WHERE id IN (${pids.join(',')})`).forEach(r=>stockBy[Number(r.id)]=Number(r.stock_qty));
  const soldBy={}; pub.many(`SELECT sil.product_id, COALESCE(SUM(sil.qty),0) AS sold FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id=sil.invoice_id WHERE si.status='posted' AND si.deleted_at IS NULL GROUP BY sil.product_id`).forEach(r=>soldBy[Number(r.product_id)]=Number(r.sold));
  return dup.map(arr=>{ const keep=arr[0]; const n=arr.length;
    const products=keep.lines.map(l=>{ const phantom=l.qty*(n-1); const cur=stockBy[l.product_id]||0; const sold=soldBy[l.product_id]||0;
      return {code:l.code, phantom_qty:phantom, current_stock:cur, sold_qty:sold, removable_safe:Math.max(0,Math.min(phantom,cur)), stuck_phantom:Math.max(0,phantom-cur)}; });
    return {dup_count:n, products, all_removable:products.reduce((s,p)=>s+p.stuck_phantom,0)===0}; });
}

test('중복 그룹 자동 탐지(2그룹) + 단독배치 제외', ()=>{
  const g=analyze(seed());
  assert.equal(g.length,2,'P1·P2 두 그룹만');
});
test('데이터중복+판매초과: 일부만 안전제거(음수벽)', ()=>{
  const g=analyze(seed());
  const p1=g.find(x=>x.products[0].code==='P1').products[0];
  assert.equal(p1.phantom_qty,100); assert.equal(p1.current_stock,50);
  assert.equal(p1.removable_safe,50,'현재고까지만'); assert.equal(p1.stuck_phantom,50,'나머지 막힘');
});
test('판매 적은 중복: 유령 전부 안전제거', ()=>{
  const g=analyze(seed());
  const grp2=g.find(x=>x.products[0].code==='P2');
  assert.equal(grp2.products[0].removable_safe,60); assert.equal(grp2.all_removable,true);
});
