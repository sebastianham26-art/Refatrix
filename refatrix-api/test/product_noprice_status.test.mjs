// =====================================================================
// 2026-09-24 · 정가 없는 제품 매출 차단 + 업로드 「Estado」 판매상태 일괄 지정
// 실행: DATABASE_URL=postgres://... node --test --experimental-test-module-mocks test/product_noprice_status.test.mjs
// =====================================================================
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { lacksListPrice, isPromoCode } from '../src/noPrice.js';
import { parseEstado, buildHeaderIndex, parseRow, buildPreview } from '../src/productImport.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONN = process.env.DATABASE_URL || '';

test('정가 없음 판정 — NULL·0 은 없음, 판촉물(PRO) 예외', () => {
  assert.equal(lacksListPrice({ code: 'CE0922R', list_price: null }), true);
  assert.equal(lacksListPrice({ code: 'CE0922R', list_price: '0' }), true);
  assert.equal(lacksListPrice({ code: 'CE0922R', list_price: '369.00' }), false);
  assert.equal(lacksListPrice({ code: 'PRO001', list_price: null }), false);
  assert.equal(isPromoCode('pro_019'), true);
});
test('Estado 파싱', () => {
  for (const v of ['Inactivo', 'inactive', '비활성', 'Discontinued']) assert.equal(parseEstado(v), 'inactive');
  for (const v of ['Activo', 'active', '활성']) assert.equal(parseEstado(v), 'active');
  assert.equal(parseEstado(''), null); assert.equal(parseEstado('quizá'), 'invalid');
});
test('미리보기 — 신규 비활성 집계 · 잘못된 값은 오류 · 빈칸은 그대로', () => {
  const idx = buildHeaderIndex(['Clave CTR', 'Nombre del producto', 'Estado', 'Motivo inactivo']);
  const pv = buildPreview([
    parseRow(['N1', 'X', 'Inactivo', 'Discontinued (CTR)'], idx),
    parseRow(['N2', 'X', 'talvez', ''], idx),
    parseRow(['E1', 'X', '', ''], idx),
    parseRow(['E2', 'X', 'Inactivo', ''], idx),
  ], { E1: { id: 1, code: 'E1', name: 'X', is_active: true, syd_codes: [], app_texts: [] },
       E2: { id: 2, code: 'E2', name: 'X', is_active: true, syd_codes: [], app_texts: [] } });
  assert.equal(pv.status_to_inactive, 2); assert.equal(pv.errors[0].reason, 'estado_invalid');
  assert.equal(pv.unchanged, 1); assert.equal(pv.updated[0].status_to, 'inactive');
});

const STUB_EXTRA = `
ALTER TABLE products ADD COLUMN IF NOT EXISTS status_changed_by BIGINT;
CREATE TABLE product_status_log (id BIGSERIAL PRIMARY KEY, product_id BIGINT, code TEXT, action TEXT, reason TEXT,
  check_id BIGINT, open_summary JSONB, changed_by BIGINT, created_at TIMESTAMPTZ DEFAULT now());
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS customer_id BIGINT, ADD COLUMN IF NOT EXISTS invoice_id BIGINT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS rfc TEXT, ADD COLUMN IF NOT EXISTS credit_days INT;
`;
let app = null, pool = null;
async function boot() {
  if (app) return app;
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: CONN });
  const src = readFileSync(resolve(HERE, 'product_oe.test.mjs'), 'utf8');
  await pool.query(src.split('const STUB = `')[1].split('`;')[0]);
  await pool.query(readFileSync(resolve(HERE, '../migrations/0228_product_oe_codes.sql'), 'utf8'));
  await pool.query(STUB_EXTRA);
  await pool.query(`INSERT INTO products (id, code, name, list_price, stock_qty) VALUES
    (1,'CE0922R','TERMINAL EXTERIOR',NULL,5),(2,'CB0011','RÓTULA',344,5),(3,'PRO001','GORRA',NULL,5);
    SELECT setval('products_id_seq', 100);
    INSERT INTO quotes (id, quote_no, status, customer_id, reserve_expires_at) VALUES (1,'Q-1','draft',1, now() + interval '1 day');
    INSERT INTO quote_lines (quote_id, line_no, product_id, input_code, qty) VALUES (1,1,1,'CE0922R',1),(1,2,2,'CB0011',1);`);
  mock.module(resolve(HERE, '../src/middleware/authGuard.js'), { namedExports: {
    authGuard: async (req) => { req.ctx = { perm: { role: 'director', userId: 1, pageAccess: {} }, isRegistered: true }; },
    requirePage: () => async () => {}, requirePageAny: () => async () => {}, requirePageEdit: () => async () => {},
    requirePageEditAny: () => async () => {}, requireDirector: (r, p, d) => d() } });
  mock.module(resolve(HERE, '../src/audit.js'), { namedExports: { logEvent: async () => {}, logPageView: async () => {} } });
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  app.register((await import('../src/routes/productRoutes.js')).default);
  app.register((await import('../src/routes/quoteRoutes.js')).default);
  app.register((await import('../src/routes/salesRoutes.js')).default);
  await app.ready();
  return app;
}
const skip = !CONN;

