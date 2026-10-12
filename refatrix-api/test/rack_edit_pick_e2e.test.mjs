// =====================================================================
// 0269 · 실사 랙 업로드 · 창고 위치수정 · 피킹 기록 — 종단 검증 (실 PostgreSQL)  2026-10-12
//   디렉터 지시:
//     ① SKU × 랙 × 수량을 저장하고 보여준다(실사 엑셀 업로드)
//     ② 창고담당자가 SKU 별로 「기존 위치 → 새 위치 + 수량」으로 수정 — 등록 재고를 벗어나지 않게
//     ③ 포장작업지시서에 랙 × 수량을 모두 보여주고, 피킹할 때 어느 랙에서 집었는지 기록
//   실행: TEST_PG_URL=postgres://... node --test test/rack_edit_pick_e2e.test.mjs
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
const TAG = 'RETEST';

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
  const P = `SELECT id FROM products WHERE code LIKE '${TAG}%'`;
  const custIds = (await query(`SELECT id FROM customers WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  const invIds = custIds.length ? (await query(`SELECT id FROM sales_invoices WHERE customer_id = ANY($1::bigint[])`, [custIds])).rows.map((r) => Number(r.id)) : [];
  await query(`DELETE FROM product_rack_moves WHERE product_id IN (${P})`).catch(() => {});
  await query(`DELETE FROM product_rack_stock WHERE product_id IN (${P})`).catch(() => {});
  await query(`DELETE FROM quote_pick_alloc WHERE product_id IN (${P})`).catch(() => {});
  if (invIds.length) {
    await query(`UPDATE sales_invoices SET txn_id=NULL WHERE id = ANY($1::bigint[])`, [invIds]).catch(() => {});
    await purgeRefs('sales_invoice_lines', (await query(`SELECT id FROM sales_invoice_lines WHERE invoice_id = ANY($1::bigint[])`, [invIds])).rows.map((r) => Number(r.id)));
    await query(`DELETE FROM sales_invoice_lines WHERE invoice_id = ANY($1::bigint[])`, [invIds]);
    await purgeRefs('sales_invoices', invIds);
    await query(`DELETE FROM sales_invoices WHERE id = ANY($1::bigint[])`, [invIds]);
  }
  await query(`DELETE FROM stock_shortages WHERE product_id IN (${P})`);
  await query(`DELETE FROM stock_movements WHERE product_id IN (${P})`);
  const qids = (await query(`SELECT id FROM quotes WHERE quote_no LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
  await purgeRefs('quotes', qids);
  await query(`DELETE FROM quote_lines WHERE quote_id = ANY($1::bigint[])`, [qids]);
  await query(`DELETE FROM quotes WHERE quote_no LIKE '${TAG}%'`);
  await query(`DELETE FROM rack_kinds WHERE rack LIKE 'REFM%'`);
  await purgeRefs('products', (await query(P)).rows.map((r) => Number(r.id)));
  await query(`DELETE FROM products WHERE code LIKE '${TAG}%'`);
  await purgeRefs('customers', custIds);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  const uids = (await query(`SELECT id FROM users WHERE login_id LIKE 'retest%'`)).rows.map((r) => Number(r.id));
  await query(`DELETE FROM rack_stock_imports WHERE created_by = ANY($1::bigint[])`, [uids]).catch(() => {});
  await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [uids]);
  await purgeRefs('users', uids);
  await query(`DELETE FROM users WHERE login_id LIKE 'retest%'`);
}

