// =====================================================================
// Refatrix ERP · test/product_oe.test.mjs  (2026-09-23 · 0228 OE 순정번호)
//
// 실행: DATABASE_URL=postgres://... node --test --experimental-test-module-mocks test/product_oe.test.mjs
//   · DATABASE_URL 이 없으면 순수 로직만 돌고 DB 테스트는 skip.
//   · DB 테스트는 **빈 DB** 를 전제로 최소 스텁 표를 만들고 0228 을 두 번 적용(멱등)한 뒤
//     운영 라우트 모듈(productRoutes · quoteRoutes)을 Fastify 위에서 그대로 돌린다.
//     인증(authGuard)·감사(audit)만 모의로 바꾼다.
// =====================================================================
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  parseOe, formatOe, canonicalOe, normOe, sameOe, customerOeText, oeToken, OE_FOR_NOTE,
} from '../src/oeParse.js';
import { parseRow, buildHeaderIndex, buildPreview, diffProduct, COLUMN_MAP } from '../src/productImport.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONN = process.env.DATABASE_URL || '';

// ── ① 순수 로직 ──────────────────────────────────────────────────────
test('OE 파싱 — 직접·FOR·(SYD)·None 류·중복', () => {
  const r = parseOe('54500-8H310 // FOR 54500-8H31A // None // #N/A // 0 // 545008H310 // 48530-3S125 (SYD) //  ');
  assert.deepEqual(r.map(oeToken), ['54500-8H310', 'FOR 54500-8H31A', '48530-3S125 (SYD)']);
  assert.equal(r[1].rel, 'for'); assert.equal(r[2].source, 'syd');
  assert.equal(r[0].oe_norm, '545008H310');
});
test('OE 파싱 — 같은 번호가 FOR 와 직접으로 둘 다 오면 직접이 이긴다', () => {
  const r = parseOe('FOR 1K0 407 183 M // 1K0-407-183-M');
  assert.equal(r.length, 1); assert.equal(r[0].rel, 'oe'); assert.equal(r[0].oe_code, '1K0-407-183-M');
});
test('OE 파싱 — 애프터마켓형·설명문구도 그대로 OE (D7), 세미콜론 구분도 받는다', () => {
  const r = parseOe('MEVOTECH-MK6659; CABIN AIR FILTER (K-11) // 3640.70');
  assert.deepEqual(r.map((x) => x.oe_code), ['MEVOTECH-MK6659', 'CABIN AIR FILTER (K-11)', '3640.70']);
});
test('정규 표기 — 재업로드 멱등 · 빈 값은 null', () => {
  assert.equal(canonicalOe(' 54500-8H310//FOR  54500-8H31A '), '54500-8H310 // FOR 54500-8H31A');
  assert.equal(canonicalOe('None // #N/A'), null);
  assert.equal(formatOe([]), null);
  assert.ok(sameOe(parseOe('A-1 // FOR B-2'), parseOe('FOR B2 // A1')));
  assert.ok(!sameOe(parseOe('A-1'), parseOe('FOR A-1')));
});
test('고객 견적서 Referencia OE — 직접 OE 만 · 앞 3개 · (SYD) 표식 없음', () => {
  const t = customerOeText(parseOe('A1 // FOR B2 // C3 (SYD) // D4 // E5'));
  assert.equal(t, 'A1 / C3 / D4 (+1)');
  assert.equal(customerOeText(parseOe('FOR B2')), '');
});
test('FOR 부연설명 문구 — 디렉터 지정 문장 그대로', () => {
  assert.equal(OE_FOR_NOTE, '해당 OE번호 부품의 조립품에 해당하는 OE부품입니다');
});
test('업로드 파서 — OE 헤더 3종 인식', () => {
  for (const h of ['OE', 'OE / OEM Reference', 'Referencia OE']) assert.equal(COLUMN_MAP[h], 'oe');
});
test('★ 두 열 파일(Clave CTR + OE) — 기존 제품은 제품명 없어도 되고, SyD·적용차종은 비교조차 안 한다', () => {
  const idx = buildHeaderIndex(['Clave CTR', 'OE']);
  const p = parseRow(['CQ0728R', '54500-8H310 // FOR 54500-8H31A'], idx);
  assert.equal(p.has.scode, false); assert.equal(p.has.app, false); assert.equal(p.has.name, false);
  const ex = { id: 1, code: 'CQ0728R', name: 'HORQUILLA', scode: '1526051', syd_codes: ['1526051'],
    app_texts: ['NISSAN X-Trail 2002-2007'], oe: null, oe_codes: [] };
  const d = diffProduct(p, ex);
  assert.equal(d.syd_changed, false); assert.equal(d.app_changed, false); assert.equal(d.oe_changed, true);
  const pv = buildPreview([p], { CQ0728R: ex });
  assert.equal(pv.errors.length, 0); assert.equal(pv.updated.length, 1);
  assert.equal(pv.oe_products, 1); assert.equal(pv.oe_added_codes, 2);
  assert.deepEqual(pv.updated[0].oe_to, ['54500-8H310', 'FOR 54500-8H31A']);
});
test('두 열 파일 — 신규 코드는 여전히 제품명 필수', () => {
  const idx = buildHeaderIndex(['Clave CTR', 'OE']);
  const pv = buildPreview([parseRow(['ZZNEW1', 'X-1'], idx)], {});
  assert.equal(pv.errors[0].reason, 'name_missing');
});
test('제품명 열이 있는데 비었으면 기존 제품도 오류(이름을 지우는 사고 방지)', () => {
  const idx = buildHeaderIndex(['Clave CTR', 'Nombre del producto', 'OE']);
  const pv = buildPreview([parseRow(['CQ0728R', '', 'X-1'], idx)], { CQ0728R: { id: 1, code: 'CQ0728R', name: 'H', syd_codes: [], app_texts: [], oe_codes: [] } });
  assert.equal(pv.errors.length, 1);
});
test('OE 칸을 비워 올리면 「OE 가 모두 지워지는 제품」으로 잡힌다', () => {
  const idx = buildHeaderIndex(['Clave CTR', 'OE']);
  const ex = { id: 1, code: 'A', name: 'N', syd_codes: [], app_texts: [], oe: 'X-1', oe_codes: parseOe('X-1') };
  const pv = buildPreview([parseRow(['A', ''], idx)], { A: ex });
  assert.deepEqual(pv.oe_cleared, ['A']);
});
test('같은 파일 재업로드 = 동일(정규 표기 저장)', () => {
  const idx = buildHeaderIndex(['Clave CTR', 'OE']);
  const p = parseRow(['A', ' X-1//FOR  Y-2 '], idx);
  const ex = { id: 1, code: 'A', name: 'N', syd_codes: [], app_texts: [], oe: 'X-1 // FOR Y-2', oe_codes: parseOe('X-1 // FOR Y-2') };
  const pv = buildPreview([p], { A: ex });
  assert.equal(pv.unchanged, 1); assert.equal(pv.updated.length, 0);
});
test('기존 전체 마스터 파일(OE 열 없음)은 예전과 똑같이 동작 — SyD 변경 감지 유지', () => {
  const idx = buildHeaderIndex(['Clave CTR', 'Clave SyD', 'Nombre del producto']);
  const p = parseRow(['A', '111 // 222', 'N'], idx);
  assert.equal(p.has.oe, false);
  const d = diffProduct(p, { id: 1, code: 'A', name: 'N', scode: '111', syd_codes: ['111'], app_texts: [], oe_codes: parseOe('Z-9') });
  assert.equal(d.syd_changed, true); assert.equal(d.oe_changed, false);
});

