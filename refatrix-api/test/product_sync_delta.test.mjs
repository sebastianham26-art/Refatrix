// =====================================================================
// 2026-09-29 · 0236 제품 카탈로그 「바뀐 것만」 자동 전송 + 전체 주 1회
// 실행: DATABASE_URL=postgres://.../빈DB node --test --experimental-test-module-mocks test/product_sync_delta.test.mjs
//   (DB 가 없으면 순수 함수 테스트만 돈다)
// =====================================================================
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONN = process.env.DATABASE_URL || '';
const skip = !CONN;

// 연동 설정·전송 엔진은 흉내 — 적재(아웃박스·기준)까지만 본다.
const EP = { key: 'product', enabled: true, url_test: 'http://crm.test/p', env: 'test', img_base_url: '',
  body_shape: 'lote', batch_size: 500, field_map: {}, user_field: 'login_id', send_hour_mx: 6,
  auto_send: false, full_weekday: 0, delta_auto: true, delta_every_min: 5 };
mock.module(resolve(HERE, '../src/integrations.js'), { namedExports: {
  getEndpoint: async () => EP, activeUrl: (e) => e.url_test, publicEndpoint: (e) => ({ key: e.key }) } });
mock.module(resolve(HERE, '../src/crmSync.js'), { namedExports: {
  scheduleDrain: () => {}, signalProductCancel: () => 0, pumpState: () => ({}), gapMs: () => 50 } });
mock.module(resolve(HERE, '../src/middleware/authGuard.js'), { namedExports: {
  authGuard: async (req) => { req.ctx = { perm: { role: 'director', userId: 1 }, deviceId: null }; },
  requireDirector: (r, p, d) => d() } });
mock.module(resolve(HERE, '../src/audit.js'), { namedExports: { logEvent: () => {}, logPageView: async () => {} } });
mock.module(resolve(HERE, '../src/oeCodes.js'), { namedExports: { oeReady: async () => false } });

const ps = await import('../src/productSync.js');

// ── 순수 ─────────────────────────────────────────────────────────────
test('pickChanged — 새 제품·값 변경·실패만, 대기/완료/건너뜀은 값이 같으면 보내지 않음', () => {
  const a = ps.buildProduct({ code: 'A', name: 'X', list_price: 10, stock_qty: 1, is_active: true }, '');
  const b = ps.buildProduct({ code: 'B', name: 'X', list_price: 10, stock_qty: 1, is_active: true }, '');
  const c = ps.buildProduct({ code: 'C', name: 'X', list_price: 10, stock_qty: 1, is_active: true }, '');
  const d = ps.buildProduct({ code: 'D', name: 'X', list_price: 10, stock_qty: 1, is_active: true }, '');
  const e = ps.buildProduct({ code: 'E', name: 'X', list_price: 10, stock_qty: 1, is_active: true }, '');
  const st = new Map([
    ['B', { hash: 'old', status: 'sent' }],
    ['C', { hash: ps.productHash(c), status: 'failed' }],
    ['D', { hash: ps.productHash(d), status: 'skipped' }],
    ['E', { hash: ps.productHash(e), status: 'pending' }],
  ]);
  const r = ps.pickChanged([a, b, c, d, e], st);
  assert.deepEqual(r.items.map((x) => x.p.codigo), ['A', 'B', 'C']);
  assert.deepEqual(r.counts, { nuevo: 1, cambiado: 1, reintento: 1 });
});

test('지문 — 작업자 이름은 무시, 재고 구간·정가·OE 는 반영', () => {
  const p = ps.buildProduct({ code: 'A', name: 'X', list_price: 10, stock_qty: 1, is_active: true }, '');
  assert.equal(ps.productHash({ ...p, transactionUser: 'otro' }), ps.productHash(p));
  assert.notEqual(ps.productHash({ ...p, precioLista: 11 }), ps.productHash(p));
  // 2026-10-06 · existencia 가 수량(숫자)이 되어 재고가 1개만 바뀌어도 변경분으로 나간다
  assert.notEqual(ps.productHash(ps.buildProduct({ code: 'A', name: 'X', list_price: 10, stock_qty: 2, is_active: true }, '')),
    ps.productHash(p), '재고 수량이 바뀌면 변경');
  assert.notEqual(ps.productHash({ ...p, referenciaOE: 'X1' }), ps.productHash(p));
});

