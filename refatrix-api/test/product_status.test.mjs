// =====================================================================
// 0179 · 제품 활성/비활성 — 실제 PostgreSQL 대상 시나리오 테스트
//
// 실행:  DATABASE_URL=postgres://... JWT_SECRET=x node test/product_status.test.mjs
//   · 마이그레이션이 전부 적용된 DB 가 필요합니다(npm run migrate 후 실행).
//   · 테스트 데이터는 'ZZTEST-' 접두 코드로만 만들고 끝나면 지웁니다.
//   · pg-mem 은 이 테스트의 SQL(윈도우 없는 GROUP BY 함수의존성·부분 인덱스)을
//     완전히 지원하지 않아 실 DB 로 검증합니다.
// =====================================================================
import assert from 'node:assert/strict';
import { query, pool } from '../src/db.js';
import { productOpenItems } from '../src/productStatus.js';

const TAG = 'ZZTEST-' + Date.now().toString(36).toUpperCase();
const one = async (t, p) => (await query(t, p)).rows[0];
let pass = 0;
const ok = (cond, label) => { assert.ok(cond, label); console.log('  ✓', label); pass++; };
const eq = (a, b, label) => { assert.deepEqual(a, b, `${label} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); console.log('  ✓', label); pass++; };

const made = { products: [], quotes: [], invoices: [], pos: [], shipments: [], batches: [], shortages: [], offers: [], devs: [], customers: [], users: [], teams: [], accounts: [], checks: [] };

async function seed() {
  const uid = (await one(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x:y',$1) RETURNING id`, [TAG])).id;
  made.users.push(uid);
  const team = (await one(`INSERT INTO sales_teams (name) VALUES ($1) RETURNING id`, [TAG])).id;
  made.teams.push(team);
  const acct = (await one(`INSERT INTO accounts (name, type, currency) VALUES ($1,'은행','MXN') RETURNING id`, [TAG])).id;
  made.accounts.push(acct);
  const cust = async (n) => {
    const id = (await one(`INSERT INTO customers (code, name, team_id, discount, credit_days) VALUES ($1,$1,$2,10,30) RETURNING id`, [n, team])).id;
    made.customers.push(id); return id;
  };
  const c1 = await cust(TAG + '-C1');
  const c2 = await cust(TAG + '-C2');
  const prod = async (suffix, stock) => {
    const id = (await one(
      `INSERT INTO products (code, name, list_price, stock_qty, avg_cost) VALUES ($1,$1,100,$2,40) RETURNING id`,
      [TAG + suffix, stock])).id;
    made.products.push(id); return id;
  };
  const P1 = await prod('-BUSY', 50);   // 미결 잔뜩
  const P2 = await prod('-CLEAN', 0);   // 미결 없음

  // 견적: draft + confirmed(포장 인쇄됨)
  const mkQuote = async (no, cid, status, pid, qty, printed) => {
    const q = (await one(
      `INSERT INTO quotes (quote_no, customer_id, quote_date, discount_rate, iva_rate, status,
                           subtotal_mxn, iva_mxn, total_mxn, total_qty, sku_count, created_by,
                           reserve_expires_at, packing_printed_at)
       VALUES ($1,$2,CURRENT_DATE,10,16,$3,900,144,1044,$4,1,$5, now()+interval '24 hours', $6) RETURNING id`,
      [no, cid, status, qty, made.users[0], printed ? new Date() : null])).id;
    made.quotes.push(q);
    await query(
      `INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, ctr_code, qty, list_price,
                                discount_rate, final_price, line_subtotal, line_iva, line_total, reserved_qty, stock_flag)
       VALUES ($1,1,$2,$3,$3,$4,100,10,90,$5,0,$5,$4,'ok')`, [q, pid, TAG, qty, qty * 90]);
    return q;
  };
  await mkQuote(TAG + '-Q1', c1, 'draft', P1, 5, false);
  await mkQuote(TAG + '-Q2', c2, 'confirmed', P1, 3, true);
  await mkQuote(TAG + '-Q3', c1, 'cancelled', P1, 9, false);   // 취소 → 잡히면 안 됨

  // 인보이스: 완납 / 미수 / SAT 미발행
  const mkInv = async (sat, cid, pid, qty, total, paid) => {
    const inv = (await one(
      `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, iva_rate,
                                   subtotal_mxn, iva_mxn, total_mxn, status, created_by)
       VALUES ($1,$2,CURRENT_DATE,30,CURRENT_DATE+30,16,$3,0,$3,'posted',$4) RETURNING id`,
      [sat, cid, total, made.users[0]])).id;
    made.invoices.push(inv);
    await query(
      `INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, discount_rate,
                                        unit_price, line_amount_mxn, applied_unit_cost, cogs_mxn)
       VALUES ($1,$2,$3,100,10,90,$4,40,$5)`, [inv, pid, qty, total, qty * 40]);
    if (paid > 0) {
      const pay = (await one(
        `INSERT INTO sales_payments (customer_id, pay_date, account_id, amount, created_by)
         VALUES ($1,CURRENT_DATE,$2,$3,$4) RETURNING id`, [cid, acct, paid, made.users[0]])).id;
      await query(`INSERT INTO sales_payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,$3)`, [pay, inv, paid]);
    }
  };
  await mkInv(TAG + '-A1', c1, P1, 10, 900, 900);   // 완납 → ar 에 안 잡힘
  await mkInv(TAG + '-A2', c2, P1, 4, 360, 100);    // 미수 260
  await mkInv('TMP-' + TAG, c1, P1, 1, 90, 90);     // SAT 미발행 → invoice 버킷

  // 발주(백오더 70) / 취소 PO(잡히면 안 됨)
  const po = (await one(`INSERT INTO purchase_orders (ref_no, order_date, status, created_by) VALUES ($1,CURRENT_DATE,'recorded',$2) RETURNING id`, [TAG + '-PO', made.users[0]])).id;
  made.pos.push(po);
  await query(`INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd, received_qty) VALUES ($1,$2,$3,100,5,500,30)`, [po, P1, TAG]);
  const poX = (await one(`INSERT INTO purchase_orders (ref_no, order_date, status, created_by) VALUES ($1,CURRENT_DATE,'cancelled',$2) RETURNING id`, [TAG + '-POX', made.users[0]])).id;
  made.pos.push(poX);
  await query(`INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd, received_qty) VALUES ($1,$2,$3,50,5,250,0)`, [poX, P1, TAG]);

  // 입고 진행중 / 마감된 선적(잡히면 안 됨)
  const mkShip = async (st) => {
    const s = (await one(`INSERT INTO inbound_shipments (invoice_no, eta, status, created_by) VALUES ($1,CURRENT_DATE,$2,$3) RETURNING id`, [TAG + '-' + st, st, made.users[0]])).id;
    made.shipments.push(s);
    const pal = (await one(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status) VALUES ($1,$2,1,'unloaded') RETURNING id`, [s, TAG])).id;
    await query(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, product_id, input_code, cartons, qty) VALUES ($1,$2,$3,$4,5,70)`, [pal, s, P1, TAG]);
  };
  await mkShip('receiving');
  await mkShip('closed');

  // 수입원가: 미승인 / 승인됨(잡히면 안 됨)
  for (const st of ['pending', 'approved']) {
    const b = (await one(`INSERT INTO import_batches (batch_no, import_date, currency, fx_rate, status, created_by)
                          VALUES ($1,CURRENT_DATE,'USD',18,$2,$3) RETURNING id`, [TAG + '-' + st, st, made.users[0]])).id;
    made.batches.push(b);
    await query(`INSERT INTO import_lines (batch_id, product_id, qty, import_price, unit_cost_mxn) VALUES ($1,$2,20,5,95)`, [b, P1]);
  }

  // 부족분 / 오퍼시트 / 개발요청
  const sh = (await one(`INSERT INTO stock_shortages (product_id, customer_id, requested_qty, fulfilled_qty, shortage_qty, status, occurred_at, created_by)
                         VALUES ($1,$2,10,4,6,'open',CURRENT_DATE,$3) RETURNING id`, [P1, c1, made.users[0]])).id;
  made.shortages.push(sh);
  const os = (await one(`INSERT INTO offer_sheets (offer_no, customer_id, status, origin, created_by) VALUES ($1,$2,'ready','manual',$3) RETURNING id`, [TAG + '-OS', c1, made.users[0]])).id;
  made.offers.push(os);
  await query(`INSERT INTO offer_sheet_items (offer_sheet_id, shortage_id, product_id, offer_qty, list_price, unit_price) VALUES ($1,$2,$3,6,100,90)`, [os, sh, P1]);
  const dv = (await one(`INSERT INTO product_dev_requests (input_code, customer_id, requested_qty, status, result_product_id, created_by)
                         VALUES ($1,$2,12,'reviewed',$3,$4) RETURNING id`, [TAG + '-SYD', c2, P1, made.users[0]])).id;
  made.devs.push(dv);

  return { uid: made.users[0], c1, c2, P1, P2 };
}

