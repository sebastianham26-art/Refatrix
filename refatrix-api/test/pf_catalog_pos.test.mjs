// =====================================================================
// pf_catalog_pos.test.mjs — 1108 · 플랫폼 카탈로그 점검 「장착 위치(pos)」 칸
//   A. 순수 — 표기 정규화 · 잘못된 표기 거절 · 업로드 있는 품목 비우기 거절
//   B. 실제 서버 + PostgreSQL(TEST_PG_URL):
//      목록·단건 pos(업로드 요약 → 마스터 확인값 우선) · pos 없이 부르는 옛 화면 · confirm 으로 저장(이력 · 확인 기록) ·
//      bad_pos 400 · 현장 수정 겹침 409 → mine · 열 때 본 값(stale) 409 · 업로드 다시 해도 확인완료 유지 ·
//      기존 확인 지문(0323 이전 공식)과 같음 · 엑셀 export 에 pos · 가격·재고 그대로
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/pf_catalog_pos.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pf-catalog';
process.env.PRODUCT_PUSH_DEBOUNCE_MS = '20';
const C = await import('../src/pfCatalog.js');
const P = await import('../src/productPositions.js');

test('A1. 표기 정규화 — 영어 · 스페인어 · 한글 · 줄임 · 양쪽', () => {
  const eq = (a, b) => assert.equal(P.canonPos(a), b, String(a));
  eq('Front Lower LH', 'Delantera Inferior Izquierda');
  eq('DELANTERO INF IZQ', 'Delantera Inferior Izquierda');
  eq('Del. Inf. Izq./Der.', 'Delantera Inferior Izquierda/Derecha');
  eq('앞·하·좌', 'Delantera Inferior Izquierda');
  eq('앞하좌', 'Delantera Inferior Izquierda');
  eq('Trasera', 'Trasera');
  eq('L/R', 'Izquierda/Derecha');
  eq('AMBOS', 'Izquierda/Derecha');
  eq('  ', null); eq(null, null);
  eq('foo', undefined); eq('Delantera foo', undefined);
  assert.equal(C.normValue('pos', 'front lower lh'), 'Delantera Inferior Izquierda');
  assert.ok(C.eqF('pos', 'Front Lower LH', '앞·하·좌'), '표기가 달라도 같은 위치면 같다');
  assert.equal(P.posText(P.summarize([{ block: 'front', level: 'lower', side: 'rh' }, { block: 'front', level: 'lower', side: 'lh' }])),
    'Delantera Inferior Izquierda/Derecha', '업로드 요약도 같은 표기');
});

test('A2. 수정안 — 잘못된 표기 거절 · 업로드 있는 품목은 비울 수 없음 · 같은 위치면 빠짐', () => {
  const cur = { name: 'X', scode: null, app: null, oe: null, material: null, pos: 'Delantera Inferior Izquierda', pos_upload: 'Delantera Inferior Izquierda' };
  assert.equal(C.mergeDraft(cur, {}, { pos: 'arriba' }).errors[0].error, 'bad_pos');
  assert.equal(C.mergeDraft(cur, {}, { pos: '' }).errors[0].error, 'pos_upload_exists');
  assert.deepEqual(Object.keys(C.mergeDraft(cur, {}, { pos: 'FRONT LOWER LH' }).draft), [], '같은 위치 → 수정안 없음');
  const m = C.mergeDraft(cur, {}, { pos: 'DEL INF DER' });
  assert.deepEqual(m.draft.pos, { base: 'Delantera Inferior Izquierda', value: 'Delantera Inferior Derecha' });
  const cur2 = { ...cur, pos: 'Trasera', pos_upload: null };
  assert.equal(C.mergeDraft(cur2, {}, { pos: '' }).draft.pos.value, null, '업로드가 없으면 비울 수 있다');
});