// ── ② 실 PostgreSQL 종단 ───────────────────────────────────────────────
const STUB = `
DROP SCHEMA public CASCADE; CREATE SCHEMA public;
CREATE TABLE users (id BIGSERIAL PRIMARY KEY, name TEXT);
INSERT INTO users (id, name) VALUES (1, 'director');
CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY, code TEXT UNIQUE, scode TEXT, app TEXT, name TEXT, sat_code TEXT, origin TEXT,
  list_price NUMERIC, discount NUMERIC, iva_rate NUMERIC, ean TEXT, location TEXT, list_price_syd NUMERIC,
  price_customer_syd NUMERIC, price_customer_ctr NUMERIC, stock_qty NUMERIC DEFAULT 0, avg_cost NUMERIC,
  rack_location TEXT, material TEXT, is_active BOOLEAN DEFAULT true, inactive_reason TEXT, status_changed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ, created_by BIGINT, updated_by BIGINT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE product_syd_codes (product_id BIGINT REFERENCES products(id) ON DELETE CASCADE, syd_code TEXT, UNIQUE(product_id, syd_code));
CREATE TABLE product_applications (id BIGSERIAL PRIMARY KEY, product_id BIGINT REFERENCES products(id) ON DELETE CASCADE,
  app_text TEXT, maker TEXT, model TEXT, year_from INT, year_to INT);
CREATE TABLE product_change_log (id BIGSERIAL PRIMARY KEY, product_id BIGINT, code TEXT, action TEXT, source TEXT,
  changes JSONB, changed_by BIGINT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE product_xref_codes (product_id BIGINT, norm_code TEXT);
CREATE TABLE product_dev_requests (id BIGSERIAL PRIMARY KEY, input_code TEXT, customer_id BIGINT, requested_qty NUMERIC,
  source_quote_id BIGINT, status TEXT DEFAULT 'received', deleted_at TIMESTAMPTZ, developed_at DATE, result_product_id BIGINT,
  result_ctr_code TEXT, updated_by BIGINT, updated_at TIMESTAMPTZ);
CREATE TABLE customers (id BIGSERIAL PRIMARY KEY, name TEXT, discount NUMERIC DEFAULT 0, team_id BIGINT, owner_id BIGINT, deleted_at TIMESTAMPTZ);
INSERT INTO customers (id, name, discount) VALUES (1, 'CLIENTE PRUEBA', 49);
CREATE TABLE quotes (id BIGSERIAL PRIMARY KEY, quote_no TEXT, status TEXT DEFAULT 'draft', deleted_at TIMESTAMPTZ,
  reserve_expires_at TIMESTAMPTZ, packing_printed_at TIMESTAMPTZ);
CREATE TABLE quote_lines (id BIGSERIAL PRIMARY KEY, quote_id BIGINT, line_no INT, product_id BIGINT, input_code TEXT,
  ctr_code TEXT, syd_codes TEXT, product_name TEXT, app_text TEXT, qty NUMERIC, list_price NUMERIC, discount_rate NUMERIC,
  final_price NUMERIC, line_subtotal NUMERIC, line_iva NUMERIC, line_total NUMERIC, avail_stock NUMERIC, stock_flag TEXT,
  issue TEXT, reserved_qty NUMERIC DEFAULT 0);
CREATE TABLE sales_invoices (id BIGSERIAL PRIMARY KEY, status TEXT, deleted_at TIMESTAMPTZ, customer_id BIGINT);
CREATE TABLE sales_invoice_lines (id BIGSERIAL PRIMARY KEY, invoice_id BIGINT, product_id BIGINT, qty NUMERIC, line_amount_mxn NUMERIC, cogs_mxn NUMERIC, applied_unit_cost NUMERIC);
CREATE TABLE import_batches (id BIGSERIAL PRIMARY KEY, batch_no TEXT, import_date DATE, currency TEXT, fx_rate NUMERIC, status TEXT, deleted_at TIMESTAMPTZ, exclude_from_cost BOOLEAN);
CREATE TABLE import_lines (id BIGSERIAL PRIMARY KEY, batch_id BIGINT, product_id BIGINT, qty NUMERIC, import_price NUMERIC, unit_cost_mxn NUMERIC, po_ref TEXT);
CREATE VIEW v_backorder AS SELECT NULL::bigint AS product_id, 0::numeric AS backorder_qty WHERE false;
CREATE VIEW v_incoming_stock AS SELECT NULL::bigint AS product_id, 0::numeric AS incoming_qty, NULL::date AS incoming_eta WHERE false;
`;
const SEED = `
INSERT INTO products (id, code, scode, app, name, list_price, stock_qty) VALUES
 (1,'CQ0728R','54500-8H310','NISSAN X-Trail 2002-2007','HORQUILLA',1000,5),
 (2,'CQ0728L','54501-8H310','NISSAN X-Trail 2002-2007','HORQUILLA',1000,5),
 (3,'GV1187','1405004','NISSAN X-Trail 2002-2007','BUJE',200,10),
 (4,'CB0011','1006019','DODGE, CHRYSLER 200 2011-2014','RÓTULA',344,46),
 (5,'PRO001',NULL,NULL,'GORRA',0,3),
 (6,'CE0999','777888',NULL,'TERMINAL',100,1);
SELECT setval('products_id_seq', 100);
INSERT INTO product_syd_codes VALUES (1,'54500-8H310'),(2,'54501-8H310'),(3,'1405004'),(4,'1006019'),(6,'777888');
INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES
 (1,'NISSAN X-Trail 2002-2007','NISSAN','X-Trail',2002,2007),(2,'NISSAN X-Trail 2002-2007','NISSAN','X-Trail',2002,2007),
 (3,'NISSAN X-Trail 2002-2007','NISSAN','X-Trail',2002,2007),(4,'DODGE, CHRYSLER 200 2011-2014','DODGE, CHRYSLER','200',2011,2014);
`;

