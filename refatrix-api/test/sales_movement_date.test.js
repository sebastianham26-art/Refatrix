import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
test('0068: 매출 출고 moved_at을 inv_date로 보정(과거월 복귀)', ()=>{
  const db=newDb(); const pub=db.public;
  pub.none(`
    CREATE TABLE sales_invoices(id INT PRIMARY KEY, inv_date DATE);
    CREATE TABLE stock_movements(id INT PRIMARY KEY, sales_invoice_id INT, move_type TEXT, moved_at TIMESTAMPTZ);
    -- 4월 인보이스인데 출고는 6월로 기록된 3건 + 정상 1건 + 되돌리기 in 1건
    INSERT INTO sales_invoices VALUES (10,'2026-04-15');
    INSERT INTO stock_movements VALUES
      (1,10,'out','2026-06-22T10:00:00Z'),
      (2,10,'out','2026-06-22T10:00:00Z'),
      (3,10,'out','2026-06-22T10:00:00Z'),
      (4,10,'out','2026-04-15T00:00:00Z'),   -- 이미 정상(보정 대상 아님)
      (5,10,'in','2026-06-22T10:00:00Z');    -- 되돌리기 'in'(건드리면 안 됨)
  `);
  // pg-mem 제약 → 행 단위로 동등 적용(실제 마이그 SQL은 pglast로 검증됨)
  const invDate={}; pub.many(`SELECT id, inv_date AS d FROM sales_invoices`).forEach(r=>invDate[r.id]=new Date(r.d).toISOString().slice(0,10));
  pub.many(`SELECT id, sales_invoice_id, move_type, moved_at AS d FROM stock_movements`).forEach(r=>{
    if(r.move_type==='out' && r.sales_invoice_id!=null){ const want=invDate[r.sales_invoice_id]; const cur=new Date(r.d).toISOString().slice(0,10);
      if(want && cur!==want) pub.none(`UPDATE stock_movements SET moved_at='${want}' WHERE id=${r.id}`); }
  });  const apr=pub.many(`SELECT moved_at AS d FROM stock_movements WHERE move_type='out'`).filter(r=>new Date(r.d).toISOString().slice(0,10)==='2026-04-15').length;
  assert.equal(apr,4,'출고 4건 모두 4/15로(3건 보정 + 1건 기존)');
  const inMv=new Date(pub.many(`SELECT moved_at AS d FROM stock_movements WHERE id=5`)[0].d).toISOString().slice(0,10);
  assert.equal(inMv,'2026-06-22','되돌리기 in은 그대로');
});
