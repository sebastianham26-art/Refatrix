/* 2026-10-22 · 견적 엑셀(전체 견적 · Top 500 · 가격표) 수량열 4종 — 운영 라우트를 실 PostgreSQL 에서 그대로 실행.
   회귀 가드: 0901b 에서 넣은 운송중·예약·생산중 계산이 price-list 에서 빠져 엑셀이 폴백
   (En tránsito 항상 0 · En producción = 발주잔량 전체 · Disponible = Existencia)으로 찍혔다.
   실행: TEST_PG_URL=postgres://... node test/quote_pricelist_qty_e2e.test.mjs  (없으면 skip) */
const URL = process.env.TEST_PG_URL;
if (!URL) { console.log('TEST_PG_URL 없음 → skip'); process.exit(0); }
process.env.DATABASE_URL = URL;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const { pool, query } = await import('../src/db.js');
const { plQty } = await import('../src/quoteQtyCols.js');
const routes = (await import('../src/routes/quoteRoutes.js')).default;
const H = {}; const app = { log: { info() {}, warn() {}, error() {} } };
for (const m of ['get', 'post', 'put', 'patch', 'delete']) app[m] = (p, o, h) => { H[m.toUpperCase() + ' ' + p] = (typeof o === 'function' ? o : h); };
await routes(app);
clearInterval(globalThis.__refatrixExpirySweeper);   // 스위퍼가 테스트 예약을 건드리지 않게
const call = (qs) => H['GET /api/quotes/price-list']({ ctx: { perm: { role: 'director' } }, query: qs }, { code() { return this; }, send(b) { return b; } });

console.log('\n① 순수 계산 (plQty)');
const u = plQty({ stock_qty: '50', reserved_qty: '15', incoming_qty: '40', backorder_qty: '100', incoming_eta: '2026-11-05' });
ok('가용 = 50 − 15 = 35', u.avail_qty === 35, u);
ok('운송중 40 · 생산중 100 − 40 = 60', u.incoming_qty === 40 && u.production_qty === 60, u);
ok('예약이 재고보다 커도 가용은 0', plQty({ stock_qty: 3, reserved_qty: 9 }).avail_qty === 0);
ok('발주 없이 선적만 있어도 생산중은 0(음수 없음)', plQty({ stock_qty: 0, incoming_qty: 12, backorder_qty: 0 }).production_qty === 0);
ok('현재고 null 이면 가용도 null', plQty({ stock_qty: null }).avail_qty === null);

