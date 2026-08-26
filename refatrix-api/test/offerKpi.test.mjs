// =====================================================================
// Offer KPI — 오퍼시트 → 인보이스 자동 매칭 (2026-08-03 디렉터 확정)
//   인보이스 기준(IVA 제외) · 발송 후 30일 창 · 제안수량 캡 · 선발송 우선 · 직원별 귀속
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { computeOfferKpi, loadOfferKpi } from '../src/offerKpi.js';

const SHEET = (o) => ({ id: 1, offer_no: 'OS-1', customer_id: 10, customer_name: 'A', sent_by: 5, sent_by_name: 'María', sent_date: '2026-08-01', lines: [{ product_id: 1, offer_qty: 15 }], ...o });
const INV = (o) => ({ id: 100, sat_no: 'F-100', customer_id: 10, product_id: 1, qty: 10, unit_price: 100, inv_date: '2026-08-05', ctr_code: 'CL0001', product_name: 'TERM', ...o });

test('기본 매칭: 발송 후 창 안 인보이스 → 귀속 (금액 = qty × 단가, IVA 제외)', () => {
  const out = computeOfferKpi([SHEET()], [INV()]);
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].qty, 10);
  assert.equal(out.matches[0].amount_mxn, 1000);
  assert.equal(out.matches[0].staff_name, 'María');
  assert.equal(out.totals.matched_amount_mxn, 1000);
});

test('제안수량 캡: 인보이스 20 > 제안 15 → 15만 귀속 (초과분은 일반 판매)', () => {
  const out = computeOfferKpi([SHEET()], [INV({ qty: 20 })]);
  assert.equal(out.matches[0].qty, 15);
  assert.equal(out.matches[0].amount_mxn, 1500);
});

test('30일 창: 창 밖(발송 전·31일 후) 인보이스는 미귀속', () => {
  const before = computeOfferKpi([SHEET()], [INV({ inv_date: '2026-07-31' })]);
  assert.equal(before.matches.length, 0, '발송 전');
  const late = computeOfferKpi([SHEET()], [INV({ inv_date: '2026-09-01' })]);
  assert.equal(late.matches.length, 0, '창(8/31) 지남');
  const edge = computeOfferKpi([SHEET()], [INV({ inv_date: '2026-08-31' })]);
  assert.equal(edge.matches.length, 1, '창 마지막 날은 포함');
});

test('다른 고객·다른 SKU는 미귀속', () => {
  assert.equal(computeOfferKpi([SHEET()], [INV({ customer_id: 99 })]).matches.length, 0);
  assert.equal(computeOfferKpi([SHEET()], [INV({ product_id: 9 })]).matches.length, 0);
});

test('시트 여럿: 먼저 발송한 시트부터 귀속, 이중 집계 없음 (5+10 시트에 인보이스 12 → 5/7)', () => {
  const s1 = SHEET({ id: 1, offer_no: 'OS-1', sent_date: '2026-08-01', lines: [{ product_id: 1, offer_qty: 5 }] });
  const s2 = SHEET({ id: 2, offer_no: 'OS-2', sent_date: '2026-08-03', sent_by: 6, sent_by_name: 'Óscar', lines: [{ product_id: 1, offer_qty: 10 }] });
  const out = computeOfferKpi([s1, s2], [INV({ qty: 12 })]);
  assert.equal(out.matches.length, 2);
  assert.deepEqual(out.matches.map((m) => [m.offer_no, m.qty]), [['OS-1', 5], ['OS-2', 7]]);
  assert.equal(out.totals.matched_amount_mxn, 1200, '합계 = 12 × 100 (이중 집계 없음)');
  const maria = out.staff.find((s) => s.staff_name === 'María');
  const oscar = out.staff.find((s) => s.staff_name === 'Óscar');
  assert.equal(maria.matched_amount_mxn, 500);
  assert.equal(oscar.matched_amount_mxn, 700);
});

test('인보이스 여러 장이 순서대로 잔여 소진: 10+10 인보이스, 제안 15 → 10/5', () => {
  const out = computeOfferKpi([SHEET()], [INV({ id: 100, inv_date: '2026-08-04', qty: 10 }), INV({ id: 101, inv_date: '2026-08-06', qty: 10 })]);
  assert.deepEqual(out.matches.map((m) => [m.invoice_id, m.qty]), [[100, 10], [101, 5]]);
});

