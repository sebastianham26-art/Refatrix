// =====================================================================
// vehicle_map_e2e.test.mjs — 2026-11-27 · 차종으로 제품찾기 차량 도면 API (실 PostgreSQL + 실제 서버)
//   ① 차종(메이커 · 모델 · 연식) → CTR 제품 · 연식 범위 밖 제외 · 메이커 · 모델 필수
//   ② 장착위치 우선순위: CTR 확인값(mount_pos) → 이 차종 업로드 줄 → 전체 업로드 줄 · 없으면 null
//   ③ 수량: 창고재고 · 운송(v_incoming_stock) · 백오더(부족분 open) · 누적판매(게시 · 미삭제, 팀 가시성)
//   ④ 코드: SYD · OE · BAW(마스터 같은 행 + product_xref_codes)
//   ⑤ 경쟁사만: CTR 미연결 마스터 행(SYD · BAW) · 연식 · 다른 메이커 거름 · 연결된 행 제외
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/vehicle_map_e2e.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-vehicle-map';
const SKIP = !PG && 'TEST_PG_URL 없음';
const RUN = String(Date.now() % 9000 + 1000);
const TAG = 'VMT' + RUN;
const MK = TAG + 'MK';          // 시험용 메이커(실데이터와 안 겹치게)
const MD = 'Mdl' + RUN;          // 시험용 모델

let query, pool, app;
const ID = {}, tok = {};
const get = (url, w = 'dir') => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[w] } });

