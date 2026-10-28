// =====================================================================
// lead_portal.test.mjs — Meta 광고 문의 고객 포털 (0297 · 2026-10-26)
//   A. 순수 함수 — 코드 형식 · 정규화 · 상태 · 마스킹 · 문의 모양(연락처 · 원문 제외) · 안내문
//   B. 실제 서버 + PostgreSQL(TEST_PG_URL):
//      발급(디렉터만) → 로그인(틀린 코드 · 잠금) → ERP API 차단 → 문의 목록(제외 · 가용 · 운송중 · 할인가 · 12개월 구매)
//      → 연락처 공개(기록 한 줄) → 매장 재고(고객 · 담당 영업 · 남의 고객 403 · 이력) → 주문(견적 · 예약 · 담당 · 문의 연결 · 멱등 · 단종 · 없는 코드)
//      → 범위(주) → 정지 · 재개 · 만료 → 재발급(옛 코드 · 옛 토큰 무효) → 삭제
//   C. 화면(jsdom): ERP 탭(발급 · 목록 · 매장 재고) · 플랫폼 leads.html(코드 → 목록 → 연락처 → Mi stock → 주문)
//   실행: TEST_PG_URL=postgres://... node --test test/lead_portal.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-lead-portal';
process.env.QUOTE_WA_ENABLED = '0';
process.env.META_LEADS_AUTO = '0';
const WSECRET = 'app-secret-lead-portal'; process.env.WHATSAPP_APP_SECRET = WSECRET; process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'vt';
process.env.META_PAGE_TOKEN = process.env.META_PAGE_TOKEN || 'PAGE_TOK_TEST';
const L = await import('../src/leadPortal.js');
let POOL = null;
// 서버의 주기 작업(스위퍼)이 남아 프로세스가 안 끝나므로 **모든 테스트가 끝난 뒤** 닫는다
after(async () => { if (POOL) { await POOL.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); } });
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('A1. 코드 · 정규화 · 해시', () => {
  for (let i = 0; i < 50; i++) assert.match(L.newCode(), /^RFX-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(L.normCode(' rfx-7k2m-q9pd '), '7K2MQ9PD');
  assert.equal(L.normCode('7K2M Q9PD'), '7K2MQ9PD', 'RFX 생략 · 공백 허용');
  assert.equal(L.normCode('RFX-7K2M'), null);
  assert.equal(L.normCode(null), null);
  assert.equal(L.formatFbQuoteNo('2026', 7), 'FB-2026-0007');
  assert.equal(L.codeHash('7K2MQ9PD'), L.codeHash(L.normCode('rfx 7k2m q9pd')));
  assert.notEqual(L.codeHash('7K2MQ9PD'), L.codeHash('7K2MQ9PE'));
});

test('A2. 상태 · 남은 일수 · 마스킹', () => {
  assert.equal(L.codeState({ active: true, expires_on: '2026-11-26' }, '2026-10-26'), 'active');
  assert.equal(L.codeState({ active: true, expires_on: '2026-10-31' }, '2026-10-26'), 'soon');
  assert.equal(L.codeState({ active: true, expires_on: '2026-10-26' }, '2026-10-26'), 'soon', '만료일 당일까지 열람');
  assert.equal(L.codeState({ active: true, expires_on: '2026-10-25' }, '2026-10-26'), 'expired');
  assert.equal(L.codeState({ active: false, expires_on: '2027-01-01' }, '2026-10-26'), 'paused');
  assert.equal(L.codeState({ active: true, expires_on: '2027-01-01', deleted_at: new Date() }, '2026-10-26'), 'deleted');
  assert.equal(L.daysBetween('2026-10-26', '2026-11-26'), 31);
  assert.equal(L.maskPhone('8123456742'), '81 •••• ••42');
  assert.equal(L.maskPhone('5218123456742'), '81 •••• ••42');
  assert.equal(L.maskPhone('123'), null);
  assert.equal(L.maskName('Jorge Treviño Garza'), 'J•••• T••••');
  assert.deepEqual([L.parseQty(''), L.parseQty('3'), L.parseQty(-1).ok, L.parseQty(1.5).ok], [{ ok: true, qty: null }, { ok: true, qty: 3 }, false, false]);
});

test('A3. 문의 모양 — 연락처 · 원문은 없다, 부품번호 · 미확정 부품', () => {
  const s = L.shapeLead({ id: '7', platform: 'whatsapp', name: 'Jorge Treviño', phone: '8123456742', customer_text: 'secreto', note: 'interno', status: 'nuevo',
    summary: 'Busca horquillas', vehicles: 'Nissan Versa 2017', items: [
      { status: 'ok', code: 'CQ0271L', qty: 1, veh: 'Versa 2017' }, { status: 'ok', code: 'CQ0271L', qty: 2 },
      { status: 'ok', code: 'CQ0271R', qty: null }, { status: 'sin_catalogo', pieza: 'Bujes de barra' }, { status: 'candidato', pieza: 'Bujes de barra' }] });
  assert.equal(s.id, 7);
  assert.deepEqual(s.parts.map((p) => [p.code, p.qty]), [['CQ0271L', 2], ['CQ0271R', 1]]);
  assert.deepEqual(s.open_parts, ['Bujes de barra']);
  assert.equal(s.name_masked, 'J•••• T••••'); assert.equal(s.phone_masked, '81 •••• ••42'); assert.equal(s.has_phone, true);
  const json = JSON.stringify(s);
  for (const bad of ['Jorge', '8123456742', 'secreto', 'interno', 'nuevo']) assert.ok(!json.includes(bad), bad + ' 가 새면 안 됨');
  const t = L.inviteText({ customerName: 'El Puente', code: 'RFX-7K2M-Q9PD', expiresOn: '2026-11-26', url: 'https://x/leads' });
  assert.ok(t.includes('RFX-7K2M-Q9PD') && t.includes('26/11/2026') && t.includes('https://x/leads'));
});

test('B. 실제 서버 + PostgreSQL', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  POOL = pool;
  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  t.after(() => app.close());
  L.resetFails();
  const T = Date.now().toString(36).slice(-5).toUpperCase();
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  const dir = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x',$2) RETURNING id`, [`LP Dir ${T}`, `lpdir${T}`]);
  const rep = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'sales','x',$2) RETURNING id`, [`Oscar ${T}`, `lprep${T}`]);
  const rep2 = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'sales','x',$2) RETURNING id`, [`Otro ${T}`, `lprep2${T}`]);
  for (const u of [rep, rep2]) await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'quote','anywhere','edit')`, [u.id]);
  const H = (u, role) => ({ authorization: 'Bearer ' + app.jwt.sign({ sub: Number(u.id), role }) });
  const D = H(dir, 'director'), R1 = H(rep, 'sales'), R2 = H(rep2, 'sales');
  const call = (h, method, url, payload, extra = {}) => app.inject({ method, url, payload, headers: { ...h, ...extra } });
  const cust = await one(`INSERT INTO customers (name, code, discount, owner_id, created_by, doc_gate) VALUES ($1,$2,45,$3,$4,false) RETURNING id`, [`Refacc El Puente ${T}`, `LP${T}`, rep.id, dir.id]);
  const P1 = await one(`INSERT INTO products (code, name, list_price, stock_qty) VALUES ($1,'HORQUILLA INF IZQ',1000,10) RETURNING id, code`, [`LQ${T}L`]);
  const P2 = await one(`INSERT INTO products (code, name, list_price, stock_qty) VALUES ($1,$2,2000,0) RETURNING id, code`, [`LS${T}`, `AMORTIGUADOR DEL ${T}`]);
  const P3 = await one(`INSERT INTO products (code, name, list_price, stock_qty, is_active) VALUES ($1,'DESCONTINUADO',500,5,false) RETURNING id, code`, [`LX${T}`]);
  // 운송중 P2 40개 · 다른 견적이 P1 3개 예약
  const sh = await one(`INSERT INTO inbound_shipments (status, eta) VALUES ('incoming', '2026-11-18') RETURNING id`);
  const pl = await one(`INSERT INTO inbound_pallets (shipment_id, order_no, pl_no) VALUES ($1,$2,1) RETURNING id`, [sh.id, `${T}-PO`]);
  await query(`INSERT INTO inbound_pallet_items (pallet_id, shipment_id, product_id, input_code, cartons, qty) VALUES ($1,$2,$3,$4,1,40)`, [pl.id, sh.id, P2.id, P2.code]);
  const qo = await one(`INSERT INTO quotes (status, reserve_expires_at) VALUES ('draft', now() + interval '5 hours') RETURNING id`);
  await query(`INSERT INTO quote_lines (quote_id, product_id, qty, reserved_qty) VALUES ($1,$2,3,3)`, [qo.id, P1.id]);
  // 이 고객이 최근 12개월 P1 6개 구매
  const inv = await one(`INSERT INTO sales_invoices (sat_no, customer_id, inv_date, credit_days, due_date, subtotal_mxn, iva_mxn, total_mxn, status, created_by)
                         VALUES ($1,$2,CURRENT_DATE - 14,0,CURRENT_DATE,3300,528,3828,'posted',$3) RETURNING id`, [`LPSAT${T}`, cust.id, dir.id]);
  await query(`INSERT INTO sales_invoice_lines (invoice_id, product_id, qty, list_price, discount_rate, unit_price, line_amount_mxn) VALUES ($1,$2,6,1000,45,550,3300)`, [inv.id, P1.id]);
  // 문의 3건(하나는 제외)
  const mk = (tid, state, phone, items, status = 'nuevo', name = 'Jorge Treviño') => one(
    `INSERT INTO meta_threads (platform, thread_id, user_id, name, first_at, last_at, in_count, msg_count, messages, customer_text, ai_state, a_phone, ai_vehicles, ai_summary, ai_items, status, note)
     VALUES ('whatsapp',$1,$2,$3,now() - interval '1 day',now(),2,3,'[{"me":false,"text":"secreto"}]'::jsonb,'texto secreto',$4,$5,'Nissan Versa 2017','Busca horquilla',$6::jsonb,$7,'nota interna') RETURNING id`,
    [tid, phone, name, state, phone, JSON.stringify(items), status]);
  const T1 = await mk(`wa:LP1${T}`, 'Nuevo León', '528123456742', [{ status: 'ok', code: P1.code, qty: 2 }, { status: 'sin_catalogo', pieza: 'Bujes' }]);
  const T2 = await mk(`wa:LP2${T}`, 'Tamaulipas', '528331112233', [{ status: 'ok', code: P2.code, qty: 2 }, { status: 'ok', code: 'NOEXISTE' + T, qty: 1 }]);
  const T3 = await mk(`wa:LP3${T}`, 'Nuevo León', '528199999999', [], 'descartado');

  // ── 발급 ──
  assert.equal((await call(R1, 'POST', '/api/lead-portal-admin/codes', { customer_id: cust.id, expires_on: '2099-01-01' })).statusCode, 403, '디렉터만');
  assert.equal((await call(D, 'POST', '/api/lead-portal-admin/codes', { customer_id: cust.id, expires_on: '2001-01-01' })).statusCode, 400, '과거 만료일');
  let r = await call(D, 'POST', '/api/lead-portal-admin/codes', { customer_id: cust.id, expires_on: '2099-12-31', basis_amount: '50,000', memo: '10월 5만' });
  assert.equal(r.statusCode, 200, r.body);
  let J = r.json(); const CODE = J.code;
  assert.match(CODE, /^RFX-/); assert.ok(J.invite.includes(CODE)); assert.equal(J.item.basis_amount, 50000); assert.equal(J.item.state, 'active');
  const codeId = J.item.id;
  const raw = await one(`SELECT code_hash, code_last4 FROM lead_portal_codes WHERE id=$1`, [codeId]);
  assert.ok(!raw.code_hash.includes(L.normCode(CODE)), '코드 원문 저장 안 함'); assert.equal(raw.code_last4, L.normCode(CODE).slice(-4));
  r = await call(D, 'GET', `/api/lead-portal-admin/customer-ref/${cust.id}`); assert.equal(r.json().d30, 3300);

  // ── 로그인 ──
  const IP = { 'x-nf-client-connection-ip': '10.9.9.' + (Date.now() % 200) };
  assert.equal((await call({}, 'POST', '/api/lead-portal/login', { code: 'RFX-2222-2222' }, IP)).statusCode, 401);
  r = await call({}, 'POST', '/api/lead-portal/login', { code: CODE.toLowerCase() }, IP);
  assert.equal(r.statusCode, 200, r.body); const TOK = r.json().token;
  assert.equal(r.json().me.customer_name, `Refacc El Puente ${T}`);
  const C = { authorization: 'Bearer ' + TOK };
  // 잠금
  const IP2 = { 'x-nf-client-connection-ip': '10.8.8.8' };
  for (let i = 0; i < 8; i++) await call({}, 'POST', '/api/lead-portal/login', { code: 'RFX-3333-333' + (i % 8 + 2) }, IP2);
  assert.equal((await call({}, 'POST', '/api/lead-portal/login', { code: CODE }, IP2)).statusCode, 429, '8회 틀리면 잠금(맞는 코드도)');
  // 포털 토큰으로 ERP API 는 전부 401
  for (const u of ['/api/meta-leads/status', '/api/customers', '/api/lead-portal-admin/codes']) assert.equal((await call(C, 'GET', u)).statusCode, 401, u);
  // ERP 토큰으로 포털 API 는 401
  assert.equal((await call(D, 'GET', '/api/lead-portal/leads')).statusCode, 401);

  // ── 문의 목록 ──
  r = await call(C, 'GET', '/api/lead-portal/leads'); assert.equal(r.statusCode, 200, r.body); J = r.json();
  const ids = J.leads.map((l) => l.id);
  assert.ok(ids.includes(Number(T1.id)) && ids.includes(Number(T2.id)) && !ids.includes(Number(T3.id)), '제외(descartado)는 안 보임');
  const body = r.body;
  for (const bad of ['Jorge', '8123456742', 'secreto', 'nota interna']) assert.ok(!body.includes(bad), bad + ' 노출 금지');
  const l1 = J.leads.find((l) => l.id === Number(T1.id));
  assert.deepEqual(l1.parts.map((p) => p.code), [P1.code]); assert.deepEqual(l1.open_parts, ['Bujes']); assert.equal(l1.phone_masked, '81 •••• ••42');
  const l2 = J.leads.find((l) => l.id === Number(T2.id));
  assert.deepEqual(l2.parts.map((p) => p.code), [P2.code], '카탈로그에 없는 코드는 뺀다');
  const p1 = J.products[P1.code], p2 = J.products[P2.code];
  assert.equal(p1.avail, 7, '현재고 10 − 다른 견적 예약 3'); assert.equal(p1.price, 550, '할인 45%'); assert.equal(p1.bought12, 6); assert.equal(p1.shelf, null);
  assert.equal(p2.avail, 0); assert.equal(p2.incoming, 40); assert.equal(p2.eta, '2026-11-18');

  // ── 연락처 공개 ──
  r = await call(C, 'POST', `/api/lead-portal/leads/${T1.id}/contact`); assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().phone, '528123456742'); assert.equal(r.json().wa_link, null, '0300 · wa.me 버튼 제거'); assert.equal(r.json().first_time, true);
  r = await call(C, 'POST', `/api/lead-portal/leads/${T1.id}/contact`); assert.equal(r.json().first_time, false);
  assert.equal((await call(C, 'POST', `/api/lead-portal/leads/${T3.id}/contact`)).statusCode, 404, '제외 문의');
  let rv = await one(`SELECT count(*)::int n, max(n) mx FROM lead_portal_reveals WHERE thread_id=$1`, [T1.id]); assert.deepEqual([rv.n, rv.mx], [1, 2]);
  r = await call(D, 'GET', '/api/meta-leads/list?q=' + encodeURIComponent('LP1') ); // 아무 검색
  r = await call(D, 'GET', '/api/meta-leads/list'); const row = r.json().items.find((x) => x.id === Number(T1.id));
  assert.equal(row.revealed_to, `Refacc El Puente ${T}`, 'ERP 목록에 「공개된 곳」');
  r = await call(C, 'GET', '/api/lead-portal/leads'); assert.equal(r.json().leads.find((l) => l.id === Number(T1.id)).revealed, true);

  // ── 0298 · 제품 찾기 · 찾는 부품 기록 ──
  await query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,$2)`, [P1.id, `SY-${T}-77`]);
  await query(`INSERT INTO product_oe_codes (product_id, oe_code, oe_norm) VALUES ($1,$2,$3)`, [P2.id, `54500-${T}A`, `54500${T}A`]);
  const srch = async (q) => (await call(C, 'GET', '/api/lead-portal/search?q=' + encodeURIComponent(q))).json().items;
  let it0 = await srch(P1.code.toLowerCase()); assert.equal(it0[0].code, P1.code, 'CTR 코드'); assert.equal(it0[0].exact, true);
  assert.equal(it0[0].avail, 7); assert.equal(it0[0].price, 550); assert.equal(it0[0].bought12, 6); assert.ok(it0[0].img.includes(P1.code));
  it0 = await srch(`sy ${T} 77`); assert.equal(it0[0].code, P1.code, 'SYD 코드(표기 흔들림)'); assert.equal(it0[0].via, 'syd'); assert.ok(it0[0].hit.startsWith('SYD'));
  it0 = await srch(`54500 ${T}a`); assert.equal(it0[0].code, P2.code, 'OE 번호'); assert.equal(it0[0].via, 'oe'); assert.equal(it0[0].incoming, 40);
  it0 = await srch(`amortiguador del ${T}`); assert.ok(it0.some((x) => x.code === P2.code), '품명');
  assert.deepEqual(await srch('x'), [], '두 글자 미만');
  assert.ok(!JSON.stringify(await srch(P1.code)).includes('cost'), '원가 없음');
  // 2026-10-28 · 연락처를 안 본 문의에도 기록 가능(모든 문의에 「Registrar piezas que busca」)
  r = await call(C, 'PUT', `/api/lead-portal/leads/${T2.id}/wants`, { items: [{ code: P1.code, qty: 1 }] }); assert.equal(r.statusCode, 200, r.body);
  await call(C, 'PUT', `/api/lead-portal/leads/${T2.id}/wants`, { items: [] });
  assert.equal((await call(C, 'PUT', `/api/lead-portal/leads/${T3.id}/wants`, { items: [] })).statusCode, 404, '제외 문의');
  assert.equal((await call(C, 'PUT', `/api/lead-portal/leads/${T1.id}/wants`, { items: [{ code: 'NADA' + T, qty: 1 }] })).statusCode, 400);
  r = await call(C, 'PUT', `/api/lead-portal/leads/${T1.id}/wants`, { items: [{ code: P2.code, qty: 2, input: `54500-${T}A` }, { code: P1.code, qty: 1 }, { code: P2.code, qty: 1 }] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().wants.map((x) => [x.code, x.qty]), [[P2.code, 3], [P1.code, 1]], '같은 코드 합침');
  assert.equal(r.json().products[P2.code].avail, 0);
  r = await call(C, 'GET', '/api/lead-portal/leads'); let lw = r.json().leads.find((l) => l.id === Number(T1.id));
  assert.deepEqual(lw.wants.map((x) => [x.code, x.qty, x.input]), [[P2.code, 3, `54500-${T}A`], [P1.code, 1, null]]);
  assert.ok(r.json().products[P2.code], '찾는 부품 정보도 같이');
  r = await call(D, 'GET', '/api/meta-leads/list'); assert.ok(r.json().items.find((x) => x.id === Number(T1.id)).revealed_to.includes(`${P2.code}×3`), 'ERP 목록에 찾는 부품');
  r = await call(D, 'GET', '/api/lead-portal-admin/reveals'); assert.ok(r.json().items.find((x) => x.thread_id === Number(T1.id)).wants.includes(`${P1.code}×1`));
  r = await call(C, 'PUT', `/api/lead-portal/leads/${T1.id}/wants`, { items: [{ code: P1.code, qty: 4 }] });
  assert.deepEqual(r.json().wants.map((x) => [x.code, x.qty]), [[P1.code, 4]], '목록 통째 교체(빠진 건 지움)');
  r = await call(C, 'PUT', `/api/lead-portal/leads/${T1.id}/wants`, { items: [] }); assert.deepEqual(r.json().wants, [], '전부 지우기');
  await call(C, 'PUT', `/api/lead-portal/leads/${T1.id}/wants`, { items: [{ code: P2.code, qty: 2 }] });

  // ── 매장 재고 ──
  r = await call(C, 'PUT', '/api/lead-portal/stock', { code: P1.code, qty: 3 }); assert.equal(r.statusCode, 200, r.body);
  assert.equal((await call(C, 'PUT', '/api/lead-portal/stock', { code: P1.code, qty: -1 })).statusCode, 400);
  r = await call(R1, 'GET', `/api/lead-portal-admin/shelf?customer_id=${cust.id}`); assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().items.map((x) => [x.code, x.qty, x.by.startsWith('고객'), x.bought12, x.avail]), [[P1.code, 3, true, 6, 7]]);
  assert.equal((await call(R2, 'GET', `/api/lead-portal-admin/shelf?customer_id=${cust.id}`)).statusCode, 403, '남의 고객');
  assert.equal((await call(R2, 'PUT', '/api/lead-portal-admin/shelf', { customer_id: cust.id, code: P1.code, qty: 1 })).statusCode, 403);
  r = await call(R1, 'PUT', '/api/lead-portal-admin/shelf', { customer_id: cust.id, code: P1.code, qty: 1 }); assert.equal(r.statusCode, 200, r.body);
  r = await call(D, 'PUT', '/api/lead-portal-admin/shelf', { customer_id: cust.id, code: P2.code, qty: 0 }); assert.equal(r.statusCode, 200);
  r = await call(C, 'GET', '/api/lead-portal/leads'); J = r.json();
  assert.deepEqual([J.products[P1.code].shelf, J.products[P1.code].shelf_src, J.products[P2.code].shelf], [1, 'staff', 0]);
  r = await call(R1, 'GET', `/api/lead-portal-admin/shelf/log?customer_id=${cust.id}&code=${P1.code}`);
  assert.deepEqual(r.json().items.map((x) => [x.old, x.new]), [[3, 1], [null, 3]]);
  r = await call(C, 'PUT', '/api/lead-portal/stock', { code: P2.code, qty: '' }); assert.equal(r.json().shelf, null, '빈 값 = 지움');

  // ── 주문 ──
  assert.equal((await call(C, 'POST', '/api/lead-portal/order', { key: 'k1' + T + 'xxxx', items: [{ code: 'NOPE' + T, qty: 1 }] })).statusCode, 400);
  assert.equal((await call(C, 'POST', '/api/lead-portal/order', { key: 'k2' + T + 'xxxx', items: [{ code: P3.code, qty: 1 }] })).statusCode, 409, '단종');
  assert.equal((await call(C, 'POST', '/api/lead-portal/order', { key: 'k3' + T + 'xxxx', items: [{ code: P1.code, qty: 0 }] })).statusCode, 400);
  const KEY = 'ord' + T + 'abcdef';
  const ord = { key: KEY, note: 'Entregar mañana', items: [{ code: P1.code, qty: 2, thread_id: T1.id }, { code: P2.code, qty: 2, thread_id: T2.id }, { code: P1.code, qty: 1, thread_id: T1.id }, { code: P1.code, qty: 1, thread_ids: [T3.id, T1.id] }] };
  r = await call(C, 'POST', '/api/lead-portal/order', ord); assert.equal(r.statusCode, 200, r.body);
  J = r.json(); assert.match(J.quote_no, /^FB-\d{4}-\d{4}$/, '포털 견적번호는 FB'); assert.equal(J.asesor, 'Oscar');
  const q = await one(`SELECT * FROM quotes WHERE quote_no=$1`, [J.quote_no]);
  assert.equal(q.origin, 'lead_portal'); assert.equal(q.status, 'draft'); assert.equal(Number(q.customer_id), Number(cust.id));
  assert.equal(Number(q.discount_rate), 45); assert.equal(Number(q.assigned_to), Number(rep.id)); assert.equal(Number(q.lead_portal_code_id), codeId);
  assert.ok(q.memo.includes('Portal oportunidades') && q.memo.includes('Entregar mañana'));
  assert.deepEqual(q.lead_thread_ids.map(Number).sort(), [Number(T1.id), Number(T2.id)].sort(), '제외 문의 번호는 버림');
  const lines = (await query(`SELECT ctr_code, qty, final_price, reserved_qty FROM quote_lines WHERE quote_id=$1 ORDER BY line_no`, [q.id])).rows;
  assert.deepEqual(lines.map((x) => [x.ctr_code, Number(x.qty), Number(x.final_price), Number(x.reserved_qty)]), [[P1.code, 4, 550, 4], [P2.code, 2, 1100, 0]], '같은 코드 합침(문의가 제외돼도 수량은 주문대로) · 가용만큼 예약');
  assert.equal(Number(q.total_mxn), Math.round((4 * 550 + 2 * 1100) * 1.16 * 100) / 100);
  const st = (await query(`SELECT id, status, derived_to FROM meta_threads WHERE id = ANY($1::bigint[]) ORDER BY id`, [[T1.id, T2.id, T3.id]])).rows;
  assert.deepEqual(st.map((x) => x.status), ['derivado', 'derivado', 'descartado']);
  r = await call(C, 'POST', '/api/lead-portal/order', ord); assert.equal(r.json().duplicate, true); assert.equal(r.json().quote_no, J.quote_no, '같은 키 = 같은 견적');
  assert.equal((await one(`SELECT count(*)::int n FROM quotes WHERE lead_portal_key=$1`, [KEY])).n, 1);
  // FB 번호는 연도별 일련번호 — 다음 주문은 +1, 화면 견적(Q-)과 따로 센다
  const yr = J.quote_no.slice(3, 7);
  const { withTx } = await import('../src/db.js');
  assert.equal(await withTx((c) => L.nextFbQuoteNo(c, yr)), L.formatFbQuoteNo(yr, Number(J.quote_no.slice(-4)) + 1));
  r = await call(C, 'GET', '/api/lead-portal/leads'); assert.equal(r.json().products[P1.code].avail, 3, '내 주문 예약 4 반영');
  r = await call(D, 'GET', '/api/lead-portal-admin/codes'); let it = r.json().items.find((x) => x.id === codeId);
  assert.deepEqual([it.reveals, it.orders, it.orders_total], [1, 1, Number(q.total_mxn)]);

  // ── 범위(주) ──
  r = await call(D, 'PATCH', `/api/lead-portal-admin/codes/${codeId}`, { scope_states: ['Tamaulipas', 'Narnia'] }); assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().item.scope_states, ['Tamaulipas'], '없는 주는 버림');
  r = await call(C, 'GET', '/api/lead-portal/leads'); assert.deepEqual(r.json().leads.map((l) => l.id).filter((id) => [T1.id, T2.id].map(Number).includes(id)), [Number(T2.id)]);
  assert.equal((await call(C, 'POST', `/api/lead-portal/leads/${T1.id}/contact`)).statusCode, 404, '범위 밖 연락처');
  await call(D, 'PATCH', `/api/lead-portal-admin/codes/${codeId}`, { scope_states: [] });

  // ── 0299 · 문의 메모(작성자만) · 디렉터 전용 코드 ──
  const cust2 = await one(`INSERT INTO customers (name, code, discount, owner_id, created_by, doc_gate) VALUES ($1,$2,30,$3,$4,false) RETURNING id`, [`Refacc Otra ${T}`, `LQ${T}`, rep2.id, dir.id]);
  r = await call(D, 'POST', '/api/lead-portal-admin/codes', { customer_id: cust2.id, expires_on: '2099-12-31' }); const CODE_B = r.json().code;
  const CB = { authorization: 'Bearer ' + (await call({}, 'POST', '/api/lead-portal/login', { code: CODE_B }, IP)).json().token };
  assert.equal((await call(C, 'POST', `/api/lead-portal/leads/${T2.id}/notes`, { body: '   ' })).statusCode, 400, '빈 메모');
  assert.equal((await call(C, 'POST', `/api/lead-portal/leads/${T2.id}/notes`, { body: 'x'.repeat(1001) })).statusCode, 400, '1000자 초과');
  assert.equal((await call(C, 'POST', `/api/lead-portal/leads/${T3.id}/notes`, { body: 'hola' })).statusCode, 404, '제외 문의');
  r = await call(C, 'POST', `/api/lead-portal/leads/${T2.id}/notes`, { body: 'Le llamé, quiere cotización mañana' }); assert.equal(r.statusCode, 200, r.body);
  const nA = r.json().note; assert.equal(nA.mine, true); assert.equal(nA.author, undefined, '고객 화면엔 작성자 이름 안 보냄');
  r = await call(CB, 'POST', `/api/lead-portal/leads/${T2.id}/notes`, { body: 'Nota de otra refaccionaria' }); const nB = r.json().note;
  let la = (await call(C, 'GET', '/api/lead-portal/leads')).json().leads.find((l) => l.id === Number(T2.id));
  assert.deepEqual(la.notes.map((x) => x.body), ['Le llamé, quiere cotización mañana'], 'A 는 자기 메모만');
  let lb = (await call(CB, 'GET', '/api/lead-portal/leads')).json().leads.find((l) => l.id === Number(T2.id));
  assert.deepEqual(lb.notes.map((x) => x.body), ['Nota de otra refaccionaria'], 'B 도 자기 메모만');
  assert.equal((await call(CB, 'DELETE', `/api/lead-portal/notes/${nA.id}`)).statusCode, 404, '남의 메모는 못 지움');
  assert.equal((await call(C, 'DELETE', `/api/lead-portal/notes/${nA.id}`)).statusCode, 200);
  la = (await call(C, 'GET', '/api/lead-portal/leads')).json().leads.find((l) => l.id === Number(T2.id)); assert.deepEqual(la.notes, []);
  r = await call(D, 'GET', `/api/lead-portal-admin/notes?thread_id=${T2.id}`); assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().items.map((x) => [x.author, x.body, !!x.deleted_at]).sort(), [[`Refacc El Puente ${T}`, 'Le llamé, quiere cotización mañana', true], [`Refacc Otra ${T}`, 'Nota de otra refaccionaria', false]].sort(), '디렉터는 지운 것까지 전부 · 누가');
  assert.equal((await call(R1, 'GET', '/api/lead-portal-admin/notes')).statusCode, 403, '디렉터만');
  // 디렉터 전용 코드
  assert.equal((await call(R1, 'POST', '/api/lead-portal-admin/codes', { kind: 'director', expires_on: '2099-12-31' })).statusCode, 403);
  r = await call(D, 'POST', '/api/lead-portal-admin/codes', { kind: 'director', expires_on: '2099-12-31', memo: 'Sebastian' }); assert.equal(r.statusCode, 200, r.body);
  const DCODE = r.json().code; const dId = r.json().item.id;
  assert.equal(r.json().item.kind, 'director'); assert.equal(r.json().item.customer_id, null); assert.ok(r.json().invite.includes(DCODE));
  r = await call({}, 'POST', '/api/lead-portal/login', { code: DCODE }, IP); assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().me.role, 'director'); assert.equal(r.json().me.customer_name, 'Dirección Refatrix');
  const CD = { authorization: 'Bearer ' + r.json().token };
  for (const u of ['/api/meta-leads/status', '/api/lead-portal-admin/codes']) assert.equal((await call(CD, 'GET', u)).statusCode, 401, '디렉터 코드도 ERP API 401');
  r = await call(CD, 'GET', '/api/lead-portal/leads'); assert.equal(r.statusCode, 200, r.body);
  const ld = r.json().leads.find((l) => l.id === Number(T2.id));
  assert.deepEqual(ld.notes.map((x) => [x.author, x.body]), [[`Refacc Otra ${T}`, 'Nota de otra refaccionaria']], '디렉터 코드는 모든 메모 · 작성자');
  assert.equal(r.json().products[P2.code].price, 2000, '정가(할인 없음)');
  r = await call(CD, 'POST', `/api/lead-portal/leads/${T2.id}/contact`); assert.equal(r.statusCode, 200);
  assert.equal((await one(`SELECT count(*)::int n FROM lead_portal_reveals WHERE code_id=$1`, [dId])).n, 0, '디렉터 열람은 공개 기록에 안 섞음');
  for (const [m, u, b] of [['PUT', '/api/lead-portal/stock', { code: P1.code, qty: 1 }], ['PUT', `/api/lead-portal/leads/${T2.id}/wants`, { items: [] }], ['POST', '/api/lead-portal/order', { key: 'dir' + T + 'xxxxx', items: [{ code: P1.code, qty: 1 }] }]]) {
    r = await call(CD, m, u, b); assert.equal(r.statusCode, 403, u); assert.equal(r.json().error, 'director_view');
  }
  r = await call(CD, 'POST', `/api/lead-portal/leads/${T2.id}/notes`, { body: 'Revisar con Oscar' }); const nD = r.json().note;
  assert.equal(nD.author, 'Dirección Refatrix'); assert.equal(nD.mine, true);
  lb = (await call(CB, 'GET', '/api/lead-portal/leads')).json().leads.find((l) => l.id === Number(T2.id));
  assert.ok(!lb.notes.some((x) => x.body === 'Revisar con Oscar'), '디렉터 메모는 고객에게 안 보임');
  assert.equal((await call(CD, 'DELETE', `/api/lead-portal/notes/${nB.id}`)).statusCode, 404, '디렉터 코드로 고객 메모 삭제 불가');
  assert.equal((await call(CD, 'DELETE', `/api/lead-portal/notes/${nD.id}`)).statusCode, 200);
  r = await call(D, 'GET', '/api/lead-portal-admin/codes'); const dRow = r.json().items.find((x) => x.id === dId);
  assert.deepEqual([dRow.kind, dRow.customer_name, dRow.customer_id], ['director', 'Dirección Refatrix', null]);
  r = await call(D, 'POST', `/api/lead-portal-admin/codes/${dId}/reissue`); assert.ok(r.json().invite.includes('dirección'));
  await call(D, 'DELETE', `/api/lead-portal-admin/codes/${dId}`);

  // ── 0300 · Facebook(Messenger) 대화 ──
  const M = await import('../src/metaLeads.js'); const MP = await import('../src/metaPageMsgs.js');
  M.setMetaFetch(async (url) => ({ ok: true, status: 200, json: { id: '1', name: 'CTR', access_token: 'PAGE_TOKEN' } }));
  const sent = []; let failNext = null;
  MP.setMessengerPost(async (url, body) => { sent.push({ url, body }); if (failNext) { const e = failNext; failNext = null; return { ok: false, status: 400, json: { error: e } }; } return { ok: true, status: 200, json: { recipient_id: body.recipient.id, message_id: 'm_out_' + T + '_' + sent.length } }; });
  t.after(() => { M.setMetaFetch(null); MP.setMessengerPost(null); });
  const PS4 = 'ps4' + T, PS5 = 'ps5' + T;
  await query(`UPDATE lead_portal_settings SET claim_days=3 WHERE id=1`);   // 앞선 실행이 바꿔 둔 값 초기화
  const orig = [{ at: new Date(Date.now() - 7200e3).toISOString(), me: false, text: 'Hola, busco amortiguadores para Aveo' }];
  const T4 = await one(`INSERT INTO meta_threads (platform, thread_id, user_id, name, first_at, last_at, last_in_at, in_count, msg_count, messages, ai_state, ai_vehicles, ai_summary, status)
                        VALUES ('messenger',$1,$2,'Mario',now() - interval '2 hours',now() - interval '1 hour',now() - interval '1 hour',1,1,$3::jsonb,'Nuevo León','Chevrolet Aveo 2018','Amortiguadores','nuevo') RETURNING id`, ['t_' + PS4, PS4, JSON.stringify(orig)]);
  const T5 = await one(`INSERT INTO meta_threads (platform, thread_id, user_id, name, first_at, last_at, last_in_at, in_count, msg_count, ai_state, status)
                        VALUES ('messenger',$1,$2,'Luis',now() - interval '5 days',now() - interval '3 days',now() - interval '3 days',1,1,'Nuevo León','nuevo') RETURNING id`, ['t_' + PS5, PS5]);
  // 예전 직원 대화(웹훅) — 2026-10-28 디렉터: 포털 대화창에 「실제로 이루어진 대화」 전체를 보여 준다
  await query(`INSERT INTO meta_page_messages (psid, mid, direction, source, text, at) VALUES ($1,$2,'out','staff','Hola, soy de Refatrix',now() - interval '110 minutes')`, [PS4, 'm_pre_' + T]);
  const hook = (body) => { const raw = JSON.stringify(body); return app.inject({ method: 'POST', url: '/api/wa/webhook', payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', WSECRET).update(raw).digest('hex') } }); };
  const PAGE = '1338649012669713';
  assert.equal((await call(C, 'GET', `/api/lead-portal/leads/${T1.id}/chat`)).json().error, 'chat_not_allowed', 'WhatsApp 문의는 대화 없음');
  assert.equal((await call(C, 'POST', `/api/lead-portal/leads/${T1.id}/claim`)).json().error, 'chat_not_allowed', '예전 「Atender」 호환 — WhatsApp 은 대화 없음');
  r = await call(C, 'GET', '/api/lead-portal/leads'); let L4 = r.json().leads.find((l) => l.id === Number(T4.id)); let L5 = r.json().leads.find((l) => l.id === Number(T5.id));
  assert.deepEqual([L4.chat.open, L4.claim, L5.chat.open, r.json().me.claim_days], [true, null, false, 3]);
  assert.equal(r.json().leads.find((l) => l.id === Number(T1.id)).chat, null);
  assert.ok(!r.body.includes(PS4), 'PSID 안 보냄');
  assert.equal((await call(C, 'GET', `/api/lead-portal/leads/${T4.id}/chat`)).json().error, 'need_contact', '연락처를 봐야 대화');
  assert.equal((await call(C, 'POST', `/api/lead-portal/leads/${T4.id}/chat`, { text: 'hola' })).json().error, 'need_contact');

  // ── 0305 · 선점 = 「Ver contacto」 + 연락 내용 기록(모든 채널) ──
  r = await call(C, 'POST', `/api/lead-portal/leads/${T1.id}/notes`, { body: 'Le llamé, quiere 1 horquilla, pasa mañana' }); assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().claim.state, 'mine'); assert.equal(r.json().claim.created, true);
  assert.ok(Math.abs(new Date(r.json().claim.until).getTime() - (Date.now() + 3 * 86400000)) < 120000, '기본 3일');
  r = await call(CB, 'GET', '/api/lead-portal/leads'); let b1 = r.json().leads.find((l) => l.id === Number(T1.id));
  assert.deepEqual([b1.claim.state, b1.name_masked, b1.phone_masked, b1.has_phone], ['other', null, null, false], '다른 곳: 가린 연락처도 안 보냄');
  r = await call(CB, 'POST', `/api/lead-portal/leads/${T1.id}/contact`); assert.equal(r.statusCode, 409); assert.equal(r.json().error, 'claimed_other');
  assert.equal((await call(CB, 'PUT', `/api/lead-portal/leads/${T1.id}/wants`, { items: [{ code: P1.code, qty: 1 }] })).json().error, 'claimed_other');
  r = await call(CB, 'POST', `/api/lead-portal/leads/${T1.id}/notes`, { body: 'nota B' }); assert.equal(r.statusCode, 200); assert.equal(r.json().claim.state, 'need_contact', 'B 메모는 저장되지만 선점 아님');
  r = await call(C, 'POST', `/api/lead-portal/leads/${T1.id}/notes`, { body: 'Segunda llamada' }); assert.equal(r.json().claim.state, 'mine'); assert.equal(r.json().claim.created, false, '메모 더 쓰면 연장');
  r = await call(C, 'POST', `/api/lead-portal/leads/${T2.id}/notes`, { body: 'Sin contacto aún' }); assert.equal(r.json().claim.state, 'need_contact', '연락처 안 본 메모 = 선점 아님');
  r = await call(C, 'GET', '/api/lead-portal/leads'); assert.equal(r.json().leads.find((l) => l.id === Number(T1.id)).claim.state, 'mine');

  // Messenger: 연락처 보기 → 대화 전체 → 첫 메시지 = 선점
  assert.equal((await call(C, 'POST', `/api/lead-portal/leads/${T4.id}/contact`)).statusCode, 200);
  { // 1028b · 예전 페이지(「Atender」) 호환: 대화창만 열어 주고 선점은 만들지 않는다 — 첫 메시지 때 선점
    const rc = await call(C, 'POST', `/api/lead-portal/leads/${T4.id}/claim`); assert.equal(rc.statusCode, 200, rc.body);
    assert.equal(rc.json().compat, true); assert.equal(rc.json().claim_until, null);
    assert.equal((await query(`SELECT count(*)::int AS n FROM lead_portal_claims WHERE thread_id=$1 AND released_at IS NULL`, [T4.id])).rows[0].n, 0, '버튼만으로 선점 안 됨');
  }
  r = await call(C, 'GET', `/api/lead-portal/leads/${T4.id}/chat`); assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().messages.map((m) => [m.who, m.text]), [['cliente', 'Hola, busco amortiguadores para Aveo'], ['refatrix', 'Hola, soy de Refatrix']], '선점 전에도 실제 대화 전체');
  assert.equal(r.json().claimed, false); assert.equal(r.json().summary, 'Amortiguadores');
  r = await call(C, 'POST', `/api/lead-portal/leads/${T4.id}/chat`, { text: 'Sí, $1,350 c/u' }); assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().claim.state, 'mine'); assert.equal(r.json().claim.created, true, '첫 메시지로 선점');
  assert.equal(sent.at(-1).body.recipient.id, PS4); assert.equal(sent.at(-1).body.messaging_type, 'RESPONSE');
  assert.equal(sent.at(-1).body.message.text, `[Refacc El Puente ${T}] Sí, $1,350 c/u`, '앞에 [가게 이름]');
  assert.equal((await one(`SELECT status FROM meta_threads WHERE id=$1`, [T4.id])).status, 'derivado');
  const outMid = 'm_out_' + T + '_' + sent.length;
  await new Promise((res) => setTimeout(res, 20));
  await hook({ object: 'page', entry: [{ id: PAGE, messaging: [
    { sender: { id: PAGE }, recipient: { id: PS4 }, timestamp: Date.now(), message: { mid: outMid, is_echo: true, text: `[Refacc El Puente ${T}] Sí, $1,350 c/u` } },
    { sender: { id: PS4 }, recipient: { id: PAGE }, timestamp: Date.now() + 5, message: { mid: 'm_in1_' + T, text: '¿Dónde están?' } },
    { sender: { id: PAGE }, recipient: { id: PS4 }, timestamp: Date.now() + 10, message: { mid: 'm_staff_' + T, is_echo: true, text: 'Gracias, le atiende la refaccionaria' } }] }] });
  r = await call(C, 'GET', `/api/lead-portal/leads/${T4.id}/chat`); assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().messages.map((m) => [m.who, m.text]), [['cliente', 'Hola, busco amortiguadores para Aveo'], ['refatrix', 'Hola, soy de Refatrix'], ['yo', `[Refacc El Puente ${T}] Sí, $1,350 c/u`], ['cliente', '¿Dónde están?'], ['refatrix', 'Gracias, le atiende la refaccionaria']], '대화 전체 · 에코 중복 없음');
  assert.equal(r.json().claimed, true); assert.equal(r.json().can_send, true);
  assert.equal((await call(CB, 'GET', `/api/lead-portal/leads/${T4.id}/chat`)).json().error, 'claimed_other');
  assert.equal((await call(CB, 'POST', `/api/lead-portal/leads/${T4.id}/contact`)).json().error, 'claimed_other');
  // ERP 한 건 열기 — 웹훅 메시지 합침
  r = await call(D, 'GET', `/api/meta-leads/${T4.id}`); assert.equal(r.statusCode, 200, r.body);
  const em = r.json().messages;
  const pm = em.find((m) => m.src === 'portal'); assert.ok(pm && pm.me && pm.shop === `Refacc El Puente ${T}` && pm.text.endsWith('Sí, $1,350 c/u'));
  assert.ok(em.some((m) => m.src === 'staff' && m.text === 'Gracias, le atiende la refaccionaria'));
  assert.ok(em.some((m) => !m.me && m.text === '¿Dónde están?'));
  assert.equal(em.filter((m) => m.src === 'portal').length, 1, '에코 중복 없음');
  assert.ok(!('psid' in r.json()), 'psid 응답에 없음');
  assert.deepEqual(L.mergeConversation([{ at: '2026-10-26T20:00:00Z', me: true, text: 'Hola  a' }], [{ direction: 'out', source: 'portal', text: 'Hola a', at: '2026-10-26T20:01:00Z', shop: 'X' }, { direction: 'in', source: 'customer', text: 'ok', at: '2026-10-26T19:00:00Z' }]).map((m) => [m.text, m.src || null, !!m.live]),
    [['ok', null, true], ['Hola  a', 'portal', false]], '같은 메시지는 하나(그래프 쪽에 표시) · 시간순');
  assert.equal((await call(C, 'POST', `/api/lead-portal/leads/${T4.id}/chat`, { text: 'x'.repeat(1001) })).statusCode, 400);
  failNext = { code: 100, message: 'Invalid parameter' };
  r = await call(C, 'POST', `/api/lead-portal/leads/${T4.id}/chat`, { text: 'hola' }); assert.equal(r.statusCode, 502); assert.equal(r.json().error, 'send_failed');
  assert.equal((await one(`SELECT count(*)::int n FROM lead_portal_claims WHERE thread_id=$1 AND released_at IS NULL`, [T4.id])).n, 1, '실패해도 기존 선점 유지');
  // 24시간 지난 문의 → 손님이 다시 쓰면 열림 · 첫 전송 실패 시 방금 만든 선점은 되돌림
  await call(C, 'POST', `/api/lead-portal/leads/${T5.id}/contact`);
  const nSent = sent.length;
  r = await call(C, 'POST', `/api/lead-portal/leads/${T5.id}/chat`, { text: 'hola' }); assert.equal(r.statusCode, 409); assert.equal(r.json().error, 'window_closed'); assert.equal(sent.length, nSent, 'Meta 에 보내지 않음');
  assert.equal((await one(`SELECT count(*)::int n FROM lead_portal_claims WHERE thread_id=$1`, [T5.id])).n, 0, '창 닫힘 = 선점 없음');
  await hook({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: PS5 }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: 'm_in5_' + T, text: 'Hola de nuevo' } }] }] });
  failNext = { code: 100, message: 'Invalid parameter' };
  assert.equal((await call(C, 'POST', `/api/lead-portal/leads/${T5.id}/chat`, { text: 'Buenas' })).statusCode, 502);
  assert.equal((await one(`SELECT count(*)::int n FROM lead_portal_claims WHERE thread_id=$1`, [T5.id])).n, 0, '첫 전송 실패 → 선점 되돌림');
  assert.equal((await call(C, 'POST', `/api/lead-portal/leads/${T5.id}/chat`, { text: 'Buenas' })).statusCode, 200, '창 다시 열림');
  // 디렉터 코드 — 대화 전체 · 보내기 불가 · 선점 무관
  r = await call(D, 'POST', '/api/lead-portal-admin/codes', { kind: 'director', expires_on: '2099-12-31' });
  const CD2 = { authorization: 'Bearer ' + (await call({}, 'POST', '/api/lead-portal/login', { code: r.json().code }, IP)).json().token };
  r = await call(CD2, 'GET', `/api/lead-portal/leads/${T4.id}/chat`); assert.equal(r.json().messages[0].text, 'Hola, busco amortiguadores para Aveo'); assert.equal(r.json().can_send, false);
  assert.equal(r.json().messages.find((m) => m.who === 'portal').shop, `Refacc El Puente ${T}`);
  assert.equal((await call(CD2, 'POST', `/api/lead-portal/leads/${T4.id}/chat`, { text: 'x' })).statusCode, 403);
  r = await call(CD2, 'GET', '/api/lead-portal/leads'); const d1 = r.json().leads.find((l) => l.id === Number(T1.id));
  assert.equal(d1.claim.state, 'other'); assert.ok(d1.phone_masked, '디렉터는 선점돼도 가린 연락처 그대로');
  assert.equal((await call(CD2, 'POST', `/api/lead-portal/leads/${T1.id}/contact`)).statusCode, 200, '디렉터는 선점 무관');
  // ERP — 목록 · 설정 · 선점 관리
  r = await call(D, 'GET', '/api/meta-leads/list');
  assert.ok(r.json().items.find((x) => x.id === Number(T4.id)).chat_by.startsWith(`Refacc El Puente ${T} 선점 · Messenger 보냄 1`));
  assert.ok(r.json().items.find((x) => x.id === Number(T1.id)).chat_by.startsWith(`Refacc El Puente ${T} 선점 · ~`), 'WhatsApp 선점도 목록에');
  assert.equal((await call(R1, 'PUT', '/api/lead-portal-admin/settings', { claim_days: 5 })).statusCode, 403);
  assert.equal((await call(D, 'PUT', '/api/lead-portal-admin/settings', { claim_days: 0 })).statusCode, 400);
  assert.equal((await call(D, 'PUT', '/api/lead-portal-admin/settings', { claim_days: 5 })).json().claim_days, 5);
  r = await call(D, 'GET', '/api/lead-portal-admin/claims'); const cl4 = r.json().items.find((x) => x.thread_id === Number(T4.id)); const cl1 = r.json().items.find((x) => x.thread_id === Number(T1.id));
  assert.deepEqual([cl4.active, cl4.via, cl4.platform, cl4.sent, cl4.received, cl1.via, cl1.platform, r.json().claim_days], [true, 'messenger', 'messenger', 1, 1, 'note', 'whatsapp', 5]);
  assert.equal((await call(D, 'POST', `/api/lead-portal-admin/claims/${cl4.id}/extend`, { days: 2 })).statusCode, 200);
  assert.equal((await call(D, 'POST', `/api/lead-portal-admin/claims/${cl4.id}/release`)).statusCode, 200);
  // 해제 뒤 B 가 연락처 → 메시지로 선점(바뀐 기본 5일) · B 대화창에 C 메시지는 「다른 refaccionaria」
  assert.equal((await call(CB, 'POST', `/api/lead-portal/leads/${T4.id}/contact`)).statusCode, 200);
  r = await call(CB, 'POST', `/api/lead-portal/leads/${T4.id}/chat`, { text: 'Hola, soy Otra' }); assert.equal(r.statusCode, 200, r.body);
  assert.ok(Math.abs(new Date(r.json().claim.until).getTime() - (Date.now() + 5 * 86400000)) < 120000, '바뀐 기본 5일');
  r = await call(CB, 'GET', `/api/lead-portal/leads/${T4.id}/chat`); const bw = r.json().messages.map((m) => m.who);
  assert.ok(bw.includes('otro') && bw.includes('yo') && !JSON.stringify(r.json()).includes('Refacc El Puente'), '다른 가게 이름은 안 보임');
  assert.equal((await call(C, 'GET', `/api/lead-portal/leads/${T4.id}/chat`)).json().error, 'claimed_other');
  await call(D, 'PUT', '/api/lead-portal-admin/settings', { claim_days: 3 });

  // ── 정지 · 재개 · 만료 ──
  await call(D, 'PATCH', `/api/lead-portal-admin/codes/${codeId}`, { active: false });
  r = await call(C, 'GET', '/api/lead-portal/leads'); assert.equal(r.statusCode, 403); assert.equal(r.json().error, 'paused');
  assert.equal((await call({}, 'POST', '/api/lead-portal/login', { code: CODE }, IP)).json().error, 'paused');
  await call(D, 'PATCH', `/api/lead-portal-admin/codes/${codeId}`, { active: true });
  assert.equal((await call(C, 'GET', '/api/lead-portal/leads')).statusCode, 200);
  r = await call(D, 'PATCH', `/api/lead-portal-admin/codes/${codeId}`, { expires_on: '2020-01-01' }); assert.equal(r.json().item.state, 'expired');
  r = await call(C, 'GET', '/api/lead-portal/me'); assert.equal(r.statusCode, 403); assert.equal(r.json().error, 'expired'); assert.equal(r.json().expires_on, '2020-01-01');
  await call(D, 'PATCH', `/api/lead-portal-admin/codes/${codeId}`, { expires_on: '2099-12-31' });
  r = await call(D, 'GET', `/api/lead-portal-admin/codes/${codeId}/log`);
  assert.deepEqual(r.json().items.map((x) => x.action).reverse(), ['issue', 'update', 'update', 'pause', 'resume', 'update', 'update']);

  // ── 재발급 · 삭제 ──
  r = await call(D, 'POST', `/api/lead-portal-admin/codes/${codeId}/reissue`); assert.equal(r.statusCode, 200);
  const CODE2 = r.json().code; assert.notEqual(CODE2, CODE);
  assert.equal((await call(C, 'GET', '/api/lead-portal/leads')).statusCode, 401, '옛 토큰 무효');
  assert.equal((await call({}, 'POST', '/api/lead-portal/login', { code: CODE }, IP)).statusCode, 401, '옛 코드 무효');
  r = await call({}, 'POST', '/api/lead-portal/login', { code: CODE2 }, IP); assert.equal(r.statusCode, 200);
  const C2 = { authorization: 'Bearer ' + r.json().token };
  r = await call(C2, 'GET', '/api/lead-portal/me'); assert.ok(r.json().token, '열 때마다 새 토큰');
  assert.equal((await call(D, 'DELETE', `/api/lead-portal-admin/codes/${codeId}`)).statusCode, 200);
  assert.equal((await call(C2, 'GET', '/api/lead-portal/leads')).statusCode, 401);
  assert.equal((await call({}, 'POST', '/api/lead-portal/login', { code: CODE2 }, IP)).statusCode, 401);
  r = await call(D, 'GET', '/api/lead-portal-admin/codes'); assert.ok(!r.json().items.some((x) => x.id === codeId));
  // 고객 찾기 — 영업은 자기 고객만
  r = await call(R2, 'GET', '/api/lead-portal-admin/customers?q=' + encodeURIComponent('El Puente ' + T)); assert.equal(r.json().items.length, 0);
  r = await call(R1, 'GET', '/api/lead-portal-admin/customers?q=' + encodeURIComponent('El Puente ' + T)); assert.equal(r.json().items.length, 1);
});

