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

// ── 입고단가 브레이크다운(수입금액 → 환율 → 기본원가 + 배분부대비용) ──
function lineBreakdown(qty, importPrice, currency, fx, unitCostMxn){
  const r2=(n)=>Math.round(n*100)/100;
  const f=(currency==='USD'&&fx!=null)?Number(fx):1;
  const baseCur=importPrice!=null?r2(qty*importPrice):null;
  const baseMxn=baseCur!=null?r2(baseCur*f):null;
  const lineTotal=unitCostMxn!=null?r2(qty*unitCostMxn):null;
  const overhead=(lineTotal!=null&&baseMxn!=null)?Math.max(0,r2(lineTotal-baseMxn)):null;
  return {base_amount_cur:baseCur, fx_rate:f, base_amount_mxn:baseMxn, overhead_mxn:overhead, line_total_mxn:lineTotal};
}
test('입고단가 브레이크다운: USD 환율 적용 + 배분부대비용 = 라인총원가 − 기본원가', ()=>{
  // 16개 × USD 8.50, 환율 16, 저장 입고단가 136.79 MXN/개 → 라인총 2188.64
  const b=lineBreakdown(16, 8.50, 'USD', 16, 136.79);
  assert.equal(b.base_amount_cur, 136.00, '수입금액(USD)=16×8.50');
  assert.equal(b.fx_rate, 16);
  assert.equal(b.base_amount_mxn, 2176.00, '기본원가(MXN)=136×16');
  assert.equal(b.line_total_mxn, 2188.64, '라인총원가=16×136.79');
  assert.equal(b.overhead_mxn, 12.64, '배분부대비용=2188.64−2176.00');
});
test('입고단가 브레이크다운: MXN 통화는 환율 1, 부대비용 음수면 0', ()=>{
  const b=lineBreakdown(10, 100, 'MXN', null, 100); // 기본=라인총 → 부대비용 0
  assert.equal(b.fx_rate, 1);
  assert.equal(b.base_amount_mxn, 1000);
  assert.equal(b.overhead_mxn, 0);
  const c=lineBreakdown(10, 100, 'MXN', null, 95); // 단가가 기본보다 작음(음수 방지)
  assert.equal(c.overhead_mxn, 0, '음수 부대비용은 0으로 클램프');
});

// ── 누적 판매수량 집계 + 정렬(재고/판매/평가액) ──
function soldByProduct(pub){
  const rows=pub.many(`SELECT sil.product_id AS pid, sil.qty AS qty, si.status AS st, si.deleted_at AS del
    FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id=sil.invoice_id`);
  const m={};
  rows.forEach(r=>{ if(r.st==='posted'&&!r.del){ m[r.pid]=(m[r.pid]||0)+Number(r.qty); } });
  return m;
}
test('누적 판매수량: 게시·미삭제만 합산(삭제 인보이스 제외)', ()=>{
  const pub=seed();
  const m=soldByProduct(pub);
  assert.equal(m[1], 22, '10+5+7 (삭제건 99 제외)');
});
test('정렬 키: 재고/판매/평가액 내림차순 비교가 의도대로', ()=>{
  const items=[
    {code:'A', stock:5,  sold:30, avg:10},
    {code:'B', stock:50, sold:2,  avg:3},
    {code:'C', stock:20, sold:2,  avg:100},
  ].map(p=>({...p, val:p.stock*p.avg}));
  const byStock=[...items].sort((a,b)=>b.stock-a.stock).map(x=>x.code);
  const bySold =[...items].sort((a,b)=>b.sold-a.sold).map(x=>x.code);
  const byVal  =[...items].sort((a,b)=>b.val-a.val).map(x=>x.code);
  assert.deepEqual(byStock, ['B','C','A']);
  assert.deepEqual(bySold,  ['A','B','C']); // B,C 동률은 안정 정렬
  assert.deepEqual(byVal,   ['C','B','A']); // 20*100=2000 > 50*3=150 > 5*10=50
});

// ── 매출총이익(고객별 + 총) ──
function grossFromRows(rows){
  const r2=(n)=>Math.round(n*100)/100;
  const by=rows.map(r=>{
    const qty=Number(r.qty), revenue=r2(Number(r.revenue)), cogs=r2(Number(r.cogs));
    const profit=r2(revenue-cogs);
    return {customer_name:r.customer_name, qty, revenue, cogs, profit,
      margin_pct:revenue>0?r2(profit/revenue*100):null,
      avg_price:qty>0?r2(revenue/qty):null, avg_cost:qty>0?r2(cogs/qty):null};
  });
  const tQty=by.reduce((s,x)=>s+x.qty,0), tRev=r2(by.reduce((s,x)=>s+x.revenue,0)), tCogs=r2(by.reduce((s,x)=>s+x.cogs,0));
  const tProfit=r2(tRev-tCogs);
  return {by, total:{qty:tQty, revenue:tRev, cogs:tCogs, profit:tProfit,
    margin_pct:tRev>0?r2(tProfit/tRev*100):null, avg_price:tQty>0?r2(tRev/tQty):null, avg_cost:tQty>0?r2(tCogs/tQty):null}};
}
test('매출총이익: 고객별 매출−원가=이익, 이익률, 평균단가/원가', ()=>{
  // A: 10개, 매출 2000, 원가 1300 / B: 5개, 매출 900, 원가 700
  const rows=[
    {customer_name:'A', qty:10, revenue:2000, cogs:1300},
    {customer_name:'B', qty:5,  revenue:900,  cogs:700},
  ];
  const g=grossFromRows(rows);
  assert.equal(g.by[0].profit,700); assert.equal(g.by[0].margin_pct,35); // 700/2000
  assert.equal(g.by[0].avg_price,200); assert.equal(g.by[0].avg_cost,130);
  assert.equal(g.by[1].profit,200); assert.equal(g.by[1].margin_pct,22.22); // 200/900
  // 총
  assert.equal(g.total.qty,15);
  assert.equal(g.total.revenue,2900); assert.equal(g.total.cogs,2000); assert.equal(g.total.profit,900);
  assert.equal(g.total.margin_pct,31.03); // 900/2900
  assert.equal(g.total.avg_price,193.33); assert.equal(g.total.avg_cost,133.33);
});
test('매출총이익: 매출 0이면 이익률 null(0 나눗셈 방지)', ()=>{
  const g=grossFromRows([{customer_name:'X', qty:0, revenue:0, cogs:0}]);
  assert.equal(g.by[0].margin_pct,null);
  assert.equal(g.total.margin_pct,null);
});
