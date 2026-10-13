// =====================================================================
// 2026-10-13 · 매출확정 「할인율로 매출액 수정」 + 최종단가 엑셀 플래그
//   순수: repriceByDiscount / effectiveDiscountPct
//   종단(실 PostgreSQL): POST /api/sales/:id/adjust-discount · GET /api/dashboard/funnel/invoice-lines
//   실행: TEST_PG_URL=postgres://... node --test test/sales_discount_adjust.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
if (process.env.TEST_PG_URL) process.env.DATABASE_URL = process.env.TEST_PG_URL;
const { repriceByDiscount, effectiveDiscountPct } = await import('../src/sales.js');

const L = [
  { id: 1, code: 'A', qty: 3, list_price: 1000, unit_price: 550, line_amount_mxn: 1650 },
  { id: 2, code: 'B', qty: 7, list_price: 333.33, unit_price: 183.33, line_amount_mxn: 1283.31 },
  { id: 3, code: 'C', qty: 1, list_price: 99.99, unit_price: 54.99, line_amount_mxn: 54.99 },
];

test('정가 대비 — 단가=정가×(1−r), 금액=단가×수량, IVA 16%, 소계+IVA=총계', () => {
  const r = repriceByDiscount(L, { basis: 'list', rate: 50 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines.map((l) => l.unit_price), [500, 166.67, 50]);   // 333.33×0.5=166.665 → 166.67, 99.99×0.5=49.995 → 50.00
  assert.deepEqual(r.lines.map((l) => l.line_amount_mxn), [1500, 1166.69, 50]);
  for (const l of r.lines) assert.equal(Math.round(l.unit_price * l.qty * 100) / 100, l.line_amount_mxn, '수량×단가=금액');
  assert.equal(r.subtotal, 2716.69);
  assert.equal(r.iva, 434.67);
  assert.equal(r.total, 3151.36);
  assert.ok(r.lines.every((l) => l.discount_rate === 50));
});

test('정가 대비는 두 번 적용해도 같은 결과(누적 안 됨)', () => {
  const a = repriceByDiscount(L, { basis: 'list', rate: 48 });
  const again = repriceByDiscount(a.lines.map((l, i) => ({ ...L[i], ...l })), { basis: 'list', rate: 48 });
  assert.equal(again.subtotal, a.subtotal);
});

test('현재 매출액 대비 — 실효단가(금액÷수량)×(1−r), 누적됨, discount_rate 는 정가 대비 실효값', () => {
  const r = repriceByDiscount(L, { basis: 'current', rate: 10 });
  assert.deepEqual(r.lines.map((l) => l.unit_price), [495, 165, 49.49]);   // 183.33×0.9=164.997→165.00, 54.99×0.9=49.491→49.49
  assert.equal(r.subtotal, 495 * 3 + 165 * 7 + 49.49);
  assert.equal(r.lines[0].discount_rate, 50.5);
  // 비례 조정으로 단가×수량≠금액인 줄: 금액 기준으로 계산
  const odd = repriceByDiscount([{ id: 9, qty: 3, list_price: 100, unit_price: 33.33, line_amount_mxn: 100.01 }], { basis: 'current', rate: 0 });
  assert.equal(odd.lines[0].unit_price, 33.34);
  assert.equal(odd.lines[0].line_amount_mxn, 100.02);
});

test('IVA 세율은 인보이스 값을 따른다', () => {
  const r = repriceByDiscount([{ id: 1, qty: 1, list_price: 100 }], { basis: 'list', rate: 0, ivaRate: 8 });
  assert.equal(r.iva, 8); assert.equal(r.total, 108);
});

test('오류 — 기준·할인율 범위·정가 0·수량 0·라인 없음', () => {
  assert.equal(repriceByDiscount(L, { basis: 'x', rate: 1 }).error, 'bad_basis');
  for (const bad of [-1, 100, 150, '', null, 'abc']) assert.equal(repriceByDiscount(L, { basis: 'list', rate: bad }).error, 'bad_rate', String(bad));
  const np = repriceByDiscount([...L, { id: 4, code: 'Z', qty: 1, list_price: 0, line_amount_mxn: 10 }], { basis: 'list', rate: 10 });
  assert.equal(np.error, 'no_list_price'); assert.deepEqual(np.codes, ['Z']);
  // 정가 0 이어도 「현재 매출액 대비」는 가능
  assert.equal(repriceByDiscount([{ id: 4, code: 'Z', qty: 2, list_price: 0, line_amount_mxn: 10, discount_rate: 0 }], { basis: 'current', rate: 10 }).subtotal, 9);
  assert.equal(repriceByDiscount([{ id: 5, code: 'Q', qty: 0, list_price: 10, line_amount_mxn: 0 }], { basis: 'current', rate: 10 }).error, 'zero_qty');
  assert.equal(repriceByDiscount([], { basis: 'list', rate: 10 }).error, 'no_lines');
});

test('effectiveDiscountPct', () => {
  assert.equal(effectiveDiscountPct(L), Math.round((1 - (1650 + 1283.31 + 54.99) / (3000 + 333.33 * 7 + 99.99)) * 10000) / 100);
  assert.equal(effectiveDiscountPct([{ qty: 1, list_price: 0, line_amount_mxn: 5 }]), null);
});

// ── 종단 ──
const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
let query, app;
const ID = {}; const tok = {};

test('boot', { skip: SKIP }, async () => {
  ({ query } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const salesRoutes = (await import('../src/routes/salesRoutes.js')).default;
  const devRoutes = (await import('../src/routes/devRequestRoutes.js')).default;
  // 정리
  await query(`UPDATE sales_invoices SET txn_id=NULL WHERE sat_no LIKE 'DISCTEST%'`);
  await query(`DELETE FROM transactions WHERE memo LIKE 'DISCTEST%'`);
  await query(`DELETE FROM sales_invoice_lines WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE sat_no LIKE 'DISCTEST%')`);
  await query(`DELETE FROM sales_invoices WHERE sat_no LIKE 'DISCTEST%'`);
  await query(`DELETE FROM products WHERE code LIKE 'DISCTEST%'`);
  await query(`DELETE FROM customers WHERE code LIKE 'DISCTEST%'`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'disctest%')`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'disctest%')`);
  await query(`DELETE FROM users WHERE login_id LIKE 'disctest%'`);
  const mk = async (role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,$3,$4) RETURNING id`, ['DISCTEST ' + role, role, hashPin('1234'), login])).rows[0].id);
  ID.dir = await mk('director', 'disctest_dir');
  ID.sup = await mk('sales_support', 'disctest_sup');
  ID.sal = await mk('sales', 'disctest_sal');
  for (const u of [ID.sup, ID.sal]) await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'sales','anywhere','edit')`, [u]);
  ID.cust = Number((await query(`INSERT INTO customers (code, name) VALUES ('DISCTEST-C','DISCTEST Cliente') RETURNING id`)).rows[0].id);
  ID.pA = Number((await query(`INSERT INTO products (code, name, list_price) VALUES ('DISCTEST-A','Amort A',1000) RETURNING id`)).rows[0].id);
  ID.pB = Number((await query(`INSERT INTO products (code, name, list_price) VALUES ('DISCTEST-B','Brazo B',333.33) RETURNING id`)).rows[0].id);
  const mkInv = async (sat, ym) => {
    const inv = Number((await query(
      `INSERT INTO sales_invoices (customer_id, inv_date, sat_no, status, subtotal_mxn, iva_mxn, total_mxn)
       VALUES ($1, ${ym ? `'${ym}-05'` : `(now() AT TIME ZONE 'America/Mexico_City')::date`}, $2, 'posted', 2933.31, 469.33, 3402.64) RETURNING id`, [ID.cust, sat])).rows[0].id);
    await query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, discount_rate, unit_price, line_amount_mxn) VALUES
      ($1,$2,3,1000,45,550,1650), ($1,$3,7,333.33,45,183.33,1283.31)`, [inv, ID.pA, ID.pB]);
    const tx = Number((await query(
      `INSERT INTO transactions (txn_date, direction, amount, currency, fx_rate, amount_mxn, category_code, status, kind, approved, sales_invoice_id, memo)
       VALUES (CURRENT_DATE,'in',3402.64,'MXN',1,3402.64,'4010','plan','invoice',true,$1,'DISCTEST ar') RETURNING id`, [inv])).rows[0].id);
    await query(`UPDATE sales_invoices SET txn_id=$1 WHERE id=$2`, [tx, inv]);
    return { inv, tx };
  };
  Object.assign(ID, { cur: await mkInv('DISCTEST-1') });
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(salesRoutes);
  await app.register(devRoutes);
  await app.ready();
  for (const k of ['dir', 'sup', 'sal']) tok[k] = app.jwt.sign({ sub: ID[k] });
});

const get = (w, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[w] } });
const post = (w, url, body) => app.inject({ method: 'POST', url, payload: body, headers: { authorization: 'Bearer ' + tok[w] } });

test('invoice-lines — list_price·discount_rate·iva_rate 숫자 · 최종단가 엑셀 플래그(디렉터·영업지원만)', { skip: SKIP }, async () => {
  const d = (await get('dir', `/api/dashboard/funnel/invoice-lines?invoice_id=${ID.cur.inv}`)).json();
  assert.equal(d.invoice.can_price_xls, true);
  assert.equal(d.invoice.iva_rate, 16);
  assert.equal(d.items[1].list_price, 333.33);
  assert.equal(d.items[1].discount_rate, 45);
  const s = await get('sup', `/api/dashboard/funnel/invoice-lines?invoice_id=${ID.cur.inv}`);
  assert.equal(s.statusCode, 200);
  assert.equal(s.json().invoice.can_price_xls, true, '영업지원(Maria)');
  assert.equal(s.json().invoice.can_adjust, false, '영업지원은 수정 불가');
  const v = await get('sal', `/api/dashboard/funnel/invoice-lines?invoice_id=${ID.cur.inv}`);
  if (v.statusCode === 200) assert.equal(v.json().invoice.can_price_xls, false, '영업사원');
});

test('adjust-discount — 권한: 영업지원·영업사원 403', { skip: SKIP }, async () => {
  for (const w of ['sup', 'sal']) {
    const r = await post(w, `/api/sales/${ID.cur.inv}/adjust-discount`, { basis: 'list', rate: 50 });
    assert.equal(r.statusCode, 403, w);
  }
});

test('adjust-discount — 정가 대비 50%: 라인·인보이스·입금예정 동기화, 감사로그', { skip: SKIP }, async () => {
  const r = await post('dir', `/api/sales/${ID.cur.inv}/adjust-discount`, { basis: 'list', rate: 50 });
  assert.equal(r.statusCode, 200, r.body);
  const o = r.json();
  assert.deepEqual(o.after, { subtotal: 2666.69, iva: 426.67, total: 3093.36 });
  assert.equal(o.before.total, 3402.64);
  const lines = (await query(`SELECT qty, unit_price, line_amount_mxn, discount_rate FROM sales_invoice_lines WHERE invoice_id=$1 ORDER BY id`, [ID.cur.inv])).rows;
  assert.deepEqual(lines.map((l) => [Number(l.unit_price), Number(l.line_amount_mxn), Number(l.discount_rate)]), [[500, 1500, 50], [166.67, 1166.69, 50]]);
  const inv = (await query(`SELECT subtotal_mxn, iva_mxn, total_mxn FROM sales_invoices WHERE id=$1`, [ID.cur.inv])).rows[0];
  assert.deepEqual([Number(inv.subtotal_mxn), Number(inv.iva_mxn), Number(inv.total_mxn)], [2666.69, 426.67, 3093.36]);
  const tx = (await query(`SELECT amount, amount_mxn FROM transactions WHERE id=$1`, [ID.cur.tx])).rows[0];
  assert.equal(Number(tx.amount), 3093.36); assert.equal(Number(tx.amount_mxn), 3093.36);
  const log = (await query(`SELECT detail FROM audit_log WHERE user_id=$1 AND target=$2 ORDER BY id DESC LIMIT 1`, [ID.dir, `sales_invoice:${ID.cur.inv}`])).rows[0];
  assert.ok(log && JSON.stringify(log.detail).includes('adjustDiscount'));
  // 엑셀이 읽는 응답도 새 값
  const d = (await get('sup', `/api/dashboard/funnel/invoice-lines?invoice_id=${ID.cur.inv}`)).json();
  assert.equal(d.invoice.subtotal_mxn, 2666.69);
  assert.equal(d.items.reduce((s, l) => Math.round((s + l.line_amount_mxn) * 100) / 100, 0), 2666.69);
});

test('adjust-discount — 같은 정가 대비 재적용은 그대로 · 현재 대비 10% 는 누적', { skip: SKIP }, async () => {
  const again = (await post('dir', `/api/sales/${ID.cur.inv}/adjust-discount`, { basis: 'list', rate: 50 })).json();
  assert.equal(again.after.total, 3093.36);
  const cur = (await post('dir', `/api/sales/${ID.cur.inv}/adjust-discount`, { basis: 'current', rate: 10 })).json();
  assert.equal(cur.after.subtotal, 450 * 3 + 150 * 7);   // 500×0.9, 166.67×0.9=150.003→150.00
  const lines = (await query(`SELECT discount_rate FROM sales_invoice_lines WHERE invoice_id=$1 ORDER BY id`, [ID.cur.inv])).rows;
  assert.deepEqual(lines.map((l) => Number(l.discount_rate)), [55, 55]);
});

test('adjust-discount — 400/404/409 · 게시 안 된 인보이스', { skip: SKIP }, async () => {
  assert.equal((await post('dir', `/api/sales/${ID.cur.inv}/adjust-discount`, { basis: 'list', rate: 100 })).statusCode, 400);
  assert.equal((await post('dir', `/api/sales/${ID.cur.inv}/adjust-discount`, { basis: 'nope', rate: 10 })).statusCode, 400);
  assert.equal((await post('dir', `/api/sales/99999999/adjust-discount`, { basis: 'list', rate: 10 })).statusCode, 404);
  await query(`UPDATE sales_invoices SET status='draft' WHERE id=$1`, [ID.cur.inv]).catch(() => null);
  const st = (await query(`SELECT status FROM sales_invoices WHERE id=$1`, [ID.cur.inv])).rows[0].status;
  if (st !== 'posted') {
    assert.equal((await post('dir', `/api/sales/${ID.cur.inv}/adjust-discount`, { basis: 'list', rate: 10 })).json().error, 'not_posted');
    await query(`UPDATE sales_invoices SET status='posted' WHERE id=$1`, [ID.cur.inv]);
  }
  // 정가 0 인 줄 → 정가 대비 불가, 현재 대비는 가능
  await query(`UPDATE sales_invoice_lines SET list_price=0 WHERE invoice_id=$1 AND product_id=$2`, [ID.cur.inv, ID.pB]);
  const np = await post('dir', `/api/sales/${ID.cur.inv}/adjust-discount`, { basis: 'list', rate: 10 });
  assert.equal(np.statusCode, 409); assert.equal(np.json().error, 'no_list_price'); assert.deepEqual(np.json().codes, ['DISCTEST-B']);
  assert.equal((await post('dir', `/api/sales/${ID.cur.inv}/adjust-discount`, { basis: 'current', rate: 0 })).statusCode, 200);
});

test('cleanup', { skip: SKIP }, async () => {
  await app.close();
  const { pool } = await import('../src/db.js');
  await pool.end();
});