async function cleanup() {
  const P = made.products;
  if (P.length) {
    await query(`DELETE FROM offer_sheet_items WHERE product_id = ANY($1)`, [P]);
    await query(`DELETE FROM offer_sheets WHERE id = ANY($1)`, [made.offers]);
    await query(`DELETE FROM product_dev_requests WHERE id = ANY($1)`, [made.devs]);
    await query(`DELETE FROM stock_shortages WHERE id = ANY($1)`, [made.shortages]);
    await query(`DELETE FROM import_lines WHERE batch_id = ANY($1)`, [made.batches]);
    await query(`DELETE FROM import_batches WHERE id = ANY($1)`, [made.batches]);
    await query(`DELETE FROM inbound_pallet_items WHERE shipment_id = ANY($1)`, [made.shipments]);
    await query(`DELETE FROM inbound_pallets WHERE shipment_id = ANY($1)`, [made.shipments]);
    await query(`DELETE FROM inbound_shipments WHERE id = ANY($1)`, [made.shipments]);
    await query(`DELETE FROM purchase_order_lines WHERE po_id = ANY($1)`, [made.pos]);
    await query(`DELETE FROM purchase_orders WHERE id = ANY($1)`, [made.pos]);
    await query(`DELETE FROM sales_payment_allocations WHERE invoice_id = ANY($1)`, [made.invoices]);
    await query(`DELETE FROM sales_payments WHERE customer_id = ANY($1)`, [made.customers]);
    await query(`DELETE FROM sales_invoice_lines WHERE invoice_id = ANY($1)`, [made.invoices]);
    await query(`DELETE FROM sales_invoices WHERE id = ANY($1)`, [made.invoices]);
    await query(`DELETE FROM quote_lines WHERE quote_id = ANY($1)`, [made.quotes]);
    await query(`DELETE FROM quotes WHERE id = ANY($1)`, [made.quotes]);
    await query(`DELETE FROM product_status_check_notes WHERE product_id = ANY($1)`, [P]);
    await query(`DELETE FROM product_status_check_items WHERE product_id = ANY($1)`, [P]);
    await query(`DELETE FROM product_status_checks WHERE id = ANY($1)`, [made.checks]);
    await query(`DELETE FROM product_status_log WHERE product_id = ANY($1)`, [P]);
    await query(`DELETE FROM product_change_log WHERE product_id = ANY($1)`, [P]);
    await query(`DELETE FROM products WHERE id = ANY($1)`, [P]);
  }
  await query(`DELETE FROM customers WHERE id = ANY($1)`, [made.customers]);
  await query(`DELETE FROM accounts WHERE id = ANY($1)`, [made.accounts]);
  await query(`DELETE FROM sales_teams WHERE id = ANY($1)`, [made.teams]);
  await query(`DELETE FROM audit_log WHERE user_id = ANY($1)`, [made.users]);
  await query(`DELETE FROM page_view_daily WHERE user_id = ANY($1)`, [made.users]);
  await query(`DELETE FROM users WHERE id = ANY($1)`, [made.users]);
}