// ---------- loadOfferKpi (pg-mem — SQL 로딩 + 프로모 결합) ----------
function seed() {
  const db = newDb(); const pub = db.public;
  pub.none(`
    CREATE TABLE customers(id INT PRIMARY KEY, name TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE users(id INT PRIMARY KEY, name TEXT);
    CREATE TABLE products(id INT PRIMARY KEY, code TEXT, name TEXT);
    CREATE TABLE offer_sheets(id INT PRIMARY KEY, offer_no TEXT, customer_id INT, status TEXT,
      sent_at TEXT, sent_by INT, deleted_at TIMESTAMPTZ, disabled_at TIMESTAMPTZ);
    CREATE TABLE offer_sheet_items(id INT PRIMARY KEY, offer_sheet_id INT, product_id INT, offer_qty NUMERIC);
    CREATE TABLE invoices(id INT PRIMARY KEY, sat_no TEXT, customer_id INT, product_id INT,
      qty NUMERIC, unit_price NUMERIC, inv_date TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE offer_promos(id INT PRIMARY KEY, ym TEXT, goal_amount_mxn NUMERIC, prize_text TEXT, active BOOLEAN);
  `);
  const q = async (sql, args) => pub.query(sql.replace(/\$(\d+)/g, (_, n) => {
    const v = (args || [])[Number(n) - 1];
    if (v == null) return 'NULL';
    return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  }));
  return { pub, q };
}

test('loadOfferKpi: 발송 시트 + 이번 달 인보이스 + 프로모 달성 판정', async () => {
  const { pub, q } = seed();
  pub.none(`
    INSERT INTO customers VALUES (10,'Cliente A',NULL);
    INSERT INTO users VALUES (5,'María');
    INSERT INTO products VALUES (1,'CL0001','TERM');
    INSERT INTO offer_sheets VALUES (1,'OS-1',10,'sent','2026-08-01 10:00:00',5,NULL);
    INSERT INTO offer_sheet_items VALUES (11,1,1,15);
    INSERT INTO invoices VALUES (100,'F-100',10,1,10,1200,'2026-08-05',NULL);
    INSERT INTO invoices VALUES (101,'F-101',10,1,50,1200,'2026-08-06',NULL);  -- 잔여 5만 귀속
    INSERT INTO invoices VALUES (102,'F-102',99,1,10,1200,'2026-08-06',NULL);  -- 다른 고객 제외
    INSERT INTO offer_promos VALUES (1,'2026-08',10000,'Tarjeta $500 × 2',true);
  `);
  const out = await loadOfferKpi(q, '2026-08');
  assert.equal(out.window_days, 30);
  assert.equal(out.matches.length, 2);
  assert.equal(out.totals.matched_amount_mxn, 18000, '(10+5) × 1200');
  assert.equal(out.totals.sheets_sent, 1);
  const maria = out.staff.find((s) => s.staff_name === 'María');
  assert.equal(maria.matched_amount_mxn, 18000);
  assert.equal(maria.sheets_sent, 1);
  assert.equal(maria.achieved, true, '목표 10,000 ≤ 18,000');
  assert.equal(out.promo.prize_text, 'Tarjeta $500 × 2');
});

test('loadOfferKpi: 취소 시트·삭제 인보이스 제외, 프로모 없으면 achieved 미설정', async () => {
  const { pub, q } = seed();
  pub.none(`
    INSERT INTO customers VALUES (10,'Cliente A',NULL);
    INSERT INTO users VALUES (5,'María');
    INSERT INTO products VALUES (1,'CL0001','TERM');
    INSERT INTO offer_sheets VALUES (1,'OS-1',10,'cancelled','2026-08-01 10:00:00',5,NULL);
    INSERT INTO offer_sheets VALUES (2,'OS-2',10,'sent','2026-08-02 10:00:00',5,NULL);
    INSERT INTO offer_sheet_items VALUES (11,1,1,15);
    INSERT INTO offer_sheet_items VALUES (12,2,1,15);
    INSERT INTO invoices VALUES (100,'F-100',10,1,10,100,'2026-08-05',NULL);
    INSERT INTO invoices VALUES (101,'F-101',10,1,10,100,'2026-08-05','2026-08-06');
  `);
  const out = await loadOfferKpi(q, '2026-08');
  assert.equal(out.matches.length, 1, '취소 시트 미귀속·삭제 인보이스 제외');
  assert.equal(out.matches[0].offer_no, 'OS-2');
  assert.equal(out.promo, null);
  assert.equal(out.staff[0].achieved, undefined);
});

test('loadOfferKpi: 지난달 말 발송 시트도 창이 걸치면 이번 달 인보이스 귀속', async () => {
  const { pub, q } = seed();
  pub.none(`
    INSERT INTO customers VALUES (10,'Cliente A',NULL);
    INSERT INTO users VALUES (5,'María');
    INSERT INTO products VALUES (1,'CL0001','TERM');
    INSERT INTO offer_sheets VALUES (1,'OS-1',10,'sent','2026-07-25 10:00:00',5,NULL);
    INSERT INTO offer_sheet_items VALUES (11,1,1,15);
    INSERT INTO invoices VALUES (100,'F-100',10,1,10,100,'2026-08-10',NULL);
  `);
  const out = await loadOfferKpi(q, '2026-08');
  assert.equal(out.matches.length, 1, '7/25 발송 + 8/10 인보이스 (창 8/24까지)');
  assert.equal(out.totals.sheets_sent, 0, '이 달 발송 건수에는 미포함');
});