async function boot() {
  ({ query } = await import('../src/db.js'));
  rs = await import('../src/rackStock.js');
  const { hashPin } = await import('../src/auth.js');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();
  const mkU = async (login, role) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`${TAG}${login}`, role, hashPin('4321'), login])).rows[0].id);
  ID.dir = await mkU('retest_dir', 'director');
  ID.wh = await mkU('retest_wh', 'warehouse');          // 창고담당(edit)
  ID.ro = await mkU('retest_ro', 'warehouse');          // 창고 열람만
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'warehouse','anywhere','edit'),($2,'warehouse','anywhere','view')`, [ID.wh, ID.ro]);
  const mkP = async (code, stock, ean) => Number((await query(
    `INSERT INTO products (code, name, stock_qty, avg_cost, list_price, ean) VALUES ($1,$2,$3,100,500,$4) RETURNING id`,
    [code, code + ' 부품', stock, ean || ('76' + String(Math.floor(Math.random() * 1e10)).padStart(11, '0'))])).rows[0].id);
  ID.p1 = await mkP(`${TAG}-P1`, 19);
  ID.p2 = await mkP(`${TAG}-P2`, 7);
  ID.p3 = await mkP(`${TAG}-P3`, 10, '0759000000123');
  ID.cust = Number((await query(
    `INSERT INTO customers (name, code, credit_days, rfc, owner_id, created_by) VALUES ($1,$2,30,'XAXX010101000',$3,$3) RETURNING id`,
    [`${TAG}고객`, `${TAG}-C`, ID.dir])).rows[0].id);
  await query(`INSERT INTO rack_kinds (rack, kind) VALUES ('REFM-01','fast')`);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (r, body, done) => {
    if (!body || !String(body).trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
  });
  for (const f of ['quoteRoutes', 'salesRoutes', 'warehouseRoutes', 'rackStockRoutes']) {
    await app.register((await import(`../src/routes/${f}.js`)).default);
  }
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.wh = app.jwt.sign({ sub: ID.wh });
  tok.ro = app.jwt.sign({ sub: ID.ro });
}

const H = (who = 'dir') => ({ authorization: 'Bearer ' + tok[who] });
const get = (url, who) => app.inject({ method: 'GET', url, headers: H(who) });
const post = (url, body, who) => app.inject({ method: 'POST', url, payload: body || {}, headers: H(who) });
const racksOf = async (pid) => (await query(`SELECT rack, qty::float AS qty FROM product_rack_stock WHERE product_id=$1 ORDER BY rack`, [pid])).rows
  .map((r) => `${r.rack}=${r.qty}`).join(',');

// 실사 엑셀(가로형: 코드 · 랙/수량 ×6) 을 화면이 줄로 풀어 보내는 형태
const ROWS = () => [
  { line: 2, code: `${TAG}-P1`, rack: 'ae1-1', qty: 10, sig: 'a' },
  { line: 2, code: `${TAG}-P1`, rack: 'REFM-01', qty: 9, sig: 'a2' },     // P1 = 19 = 재고 → ok
  { line: 3, code: `${TAG}-P2`, rack: 'AE2-1', qty: 9, sig: 'b' },         // P2 재고 7 → 초과(저장 안 함)
  { line: 4, code: '759000000123', rack: 'AE3-1', qty: 6, sig: 'c' },      // EAN(앞자리 0 빠짐) → P3, 재고 10 → under
  { line: 5, code: '759000000123', rack: 'AE3-1', qty: 6, sig: 'c' },      // 같은 줄 반복 → 한 번만
  { line: 6, code: 'NOPE-999', rack: 'AE9-9', qty: 1, sig: 'd' },          // 없는 코드
  { line: 7, code: 'NOPE-888', rack: '', qty: 1, sig: 'e' },               // 랙 빈칸 → 줄 오류(제품 없음)
];

test('boot', { skip: SKIP }, async () => { await boot(); assert.equal(await rs.rackEditReady(), true); });

test('① 실사 업로드 미리보기 — 일치·부족·초과·중복·미등록·오류 판정', { skip: SKIP }, async () => {
  const r = await post('/api/rack-stock/import/preview', { rows: ROWS() }, 'wh');
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  const by = Object.fromEntries(j.skus.map((s) => [s.code, s]));
  assert.equal(by[`${TAG}-P1`].status, 'ok');
  assert.deepEqual(by[`${TAG}-P1`].racks.map((x) => [x.rack, x.qty]), [['AE1-1', 10], ['REFM-01', 9]]);
  assert.equal(by[`${TAG}-P2`].status, 'over');
  assert.equal(by[`${TAG}-P3`].status, 'under');
  assert.equal(by[`${TAG}-P3`].total, 6, '같은 줄 두 번 → 6 (12 아님)');
  assert.equal(by[`${TAG}-P3`].dup_lines, 1);
  assert.equal(j.unknown[0].code, 'NOPE-999');
  assert.equal(j.errors.length, 1);
  assert.equal(j.counts.over, 1);
  assert.equal(await racksOf(ID.p1), '', '미리보기는 저장하지 않는다');
});

test('② 업로드 적용 — 디렉터만 · 초과 SKU 는 저장 안 함 · 파일 내용으로 통째로 맞춤', { skip: SKIP }, async () => {
  const deny = await post('/api/rack-stock/import', { rows: ROWS() }, 'wh');
  assert.equal(deny.statusCode, 403, '창고담당은 업로드 적용 불가(디렉터)');
  await post('/api/rack-stock/set', { product_id: ID.p1, rack: 'ZZ9-9', qty: 2 });   // 파일에 없는 옛 위치
  const r = await post('/api/rack-stock/import', { rows: ROWS(), file_name: 'conteos.xlsx' });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.skus, 2);
  assert.deepEqual(j.blocked.map((b) => b.code), [`${TAG}-P2`]);
  assert.equal(await racksOf(ID.p1), 'AE1-1=10,REFM-01=9', '파일에 없는 ZZ9-9 는 0 으로');
  assert.equal(await racksOf(ID.p2), '', '초과 SKU 는 저장하지 않는다');
  assert.equal(await racksOf(ID.p3), 'AE3-1=6', '나머지 4 = 위치 미지정');
  const n = (await query(`SELECT COUNT(*)::int n FROM product_rack_moves WHERE ref=$1 AND reason='import'`, [`rack_import:${j.id}`])).rows[0].n;
  assert.ok(n >= 3);
  // 같은 파일 다시 → 바뀐 것 없음
  const again = (await post('/api/rack-stock/import', { rows: ROWS() })).json();
  assert.equal(again.skus, 0);
  const hist = (await get('/api/rack-stock/imports', 'wh')).json();
  assert.ok(hist.items.some((x) => x.file_name === 'conteos.xlsx' && x.skus === 2 && x.blocked === 1));
});

test('③ 위치수정(창고담당) — 기존 랙 → 새 랙 + 수량, 재고 합계를 벗어날 수 없다', { skip: SKIP }, async () => {
  const ok = await post('/api/rack-stock/transfer', { product_id: ID.p1, from: 'AE1-1', to: 'ae2-2', qty: 4, note: '정리' }, 'wh');
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(await racksOf(ID.p1), 'AE1-1=6,AE2-2=4,REFM-01=9');
  assert.equal(ok.json().located, 19);
  // 출발 랙 수량보다 많이
  const r1 = await post('/api/rack-stock/transfer', { product_id: ID.p1, from: 'AE2-2', to: 'AE1-1', qty: 5 }, 'wh');
  assert.equal(r1.statusCode, 409); assert.equal(r1.json().error, 'not_enough');
  // 위치 미지정이 없는데 랙에 올리기 → 재고 초과 차단
  const r2 = await post('/api/rack-stock/transfer', { product_id: ID.p1, from: null, to: 'AE5-5', qty: 1 }, 'wh');
  assert.equal(r2.statusCode, 409); assert.equal(r2.json().error, 'over_stock');
  // P3: 위치 미지정 4 → 랙 4 는 가능, 1 더는 불가
  const r3 = await post('/api/rack-stock/transfer', { product_id: ID.p3, from: '', to: 'AE3-2', qty: 4 }, 'wh');
  assert.equal(r3.statusCode, 200, r3.body);
  assert.equal(r3.json().unassigned, 0);
  const r4 = await post('/api/rack-stock/transfer', { product_id: ID.p3, from: '', to: 'AE3-2', qty: 1 }, 'wh');
  assert.equal(r4.json().error, 'over_stock');
  // 랙 → 위치 미지정
  const r5 = await post('/api/rack-stock/transfer', { product_id: ID.p3, from: 'AE3-2', to: '', qty: 1 }, 'wh');
  assert.equal(r5.statusCode, 200, r5.body);
  assert.equal(await racksOf(ID.p3), 'AE3-1=6,AE3-2=3');
  // 여러 건 묶음: 하나라도 틀리면 아무것도 안 바뀐다
  const r6 = await post('/api/rack-stock/transfer', { product_id: ID.p3, moves: [
    { from: 'AE3-1', to: 'AE3-2', qty: 2 }, { from: 'AE3-1', to: 'AE3-3', qty: 9 }] }, 'wh');
  assert.equal(r6.statusCode, 409);
  assert.equal(await racksOf(ID.p3), 'AE3-1=6,AE3-2=3', '묶음 전체 취소');
  // 같은 곳·잘못된 랙 이름
  assert.equal((await post('/api/rack-stock/transfer', { product_id: ID.p3, from: 'AE3-1', to: 'ae3-1', qty: 1 }, 'wh')).json().error, 'same_place');
  assert.equal((await post('/api/rack-stock/transfer', { product_id: ID.p3, from: 'AE3-1', to: 'A E#', qty: 1 }, 'wh')).json().error, 'bad_rack');
  // 열람 권한만 있으면 수정 불가
  assert.equal((await post('/api/rack-stock/transfer', { product_id: ID.p3, from: 'AE3-1', to: 'AE3-2', qty: 1 }, 'ro')).statusCode, 403);
  // 원장
  const mv = (await query(`SELECT reason, note FROM product_rack_moves WHERE product_id=$1 AND reason='transfer' ORDER BY id`, [ID.p1])).rows;
  assert.equal(mv.length, 2);
  assert.ok(mv[0].note.includes('AE1-1 → AE2-2'));
  // 시스템 재고는 그대로
  assert.equal(Number((await query(`SELECT stock_qty FROM products WHERE id=$1`, [ID.p1])).rows[0].stock_qty), 19);
});

async function mkQuote(no, pid, code, qty) {
  const q = Number((await query(
    `INSERT INTO quotes (quote_no, customer_id, status, created_by) VALUES ($1,$2,'confirmed',$3) RETURNING id`,
    [`${TAG}-${no}`, ID.cust, ID.dir])).rows[0].id);
  await query(`INSERT INTO quote_lines (quote_id, line_no, product_id, ctr_code, qty, reserved_qty, list_price, final_price)
               VALUES ($1,1,$2,$3,$4,$4,500,500)`, [q, pid, code, qty]);
  return q;
}

test('④ 지시서가 잡은 수량은 옮길 수 없다 — 견적번호와 옮길 수 있는 수량 안내 · 상세에 held 표시', { skip: SKIP }, async () => {
  ID.q1 = await mkQuote('Q1', ID.p1, `${TAG}-P1`, 5);
  const pr = (await post(`/api/quotes/${ID.q1}/packing-printed`)).json();
  assert.deepEqual(pr.picks[ID.p1].map((p) => [p.rack, p.qty]), [['REFM-01', 5]], 'fast 랙 먼저');
  assert.deepEqual(pr.racks_all[ID.p1].map((r) => r.rack), ['REFM-01', 'AE1-1', 'AE2-2'], '지시서용: SKU 의 모든 랙');
  const r = await post('/api/rack-stock/transfer', { product_id: ID.p1, from: 'REFM-01', to: 'AE1-1', qty: 9 }, 'wh');
  assert.equal(r.statusCode, 409);
  const j = r.json();
  assert.equal(j.error, 'held'); assert.equal(j.movable, 4); assert.deepEqual(j.quotes, [`${TAG}-Q1`]);
  const ok = await post('/api/rack-stock/transfer', { product_id: ID.p1, from: 'REFM-01', to: 'AE1-1', qty: 4 }, 'wh');
  assert.equal(ok.statusCode, 200, ok.body);
  const dt = (await get(`/api/rack-stock/product/${ID.p1}`, 'wh')).json();
  const fm = dt.racks.find((x) => x.rack === 'REFM-01');
  assert.equal(fm.held, 5); assert.equal(fm.movable, 0);
  assert.equal(dt.edit_ready, true);
});

test('⑤ 피킹 기록 — 실제로 집은 랙을 기록하면 매출 전환 때 그 랙에서 차감', { skip: SKIP }, async () => {
  // 현재 P1: AE1-1=10, AE2-2=4, REFM-01=5(Q1 이 5 잡음)
  const pk0 = (await get(`/api/warehouse/packing/${ID.q1}`, 'wh')).json();
  const it0 = pk0.items[0];
  assert.equal(it0.picked, false);
  assert.deepEqual(it0.racks_all.map((r) => `${r.rack}=${r.qty}`), ['REFM-01=5', 'AE1-1=10', 'AE2-2=4'], '포장 화면: 모든 랙 × 수량');
  const op = (await get(`/api/warehouse/packing/${ID.q1}/pick-options?product_id=${ID.p1}`, 'wh')).json();
  assert.equal(op.required, 5);
  assert.equal(op.racks.find((x) => x.rack === 'REFM-01').max, 5, '자기 지시서가 잡은 수량은 집을 수 있다');
  // 합계 불일치
  const bad = await post(`/api/warehouse/packing/${ID.q1}/pick`, { product_id: ID.p1, picks: [{ rack: 'AE2-2', qty: 3 }] }, 'wh');
  assert.equal(bad.json().error, 'qty_mismatch');
  // 랙 수량 초과
  const bad2 = await post(`/api/warehouse/packing/${ID.q1}/pick`, { product_id: ID.p1, picks: [{ rack: 'AE2-2', qty: 5 }] }, 'wh');
  assert.equal(bad2.json().error, 'held');
  // 기록 없는 랙
  const bad3 = await post(`/api/warehouse/packing/${ID.q1}/pick`, { product_id: ID.p1, picks: [{ rack: 'XX1-1', qty: 5 }] }, 'wh');
  assert.equal(bad3.json().error, 'no_rack_stock');
  // 열람 권한 → 403
  assert.equal((await post(`/api/warehouse/packing/${ID.q1}/pick`, { product_id: ID.p1, as_planned: true }, 'ro')).statusCode, 403);
  // 실제 피킹: AE2-2 에서 4, AE1-1 에서 1
  const ok = await post(`/api/warehouse/packing/${ID.q1}/pick`, { product_id: ID.p1, picks: [{ rack: 'ae2-2', qty: 4 }, { rack: 'AE1-1', qty: 1 }] }, 'wh');
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().picks.every((p) => p.picked));
  const pk = (await get(`/api/warehouse/packing/${ID.q1}`, 'wh')).json();
  assert.equal(pk.items[0].picked, true);
  assert.equal(pk.items[0].picked_by_name, `${TAG}retest_wh`);
  assert.equal(pk.items[0].rack_picks, 'AE2-2 ×4 · AE1-1 ×1', '피킹 순서(수량 많은 랙 먼저)');
  // 지시서를 다시 출력해도 기록은 유지
  await post(`/api/quotes/${ID.q1}/packing-printed`);
  const n = (await query(`SELECT COUNT(*)::int n FROM quote_pick_alloc WHERE quote_id=$1 AND picked_at IS NOT NULL`, [ID.q1])).rows[0].n;
  assert.equal(n, 2);
  // 이제 REFM-01 은 홀드가 풀려 옮길 수 있다
  const dt = (await get(`/api/rack-stock/product/${ID.p1}`, 'wh')).json();
  assert.equal(dt.racks.find((x) => x.rack === 'REFM-01').movable, 5);
  // 매출 전환 → 기록한 위치에서 차감
  await query(`INSERT INTO quote_packing_docs (quote_id, file_data, uploaded_at) VALUES ($1,'data:x',now())`, [ID.q1]);
  const cv = await post(`/api/quotes/${ID.q1}/convert`, { seller_id: ID.dir });
  assert.equal(cv.statusCode, 200, cv.body);
  assert.equal(await racksOf(ID.p1), 'AE1-1=9,REFM-01=5', 'AE2-2 4 + AE1-1 1 차감, REFM-01 은 그대로');
  // 전환 후에는 기록 불가
  const late = await post(`/api/warehouse/packing/${ID.q1}/pick`, { product_id: ID.p1, as_planned: true }, 'wh');
  assert.equal(late.json().error, 'already_converted');
});

test('⑥ 지시서대로 기록 · 기록 취소(계획으로 되돌림) · 위치 미지정에서 피킹', { skip: SKIP }, async () => {
  ID.q2 = await mkQuote('Q2', ID.p3, `${TAG}-P3`, 8);
  // P3: AE3-1=6, AE3-2=3, 미지정 1
  await post(`/api/quotes/${ID.q2}/packing-printed`);
  const a = await post(`/api/warehouse/packing/${ID.q2}/pick`, { product_id: ID.p3, as_planned: true }, 'wh');
  assert.equal(a.statusCode, 200, a.body);
  assert.deepEqual(a.json().picks.map((p) => [p.rack, p.qty, !!p.picked]), [['AE3-1', 6, true], ['AE3-2', 2, true]]);
  const r = await post(`/api/warehouse/packing/${ID.q2}/pick`, { product_id: ID.p3, reset: true }, 'wh');
  assert.equal(r.statusCode, 200, r.body);
  const left = (await query(`SELECT COUNT(*)::int n FROM quote_pick_alloc WHERE quote_id=$1 AND picked_at IS NOT NULL`, [ID.q2])).rows[0].n;
  assert.equal(left, 0);
  // 위치 미지정 1 + AE3-2 3 + AE3-1 4
  const u = await post(`/api/warehouse/packing/${ID.q2}/pick`, { product_id: ID.p3, picks: [{ rack: null, qty: 1 }, { rack: 'AE3-2', qty: 3 }, { rack: 'AE3-1', qty: 4 }] }, 'wh');
  assert.equal(u.statusCode, 200, u.body);
  const over = await post(`/api/warehouse/packing/${ID.q2}/pick`, { product_id: ID.p3, picks: [{ rack: null, qty: 2 }, { rack: 'AE3-1', qty: 6 }] }, 'wh');
  assert.equal(over.json().error, 'over_stock');
});

test('⑦ 마이그레이션 전 호환 — 0269 가 없으면 새 기능만 409, 기존 지시서는 그대로', { skip: SKIP }, async () => {
  rs.setRackEditReady(false);
  // probe 를 막기 위해 직후 호출
  const r = await post('/api/rack-stock/transfer', { product_id: ID.p3, from: 'AE3-1', to: 'AE3-2', qty: 1 }, 'wh');
  assert.equal(r.statusCode, 409); assert.equal(r.json().error, 'rack_edit_not_ready');
  const pk = await get(`/api/warehouse/packing/${ID.q2}`, 'wh');
  assert.equal(pk.statusCode, 200);
  rs.setRackEditReady(true);
});

// ---------------- 독립 리뷰 지적 회귀 ----------------
async function mkProd(code, stock, ean) {
  return Number((await query(`INSERT INTO products (code, name, stock_qty, list_price, ean) VALUES ($1,$1,$2,500,$3) RETURNING id`,
    [code, stock, ean || null])).rows[0].id);
}

test('R1 동시 매출 — 매출이 커밋 전이면 위치수정은 기다렸다가 줄어든 재고로 다시 판단(랙 합 > 재고 방지)', { skip: SKIP }, async () => {
  const { pool } = await import('../src/db.js');
  const pid = await mkProd(`${TAG}-R1`, 10);
  await post('/api/rack-stock/set', { product_id: pid, rack: 'R1-1', qty: 5 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE products SET stock_qty = stock_qty - 5 WHERE id=$1`, [pid]);          // 매출 등록 순서 그대로
    await rs.takeFromRack(c, pid, 'R1-1', 5, { reason: 'sale', ref: 'test' });
    const tr = post('/api/rack-stock/transfer', { product_id: pid, from: null, to: 'R1-2', qty: 10 }, 'wh');
    await new Promise((r) => setTimeout(r, 300));
    await c.query('COMMIT');
    const r = await tr;
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'over_stock', '커밋된 재고 5 기준 → 위치 미지정 5 뿐');
  } finally { c.release(); }
  const tot = Number((await query(`SELECT COALESCE(SUM(qty),0) s FROM product_rack_stock WHERE product_id=$1`, [pid])).rows[0].s);
  assert.ok(tot <= 5);
});