try {
  const { uid, P1, P2 } = await seed();
  console.log('① 미결 항목 수집');
  const r = await productOpenItems(P1);
  const n = (k) => r.summary[k].n;
  eq(n('quote'), 2, '견적: draft·confirmed 2건 (취소 견적은 제외)');
  eq(r.rows.filter((x) => x.bucket === 'quote').map((x) => x.stage).sort(), ['견적', '포장 진행중'], '견적 단계 판정(견적 / 포장 진행중)');
  eq(n('invoice'), 1, '인보이스 미결: SAT 미발행 1건');
  eq(n('ar'), 1, '미수금: 완납 인보이스는 제외하고 1건');
  eq(r.rows.find((x) => x.bucket === 'ar').amount, 260, '미수 잔액 260');
  eq(n('po'), 1, '발주 미입고 1건 (취소 PO 제외)');
  eq(r.rows.find((x) => x.bucket === 'po').qty, 70, '백오더 잔량 70 = 100 − 30');
  eq(n('inbound'), 1, '입고 진행중 1건 (closed 선적 제외)');
  eq(n('batch'), 1, '수입원가 미승인 1건 (approved 제외)');
  eq(n('shortage'), 1, '부족분 미해소 1건');
  eq(n('offer'), 1, '오퍼시트 1건');
  eq(n('devreq'), 1, '개발요청 1건');
  ok(r.summary.stock.info === true && r.summary.stock.n === 1, '보유 재고는 참고(info) 버킷');
  eq(r.open_total, 10, '미결 합계 10건 (참고 버킷 제외)');

  console.log('② 업체별 그룹');
  const parties = r.parties.map((p) => p.party);
  ok(parties.includes(TAG + '-C1') && parties.includes(TAG + '-C2'), '고객사별로 묶임');
  ok(parties.includes('(구매·발주)') && parties.includes('(수입·입고)') && parties.includes('(사내)'), '내부 항목은 고정 라벨로 묶임');
  eq(r.parties.reduce((s, p) => s + p.items.length, 0), r.rows.length, '업체별 합계 = 전체 행수(누락 없음)');

  console.log('③ 미결 없는 SKU');
  const c = await productOpenItems(P2);
  eq(c.open_total, 0, '깨끗한 SKU 는 미결 0');
  eq(c.parties.length, 0, '깨끗한 SKU 는 업체 그룹 없음');

  console.log('④ 상태 전환 · 이력');
  await query(`UPDATE products SET is_active=false, inactive_reason='단종', status_changed_at=now(), status_changed_by=$2 WHERE id=$1`, [P1, uid]);
  await query(`INSERT INTO product_status_log (product_id, code, action, reason, changed_by) VALUES ($1,$2,'deactivate','단종',$3)`, [P1, TAG + '-BUSY', uid]);
  const after = await productOpenItems(P1);
  eq(after.product.is_active, false, '비활성 반영');
  eq(after.open_total, 10, '비활성으로 바꿔도 기존 미결 항목은 그대로 조회됨(기록 보존)');
  const logN = Number((await one(`SELECT COUNT(*)::int AS n FROM product_status_log WHERE product_id=$1`, [P1])).n);
  eq(logN, 1, '상태 전환 이력 1건 기록');

  console.log('⑤ 점검 배치 스냅샷 · 업체별 메모');
  const chk = (await one(
    `INSERT INTO product_status_checks (title, mode, sku_count, open_count, created_by)
     VALUES ($1,'deactivate',1,1,$2) RETURNING id`, [TAG, uid])).id;
  made.checks.push(chk);
  await query(
    `INSERT INTO product_status_check_items (check_id, product_id, code, name, was_active, target_active, open_total, summary, detail)
     VALUES ($1,$2,$3,$3,false,true,$4,$5,$6)`,
    [chk, P1, TAG + '-BUSY', after.open_total, JSON.stringify(after.summary), JSON.stringify({ parties: after.parties })]);
  await query(
    `INSERT INTO product_status_check_notes (check_id, product_id, party, state, memo, updated_by)
     VALUES ($1,$2,$3,'doing','견적 취소 요청함',$4)
     ON CONFLICT (check_id, product_id, party) DO UPDATE SET state=EXCLUDED.state, memo=EXCLUDED.memo`,
    [chk, P1, TAG + '-C1', uid]);
  await query(
    `INSERT INTO product_status_check_notes (check_id, product_id, party, state, memo, updated_by)
     VALUES ($1,$2,$3,'done','처리 완료',$4)
     ON CONFLICT (check_id, product_id, party) DO UPDATE SET state=EXCLUDED.state, memo=EXCLUDED.memo`,
    [chk, P1, TAG + '-C1', uid]);
  const note = await one(`SELECT state, memo FROM product_status_check_notes WHERE check_id=$1 AND product_id=$2`, [chk, P1]);
  eq([note.state, note.memo], ['done', '처리 완료'], '업체별 메모는 (배치,SKU,업체) 단위 업서트');
  const snap = await one(`SELECT open_total, detail FROM product_status_check_items WHERE check_id=$1`, [chk]);
  eq(Number(snap.open_total), 10, '배치 스냅샷에 미결 건수 보존');
  eq(snap.detail.parties.length, after.parties.length, '배치 스냅샷에 업체별 상세 보존');

  console.log(`\nALL ${pass} ASSERTIONS PASSED`);
} catch (e) {
  console.error('\nFAILED:', e.message);
  process.exitCode = 1;
} finally {
  await cleanup();
  await pool.end();
}