// ---- 픽스처 ----
const TAG = 'TSTPLQ';
const mk = async (code, stock) => Number((await query(`INSERT INTO products (code, name, stock_qty, list_price) VALUES ($1,$1,$2,100) RETURNING id`, [code, stock])).rows[0].id);
const A = await mk(TAG + 'A', 50), B = await mk(TAG + 'B', 0), C = await mk(TAG + 'C', 10);
await query(`INSERT INTO ctr_vio_rank (ctr_code, vio_rank, vio_units, vio_model) VALUES ($1,1,999999999,'TEST') ON CONFLICT DO NOTHING`, [TAG + 'A']);
// 발주: A 100 · B 30 (미입고)
const po = Number((await query(`INSERT INTO purchase_orders (ref_no) VALUES ($1) RETURNING id`, [TAG + '-PO'])).rows[0].id);
for (const [pid, code, qty] of [[A, 'A', 100], [B, 'B', 30]]) {
  await query(`INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd) VALUES ($1,$2,$3,$4,1,$4)`, [po, pid, TAG + code, qty]);
}
// 선적: 마감 전(incoming) A 40 · B 30 · 미등록 SKU 1줄 / 마감된(closed) 선적 A 999 — 운송중에서 빠져야 함
const mkShip = async (status, items) => {
  const s = Number((await query(`INSERT INTO inbound_shipments (status, eta) VALUES ($1, '2026-11-05') RETURNING id`, [status])).rows[0].id);
  const pl = Number((await query(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no) VALUES ($1,$2,1) RETURNING id`, [s, TAG + '-PO'])).rows[0].id);
  for (const [pid, code, qty] of items) await query(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, product_id, input_code, cartons, qty) VALUES ($1,$2,$3,$4,1,$5)`, [pl, s, pid, code, qty]);
  return s;
};
const S1 = await mkShip('incoming', [[A, TAG + 'A', 40], [B, TAG + 'B', 30], [null, TAG + 'ZZ', 7]]);
const S2 = await mkShip('closed', [[A, TAG + 'A', 999]]);
// 견적 예약: 살아 있는 draft A 15 / 만료된 draft A 7(제외) / 매출전환 A 5(제외) / 포장지시 출력된(만료 지남) confirmed C 4(포함)
const mkQ = async (status, expires, packed, pid, resv) => {
  const q = Number((await query(`INSERT INTO quotes (status, reserve_expires_at, packing_printed_at) VALUES ($1, now() + ($2 || ' hours')::interval, $3) RETURNING id`, [status, String(expires), packed ? new Date() : null])).rows[0].id);
  await query(`INSERT INTO quote_lines (quote_id, product_id, qty, reserved_qty) VALUES ($1,$2,$3,$3)`, [q, pid, resv]);
  return q;
};
const QS = [await mkQ('draft', 24, false, A, 15), await mkQ('draft', -1, false, A, 7),
            await mkQ('converted', 24, false, A, 5), await mkQ('confirmed', -1, true, C, 4)];

const check = (label, items) => {
  const by = Object.fromEntries(items.filter((x) => x.ctr_code && x.ctr_code.startsWith(TAG)).map((x) => [x.ctr_code, x]));
  const a = by[TAG + 'A'], b = by[TAG + 'B'], c = by[TAG + 'C'];
  ok(`${label} · A 현재고 50 · 가용 35(만료·전환 견적 제외)`, a && a.stock_qty === 50 && a.avail_qty === 35 && a.reserved_qty === 15, a);
  ok(`${label} · A 운송중 40(마감 선적 999 제외) · 생산중 60 · ETA`, a && a.incoming_qty === 40 && a.production_qty === 60 && a.incoming_eta === '2026-11-05', a);
  ok(`${label} · A 운송중 + 생산중 = 발주잔량 100`, a && a.incoming_qty + a.production_qty === a.backorder_qty);
  if (b) ok(`${label} · B 전량 선적 → 운송중 30 · 생산중 0`, b.incoming_qty === 30 && b.production_qty === 0, b);
  if (c) ok(`${label} · C 포장지시 출력 견적은 만료 지나도 예약 유지 → 가용 6`, c.avail_qty === 6, c);
};

console.log('\n② 📚 전체 견적 (?all=1)');
check('전체', (await call({ all: '1' })).items);
console.log('\n③ ⭐ Top 500 (?top=500)');
check('Top500', (await call({ top: '500' })).items);
console.log('\n④ 기본 가격표');
check('가격표', (await call({})).items);

// 정리
await query(`DELETE FROM quote_lines WHERE quote_id = ANY($1)`, [QS]);
await query(`DELETE FROM quotes WHERE id = ANY($1)`, [QS]);
for (const s of [S1, S2]) {
  await query(`DELETE FROM inbound_pallet_items WHERE shipment_id=$1`, [s]);
  await query(`DELETE FROM inbound_pallets WHERE shipment_id=$1`, [s]);
  await query(`DELETE FROM inbound_shipments WHERE id=$1`, [s]);
}
await query(`DELETE FROM purchase_order_lines WHERE po_id=$1`, [po]);
await query(`DELETE FROM purchase_orders WHERE id=$1`, [po]);
await query(`DELETE FROM ctr_vio_rank WHERE ctr_code=$1`, [TAG + 'A']);
await query(`DELETE FROM products WHERE id = ANY($1)`, [[A, B, C]]);
await pool.end();
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
