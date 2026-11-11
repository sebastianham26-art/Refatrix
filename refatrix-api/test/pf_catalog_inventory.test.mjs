// =====================================================================
// pf_catalog_inventory.test.mjs — 2026-11-11 · 플랫폼 「재고연관성」
//   GET /api/pf-catalog/purchases · GET /api/pf-catalog/stock
//   실제 서버 + PostgreSQL(TEST_PG_URL):
//     구매: 발주 기준 · 취소 · 삭제 제외 · 같은 발주 여러 줄 = 1건 · 첫/최근 발주일 · 입고 · 미입고 잔량 ·
//           미연결 줄을 코드로 맞춤(하이픈·소문자) · 못 맞춘 줄 unmatched · 발주 없는 코드 미포함 · PRO·키트 제외
//     재고: 가용 = 실물 − 예약(만료 예약 · 취소 견적 제외 · 포장지시 출력은 만료여도 포함) · 0 이하 없음 ·
//           재고 0 코드도 포함(has_stock) · 운송 중은 가용에 미포함 · ?codes · 캐시 · fresh · 원가·금액 없음 · ERP 토큰 401
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/pf_catalog_inventory.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pf-catalog';

test('B. 실제 서버 + PostgreSQL — purchases · stock', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  const MINE = `SELECT id FROM products WHERE code LIKE 'PFI%' OR code IN ('PROPFI1','K99101')`;
  async function cleanup() {
    const shIds = (await query(`SELECT DISTINCT shipment_id FROM inbound_pallets WHERE order_no='PFI-TEST'`)).rows.map((x) => x.shipment_id);
    await query(`DELETE FROM inbound_pallet_items WHERE input_code LIKE 'PFI%'`);
    await query(`DELETE FROM inbound_pallets WHERE order_no='PFI-TEST'`);
    if (shIds.length) await query(`DELETE FROM inbound_shipments WHERE id = ANY($1)`, [shIds]);
    await query(`DELETE FROM purchase_order_lines WHERE po_id IN (SELECT id FROM purchase_orders WHERE ref_no LIKE 'PFI-%')`);
    await query(`DELETE FROM purchase_orders WHERE ref_no LIKE 'PFI-%'`);
    await query(`DELETE FROM quote_lines WHERE product_id IN (${MINE})`);
    await query(`DELETE FROM quotes WHERE quote_no LIKE 'PFI-%'`);
    await query(`DELETE FROM products WHERE id IN (${MINE})`);
  }
  after(async () => { await cleanup().catch((e) => console.error('cleanup', e.message)); await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });

  const V = await import('../src/surveyViewer.js');
  const keepLog = V.platformApi.log;
  V.platformApi.log = async (tok) => (tok.startsWith('aaaaaaaa') ? { ok: true } : { ok: false, invalid: true });
  t.after(() => { V.platformApi.log = keepLog; });
  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  t.after(() => app.close());
  const one = async (sql, a) => (await query(sql, a)).rows[0];

  await cleanup();
  const mk = (code, stock) => one(`INSERT INTO products (code, name, list_price, stock_qty, avg_cost, is_active) VALUES ($1,'X',100,$2,55.5,true) RETURNING id`, [code, stock]).then((r) => Number(r.id));
  const A = await mk('PFI001', 9); const B = await mk('PFI-002', 0); const Cc = await mk('PFI003', 3); const D = await mk('PFI004', 1);
  const PRO = await mk('PROPFI1', 5); const KIT = await mk('K99101', 5);

  // ── 발주 ──
  let pn = 0;
  const po = async (status, date, lines, { deleted = false } = {}) => {
    const p = await one(`INSERT INTO purchase_orders (ref_no, order_date, status, deleted_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['PFI-' + (++pn), date, status, deleted ? new Date() : null]);
    for (const [pid, code, qty, rec] of lines) {
      await query(`INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd, received_qty) VALUES ($1,$2,$3,$4,7.25,$5,$6)`,
        [p.id, pid, code, qty, qty * 7.25, rec]);
    }
  };
  await po('received', '2024-03-02', [[A, 'PFI001', 20, 20], [A, 'PFI001', 10, 10]]);   // 1건 두 줄
  await po('shipped', '2026-10-01', [[A, 'PFI001', 20, 0]]);
  await po('cancelled', '2026-10-05', [[A, 'PFI001', 999, 0]]);                          // 제외
  await po('recorded', '2026-10-06', [[A, 'PFI001', 999, 0]], { deleted: true });        // 제외
  await po('recorded', '2025-12-15', [[null, 'pfi002', 7, 3]]);                          // 미연결 → 코드(하이픈·소문자)로 맞춤
  await po('recorded', '2025-12-16', [[null, 'ZZOLD-77', 4, 0]]);                        // 못 맞춤 → unmatched
  await po('recorded', '2025-12-17', [[PRO, 'PROPFI1', 4, 0], [KIT, 'K99101', 4, 0]]);   // 대상 밖

  // ── 견적 예약 ──
  let qn = 0;
  const quote = async (status, pid, resv, { expired = false, printed = false } = {}) => {
    const q = await one(`INSERT INTO quotes (quote_no, status, reserve_expires_at, packing_printed_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['PFI-' + (++qn), status, expired ? new Date(Date.now() - 3600e3) : new Date(Date.now() + 3600e3), printed ? new Date() : null]);
    await query(`INSERT INTO quote_lines (quote_id, product_id, qty, reserved_qty) VALUES ($1,$2,$3,$3)`, [q.id, pid, resv]);
  };
  await quote('confirmed', A, 2);                          // 예약 2
  await quote('draft', A, 5, { expired: true });           // 만료 예약 → 제외
  await quote('draft', A, 1, { expired: true, printed: true });   // 포장지시 출력 → 포함 (예약 3)
  await quote('cancelled', A, 4);                          // 제외
  await quote('confirmed', D, 5);                          // 재고 1 < 예약 5 → 가용 0

  // ── 운송 중(가용에 안 들어감) ──
  const sh = await one(`INSERT INTO inbound_shipments (status, eta) VALUES ('incoming', CURRENT_DATE + 10) RETURNING id`);
  const pl = await one(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no) VALUES ($1,'PFI-TEST',1) RETURNING id`, [sh.id]);
  await query(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, input_code, cartons, qty, product_id) VALUES ($1,$2,'PFI003',1,6,$3)`, [pl.id, sh.id, Cc]);

  // ── 인증 ──
  for (const url of ['/api/pf-catalog/purchases', '/api/pf-catalog/stock']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    const erpTok = app.jwt.sign({ sub: 1, typ: 'erp' });
    assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + erpTok } })).statusCode, 401, 'ERP 토큰 401');
  }
  const lg = await app.inject({ method: 'POST', url: '/api/pf-catalog/login', payload: { token: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Park CTR', user_key: '12' } });
  const H = { authorization: 'Bearer ' + lg.json().token };
  const get = async (u) => { const x = await app.inject({ method: 'GET', url: u, headers: H }); assert.equal(x.statusCode, 200, x.body); return x.json(); };
  const by = (res) => Object.fromEntries(res.items.map((x) => [x.code, x]));

  // ── 구매이력 ──
  let R = await get('/api/pf-catalog/purchases?fresh=1');
  assert.ok(R.updated_at && R.source);
  let M = by(R);
  assert.deepEqual(M.PFI001, { code: 'PFI001', po_qty: 50, po_count: 2, first_po_at: '2024-03-02', last_po_at: '2026-10-01', received_qty: 30, open_qty: 20 });
  assert.deepEqual([M['PFI-002'].po_qty, M['PFI-002'].open_qty, M['PFI-002'].po_count], [7, 4, 1], '미연결 줄을 코드로 맞춤');
  assert.equal(M.PFI003, undefined, '발주 없는 코드는 빠진다'); assert.equal(M.PFI004, undefined);
  assert.equal(M.PROPFI1, undefined); assert.equal(M.K99101, undefined, 'PRO · 키트 제외');
  assert.ok(R.unmatched.some((u) => u.input_code === 'ZZOLD-77' && u.qty === 4), '못 맞춘 줄은 unmatched');
  assert.ok(!R.unmatched.some((u) => u.input_code === 'PFI002'), '맞춘 줄은 unmatched 아님');
  assert.ok(!/unit_cost|amount|7\.25|usd/i.test(JSON.stringify(R)), '원가 · 금액 없음');
  R = await get('/api/pf-catalog/purchases?codes=pfi001,PFI003');
  assert.deepEqual(R.items.map((x) => x.code), ['PFI001']);

  // ── 재고 ──
  R = await get('/api/pf-catalog/stock?fresh=1');
  M = by(R);
  assert.deepEqual(M.PFI001, { code: 'PFI001', stock_qty: 6, total_qty: 9, reserved_qty: 3, has_stock: true });
  assert.deepEqual(M['PFI-002'], { code: 'PFI-002', stock_qty: 0, total_qty: 0, reserved_qty: 0, has_stock: false }, '재고 0 도 나온다');
  assert.deepEqual(M.PFI003, { code: 'PFI003', stock_qty: 3, total_qty: 3, reserved_qty: 0, has_stock: true, transit_qty: 6 }, '운송 중은 가용에 미포함');
  assert.deepEqual([M.PFI004.stock_qty, M.PFI004.has_stock], [0, false], '예약 > 재고 → 0');
  assert.equal(M.PROPFI1, undefined); assert.equal(M.K99101, undefined);
  assert.ok(R.count === R.count_stock + R.count_zero);
  assert.ok(!/avg_cost|55\.5|list_price/i.test(JSON.stringify(R)), '원가 · 가격 없음');
  R = await get('/api/pf-catalog/stock?codes=PFI003');
  assert.deepEqual(R.items.map((x) => x.code), ['PFI003']);

  // ── 캐시 · fresh ──
  await query(`UPDATE products SET stock_qty = 20 WHERE id=$1`, [Cc]);
  assert.equal(by(await get('/api/pf-catalog/stock')).PFI003.stock_qty, 3, '캐시');
  assert.equal(by(await get('/api/pf-catalog/stock?fresh=1')).PFI003.stock_qty, 20, 'fresh');
});
