import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { validateReceiptDataUrl } from '../src/ar.js';

// ---------- 순수: 입금증 data URL 검증 ----------
test('validateReceiptDataUrl: PNG 허용', () => {
  const r = validateReceiptDataUrl('data:image/png;base64,iVBORw0KGgo=');
  assert.equal(r.ok, true); assert.equal(r.mime, 'image/png');
});
test('validateReceiptDataUrl: PDF 허용', () => {
  const r = validateReceiptDataUrl('data:application/pdf;base64,JVBERi0=');
  assert.equal(r.ok, true); assert.equal(r.mime, 'application/pdf');
});
test('validateReceiptDataUrl: 허용 안 되는 mime 거부', () => {
  const r = validateReceiptDataUrl('data:text/html;base64,PGh0bWw+');
  assert.equal(r.ok, false); assert.equal(r.error, 'bad_mime');
});
test('validateReceiptDataUrl: data URL 아니면 거부', () => {
  assert.equal(validateReceiptDataUrl('hello').ok, false);
  assert.equal(validateReceiptDataUrl('').ok, false);
  assert.equal(validateReceiptDataUrl(null).ok, false);
});
test('validateReceiptDataUrl: 크기 초과 거부', () => {
  const big = 'A'.repeat(20 * 1024 * 1024); // ~15MB decoded
  const r = validateReceiptDataUrl('data:image/jpeg;base64,' + big, 8 * 1024 * 1024);
  assert.equal(r.ok, false); assert.equal(r.error, 'too_large');
});

// ---------- 통합: 실제 쿼리(pg-mem) ----------
function seedDb() {
  const db = newDb();
  db.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
  db.public.none(`
    CREATE TABLE customers (id INT PRIMARY KEY, code TEXT, name TEXT, rfc TEXT, phone TEXT,
      team_id INT, owner_id INT, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_teams (id INT PRIMARY KEY, name TEXT);
    CREATE TABLE users (id INT PRIMARY KEY, name TEXT);
    CREATE TABLE accounts (id INT PRIMARY KEY, name TEXT, currency TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_invoices (id INT PRIMARY KEY, customer_id INT, sat_no TEXT,
      inv_date DATE, due_date DATE, total_mxn NUMERIC, status TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_payments (id INT PRIMARY KEY, customer_id INT, pay_date DATE,
      account_id INT, amount NUMERIC, advance_amount NUMERIC DEFAULT 0, memo TEXT, created_by INT);
    CREATE TABLE sales_payment_allocations (id INT PRIMARY KEY, payment_id INT, invoice_id INT, amount NUMERIC);
    CREATE TABLE sales_payment_docs (payment_id INT PRIMARY KEY, file_name TEXT, mime_type TEXT,
      file_data TEXT NOT NULL, uploaded_by INT, uploaded_at TIMESTAMPTZ DEFAULT now());
  `);
  db.public.none(`
    INSERT INTO customers (id,code,name,rfc,phone,team_id,owner_id) VALUES
      (1,'CL001','Cliente Uno','RFC1','555',10,100),
      (2,'CL002','Cliente Dos','RFC2','556',11,101);
    INSERT INTO sales_teams (id,name) VALUES (10,'01_Monterrey'),(11,'02_Merida');
    INSERT INTO users (id,name) VALUES (100,'Oscar'),(101,'Maria');
    INSERT INTO accounts (id,name,currency) VALUES (1,'BBVA MXN','MXN');
    -- 인보이스 A: 1000, 600 반제(2건) → 미수 400 (오픈)
    INSERT INTO sales_invoices (id,customer_id,sat_no,inv_date,due_date,total_mxn,status) VALUES
      (501,1,'AAA-501','2026-05-01','2026-05-31',1000,'posted'),
      (502,1,'BBB-502','2026-05-10','2026-06-10', 500,'posted'),  -- 완납 예정
      (503,2,'CCC-503','2026-06-01','2026-07-01', 800,'posted');  -- 미반제
    INSERT INTO sales_payments (id,customer_id,pay_date,account_id,amount,memo,created_by) VALUES
      (9001,1,'2026-05-15',1,400,'1차',100),
      (9002,1,'2026-05-20',1,200,'2차',100),
      (9003,1,'2026-06-01',1,500,'완납분',100);
    INSERT INTO sales_payment_allocations (id,payment_id,invoice_id,amount) VALUES
      (1,9001,501,400),
      (2,9002,501,200),
      (3,9003,502,500);
    INSERT INTO sales_payment_docs (payment_id,file_name,mime_type,file_data,uploaded_by) VALUES
      (9001,'recibo.png','image/png','data:image/png;base64,iVBORw0KGgo=',100);
  `);
  return db.public;
}

