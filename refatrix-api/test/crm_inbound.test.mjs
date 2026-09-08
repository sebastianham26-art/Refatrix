// CRM → ERP 수신(신규고객 등록) — 0208
//
//   순수 로직(필드 읽기·키 검증)은 DB 없이 돌고,
//   실제 수신은 TEST_PG_URL 이 있을 때 buildApp().inject() 로 진짜 라우트를 때린다.
//
//   실행: TEST_PG_URL=postgres://... node --test test/crm_inbound.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, '..');
const REPO = join(API, '..');
const read = (p) => readFileSync(p, 'utf8');

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

const { mapInbound, missingRequired, readInboundKey, verifyInboundKey, sameToken, flattenBody,
        scrubPayload } = await import('../src/crmInbound.js');
const { validatePatch, publicEndpoint } = await import('../src/integrations.js');

// ── A. 본문 읽기 — 상대가 계약서와 다른 이름을 써도 알아본다 ──────────
test('A1. 계약서 이름 그대로 온 본문을 읽는다', () => {
  const m = mapInbound({
    rfc: 'CQR1603288MA', nombre: 'COMERCIALIZADORA QUALI', apellido: 'LIRA',
    telefono: '8113843028', correo: 'a@b.com', crmCustomerCode: 'WEB-14',
    discountPercent: 30, paymentDays: 45, sydRefBuyPrice: 412.5, vendedorCorreo: 'oscar@refatrix.com.mx',
  });
  assert.equal(m.rfc, 'CQR1603288MA');
  assert.equal(m.crmCode, 'WEB-14');
  assert.equal(m.discountPercent, 30);
  assert.equal(m.paymentDays, 45);
  assert.equal(m.sydRefBuyPrice, 412.5);
  assert.equal(m.vendedorCorreo, 'oscar@refatrix.com.mx');
});

test('A2. CRM 이 실제로 보낸 이름(customerCode)도 읽는다', () => {
  // 2026-09-08 첫 호출 로그: customerId=null customerCode=WEB-128 transactionUser=refatrixAdmin
  const m = mapInbound({ rfc: 'AIAC8310204A1', customerCode: 'WEB-128', customerId: null,
    transactionUser: 'refatrixAdmin' });
  assert.equal(m.crmCode, 'WEB-128', '계약서의 crmCustomerCode 가 아니어도 잃어버리면 안 된다');
  assert.equal(m.transactionUser, 'refatrixAdmin');
});

test('A3. 대소문자·언더스코어·한 겹 감싼 본문을 견딘다', () => {
  const m = mapInbound({ cliente: { RFC: 'x', Nombre_Comercial: 'ACME', correo_electronico: 'c@d.com' } });
  assert.equal(m.rfc, 'x');
  assert.equal(m.nombreComercial, 'ACME');
  assert.equal(m.correo, 'c@d.com');
  assert.ok(flattenBody({ data: { a: 1 } }).a === 1);
});

test('A4. 숫자는 문자열·퍼센트·쉼표로 와도 숫자가 된다', () => {
  const m = mapInbound({ discountPercent: '30%', paymentDays: '45', sydRefBuyPrice: '1,412.50' });
  assert.equal(m.discountPercent, 30);
  assert.equal(m.paymentDays, 45);
  assert.equal(m.sydRefBuyPrice, 1412.5);
});

test('A5. transactionUser 가 없으면 crm 으로 기록한다', () => {
  assert.equal(mapInbound({}).transactionUser, 'crm');
});

// ── B. 필수 5개 ──────────────────────────────────────────────────────
test('B1. 빠진 필수 필드를 이름으로 돌려준다', () => {
  assert.deepEqual(missingRequired(mapInbound({ rfc: 'X', nombre: 'N' })),
    ['apellido', 'telefono', 'correo']);
});

test('B2. 필수 5개만 있으면 통과한다 — 나머지는 없어도 막지 않는다', () => {
  const m = mapInbound({ rfc: 'X', nombre: 'N', apellido: 'A', telefono: '1', correo: 'c@d.com' });
  assert.deepEqual(missingRequired(m), []);
  assert.equal(m.discountPercent, null, '안 온 값은 null 이어야 한다(0 으로 지어내면 안 된다)');
  assert.equal(m.paymentDays, null);
});

test('B3. 공백만 든 값은 없는 것으로 본다', () => {
  assert.ok(missingRequired(mapInbound({ rfc: '  ', nombre: 'N', apellido: 'A', telefono: '1', correo: 'c@d' }))
    .includes('rfc'));
});

// ── C. 수신 키 ───────────────────────────────────────────────────────
const req = (o) => ({ headers: {}, query: {}, body: {}, ...o });

