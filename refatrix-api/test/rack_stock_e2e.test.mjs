// =====================================================================
// 랙별 재고(제품 × 랙 × 수량) — 종단 검증 (실 PostgreSQL)  0245 · 2026-10-01
//   디렉터 결정: ① 실사 반영 시 랙마다 센 수량 저장 ② 포장지시서는 fast moving 랙 먼저
//               ③ 포장 때 랙 스캔 없이 지시서 위치에서 자동 차감
//   실행: TEST_PG_URL=postgres://... node --test test/rack_stock_e2e.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app, rs;
const tok = {};
const ID = {};
const TAG = 'RSTEST';
const PIN = '4321';

// 테스트가 만든 고객·인보이스에 매달린 행을 FK 카탈로그 기준으로 전부 지운다(자동 단계·CRM 아웃박스 등).
async function purgeRefs(table, ids) {
  if (!ids.length) return;
  const fks = (await query(
    `SELECT c.conrelid::regclass::text AS t, a.attname AS col
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.confrelid = $1::regclass AND c.contype='f'`, [table])).rows;
  for (let pass = 0; pass < 3; pass++) {
    for (const f of fks) {
      if (f.t === table) continue;
      await query(`DELETE FROM ${f.t} WHERE ${f.col} = ANY($1::bigint[])`, [ids]).catch(() => {});
    }
  }
}

async function cleanup() {
  const P = `SELECT id FROM products WHERE code LIKE '${TAG}%' OR code LIKE 'PRO${TAG}%'`;
  const custIds = (await query(`SELECT id FROM customers WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  const invIds = custIds.length ? (await query(`SELECT id FROM sales_invoices WHERE customer_id = ANY($1::bigint[])`, [custIds])).rows.map((r) => Number(r.id)) : [];
  await query(`DELETE FROM product_rack_moves WHERE product_id IN (${P})`).catch(() => {});
  await query(`DELETE FROM product_rack_stock WHERE product_id IN (${P})`).catch(() => {});
  await query(`DELETE FROM quote_pick_alloc WHERE product_id IN (${P})`).catch(() => {});
  await query(`DELETE FROM rack_moves WHERE product_id IN (${P})`);
  if (invIds.length) {
    await query(`UPDATE sales_invoices SET txn_id=NULL WHERE id = ANY($1::bigint[])`, [invIds]).catch(() => {});
    await query(`DELETE FROM sales_invoice_lines WHERE invoice_id = ANY($1::bigint[])`, [invIds]).catch(() => {});
    await purgeRefs('sales_invoice_lines', (await query(`SELECT id FROM sales_invoice_lines WHERE invoice_id = ANY($1::bigint[])`, [invIds])).rows.map((r) => Number(r.id)));
    await purgeRefs('sales_invoices', invIds);
    await query(`DELETE FROM sales_invoice_lines WHERE invoice_id = ANY($1::bigint[])`, [invIds]);
    await query(`DELETE FROM sales_invoices WHERE id = ANY($1::bigint[])`, [invIds]);
  }
  await query(`DELETE FROM stock_shortages WHERE product_id IN (${P})`);
  await query(`DELETE FROM stock_movements WHERE product_id IN (${P})`);
  await query(`DELETE FROM quote_packing_docs WHERE quote_id IN (SELECT id FROM quotes WHERE quote_no LIKE '${TAG}%')`);
  await query(`DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM quotes WHERE quote_no LIKE '${TAG}%')`);
  await purgeRefs('quotes', (await query(`SELECT id FROM quotes WHERE quote_no LIKE '${TAG}%'`)).rows.map((r) => Number(r.id)));
  await query(`DELETE FROM quotes WHERE quote_no LIKE '${TAG}%'`);
  await query(`DELETE FROM stock_count_adjustments WHERE count_id IN (SELECT id FROM stock_counts WHERE scope_note LIKE '${TAG}%')`);
  await query(`DELETE FROM stock_counts WHERE scope_note LIKE '${TAG}%'`);
  await query(`DELETE FROM inbound_pallet_items WHERE input_code LIKE '${TAG}%'`);
  await query(`DELETE FROM inbound_pallets WHERE order_no LIKE '${TAG}%'`);
  await query(`DELETE FROM inbound_shipments WHERE note LIKE '${TAG}%'`);
  await query(`DELETE FROM rack_kinds WHERE rack LIKE 'RSFM%'`);
  await purgeRefs('products', (await query(P)).rows.map((r) => Number(r.id)));
  await query(`DELETE FROM products WHERE code LIKE '${TAG}%' OR code LIKE 'PRO${TAG}%'`);
  await purgeRefs('customers', custIds);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'rstest%')`);
  const uids = (await query(`SELECT id FROM users WHERE login_id LIKE 'rstest%'`)).rows.map((r) => Number(r.id));
  await purgeRefs('users', uids);
  await query(`DELETE FROM users WHERE login_id LIKE 'rstest%'`);
}

