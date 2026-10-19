/* 2026-10-19 · 패킹리스트 없이 붙여넣은 입고(카톤 0 · 오더별 팔렛 1) — 운영 라우트를 실 PostgreSQL 에서 그대로 실행.
   생성 → 하차 → 검수 확정(스캔 0) → 마감 → 재고 + 수량 그대로, 창고 종료 조건(적치 완료) 충족까지.
   실행: TEST_PG_URL=postgres://... node test/inbound_paste_e2e.test.mjs  (없으면 skip) */
const URL = process.env.TEST_PG_URL;
if (!URL) { console.log('TEST_PG_URL 없음 → skip'); process.exit(0); }
process.env.DATABASE_URL = URL;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };

const { pool, query } = await import('../src/db.js');
const { hashPin } = await import('../src/auth.js');
const routes = (await import('../src/routes/inboundRoutes.js')).default;
const H = {}; const app = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) app[m] = (p, o, h) => { H[m.toUpperCase() + ' ' + p] = (typeof o === 'function' ? o : h); };
await routes(app);
const TAG = 'TSTPASTE';
const uid = Number((await query(`INSERT INTO users (name, role, pin_hash) VALUES ('${TAG}','director',$1) RETURNING id`, [hashPin('1234')])).rows[0].id);
const call = (k, { body = {}, params = {} } = {}) => H[k]({ user: { sub: uid }, ctx: { perm: { userId: uid, role: 'director' }, deviceId: null }, body, params, query: {} }, { code() { return this; }, send(b) { return b; } });
const mk = async (code, stock) => Number((await query(`INSERT INTO products (code, name, stock_qty) VALUES ($1,$1,$2) RETURNING id`, [code, stock])).rows[0].id);
const A = await mk(TAG + 'A', 5), B = await mk(TAG + 'B', 0);

// 화면이 보내는 그대로(parsePasteRows 결과)
const rows = [
  { order_no: 'PO-T-01', pl_no: 1, code: TAG + 'A', cartons: 0, qty: 1200, desc: '', box_from: null, box_to: null },
  { order_no: 'PO-T-01', pl_no: 1, code: TAG + 'B', cartons: 0, qty: 24, desc: '', box_from: null, box_to: null },
  { order_no: 'PO-T-02', pl_no: 1, code: TAG + 'A', cartons: 0, qty: 10, desc: '', box_from: null, box_to: null },
  { order_no: 'PO-T-02', pl_no: 1, code: TAG + 'ZZ', cartons: 0, qty: 3, desc: '', box_from: null, box_to: null },
];
console.log('\n① 미리보기 · 생성');
const pv = await call('POST /api/inbound/preview', { body: { rows } });
ok('미리보기: 오더 2 → 팔렛 2 · 카톤 0 · 수량 1,237', pv.ok && pv.summary.pallets === 2 && pv.summary.cartons === 0 && pv.summary.qty === 1237, pv);
ok('미등록 SKU 표시', pv.summary.unmatched.includes(TAG + 'ZZ'));
const cr = await call('POST /api/inbound', { body: { rows, eta: '2026-10-25', invoice_no: null } });
ok('생성 성공(인보이스 없이)', cr.ok && cr.id > 0, cr);
const id = cr.id;
const pals = (await query(`SELECT id, order_no, cartons_expected, qty_expected FROM inbound_pallets WHERE shipment_id=$1 ORDER BY order_no`, [id])).rows;
ok('팔렛 2개 · PO-T-01 수량 1224', pals.length === 2 && Number(pals[0].qty_expected) === 1224 && Number(pals[0].cartons_expected) === 0, pals);

console.log('\n② 하차 → 검수 확정(스캔 0) → 마감');
for (const p of pals) {
  const u = await call('POST /api/inbound/:id/pallets/:pid/unload', { params: { id, pid: p.id } });
  const c = await call('POST /api/inbound/:id/pallets/:pid/confirm', { params: { id, pid: p.id }, body: {} });
  ok(`${p.order_no} 하차·검수 확정`, u.ok && c.ok, { u, c });
}
const cl = await call('POST /api/inbound/:id/close', { params: { id }, body: { pin: '1234' } });
ok('마감 성공', cl && cl.ok, cl);
const st = Object.fromEntries((await query(`SELECT code, stock_qty FROM products WHERE id = ANY($1)`, [[A, B]])).rows.map((r) => [r.code, Number(r.stock_qty)]));
ok('재고 A 5 + 1200 + 10 = 1215', st[TAG + 'A'] === 1215, st);
ok('재고 B 0 + 24 = 24', st[TAG + 'B'] === 24, st);

console.log('\n③ 창고 종료 조건');
const ck = await call('POST /api/inbound/:id/wh-finish/request', { params: { id }, body: {} }).catch((e) => ({ err: e.message }));
ok('적치 대기 없음(카톤 0 라인은 적치 대상 아님)', ck && (ck.ok || (ck.check && ck.check.put_pending === 0)), ck);

// 정리
await query(`DELETE FROM inbound_scans WHERE pallet_id IN (SELECT id FROM inbound_pallets WHERE shipment_id=$1)`, [id]).catch(() => {});
await query(`DELETE FROM inbound_pallet_items WHERE shipment_id=$1`, [id]);
await query(`DELETE FROM inbound_pallets WHERE shipment_id=$1`, [id]);
await query(`DELETE FROM inbound_shipments WHERE id=$1`, [id]).catch(() => {});
await query(`DELETE FROM stock_movements WHERE product_id = ANY($1)`, [[A, B]]).catch(() => {});
await query(`DELETE FROM products WHERE id = ANY($1)`, [[A, B]]).catch(() => {});
await query(`DELETE FROM audit_log WHERE user_id=$1`, [uid]).catch(() => {});
await query(`DELETE FROM users WHERE id=$1`, [uid]).catch(() => {});
await pool.end();
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