test('C1. 헤더·쿼리·본문 어디에 실려 와도 키를 찾는다', () => {
  assert.deepEqual(readInboundKey(req({ headers: { 'x-api-key': 'K1' } })), { token: 'K1', where: 'header' });
  assert.deepEqual(readInboundKey(req({ query: { apiKey: 'K2' } })), { token: 'K2', where: 'query' });
  assert.deepEqual(readInboundKey(req({ body: { apiKey: 'K3' } })), { token: 'K3', where: 'body' });
  assert.deepEqual(readInboundKey(req({ headers: { authorization: 'Bearer K4' } })), { token: 'K4', where: 'header' });
  assert.equal(readInboundKey(req({})).where, 'none');
});

test('C2. 테스트 키·운영 키 둘 다 받아 준다(어느 쪽인지는 기록된다)', () => {
  const ep = { auth_token_test: 'T'.repeat(20), auth_token_prod: 'P'.repeat(20) };
  assert.deepEqual(verifyInboundKey(ep, 'T'.repeat(20)), { ok: true, env: 'test' });
  assert.deepEqual(verifyInboundKey(ep, 'P'.repeat(20)), { ok: true, env: 'prod' });
});

test('C3. 키가 틀리거나 없으면 거절한다', () => {
  const ep = { auth_token_prod: 'P'.repeat(20) };
  assert.equal(verifyInboundKey(ep, 'X'.repeat(20)).ok, false);
  assert.equal(verifyInboundKey(ep, null).reason, 'missing');
  assert.equal(verifyInboundKey({}, 'anything').reason, 'no_key_configured',
    '키를 발급하지 않았는데 아무나 받아 주면 안 된다');
});

test('C4. 길이가 다르면 즉시 false(비교에서 정보가 새지 않게)', () => {
  assert.equal(sameToken('abc', 'abcd'), false);
  assert.equal(sameToken('', ''), false);
  assert.equal(sameToken('abc', 'abc'), true);
});

test('C5. 이력에 남길 본문에서는 키 값을 지운다', () => {
  // 키를 본문으로 받아 주기로 했으므로, 원문을 그대로 저장하면 우리 키가 이력에 평문으로 남는다.
  const s = scrubPayload({ apiKey: 'rfx_prod_secret', rfc: 'X', cliente: { api_key: 'zz', nombre: 'N' } });
  assert.equal(s.apiKey, '***');
  assert.equal(s.cliente.api_key, '***');
  assert.equal(s.rfc, 'X', '키가 아닌 값은 그대로 남아야 원문 확인에 쓸 수 있다');
  assert.equal(s.cliente.nombre, 'N');
  assert.equal(JSON.stringify(s).includes('secret'), false);
});

// ── D. 등록부 — 수신 연동은 상대 URL 이 없다 ─────────────────────────
test('D1. 수신 연동은 운영 URL 을 요구하지 않는다', () => {
  assert.equal(validatePatch({ env: 'prod', url_prod: '' }), 'url_prod_required', '전송 연동은 그대로 막힌다');
  assert.equal(validatePatch({ env: 'prod', url_prod: '' }, { direction: 'in' }), null,
    '수신 연동까지 막으면 화면에서 저장 자체가 안 된다');
});

test('D2. 화면 응답에 방향·수신 주소가 실리고 키 값은 실리지 않는다', () => {
  const pub = publicEndpoint({ key: 'crm_customer_registration', category: 'customer', label: 'L',
    enabled: true, env: 'prod', direction: 'in', inbound_path: '/api/integrations/crm/customer-registration',
    auth_token_prod: 'rfx_prod_supersecret', ok_code: '0', timeout_ms: 10000 });
  assert.equal(pub.direction, 'in');
  assert.equal(pub.inbound_path, '/api/integrations/crm/customer-registration');
  assert.equal(pub.has_token_prod, true);
  assert.equal(JSON.stringify(pub).includes('supersecret'), false, '키 값이 화면으로 나가면 안 된다');
});

// ── E. 소스 계약 ─────────────────────────────────────────────────────
test('E1. 서버가 수신 라우트를 등록한다', () => {
  const s = read(join(API, 'src/server.js'));
  assert.ok(s.includes("import crmInboundRoutes from './routes/crmInboundRoutes.js'"));
  assert.ok(s.includes('app.register(crmInboundRoutes)'), '등록하지 않으면 404 가 그대로 난다');
});

test('E2. CRM 이 부르는 주소 그대로여야 한다', () => {
  const s = read(join(API, 'src/routes/crmInboundRoutes.js'));
  assert.ok(s.includes("'/api/integrations/crm/customer-registration'"),
    'CRM 개발자에게 준 주소와 한 글자라도 다르면 다시 404 다');
});

