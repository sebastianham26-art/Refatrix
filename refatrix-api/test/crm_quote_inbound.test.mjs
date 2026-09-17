// CRM → ERP 견적요청 수신 (0220)
//
//   왜 이 시험이 있나: 이 창구가 없던 동안 CRM 은 화면용 API 를 직원 계정으로 호출했고,
//   `customer_id` 숫자를 그대로 믿는 바람에 **남의 고객(NAJAR)에 견적이 붙었다.**
//   그리고 거절되면 아무 기록도 안 남아 「보냈는데 없다」를 추측으로만 다뤘다.
//   여기서 잠그는 것은 그 두 가지다 — **숫자 id 로는 절대 고객이 정해지지 않는다**,
//   그리고 **성공이든 거절이든 이력이 남는다.**
//
//   실행: TEST_PG_URL=postgres://... node --test test/crm_quote_inbound.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

const { mapQuote, quoteDate, badQuoteLines } = await import('../src/crmInbound.js');

// ── ① 순수 로직 ────────────────────────────────────────────────
test('고객은 RFC·CRM코드로만 읽는다 — 숫자 id 는 읽지 않는다', () => {
  // ⚠ 이 프로젝트에서 가장 비싼 교훈이다. CRM 의 5번과 ERP 의 5번은 다른 회사다.
  //   숫자를 **받아 두기만 해도** 언젠가 쓰이고, 그날 남의 고객에 견적이 붙는다.
  const m = mapQuote({ customer_id: 5, customerId: 5, id: 5, rfc: 'AIAC8310204A0',
    lineas: [{ codigo: 'GV0022', cantidad: 3 }] });
  assert.equal(m.rfc, 'AIAC8310204A0');
  assert.equal(JSON.stringify(m).includes('customer_id'), false);
  assert.equal(m.customerId, undefined);
});

test('줄은 이름이 달라도 알아본다(codigo/code/sku · cantidad/qty)', () => {
  const a = mapQuote({ rfc: 'X', lineas: [{ codigo: 'GV0022', cantidad: 3 }] });
  const b = mapQuote({ rfc: 'X', lines: [{ code: 'GV0022', qty: 3 }] });
  const c = mapQuote({ rfc: 'X', partidas: [{ sku: 'GV0022', piezas: 3 }] });
  for (const m of [a, b, c]) assert.deepEqual(m.lines, [{ code: 'GV0022', qty: 3 }]);
});

test('CRM 견적번호는 여러 이름으로 와도 잡는다(멱등의 열쇠)', () => {
  assert.equal(mapQuote({ cotizacionCrm: 'COT-1' }).crmQuoteNo, 'COT-1');
  assert.equal(mapQuote({ folio: 'COT-2' }).crmQuoteNo, 'COT-2');
  assert.equal(mapQuote({ numeroCotizacion: 'COT-3' }).crmQuoteNo, 'COT-3');
});

test('한 겹 감싼 본문도 푼다', () => {
  const m = mapQuote({ data: { rfc: 'ABC010101AA1', lineas: [{ codigo: 'A', cantidad: 1 }] } });
  assert.equal(m.rfc, 'ABC010101AA1');
  assert.equal(m.lines.length, 1);
});

test('견적일자는 형식이 맞을 때만 쓴다(아니면 오늘)', () => {
  assert.equal(quoteDate('2026-09-17'), '2026-09-17');
  assert.equal(quoteDate('2026-09-17T12:00:00Z'), '2026-09-17');
  assert.equal(quoteDate('17/09/2026'), null, '형식이 달라도 접수를 막지는 않는다 — 오늘로 둔다');
  assert.equal(quoteDate(''), null);
});

test('코드 없는 줄·수량 0 은 상대가 고쳐야 한다(우리가 추측하지 않는다)', () => {
  const bad = badQuoteLines([{ code: 'A', qty: 2 }, { code: null, qty: 1 }, { code: 'B', qty: 0 }]);
  assert.deepEqual(bad, [
    { linea: 2, motivo: 'codigo_requerido' },
    { linea: 3, codigo: 'B', motivo: 'cantidad_invalida' },
  ]);
  assert.deepEqual(badQuoteLines([{ code: 'A', qty: 1 }]), []);
});