test('변경분 묶음은 마감 신호를 보내지 않는다', () => {
  const p = ps.buildProduct({ code: 'A', name: 'X', list_price: 1, stock_qty: 1, is_active: true }, '');
  const meta = { envioId: 'DLT-1', fechaCorte: '2026-09-29', lote: 1, totalLotes: 1, totalProductos: 1, transactionUser: 'x' };
  assert.equal(ps.buildLote({ ...meta, mode: 'delta' }, [p], { shape: 'lote' }).esUltimoLote, false);
  assert.equal(ps.buildLote({ ...meta, mode: 'full' }, [p], { shape: 'lote' }).esUltimoLote, true);
});

test('일정 — 전체는 설정 요일·시각, 변경분은 주기·기준·진행 중 전송 확인', () => {
  const cfg = { autoSend: true, weekday: 0, sendHour: 6 };
  assert.equal(ps.fullDue(cfg, { wd: 0, hour: 7, ranToday: false }), true);
  assert.equal(ps.fullDue(cfg, { wd: 1, hour: 7, ranToday: false }), false, '일요일이 아니면 안 돎');
  assert.equal(ps.fullDue(cfg, { wd: 0, hour: 5, ranToday: false }), false);
  assert.equal(ps.fullDue(cfg, { wd: 0, hour: 7, ranToday: true }), false);
  assert.equal(ps.fullDue({ ...cfg, weekday: null }, { wd: 3, hour: 7, ranToday: false }), true, 'NULL = 매일(예전 동작)');
  assert.equal(ps.fullDue({ ...cfg, autoSend: false }, { wd: 0, hour: 7, ranToday: false }), false);
  const now = Date.parse('2026-09-29T12:00:00Z');
  const dc = { deltaAuto: true, everyMin: 5 };
  assert.equal(ps.deltaDue(dc, { lastAt: now - 6 * 60000, now, pending: 0, baseline: 10 }), true);
  assert.equal(ps.deltaDue(dc, { lastAt: now - 2 * 60000, now, pending: 0, baseline: 10 }), false);
  assert.equal(ps.deltaDue(dc, { lastAt: null, now, pending: 3, baseline: 10 }), false, '전체 전송 중이면 겹치지 않음');
  assert.equal(ps.deltaDue(dc, { lastAt: null, now, pending: 0, baseline: 0 }), false, '기준 없으면 안 돎');
  assert.equal(ps.deltaDue({ deltaAuto: false, everyMin: 5 }, { lastAt: null, now, pending: 0, baseline: 10 }), false);
  assert.equal(ps.mxWeekday(Date.parse('2026-09-27T12:00:00Z')), 0, '2026-09-27 은 일요일');
});

// ── 실 DB ────────────────────────────────────────────────────────────
const STUB = `
DROP TABLE IF EXISTS product_sync_state, product_sync_runs, crm_customer_outbox, products, users, integration_endpoints CASCADE;
CREATE TABLE users (id BIGSERIAL PRIMARY KEY, login_id TEXT, name TEXT, role TEXT);
CREATE TABLE integration_endpoints (key TEXT PRIMARY KEY);
INSERT INTO integration_endpoints (key) VALUES ('product'), ('customer_commercial');
CREATE TABLE products (id BIGSERIAL PRIMARY KEY, code TEXT, name TEXT, app TEXT, scode TEXT, list_price NUMERIC,
  stock_qty INT, is_active BOOLEAN DEFAULT true, sat_code TEXT, origin TEXT, iva_rate NUMERIC, ean TEXT, location TEXT,
  list_price_syd NUMERIC, price_customer_ctr NUMERIC, deleted_at TIMESTAMPTZ);
CREATE TABLE crm_customer_outbox (id BIGSERIAL PRIMARY KEY, customer_id BIGINT, entity TEXT, entity_id BIGINT,
  entity_label TEXT, endpoint_key TEXT, op TEXT, origin TEXT, rfc TEXT, payload JSONB, status TEXT, acted_by BIGINT,
  attempts INT DEFAULT 0, last_error TEXT, sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE product_sync_runs (
  id BIGSERIAL PRIMARY KEY, envio_id TEXT NOT NULL, fecha_corte DATE NOT NULL,
  mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full','test')), origin TEXT NOT NULL DEFAULT 'manual',
  total_productos INT NOT NULL DEFAULT 0, total_lotes INT NOT NULL DEFAULT 0, batch_size INT NOT NULL DEFAULT 500,
  env TEXT, note TEXT, created_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX uq_psr_auto_day ON product_sync_runs (fecha_corte) WHERE origin = 'auto' AND mode = 'full';
INSERT INTO products (code, name, list_price, stock_qty) VALUES ('CE0001','TERMINAL',100,5),('CE0002','RÓTULA',200,5),
  ('CE0003','BUJE',300,5),('PRO001','GORRA',0,5);
`;
let pool = null;
async function db() {
  if (pool) return pool;
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: CONN });
  await pool.query(STUB);
  const mig = readFileSync(resolve(HERE, '../migrations/0236_product_sync_delta.sql'), 'utf8');
  await pool.query(mig);
  await pool.query(mig);                                   // 멱등
  return pool;
}
const outbox = async () => (await pool.query(`SELECT * FROM crm_customer_outbox ORDER BY id`)).rows;