let app = null, pool = null;
async function boot() {
  if (app) return app;
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: CONN });
  await pool.query(STUB);
  const mig = readFileSync(resolve(HERE, '../migrations/0228_product_oe_codes.sql'), 'utf8');
  await pool.query(mig); await pool.query(mig);          // 멱등
  await pool.query(SEED);
  mock.module(resolve(HERE, '../src/middleware/authGuard.js'), {
    namedExports: {
      authGuard: async (req) => { req.ctx = { perm: { role: 'director', userId: 1, pageAccess: {} }, isRegistered: true }; },
      requirePage: () => async () => {}, requirePageAny: () => async () => {}, requirePageEdit: () => async () => {},
      requirePageEditAny: () => async () => {}, requireDirector: (req, reply, done) => done(),
    },
  });
  mock.module(resolve(HERE, '../src/audit.js'), {
    namedExports: { logEvent: async () => {}, logPageView: async () => {} },
  });
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  app.register((await import('../src/routes/productRoutes.js')).default);
  app.register((await import('../src/routes/quoteRoutes.js')).default);
  await app.ready();
  return app;
}
const skip = !CONN;
const q = (t, p) => pool.query(t, p);

test('DB ① 0228 두 번 적용(멱등) · 표·칼럼 생김', { skip }, async () => {
  await boot();
  const t = (await q(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name='product_oe_codes'`)).rows[0].n;
  const c = (await q(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='quote_lines' AND column_name IN ('match_source','oe_codes')`)).rows[0].n;
  assert.equal(t, 1); assert.equal(c, 2);
});