async function boot() {
  ({ query } = await import('../src/db.js'));
  rs = await import('../src/rackStock.js');
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();

  ID.dir = Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ('${TAG}디렉터','director',$1,'rstest_dir') RETURNING id`, [hashPin(PIN)])).rows[0].id);
  const mkP = async (code, stock) => Number((await query(
    `INSERT INTO products (code, name, stock_qty, avg_cost, list_price, ean) VALUES ($1,$2,$3,100,500,$4) RETURNING id`,
    [code, code + ' 부품', stock, '75' + String(Math.floor(Math.random() * 1e10)).padStart(11, '0')])).rows[0].id);
  ID.p1 = await mkP(`${TAG}-P1`, 19);
  ID.p2 = await mkP(`${TAG}-P2`, 7);
  ID.cust = Number((await query(
    `INSERT INTO customers (name, code, credit_days, rfc, owner_id, created_by) VALUES ($1,$2,30,'XAXX010101000',$3,$3) RETURNING id`,
    [`${TAG}고객`, `${TAG}-C`, ID.dir])).rows[0].id);
  await query(`INSERT INTO rack_kinds (rack, kind) VALUES ('RSFM-01','fast')`);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (r, body, done) => {
    if (!body || !String(body).trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
  });
  for (const f of ['stockCountRoutes', 'quoteRoutes', 'salesRoutes', 'warehouseRoutes', 'productRoutes',
    'rackMoveRoutes', 'rackStockRoutes', 'inboundRoutes']) {
    await app.register((await import(`../src/routes/${f}.js`)).default);
  }
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
}

const H = () => ({ authorization: 'Bearer ' + tok.dir });
const get = (url) => app.inject({ method: 'GET', url, headers: H() });
const post = (url, body) => app.inject({ method: 'POST', url, payload: body || {}, headers: H() });
const del = (url) => app.inject({ method: 'DELETE', url, headers: H() });
const racksOf = async (pid) => (await query(`SELECT rack, qty::float AS qty FROM product_rack_stock WHERE product_id=$1 ORDER BY rack`, [pid])).rows
  .map((r) => `${r.rack}=${r.qty}`).join(',');

test('boot', { skip: SKIP }, async () => { await boot(); assert.equal(await rs.rackStockReady(), true); });

test('① 실사 반영 → 랙마다 센 수량이 랙재고로 저장(보류 SKU 제외), 대조 화면에 랙×수량', { skip: SKIP }, async () => {
  const sc = (await post('/api/stock-counts', { scope_note: `${TAG} 실사` })).json();
  ID.sc = sc.id;
  const line = async (code, rack, qty) => {
    const r = await post(`/api/stock-counts/${sc.id}/lines`, { raw_code: code, rack_scanned: rack, counted_qty: qty });
    assert.equal(r.statusCode, 200, r.body);
  };
  await line(`${TAG}-P1`, 'ae1-3', 12);       // 소문자로 찍혀도 같은 랙
  await line(`${TAG}-P1`, 'RSFM-01', 4);
  await line(`${TAG}-P1`, 'AE1-3 ', 3);       // AE1-3 합 15
  await line(`${TAG}-P2`, 'AE2-1', 5);        // 시스템 7 → 차이 −2 (보류할 것)
  assert.equal((await post(`/api/stock-counts/${sc.id}/submit`)).statusCode, 200);

  const rc = (await get(`/api/stock-counts/${sc.id}/reconcile`)).json();
  const r1 = rc.rows.find((r) => r.code === `${TAG}-P1`);
  assert.equal(r1.rack, 'AE1-3 ×15 · RSFM-01 ×4');
  assert.equal(r1.counted_qty, 19);

  const pv = (await post(`/api/stock-counts/${sc.id}/apply/preview`)).json();
  const items = pv.items.map((it) => ({ kind: it.kind, product_id: it.product_id,
    apply: it.product_id !== ID.p2, save_rack: false, comment: '' }));
  assert.ok(pv.items.find((i) => i.product_id === ID.p1).rack_qty.includes('AE1-3 ×15'));
  const ap = await post(`/api/stock-counts/${sc.id}/apply`, { items, pin: PIN });
  assert.equal(ap.statusCode, 200, ap.body);
  const aj = ap.json();
  assert.equal(aj.rack_stock.skus, 1);
  assert.equal(await racksOf(ID.p1), 'AE1-3=15,RSFM-01=4');
  assert.equal(await racksOf(ID.p2), '', '보류(반영 안 함)한 수량차이 SKU 는 랙재고를 바꾸지 않는다');
  const mv = (await query(`SELECT COUNT(*)::int n FROM product_rack_moves WHERE product_id=$1 AND reason='count'`, [ID.p1])).rows[0].n;
  assert.equal(mv, 2);
});

test('② 제품찾기 — rack_stock 이 fast moving 먼저로 나온다', { skip: SKIP }, async () => {
  const r = (await get(`/api/products?q=${TAG}-P1`)).json();
  const p = r.items.find((x) => x.code === `${TAG}-P1`);
  assert.deepEqual(p.rack_stock.map((x) => [x.rack, x.qty, x.kind]), [['RSFM-01', 4, 'fast'], ['AE1-3', 15, 'carton']]);
});

async function mkQuote(no, qty) {
  const q = Number((await query(
    `INSERT INTO quotes (quote_no, customer_id, status, created_by) VALUES ($1,$2,'confirmed',$3) RETURNING id`,
    [`${TAG}-${no}`, ID.cust, ID.dir])).rows[0].id);
  await query(`INSERT INTO quote_lines (quote_id, line_no, product_id, ctr_code, qty, reserved_qty, list_price, final_price)
               VALUES ($1,1,$2,$3,$4,$4,500,500)`, [q, ID.p1, `${TAG}-P1`, qty]);
  return q;
}

test('③ 포장지시서 — fast moving 랙 먼저, 다른 지시서가 잡은 수량은 피한다', { skip: SKIP }, async () => {
  ID.q1 = await mkQuote('Q1', 6);
  const pv = (await get(`/api/quotes/${ID.q1}/convert-preview`)).json();
  assert.equal(pv.rack_stock_ready, true);
  assert.deepEqual(pv.in_stock[0].picks.map((p) => [p.rack, p.qty]), [['RSFM-01', 4], ['AE1-3', 2]]);
  assert.equal(pv.in_stock[0].picks_saved, false);
  const pr = (await post(`/api/quotes/${ID.q1}/packing-printed`)).json();
  assert.deepEqual(pr.picks[ID.p1].map((p) => [p.rack, p.qty]), [['RSFM-01', 4], ['AE1-3', 2]]);
  // 재출력해도 같은 위치(중복 저장 없음)
  await post(`/api/quotes/${ID.q1}/packing-printed`);
  const n = (await query(`SELECT COUNT(*)::int n FROM quote_pick_alloc WHERE quote_id=$1`, [ID.q1])).rows[0].n;
  assert.equal(n, 2);

  // 두 번째 지시서: RSFM-01 4개는 Q1 이 잡았으므로 AE1-3 에서
  ID.q2 = await mkQuote('Q2', 3);
  const pr2 = (await post(`/api/quotes/${ID.q2}/packing-printed`)).json();
  assert.deepEqual(pr2.picks[ID.p1].map((p) => [p.rack, p.qty]), [['AE1-3', 3]]);

  // 창고 포장 화면도 같은 위치
  const wh = (await get(`/api/warehouse/packing-queue/${ID.q2}`)).json();
  assert.equal(wh.items[0].rack_location, 'AE1-3 ×3');
  const pk = (await get(`/api/warehouse/packing/${ID.q1}`)).json();
  assert.equal(pk.items[0].rack_picks, 'RSFM-01 ×4 · AE1-3 ×2');
});

test('④ 매출 전환 — 랙 스캔 없이 지시서 위치에서 자동 차감 · 삭제하면 같은 랙으로 복원', { skip: SKIP }, async () => {
  await query(`INSERT INTO quote_packing_docs (quote_id, file_data, uploaded_at) VALUES ($1,'data:x',now())`, [ID.q1]);
  const cv = await post(`/api/quotes/${ID.q1}/convert`, { seller_id: ID.dir });
  assert.equal(cv.statusCode, 200, cv.body);
  const inv = (await query(`SELECT invoice_id FROM quotes WHERE id=$1`, [ID.q1])).rows[0].invoice_id;
  ID.inv1 = Number(inv);
  assert.ok(ID.inv1);
  assert.equal(await racksOf(ID.p1), 'AE1-3=13', 'RSFM-01 4개 + AE1-3 2개가 빠져야 한다');
  const cons = (await query(`SELECT COUNT(*)::int n FROM quote_pick_alloc WHERE quote_id=$1 AND consumed_invoice_id=$2`, [ID.q1, ID.inv1])).rows[0].n;
  assert.equal(cons, 2);
  const stock = Number((await query(`SELECT stock_qty FROM products WHERE id=$1`, [ID.p1])).rows[0].stock_qty);
  assert.equal(stock, 13, '총량도 13');

  const d = await del(`/api/sales/${ID.inv1}`);
  assert.equal(d.statusCode, 200, d.body);
  assert.equal(await racksOf(ID.p1), 'AE1-3=15,RSFM-01=4');
  const open = (await query(`SELECT COUNT(*)::int n FROM quote_pick_alloc WHERE quote_id=$1 AND consumed_invoice_id IS NULL`, [ID.q1])).rows[0].n;
  assert.equal(open, 2, '견적이 미전환으로 돌아가면 지시서 위치도 다시 유효');
  // 두 번 복원해도 이중 증가 없음
  await rs.restoreForSale(null, ID.inv1, ID.dir);
  assert.equal(await racksOf(ID.p1), 'AE1-3=15,RSFM-01=4');
});

test('⑤ 직접 매출(견적 없음) — 피킹 순서(fast 먼저)로 차감, 랙이 모자라면 위치 미지정에서', { skip: SKIP }, async () => {
  const r = await post('/api/sales', { customer_id: ID.cust, inv_date: '2026-10-01', seller_id: ID.dir,
    lines: [{ product_id: ID.p2, qty: 2 }] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await racksOf(ID.p2), '', 'P2 는 랙 기록 없음 → 차감할 랙 없음(위치 미지정)');
  ID.inv2 = Number(r.json().id);
  await del(`/api/sales/${ID.inv2}`);
  const r3 = await post('/api/sales', { customer_id: ID.cust, inv_date: '2026-10-01', seller_id: ID.dir,
    lines: [{ product_id: ID.p1, qty: 5 }] });
  assert.equal(r3.statusCode, 200, r3.body);
  // Q1(미전환으로 되돌아감) 지시서가 RSFM-01 4개를 잡고 있다 → 직접 매출은 그걸 피해 AE1-3 에서 5개
  assert.equal(await racksOf(ID.p1), 'AE1-3=10,RSFM-01=4', '다른 지시서가 잡은 fast 랙 수량은 건드리지 않는다');
  await del(`/api/sales/${Number(r3.json().id)}`);
  assert.equal(await racksOf(ID.p1), 'AE1-3=15,RSFM-01=4');
});

test('⑥ 위치변경 — 출발 랙 −, 도착 랙 + · 되돌리기', { skip: SKIP }, async () => {
  const m = await post('/api/warehouse/rack-moves', { from_rack: 'AE1-3', to_rack: 'RSFM-01', update_master: false,
    lines: [{ product_id: ID.p1, cartons: 1, per_carton: 5 }] });
  assert.equal(m.statusCode, 200, m.body);
  assert.equal(await racksOf(ID.p1), 'AE1-3=10,RSFM-01=9');
  const u = await post(`/api/warehouse/rack-moves/${m.json().moved[0].id}/undo`);
  assert.equal(u.statusCode, 200, u.body);
  assert.equal(await racksOf(ID.p1), 'AE1-3=15,RSFM-01=4');
});

test('⑦ 랙별 재고 화면 API — 목록·랙요약·상세·디렉터 수동조정', { skip: SKIP }, async () => {
  const s = await post('/api/rack-stock/set', { product_id: ID.p1, rack: 'ae9-9', qty: 2, note: 'test' });
  assert.equal(s.statusCode, 200, s.body);
  const l = (await get(`/api/rack-stock?q=${TAG}`)).json();
  const it = l.items.find((x) => x.product_id === ID.p1);
  assert.equal(it.located, 21);
  assert.equal(it.over, 2, '랙 합(21) > 시스템(19) → 초과 2');
  const p2 = l.items.find((x) => x.product_id === ID.p2);
  assert.equal(p2.unassigned, 7, 'P2 는 수량차이 보류 → 랙 기록 없음 → 7 전부 위치 미지정');
  const rk = (await get('/api/rack-stock/racks')).json();
  assert.ok(rk.racks.find((r) => r.rack === 'RSFM-01' && r.kind === 'fast'));
  const dt = (await get(`/api/rack-stock/product/${ID.p1}`)).json();
  assert.equal(dt.moves[0].reason, 'manual');
  await post('/api/rack-stock/set', { product_id: ID.p1, rack: 'AE9-9', qty: 0 });
  assert.equal(await racksOf(ID.p1), 'AE1-3=15,RSFM-01=4');
});

test('⑧ 격리 — 랙 작업이 실패해도 바깥 트랜잭션(본 업무)은 커밋된다', { skip: SKIP }, async () => {
  const { withTx } = await import('../src/db.js');
  await withTx(async (c) => {
    await c.query(`UPDATE products SET name='${TAG}-P1 격리' WHERE id=$1`, [ID.p1]);
    const r = await rs.rackSafe(c, 'boom', async (run) => { await run(`SELECT * FROM no_such_table`); });
    assert.equal(r, null);
    await c.query(`SELECT 1`);   // 트랜잭션이 살아 있어야 한다
  });
  const nm = (await query(`SELECT name FROM products WHERE id=$1`, [ID.p1])).rows[0].name;
  assert.equal(nm, `${TAG}-P1 격리`);
});

test('⑨ 과거 실사 가져오기 — 이미 저장된 실사는 거부 · 보류 SKU 제외 · 실사가 안 간 랙은 보존', { skip: SKIP }, async () => {
  const again = await post(`/api/rack-stock/from-count/${ID.sc}`);
  assert.equal(again.statusCode, 409, '반영 때 이미 저장됨 → 다시 가져오지 않는다');
  assert.equal(again.json().error, 'already_imported');
  // 배포 전에 반영된 실사를 흉내: 원장의 count 기록을 지우고 랙재고를 흐트러뜨린다
  await query(`DELETE FROM product_rack_moves WHERE ref=$1`, [`count:${ID.sc}`]);
  await query(`DELETE FROM product_rack_stock WHERE product_id IN ($1,$2)`, [ID.p1, ID.p2]);
  await post('/api/rack-stock/set', { product_id: ID.p1, rack: 'B7-7', qty: 3 });     // 이 실사가 가지 않은 랙
  await post('/api/rack-stock/set', { product_id: ID.p1, rack: 'AE1-3', qty: 99 });   // 실사가 간 랙 → 실사값으로
  const r = await post(`/api/rack-stock/from-count/${ID.sc}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().skipped, 1);
  assert.equal(await racksOf(ID.p1), 'AE1-3=15,B7-7=3,RSFM-01=4', '실사가 안 간 B7-7 은 그대로');
  assert.equal(await racksOf(ID.p2), '');
  await post('/api/rack-stock/set', { product_id: ID.p1, rack: 'B7-7', qty: 0 });
  // 위치 미지정만 필터 — 랙 기록이 전혀 없는 재고 SKU(P2)도 잡힌다
  const un = (await get(`/api/rack-stock?unassigned=1&q=${TAG}`)).json();
  assert.ok(un.items.some((x) => x.product_id === ID.p2 && x.unassigned === 7));
  assert.ok(!un.items.some((x) => x.product_id === ID.p1), 'P1 은 19 = 15 + 4 로 맞음');
});

