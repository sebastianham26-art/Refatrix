// =====================================================================
// salestrend.test.mjs (2026-10-16 · 구매 › 판매 이력·주기)
//   A. 단위 — src/salesTrend.js 계산(수요유형 · 예측 · 커버 · 제안 · 짝 · 부품군)
//   B. E2E — TEST_PG_URL 이 있을 때 실제 PostgreSQL + buildApp().inject
//      (migrate 완료된 빈 DB에서 실행 — 시드는 이 파일이 만들고 지운다)
//   실행: node --test test/salestrend.test.mjs
//         TEST_PG_URL=postgres://... node --test test/salestrend.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
if (PG) process.env.DATABASE_URL = PG;
const S = await import('../src/salesTrend.js');

// ---------------- A. 단위 ----------------
test('A1 monthKeys · monthDiff', () => {
  assert.deepEqual(S.monthKeys('2026-02', 4), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.equal(S.monthDiff('2025-11', '2026-02'), 3);
});
test('A2 꾸준: 매달 10개 → smooth · fc 10 · 커버/제안', () => {
  const series = [...new Array(23).fill(10), 4];                 // 마지막 = 이번 달(진행 중)
  const a = S.analyzeSku({ series, curYm: '2026-10', firstSaleYm: '2024-11', stock: 15, backorder: 20, lead: 4, safe: 1 });
  assert.equal(a.type, 'smooth'); assert.equal(a.fc, 10); assert.equal(a.supply, 35);
  assert.equal(a.cover, 3.5); assert.equal(a.suggest, 15);   // 10×5 − 35
  assert.equal(a.total, 234); assert.equal(a.sale_months, 23); assert.equal(a.since_last, 0);
});
test('A3 간헐: 3개월마다 6개 → inter · Croston-SBA', () => {
  const s = new Array(24).fill(0); for (let i = 2; i < 23; i += 3) s[i] = 6;
  const a = S.analyzeSku({ series: s, curYm: '2026-10', firstSaleYm: '2024-12', stock: 0, backorder: 0 });
  assert.equal(a.type, 'inter'); assert.equal(a.adi, 3); assert.equal(a.cv2, 0);
  const expect = Math.round(S.crostonSba(s.slice(0, -1)) * 10) / 10;
  assert.equal(a.fc, expect); assert.ok(a.fc > 1.5 && a.fc < 2.1, 'fc≈6/3×0.9');
});
test('A4 정지 · 신규 · 무판매 · 변동/불규칙', () => {
  const dead = new Array(24).fill(0); dead[5] = 5; dead[10] = 5;
  assert.equal(S.analyzeSku({ series: dead, curYm: '2026-10', firstSaleYm: '2024-04', stock: 30 }).type, 'dead');
  assert.equal(S.analyzeSku({ series: dead, curYm: '2026-10', firstSaleYm: '2024-04', stock: 30 }).fc, 0);
  const nw = new Array(24).fill(0); nw[22] = 3; nw[23] = 2;
  assert.equal(S.analyzeSku({ series: nw, curYm: '2026-10', firstSaleYm: '2026-09' }).type, 'new');
  const onlyNow = new Array(24).fill(0); onlyNow[23] = 2;
  assert.equal(S.analyzeSku({ series: onlyNow, curYm: '2026-10', firstSaleYm: '2026-10' }).type, 'new');
  assert.equal(S.analyzeSku({ series: new Array(24).fill(0), curYm: '2026-10', firstSaleYm: null }).type, 'none');
  const er = Array.from({ length: 24 }, (_, i) => (i % 4 === 0 ? 60 : 4));
  assert.equal(S.analyzeSku({ series: er, curYm: '2026-10', firstSaleYm: '2024-11' }).type, 'erratic');
  const lu = new Array(24).fill(0); lu[3] = 2; lu[9] = 80; lu[15] = 3; lu[20] = 40;
  assert.equal(S.analyzeSku({ series: lu, curYm: '2026-10', firstSaleYm: '2024-11' }).type, 'lumpy');
});
test('A5 견적 부족 포함 예측(fc_lost) · 공급 0 · 음수 제안 없음', () => {
  const s = [...new Array(23).fill(10), 0]; const lost = [...new Array(20).fill(0), 5, 5, 5, 0];
  const a = S.analyzeSku({ series: s, lostSeries: lost, curYm: '2026-10', firstSaleYm: '2024-11', stock: 500, lead: 4, safe: 1 });
  assert.ok(a.fc_lost > a.fc); assert.equal(a.lost_total, 15); assert.equal(a.suggest, 0); assert.equal(a.suggest_lost, 0);
  // 판매 없는 SKU 의 못 판 수량만으로도 예측이 생긴다(유형은 판매 기준 none 유지)
  const b = S.analyzeSku({ series: new Array(24).fill(0), lostSeries: lost, curYm: '2026-10', firstSaleYm: null });
  assert.equal(b.type, 'none'); assert.equal(b.fc, 0); assert.ok(b.fc_lost > 0); assert.ok(b.suggest_lost > 0);
});
test('A6 부품군 · L/R 짝', () => {
  assert.equal(S.partKind('ROTULA INFERIOR', 'CB0401'), 'RÓTULA');
  assert.equal(S.partKind('RÓTULA SUPERIOR', 'X'), 'RÓTULA');
  assert.equal(S.partKind('TERMINAL INTERIOR', 'CR0160'), 'TERMINAL INTERIOR');
  assert.equal(S.partKind('HORQUILLA INFERIOR SIN ROTULA', 'CQ1'), 'HORQUILLA');
  assert.equal(S.partKind('GOMA DE ESTABILIZADOR', 'GV1'), 'BUJE');
  assert.equal(S.partKind('', 'CL0387'), 'TORNILLO ESTABILIZADOR');
  assert.equal(S.partKind('', 'ZZ1'), '기타');
  assert.equal(S.pairCode('CE0351R'), 'CE0351L'); assert.equal(S.pairCode('cq0166l'), 'CQ0166R');
  assert.equal(S.pairCode('CB0401'), null); assert.equal(S.pairCode('GY2438G'), null);
});

test('A7 화면 카테고리(5대 + PRO + 기타)', () => {
  const c = S.trendCat;
  assert.equal(c('ROTULA INFERIOR', 'CB0401'), 'rotula');
  assert.equal(c('HORQUILLA INFERIOR CON ROTULA', 'CQ0546R'), 'horquilla');
  assert.equal(c('TERMINAL EXTERIOR "R"', 'CE0351R'), 'terminal_ext');
  assert.equal(c('TERMINAL INTERIOR', 'CR0160'), 'terminal_int');
  assert.equal(c('TORNILLO ESTABILIZADOR TRASERO', 'CL0962'), 'tornillo');
  assert.equal(c('GOMA DE ESTABILIZADOR', 'GV1'), 'etc');
  assert.equal(c('BUJE', 'GV0273'), 'etc');
  assert.equal(c('AMORTIGUADOR DELANTERO GAS', 'GY2438G'), 'etc');
  assert.equal(c('GORRA REFATRIX', 'PRO-CAP'), 'pro'); assert.equal(c('ROTULA', ' pro01'), 'pro');
  assert.equal(c('', 'CE0022L'), 'terminal_ext'); assert.equal(c('', 'ZZ1'), 'etc');
  assert.deepEqual(S.TREND_CATS.map((x) => x.key), ['rotula', 'terminal_ext', 'terminal_int', 'horquilla', 'tornillo', 'pro']);
});

// ---------------- B. E2E (실제 PostgreSQL) ----------------
let app = null, pool = null;
after(async () => {
  if (pool) {
    await pool.query(`DELETE FROM stock_shortage_resolutions WHERE shortage_id IN (SELECT id FROM stock_shortages WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'TT%'))`);
    await pool.query(`DELETE FROM stock_shortages WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'TT%')`);
    await pool.query(`DELETE FROM inbound_pallet_items WHERE input_code LIKE 'TT%'`);
    await pool.query(`DELETE FROM inbound_pallets WHERE order_no='TT-PO'`);
    await pool.query(`DELETE FROM inbound_shipments WHERE invoice_no='TT-SHIP'`);
    await pool.query(`DELETE FROM purchase_order_lines WHERE input_code LIKE 'TT%'`);
    await pool.query(`DELETE FROM purchase_orders WHERE ref_no='TT-PO'`);
    await pool.query(`DELETE FROM sales_invoice_lines WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'TT%')`);
    await pool.query(`DELETE FROM sales_invoices WHERE memo='TT'`);
    await pool.query(`DELETE FROM products WHERE code LIKE 'TT%'`);
    await pool.query(`DELETE FROM customers WHERE code LIKE 'TT-%'`);
    await pool.query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'tt_%')`);
    await pool.query(`DELETE FROM users WHERE login_id LIKE 'tt_%'`);
  }
  if (app) await app.close();
  if (pool) await pool.end();
  setTimeout(() => process.exit(0), 50).unref();
});

test('B E2E 판매 이력·주기 API', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  ({ pool } = await import('../src/db.js'));
  const { buildApp } = await import('../src/server.js');
  const { mxToday } = await import('../src/priceMaster.js');
  app = buildApp(); await app.ready();
  const q = (s, p) => pool.query(s, p);

  const today = mxToday(); const cur = today.slice(0, 7);
  const ym = (k) => S.monthKeys(cur, k + 1)[0];            // k개월 전 'YYYY-MM'
  const day = (k) => (k === 0 ? today : ym(k) + '-15');

  // 사용자
  const U = {};
  for (const [lid, role] of [['tt_dir', 'director'], ['tt_soc', 'socio'], ['tt_pur', 'sales_support'], ['tt_trs', 'treasury']]) {
    const id = Number((await q(`INSERT INTO users (login_id, name, role, pin_hash) VALUES ($1,$1,$2,'x') RETURNING id`, [lid, role])).rows[0].id);
    U[lid] = { id, tok: app.jwt.sign({ sub: id, role }) };
  }
  await q(`INSERT INTO user_page_access (user_id, page_key) VALUES ($1,'purchase'),($2,'purchase')`, [U.tt_pur.id, U.tt_trs.id]);
  const C1 = Number((await q(`INSERT INTO customers (code,name) VALUES ('TT-C1','Refacc TT Uno') RETURNING id`)).rows[0].id);
  const C2 = Number((await q(`INSERT INTO customers (code,name) VALUES ('TT-C2','Refacc TT Dos') RETURNING id`)).rows[0].id);
  const P = {};
  for (const [code, name, stock] of [['TT0001', 'ROTULA INFERIOR', 15], ['TT0002L', 'TERMINAL EXTERIOR "L"', 0], ['TT0002R', 'TERMINAL EXTERIOR "R"', 4],
    ['TT0003', 'HORQUILLA INFERIOR', 30], ['TT0004', 'TORNILLO ESTABILIZADOR', 0], ['TT0005', 'BUJE', 0], ['TT0006', 'ROTULA SUPERIOR', 0]]) {
    P[code] = Number((await q(`INSERT INTO products (code,name,stock_qty) VALUES ($1,$2,$3) RETURNING id`, [code, name, stock])).rows[0].id);
  }
  const sell = async (code, k, qty, cust = C1, status = 'posted', deleted = false) => {
    const inv = Number((await q(`INSERT INTO sales_invoices (customer_id, inv_date, status, memo, deleted_at) VALUES ($1,$2,$3,'TT',$4) RETURNING id`,
      [cust, day(k), status, deleted ? new Date() : null])).rows[0].id);
    await q(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, unit_price, line_amount_mxn) VALUES ($1,$2,$3,100,55,$4)`, [inv, P[code], qty, 55 * qty]);
  };
  for (let k = 1; k <= 23; k++) await sell('TT0001', k, 10, k % 2 ? C1 : C2);    // 꾸준
  await sell('TT0001', 0, 4, C1);                                                // 이번 달 진행 중
  await sell('TT0001', 2, 999, C1, 'posted', true);                              // 삭제 → 제외
  await sell('TT0001', 3, 888, C1, 'delete_pending');                            // 승인 대기 → 제외
  for (let k = 3; k <= 21; k += 3) await sell('TT0002L', k, 6);                  // 간헐
  for (let k = 1; k <= 12; k++) await sell('TT0002R', k, 2);
  await sell('TT0003', 10, 5); await sell('TT0003', 12, 5);                      // 정지
  await sell('TT0004', 1, 3); await sell('TT0004', 0, 2);                        // 신규

  // 발주 20 (그중 8 운송중)
  const po = Number((await q(`INSERT INTO purchase_orders (ref_no) VALUES ('TT-PO') RETURNING id`)).rows[0].id);
  await q(`INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, unit_cost_usd, amount_usd) VALUES ($1,$2,'TT0001',20,1,20)`, [po, P.TT0001]);
  const sh = Number((await q(`INSERT INTO inbound_shipments (invoice_no, status, eta) VALUES ('TT-SHIP','incoming',$1) RETURNING id`, [today])).rows[0].id);
  const pl = Number((await q(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no) VALUES ($1,'TT-PO',1) RETURNING id`, [sh])).rows[0].id);
  await q(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, product_id, input_code, cartons, qty) VALUES ($1,$2,$3,'TT0001',1,8)`, [pl, sh, P.TT0001]);

  // 못 판 수량: 7 부족 중 3 판매 해소(→4) · 5 미해소 open · 100 취소(제외)
  const s1 = Number((await q(`INSERT INTO stock_shortages (product_id, customer_id, requested_qty, shortage_qty, resolved_qty, status, occurred_at)
                              VALUES ($1,$2,7,7,3,'resolved',$3) RETURNING id`, [P.TT0006, C1, day(2)])).rows[0].id);
  await q(`INSERT INTO stock_shortage_resolutions (shortage_id, qty, source) VALUES ($1,3,'sale')`, [s1]);
  await q(`INSERT INTO stock_shortages (product_id, requested_qty, shortage_qty, status, occurred_at) VALUES ($1,5,5,'open',$2)`, [P.TT0006, day(1)]);
  await q(`INSERT INTO stock_shortages (product_id, requested_qty, shortage_qty, status, occurred_at) VALUES ($1,100,100,'cancelled',$2)`, [P.TT0006, day(1)]);

  const get = (u, path) => app.inject({ method: 'GET', url: path, headers: { authorization: 'Bearer ' + U[u].tok } });

  await t.test('권한: 디렉터·소시오만 (구매 권한 있는 영업지원·재무 403)', async () => {
    assert.equal((await get('tt_dir', '/api/salestrend')).statusCode, 200);
    assert.equal((await get('tt_soc', '/api/salestrend')).statusCode, 200);
    assert.equal((await get('tt_pur', '/api/salestrend')).statusCode, 403);
    assert.equal((await get('tt_trs', '/api/salestrend/' + P.TT0001)).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/salestrend' })).statusCode, 401);
  });

  let L;
  await t.test('목록: 기간·활동 필터·계산', async () => {
    const r = await get('tt_dir', '/api/salestrend?months=24&lead=4&safe=1');
    L = r.json();
    assert.equal(L.months.length, 24); assert.equal(L.months[23], cur); assert.equal(L.cur_ym, cur);
    const by = Object.fromEntries(L.items.map((x) => [x.code, x]));
    assert.ok(!by.TT0005, '활동 없는 SKU 는 기본 제외');
    const a = by.TT0001;
    assert.equal(a.type, 'smooth'); assert.equal(a.total, 234, '삭제·승인대기 인보이스 제외');
    assert.equal(a.series[23], 4); assert.equal(a.series[22], 10);
    assert.equal(a.fc, 10); assert.equal(a.stock, 15); assert.equal(a.backorder, 20); assert.equal(a.incoming, 8);
    assert.equal(a.supply, 35); assert.equal(a.top_share, 0.53);   // C1 = 홀수달 12×10 + 이번 달 4 = 124/234
    assert.equal(a.kind, 'RÓTULA'); assert.equal(a.cat, 'rotula'); assert.equal(by.TT0002L.cat, 'terminal_ext'); assert.equal(by.TT0005, undefined);
    assert.deepEqual(L.cats.map((x) => x.key), ['rotula', 'terminal_ext', 'terminal_int', 'horquilla', 'tornillo', 'pro']); assert.equal(a.last_ym, cur); assert.equal(L.done_months, 23);
    // 화면 공식(커버·제안)은 서버 analyzeSku 와 같아야 한다
    assert.equal(Math.round(a.supply / a.fc * 10) / 10, 3.5); assert.equal(Math.max(0, Math.ceil(a.fc * 5 - a.supply)), 15);
    assert.equal(by.TT0002L.type, 'inter'); assert.equal(by.TT0002L.pair, 'TT0002R'); assert.equal(by.TT0002L.kind, 'TERMINAL EXTERIOR');
    assert.equal(by.TT0003.type, 'dead'); assert.equal(by.TT0003.fc, 0); assert.equal(by.TT0003.stock, 30);
    assert.equal(by.TT0004.type, 'new');
    const z = by.TT0006;
    assert.equal(z.type, 'none'); assert.equal(z.lost_total, 9, '4(판매해소 차감) + 5(open), 취소 제외');
    assert.equal(z.shortage_open, 5); assert.ok(z.fc_lost > 0); assert.equal(z.fc, 0);
    assert.equal(z.lost[22], 5, '1개월 전 open 5'); assert.equal(z.lost[21], 4, '2개월 전 7−판매해소3'); assert.equal(z.lost[23], 0);
  });
  await t.test('목록: all=1 · months=12 · 잘못된 파라미터 보정', async () => {
    const r = (await get('tt_dir', '/api/salestrend?all=1&months=12&lead=99&safe=-5')).json();
    assert.ok(r.items.some((x) => x.code === 'TT0005'));
    assert.equal(r.months.length, 12); assert.equal(r.lead, 12); assert.equal(r.safe, 0);
    const a = r.items.find((x) => x.code === 'TT0001'); assert.equal(a.total, 114);   // 11×10 + 4
    const r2 = (await get('tt_dir', '/api/salestrend?months=7')).json(); assert.equal(r2.months.length, 24);
  });
  await t.test('목록: gzip 요청 시 압축 응답(내용 동일)', async () => {
    const { gunzipSync } = await import('node:zlib');
    const r = await app.inject({ method: 'GET', url: '/api/salestrend?months=24', headers: { authorization: 'Bearer ' + U.tt_dir.tok, 'accept-encoding': 'gzip, deflate, br' } });
    assert.equal(r.statusCode, 200); assert.equal(r.headers['content-encoding'], 'gzip');
    const j = JSON.parse(gunzipSync(r.rawPayload).toString('utf8'));
    assert.deepEqual(j.items.map((x) => x.code), L.items.map((x) => x.code));
  });
  await t.test('상세: 고객·인보이스·짝·404', async () => {
    const d = (await get('tt_soc', '/api/salestrend/' + P.TT0001 + '?months=24')).json();
    assert.equal(d.product.code, 'TT0001'); assert.equal(d.total, 234); assert.equal(d.product.cat, 'rotula');
    assert.equal(d.months.length, 24, '월 라벨 배열 유지'); assert.equal(d.sale_months, 23); assert.equal(d.series.length, 24); assert.equal(d.type, 'smooth');
    assert.equal(d.customers.length, 2);
    assert.equal(d.customers.reduce((s, c) => s + c.qty, 0), 234);
    assert.equal(d.invoices.length, 24); assert.equal(d.invoices[0].inv_date, today); assert.equal(d.invoices[0].unit_price, 55);
    assert.equal(d.product.incoming, 8); assert.equal(d.pair, null);
    assert.equal(d.cover, 3.5); assert.equal(d.suggest, 15); assert.equal(d.customers[0].share, 0.53); assert.equal(d.customers[0].name, 'Refacc TT Uno');
    const e = (await get('tt_dir', '/api/salestrend/' + P.TT0002L)).json();
    assert.equal(e.type, 'inter'); assert.ok(e.pair); assert.equal(e.pair.code, 'TT0002R'); assert.equal(e.pair.total, 24);
    assert.equal(e.next_in !== null, true);
    assert.equal((await get('tt_dir', '/api/salestrend/999999999')).statusCode, 404);
    assert.equal((await get('tt_dir', '/api/salestrend/abc')).statusCode, 400);
  });
});