test('DB ① 0236 — 멱등 · mode 에 delta · 제품 창구 전체 요일 = 일요일', { skip }, async () => {
  const p = await db();
  const ep = (await p.query(`SELECT * FROM integration_endpoints WHERE key='product'`)).rows[0];
  assert.equal(ep.delta_auto, true); assert.equal(ep.delta_every_min, 5); assert.equal(ep.full_weekday, 0);
  const other = (await p.query(`SELECT full_weekday FROM integration_endpoints WHERE key='customer_commercial'`)).rows[0];
  assert.equal(other.full_weekday, null);
  await p.query(`INSERT INTO product_sync_runs (envio_id, fecha_corte, mode) VALUES ('x', '2026-09-29', 'delta')`);
  await assert.rejects(p.query(`INSERT INTO product_sync_runs (envio_id, fecha_corte, mode) VALUES ('x', '2026-09-29', 'raro')`));
  await p.query(`DELETE FROM product_sync_runs`);
});

test('DB ② 기준 없으면 변경분 거절 → 기준만 저장(보내지 않음) → 바뀐 것 없음', { skip }, async () => {
  await db();
  assert.equal((await ps.runCatalogSync({ mode: 'delta' })).error, 'no_baseline');
  const b = await ps.runCatalogSync({ mode: 'baseline', actorUserId: null });
  assert.equal(b.ok, true); assert.equal(b.total_productos, 3, 'PRO 제외');
  assert.equal((await outbox()).length, 0, '아무것도 보내지 않음');
  assert.equal(await ps.baselineCount(), 3);
  const d = await ps.runCatalogSync({ mode: 'delta' });
  assert.equal(d.nothing, true);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM product_sync_runs WHERE mode='delta'`)).rows[0].n, 0, '빈 회차를 만들지 않음');
});

test('DB ③ 값이 바뀐 1개만 · 마감 신호 없음 · 실패하면 다음 변경분에 다시', { skip }, async () => {
  await db();
  await pool.query(`UPDATE products SET list_price=111 WHERE code='CE0001'`);
  const pv = await ps.computeDelta('');
  assert.equal(pv.items.length, 1); assert.equal(pv.counts.cambiado, 1);
  const d = await ps.runCatalogSync({ mode: 'delta', origin: 'auto' });
  assert.equal(d.ok, true); assert.equal(d.total_productos, 1); assert.match(d.envio_id, /^DLT-/);
  let ob = await outbox();
  assert.equal(ob.length, 1); assert.equal(ob[0].origin, 'auto_delta');
  assert.equal(ob[0].payload.esUltimoLote, false);
  assert.deepEqual(ob[0].payload.productos.map((x) => x.codigo), ['CE0001']);
  assert.equal(ob[0].payload.productos[0].precioLista, 111);
  // 대기 중 → 다시 안 실음
  assert.equal((await ps.runCatalogSync({ mode: 'delta' })).nothing, true);
  // 실패 → 다시 실음(재전송)
  await pool.query(`UPDATE crm_customer_outbox SET status='failed' WHERE id=$1`, [ob[0].id]);
  const r = await ps.runCatalogSync({ mode: 'delta' });
  assert.equal(r.total_productos, 1); assert.equal(r.counts.reintento, 1);
  await pool.query(`UPDATE crm_customer_outbox SET status='sent'`);
  assert.equal((await ps.runCatalogSync({ mode: 'delta' })).nothing, true);
});

test('DB ④ 새 제품 · 지워진 제품은 비활성으로 한 번만', { skip }, async () => {
  await db();
  await pool.query(`INSERT INTO products (code, name, list_price, stock_qty) VALUES ('CE0004','NUEVO',50,1)`);
  await pool.query(`UPDATE products SET deleted_at=now() WHERE code='CE0002'`);
  const d = await ps.runCatalogSync({ mode: 'delta' });
  assert.equal(d.counts.nuevo, 1); assert.equal(d.counts.baja, 1);
  const last = (await outbox()).at(-1).payload.productos;
  const gone = last.find((x) => x.codigo === 'CE0002');
  assert.equal(gone.activo, false); assert.equal(gone.statusCode, 'inactive');
  await pool.query(`UPDATE crm_customer_outbox SET status='sent'`);
  assert.equal((await ps.runCatalogSync({ mode: 'delta' })).nothing, true, '비활성 알림은 한 번만');
});

test('DB ⑤ 전체 전송은 기준을 새로 잡는다 · 틱: 전체 전송 중엔 변경분이 기다린다', { skip }, async () => {
  await db();
  await pool.query(`UPDATE products SET list_price=999 WHERE code='CE0003'`);
  const f = await ps.runCatalogSync({ mode: 'full' });
  assert.equal(f.total_productos, 3);
  const lastFull = (await outbox()).at(-1);
  assert.equal(lastFull.payload.esUltimoLote, true);
  const st = (await pool.query(`SELECT outbox_id FROM product_sync_state WHERE code='CE0003'`)).rows[0];
  assert.equal(Number(st.outbox_id), Number(lastFull.id));
  // 전체가 아직 대기 중 → 틱은 변경분을 돌리지 않는다
  await pool.query(`UPDATE products SET list_price=1000 WHERE code='CE0003'`);
  // 지금보다 1시간 뒤(마지막 변경분 회차보다 늦게) — 전체 요일이 아니도록 요일을 확인
  let now = Date.now() + 3600000; while (ps.mxWeekday(now) === 0 || ps.mxWeekday(now + 11 * 60000) === 0) now += 86400000;
  assert.equal((await ps.productSyncTick({ now })).skipped, 'delta_not_due');
  await pool.query(`UPDATE crm_customer_outbox SET status='sent'`);
  const t = await ps.productSyncTick({ now: now + 10 * 60000 });
  assert.equal(t.ran, 'delta'); assert.equal(t.result.total_productos, 1);
  assert.equal((await ps.productSyncTick({ now: now + 11 * 60000 })).skipped, 'delta_not_due', '5분 주기');
});

test('DB ⑥ 틱: 일요일 06시 이후 전체 자동(auto_send 켬) · 같은 날 두 번 안 돎', { skip }, async () => {
  await db();
  await pool.query(`UPDATE crm_customer_outbox SET status='sent'`);
  EP.auto_send = true;
  const sun = Date.parse('2026-10-04T13:00:00Z');   // 멕시코 일 07:00
  const t = await ps.productSyncTick({ now: sun });
  assert.equal(t.ran, 'full'); assert.equal(t.result.mode, 'full');
  EP.auto_send = false;
});

test('고른 제품 — 코드 정리(중복·대소문자·구분자)', () => {
  assert.deepEqual(ps.parseCodes(' ce0001, CE0001\nCB0011;gv1187  '), ['ce0001', 'CB0011', 'gv1187']);
  assert.deepEqual(ps.parseCodes(['A', 'a', '', null, 'B']), ['A', 'B']);
});

test('DB ⑦ 고른 제품만 보내기 — 없는·PRO 코드는 제외 · 마감 신호 없음 · 기준 갱신 · 변경분 주기에 안 섞임', { skip }, async () => {
  await db();
  await pool.query(`UPDATE crm_customer_outbox SET status='sent'`);
  const before = (await pool.query(`SELECT max(created_at) AS at FROM product_sync_runs WHERE mode='delta' AND origin <> 'pick'`)).rows[0].at;
  const r = await ps.runCatalogSync({ mode: 'pick', codes: ['ce0001', ' CE0003 ', 'PRO001', 'NOPE', 'CE0001'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.envio_id, /^SEL-/);
  assert.equal(r.total_productos, 2);
  assert.deepEqual(r.missing.sort(), ['NOPE', 'PRO001']);
  const run = (await pool.query(`SELECT mode, origin FROM product_sync_runs WHERE id=$1`, [r.run_id])).rows[0];
  assert.deepEqual(run, { mode: 'delta', origin: 'pick' });
  const ob = (await pool.query(`SELECT * FROM crm_customer_outbox WHERE entity_id=$1`, [r.run_id])).rows;
  assert.equal(ob.length, 1); assert.equal(ob[0].origin, 'product_pick');
  assert.equal(ob[0].payload.esUltimoLote, false);
  assert.deepEqual(ob[0].payload.productos.map((x) => x.codigo).sort(), ['CE0001', 'CE0003']);
  const st = (await pool.query(`SELECT outbox_id FROM product_sync_state WHERE code='CE0001'`)).rows[0];
  assert.equal(Number(st.outbox_id), Number(ob[0].id), '보낸 값이 기준이 된다');
  const after = (await pool.query(`SELECT max(created_at) AS at FROM product_sync_runs WHERE mode='delta' AND origin <> 'pick'`)).rows[0].at;
  assert.equal(String(after), String(before), '변경분 주기 계산에서 빠진다');
  assert.equal((await ps.runCatalogSync({ mode: 'pick', codes: [] })).error, 'no_codes');
  assert.equal((await ps.runCatalogSync({ mode: 'pick', codes: ['NOPE'] })).error, 'codes_not_found');
  assert.equal((await ps.runCatalogSync({ mode: 'pick', codes: Array.from({ length: 501 }, (_, k) => 'X' + k) })).error, 'too_many_codes');
  const found = await ps.searchSendable('ce00');
  assert.ok(found.length >= 2 && found.every((x) => !/^PRO/.test(x.code)));
  assert.equal((await ps.searchSendable('gorra')).length, 0, 'PRO 판촉물은 검색에도 안 나옴');
});

test('DB ⑧ 화면 API — 찾기 · 붙여넣기 확인 · 고른 제품 보내기(HTTP)', { skip }, async () => {
  await db();
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  app.register((await import('../src/routes/productSyncRoutes.js')).default);
  await app.ready();
  try {
    const s1 = (await app.inject({ method: 'GET', url: '/api/product-sync/search?q=CE000' })).json();
    assert.ok(s1.items.length >= 2);
    const c = (await app.inject({ method: 'POST', url: '/api/product-sync/pick-check', payload: { codes: 'CE0001\nnope, PRO001' } })).json();
    assert.deepEqual(c.found.map((x) => x.code), ['CE0001']); assert.deepEqual(c.missing.sort(), ['PRO001', 'nope']);
    assert.equal(typeof c.found[0].existencia, 'number');
    const r = await app.inject({ method: 'POST', url: '/api/product-sync/run', payload: { mode: 'pick', codes: ['CE0003'] } });
    assert.equal(r.statusCode, 200, r.body); assert.match(r.json().envio_id, /^SEL-/);
    const e = await app.inject({ method: 'POST', url: '/api/product-sync/run', payload: { mode: 'pick', codes: ['NOPE'] } });
    assert.equal(e.statusCode, 400); assert.equal(e.json().error, 'codes_not_found'); assert.deepEqual(e.json().missing, ['NOPE']);
  } finally { await app.close(); }
});

test('화면 — 버튼 · 설정 칸 · 빌드 토큰', () => {
  const html = readFileSync(resolve(HERE, '../../refatrix-integrations.html'), 'utf8');
  for (const id of ['btnPickSend', 'fPickQ', 'fPickPaste', 'btnPickPaste', 'pickRows', 'btnCatalogDelta', 'btnCatalogDeltaPreview', 'btnCatalogBaseline', 'fDeltaAuto', 'fDeltaEvery', 'fFullWeekday'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /\/api\/product-sync\/delta-preview/);
  assert.match(html, /build 20261006(ex|xl)|build 20261007pk/);
});

test.after(async () => { if (pool) await pool.end(); try { (await import('../src/db.js')).pool?.end?.(); } catch (_) {} });