test('⑩ 수입 적치 — 적치한 카톤만큼 그 랙에 + (음수 delta = 다시 내림)', { skip: SKIP }, async () => {
  const sh = Number((await query(`INSERT INTO inbound_shipments (invoice_no, note) VALUES ('${TAG}-INV','${TAG} 적치') RETURNING id`)).rows[0].id);
  const pal = Number((await query(
    `INSERT INTO inbound_pallets (shipment_id, order_no, pl_no, status, cartons_expected, qty_expected, checked_at)
     VALUES ($1,'${TAG}-PO','1','checking',3,48, now()) RETURNING id`, [sh])).rows[0].id);
  const it = Number((await query(
    `INSERT INTO inbound_pallet_items (pallet_id, shipment_id, input_code, product_id, cartons, qty, scanned_cartons, put_cartons)
     VALUES ($1,$2,'${TAG}-P2',$3,3,48,3,0) RETURNING id`, [pal, sh, ID.p2])).rows[0].id);
  const r = await post(`/api/inbound/${sh}/pallets/${pal}/putaway`, { items: [{ item_id: it, put_delta: 2, rack: 'B5-1' }] });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await racksOf(ID.p2), 'B5-1=32', '카톤 2 × 16');
  await post(`/api/inbound/${sh}/pallets/${pal}/putaway`, { items: [{ item_id: it, put_delta: -1 }] });
  assert.equal(await racksOf(ID.p2), 'B5-1=16', '1카톤 내림 → 저장된 적치 랙에서 −16');
  await post(`/api/inbound/${sh}/pallets/${pal}/putaway`, { items: [{ item_id: it, put_delta: 5 }] });
  assert.equal(await racksOf(ID.p2), 'B5-1=48', '목표 카톤(3)을 넘겨 더하지 않는다');
  // 박스 1개를 다른 랙으로: −1(새 랙 스캔과 함께 와도 옛 랙에서 뺀다) → +1 새 랙
  await post(`/api/inbound/${sh}/pallets/${pal}/putaway`, { items: [{ item_id: it, put_delta: -1, rack: 'B6-1' }] });
  await post(`/api/inbound/${sh}/pallets/${pal}/putaway`, { items: [{ item_id: it, put_delta: 1, rack: 'B6-1' }] });
  assert.equal(await racksOf(ID.p2), 'B5-1=32,B6-1=16', '옛 랙 −16, 새 랙 +16 — 이중 기록 없음');
  // 검수 리셋 → 이 항목이 랙에 더한 수량을 전부 되돌린다
  const rs1 = await post(`/api/inbound/${sh}/reset-check`, { pallet_ids: [pal] });
  assert.equal(rs1.statusCode, 200, rs1.body);
  assert.equal(await racksOf(ID.p2), '', '리셋 후 재적치해도 이중 계산되지 않게 0');
});