test('E3. 수신 연동에는 「연결 테스트」를 걸지 않는다', () => {
  const s = read(join(API, 'src/routes/integrationRoutes.js'));
  assert.ok(s.includes("ep.direction === 'in'"), '수신 연동에 시험 전송을 시도하면 무의미한 오류가 난다');
});

test('E4. 채번 규칙은 한 곳에서만 정의된다', () => {
  const c = read(join(API, 'src/routes/customerRoutes.js'));
  assert.ok(c.includes("from '../customerCode.js'"));
  assert.equal(/async function computeNextCode/.test(c), false, '채번 규칙이 두 벌이면 C-/P- 번호가 어긋난다');
});

test('E5. 화면이 수신 연동을 전송 연동과 다르게 그린다', () => {
  const h = read(join(REPO, 'refatrix-integrations.html'));
  assert.ok(h.includes('boxInbound'));
  assert.ok(h.includes('/api/crm-inbound/history'));
  assert.ok(h.includes('inbound-key'), '키 발급 버튼이 있어야 개발자에게 줄 키를 만들 수 있다');
});

test('E6. 감사로그 action 은 체크 제약 목록 안의 값만 쓴다', () => {
  const s = read(join(API, 'src/routes/crmSyncRoutes.js'));
  assert.equal(s.includes("action: 'crm_bulk_push'"), false,
    'audit_log_action_check 에 없는 값이라 조용히 버려진다');
});

// ── F. 실제 수신 (DB) ────────────────────────────────────────────────
const dbTest = PG ? test : test.skip;