// ── C. 화면 ─────────────────────────────────────────────────────────
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const ADMIN_JS = path.join(ROOT, 'refatrix-leadportal-admin.js');
const META_HTML = path.join(ROOT, 'refatrix-metaleads.html');
const PF_HTML = path.join(ROOT, 'Netlify', 'leads.html');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function fakeFetch(routes, log) {
  return async (url, o = {}) => {
    const u = String(url); const m = (o.method || 'GET').toUpperCase();
    log.push([m, u, o.body ? JSON.parse(o.body) : null, (o.headers || {}).Authorization || (o.headers || {}).authorization || null]);
    for (const [re, fn] of routes) {
      if (re.test(m + ' ' + u)) { const [status, body] = await fn(u, o.body ? JSON.parse(o.body) : null); return { ok: status < 400, status, json: async () => body }; }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'http_404' }) };
  };
}

test('C1. ERP 「🔑 고객 접속코드」 탭 — 발급 · 안내문 · 목록 · 기한 변경 · 매장 재고', { skip: (!JSDOM || !existsSync(ADMIN_JS) || !existsSync(META_HTML)) && 'jsdom 또는 파일 없음' }, async () => {
  const html = readFileSync(META_HTML, 'utf8');
  assert.ok(html.includes('data-p="lp"') && html.includes('refatrix-leadportal-admin.js'), 'metaleads 에 탭 · 스크립트');
  const page = `<!doctype html><body>
    <div class="tabs" id="tabs"><button class="tab" data-p="lp">t</button></div>
    ${html.slice(html.indexOf('<!-- 0297 · 고객 접속코드 -->'), html.indexOf('<!-- /0297 -->'))}
    <script>let session={token:'T',user:{role:'director'},api:''};const $=(id)=>document.getElementById(id);
      const esc=(s)=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      async function api(method,path,body){const o={method,headers:{'Authorization':'Bearer '+session.token}};if(body!==undefined){o.headers['Content-Type']='application/json';o.body=JSON.stringify(body);}
        const r=await fetch(session.api+path,o);const d=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(d.error||('http_'+r.status));e.data=d;throw e;}return d;}</script>
    <script>${readFileSync(ADMIN_JS, 'utf8')}</script></body>`;
  const log = [];
  const codes = [{ id: 5, customer_id: 9, customer_code: 'C-0052', customer_name: 'El Puente', last4: 'Q9PD', expires_on: '2026-11-26', days_left: 31, basis_amount: 50000, memo: '10월', scope_states: null, active: true, state: 'active', last_seen_at: null, created_on: '2026-10-26', reveals: 2, orders: 1, orders_total: 2366.4 }];
  const routes = [
    [/GET \/api\/lead-portal-admin\/status/, () => [200, { ready: true, director: true, states: ['Nuevo León', 'Tamaulipas'], url: 'https://x/leads', today: '2026-10-26' }]],
    [/GET \/api\/lead-portal-admin\/codes$/, () => [200, { today: '2026-10-26', items: codes }]],
    [/GET \/api\/lead-portal-admin\/reveals/, () => [200, { items: [{ first_mx: '2026-10-26 08:14', customer_name: 'El Puente', code_last4: 'Q9PD', thread_id: 1842, platform: 'whatsapp', status: 'nuevo', vehicles: 'Versa 2017', parts: 'Horquilla', n: 1, wants: 'CS1188×2' }] }]],
    [/GET \/api\/lead-portal-admin\/customers/, () => [200, { items: [{ id: 9, code: 'C-0052', name: 'El Puente', discount: 45 }] }]],
    [/GET \/api\/lead-portal-admin\/customer-ref\/9/, () => [200, { d30: 18420, d90: 61950, d365: 214300, last_date: '2026-10-21', last_amount: 12880, codes: 0 }]],
    [/POST \/api\/lead-portal-admin\/codes$/, (_, b) => [200, { ok: true, code: 'RFX-7K2M-Q9PD', invite: 'Hola El Puente RFX-7K2M-Q9PD', item: { ...codes[0], expires_on: b.expires_on } }]],
    [/PATCH \/api\/lead-portal-admin\/codes\/5/, (_, b) => [200, { ok: true, item: { ...codes[0], ...b } }]],
    [/GET \/api\/lead-portal-admin\/shelf\?/, () => [200, { items: [{ code: 'CQ0271L', name: 'Horquilla', qty: 3, by: '고객 (…Q9PD)', at: '2026-10-20 15:02', bought12: 6, avail: 24 }] }]],
    [/PUT \/api\/lead-portal-admin\/shelf/, (_, b) => [200, { ok: true, code: b.code, qty: b.qty }]],
    [/GET \/api\/lead-portal-admin\/claims/, () => [200, { claim_days: 3, items: [{ id: 4, thread_id: 1839, customer_name: 'El Puente', code_last4: 'Q9PD', claimed_mx: '2026-10-26 14:01', expires_mx: '2026-10-29 14:06', released_mx: null, active: true, vehicles: 'Aveo 2018', lead_name: 'Mario', sent: 2, received: 1, last_mx: '2026-10-26 14:06' }] }]],
    [/POST \/api\/lead-portal-admin\/claims\/4\/release/, () => [200, { ok: true }]],
    [/PUT \/api\/lead-portal-admin\/settings/, (_, b) => [200, { ok: true, claim_days: b.claim_days }]],
    [/GET \/api\/lead-portal-admin\/notes/, () => [200, { items: [{ id: 1, thread_id: 1842, body: 'Le llamé', author: 'El Puente', code_last4: 'Q9PD', at: '2026-10-26 14:00', deleted_at: '2026-10-26 14:05', platform: 'messenger', vehicles: 'Versa' }] }]],
  ];
  const dom = new JSDOM(page, { runScripts: 'dangerously', beforeParse(w) { w.fetch = fakeFetch(routes, log); w.prompt = () => '2026-12-31'; w.confirm = () => true; w.navigator.clipboard = { writeText: async () => {} }; } });
  const w = dom.window, d = w.document;
  d.querySelector('[data-p="lp"]').click(); await tick(80);
  assert.ok(d.getElementById('lpCodes').textContent.includes('El Puente'), '목록');
  assert.ok(d.getElementById('lpCodes').textContent.includes('…Q9PD'));
  assert.ok(d.getElementById('lpReveals').textContent.includes('Versa 2017') && d.getElementById('lpReveals').textContent.includes('CS1188×2'));
  // 발급
  d.getElementById('lpCustQ').value = 'Puente'; d.getElementById('lpCustQ').dispatchEvent(new w.Event('input')); await tick(400);
  d.querySelector('#lpCustList [data-cid="9"]').click(); await tick(60);
  assert.ok(d.getElementById('lpRef').textContent.includes('214,300'), 'ERP 매출 참고');
  d.getElementById('lpExp').value = '2026-11-26'; d.getElementById('lpAmt').value = '50,000'; d.getElementById('lpMemo').value = '10월 주문';
  d.getElementById('lpIssue').click(); await tick(60);
  const post = log.find((x) => x[0] === 'POST' && x[1].endsWith('/codes'));
  assert.deepEqual([post[2].customer_id, post[2].expires_on, post[2].basis_amount, post[2].memo], [9, '2026-11-26', '50,000', '10월 주문']);
  assert.ok(d.getElementById('lpIssued').textContent.includes('RFX-7K2M-Q9PD'), '코드 한 번 보여 줌');
  assert.ok(d.getElementById('lpNotes').textContent.includes('Le llamé') && d.getElementById('lpNotes').textContent.includes('삭제됨'), '메모 전부(삭제 포함)');
  assert.ok(d.getElementById('lpClaims').textContent.includes('대화 중') && d.getElementById('lpClaims').textContent.includes('Aveo 2018'));
  assert.equal(d.getElementById('lpClaimDays').value, '3');
  d.getElementById('lpClaimDays').value = '5'; d.getElementById('lpClaimSave').click(); await tick(60);
  assert.deepEqual(log.find((x) => x[0] === 'PUT' && x[1].includes('/settings'))[2], { claim_days: 5 });
  d.querySelector('[data-crel="4"]').click(); await tick(60);
  assert.ok(log.some((x) => x[0] === 'POST' && x[1].endsWith('/claims/4/release')));
  // 기한 변경(prompt)
  d.querySelector('#lpCodes [data-act="ext"][data-id="5"]').click(); await tick(60);
  assert.deepEqual(log.find((x) => x[0] === 'PATCH')[2], { expires_on: '2026-12-31' });
  // 디렉터 전용 코드(prompt → 2026-12-31)
  d.getElementById('lpDirIssue').click(); await tick(60);
  assert.equal(log.filter((x) => x[0] === 'POST' && x[1].endsWith('/codes')).pop()[2].kind, 'director');
  // 매장 재고
  d.querySelector('#lpCodes [data-act="shelf"][data-id="5"]').click(); await tick(60);
  assert.ok(d.getElementById('lpShelf').textContent.includes('CQ0271L'));
  const inp = d.querySelector('#lpShelf input[data-code="CQ0271L"]'); inp.value = '1'; inp.dispatchEvent(new w.Event('change', { bubbles: true })); await tick(60);
  assert.deepEqual(log.find((x) => x[0] === 'PUT' && x[1].includes('/shelf'))[2], { customer_id: 9, code: 'CQ0271L', qty: 1 });
});