test('⑪ 매출 수정 승인 — 원래 차감분을 되돌리고 새 수량으로 다시 차감 · 삭제 요청 승인도 복원', { skip: SKIP }, async () => {
  // 지시서 홀드를 없애 깨끗한 상태에서(두 견적 취소)
  await query(`UPDATE quotes SET status='cancelled' WHERE quote_no LIKE '${TAG}%'`);
  assert.equal(await racksOf(ID.p1), 'AE1-3=15,RSFM-01=4');
  const s1 = await post('/api/sales', { customer_id: ID.cust, inv_date: '2026-10-01', seller_id: ID.dir, lines: [{ product_id: ID.p1, qty: 3 }] });
  assert.equal(s1.statusCode, 200, s1.body);
  const inv = Number(s1.json().id);
  assert.equal(await racksOf(ID.p1), 'AE1-3=15,RSFM-01=1', '홀드 없으면 fast 랙부터');
  const er = (await post(`/api/sales/${inv}/edit-request`, { reason: 't', lines: [{ product_id: ID.p1, qty: 6 }] })).json();
  const ap = await post(`/api/sales/change-requests/${er.id}/approve`);
  assert.equal(ap.statusCode, 200, ap.body);
  assert.equal(await racksOf(ID.p1), 'AE1-3=13', '복원(RSFM 4) 후 6개 → RSFM 4 + AE1-3 2');
  const dr = (await post(`/api/sales/${inv}/delete-request`, { reason: 't' })).json();
  const ap2 = await post(`/api/sales/change-requests/${dr.id}/approve`);
  assert.equal(ap2.statusCode, 200, ap2.body);
  assert.equal(await racksOf(ID.p1), 'AE1-3=15,RSFM-01=4');
});