test('드릴다운: 인보이스 501 수금내역 2건 + 입금증 1건, 미수 400', () => {
  const pub = seedDb();
  const inv = pub.many(`
    SELECT s.id, s.sat_no, s.total_mxn, COALESCE(pa.paid,0) AS paid
      FROM sales_invoices s
      LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
     WHERE s.id=501 AND s.deleted_at IS NULL`)[0];
  const total = Number(inv.total_mxn), paid = Number(inv.paid), outstanding = total - paid;
  assert.equal(paid, 600);
  assert.equal(outstanding, 400);
  assert.equal(outstanding <= 0.005, false); // 미완납

  const rows = pub.many(`
    SELECT al.id AS alloc_id, al.amount, p.id AS payment_id, p.memo, a.name AS account_name,
           (d.payment_id IS NOT NULL) AS has_receipt
      FROM sales_payment_allocations al
      JOIN sales_payments p ON p.id=al.payment_id
      LEFT JOIN accounts a ON a.id=p.account_id
      LEFT JOIN sales_payment_docs d ON d.payment_id=p.id
     WHERE al.invoice_id=501
     ORDER BY p.pay_date, al.id`);
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[0].amount), 400);
  assert.equal(rows[0].has_receipt, true);   // 9001엔 입금증
  assert.equal(rows[1].has_receipt, false);  // 9002엔 없음
  assert.equal(rows[0].account_name, 'BBVA MXN');
});

test('완납 판정: 인보이스 502는 paid_full=true', () => {
  const pub = seedDb();
  const inv = pub.many(`
    SELECT s.total_mxn, COALESCE(pa.paid,0) AS paid
      FROM sales_invoices s
      LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
     WHERE s.id=502`)[0];
  const outstanding = Number(inv.total_mxn) - Number(inv.paid);
  assert.equal(outstanding, 0);
  assert.equal(outstanding <= 0.005, true);
});

test('오픈리스트: 미수>0.01 인보이스만 (501,503) — 502는 완납이라 제외', () => {
  const pub = seedDb();
  const rows = pub.many(`
    SELECT s.id, (s.total_mxn - COALESCE(pa.paid,0)) AS outstanding
      FROM sales_invoices s
      LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
     WHERE s.deleted_at IS NULL AND s.status='posted'
       AND (s.total_mxn - COALESCE(pa.paid,0)) > 0.01
     ORDER BY s.id`);
  assert.deepEqual(rows.map(r => Number(r.id)), [501, 503]);
});

test('검색: SAT 일부 일치(BBB)로 완납 인보이스도 찾음', () => {
  const pub = seedDb();
  const rows = pub.many(`
    SELECT s.id, s.sat_no, (s.total_mxn - COALESCE(pa.paid,0)) AS outstanding
      FROM sales_invoices s
      JOIN customers c ON c.id=s.customer_id AND c.deleted_at IS NULL
      LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM sales_payment_allocations GROUP BY invoice_id) pa ON pa.invoice_id=s.id
     WHERE s.deleted_at IS NULL AND s.status='posted'
       AND (s.sat_no ILIKE '%BBB%' OR c.name ILIKE '%BBB%' OR c.code ILIKE '%BBB%')
     ORDER BY s.inv_date DESC, s.id DESC`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sat_no, 'BBB-502');
  assert.equal(Number(rows[0].outstanding) <= 0.005, true); // 완납 인보이스도 검색됨
});

test('검색: 고객명 일부(Dos)로 미반제 인보이스 찾음', () => {
  const pub = seedDb();
  const rows = pub.many(`
    SELECT s.id FROM sales_invoices s
      JOIN customers c ON c.id=s.customer_id AND c.deleted_at IS NULL
     WHERE s.status='posted' AND (s.sat_no ILIKE '%Dos%' OR c.name ILIKE '%Dos%' OR c.code ILIKE '%Dos%')`);
  assert.deepEqual(rows.map(r => Number(r.id)), [503]);
});

