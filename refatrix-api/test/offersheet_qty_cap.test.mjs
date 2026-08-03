// =====================================================================
// Offer Sheet 제안수량 캡 (2026-08-03 디렉터 확정)
//   제안수량 = min(부족수량, 현재고 스냅샷)
//   - 고객 간 배분 없음: 모든 고객에게 같은 재고를 오퍼(선착순, 면책문구).
//   - 같은 고객·같은 SKU 여러 기록: 합계가 현재고를 넘지 않게 누적 캡.
//   - 캡으로 0이 된 기록도 시트에 담아(수량 0) 중복가드 유지.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { generateOfferSheets } from '../src/offerSheets.js';

function seed() {
  const db = newDb();
  const pub = db.public;
  // 생성기가 쓰는 잠금·형변환 함수 흉내
  pub.registerFunction({ name: 'pg_advisory_xact_lock', args: ['integer'], returns: 'integer', implementation: () => 1 });
  pub.registerFunction({ name: 'to_char', args: ['timestamptz', 'text'], returns: 'text', implementation: (d) => {
    const t = new Date(d); const p = (n) => String(n).padStart(2, '0');
    return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}`;
  } });
  pub.none(`
    CREATE TABLE products(id INT PRIMARY KEY, code TEXT, list_price NUMERIC, iva_rate NUMERIC, stock_qty NUMERIC, deleted_at TIMESTAMPTZ);
    CREATE TABLE customers(id INT PRIMARY KEY, name TEXT, discount NUMERIC, deleted_at TIMESTAMPTZ);
    CREATE TABLE stock_shortages(id INT PRIMARY KEY, customer_id INT, product_id INT,
      shortage_qty NUMERIC, resolved_qty NUMERIC DEFAULT 0, status TEXT, occurred_at TEXT, source_quote_id INT);
    CREATE TABLE quotes(id INT PRIMARY KEY, customer_id INT, quote_no TEXT, status TEXT, quote_date TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE quote_lines(id INT PRIMARY KEY, quote_id INT, product_id INT, qty NUMERIC, reserved_qty NUMERIC);
    CREATE TABLE offer_sheets(id SERIAL PRIMARY KEY, offer_no TEXT, customer_id INT, import_batch_id INT,
      status TEXT, origin TEXT, subtotal_mxn NUMERIC, iva_mxn NUMERIC, total_mxn NUMERIC,
      created_by INT, created_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ);
    CREATE TABLE offer_sheet_items(id SERIAL PRIMARY KEY, offer_sheet_id INT, shortage_id INT, quote_id INT, quote_line_id INT,
      product_id INT, offer_qty NUMERIC, list_price NUMERIC, discount_rate NUMERIC, unit_price NUMERIC,
      line_subtotal NUMERIC, line_iva NUMERIC, line_total NUMERIC, occurred_at TIMESTAMPTZ);
  `);
  const q = async (sql, args) => pub.query(sql.replace(/\$(\d+)/g, (_, n) => {
    const v = (args || [])[Number(n) - 1];
    if (v == null) return 'NULL';
    return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  }));
  return { pub, q };
}

test('시나리오(디렉터 예시): 재고 15 — A 부족 20 → 15 오퍼, B 부족 5 → 5 오퍼 (배분 없음)', async () => {
  const { pub, q } = seed();
  pub.none(`
    INSERT INTO products VALUES (1,'CL0001',100,16,15,NULL);
    INSERT INTO customers VALUES (10,'Cliente A',0,NULL),(20,'Cliente B',0,NULL);
    INSERT INTO stock_shortages VALUES (101,10,1,20,0,'open','2026-07-01',NULL);
    INSERT INTO stock_shortages VALUES (102,20,1,5,0,'open','2026-07-02',NULL);
  `);
  const out = await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  assert.equal(out.sheets, 2);
  const items = pub.many(`SELECT s.customer_id, i.offer_qty, i.line_subtotal
                            FROM offer_sheet_items i JOIN offer_sheets s ON s.id=i.offer_sheet_id ORDER BY s.customer_id`);
  assert.equal(Number(items[0].offer_qty), 15, 'A: min(20, 재고15) = 15');
  assert.equal(Number(items[0].line_subtotal), 1500, 'A 금액도 캡 수량 기준');
  assert.equal(Number(items[1].offer_qty), 5, 'B: min(5, 재고15) = 5 — 배분하지 않음');
  const totals = pub.many(`SELECT customer_id, total_mxn FROM offer_sheets ORDER BY customer_id`);
  assert.equal(Number(totals[0].total_mxn), 1740, 'A: 1500 + IVA 16%');
  assert.equal(Number(totals[1].total_mxn), 580, 'B: 500 + IVA 16%');
});

test('같은 고객·같은 SKU 기록 2건(10+10)·재고 15 → 10+5, 합계 15 (누적 캡, 0 수량도 기록 유지)', async () => {
  const { pub, q } = seed();
  pub.none(`
    INSERT INTO products VALUES (1,'CL0001',100,16,15,NULL);
    INSERT INTO customers VALUES (10,'Cliente A',0,NULL);
    INSERT INTO stock_shortages VALUES (101,10,1,10,0,'open','2026-07-01',NULL);
    INSERT INTO stock_shortages VALUES (102,10,1,10,0,'open','2026-07-02',NULL);
    INSERT INTO stock_shortages VALUES (103,10,1,10,0,'open','2026-07-03',NULL);
  `);
  const out = await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  assert.equal(out.sheets, 1);
  const items = pub.many(`SELECT shortage_id, offer_qty FROM offer_sheet_items ORDER BY shortage_id`);
  assert.deepEqual(items.map((r) => Number(r.offer_qty)), [10, 5, 0], '먼저 발생한 기록부터 채우고 넘치면 0');
  const sum = items.reduce((a, r) => a + Number(r.offer_qty), 0);
  assert.equal(sum, 15, '고객 내 SKU 합계 = 현재고');
  // 0 수량 기록도 시트에 담겨 중복가드 유지 → 재스캔 시 새 시트 없음
  const again = await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  assert.equal(again.sheets, 0, '재스캔 중복 생성 없음');
});

test('견적 부족 라인 출처도 동일 캡: 재고 3 · 견적 부족 8 → 3', async () => {
  const { pub, q } = seed();
  pub.none(`
    INSERT INTO products VALUES (1,'CL0001',200,16,3,NULL);
    INSERT INTO customers VALUES (10,'Cliente A',10,NULL);
    INSERT INTO quotes VALUES (7,10,'Q-0007','confirmed','2026-07-20',NULL);
    INSERT INTO quote_lines VALUES (71,7,1,8,0);
  `);
  const out = await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  assert.equal(out.sheets, 1);
  const it = pub.many(`SELECT offer_qty, unit_price, line_subtotal FROM offer_sheet_items`)[0];
  assert.equal(Number(it.offer_qty), 3, 'min(8, 재고3) = 3');
  assert.equal(Number(it.unit_price), 180, '정가 200 × (1−10%)');
  assert.equal(Number(it.line_subtotal), 540, '180 × 3');
});

test('부족수량 ≤ 재고면 캡 미적용(기존 동작 유지): 재고 100 · 부족 7 → 7', async () => {
  const { pub, q } = seed();
  pub.none(`
    INSERT INTO products VALUES (1,'CL0001',100,16,100,NULL);
    INSERT INTO customers VALUES (10,'Cliente A',0,NULL);
    INSERT INTO stock_shortages VALUES (101,10,1,7,0,'open','2026-07-01',NULL);
  `);
  await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  assert.equal(Number(pub.many(`SELECT offer_qty FROM offer_sheet_items`)[0].offer_qty), 7);
});