async function cleanup() {
  try {
    const pids = (await query(`SELECT id FROM products WHERE code LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
    for (const t of ['sales_invoice_lines', 'stock_shortages', 'inbound_pallet_items', 'product_applications', 'product_syd_codes', 'product_xref_codes', 'product_oe_codes', 'product_rack_stock'])
      await query(`DELETE FROM ${t} WHERE product_id = ANY($1::bigint[])`, [pids]).catch(() => {});
    await query(`DELETE FROM sales_invoices WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE '${TAG}%')`).catch(() => {});
    await query(`DELETE FROM inbound_pallets WHERE order_no LIKE '${TAG}%'`).catch(() => {});
    await query(`DELETE FROM inbound_shipments WHERE id IN (SELECT shipment_id FROM inbound_pallets WHERE order_no LIKE '${TAG}%')`).catch(() => {});
    await query(`DELETE FROM product_positions WHERE ctr_code LIKE '${TAG}%'`).catch(() => {});
    await query(`DELETE FROM purchase_order_lines WHERE product_id = ANY($1::bigint[])`, [pids]).catch(() => {});
    await query(`DELETE FROM purchase_orders WHERE ref_no LIKE '${TAG}%'`).catch(() => {});
    await query(`DELETE FROM products WHERE id = ANY($1::bigint[])`, [pids]);
    await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`).catch(() => {});
    await query(`DELETE FROM xref_master_versions WHERE filename LIKE '${TAG}%'`).catch(() => {});
    const uids = (await query(`SELECT id FROM users WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
    await query(`DELETE FROM user_page_access WHERE user_id = ANY($1::bigint[])`, [uids]).catch(() => {});
    await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [uids]).catch(() => {});
    await query(`DELETE FROM customer_meetings WHERE created_by = ANY($1::bigint[])`, [uids]).catch(() => {});
    await query(`DELETE FROM customer_stage_history WHERE created_by = ANY($1::bigint[])`, [uids]).catch(() => {});
    await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [uids]);
  } catch (e) { console.log('# cleanup(무시)', e.message); }
}

test('boot', { skip: SKIP }, async () => {
  ({ query, pool } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  await cleanup();
  const mkU = async (n, role) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,$3,$4) RETURNING id`, [TAG + n, role, hashPin('4321'), (TAG + n).toLowerCase()])).rows[0].id);
  ID.dir = await mkU('dir', 'director');
  ID.sales = await mkU('sales', 'sales');
  ID.none = await mkU('none', 'sales');
  ID.qonly = await mkU('qonly', 'sales');   // 11-27f · 견적 화면 권한만 — 견적에서 차종으로 찾아 담기
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'quote','anywhere','edit')`, [ID.qonly]);
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'products','anywhere','view')`, [ID.sales]);
  const mkP = async (sfx, name, stock, app, syd, extra = {}) => {
    const code = TAG + sfx;
    const id = Number((await query(
      `INSERT INTO products (code, name, stock_qty, avg_cost, list_price, scode, mount_pos) VALUES ($1,$2,$3,30,100,$4,$5) RETURNING id`,
      [code, name, stock, syd || null, extra.mount_pos || null])).rows[0].id);
    if (syd) await query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,$2)`, [id, syd]);
    for (const [y1, y2] of app) await query(
      `INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, `${MK} ${MD} ${y1}-${y2}`, MK, MD, y1, y2]);
    return { id, code };
  };
  ID.A = await mkP('-A', 'ROTULA INFERIOR', 12, [[2012, 2019]], `${TAG}S1`, { mount_pos: 'Delantera Inferior Izquierda' });
  ID.B = await mkP('-B', 'TERMINAL INTERIOR', 0, [[2012, 2019]], `${TAG}S2`);
  ID.C = await mkP('-C', 'TORNILLO ESTABILIZADOR', 4, [[2020, 2023]], null);        // 연식 밖(2015 조회 시)
  ID.D = await mkP('-D', 'BUJE DE HORQUILLA', 3, [[2010, 2016]], null);              // 위치 없음
  // 업로드 위치: B = 이 차종 줄(앞 · 좌/우) + 다른 차종 줄(뒤)
  await query(`INSERT INTO product_positions (ctr_code, block, level, side, brand, model, y_from, y_to) VALUES
    ($1,'front',NULL,'lh',$2,$3,2012,2019),($1,'front',NULL,'rh',$2,$3,2012,2019),($1,'rear',NULL,'lh','OTRA','Otro',2000,2005)`, [ID.B.code, MK, MD]);
  // OE · BAW(xref 직접)
  await query(`INSERT INTO product_oe_codes (product_id, oe_code, oe_norm, rel, source) VALUES ($1,'40160-3AN0A','401603AN0A','oe','master')`, [ID.A.id]).catch((e) => console.log('# oe', e.message));
  await query(`INSERT INTO product_xref_codes (product_id, xref_code, norm_code, brand) VALUES ($1,'BW-77','BW77','BAW')`, [ID.B.id]);
  // 랙
  await query(`INSERT INTO product_rack_stock (product_id, rack, qty) VALUES ($1,'A-03-2',12)`, [ID.A.id]).catch((e) => console.log('# rack', e.message));
  // 운송 중
  const sh = Number((await query(`INSERT INTO inbound_shipments (status, eta) VALUES ('incoming', '2026-12-20') RETURNING id`)).rows[0].id);
  const pl = Number((await query(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no) VALUES ($1,$2,1) RETURNING id`, [sh, TAG + 'PO'])).rows[0].id);
  await query(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, input_code, cartons, qty, product_id) VALUES ($1,$2,$3,1,200,$4)`, [pl, sh, ID.A.code, ID.A.id]);
  // 백오더
  await query(`INSERT INTO stock_shortages (product_id, requested_qty, shortage_qty, resolved_qty, occurred_at, status) VALUES
    ($1,40,35,5,'2026-11-01','open'),($1,10,10,0,'2026-11-02','resolved')`, [ID.B.id]);
  // 11-27c · 공장 발주 미입고: A 발주 1500(입고 0) → 운송 200 · 생산 중 1300 / B 발주 50(입고 10) → 생산 중 40
  const po = Number((await query(`INSERT INTO purchase_orders (ref_no, order_date, status) VALUES ($1, '2026-10-01', 'recorded') RETURNING id`, [TAG + 'PO1'])).rows[0].id);
  ID.po = po;
  await query(`INSERT INTO purchase_order_lines (po_id, product_id, input_code, qty, received_qty, unit_cost_usd, amount_usd) VALUES ($1,$2,$3,1500,0,1,1500),($1,$4,$5,50,10,1,50)`, [po, ID.A.id, ID.A.code, ID.B.id, ID.B.code]);
  // 매출: 게시 2건 + 작성중 1건 + 삭제 1건
  const cu = Number((await query(`INSERT INTO customers (name, code) VALUES ($1,$2) RETURNING id`, [TAG + '고객', TAG + '-CU'])).rows[0].id);
  const inv = async (status, del, q) => {
    const iid = Number((await query(`INSERT INTO sales_invoices (customer_id, inv_date, status, deleted_at) VALUES ($1,'2026-11-10',$2,$3) RETURNING id`, [cu, status, del ? new Date() : null])).rows[0].id);
    await query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, unit_price, line_amount_mxn) VALUES ($1,$2,$3,100,55,$4)`, [iid, ID.A.id, q, q * 55]);
  };
  await inv('posted', false, 100); await inv('posted', false, 60); await inv('edit_pending', false, 999); await inv('posted', true, 777);
  // 크로스레퍼런스 마스터(활성 버전): 1행 = SYD S1(ERP 연결) · 2행 = CTR 없음 이 차종 · 3행 = 다른 메이커 · 4행 = 연식 밖 · 5행 = BAW 만
  const prevActive = (await query(`SELECT id FROM xref_master_versions WHERE is_active`)).rows.map((r) => Number(r.id));
  ID.prevActive = prevActive;
  await query(`UPDATE xref_master_versions SET is_active=false WHERE is_active`);
  const v = Number((await query(`INSERT INTO xref_master_versions (filename, is_active) VALUES ($1, true) RETURNING id`, [TAG + '_x.xlsx'])).rows[0].id);
  ID.ver = v;
  const rows = [
    [2, { SYD: [`${TAG}S1`], BAW: ['BW-11'] }, 'ROTULA INFERIOR', `${MK} ${MD} 2012-2019`, 'Delantera Inferior'],
    [3, { SYD: [`${TAG}S9`], BAW: ['BW-99'] }, 'HORQUILLA INFERIOR', `${MD} 12-19`, 'Delantero Izq'],
    [4, { SYD: [`${TAG}S8`] }, 'AMORTIGUADOR', `OTRAMARCA ${MD} 2015`, 'Trasero'],
    [5, { SYD: [`${TAG}S7`] }, 'BUJE', `${MK} ${MD} 2001-2004`, null],
    [6, { BAW: ['BW-55'] }, 'TORNILLO ESTABILIZADOR TRASERO', `${MK} ${MD}`, null],
  ];
  for (const [rn, codes, d, a, u] of rows) {
    await query(`INSERT INTO xref_master_rows (version_id, row_no, codes, descripcion, aplicacion, ubicacion) VALUES ($1,$2,$3,$4,$5,$6)`, [v, rn, JSON.stringify(codes), d, a, u]);
    for (const [b, list] of Object.entries(codes)) for (const c of list)
      await query(`INSERT INTO xref_master_codes (version_id, row_no, brand, code, norm_code) VALUES ($1,$2,$3,$4,$5)`, [v, rn, b, c, c.toUpperCase().replace(/[^A-Z0-9]/g, '')]);
  }
  // 다른 메이커 거름 판정용 — OTRAMARCA 가 product_applications 메이커에 있어야 한다
  await query(`INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,'OTRAMARCA X 2010','OTRAMARCA','X',2010,2010)`, [ID.D.id]);
  const { invalidateXrefMaster, setXrefMasterReady } = await import('../src/xrefMaster.js');
  invalidateXrefMaster(); setXrefMasterReady(true);
  const { buildApp } = await import('../src/server.js');
  app = buildApp(); await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.sales = app.jwt.sign({ sub: ID.sales });
  tok.none = app.jwt.sign({ sub: ID.none });
  tok.qonly = app.jwt.sign({ sub: ID.qonly });
});
after(async () => {
  if (!PG) return;
  await cleanup();
  if (ID.prevActive && ID.prevActive.length) await query(`UPDATE xref_master_versions SET is_active=true WHERE id = ANY($1::bigint[])`, [ID.prevActive]).catch(() => {});
  try { await app.close(); } catch (_) {}
  await pool.end().catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});

const url = (y) => `/api/products/vehicle-map?maker=${encodeURIComponent(MK)}&model=${encodeURIComponent(MD)}${y ? '&year=' + y : ''}`;

test('① 차종 → CTR 제품 · 연식 · 필수값 · 권한', { skip: SKIP }, async () => {
  assert.equal((await get(`/api/products/vehicle-map?maker=${MK}`)).statusCode, 400, '모델 필수');
  assert.equal((await get(url(2015), 'none')).statusCode, 403, '제품 · 견적 화면 권한 없으면 403');
  assert.equal((await get(url(2015), 'qonly')).statusCode, 200, '11-27f · 견적 화면 권한만 있어도 차량 도면');
  for (const ep of ['app-makers', `app-models?maker=${encodeURIComponent(MK)}`, `app-years?maker=${encodeURIComponent(MK)}`])
    assert.equal((await get('/api/products/' + ep, 'qonly')).statusCode, 200, ep + ' — 견적 사용자');
  assert.equal((await get(url(2015))).json().items.find((x) => x.code === ID.A.code).is_active, true, 'is_active 포함');
  const r = await get(url(2015));
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  const codes = d.items.map((x) => x.code).sort();
  assert.deepEqual(codes, [ID.A.code, ID.B.code, ID.D.code], 'C(2020-2023)는 2015 에 없음');
  assert.equal(d.counts.ctr, 3);
  assert.equal(d.counts.ctr_in_stock, 2);
  const all = (await get(url())).json();
  assert.equal(all.items.length, 4, '연식 비우면 전체');
});

test('② 장착위치 우선순위 · 부품 무리', { skip: SKIP }, async () => {
  const d = (await get(url(2015))).json();
  const by = Object.fromEntries(d.items.map((x) => [x.code, x]));
  assert.equal(by[ID.A.code].pos.src, 'erp');
  assert.deepEqual(by[ID.A.code].pos.blocks, ['front']);
  assert.deepEqual(by[ID.A.code].pos.sides, ['lh']);
  assert.equal(by[ID.B.code].pos.src, 'vehicle', '이 차종 업로드 줄만');
  assert.deepEqual(by[ID.B.code].pos.blocks, ['front'], '다른 차종의 뒤 줄은 안 섞인다');
  assert.deepEqual(by[ID.B.code].pos.sides, ['lh', 'rh']);
  assert.equal(by[ID.D.code].pos, null);
  assert.equal(by[ID.A.code].cat, 'ball');
  assert.equal(by[ID.B.code].cat, 'rack');
  assert.equal(by[ID.D.code].cat, 'bush');
  assert.equal(d.counts.ctr_placed, 2);
});

test('③ 수량 — 창고 · 운송 · 백오더 · 누적판매(팀 가시성)', { skip: SKIP }, async () => {
  const d = (await get(url(2015))).json();
  const by = Object.fromEntries(d.items.map((x) => [x.code, x]));
  assert.equal(by[ID.A.code].stock_qty, 12);
  assert.equal(by[ID.A.code].transit_qty, 200);
  assert.equal(by[ID.A.code].transit_eta, '2026-12-20');
  assert.equal(by[ID.A.code].sold_qty, 160, '게시 · 미삭제만(수정대기 999 · 삭제 777 제외)');
  assert.equal(by[ID.A.code].po_open_qty, 1500, '발주 미입고 잔량');
  assert.equal(by[ID.A.code].backorder_qty, 1300, '백오더 = 생산 중 = 1500 − 운송 200');
  assert.equal(by[ID.B.code].backorder_qty, 40, '생산 중 50−10');
  assert.equal(by[ID.B.code].short_qty, 30, '고객 미출고 부족분(참고) open 잔량 35−5, resolved 제외');
  assert.equal(by[ID.B.code].stock_qty, 0);
  assert.deepEqual(by[ID.A.code].racks, [{ rack: 'A-03-2', qty: 12 }]);
  const s = (await get(url(2015), 'sales')).json();
  const sa = s.items.find((x) => x.code === ID.A.code);
  assert.equal(sa.sold_qty, 0, '팀 없는 영업 — 다른 팀 고객 판매는 안 보인다');
  assert.equal(sa.stock_qty, 12);
  assert.ok(!('avg_cost' in sa) && !('list_price' in sa), '가격 · 원가 없음');
});

test('④ 코드 — SYD · OE · BAW', { skip: SKIP }, async () => {
  const d = (await get(url(2015))).json();
  const by = Object.fromEntries(d.items.map((x) => [x.code, x]));
  assert.deepEqual(by[ID.A.code].syd, [`${TAG}S1`]);
  assert.deepEqual(by[ID.A.code].oe, ['40160-3AN0A']);
  assert.deepEqual(by[ID.A.code].baw, ['BW-11'], '마스터 같은 행 BAW');
  assert.deepEqual(by[ID.B.code].baw, ['BW-77'], 'product_xref_codes BAW');
  assert.deepEqual(by[ID.D.code].syd, []);
});

test('⑤ 경쟁사만(CTR 없음) — SYD · BAW · 위치 · 거름', { skip: SKIP }, async () => {
  const d = (await get(url(2015))).json();
  const rows = d.competitors.map((c) => c.row_no).sort();
  assert.deepEqual(rows, [3, 6], '2행=ERP 연결 · 4행=다른 메이커 · 5행=연식 밖');
  const r3 = d.competitors.find((c) => c.row_no === 3);
  assert.deepEqual(r3.syd, [`${TAG}S9`]);
  assert.deepEqual(r3.baw, ['BW-99']);
  assert.equal(r3.cat, 'arm');
  assert.deepEqual(r3.pos.blocks, ['front']);
  assert.deepEqual(r3.pos.sides, ['lh']);
  assert.equal(r3.year_known, true);
  const r6 = d.competitors.find((c) => c.row_no === 6);
  assert.deepEqual(r6.syd, []);
  assert.deepEqual(r6.baw, ['BW-55'], 'BAW 만 있는 행');
  assert.equal(r6.cat, 'link');
  assert.deepEqual(r6.pos.blocks, ['rear'], 'UBICACIÓN 없으면 품명에서');
  assert.equal(r6.year_known, false);
  const y2002 = (await get(url(2002))).json();
  assert.ok(y2002.competitors.some((c) => c.row_no === 5), '2002 면 5행(2001-2004)');
  assert.equal(d.counts.competitors, 2);
});

test('⑥ 11-27b · 이름 키 — 대소문자 · 하이픈 · 공백이 달라도 같은 메이커 · 모델', { skip: SKIP }, async () => {
  // 카탈로그 원문은 그대로: 메이커 소문자 · 모델 하이픈 표기로 한 제품 더
  const e = Number((await query(`INSERT INTO products (code, name, stock_qty) VALUES ($1,'HORQUILLA SUPERIOR',2) RETURNING id`, [TAG + '-E'])).rows[0].id);
  const mdH = 'MDL-' + RUN;   // MD = 'Mdl' + RUN 과 같은 키
  await query(`INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,$2,$3,$4,2012,2019)`,
    [e, `${MK.toLowerCase()} ${mdH} 2012-2019`, MK.toLowerCase(), mdH]);
  await query(`INSERT INTO xref_master_rows (version_id, row_no, codes, descripcion, aplicacion, ubicacion) VALUES ($1,7,$2,'ROTULA SUPERIOR',$3,'Delantera')`,
    [ID.ver, JSON.stringify({ SYD: [`${TAG}S6`] }), `${MK} mdl ${RUN} 12-19`]);
  await query(`INSERT INTO xref_master_codes (version_id, row_no, brand, code, norm_code) VALUES ($1,7,'SYD',$2,$2)`, [ID.ver, `${TAG}S6`]);

  // 드롭다운: 키마다 한 줄 · 묶인 표기
  const mk = (await get('/api/products/app-makers')).json();
  const mine = mk.groups.filter((g) => g.key === MK.toUpperCase());
  assert.equal(mine.length, 1, '메이커 한 줄');
  assert.deepEqual(mine[0].variants.slice().sort(), [MK, MK.toLowerCase()].sort());
  assert.equal(mk.items.filter((x) => x.toUpperCase() === MK.toUpperCase()).length, 1);
  const md = (await get(`/api/products/app-models?maker=${encodeURIComponent(MK.toLowerCase())}`)).json();
  assert.equal(md.groups.length, 1, '모델 한 줄(Mdl / MDL- 묶음)');
  assert.equal(md.groups[0].label, MD, '많이 쓰인 표기가 대표');
  assert.ok(md.groups[0].variants.includes(mdH));
  const yr = (await get(`/api/products/app-years?maker=${encodeURIComponent(MK)}&model=${encodeURIComponent('mdl ' + RUN)}`)).json();
  assert.ok(yr.items.includes(2015) && yr.items.includes(2012) && yr.items.includes(2023));

  // 도면 · 예전 차종 검색: 어떤 표기로 골라도 같은 결과
  const codesOf = async (maker, model) => (await get(`/api/products/vehicle-map?maker=${encodeURIComponent(maker)}&model=${encodeURIComponent(model)}&year=2015`)).json();
  const a = await codesOf(MK, MD), b = await codesOf(MK.toLowerCase(), mdH), c = await codesOf(' ' + MK + ' ', 'mdl ' + RUN);
  const ks = (d) => d.items.map((x) => x.code).sort().join(',');
  assert.ok(ks(a).includes(TAG + '-E'), '하이픈 표기 제품도 나온다');
  assert.equal(ks(a), ks(b)); assert.equal(ks(a), ks(c));
  assert.ok(a.competitors.some((x) => x.row_no === 7), "마스터 'mdl 1234' 공백 표기도 같은 모델");
  const bv = (await get(`/api/products/by-vehicle?maker=${encodeURIComponent(MK.toLowerCase())}&model=${encodeURIComponent(mdH)}`)).json();
  assert.ok(bv.items.some((x) => x.code === TAG + '-A') && bv.items.some((x) => x.code === TAG + '-E'), 'by-vehicle 도 이름 키');
  assert.equal((await get(`/api/products/vehicle-map?maker=${encodeURIComponent('--')}&model=x`)).statusCode, 400, '기호만이면 400');
});

test('⑦ 11-27e · 한 칸에 메이커 여럿(FORD, MERCURY) — 낱개 메이커로 드롭다운 · 찾기', { skip: SKIP }, async () => {
  const F = TAG + 'FD', M = TAG + 'MC', GM = 'GrandMq' + RUN;
  const mk = async (sfx, maker, model) => {
    const id = Number((await query(`INSERT INTO products (code, name, stock_qty) VALUES ($1,'ROTULA INFERIOR',1) RETURNING id`, [TAG + sfx])).rows[0].id);
    await query(`INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,$2,$3,$4,2003,2011)`, [id, `${maker} ${model} 2003-2011`, maker, model]);
  };
  await mk('-F1', `${F}, ${M}`, GM);          // 한 칸 두 메이커
  await mk('-F2', F.toLowerCase(), 'Focus' + RUN);
  await mk('-F3', M, 'Sable' + RUN);
  await query(`INSERT INTO xref_master_rows (version_id, row_no, codes, descripcion, aplicacion, ubicacion) VALUES ($1,8,$2,'HORQUILLA',$3,'Delantera')`,
    [ID.ver, JSON.stringify({ SYD: [`${TAG}S5`] }), `${F}, ${M} ${GM} 2003-2011`]);
  await query(`INSERT INTO xref_master_codes (version_id, row_no, brand, code, norm_code) VALUES ($1,8,'SYD',$2,$2)`, [ID.ver, `${TAG}S5`]);

  const g = (await get('/api/products/app-makers')).json().groups;
  assert.equal(g.filter((x) => x.key === F.toUpperCase()).length, 1, 'FORD 한 줄');
  assert.equal(g.filter((x) => x.key === M.toUpperCase()).length, 1, 'MERCURY 한 줄');
  assert.equal(g.filter((x) => x.key === (F + M).toUpperCase()).length, 0, "'FORD, MERCURY' 줄은 없음");
  const models = async (m) => (await get(`/api/products/app-models?maker=${encodeURIComponent(m)}`)).json().items.sort();
  assert.deepEqual(await models(F), [GM, 'Focus' + RUN].sort(), 'FORD → 같이 적힌 Grand Marquis + Focus');
  assert.deepEqual(await models(M), [GM, 'Sable' + RUN].sort(), 'MERCURY → Grand Marquis + Sable');
  const yrs = (await get(`/api/products/app-years?maker=${encodeURIComponent(M)}&model=${encodeURIComponent(GM)}`)).json().items;
  assert.ok(yrs.includes(2005));
  for (const m of [F, M.toLowerCase()]) {
    const d = (await get(`/api/products/vehicle-map?maker=${encodeURIComponent(m)}&model=${encodeURIComponent(GM)}&year=2005`)).json();
    assert.deepEqual(d.items.map((x) => x.code), [TAG + '-F1'], m + ' 로 골라도 같은 제품');
    assert.ok(d.competitors.some((x) => x.row_no === 8), m + ' · 마스터의 FORD, MERCURY 표기도 맞음');
  }
  const bv = (await get(`/api/products/by-vehicle?maker=${encodeURIComponent(M)}`)).json();
  assert.deepEqual(bv.items.map((x) => x.code).sort(), [TAG + '-F1', TAG + '-F3'].sort());
});

test('⑧ 11-27f · 도면에서 담은 줄 그대로 견적 저장 → 재고부족 표시 · CTR 없는 코드는 개발요청(입력 브랜드)', { skip: SKIP }, async () => {
  const cid = Number((await query(`SELECT id FROM customers WHERE name = $1`, [TAG + '고객'])).rows[0].id);
  // 견적 화면 qvmPick 이 만드는 줄과 같은 모양
  const lines = [
    { code: ID.A.code, product_id: ID.A.id, qty: 20 },        // 창고 12 → 부족
    { code: 'BW-99', brand: 'BAW', qty: 2 },                    // ⑤의 3행 — CTR 없음
  ];
  const pv = await app.inject({ method: 'POST', url: '/api/quotes/preview', headers: { authorization: 'Bearer ' + tok.dir }, payload: { customer_id: cid, lines } });
  assert.equal(pv.statusCode, 200, pv.body);
  const pl = pv.json().lines;
  assert.equal(pl[0].matched, true);
  assert.notEqual(pl[0].stock_flag, 'ok', '재고 12 < 20 → 부족 표시');
  assert.equal(pl[1].matched, false); assert.equal(pl[1].stock_flag, 'not_found'); assert.equal(pl[1].input_brand, 'BAW');
  const sv = await app.inject({ method: 'POST', url: '/api/quotes', headers: { authorization: 'Bearer ' + tok.dir }, payload: { customer_id: cid, lines } });
  assert.equal(sv.statusCode, 200, sv.body);
  const qid = Number(sv.json().id);
  const ql = (await query(`SELECT input_code, product_id, qty, stock_flag FROM quote_lines WHERE quote_id=$1 ORDER BY line_no`, [qid])).rows;
  assert.equal(Number(ql[0].product_id), ID.A.id); assert.notEqual(ql[0].stock_flag, 'ok');
  assert.equal(ql[1].product_id, null); assert.equal(ql[1].stock_flag, 'not_found');
  const dr = (await query(`SELECT input_code, input_brand FROM product_dev_requests WHERE source_quote_id=$1`, [qid])).rows;
  assert.deepEqual(dr.map((r) => [r.input_code, r.input_brand]), [['BW-99', 'BAW']], '개발요청 · 입력 브랜드');
  await query(`DELETE FROM product_dev_requests WHERE source_quote_id=$1`, [qid]);
  await query(`DELETE FROM quote_lines WHERE quote_id=$1`, [qid]).catch(() => {});
  await query(`DELETE FROM quotes WHERE id=$1`, [qid]).catch(() => {});
});

test('⑨ 11-27g · app-models?year= — 그 연식이 적용 범위에 드는 모델만', { skip: SKIP }, async () => {
  const F = TAG + 'FD';   // ⑦에서 만든 메이커: GrandMq(2003-2011) · Focus(2003-2011)
  const id = Number((await query(`INSERT INTO products (code, name, stock_qty) VALUES ($1,'BUJE',1) RETURNING id`, [TAG + '-F4'])).rows[0].id);
  await query(`INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,$2,$3,$4,2015,2019)`, [id, `${F} Escape${RUN} 2015-2019`, F, 'Escape' + RUN]);
  const m = async (y) => (await get(`/api/products/app-models?maker=${encodeURIComponent(F)}${y ? '&year=' + y : ''}`)).json().items.sort();
  assert.deepEqual(await m(), ['Escape' + RUN, 'Focus' + RUN, 'GrandMq' + RUN].sort(), '연식 없으면 전부');
  assert.deepEqual(await m(2017), ['Escape' + RUN]);
  assert.deepEqual(await m(2005), ['Focus' + RUN, 'GrandMq' + RUN].sort());
  assert.deepEqual(await m(1990), []);
  const yrs = (await get(`/api/products/app-years?maker=${encodeURIComponent(F)}`)).json().items;
  assert.ok(yrs.includes(2017) && yrs.includes(2005), '메이커만으로 연식 목록');
});

test('⑩ 11-27h · 연식 범위 밖(3008 등)은 연식 목록에서 빼고 odd 로 알려 준다', { skip: SKIP }, async () => {
  const P = TAG + 'PG';
  const id = Number((await query(`INSERT INTO products (code, name, stock_qty) VALUES ($1,'BUJE',1) RETURNING id`, [TAG + '-P1'])).rows[0].id);
  // 예전 분해 규칙이 만든 줄 그대로: 모델명 3008 이 연식으로, 오타 2008-3008
  await query(`INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES
    ($1,$2,$3,NULL,3008,3008),($1,$4,$3,'5008',2017,2020),($1,$5,$3,'Partner',2008,3008)`,
    [id, `${P} 3008`, P, `${P} 5008 2017-2020`, `${P} Partner 2008-3008`]);
  const d = (await get(`/api/products/app-years?maker=${encodeURIComponent(P)}`)).json();
  const ymax = new Date().getFullYear() + 2;
  assert.ok(d.items.every((y) => y >= 1950 && y <= ymax), '목록은 1950 ~ 올해+2 안');
  assert.ok(!d.items.includes(3008));
  assert.ok(d.items.includes(2017) && d.items.includes(2008), '오타 범위도 올해+2 까지만 펼침');
  assert.deepEqual(d.range, [1950, ymax]);
  assert.deepEqual(d.odd.map((o) => o.app_text).sort(), [`${P} 3008`, `${P} Partner 2008-3008`].sort(), '범위 밖 줄을 알려 줌');
  // 새 분해 규칙(재동기화 · 다음 업로드): 3008 은 모델명으로
  const { parseAppEntry } = await import('../src/productImport.js');
  assert.deepEqual([parseAppEntry('PEUGEOT 3008').model, parseAppEntry('PEUGEOT 3008').year_from], ['3008', null]);
});

test('⑪ 11-27h · 메이커 소문자 섞임(Nissan) — ERP 수정 저장 · 재동기화 뒤 차종으로 찾아진다', { skip: SKIP }, async () => {
  const MD2 = 'Kicks' + RUN;
  // ① 제품 화면 수정(PATCH) — 원문 'Nissan Kicks… 2017-2024' 그대로 저장
  const id = Number((await query(`INSERT INTO products (code, name, stock_qty) VALUES ($1,'ROTULA INFERIOR',2) RETURNING id`, [TAG + '-N1'])).rows[0].id);
  const r = await app.inject({ method: 'PATCH', url: `/api/products/${id}`, headers: { authorization: 'Bearer ' + tok.dir }, payload: { app: `Nissan ${MD2} 2017-2024` } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await query(`SELECT app FROM products WHERE id=$1`, [id])).rows[0].app, `Nissan ${MD2} 2017-2024`, '원문은 그대로');
  const pa = (await query(`SELECT maker, model, year_from, year_to FROM product_applications WHERE product_id=$1`, [id])).rows;
  assert.deepEqual(pa.map((x) => [x.maker, x.model, x.year_from, x.year_to]), [['Nissan', MD2, 2017, 2024]], '메이커가 비지 않는다');
  const mods = (await get(`/api/products/app-models?maker=NISSAN&year=2020`)).json().items;
  assert.ok(mods.includes(MD2), 'NISSAN · 2020 모델 목록에 나온다');
  const d = (await get(`/api/products/vehicle-map?maker=NISSAN&model=${encodeURIComponent(MD2)}&year=2020`)).json();
  assert.deepEqual(d.items.map((x) => x.code), [TAG + '-N1'], '차량 도면에 나온다');
  // ② 예전 규칙으로 분해돼 메이커가 빈 줄 → 「분해 데이터 전체 재동기화」 하면 고쳐진다(원문 기준)
  const id2 = Number((await query(`INSERT INTO products (code, name, stock_qty, app) VALUES ($1,'BUJE',1,$2) RETURNING id`, [TAG + '-N2', `Great Wall Poer${RUN} 2021-2025`])).rows[0].id);
  await query(`INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,$2,NULL,$3,2021,2025)`, [id2, `Great Wall Poer${RUN} 2021-2025`, `Great Wall Poer${RUN}`]);
  const rs = await app.inject({ method: 'POST', url: '/api/products/resync-derived', headers: { authorization: 'Bearer ' + tok.dir } });
  assert.equal(rs.statusCode, 200, rs.body);
  const pa2 = (await query(`SELECT maker, model FROM product_applications WHERE product_id=$1`, [id2])).rows;
  assert.deepEqual(pa2.map((x) => [x.maker, x.model]), [['Great Wall', 'Poer' + RUN]]);
  const g = (await get('/api/products/app-makers')).json().groups;
  assert.ok(g.some((x) => x.key === 'GREATWALL'), "드롭다운에 'Great Wall' 한 줄");
});
