// 부족분 해소 엔진 통합 테스트 (실제 Postgres 사용)
//   node test/shortage_resolve.test.js
import pg from 'pg';
import { allocateShortagesOnSale, reverseInvoiceResolutions, scanResolveShortages } from '../src/shortageResolve.js';
import fs from 'fs';

const pool = new pg.Pool({ connectionString: 'postgres://tester:tester@localhost:5432/refatest' });
const q = (text, params) => pool.query(text, params);

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}
const n3 = (x) => Math.round(Number(x) * 1000) / 1000;

async function setup() {
  await q(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  // 최소 스키마(운영 스키마의 관련 부분만)
  await q(`
    CREATE TABLE users (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT);
    CREATE TABLE products (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code TEXT, name TEXT,
      stock_qty NUMERIC(15,3) DEFAULT 0, list_price NUMERIC(15,2) DEFAULT 0, iva_rate NUMERIC(5,2) DEFAULT 16, deleted_at TIMESTAMPTZ);
    CREATE TABLE customers (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT, discount NUMERIC(5,2) DEFAULT 0, deleted_at TIMESTAMPTZ);
    CREATE TABLE quotes (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
    CREATE TABLE sales_invoices (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      customer_id BIGINT REFERENCES customers(id), inv_date DATE, status TEXT DEFAULT 'posted', sat_no TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE sales_invoice_lines (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      invoice_id BIGINT REFERENCES sales_invoices(id), product_id BIGINT REFERENCES products(id), qty NUMERIC(15,3));
    CREATE TABLE stock_shortages (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id),
      customer_id BIGINT REFERENCES customers(id),
      sales_invoice_id BIGINT REFERENCES sales_invoices(id),
      requested_qty NUMERIC(15,3) NOT NULL,
      fulfilled_qty NUMERIC(15,3) NOT NULL DEFAULT 0,
      shortage_qty NUMERIC(15,3) NOT NULL,
      shortage_amount_mxn NUMERIC(15,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','cancelled')),
      occurred_at DATE NOT NULL,
      source_quote_id BIGINT REFERENCES quotes(id),
      note TEXT, created_at TIMESTAMPTZ DEFAULT now(), created_by BIGINT,
      resolved_at TIMESTAMPTZ, resolved_by BIGINT);
  `);
  // 0156 마이그레이션 원본 적용
  await q(fs.readFileSync(new URL('../migrations/0156_shortage_resolutions.sql', import.meta.url), 'utf8'));
  // 시드
  await q(`INSERT INTO users (name) VALUES ('tester')`);
  await q(`INSERT INTO products (code,name,stock_qty) VALUES ('CA0001','부품A',0),('CB0002','부품B',0)`);
  await q(`INSERT INTO customers (name) VALUES ('고객1'),('고객2')`);
}

async function shortage(pid, cid, qty, date, invId = null) {
  const r = await q(
    `INSERT INTO stock_shortages (product_id, customer_id, sales_invoice_id, requested_qty, fulfilled_qty, shortage_qty, shortage_amount_mxn, occurred_at)
     VALUES ($1,$2,$3,$4,0,$4,$5,$6) RETURNING id`, [pid, cid, invId, qty, qty * 100, date]);
  return Number(r.rows[0].id);
}
async function invoice(cid, date, lines) {
  const inv = (await q(`INSERT INTO sales_invoices (customer_id, inv_date) VALUES ($1,$2) RETURNING id`, [cid, date])).rows[0];
  for (const [pid, qty] of lines) await q(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty) VALUES ($1,$2,$3)`, [inv.id, pid, qty]);
  return Number(inv.id);
}
async function sh(id) {
  const r = (await q(`SELECT shortage_qty, resolved_qty, status FROM stock_shortages WHERE id=$1`, [id])).rows[0];
  return { qty: n3(r.shortage_qty), res: n3(r.resolved_qty), status: r.status };
}

async function main() {
  await setup();

  console.log('① FIFO 부분·전량 해소');
  const s1 = await shortage(1, 1, 10, '2026-05-01');  // 오래된 부족 10
  const s2 = await shortage(1, 1, 5, '2026-06-01');   // 이후 부족 5
  const inv1 = await invoice(1, '2026-06-10', [[1, 12]]);
  const out1 = await allocateShortagesOnSale(q, { productId: 1, customerId: 1, qty: 12, invDate: '2026-06-10', invoiceId: inv1, userId: 1 });
  ok(out1.allocated === 12, `판매 12 전량 배분 (got ${out1.allocated})`);
  let a = await sh(s1), b = await sh(s2);
  ok(a.res === 10 && a.status === 'resolved', `오래된 부족 10 전량 해소·resolved (${a.res}/${a.status})`);
  ok(b.res === 2 && b.status === 'open', `이후 부족 5 중 2 해소·open 유지 (${b.res}/${b.status})`);

  console.log('② 자기 인보이스 부족은 자기 출고로 해소 안 됨');
  const inv2 = await invoice(1, '2026-06-20', [[2, 3]]);
  const s3 = await shortage(2, 1, 7, '2026-06-20', inv2); // 같은 인보이스의 부족
  const out2 = await allocateShortagesOnSale(q, { productId: 2, customerId: 1, qty: 3, invDate: '2026-06-20', invoiceId: inv2, userId: 1 });
  ok(out2.allocated === 0, `자기 인보이스 부족 미해소 (allocated ${out2.allocated})`);
  ok((await sh(s3)).res === 0, '부족 기록 그대로 유지');

  console.log('③ 다른 고객 판매는 해소하지 않음');
  const inv3 = await invoice(2, '2026-06-25', [[2, 5]]);
  const out3 = await allocateShortagesOnSale(q, { productId: 2, customerId: 2, qty: 5, invDate: '2026-06-25', invoiceId: inv3, userId: 1 });
  ok(out3.allocated === 0 && (await sh(s3)).res === 0, '고객2 판매 → 고객1 부족 미해소');

  console.log('④ 발생일 이전 판매는 해소하지 않음 (invDate < occurred_at)');
  const s4 = await shortage(2, 2, 4, '2026-07-15');
  const inv4 = await invoice(2, '2026-07-01', [[2, 4]]);
  const out4 = await allocateShortagesOnSale(q, { productId: 2, customerId: 2, qty: 4, invDate: '2026-07-01', invoiceId: inv4, userId: 1 });
  ok(out4.allocated === 0 && (await sh(s4)).res === 0, '발생 전 판매 미해소');

  console.log('⑤ 인보이스 삭제 되돌림 (원장 삭제 + 잔여 복원 + open 재개방)');
  await reverseInvoiceResolutions(q, inv1, 1);
  a = await sh(s1); b = await sh(s2);
  ok(a.res === 0 && a.status === 'open', `s1 복원 open (${a.res}/${a.status})`);
  ok(b.res === 0 && b.status === 'open', `s2 복원 open (${b.res}/${b.status})`);
  const ledger1 = (await q(`SELECT COUNT(*)::int AS n FROM stock_shortage_resolutions WHERE sales_invoice_id=$1`, [inv1])).rows[0].n;
  ok(ledger1 === 0, '원장 행 삭제됨');

  console.log('⑥ 소급 스캔 (멱등)');
  // 현재 open: s1(10, 5/1), s2(5, 6/1) — inv1(6/10, 12개 판매)이 존재 → 스캔이 다시 해소해야 함
  const scan1 = await scanResolveShortages(q, { userId: 1 });
  a = await sh(s1); b = await sh(s2);
  ok(scan1.allocated >= 12 && a.status === 'resolved' && b.res === 2, `스캔으로 재해소 (alloc ${scan1.allocated}, s1 ${a.res}, s2 ${b.res})`);
  const scan2 = await scanResolveShortages(q, { userId: 1 });
  ok(scan2.allocated === 0, `재실행 시 추가 해소 없음(멱등) (got ${scan2.allocated})`);

  console.log('⑦ 스캔도 자기 인보이스 부족 제외 + 용량 초과 배분 없음');
  const cnt3 = await sh(s3);
  ok(cnt3.res === 0 && cnt3.status === 'open', `s3(자기 인보이스 부족)는 스캔에도 미해소 (${cnt3.res})`);
  const totalLedger = n3((await q(`SELECT COALESCE(SUM(qty),0) AS s FROM stock_shortage_resolutions`)).rows[0].s);
  ok(totalLedger === 12, `원장 합계 = 판매 가용량 12 (got ${totalLedger})`);

  console.log('⑧ 소수 수량(3자리 반올림)');
  const s5 = await shortage(1, 2, 1.25, '2026-07-01');
  const inv5 = await invoice(2, '2026-07-05', [[1, 0.75]]);
  await allocateShortagesOnSale(q, { productId: 1, customerId: 2, qty: 0.75, invDate: '2026-07-05', invoiceId: inv5, userId: 1 });
  const e = await sh(s5);
  ok(e.res === 0.75 && e.status === 'open', `1.25 중 0.75 해소 (${e.res})`);

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
