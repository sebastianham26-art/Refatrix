// =====================================================================
// Offer Sheet 비활성화(오퍼 중단) — 0183 (2026-08-26)
//   요구: 영업지원>부족분>Offer Sheet 목록에서 오퍼 자체를 삭제(비활성화)한다.
//         부족 기록(stock_shortages)은 유지하고, 그 오퍼시트만 다시 생성되지 않게.
//   핵심 검증:
//     ① 비활성 시트에 담긴 부족분은 재스캔해도 오퍼시트가 다시 안 생긴다.
//     ② 취소(cancelled)는 기존대로 재생성 대상으로 복귀한다(회귀).
//     ③ 취소 + 비활성이면 재생성 안 된다(= "취소했는데 자꾸 또 생긴다" 해결).
//     ④ 활성화(비활성 해제)하면 다시 생성 대상으로 돌아온다.
//     ⑤ 견적 부족라인(quote_line_id) 출처도 같은 규칙을 따른다.
//     ⑥ 부족 기록 자체는 어떤 경우에도 변하지 않는다.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { generateOfferSheets } from '../src/offerSheets.js';

function seed() {
  const db = newDb();
  const pub = db.public;
  pub.registerFunction({ name: 'pg_advisory_xact_lock', args: ['integer'], returns: 'integer', implementation: () => 1 });
  pub.registerFunction({ name: 'to_char', args: ['timestamptz', 'text'], returns: 'text', implementation: (d) => {
    const t = new Date(d); const p = (n) => String(n).padStart(2, '0');
    return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}`;
  } });
  pub.none(`
    CREATE TABLE products(id INT PRIMARY KEY, code TEXT, list_price NUMERIC, iva_rate NUMERIC, stock_qty NUMERIC,
      deleted_at TIMESTAMPTZ, is_active BOOLEAN DEFAULT true);
    CREATE TABLE customers(id INT PRIMARY KEY, name TEXT, discount NUMERIC, deleted_at TIMESTAMPTZ);
    CREATE TABLE stock_shortages(id INT PRIMARY KEY, customer_id INT, product_id INT,
      shortage_qty NUMERIC, resolved_qty NUMERIC DEFAULT 0, status TEXT, occurred_at TEXT, source_quote_id INT);
    CREATE TABLE quotes(id INT PRIMARY KEY, customer_id INT, quote_no TEXT, status TEXT, quote_date TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE quote_lines(id INT PRIMARY KEY, quote_id INT, product_id INT, qty NUMERIC, reserved_qty NUMERIC);
    CREATE TABLE offer_sheets(id SERIAL PRIMARY KEY, offer_no TEXT, customer_id INT, import_batch_id INT,
      status TEXT, origin TEXT, subtotal_mxn NUMERIC, iva_mxn NUMERIC, total_mxn NUMERIC,
      created_by INT, created_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ,
      disabled_at TIMESTAMPTZ, disabled_by INT, disabled_note TEXT);
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

const basicRows = `
  INSERT INTO products (id,code,list_price,iva_rate,stock_qty,deleted_at) VALUES (1,'CL0001',100,16,50,NULL);
  INSERT INTO customers VALUES (10,'Cliente A',0,NULL);
  INSERT INTO stock_shortages VALUES (101,10,1,20,0,'open','2026-07-01',NULL);
`;
const sheetCount = (pub) => Number(pub.many(`SELECT COUNT(*)::int AS n FROM offer_sheets`)[0].n);
const disable = (pub, id) => pub.none(`UPDATE offer_sheets SET disabled_at=now(), disabled_by=1 WHERE id=${id}`);

test('① 비활성 시트의 부족분은 재스캔해도 오퍼시트가 다시 생성되지 않는다', async () => {
  const { pub, q } = seed();
  pub.none(basicRows);
  const first = await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  assert.equal(first.sheets, 1, '최초 1건 생성');
  disable(pub, 1);

  const again = await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  assert.equal(again.sheets, 0, '비활성 시트에 담긴 부족분은 재생성 대상이 아니다');
  assert.equal(sheetCount(pub), 1);

  // 부족 기록은 그대로 (발주 근거 보존)
  const sh = pub.many(`SELECT status, shortage_qty, resolved_qty FROM stock_shortages WHERE id=101`)[0];
  assert.equal(sh.status, 'open');
  assert.equal(Number(sh.shortage_qty), 20);
  assert.equal(Number(sh.resolved_qty), 0);
});

test('② 회귀: 취소(cancelled)는 지금처럼 재생성 대상으로 복귀한다', async () => {
  const { pub, q } = seed();
  pub.none(basicRows);
  await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  pub.none(`UPDATE offer_sheets SET status='cancelled' WHERE id=1`);

  const again = await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  assert.equal(again.sheets, 1, '취소하면 다시 생성된다(기존 동작)');
  assert.equal(sheetCount(pub), 2);
});

test('③ 취소 + 비활성 = 재생성 안 됨 ("취소했는데 스캔할 때마다 또 생긴다" 해결)', async () => {
  const { pub, q } = seed();
  pub.none(basicRows);
  await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  pub.none(`UPDATE offer_sheets SET status='cancelled' WHERE id=1`);
  disable(pub, 1);

  const again = await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  assert.equal(again.sheets, 0);
  assert.equal(sheetCount(pub), 1);
});

test('④ 활성화(비활성 해제)하면 원래 규칙으로 돌아온다 (ready→생성 안 됨 / cancelled→생성됨)', async () => {
  const { pub, q } = seed();
  pub.none(basicRows);
  await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  disable(pub, 1);
  pub.none(`UPDATE offer_sheets SET disabled_at=NULL, disabled_by=NULL, disabled_note=NULL WHERE id=1`);

  assert.equal((await generateOfferSheets(q, { origin: 'manual', userId: 1 })).sheets, 0,
    '활성 ready 시트가 살아있으니 중복 생성 없음(기존 가드)');
  pub.none(`UPDATE offer_sheets SET status='cancelled' WHERE id=1`);
  assert.equal((await generateOfferSheets(q, { origin: 'manual', userId: 1 })).sheets, 1,
    '활성 상태에서 취소하면 다시 생성 대상');
});

test('⑤ 견적 부족라인 출처도 같은 규칙 — 비활성 시트면 재생성 안 됨', async () => {
  const { pub, q } = seed();
  const today = new Date().toISOString().slice(0, 10);
  pub.none(`
    INSERT INTO products (id,code,list_price,iva_rate,stock_qty,deleted_at) VALUES (1,'CL0001',100,16,50,NULL);
    INSERT INTO customers VALUES (10,'Cliente A',0,NULL);
    INSERT INTO quotes VALUES (500,10,'Q-500','draft','${today}',NULL);
    INSERT INTO quote_lines VALUES (900,500,1,12,2);
  `);
  const first = await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  assert.equal(first.sheets, 1);
  const it = pub.many(`SELECT quote_line_id, offer_qty FROM offer_sheet_items`)[0];
  assert.equal(Number(it.quote_line_id), 900);
  assert.equal(Number(it.offer_qty), 10, '부족 = 12 − 예약 2');

  pub.none(`UPDATE offer_sheets SET status='cancelled' WHERE id=1`);
  disable(pub, 1);
  assert.equal((await generateOfferSheets(q, { origin: 'manual', userId: 1 })).sheets, 0,
    '비활성이면 견적 부족라인도 다시 오퍼되지 않는다');
});

test('⑥ 다른 고객·다른 부족분은 비활성과 무관하게 정상 생성된다', async () => {
  const { pub, q } = seed();
  pub.none(basicRows);
  await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  disable(pub, 1);
  // 나중에 새로 생긴 부족분(다른 고객)
  pub.none(`
    INSERT INTO customers VALUES (20,'Cliente B',0,NULL);
    INSERT INTO stock_shortages VALUES (102,20,1,5,0,'open','2026-08-20',NULL);
  `);
  const out = await generateOfferSheets(q, { origin: 'manual', userId: 1 });
  assert.equal(out.sheets, 1, '비활성은 그 시트에 담긴 기록만 막는다');
  const rows = pub.many(`SELECT s.customer_id, i.shortage_id FROM offer_sheet_items i
                           JOIN offer_sheets s ON s.id=i.offer_sheet_id WHERE s.id=2`);
  assert.equal(Number(rows[0].customer_id), 20);
  assert.equal(Number(rows[0].shortage_id), 102);
});