test('조립기는 한 곳에 있다 — 화면과 수신 창구가 같은 것을 쓴다', () => {
  // 두 벌로 두면 코드 해석 규칙이 갈라지고, 「화면에서는 되는데 웹에서는 안 되는」 상태가 된다.
  const qr = readFileSync(new URL('../src/routes/quoteRoutes.js', import.meta.url), 'utf8');
  const cq = readFileSync(new URL('../src/routes/crmQuoteRoutes.js', import.meta.url), 'utf8');
  assert.ok(/from '\.\.\/quoteBuild\.js'/.test(qr), '화면 라우트가 공용 조립기를 써야 한다');
  assert.ok(/from '\.\.\/quoteBuild\.js'/.test(cq), '수신 창구도 같은 조립기를 써야 한다');
  assert.equal(/async function buildLines/.test(qr), false, '조립기가 두 벌이면 안 된다');
});

test('수신 창구는 customer_id 를 쓰지 않는다(코드로 잠근다)', () => {
  const cq = readFileSync(new URL('../src/routes/crmQuoteRoutes.js', import.meta.url), 'utf8');
  assert.equal(/b\.customer_id|body\.customer_id|m\.customerId/.test(cq), false,
    '숫자 고객번호를 읽는 코드가 생기면 NAJAR 사고가 되돌아온다');
  assert.ok(/rfc_norm=\$1/.test(cq), 'RFC 로 찾아야 한다');
});

// ── ② 실제 DB ──────────────────────────────────────────────────
const dbTest = PG ? test : test.skip;

