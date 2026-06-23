import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
function seed(){
  const db=newDb(); const pub=db.public;
  pub.none(`
    CREATE TABLE import_batches(id INT PRIMARY KEY, batch_no TEXT, import_date DATE, currency TEXT, deleted_at TIMESTAMPTZ, exclude_from_cost BOOLEAN NOT NULL DEFAULT false);
    CREATE TABLE import_lines(batch_id INT, product_id INT, qty NUMERIC, unit_cost_mxn NUMERIC);
    -- 정상 배치10 100@90, 정상 배치11 100@100, 무효 배치99(TEST) 1000@500(제외)
    INSERT INTO import_batches VALUES (10,'B-10','2026-03-01','USD',NULL,false),(11,'B-11','2026-04-01','USD',NULL,false),(99,'TEST-1781790351851','2026-05-01','USD',NULL,true);
    INSERT INTO import_lines VALUES (10,1,100,90),(11,1,100,100),(99,1,1000,500);
  `);
  return pub;
}
function costLines(pub,pid,withExclude){
  // 드릴다운/가중평균 쿼리: 제외 배치 빼고 라인 모음
  const cond = withExclude ? '' : ' AND b.exclude_from_cost IS NOT TRUE';
  const rows=pub.many(`SELECT il.qty, il.unit_cost_mxn FROM import_lines il JOIN import_batches b ON b.id=il.batch_id AND b.deleted_at IS NULL${cond} WHERE il.product_id=${pid}`);
  const lines=rows.map(r=>({qty:Number(r.qty),u:Number(r.unit_cost_mxn)}));
  const sq=lines.reduce((s,l)=>s+l.qty,0), sa=lines.reduce((s,l)=>s+l.qty*l.u,0);
  return {sq, sa, avg:sq>0?sa/sq:0, n:lines.length};
}
test('제외 배치는 평균원가 가중평균에서 빠짐', ()=>{
  const pub=seed();
  const excluded=costLines(pub,1,false); // 제외 적용
  assert.equal(excluded.n,2,'정상 배치 2개만');
  assert.equal(excluded.sq,200); assert.equal(excluded.avg,95,'(100*90+100*100)/200=95');
});
test('제외 안 하면 무효 배치가 원가를 왜곡', ()=>{
  const pub=seed();
  const all=costLines(pub,1,true); // 제외 미적용(비교용)
  assert.equal(all.n,3);
  assert.notEqual(Math.round(all.avg),95,'무효 1000@500 포함 시 평균 크게 왜곡');
});
test('토글: exclude_from_cost 갱신', ()=>{
  const pub=seed();
  pub.none(`UPDATE import_batches SET exclude_from_cost=true WHERE id=11`);
  const c=costLines(pub,1,false);
  assert.equal(c.n,1,'10번만 남음'); assert.equal(c.avg,90);
});
