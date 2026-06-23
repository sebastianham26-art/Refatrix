import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
function seed(){
  const db=newDb();
  db.public.none(`
    CREATE TABLE products(id INT PRIMARY KEY, code TEXT, name TEXT, stock_qty NUMERIC);
    CREATE TABLE import_batches(id INT PRIMARY KEY, batch_no TEXT, import_date DATE, deleted_at TIMESTAMPTZ);
    CREATE TABLE import_lines(batch_id INT, product_id INT, qty NUMERIC, unit_cost_mxn NUMERIC);
    CREATE TABLE stock_movements(id SERIAL PRIMARY KEY, product_id INT, move_type TEXT, qty NUMERIC, batch_id INT, event_no BIGINT);
    -- 원장 일치: P1 입고10(배치99) + 입고? 판매2 → 재고8 ; P2 입고10(배치99) → 재고10
    INSERT INTO products VALUES (1,'P1','uno',8),(2,'P2','dos',10);
    INSERT INTO import_batches VALUES (99,'FAKE-99','2026-04-01',NULL);
    INSERT INTO import_lines VALUES (99,1,10,5),(99,2,10,5);
    INSERT INTO stock_movements (product_id,move_type,qty,batch_id,event_no) VALUES (1,'in',10,99,1),(2,'in',10,99,1),(1,'out',2,NULL,NULL);
  `);
  return db.public;
}
function ssum(pub,pid){ return Number(pub.many(`SELECT COALESCE(SUM(CASE WHEN move_type='in' THEN qty WHEN move_type='out' THEN -qty ELSE qty END),0) AS s FROM stock_movements WHERE product_id=${pid}`)[0].s); }
function safeDelete(pub,id){
  const mv=pub.many(`SELECT product_id, move_type, qty FROM stock_movements WHERE batch_id=${id}`);
  for(const r of mv){ if(r.move_type!=='in') continue;
    const S=Number(pub.many(`SELECT stock_qty FROM products WHERE id=${r.product_id}`)[0].stock_qty);
    const removed=Math.max(0,Math.min(Math.abs(Number(r.qty)),S));
    if(removed>0) pub.none(`UPDATE products SET stock_qty=${S-removed} WHERE id=${r.product_id}`);
  }
  pub.none(`DELETE FROM stock_movements WHERE batch_id=${id}`);
  pub.none(`UPDATE import_batches SET deleted_at=now() WHERE id=${id}`);
}
function restore(pub,id){
  const lines=pub.many(`SELECT product_id, qty, unit_cost_mxn FROM import_lines WHERE batch_id=${id}`);
  const have=Number(pub.many(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE batch_id=${id}`)[0].n);
  if(!have){ const ev=Number(pub.many(`SELECT COALESCE(MAX(event_no),0)+1 AS ev FROM stock_movements`)[0].ev);
    for(const l of lines) pub.none(`INSERT INTO stock_movements (product_id,move_type,qty,batch_id,event_no) VALUES (${l.product_id},'in',${Math.abs(Number(l.qty))},${id},${ev})`); }
  pub.none(`UPDATE import_batches SET deleted_at=NULL WHERE id=${id}`);
  const pids=[...new Set(lines.map(l=>Number(l.product_id)))]; const out=[];
  for(const pid of pids){ const before=Number(pub.many(`SELECT stock_qty FROM products WHERE id=${pid}`)[0].stock_qty); const s=ssum(pub,pid);
    pub.none(`UPDATE products SET stock_qty=${s} WHERE id=${pid}`); out.push({pid,before,after:s}); }
  return out;
}
test('안전삭제 → 복원: 삭제 전 재고로 정확히 원복(stuck 포함)', ()=>{
  const pub=seed();
  const p1_0=Number(pub.many(`SELECT stock_qty FROM products WHERE id=1`)[0].stock_qty);
  const p2_0=Number(pub.many(`SELECT stock_qty FROM products WHERE id=2`)[0].stock_qty);
  assert.equal(p1_0,8); assert.equal(p2_0,10);
  safeDelete(pub,99);
  assert.equal(Number(pub.many(`SELECT stock_qty FROM products WHERE id=1`)[0].stock_qty),0,'삭제 후 P1=0(stuck)');
  assert.equal(Number(pub.many(`SELECT stock_qty FROM products WHERE id=2`)[0].stock_qty),0,'삭제 후 P2=0');
  restore(pub,99);
  assert.equal(Number(pub.many(`SELECT stock_qty FROM products WHERE id=1`)[0].stock_qty),8,'복원 후 P1=8(원복)');
  assert.equal(Number(pub.many(`SELECT stock_qty FROM products WHERE id=2`)[0].stock_qty),10,'복원 후 P2=10(원복)');
  assert.ok(pub.many(`SELECT deleted_at FROM import_batches WHERE id=99`)[0].deleted_at===null,'배치 부활');
});