test('R2 위치 미지정 이중 약속 방지 — 지시서가 위치 미지정으로 잡은 분량은 랙에 올리거나 다른 오더가 기록할 수 없다', { skip: SKIP }, async () => {
  const pid = await mkProd(`${TAG}-R2`, 10);
  await post('/api/rack-stock/set', { product_id: pid, rack: 'R2-1', qty: 5 });
  const qa = await mkQuote('R2A', pid, `${TAG}-R2`, 10);
  const pr = (await post(`/api/quotes/${qa}/packing-printed`)).json();
  assert.deepEqual(pr.picks[pid].map((p) => [p.rack, p.qty]), [['R2-1', 5], [null, 5]]);
  const t = await post('/api/rack-stock/transfer', { product_id: pid, from: null, to: 'R2-2', qty: 5 }, 'wh');
  assert.equal(t.json().error, 'over_stock', 'QA 가 위치 미지정 5 를 잡고 있음');
  // 피킹 기록: QB 가 위치 미지정 5 를 먼저 기록하면 QA 는 위치 미지정에서 기록할 수 없다
  await query(`UPDATE quotes SET status='cancelled' WHERE id=$1`, [qa]);
  const qb = await mkQuote('R2B', pid, `${TAG}-R2`, 5);
  const qc = await mkQuote('R2C', pid, `${TAG}-R2`, 5);
  await post(`/api/quotes/${qb}/packing-printed`); await post(`/api/quotes/${qc}/packing-printed`);
  const b = await post(`/api/warehouse/packing/${qb}/pick`, { product_id: pid, picks: [{ rack: null, qty: 5 }] }, 'wh');
  assert.equal(b.statusCode, 200, b.body);
  const c = await post(`/api/warehouse/packing/${qc}/pick`, { product_id: pid, picks: [{ rack: null, qty: 5 }] }, 'wh');
  assert.equal(c.json().error, 'over_stock');
  const c2 = await post(`/api/warehouse/packing/${qc}/pick`, { product_id: pid, picks: [{ rack: 'R2-1', qty: 5 }] }, 'wh');
  assert.equal(c2.statusCode, 200, c2.body);
});