dbTest('수신 → 승인 대기 고객(P-####) 생성 · 멱등 · 인증 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const { invalidateEndpointCache } = await import('../src/integrations.js');
  // 서버 전체(buildApp)가 아니라 **이 라우트만** 띄운다 —
  //   server.js 는 geoip 등 프로세스를 붙잡는 모듈을 함께 끌고 와 테스트가 끝나도 안 끝난다.
  //   서버가 이 라우트를 실제로 등록하는지는 E1 이 소스로 검증한다.
  const Fastify = (await import('fastify')).default;
  const crmInboundRoutes = (await import('../src/routes/crmInboundRoutes.js')).default;
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, function (request, body, done) {
    if (body === undefined || body === null || String(body).trim() === '') { done(null, {}); return; }
    try { done(null, JSON.parse(body)); } catch (err) { err.statusCode = 400; done(err, undefined); }
  });
  app.register(crmInboundRoutes);
  await app.ready();
  t.after(async () => { await app.close(); });

  const TAG = 'IT' + String(Date.now()).slice(-6);
  const KEY = 'rfx_test_' + 'a'.repeat(48);
  await query(`UPDATE integration_endpoints SET auth_token_test=$1, auth_token_prod=NULL, enabled=true
                WHERE key='crm_customer_registration'`, [KEY]);
  invalidateEndpointCache();

  // 담당 영업 매칭용 사용자
  const asesorId = (await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'sales','x',$2) RETURNING id`,
    ['아세소르' + TAG, 'oscar_' + TAG])).rows[0].id;

  const rfc1 = 'CQR160328MA1';          // 법인 12자리
  const post = (payload, opts = {}) => app.inject({
    method: 'POST', url: '/api/integrations/crm/customer-registration' + (opts.qs || ''),
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    payload,
  });

  const madeIds = [];
  t.after(async () => {
    if (madeIds.length) {
      await query(`DELETE FROM customer_registration_events WHERE customer_id = ANY($1::bigint[])`, [madeIds]);
      await query(`DELETE FROM crm_inbound_log WHERE customer_id = ANY($1::bigint[])`, [madeIds]);
      await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [madeIds]);
    }
    await query(`DELETE FROM crm_inbound_log WHERE rfc = $1`, [rfc1]);
    await query(`DELETE FROM users WHERE id=$1`, [asesorId]);
    await pool.end();     // 남은 커넥션이 있으면 테스트 러너가 끝나지 않는다
  });

  await t.test('키가 없으면 401 ERR_API_KEY — 고객이 만들어지지 않는다', async () => {
    const r = await post({ rfc: rfc1, nombre: 'A', apellido: 'B', telefono: '1', correo: 'a@b.com' });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().codigoError, 'ERR_API_KEY');
    const n = (await query(`SELECT count(*)::int n FROM customers WHERE rfc=$1`, [rfc1])).rows[0].n;
    assert.equal(n, 0);
  });

  await t.test('필수 5개 중 빠진 게 있으면 400 + 어떤 필드인지 알려준다', async () => {
    const r = await post({ rfc: rfc1, nombre: 'A' }, { headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 400);
    const b = r.json();
    assert.equal(b.codigoError, 'ERR_REQUIRED_FIELD');
    assert.match(b.mensaje, /apellido/);
    assert.match(b.mensaje, /telefono/);
  });

  await t.test('RFC 형식이 틀리면 400 ERR_RFC_INVALID', async () => {
    const r = await post({ rfc: 'NOPE', nombre: 'A', apellido: 'B', telefono: '1', correo: 'a@b.com' },
      { headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().codigoError, 'ERR_RFC_INVALID');
  });

  await t.test('정상 수신 → P-#### · pending · 담당 영업 자동 배정', async () => {
    const r = await post({
      rfc: rfc1, nombre: 'COMERCIALIZADORA QUALI', apellido: 'LIRA',
      telefono: '8113843028', correo: 'quali@ejemplo.com',
      customerCode: 'WEB-' + TAG,               // ← CRM 이 실제로 쓰는 이름
      discountPercent: 30, paymentDays: 45,
      vendedorCorreo: 'oscar_' + TAG + '@refatrix.com.mx',
      estado: 'Nuevo León', ciudad: 'Monterrey',
      transactionUser: 'refatrixAdmin',
    }, { headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.codigoError, '0');
    assert.equal(b.estatus, 'pendiente');
    assert.match(b.erpCustomerCode, /^P-\d{4}$/, 'CRM 유입 고객은 P 계열이어야 구분이 된다');

    const c = (await query(
      `SELECT id, code, name, rfc, phone, contact, discount, credit_days, owner_id, team_id,
              approval_status, crm_customer_code, ship_address
         FROM customers WHERE code=$1`, [b.erpCustomerCode])).rows[0];
    madeIds.push(Number(c.id));
    assert.equal(c.approval_status, 'pending', '수신 즉시 승인되면 디렉터 통제가 무너진다');
    assert.equal(c.name, 'COMERCIALIZADORA QUALI LIRA');
    assert.equal(c.rfc, rfc1);
    assert.equal(c.crm_customer_code, 'WEB-' + TAG);
    assert.equal(String(c.owner_id), String(asesorId), 'vendedorCorreo 가 맞으면 담당이 붙어야 한다');
    assert.equal(Number(c.discount), 30);
    assert.equal(Number(c.credit_days), 45);
    assert.match(c.ship_address, /Monterrey/);

    const ev = (await query(
      `SELECT snapshot FROM customer_registration_events WHERE customer_id=$1 AND action='submit'`,
      [c.id])).rows[0];
    assert.equal(ev.snapshot.origin, 'crm');
    assert.equal(ev.snapshot.raw.customerCode, 'WEB-' + TAG, '상대가 보낸 원문이 그대로 남아야 한다');
  });

  await t.test('같은 RFC 를 다시 보내도 고객이 둘이 되지 않는다(멱등)', async () => {
    const r = await post({ rfc: rfc1, nombre: 'COMERCIALIZADORA QUALI', apellido: 'LIRA',
      telefono: '8113843028', correo: 'quali@ejemplo.com' }, { headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().codigoError, '0');
    const n = (await query(
      `SELECT count(*)::int n FROM customers WHERE rfc=$1 AND deleted_at IS NULL`, [rfc1])).rows[0].n;
    assert.equal(n, 1, '재전송으로 고객이 복제되면 커미션 귀속이 깨진다');
  });

  await t.test('키는 쿼리스트링·본문으로도 받는다', async () => {
    const q = await post({ rfc: rfc1, nombre: 'A', apellido: 'B', telefono: '1', correo: 'a@b.com' },
      { qs: '?apiKey=' + KEY });
    assert.equal(q.statusCode, 200);
    const b = await post({ apiKey: KEY, rfc: rfc1, nombre: 'A', apellido: 'B', telefono: '1', correo: 'a@b.com' });
    assert.equal(b.statusCode, 200);
  });

  await t.test('수신 이력에 원문·판정·키 위치가 남는다', async () => {
    const rows = (await query(
      `SELECT * FROM crm_inbound_log WHERE rfc=$1 ORDER BY id`, [rfc1])).rows;
    assert.ok(rows.length >= 4);
    const created = rows.find((r) => r.result === 'created');
    assert.ok(created, '신규 접수 건이 기록돼야 한다');
    assert.equal(created.auth_ok, true);
    assert.equal(created.auth_in, 'header');
    assert.equal(created.payload.customerCode, 'WEB-' + TAG);
    const denied = rows.find((r) => r.codigo_error === 'ERR_API_KEY');
    assert.ok(denied && denied.auth_ok === false, '거절 건도 남아야 원인을 추적할 수 있다');
    assert.ok(rows.some((r) => r.auth_in === 'query'), '키가 어디로 들어왔는지 남아야 한다');
    assert.ok(rows.some((r) => r.auth_in === 'body'));
    assert.equal(JSON.stringify(rows).includes(KEY), false, '수신 키 값 자체가 이력에 남으면 안 된다');
  });
});