dbTest('수신 → 견적 생성 · 멱등 · 문제 줄 · 확정 잠금 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const crmQuoteRoutes = (await import('../src/routes/crmQuoteRoutes.js')).default;

  const KEY = 'rfx_test_quote_key_0220';
  await query(`UPDATE integration_endpoints SET enabled=true, env='test', auth_token_test=$1
                WHERE key='crm_quote_request'`, [KEY]);
  const { invalidateEndpointCache } = await import('../src/integrations.js');
  invalidateEndpointCache();

  // 고객 둘: 승인된 고객(RFC 로 찾을 대상)과 승인 대기 고객.
  const rfcOk = 'QIN010203AA1';
  const rfcPend = 'QIN010203BB2';
  // 앞선 실패 실행이 남긴 찌꺼기를 먼저 치운다(시험은 몇 번을 돌려도 같아야 한다).
  await query(`DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM quotes WHERE external_quote_no LIKE 'COT-T-%')`);
  await query(`DELETE FROM quotes WHERE external_quote_no LIKE 'COT-T-%'`);
  await query(`DELETE FROM crm_inbound_log WHERE endpoint_key='crm_quote_request'`);
  await query(`DELETE FROM customers WHERE code IN ('T-Q001','T-Q002')`);
  await query(`DELETE FROM products WHERE code IN ('QTEST01','QTEST02')`);
  await query(`DELETE FROM users WHERE login_id='t_q_dir'`);

  const mk = async (code, name, rfc, appr) => Number((await query(
    `INSERT INTO customers (code, name, rfc, discount, credit_days, approval_status)
     VALUES ($1,$2,$3,10,30,$4) RETURNING id`, [code, name, rfc, appr])).rows[0].id);
  const cOk = await mk('T-Q001', 'CLIENTE COTIZA SA', rfcOk, 'approved');
  const cPend = await mk('T-Q002', 'CLIENTE PENDIENTE SA', rfcPend, 'pending');

  // 제품 둘: 정상 SKU 와 판매중단 SKU.
  const mkp = async (code, name, active) => Number((await query(
    `INSERT INTO products (code, name, list_price, stock_qty, is_active)
     VALUES ($1,$2,100,50,$3) RETURNING id`, [code, name, active])).rows[0].id);
  const pOk = await mkp('QTEST01', 'PRODUCTO OK', true);
  const pOff = await mkp('QTEST02', 'PRODUCTO DESCONTINUADO', false);

  const app = Fastify();
  await app.register(crmQuoteRoutes);
  const post = (payload, key = KEY) => app.inject({ method: 'POST',
    url: '/api/integrations/crm/quote', headers: { 'x-api-key': key }, payload });

  // 화면 쪽 라우트는 **진짜 가드**(authGuard + 권한)를 그대로 태워 시험한다.
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const quoteRoutes = (await import('../src/routes/quoteRoutes.js')).default;
  const dirId = Number((await query(
    `INSERT INTO users (login_id, name, role, pin_hash) VALUES ($1,$2,'director','x') RETURNING id`,
    ['t_q_dir', '견적시험 디렉터'])).rows[0].id);
  const app2 = Fastify();
  await app2.register(fastifyJwt, { secret: 'test-secret-0220' });
  await app2.register(quoteRoutes);
  await app2.ready();
  const dirToken = app2.jwt.sign({ sub: dirId });
  const asDirector = (method, url, payload) => app2.inject({ method, url, payload,
    headers: { authorization: 'Bearer ' + dirToken } });

  const madeQuotes = [];
  t.after(async () => {
    for (const id of madeQuotes) {
      await query(`DELETE FROM quote_lines WHERE quote_id=$1`, [id]);
      await query(`DELETE FROM quotes WHERE id=$1`, [id]);
    }
    await query(`DELETE FROM crm_inbound_log WHERE endpoint_key='crm_quote_request'`);
    await query(`DELETE FROM customers WHERE id IN ($1,$2)`, [cOk, cPend]);
    await query(`DELETE FROM products WHERE id IN ($1,$2)`, [pOk, pOff]);
    await query(`UPDATE integration_endpoints SET auth_token_test=NULL WHERE key='crm_quote_request'`);
    await query(`DELETE FROM users WHERE id=$1`, [dirId]);
    await app.close();
    await app2.close();
    await pool.end();
  });

  await t.test('키가 틀리면 401 이고 **이력에 남는다**', async () => {
    const r = await post({ rfc: rfcOk, lineas: [{ codigo: 'QTEST01', cantidad: 1 }] }, 'wrong-key');
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().codigoError, 'ERR_API_KEY');
    const log = (await query(
      `SELECT result, http_status FROM crm_inbound_log
        WHERE endpoint_key='crm_quote_request' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(log.result, 'rejected');
    assert.equal(Number(log.http_status), 401);
  });

  await t.test('정상 접수 — 견적이 만들어지고 고객은 RFC 로 붙는다', async () => {
    const r = await post({ cotizacionCrm: 'COT-T-0001', rfc: rfcOk, fecha: '2026-09-17',
      comentario: 'Urgente', lineas: [{ codigo: 'QTEST01', cantidad: 3 }] });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.codigoError, '0');
    assert.match(b.cotizacionErp, /^Q-2026-/);
    assert.deepEqual(b.lineasConProblema, []);
    madeQuotes.push(b.quoteId);

    const q = (await query(
      `SELECT customer_id, origin, external_quote_no, quote_date::text, status, memo, total_qty
         FROM quotes WHERE id=$1`, [b.quoteId])).rows[0];
    assert.equal(Number(q.customer_id), cOk, '고객은 RFC 로 붙어야 한다');
    assert.equal(q.origin, 'crm');
    assert.equal(q.external_quote_no, 'COT-T-0001', 'CRM 번호는 칼럼에 남는다(메모 안이 아니라)');
    assert.equal(q.quote_date, '2026-09-17');
    assert.equal(q.status, 'draft');
    assert.match(q.memo, /Urgente/);
    assert.equal(Number(q.total_qty), 3);

    const log = (await query(
      `SELECT result, erp_code, customer_id FROM crm_inbound_log
        WHERE endpoint_key='crm_quote_request' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(log.result, 'created');
    assert.equal(log.erp_code, b.cotizacionErp);
  });

  await t.test('같은 COT 를 다시 보내도 견적은 하나다(멱등)', async () => {
    const r = await post({ cotizacionCrm: 'COT-T-0001', rfc: rfcOk,
      lineas: [{ codigo: 'QTEST01', cantidad: 3 }] });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.quoteId, madeQuotes[0], '기존 견적 번호를 그대로 돌려줘야 한다');
    const n = (await query(
      `SELECT count(*)::int AS n FROM quotes WHERE external_quote_no='COT-T-0001'`)).rows[0].n;
    assert.equal(Number(n), 1);
  });

  await t.test('CRM 의 숫자 고객번호를 보내도 그 고객에 붙지 않는다', async () => {
    // 예전 사고의 재현: customer_id 를 넣어도 **RFC 가 이긴다.**
    const r = await post({ cotizacionCrm: 'COT-T-0002', customer_id: cPend, rfc: rfcOk,
      lineas: [{ codigo: 'QTEST01', cantidad: 1 }] });
    assert.equal(r.statusCode, 200);
    madeQuotes.push(r.json().quoteId);
    const q = (await query(`SELECT customer_id FROM quotes WHERE id=$1`, [r.json().quoteId])).rows[0];
    assert.equal(Number(q.customer_id), cOk, '숫자 id 는 무시되어야 한다');
  });

  await t.test('RFC 로 못 찾으면 접수하지 않고 「먼저 등록하라」고 답한다', async () => {
    const r = await post({ cotizacionCrm: 'COT-T-0003', rfc: 'NOEXISTE010101XX1',
      lineas: [{ codigo: 'QTEST01', cantidad: 1 }] });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().codigoError, 'ERR_CUSTOMER_NOT_FOUND');
    assert.match(r.json().mensaje, /registrarlo/);
    const log = (await query(
      `SELECT result FROM crm_inbound_log WHERE endpoint_key='crm_quote_request'
        ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(log.result, 'rejected', '거절도 이력에 남아야 한다 — 「보냈는데 없다」를 끝내려고 만든 것이다');
  });

  await t.test('승인 대기 고객은 아직 견적을 못 받는다', async () => {
    const r = await post({ cotizacionCrm: 'COT-T-0004', rfc: rfcPend,
      lineas: [{ codigo: 'QTEST01', cantidad: 1 }] });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().codigoError, 'ERR_CUSTOMER_NOT_APPROVED');
  });

  await t.test('RFC 가 아예 없으면 무엇이 필요한지 말해 준다', async () => {
    const r = await post({ cotizacionCrm: 'COT-T-0005', lineas: [{ codigo: 'QTEST01', cantidad: 1 }] });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().codigoError, 'ERR_REQUIRED_FIELD');
    assert.match(r.json().mensaje, /RFC/);
  });

  await t.test('못 찾은 코드·판매중단 SKU 는 접수하되 표시하고 확정을 잠근다', async () => {
    const r = await post({ cotizacionCrm: 'COT-T-0006', rfc: rfcOk, lineas: [
      { codigo: 'QTEST01', cantidad: 2 },
      { codigo: 'NO-EXISTE-99', cantidad: 1 },
      { codigo: 'QTEST02', cantidad: 5 },
    ] });
    assert.equal(r.statusCode, 200, '고객의 요청을 버리지 않는다');
    const b = r.json();
    madeQuotes.push(b.quoteId);
    const motivos = b.lineasConProblema.map((x) => x.motivo).sort();
    assert.deepEqual(motivos, ['inactive', 'not_found']);
    assert.ok(b.lineasConProblema.every((x) => x.detalle), '고객에게 보여 줄 스페인어 설명이 있어야 한다');

    const rows = (await query(
      `SELECT input_code, issue FROM quote_lines WHERE quote_id=$1 ORDER BY line_no`, [b.quoteId])).rows;
    assert.equal(rows[0].issue, null);
    assert.equal(rows[1].issue, 'not_found');
    assert.equal(rows[2].issue, 'inactive');

    // 확정 잠금 — 0원짜리 줄이 붙은 견적이 고객에게 나가면 안 된다.
    //   ⚠ 진짜 가드(authGuard + 견적 편집 권한)를 그대로 태워서 시험한다. 가드를 건너뛰면
    //     "테스트는 통과하는데 실제로는 401" 인 상태를 못 잡는다.
    const res = await asDirector('POST', `/api/quotes/${b.quoteId}/status`, { status: 'confirmed' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'quote_has_issues');
    assert.equal(res.json().items.length, 2);
    // 문제 줄을 지우면 확정된다.
    await query(`DELETE FROM quote_lines WHERE quote_id=$1 AND issue IS NOT NULL`, [b.quoteId]);
    const ok = await asDirector('POST', `/api/quotes/${b.quoteId}/status`, { status: 'confirmed' });
    assert.equal(ok.statusCode, 200);
  });

  await t.test('줄이 없거나 수량이 0 이면 상대에게 어느 줄인지 알려 준다', async () => {
    const none = await post({ cotizacionCrm: 'COT-T-0007', rfc: rfcOk, lineas: [] });
    assert.equal(none.statusCode, 400);
    assert.equal(none.json().codigoError, 'ERR_REQUIRED_FIELD');

    const bad = await post({ cotizacionCrm: 'COT-T-0008', rfc: rfcOk,
      lineas: [{ codigo: 'QTEST01', cantidad: 0 }] });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().codigoError, 'ERR_LINE_INVALID');
    assert.equal(bad.json().lineas[0].motivo, 'cantidad_invalida');
  });

  await t.test('수신 이력은 이 창구의 것만 센다', async () => {
    const { inboundCounts } = await import('../src/crmInboundLog.js');
    const c = await inboundCounts();
    assert.ok(c.crm_quote_request, '창구별로 집계돼야 한다');
    assert.ok(Number(c.crm_quote_request.created) >= 2);
    assert.ok(Number(c.crm_quote_request.rejected) >= 4);
  });
});