test('R3 같은 랙을 두 지시서가 계획 — 먼저 피킹 기록한 쪽이 가져가고, 나중 쪽은 막힌다', { skip: SKIP }, async () => {
  const pid = await mkProd(`${TAG}-R3`, 5);
  await post('/api/rack-stock/set', { product_id: pid, rack: 'R3-1', qty: 5 });
  const qa = await mkQuote('R3A', pid, `${TAG}-R3`, 5);
  const qb = await mkQuote('R3B', pid, `${TAG}-R3`, 5);
  await post(`/api/quotes/${qa}/packing-printed`); await post(`/api/quotes/${qb}/packing-printed`);
  const b = await post(`/api/warehouse/packing/${qb}/pick`, { product_id: pid, as_planned: true }, 'wh');
  assert.equal(b.statusCode, 200, b.body);
  const a = await post(`/api/warehouse/packing/${qa}/pick`, { product_id: pid, as_planned: true }, 'wh');
  assert.equal(a.statusCode, 409); assert.equal(a.json().error, 'held');
  assert.match(a.json().note, /이미 피킹/);
});

test('R4 업로드 — 오류 줄이 있는 SKU 는 통째로 보류(빠진 랙을 지우지 않음) · 2만 줄 초과 거부 · 겹치는 EAN 은 쓰지 않음', { skip: SKIP }, async () => {
  const pid = await mkProd(`${TAG}-R4`, 20);
  await post('/api/rack-stock/set', { product_id: pid, rack: 'D1-1', qty: 8 });
  await post('/api/rack-stock/set', { product_id: pid, rack: 'D1-2', qty: 12 });
  const rows = [{ line: 2, code: `${TAG}-R4`, rack: 'D1-1', qty: 8, sig: 'x1' }, { line: 2, code: `${TAG}-R4`, rack: 'D1-2', qty: '', sig: 'x2' }];
  const pv = (await post('/api/rack-stock/import/preview', { rows })).json();
  assert.equal(pv.skus[0].status, 'error');
  const ap = (await post('/api/rack-stock/import', { rows })).json();
  assert.equal(ap.skus, 0);
  assert.deepEqual(ap.blocked.map((b) => [b.code, b.reason]), [[`${TAG}-R4`, 'error']]);
  assert.equal(await racksOf(pid), 'D1-1=8,D1-2=12', 'D1-2 가 지워지지 않는다');
  const big = Array.from({ length: 20001 }, (_, i) => ({ line: i, code: 'X', rack: 'A1-1', qty: 1 }));
  assert.equal((await post('/api/rack-stock/import', { rows: big })).statusCode, 413);
  await mkProd(`${TAG}-E1`, 1, '7500000000999'); await mkProd(`${TAG}-E2`, 1, '7500000000999');
  const amb = (await post('/api/rack-stock/import/preview', { rows: [{ line: 1, code: '7500000000999', rack: 'A1-1', qty: 1 }] })).json();
  assert.equal(amb.unknown.length, 1, '같은 EAN 이 두 제품 → 매칭하지 않는다');
});

test('R5 옛 규칙으로 만들어진 랙 이름(공백 등)도 출발 랙·피킹 랙으로 쓸 수 있다', { skip: SKIP }, async () => {
  const pid = await mkProd(`${TAG}-R5`, 6);
  await query(`INSERT INTO product_rack_stock (product_id, rack, qty) VALUES ($1,'OLD RACK 1',6)`, [pid]);
  const t = await post('/api/rack-stock/transfer', { product_id: pid, from: 'old rack 1', to: 'N1-1', qty: 2 }, 'wh');
  assert.equal(t.statusCode, 200, t.body);
  const q = await mkQuote('R5A', pid, `${TAG}-R5`, 4);
  await post(`/api/quotes/${q}/packing-printed`);
  const p = await post(`/api/warehouse/packing/${q}/pick`, { product_id: pid, picks: [{ rack: 'OLD RACK 1', qty: 4 }] }, 'wh');
  assert.equal(p.statusCode, 200, p.body);
});

after(async () => {
  if (SKIP) return;
  try { await cleanup(); } catch (e) { console.error('cleanup', e.message); }
  try { await app.close(); } catch (_) {}
  const { pool } = await import('../src/db.js');
  await pool.end();
});