test('C2. 플랫폼 leads.html — 코드 → 목록 → 연락처 → Mi stock → 주문', { skip: (!JSDOM || !existsSync(PF_HTML)) && 'jsdom 또는 파일 없음' }, async () => {
  const html = readFileSync(PF_HTML, 'utf8');
  assert.ok(!/railway\.app|erp\.refatrix/.test(html), 'ERP · Railway 주소가 페이지에 없음');
  const log = [];
  const me = { customer_name: 'El Puente', expires_on: '2026-11-26', days_left: 31, discount: 45 };
  const leads = { me, states: ['Nuevo León'], leads: [
    { id: 1842, platform: 'whatsapp', first_mx: '2026-10-26 07:52', last_mx: '2026-10-26 07:52', state: 'Nuevo León', city: 'Guadalupe', tipo: 'Mecánico', vehicles: 'Nissan Versa 2017', summary: 'Busca horquilla', parts: [{ code: 'CQ0271L', qty: 1 }, { code: 'CQ0271R', qty: 1 }], open_parts: ['Bujes'], name_masked: 'J••••', phone_masked: '81 •••• ••42', has_phone: true, revealed: false }],
    products: { CQ0271L: { code: 'CQ0271L', name: 'Horquilla izq', active: true, avail: 24, incoming: 0, eta: null, price: 612, bought12: 6, bought_last: '2026-10-12', shelf: 3, shelf_src: 'customer', shelf_at: '2026-10-20' },
      CQ0271R: { code: 'CQ0271R', name: 'Horquilla der', active: true, avail: 0, incoming: 40, eta: '2026-11-18', price: 612, bought12: 0, bought_last: null, shelf: null, shelf_src: null, shelf_at: null } } };
  const routes = [
    [/POST \/lp-api\/login/, (_, b) => (b.code === 'RFX-7K2M-Q9PD' ? [200, { token: 'TOK', me }] : [401, { error: 'invalid_code' }])],
    [/GET \/lp-api\/me/, () => [200, { token: 'TOK2', me }]],
    [/GET \/lp-api\/leads/, () => [200, leads]],
    [/POST \/lp-api\/leads\/1842\/contact/, () => [200, { name: 'Jorge Treviño', phone: '528123456742', wa_link: null, platform: 'whatsapp', first_seen: '2026-10-26 08:14' }]],
    [/GET \/lp-api\/search\?q=54500/, () => [200, { items: [{ code: 'CS1188', name: 'Amortiguador del', app: 'Chevrolet Aveo 2012-2018', active: true, syd: ['8-1188'], oe: ['54500-4Z000'], via: 'oe', exact: true, hit: 'OE 54500-4Z000', img: 'https://img/x.webp', avail: 0, incoming: 40, eta: '2026-11-18', price: 1085, bought12: 0, shelf: null }] }]],
    [/PUT \/lp-api\/leads\/1842\/wants/, (_, b) => [200, { ok: true, wants: b.items.map((x) => ({ code: x.code, qty: x.qty, input: x.input })), products: { CS1188: { code: 'CS1188', name: 'Amortiguador del', active: true, avail: 0, incoming: 40, eta: '2026-11-18', price: 1085, bought12: 0, shelf: null } } }]],
    [/POST \/lp-api\/leads\/1842\/notes/, (_, b) => [200, { ok: true, note: { id: 77, body: b.body, at: '2026-10-26 14:10', mine: true }, claim: { state: 'mine', until: new Date(Date.now() + 3 * 86400000).toISOString(), created: true } }]],
    [/DELETE \/lp-api\/notes\/77/, () => [200, { ok: true }]],
    [/PUT \/lp-api\/stock/, (_, b) => [200, { ok: true, code: b.code, shelf: b.qty, shelf_src: 'customer', shelf_at: '2026-10-26' }]],
    [/POST \/lp-api\/order/, () => [200, { ok: true, quote_no: 'FB-2026-0187', total: 710, asesor: 'Oscar' }]],
  ];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://refatrix-platform.netlify.app/leads', beforeParse(w) {
    w.fetch = fakeFetch(routes, log);
    w.confirm = () => true; } });
  const w = dom.window, d = w.document;
  await tick(50);
  assert.ok(!d.getElementById('sLogin').classList.contains('hidden'), '처음엔 코드 입력');
  d.getElementById('code').value = 'rfx-0000-0000'; d.getElementById('enter').click(); await tick(60);
  assert.ok(d.getElementById('loginMsg').textContent.length > 3, '틀린 코드 안내');
  d.getElementById('code').value = 'RFX-7K2M-Q9PD'; d.getElementById('enter').click(); await tick(120);
  assert.equal(w.localStorage.getItem('rfx_lp_token'), 'TOK2', '열 때마다 새 토큰 저장');
  assert.ok(log.every((x) => x[1].startsWith('/lp-api/')), '같은 사이트 /lp-api 만 부른다');
  const txt = d.getElementById('list').textContent;
  assert.ok(txt.includes('Nissan Versa 2017') && txt.includes('CQ0271L') && txt.includes('$612') && txt.includes('24') && txt.includes('18/11'));
  assert.ok(d.getElementById('vig').textContent.includes('26/11/2026'));
  // 주문 버튼: 매장 재고 3 → 보통, 비어 있음 → 강조(sug). 담는 건 고객이 누를 때만(수백 건이 자동으로 담기지 않게)
  const addL = () => d.querySelector('.add[data-code="CQ0271L"]'), addR = () => d.querySelector('.add[data-code="CQ0271R"]');
  assert.ok(!addL().classList.contains('sug') && addR().classList.contains('sug') && !addR().classList.contains('on'));
  // 연락처
  d.querySelector('[data-contact="1842"]').click(); await tick(60);
  assert.ok(d.getElementById('list').textContent.includes('Jorge Treviño'));
  assert.ok(!d.querySelector('a[href*="wa.me"]'), '0300 · WhatsApp 버튼 없음');
  // 0298 · 찾는 부품 기록(2026-10-28: 모든 문의에서 — 연락처 전에도 버튼)
  d.querySelector('[data-find="1842"]').click(); await tick(40);
  const fq = d.getElementById('fq1842'); assert.ok(fq, '찾기 칸');
  fq.value = '54500-4Z000'; fq.dispatchEvent(new w.Event('input', { bubbles: true })); await tick(420);
  assert.ok(d.getElementById('fr1842').textContent.includes('CS1188') && d.getElementById('fr1842').textContent.includes('OE 54500-4Z000'));
  d.querySelector('[data-rq="CS1188"]').value = '2'; d.querySelector('[data-addw="CS1188"]').click(); await tick(20);
  assert.ok(d.getElementById('fdr1842').textContent.includes('CS1188'));
  d.querySelector('[data-fsave="1842"]').click(); await tick(60);
  assert.deepEqual(log.find((x) => x[0] === 'PUT' && x[1].includes('/wants'))[2], { items: [{ code: 'CS1188', qty: 2, input: '54500-4Z000' }] });
  assert.ok(!d.getElementById('fd1842'), '저장 후 닫힘');
  assert.ok(d.getElementById('list').textContent.includes('Piezas que busca este cliente'));
  assert.ok(d.querySelector('.add[data-code="CS1188"]'), '찾은 부품도 주문 버튼');

  // 0299/0305 · 메모 = 연락 기록 → 선점 안내 · 쓰기 · 지우기
  assert.ok(d.getElementById('rulebar').textContent.includes('Ver contacto') && d.getElementById('rulebar').textContent.includes('perder tu código'), '선점 규칙 안내');
  assert.ok(d.querySelector('[data-nadd="1842"]').textContent.includes('reserva 3 días'), '연락처 본 문의 = 「Registrar lo que hablaron」');
  d.querySelector('[data-nadd="1842"]').click(); await tick(20);
  assert.ok(d.getElementById('nt1842').textContent.includes('perder tu código'));
  d.getElementById('nb1842').value = 'Le llamé, cotizar mañana'; d.querySelector('[data-nsave="1842"]').click(); await tick(60);
  assert.deepEqual(log.find((x) => x[0] === 'POST' && x[1].endsWith('/notes'))[2], { body: 'Le llamé, cotizar mañana' });
  assert.ok(d.getElementById('nt1842').textContent.includes('Le llamé, cotizar mañana') && d.getElementById('nt1842').textContent.includes('Agregar nota (1)'));
  assert.ok(d.getElementById('ct1842').textContent.includes('Reservado para ti'), '저장 → 선점 표시');
  w.confirm = () => true; d.querySelector('[data-ndel="77"]').click(); await tick(60);
  assert.ok(log.some((x) => x[0] === 'DELETE' && x[1] === '/lp-api/notes/77')); assert.ok(!d.getElementById('nt1842').textContent.includes('Le llamé'));

  // Mi stock — 아래 시트에서 5 입력
  d.querySelector('.ms[data-code="CQ0271R"]').click(); await tick(20);
  assert.ok(!d.getElementById('msSheet').classList.contains('hidden'));
  d.getElementById('msQty').value = '5'; d.getElementById('msSave').click(); await tick(60);
  assert.deepEqual(log.find((x) => x[0] === 'PUT' && x[1] === '/lp-api/stock')[2], { code: 'CQ0271R', qty: 5 });
  assert.ok(d.getElementById('msSheet').classList.contains('hidden'));
  assert.ok(!addR().classList.contains('sug'), '재고 5 → 강조 해제');
  // 장바구니 → 주문
  addL().click(); await tick(20); addR().click(); await tick(20);
  assert.ok(addL().classList.contains('on') && addR().classList.contains('on'));
  assert.ok(d.getElementById('cartbar').textContent.includes('2 piezas'));
  d.getElementById('openCart').click(); await tick(20);
  assert.ok(d.getElementById('cartTotal').textContent.includes('1,419.84'), '(612×1 + 612×1) × 1.16');
  const qi = d.querySelector('#cartBody input.q[data-code="CQ0271R"]'); qi.value = '3'; qi.dispatchEvent(new w.Event('change', { bubbles: true })); await tick(20);
  assert.ok(d.getElementById('cartTotal').textContent.includes('2,839.68'), '(612 + 612×3) × 1.16');
  d.getElementById('note').value = 'Mañana'; d.getElementById('send').click(); await tick(80);
  const o = log.find((x) => x[0] === 'POST' && x[1] === '/lp-api/order')[2];
  assert.deepEqual(o.items.map((i) => [i.code, i.qty, i.thread_ids]).sort(), [['CQ0271L', 1, [1842]], ['CQ0271R', 3, [1842]]]);
  assert.equal(o.note, 'Mañana'); assert.match(o.key, /^[A-Za-z0-9_-]{8,64}$/);
  assert.ok(d.getElementById('done').textContent.includes('FB-2026-0187') && d.getElementById('done').textContent.includes('Oscar'));
  assert.ok(!/[가-힣]/.test(d.body.textContent), '고객 화면에 한글 없음');
});