test('⑫ 프로모션(PRO) 반영 경로 — 반영한 PRO 만 저장, 세션이 닫히면 수량 맞은 SKU 까지 저장', { skip: SKIP }, async () => {
  const mk = async (code, stock) => Number((await query(
    `INSERT INTO products (code, name, stock_qty, list_price) VALUES ($1,$1,$2,10) RETURNING id`, [code, stock])).rows[0].id);
  const pro = await mk(`PRO${TAG}1`, 5);
  const ok3 = await mk(`${TAG}-P3`, 6);          // 수량 맞음(검토목록에 안 나옴 — 랙 마스터와 같게)
  await query(`UPDATE products SET rack_location='C1-1' WHERE id=$1`, [ok3]);
  const sc = (await post('/api/stock-counts', { scope_note: `${TAG} 프로모` })).json();
  await post(`/api/stock-counts/${sc.id}/lines`, { raw_code: `PRO${TAG}1`, rack_scanned: 'P9-1', counted_qty: 3 });
  await post(`/api/stock-counts/${sc.id}/lines`, { raw_code: `${TAG}-P3`, rack_scanned: 'C1-1', counted_qty: 6 });
  await post(`/api/stock-counts/${sc.id}/submit`);
  const pa = await post(`/api/stock-counts/${sc.id}/promo-apply`, { pin: PIN, items: [{ product_id: pro, apply: true, save_rack: false }] });
  assert.equal(pa.statusCode, 200, pa.body);
  assert.equal(pa.json().closed, true);
  assert.equal(await racksOf(pro), 'P9-1=3');
  assert.equal(await racksOf(ok3), 'C1-1=6', '세션 마감 시 수량이 맞았던 SKU 도 저장');
});

