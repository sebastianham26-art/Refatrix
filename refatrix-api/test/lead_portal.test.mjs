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
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-lead-portal';
process.env.QUOTE_WA_ENABLED = '0';
process.env.META_LEADS_AUTO = '0';
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
  const P2 = await one(`INSERT INTO products (code, name, list_price, stock_qty) VALUES ($1,'AMORTIGUADOR DEL',2000,0) RETURNING id, code`, [`LS${T}`]);
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
  assert.equal(r.json().phone, '528123456742'); assert.equal(r.json().wa_link, 'https://wa.me/528123456742'); assert.equal(r.json().first_time, true);
  r = await call(C, 'POST', `/api/lead-portal/leads/${T1.id}/contact`); assert.equal(r.json().first_time, false);
  assert.equal((await call(C, 'POST', `/api/lead-portal/leads/${T3.id}/contact`)).statusCode, 404, '제외 문의');
  let rv = await one(`SELECT count(*)::int n, max(n) mx FROM lead_portal_reveals WHERE thread_id=$1`, [T1.id]); assert.deepEqual([rv.n, rv.mx], [1, 2]);
  r = await call(D, 'GET', '/api/meta-leads/list?q=' + encodeURIComponent('LP1') ); // 아무 검색
  r = await call(D, 'GET', '/api/meta-leads/list'); const row = r.json().items.find((x) => x.id === Number(T1.id));
  assert.equal(row.revealed_to, `Refacc El Puente ${T}`, 'ERP 목록에 「공개된 곳」');
  r = await call(C, 'GET', '/api/lead-portal/leads'); assert.equal(r.json().leads.find((l) => l.id === Number(T1.id)).revealed, true);

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
    [/GET \/api\/lead-portal-admin\/reveals/, () => [200, { items: [{ first_mx: '2026-10-26 08:14', customer_name: 'El Puente', code_last4: 'Q9PD', thread_id: 1842, platform: 'whatsapp', status: 'nuevo', vehicles: 'Versa 2017', parts: 'Horquilla', n: 1 }] }]],
    [/GET \/api\/lead-portal-admin\/customers/, () => [200, { items: [{ id: 9, code: 'C-0052', name: 'El Puente', discount: 45 }] }]],
    [/GET \/api\/lead-portal-admin\/customer-ref\/9/, () => [200, { d30: 18420, d90: 61950, d365: 214300, last_date: '2026-10-21', last_amount: 12880, codes: 0 }]],
    [/POST \/api\/lead-portal-admin\/codes$/, (_, b) => [200, { ok: true, code: 'RFX-7K2M-Q9PD', invite: 'Hola El Puente RFX-7K2M-Q9PD', item: { ...codes[0], expires_on: b.expires_on } }]],
    [/PATCH \/api\/lead-portal-admin\/codes\/5/, (_, b) => [200, { ok: true, item: { ...codes[0], ...b } }]],
    [/GET \/api\/lead-portal-admin\/shelf\?/, () => [200, { items: [{ code: 'CQ0271L', name: 'Horquilla', qty: 3, by: '고객 (…Q9PD)', at: '2026-10-20 15:02', bought12: 6, avail: 24 }] }]],
    [/PUT \/api\/lead-portal-admin\/shelf/, (_, b) => [200, { ok: true, code: b.code, qty: b.qty }]],
  ];
  const dom = new JSDOM(page, { runScripts: 'dangerously', beforeParse(w) { w.fetch = fakeFetch(routes, log); w.prompt = () => '2026-12-31'; w.confirm = () => true; w.navigator.clipboard = { writeText: async () => {} }; } });
  const w = dom.window, d = w.document;
  d.querySelector('[data-p="lp"]').click(); await tick(80);
  assert.ok(d.getElementById('lpCodes').textContent.includes('El Puente'), '목록');
  assert.ok(d.getElementById('lpCodes').textContent.includes('…Q9PD'));
  assert.ok(d.getElementById('lpReveals').textContent.includes('Versa 2017'));
  // 발급
  d.getElementById('lpCustQ').value = 'Puente'; d.getElementById('lpCustQ').dispatchEvent(new w.Event('input')); await tick(400);
  d.querySelector('#lpCustList [data-cid="9"]').click(); await tick(60);
  assert.ok(d.getElementById('lpRef').textContent.includes('214,300'), 'ERP 매출 참고');
  d.getElementById('lpExp').value = '2026-11-26'; d.getElementById('lpAmt').value = '50,000'; d.getElementById('lpMemo').value = '10월 주문';
  d.getElementById('lpIssue').click(); await tick(60);
  const post = log.find((x) => x[0] === 'POST' && x[1].endsWith('/codes'));
  assert.deepEqual([post[2].customer_id, post[2].expires_on, post[2].basis_amount, post[2].memo], [9, '2026-11-26', '50,000', '10월 주문']);
  assert.ok(d.getElementById('lpIssued').textContent.includes('RFX-7K2M-Q9PD'), '코드 한 번 보여 줌');
  // 기한 변경(prompt)
  d.querySelector('#lpCodes [data-act="ext"][data-id="5"]').click(); await tick(60);
  assert.deepEqual(log.find((x) => x[0] === 'PATCH')[2], { expires_on: '2026-12-31' });
  // 매장 재고
  d.querySelector('#lpCodes [data-act="shelf"][data-id="5"]').click(); await tick(60);
  assert.ok(d.getElementById('lpShelf').textContent.includes('CQ0271L'));
  const inp = d.querySelector('#lpShelf input[data-code="CQ0271L"]'); inp.value = '1'; inp.dispatchEvent(new w.Event('change', { bubbles: true })); await tick(60);
  assert.deepEqual(log.find((x) => x[0] === 'PUT')[2], { customer_id: 9, code: 'CQ0271L', qty: 1 });
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
    [/POST \/lp-api\/leads\/1842\/contact/, () => [200, { name: 'Jorge Treviño', phone: '528123456742', wa_link: 'https://wa.me/528123456742', platform: 'whatsapp', first_seen: '2026-10-26 08:14' }]],
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
  assert.ok(d.querySelector('a[href="https://wa.me/528123456742"]'));
  // Mi stock — 아래 시트에서 5 입력
  d.querySelector('.ms[data-code="CQ0271R"]').click(); await tick(20);
  assert.ok(!d.getElementById('msSheet').classList.contains('hidden'));
  d.getElementById('msQty').value = '5'; d.getElementById('msSave').click(); await tick(60);
  assert.deepEqual(log.find((x) => x[0] === 'PUT')[2], { code: 'CQ0271R', qty: 5 });
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