test('C3. 플랫폼 leads.html — 디렉터 코드: 전체 메모 · 작성자 · 주문/재고 버튼 없음', { skip: (!JSDOM || !existsSync(PF_HTML)) && 'jsdom 또는 파일 없음' }, async () => {
  const html = readFileSync(PF_HTML, 'utf8'); const log = [];
  const me = { customer_name: 'Dirección Refatrix', expires_on: '2027-10-26', days_left: 365, discount: 0, role: 'director' };
  const routes = [
    [/GET \/lp-api\/me/, () => [200, { token: 'D2', me }]],
    [/GET \/lp-api\/leads/, () => [200, { me, states: [], products: { CQ0271L: { code: 'CQ0271L', name: 'H', active: true, avail: 5, incoming: 0, price: 1000, bought12: 0, shelf: null } },
      leads: [{ id: 9, platform: 'messenger', last_mx: '2026-10-26 10:00', vehicles: 'Versa', parts: [{ code: 'CQ0271L', qty: 2 }], open_parts: [], wants: [], revealed: false, has_phone: true, phone_masked: '81 •••• ••11',
        notes: [{ id: 1, body: 'Nota de El Puente', at: '2026-10-26 11:00', author: 'El Puente', mine: false }, { id: 2, body: 'Revisar', at: '2026-10-26 12:00', author: 'Dirección Refatrix', mine: true }] }] }]],
  ];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://refatrix-platform.netlify.app/leads', beforeParse(w) { w.localStorage.setItem('rfx_lp_token', 'D1'); w.fetch = fakeFetch(routes, log); } });
  const d = dom.window.document; await tick(120);
  assert.ok(d.getElementById('dirbar') && d.getElementById('dirbar').textContent.includes('dirección'));
  assert.ok(!d.querySelector('.add'), '주문 버튼 없음'); assert.ok(!d.querySelector('.ms'), 'Mi stock 버튼 없음');
  const nt = d.getElementById('nt9').textContent;
  assert.ok(nt.includes('El Puente') && nt.includes('Nota de El Puente') && nt.includes('Revisar'));
  assert.ok(d.querySelector('[data-ndel="2"]') && !d.querySelector('[data-ndel="1"]'), '디렉터는 자기 메모만 지움');
  assert.ok(d.getElementById('cartbar').classList.contains('hidden'));
});