test('B. 실제 서버 + PostgreSQL — pos', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  const MINE = `SELECT id FROM products WHERE code LIKE 'PFP%'`;
  async function cleanup() {
    for (const tb of ['pf_catalog_confirms', 'pf_catalog_review', 'pf_catalog_rounds']) await query(`DELETE FROM ${tb} WHERE product_id IN (${MINE})`).catch(() => {});
    for (const tb of ['product_change_log', 'product_syd_codes', 'product_applications', 'product_oe_codes']) await query(`DELETE FROM ${tb} WHERE product_id IN (${MINE})`).catch(() => {});
    await query(`DELETE FROM crm_customer_outbox WHERE entity='product'`).catch(() => {});
    await query(`DELETE FROM product_positions WHERE ctr_code LIKE 'PFP%'`);
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
  const call = (h, method, url, payload) => app.inject({ method, url, payload, headers: h });
  const one = async (sql, a) => (await query(sql, a)).rows[0];

  await cleanup();
  const mk = (code, name) => one(`INSERT INTO products (code, name, app, list_price, stock_qty, is_active) VALUES ($1,$2,'NISSAN Versa 2012-2019',245.5,17,true) RETURNING id`, [code, name]);
  const p1 = await mk('PFP001', 'HORQUILLA');   // 업로드 위치 있음
  const p2 = await mk('PFP002', 'ROTULA');      // 위치 없음
  const p3 = await mk('PFP003', 'TERMINAL');    // 업로드 위치 있음(양쪽)
  const pos = (code, block, level, side, model) => query(
    `INSERT INTO product_positions (ctr_code, block, level, side, brand, model) VALUES ($1,$2,$3,$4,'NISSAN',$5)`, [code, block, level, side, model]);
  await pos('PFP001', 'front', 'lower', 'lh', 'Versa'); await pos('PFP001', 'front', 'lower', 'lh', 'March');
  await pos('PFP003', 'front', null, 'lh', 'Versa'); await pos('PFP003', 'front', null, 'rh', 'Versa');

  const lg = await call({}, 'POST', '/api/pf-catalog/login', { token: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Park CTR', user_key: '12' });
  assert.equal(lg.statusCode, 200, lg.body);
  const H = { authorization: 'Bearer ' + lg.json().token };

  // ── A. 목록 · 단건에 pos ─────────────────────────────────
  let L = (await call(H, 'GET', '/api/pf-catalog/items?q=PFP&limit=50')).json();
  const by = Object.fromEntries(L.items.map((x) => [x.code, x]));
  assert.equal(by.PFP001.pos, 'Delantera Inferior Izquierda'); assert.equal(by.PFP001.pos_src, 'upload');
  assert.equal(by.PFP002.pos, '', '없으면 빈 문자열'); assert.equal(by.PFP002.pos_src, null);
  assert.equal(by.PFP003.pos, 'Delantera Izquierda/Derecha');
  assert.equal((await call(H, 'GET', `/api/pf-catalog/items/${p1.id}`)).json().pos, 'Delantera Inferior Izquierda');

  // ── 옛 화면(pos 없이) 확인완료 → 그대로 동작 · 지문은 0323 이전 공식과 같다 ─────
  let r = await call(H, 'POST', `/api/pf-catalog/items/${p2.id}/confirm`, { loaded: { name: 'ROTULA' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().applied, {});
  const oldFp = (await one(`SELECT md5(concat_ws(chr(31), COALESCE(btrim(name),''), COALESCE(btrim(scode),''), COALESCE(btrim(app),''),
                                   COALESCE(btrim(oe),''), COALESCE(btrim(material),''))) AS h FROM products WHERE id=$1`, [p2.id])).h;
  assert.equal((await one(`SELECT confirmed_hash FROM pf_catalog_review WHERE product_id=$1`, [p2.id])).confirmed_hash, oldFp,
    'mount_pos 가 비면 지문이 예전과 같다 → 기존 확인완료가 재확인으로 뒤집히지 않는다');

  // ── B. confirm 으로 pos 저장 ──────────────────────────────
  // 확인완료 품목은 그대로 맞음 상태 — 다시 확인하면서 위치를 넣는다
  r = await call(H, 'POST', `/api/pf-catalog/items/${p2.id}/confirm`, { fields: { pos: 'delantero inf der' }, loaded: { pos: '' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().applied.pos, { from: null, to: 'Delantera Inferior Derecha' });
  let row = await one(`SELECT mount_pos, list_price, stock_qty FROM products WHERE id=$1`, [p2.id]);
  assert.equal(row.mount_pos, 'Delantera Inferior Derecha');
  assert.equal(row.list_price, '245.50'); assert.equal(Number(row.stock_qty), 17, '가격 · 재고 그대로');
  assert.equal(r.json().item.pos, 'Delantera Inferior Derecha'); assert.equal(r.json().item.pos_src, 'erp');
  assert.equal(r.json().item.status, 'ok'); assert.equal(r.json().item.confirm_count, 2);
  const lg2 = await one(`SELECT source, changes FROM product_change_log WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [p2.id]);
  assert.equal(lg2.source, 'platform'); assert.equal(lg2.changes.pos.to, 'Delantera Inferior Derecha'); assert.equal(lg2.changes._pf.to, 'Park CTR');
  assert.ok(r.json().item.history.some((h) => h.parts.some((p) => p.field === 'pos')), '플랫폼 이력에 pos');
  assert.equal((await one(`SELECT applied FROM pf_catalog_confirms WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [p2.id])).applied.pos.to, 'Delantera Inferior Derecha');

  // 잘못된 표기 → 400 · 아무것도 안 바뀜
  r = await call(H, 'POST', `/api/pf-catalog/items/${p1.id}/confirm`, { fields: { pos: 'arriba izquierda' } });
  assert.equal(r.statusCode, 400, r.body); assert.equal(r.json().error, 'bad_pos'); assert.equal(r.json().field, 'pos');
  assert.equal((await one(`SELECT mount_pos FROM products WHERE id=$1`, [p1.id])).mount_pos, null);
  // 업로드 있는 품목 비우기 → 400
  r = await call(H, 'POST', `/api/pf-catalog/items/${p1.id}/confirm`, { fields: { pos: '' } });
  assert.equal(r.statusCode, 400, r.body); assert.equal(r.json().error, 'pos_upload_exists');
  // 업로드 값과 같은 위치(표기만 다름) → 바뀐 것 없음
  r = await call(H, 'POST', `/api/pf-catalog/items/${p1.id}/confirm`, { fields: { pos: 'Front Lower LH' } });
  assert.equal(r.statusCode, 200, r.body); assert.deepEqual(r.json().applied, {});
  assert.equal((await one(`SELECT mount_pos FROM products WHERE id=$1`, [p1.id])).mount_pos, null);
  // 업로드 다시(전체 교체) → 확인완료는 그대로(업로드는 지문 밖) · 보이는 값은 새 업로드
  await query(`DELETE FROM product_positions WHERE ctr_code='PFP001'`); await pos('PFP001', 'front', 'lower', null, 'Versa');
  let it = (await call(H, 'GET', `/api/pf-catalog/items/${p1.id}`)).json();
  assert.equal(it.status, 'ok'); assert.equal(it.pos, 'Delantera Inferior');

  // ── 업로드와 다른 값 → 마스터 확인값이 우선 ─────────────────
  // 확인완료 품목도 확인 요청에 칸을 실어 바로 고칠 수 있다(기존 칸과 같은 규칙)
  r = await call(H, 'POST', `/api/pf-catalog/items/${p3.id}/confirm`, { fields: { pos: 'Delantera Inferior Izquierda/Derecha' } });
  assert.equal(r.statusCode, 200, r.body);
  it = r.json().item;
  assert.equal(it.pos, 'Delantera Inferior Izquierda/Derecha'); assert.equal(it.pos_upload, 'Delantera Izquierda/Derecha'); assert.equal(it.pos_src, 'erp');

  // ── 수정안 중 ERP 에서 pos 가 바뀜 → 409 conflict → mine ─────
  r = await call(H, 'PUT', `/api/pf-catalog/items/${p3.id}/draft`, { fields: { pos: 'Trasera' } });
  assert.equal(r.statusCode, 200, r.body); assert.deepEqual(r.json().fields, ['pos']);
  await query(`UPDATE products SET mount_pos='Delantera Superior' WHERE id=$1`, [p3.id]);   // 그사이 현장 수정
  r = await call(H, 'POST', `/api/pf-catalog/items/${p3.id}/confirm`, {});
  assert.equal(r.statusCode, 409, r.body);
  assert.deepEqual(r.json().conflicts.map((x) => x.field), ['pos']);
  assert.equal(r.json().conflicts[0].erp, 'Delantera Superior'); assert.equal(r.json().conflicts[0].mine, 'Trasera');
  assert.equal((await one(`SELECT mount_pos FROM products WHERE id=$1`, [p3.id])).mount_pos, 'Delantera Superior', '겹치면 안 바뀜');
  r = await call(H, 'POST', `/api/pf-catalog/items/${p3.id}/confirm`, { resolve: { pos: 'mine' } });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().chosen.pos.chose, 'mine');
  assert.equal((await one(`SELECT mount_pos FROM products WHERE id=$1`, [p3.id])).mount_pos, 'Trasera');

  // ── 열 때 본 값(loaded.pos)과 지금 값이 다름 → 409 stale ─────
  r = await call(H, 'POST', `/api/pf-catalog/items/${p3.id}/confirm`, { loaded: { pos: 'Delantera' } });
  assert.equal(r.statusCode, 409, r.body); assert.equal(r.json().error, 'stale'); assert.deepEqual(r.json().fields, ['pos']);

  // ── ERP 현장 수정(mount_pos) → 재확인 ─────────────────────
  await query(`UPDATE products SET mount_pos='Delantera' WHERE id=$1`, [p2.id]);
  assert.equal((await call(H, 'GET', `/api/pf-catalog/items/${p2.id}`)).json().status, 'changed');

  // ── C. 엑셀 export 에 pos ─────────────────────────────────
  r = await call(H, 'POST', '/api/pf-catalog/export', { filters: { q: 'PFP' }, gps_status: 'unavailable' });
  assert.equal(r.statusCode, 200, r.body);
  const ex = Object.fromEntries(r.json().items.map((x) => [x.code, x]));
  assert.equal(ex.PFP001.pos, 'Delantera Inferior'); assert.equal(ex.PFP002.pos, 'Delantera'); assert.equal(ex.PFP003.pos, 'Trasera');
  for (const k of ['list_price', 'stock_qty']) assert.ok(!(k in ex.PFP001), `${k} 없음`);
  await query(`DELETE FROM pf_catalog_exports WHERE row_count = 3`).catch(() => {});
});
