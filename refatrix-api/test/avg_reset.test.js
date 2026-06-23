import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { flatAvgCost } from '../src/flatAvgCost.js';
import { flatAvgCostEnabled, round2 } from '../src/permissions.js';

function seed(){
  const db=newDb(); const pub=db.public;
  pub.none(`
    CREATE TABLE products(id INT PRIMARY KEY, code TEXT, name TEXT, stock_qty NUMERIC, avg_cost NUMERIC, deleted_at TIMESTAMPTZ);
    CREATE TABLE import_batches(id INT PRIMARY KEY, deleted_at TIMESTAMPTZ, exclude_from_cost BOOLEAN);
    CREATE TABLE import_lines(batch_id INT, product_id INT, qty NUMERIC, unit_cost_mxn NUMERIC);
    INSERT INTO products VALUES (1,'CL0477','TERM',10,59.89,NULL);
    -- 살아있는 배치 두 개: 30@139.74, 10@100  → 단순가중평균 = (30*139.74+10*100)/40 = (4192.2+1000)/40 = 129.805 → 129.81
    INSERT INTO import_batches VALUES (10,NULL,false),(11,NULL,false),(12,NULL,false),(13,NULL,true);
    INSERT INTO import_lines VALUES (10,1,30,139.74),(11,1,10,100);
    -- 삭제된 배치(무시): 1000@1
    INSERT INTO import_lines VALUES (12,1,1000,1);  -- batch 12 will be soft-deleted below
    UPDATE import_batches SET deleted_at=now() WHERE id=12;
    -- 원가제외 배치(무시): 500@2
    INSERT INTO import_lines VALUES (13,1,500,2);
  `);
  return pub;
}
// pg-mem 친화: $1=ANY(...) 대신 product_id 직접 비교로 동등 검증
function flatSql(pub){
  return pub.many(`SELECT il.product_id AS pid, SUM(il.qty) AS qty, SUM(il.qty*il.unit_cost_mxn) AS amount
    FROM import_lines il JOIN import_batches b ON b.id=il.batch_id
    WHERE b.deleted_at IS NULL AND b.exclude_from_cost IS NOT TRUE
    GROUP BY il.product_id`);
}

test('단순가중평균: 삭제·원가제외 배치는 무시하고 살아있는 배치만 평균', ()=>{
  const pub=seed(); const rows=flatSql(pub);
  assert.equal(rows.length,1);
  const q=Number(rows[0].qty), amt=Number(rows[0].amount);
  assert.equal(q,40,'30+10 (삭제 1000·제외 500 제외)');
  assert.equal(round2(amt),5192.2,'30*139.74+10*100');
  assert.equal(round2(amt/q),129.81,'(4192.2+1000)/40');
});

test('flatAvgCost(): qty>0 가드 + round2 나눗셈', async ()=>{
  // 가짜 클라이언트: 살아있는 배치 합계를 흉내
  const fake={ query: async()=>({rows:[
    {pid:1, qty:'40', amount:'5192.20'},
    {pid:2, qty:'0',  amount:'0'},       // 수량0 → 키 없음
  ]})};
  const m=await flatAvgCost(fake,[1,2]);
  assert.equal(m[1],129.81);
  assert.equal(2 in m, false, '수량 0이면 평균 미정(키 없음)');
});

test('flatAvgCost(): 빈 입력은 빈 객체', async ()=>{
  const fake={ query: async()=>({rows:[]}) };
  assert.deepEqual(await flatAvgCost(fake,[]), {});
});

test('avg-reset 행 계산: new_avg·diff·changed·재고평가 전후', ()=>{
  const r={ stock_qty:10, avg_cost:59.89, batch_qty:40, batch_amount:5192.20 };
  const newAvg=round2(r.batch_amount/r.batch_qty);
  assert.equal(newAvg,129.81);
  assert.equal(round2(newAvg-r.avg_cost),69.92,'diff');
  assert.equal(round2(r.stock_qty*r.avg_cost),598.90,'before=재고평가 10*59.89');
  assert.equal(round2(r.stock_qty*newAvg),1298.10,'after=10*129.81');
  assert.equal(Math.abs(newAvg-r.avg_cost)>0.005, true,'changed');
});

test('go-forward 선택: 평준화 켜짐이면 flat, 없으면 moving', ()=>{
  const newState={1:{stock_qty:40, avg_cost:115.0}};  // 이동평균 결과(예시)
  const flatAvg={1:129.81};                            // 단순평균
  const pick=(pid)=> (flatAvg[pid]!=null)?flatAvg[pid]:newState[pid].avg_cost;
  assert.equal(pick(1),129.81,'flat 우선');
  const pick2=(pid)=> (({}[pid])!=null)?({}[pid]):newState[pid].avg_cost; // flat 비어있음
  assert.equal(pick2(1),115.0,'flat 없으면 moving');
});

test('flatAvgCostEnabled: 기본 ON, MOVING_AVG_COST=1 이면 OFF', ()=>{
  const save=process.env.MOVING_AVG_COST;
  delete process.env.MOVING_AVG_COST; assert.equal(flatAvgCostEnabled(),true,'기본 단순평균');
  process.env.MOVING_AVG_COST='1'; assert.equal(flatAvgCostEnabled(),false,'이동평균 강제');
  process.env.MOVING_AVG_COST='0'; assert.equal(flatAvgCostEnabled(),true,'단순평균 강제');
  if(save===undefined) delete process.env.MOVING_AVG_COST; else process.env.MOVING_AVG_COST=save;
});