test('C4. 플랫폼 leads.html — 선점 규칙 · 모든 문의 「Registrar」 · Messenger 대화 전체 · 첫 메시지 = 선점 · WhatsApp 대화 없음', { skip: (!JSDOM || !existsSync(PF_HTML)) && 'jsdom 또는 파일 없음' }, async () => {
  const html = readFileSync(PF_HTML, 'utf8'); const log = [];
  const me = { customer_name: 'El Puente', expires_on: '2026-11-26', days_left: 31, discount: 45, role: 'customer', claim_days: 3 };
  const until = new Date(Date.now() + 20 * 3600000).toISOString();
  const cu = new Date(Date.now() + 3 * 86400000).toISOString();
  const msgs = [{ dir: 'in', who: 'cliente', text: 'Hola, busco amortiguadores', at: new Date(Date.now() - 7200e3).toISOString() },
                { dir: 'out', who: 'refatrix', text: 'Hola, ¿delanteros?', at: new Date(Date.now() - 7100e3).toISOString() }];
  const base = { parts: [], open_parts: [], wants: [], notes: [], revealed: false };
  const routes = [
    [/GET \/lp-api\/me/, () => [200, { token: 'T2', me }]],
    [/GET \/lp-api\/leads$/, () => [200, { me, states: [], products: {}, leads: [
      { ...base, id: 5, platform: 'messenger', last_mx: '2026-10-26 13:52', vehicles: 'Aveo 2018', has_phone: false, name_masked: 'M••••', claim: null, chat: { open: true, window_until: until, claim: null } },
      { ...base, id: 6, platform: 'whatsapp', last_mx: '2026-10-26 11:20', vehicles: 'Jetta 2015', has_phone: false, name_masked: null, phone_masked: null, claim: { state: 'other', until: cu }, chat: null },
      { ...base, id: 7, platform: 'whatsapp', last_mx: '2026-10-26 07:52', vehicles: 'Versa', has_phone: true, phone_masked: '81 •••• ••42', claim: null, chat: null }] }]],
    [/POST \/lp-api\/leads\/5\/contact/, () => [200, { name: 'Mario', phone: null, platform: 'messenger' }]],
    [/GET \/lp-api\/leads\/5\/chat/, () => [200, { messages: msgs, open: true, window_until: until, claim_until: null, claimed: false, summary: 'Amortiguadores delanteros', can_send: true }]],
    [/POST \/lp-api\/leads\/5\/chat/, (_, b) => [200, { ok: true, message: { dir: 'out', who: 'yo', text: '[El Puente] ' + b.text, at: new Date().toISOString() }, claim: { state: 'mine', until: cu, created: true } }]],
  ];
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://refatrix-platform.netlify.app/leads', beforeParse(w) { w.localStorage.setItem('rfx_lp_token', 'T1'); w.fetch = fakeFetch(routes, log); } });
  const w = dom.window, d = w.document; await tick(120);
  assert.ok(d.getElementById('rulebar').textContent.includes('3 días'), '선점 규칙 · 일수');
  for (const id of [5, 7]) assert.ok(d.querySelector(`[data-find="${id}"]`), `「Registrar」 — 연락처 전에도 (${id})`);
  assert.ok(d.querySelector('#ct6 .findbtn[disabled]') && !d.querySelector('[data-contact="6"]'), '다른 곳이 선점: 연락처 버튼 없음 · Registrar 비활성');
  assert.ok(d.getElementById('ct6').textContent.includes('Otra refaccionaria ya contactó'));
  assert.ok(!d.querySelector('[data-copen="5"]') && d.getElementById('cw5').textContent.includes('Ver contacto'), 'Messenger — 연락처 전엔 대화 안내만');
  assert.ok(d.getElementById('cw7').textContent.includes('WhatsApp no se atienden'), 'WhatsApp — 대화 없음');
  assert.ok(!d.querySelector('[data-ctake]'), '「Atender」 버튼 없음');
  d.querySelector('[data-contact="5"]').click(); await tick(80);
  assert.ok(d.querySelector('[data-copen="5"]'), '연락처 본 뒤 「Ver conversación」');
  d.querySelector('[data-copen="5"]').click(); await tick(120);
  const cm = d.getElementById('cm5').textContent;
  assert.ok(cm.includes('Resumen: Amortiguadores delanteros') && cm.includes('Conversación completa') && cm.includes('Hola, busco amortiguadores') && cm.includes('Hola, ¿delanteros?'), '요약 아래 실제 대화');
  assert.ok(cm.indexOf('Resumen') < cm.indexOf('Hola, busco'));
  assert.ok(d.getElementById('cw5').textContent.includes('queda reservado para ti 3 días'), '첫 메시지 = 선점 안내');
  d.getElementById('ct_5').value = 'Sí, tenemos'; d.querySelector('[data-csend="5"]').click(); await tick(80);
  assert.deepEqual(log.find((x) => x[0] === 'POST' && x[1] === '/lp-api/leads/5/chat')[2], { text: 'Sí, tenemos' });
  assert.ok(d.getElementById('cm5').textContent.includes('[El Puente] Sí, tenemos'));
  assert.ok(d.getElementById('ct5').textContent.includes('Reservado para ti'), '보낸 뒤 선점 표시');
  assert.ok(!d.getElementById('cw5').textContent.includes('queda reservado para ti 3 días'), '선점 뒤엔 안내 없음');
  assert.ok(!d.getElementById('nt5').textContent.includes('reserva 3 días'), '메모 버튼도 선점 반영');
  d.querySelector('[data-cclose="5"]').click(); await tick(20);
  assert.ok(d.querySelector('[data-copen="5"]'));
  assert.ok(!/[가-힣]/.test(d.body.textContent));
  dom.window.close();
});