test('DB ② ★ 두 열 업로드 — OE 만 바뀌고 SyD·적용차종·PRO·이름은 그대로', { skip }, async () => {
  const a = await boot();
  const before = (await q(`SELECT (SELECT count(*) FROM product_syd_codes)::int s, (SELECT count(*) FROM product_applications)::int a`)).rows[0];
  const payload = { header: ['Clave CTR', 'OE'], rows: [
    ['CQ0728R', '54500-8H310 // 54500-8H31A // FOR 40160-8H300 // None'],
    ['CQ0728L', '54501-8H310 // 54501-8H31A'],
    ['GV1187', 'FOR 54500-8H310 // FOR 54501-8H310'],
    ['CB0011', '5085914AB // 68224650AA // FVP-BJ96115'],
    ['CE0999', '1006019'],                    // 다른 제품(CB0011)의 SyD 와 같은 OE — 검토용 충돌
  ] };
  const pv = (await a.inject({ method: 'POST', url: '/api/products/import/preview', payload })).json();
  assert.equal(pv.errors.length, 0, JSON.stringify(pv.errors));
  assert.equal(pv.updated.length, 5); assert.equal(pv.new_items.length, 0);
  assert.equal(pv.oe_ready, true); assert.equal(pv.oe_column, true);
  assert.deepEqual(pv.columns_absent.sort(), ['app', 'name', 'scode']);
  assert.ok(pv.oe_collisions.count >= 3);   // GV1187 FOR ×2 (CQ0728R/L 의 SyD) + CE0999(CB0011 의 SyD)
  const cm = (await a.inject({ method: 'POST', url: '/api/products/import/commit', payload })).json();
  assert.equal(cm.ok, true); assert.equal(cm.updated, 5); assert.equal(cm.skipped, 0);
  const after = (await q(`SELECT (SELECT count(*) FROM product_syd_codes)::int s, (SELECT count(*) FROM product_applications)::int a`)).rows[0];
  assert.deepEqual(after, before, 'SyD·적용차종 분해표가 그대로여야 한다');
  const p1 = (await q(`SELECT name, scode, oe FROM products WHERE code='CQ0728R'`)).rows[0];
  assert.equal(p1.name, 'HORQUILLA'); assert.equal(p1.scode, '54500-8H310');
  assert.equal(p1.oe, '54500-8H310 // 54500-8H31A // FOR 40160-8H300');
  const pro = (await q(`SELECT name, oe, stock_qty FROM products WHERE code='PRO001'`)).rows[0];
  assert.equal(pro.name, 'GORRA'); assert.equal(pro.oe, null); assert.equal(Number(pro.stock_qty), 3);
  const n = (await q(`SELECT count(*)::int n FROM product_oe_codes`)).rows[0].n;
  assert.equal(n, 3 + 2 + 2 + 3 + 1);
  const log = (await q(`SELECT changes FROM product_change_log WHERE code='CQ0728R' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.ok(log.changes._oe); assert.equal(log.changes._oe.to.length, 3);
  // 재업로드 = 전부 동일
  const cm2 = (await a.inject({ method: 'POST', url: '/api/products/import/commit', payload })).json();
  assert.equal(cm2.unchanged, 5); assert.equal(cm2.updated, 0);
});

test('DB ③ 제품 찾기 — OE(하이픈 없이·부분)로 찾고, 정확일치는 SyD 등급', { skip }, async () => {
  const a = await boot();
  const r = (await a.inject({ method: 'GET', url: '/api/products?q=5085914' })).json();
  assert.deepEqual(r.items.map((x) => x.code), ['CB0011']);
  assert.match(r.items[0].oe, /5085914AB/);
  const r2 = (await a.inject({ method: 'GET', url: '/api/products?q=545008H31A' })).json();
  assert.deepEqual(r2.items.map((x) => x.code).sort(), ['CQ0728R']);
  const r3 = (await a.inject({ method: 'GET', url: '/api/products?q=508' })).json();   // 4자 미만 — OE 에 대지 않는다
  assert.ok(!r3.items.some((x) => x.code === 'CB0011'));
});

test('DB ④ 견적 코드 해석 — OE 1건 자동 확정, FOR 만이면 후보(pick_required), SyD∪OE 충돌은 다중', { skip }, async () => {
  const a = await boot();
  const one = (await a.inject({ method: 'GET', url: '/api/quotes/resolve-code?code=68224650AA' })).json();
  assert.equal(one.matches.length, 1); assert.equal(one.matches[0].ctr_code, 'CB0011');
  assert.equal(one.matches[0].matched_by, 'oe'); assert.equal(one.pick_required, false);
  const forOnly = (await a.inject({ method: 'GET', url: '/api/quotes/resolve-code?code=40160-8H300' })).json();
  assert.equal(forOnly.matches.length, 1); assert.equal(forOnly.pick_required, true);
  assert.equal(forOnly.matches[0].matched_by, 'oe_for');
  // 54500-8H310 = CQ0728R 의 SyD 이자 OE, GV1187 의 FOR → 두 제품 후보
  const mix = (await a.inject({ method: 'GET', url: '/api/quotes/resolve-code?code=54500-8H310' })).json();
  assert.deepEqual(mix.matches.map((x) => x.ctr_code).sort(), ['CQ0728R', 'GV1187']);
  // CE0999 의 OE 1006019 는 CB0011 의 SyD 와 같다 → 다중(조용히 한쪽으로 가지 않는다)
  const col = (await a.inject({ method: 'GET', url: '/api/quotes/resolve-code?code=1006019' })).json();
  assert.equal(col.matches.length, 2);
  // CTR 정확일치는 그대로 1건
  const ctr = (await a.inject({ method: 'GET', url: '/api/quotes/resolve-code?code=CB0011' })).json();
  assert.equal(ctr.matches.length, 1); assert.equal(ctr.source, 'ctr');
});

test('DB ⑤ 견적 미리보기 — FOR 만이면 ambiguous, OE 줄에 Referencia OE(직접 OE 만)', { skip }, async () => {
  const a = await boot();
  const r = (await a.inject({ method: 'POST', url: '/api/quotes/preview', payload: { customer_id: 1, lines: [
    { code: '5085914-AB', qty: 2 }, { code: '40160 8H300', qty: 1 } ] } })).json();
  assert.equal(r.lines[0].ctr_code, 'CB0011'); assert.equal(r.lines[0].final_price, 175.44);
  assert.equal(r.lines[0].oe_ref, '5085914AB / 68224650AA / FVP-BJ96115');
  assert.equal(r.lines[1].ambiguous, true); assert.equal(r.lines[1].pick_required, true);
  const sc = (await a.inject({ method: 'GET', url: '/api/quotes/search-code?q=8H31A' })).json();
  assert.ok(sc.items.some((x) => x.ctr_code === 'CQ0728R' && x.oe_hit && x.oe_hit.code === '54500-8H31A'));
});

test('DB ⑥ 견적 줄 기록 — match_source · oe_codes (buildLines + stampLineMeta)', { skip }, async () => {
  await boot();
  const { buildLines, stampLineMeta } = await import('../src/quoteBuild.js');
  const lines = await buildLines(49, 16, [
    { code: '68224650AA', qty: 1 },                   // OE 로 해석
    { code: '5085914AB', product_id: 4, qty: 1 },    // 자동완성으로 고른 줄 — 친 코드가 OE
    { code: '1405004', product_id: 3, qty: 1 },      // SyD
    { code: '40160-8H300', qty: 1 },                 // FOR 만 — 저장 경로에서는 multi_match(미확정)
    { code: 'NOEXISTE', qty: 1 },
  ]);
  assert.deepEqual(lines.map((l) => l.match_source), ['oe', 'oe', 'syd', 'none', 'none']);
  assert.equal(lines[3].issue, 'multi_match'); assert.equal(lines[3].product_id, null);
  assert.match(lines[0].oe_codes, /68224650AA/);
  const qid = (await q(`INSERT INTO quotes (quote_no) VALUES ('Q-T-1') RETURNING id`)).rows[0].id;
  const c = await pool.connect();
  try {
    for (const l of lines) await c.query(`INSERT INTO quote_lines (quote_id, line_no, product_id, input_code) VALUES ($1,$2,$3,$4)`, [qid, l.line_no, l.product_id, l.input_code]);
    await stampLineMeta(c, qid, lines);
  } finally { c.release(); }
  const got = (await q(`SELECT line_no, match_source FROM quote_lines WHERE quote_id=$1 ORDER BY line_no`, [qid])).rows;
  assert.deepEqual(got.map((x) => x.match_source), ['oe', 'oe', 'syd', 'none', 'none']);
});

test('DB ⑦ 화면 수정 — OE 저장(정규 표기) · 분해표 재동기화 · 신규 등록도 OE', { skip }, async () => {
  const a = await boot();
  const r = (await a.inject({ method: 'PATCH', url: '/api/products/6', payload: { oe: ' AAA-1 // FOR BBB-2 // none ', scode: '777888' } })).json();
  assert.equal(r.ok, true); assert.ok(r.changed.includes('oe'));
  assert.equal((await q(`SELECT oe FROM products WHERE id=6`)).rows[0].oe, 'AAA-1 // FOR BBB-2');
  assert.equal((await q(`SELECT count(*)::int n FROM product_oe_codes WHERE product_id=6`)).rows[0].n, 2);
  const m = (await a.inject({ method: 'GET', url: '/api/products/6/master' })).json();
  assert.equal(m.oe, 'AAA-1 // FOR BBB-2');
  const n = (await a.inject({ method: 'POST', url: '/api/products', payload: { code: 'ZZOE1', name: 'X', oe: 'CCC-3' } })).json();
  assert.equal(n.ok, true);
  assert.equal((await q(`SELECT count(*)::int n FROM product_oe_codes o JOIN products p ON p.id=o.product_id WHERE p.code='ZZOE1'`)).rows[0].n, 1);
  const dd = (await a.inject({ method: 'GET', url: '/api/products/6/drilldown' })).json();
  assert.deepEqual(dd.oe.map((x) => x.rel), ['oe', 'for']); assert.equal(dd.oe_for_note, OE_FOR_NOTE);
});

test('DB ⑧ 마스터 다운로드에 OE · 개발요청 자동매칭(직접 OE 만)', { skip }, async () => {
  const a = await boot();
  const ex = (await a.inject({ method: 'GET', url: '/api/products/master-export' })).json();
  assert.equal(ex.items.find((x) => x.code === 'CB0011').oe, '5085914AB // 68224650AA // FVP-BJ96115');
  await q(`INSERT INTO product_dev_requests (input_code) VALUES ('68224650-AA'), ('FOR-ONLY-40160-8H300'), ('40160-8H300')`);
  const { sweepDevRequestMatches } = await import('../src/devMatchSweep.js');
  try { await sweepDevRequestMatches({ userId: 1, notify: false }); } catch (_) { /* 알림·오퍼 표 없음 — 전환만 본다 */ }
  const rows = (await q(`SELECT input_code, status, result_ctr_code FROM product_dev_requests ORDER BY id`)).rows;
  assert.equal(rows[0].status, 'developed'); assert.equal(rows[0].result_ctr_code, 'CB0011');
  assert.equal(rows[2].status, 'received', 'FOR 번호로는 개발완료가 되지 않는다');
});

test('DB ⑨ 0228 전(반쪽 배포) — OE 열은 무시되고 나머지는 평소대로', { skip }, async () => {
  const a = await boot();
  const { setOeReady } = await import('../src/oeCodes.js');
  setOeReady(false);
  try {
    const pv = (await a.inject({ method: 'POST', url: '/api/products/import/preview',
      payload: { header: ['Clave CTR', 'Nombre del producto', 'OE'], rows: [['CE0999', 'TERMINAL NUEVO', 'QQQ-1']] } })).json();
    assert.equal(pv.oe_ready, false); assert.equal(pv.updated[0].oe_changed, false);
    const r = (await a.inject({ method: 'GET', url: '/api/quotes/resolve-code?code=68224650AA' })).json();
    assert.equal(r.matches.length, 0);
    const l = (await a.inject({ method: 'GET', url: '/api/products?q=HORQ' })).json();
    assert.ok(l.items.length >= 2);
  } finally { setOeReady(true); }
});

test('DB 정리', { skip }, async () => { if (app) await app.close(); if (pool) await pool.end(); });
