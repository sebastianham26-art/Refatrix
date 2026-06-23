import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
function seed(){
  const db=newDb();
  db.public.none(`
    CREATE TABLE products(id INT PRIMARY KEY, code TEXT, name TEXT, stock_qty NUMERIC);
    CREATE TABLE import_batches(id INT PRIMARY KEY, batch_no TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE stock_movements(id INT PRIMARY KEY, batch_id INT, product_id INT, move_type TEXT, qty NUMERIC);
    -- 가짜 배치 99: P1 배치10개(현재고8 → 2 팔림), P2 배치10개(현재고10 → 0 팔림)
    INSERT INTO products VALUES (1,'P1','uno',8),(2,'P2','dos',10);
    INSERT INTO import_batches VALUES (99,'FAKE-99',NULL);
    INSERT INTO stock_movements VALUES (1,99,1,'in',10),(2,99,2,'in',10);
  `);
  return db.public;
}
// 엔드포인트 로직 복제(트랜잭션 본문)
function safeDelete(pub, batchId){
  const mv=pub.many(`SELECT sm.product_id, sm.move_type, sm.qty, p.code, p.name FROM stock_movements sm JOIN products p ON p.id=sm.product_id WHERE sm.batch_id=${batchId} ORDER BY p.code`);
  const lines=[];
  for(const r of mv){
    if(r.move_type!=='in') continue;
    const S=Number(pub.many(`SELECT stock_qty FROM products WHERE id=${r.product_id}`)[0].stock_qty);
    const Q=Math.abs(Number(r.qty));
    const removed=Math.max(0,Math.min(Q,S));
    if(removed>0) pub.none(`UPDATE products SET stock_qty=${S-removed} WHERE id=${r.product_id}`);
    lines.push({code:r.code,batch_qty:Q,removed,remaining:Q-removed});
  }
  pub.none(`DELETE FROM stock_movements WHERE batch_id=${batchId}`);
  pub.none(`UPDATE import_batches SET deleted_at=now() WHERE id=${batchId}`);
  return {removed_total:lines.reduce((s,l)=>s+l.removed,0), remaining_total:lines.reduce((s,l)=>s+l.remaining,0), stuck_lines:lines.filter(l=>l.remaining>0)};
}
test('안전삭제: 재고 0에서 멈춤(음수 없음) + 잔여 보고', ()=>{
  const pub=seed(); const r=safeDelete(pub,99);
  const p1=Number(pub.many(`SELECT stock_qty FROM products WHERE id=1`)[0].stock_qty);
  const p2=Number(pub.many(`SELECT stock_qty FROM products WHERE id=2`)[0].stock_qty);
  assert.equal(p1,0,'P1 재고8 - 제거8 = 0(음수 아님)');
  assert.equal(p2,0,'P2 재고10 - 제거10 = 0');
  assert.equal(r.removed_total,18,'8+10 제거');
  assert.equal(r.remaining_total,2,'P1 잔여2(이미 팔린 만큼)');
  assert.equal(r.stuck_lines.length,1);
  assert.equal(r.stuck_lines[0].code,'P1');
});
test('안전삭제 후 배치 soft-delete', ()=>{
  const pub=seed(); safeDelete(pub,99);
  const del=pub.many(`SELECT deleted_at FROM import_batches WHERE id=99`)[0].deleted_at;
  assert.ok(del,'deleted_at 설정됨');
  assert.equal(pub.many(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE batch_id=99`)[0].n,0,'이동 삭제됨');
});