test('⑬ 동시 출력(더블클릭) — 지시서 위치가 두 번 저장되지 않는다 · 만료됐어도 출력된 견적은 위치를 잡아 둔다', { skip: SKIP }, async () => {
  const q3 = await mkQuote('Q3', 5);
  await Promise.all([post(`/api/quotes/${q3}/packing-printed`), post(`/api/quotes/${q3}/packing-printed`), post(`/api/quotes/${q3}/packing-printed`)]);
  const sum = Number((await query(`SELECT COALESCE(SUM(qty),0) s FROM quote_pick_alloc WHERE quote_id=$1`, [q3])).rows[0].s);
  assert.equal(sum, 5);
  await query(`UPDATE quotes SET status='expired' WHERE id=$1`, [q3]);
  const plan = await rs.planPick(null, ID.p1, 4, { strict: true });
  const held = (await query(`SELECT rack, qty::float q FROM quote_pick_alloc WHERE quote_id=$1 ORDER BY seq`, [q3])).rows;
  assert.equal(held[0].rack, 'RSFM-01', 'Q3 이 fast 랙을 잡음');
  assert.ok(!plan.some((p) => p.rack === 'RSFM-01'), '만료(출력됨) 견적의 위치도 비켜 간다');
  await query(`UPDATE quotes SET status='cancelled' WHERE id=$1`, [q3]);
});

after(async () => {
  if (SKIP) return;
  try { await cleanup(); } catch (e) { console.error('cleanup', e.message); }
  try { await app.close(); } catch (_) {}
  const { pool } = await import('../src/db.js');
  await pool.end();
});