test('DB ① 견적 미리보기 — 정가 없음 표시(판촉물 제외)', { skip }, async () => {
  const a = await boot();
  const r = (await a.inject({ method: 'POST', url: '/api/quotes/preview', payload: { customer_id: 1, lines: [
    { code: 'CE0922R', product_id: 1, qty: 1 }, { code: 'CB0011', product_id: 2, qty: 1 }, { code: 'PRO001', product_id: 3, qty: 1 }] } })).json();
  assert.deepEqual(r.lines.map((l) => l.no_price), [true, false, false]);
});
test('DB ② 견적 → 매출 전환 — 정가 없는 줄이 있으면 409 no_list_price (포장·RFC 안내보다 먼저)', { skip }, async () => {
  const a = await boot();
  const r = await a.inject({ method: 'POST', url: '/api/quotes/1/convert', payload: {} });
  assert.equal(r.statusCode, 409); const j = r.json();
  assert.equal(j.error, 'no_list_price'); assert.deepEqual(j.items.map((x) => x.code), ['CE0922R']);
  const pv = (await a.inject({ method: 'GET', url: '/api/quotes/1/convert-preview' })).json();
  assert.deepEqual(pv.no_price_items.map((x) => x.code), ['CE0922R']);
});
test('DB ③ 직접 매출 등록 — 정가 없는 제품은 409, 판촉물은 통과(다음 관문으로)', { skip }, async () => {
  const a = await boot();
  const r = await a.inject({ method: 'POST', url: '/api/sales', payload: { customer_id: 1, inv_date: '2026-09-24', lines: [{ product_id: 1, qty: 1 }] } });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error, 'no_list_price');
  const r2 = await a.inject({ method: 'POST', url: '/api/sales', payload: { customer_id: 1, inv_date: '2026-09-24', lines: [{ product_id: 3, qty: 1 }] } });
  assert.notEqual(r2.json().error, 'no_list_price');
});
test('DB ④ 정가를 넣으면 바로 풀린다', { skip }, async () => {
  const a = await boot();
  await a.inject({ method: 'PATCH', url: '/api/products/1', payload: { list_price: '369' } });
  const r = await a.inject({ method: 'POST', url: '/api/quotes/1/convert', payload: {} });
  assert.notEqual(r.json().error, 'no_list_price');
});
test('DB ⑤ 업로드 Estado — 신규 비활성 등록 · 기존 비활성 전환 · 이력', { skip }, async () => {
  const a = await boot();
  const payload = { header: ['Clave CTR', 'Nombre del producto', 'List Price', 'Estado', 'Motivo inactivo'], rows: [
    ['ZN1', 'TERMINAL EXTERIOR', 369, 'Inactivo', 'Discontinued (CTR)'], ['CB0011', 'RÓTULA', 344, 'Inactivo', ''] ] };
  const pv = (await a.inject({ method: 'POST', url: '/api/products/import/preview', payload })).json();
  assert.equal(pv.status_to_inactive, 2); assert.equal(pv.errors.length, 0);
  const cm = (await a.inject({ method: 'POST', url: '/api/products/import/commit', payload })).json();
  assert.equal(cm.created, 1); assert.equal(cm.updated, 1);
  const rows = (await pool.query(`SELECT code, is_active, inactive_reason FROM products WHERE code IN ('ZN1','CB0011') ORDER BY code`)).rows;
  assert.deepEqual(rows.map((r) => [r.code, r.is_active]), [['CB0011', false], ['ZN1', false]]);
  assert.equal(rows[1].inactive_reason, 'Discontinued (CTR)');
  const log = (await pool.query(`SELECT code, action FROM product_status_log ORDER BY id`)).rows;
  assert.deepEqual(log.map((r) => r.action), ['deactivate', 'deactivate']);
  const again = (await a.inject({ method: 'POST', url: '/api/products/import/commit', payload })).json();
  assert.equal(again.unchanged, 2, '같은 파일 재업로드는 이력을 더 쌓지 않는다');
});
test('DB 정리', { skip }, async () => { if (app) await app.close(); if (pool) await pool.end(); });