test('입금증 UPSERT: 기존 입금건에 부착/교체', () => {
  const pub = seedDb();
  // 9002엔 입금증이 없음 → 부착
  pub.none(`INSERT INTO sales_payment_docs (payment_id,file_name,mime_type,file_data,uploaded_by)
            VALUES (9002,'nuevo.pdf','application/pdf','data:application/pdf;base64,JVBERi0=',100)`);
  let r = pub.many(`SELECT file_name FROM sales_payment_docs WHERE payment_id=9002`)[0];
  assert.equal(r.file_name, 'nuevo.pdf');
});

// ---------- 통합: 수금(반제) 취소 되돌리기 (pg-mem) ----------
import { newDb as newDb2 } from 'pg-mem';
function seedCancel() {
  const db = newDb2();
  db.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
  db.public.none(`
    CREATE TABLE users (id INT PRIMARY KEY, name TEXT);
    CREATE TABLE accounts (id INT PRIMARY KEY, name TEXT);
    CREATE TABLE sales_invoices (id INT PRIMARY KEY, total_mxn NUMERIC, status TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE transactions (id INT PRIMARY KEY, amount NUMERIC, deleted_at TIMESTAMPTZ, updated_by INT);
    CREATE TABLE sales_payments (id INT PRIMARY KEY, customer_id INT, amount NUMERIC, advance_amount NUMERIC DEFAULT 0, advance_txn_id INT);
    CREATE TABLE sales_payment_allocations (id INT PRIMARY KEY, payment_id INT, invoice_id INT, amount NUMERIC, txn_id INT);
    CREATE TABLE sales_payment_docs (payment_id INT PRIMARY KEY, file_data TEXT NOT NULL);
  `);
  db.public.none(`
    INSERT INTO users (id,name) VALUES (100,'Dir');
    INSERT INTO accounts (id,name) VALUES (1,'BBVA');
    INSERT INTO sales_invoices (id,total_mxn,status) VALUES (501,1000,'posted');
    INSERT INTO transactions (id,amount) VALUES (7001,400);   -- 반제 입금 거래
    INSERT INTO sales_payments (id,customer_id,amount,advance_amount) VALUES (9001,1,400,0);
    INSERT INTO sales_payment_allocations (id,payment_id,invoice_id,amount,txn_id) VALUES (1,9001,501,400,7001);
    INSERT INTO sales_payment_docs (payment_id,file_data) VALUES (9001,'data:image/png;base64,iVB');
  `);
  return db.public;
}

test('수금 취소: 미수 복구 + 거래 소프트취소 + 배분/증빙/헤더 삭제', () => {
  const pub = seedCancel();
  const userId = 100, pid = 9001;
  // 취소 전: 미수 = 1000 - 400 = 600
  let paid = Number(pub.many(`SELECT COALESCE(SUM(amount),0) AS s FROM sales_payment_allocations WHERE invoice_id=501`)[0].s);
  assert.equal(1000 - paid, 600);
  // 취소 실행(엔드포인트 로직 재현)
  const allocs = pub.many(`SELECT id, invoice_id, amount, txn_id FROM sales_payment_allocations WHERE payment_id=${pid}`);
  for (const a of allocs) if (a.txn_id) pub.none(`UPDATE transactions SET deleted_at=now(), updated_by=${userId} WHERE id=${a.txn_id} AND deleted_at IS NULL`);
  pub.none(`DELETE FROM sales_payment_allocations WHERE payment_id=${pid}`);
  pub.none(`DELETE FROM sales_payment_docs WHERE payment_id=${pid}`);
  pub.none(`DELETE FROM sales_payments WHERE id=${pid}`);
  // 취소 후: 미수 = 1000 (전액 복구)
  paid = Number(pub.many(`SELECT COALESCE(SUM(amount),0) AS s FROM sales_payment_allocations WHERE invoice_id=501`)[0].s);
  assert.equal(1000 - paid, 1000, '미수 전액 복구');
  // 거래 소프트취소(삭제 아님, 이력 보존)
  const txn = pub.many(`SELECT deleted_at FROM transactions WHERE id=7001`)[0];
  assert.ok(txn.deleted_at != null, '입금 거래 소프트취소됨');
  // 배분/증빙/헤더 삭제
  assert.equal(pub.many(`SELECT id FROM sales_payment_allocations WHERE payment_id=${pid}`).length, 0, '배분 삭제');
  assert.equal(pub.many(`SELECT payment_id FROM sales_payment_docs WHERE payment_id=${pid}`).length, 0, '증빙 삭제');
  assert.equal(pub.many(`SELECT id FROM sales_payments WHERE id=${pid}`).length, 0, '헤더 삭제');
});
