// ERP → CRM 오더상태 (전송) — 0227
//
//   이 시험이 잠그는 것
//   ① CRM 4단계는 **수주 SLA 와 같은 판정**에서 나온다(규칙이 두 벌이면 언젠가 엇갈린다).
//   ② 단계는 앞으로만 가고, **같은 단계는 한 번만** 나간다(훅과 감시가 동시에 봐도).
//   ③ 건너뛴 단계는 지어내지 않는다.
//   ④ 웹(COT) 견적만 보낸다. 취소·만료는 보내지 않는다.
//   ⑤ 꺼져 있으면 아무것도 쌓지 않고, 켜면 따라잡는다.
//   ⑥ 주소·키는 「고객 상거래정보」와 같다 — 키는 복사가 아니라 **물려받는다**.
//
//   실행: TEST_PG_URL=postgres://... node --test test/crm_order_status.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

const { crmSeqForStage, reachedSteps, buildOrderPayload, CRM_ORDER_STEPS } =
  await import('../src/orderStatusSync.js');

// ── ① 순수 로직 ────────────────────────────────────────────────
test('CRM 4단계 ↔ 수주 SLA 단계 대응(디렉터 정의 2026-09-23)', () => {
  assert.equal(crmSeqForStage('created'), 1, '견적이 만들어지면 Solicitud nueva');
  assert.equal(crmSeqForStage('printing'), 2, '포장 단계로 넘어가면 Surtiendo');
  assert.equal(crmSeqForStage('packed'), 3, '포장 완료 = SAT 발행 단계 → Preparando despacho');
  assert.equal(crmSeqForStage('await_sat'), 3);
  assert.equal(crmSeqForStage('await_collect'), 4, 'SAT 등록 + 수금 단계 → OC Enviada');
  assert.equal(crmSeqForStage('collected'), 4, '수금이 끝나도 CRM 에는 OC Enviada 그대로');
  for (const k of ['cancelled', 'expired', 'pricelist', 'backorder', 'other', undefined]) {
    assert.equal(crmSeqForStage(k), 0, `${k} 는 4단계 어디에도 없다 — 지어내 보내지 않는다`);
  }
  assert.deepEqual(CRM_ORDER_STEPS.map((s) => s.text),
    ['Solicitud nueva', 'Surtiendo', 'Preparando despacho', 'OC Enviada']);
});

test('판정 규칙은 한 곳 — SLA 와 같은 함수를 쓴다', () => {
  const src = readFileSync(new URL('../src/orderStatusSync.js', import.meta.url), 'utf8');
  assert.ok(/from '\.\/quoteStage\.js'/.test(src), 'computeQuoteStage 를 가져다 써야 한다');
  assert.equal(/sat_no\s*&&\s*!String\(o\.sat_no\)\.startsWith\('TMP-'\)\s*\)\s*return/.test(src), false,
    '단계 판정을 따로 복제하면 안 된다');
});

test('거친 단계만 — 건너뛴 단계는 지어내지 않는다', () => {
  const t0 = '2026-09-23T10:00:00Z';
  // 지시서 출력 → 포장 → SAT: 네 단계 모두
  const full = { created_at: t0, packing_printed_at: '2026-09-23T11:00:00Z', packed_at: '2026-09-23T12:00:00Z',
    converted_at: '2026-09-23T13:00:00Z', sat_entered_at: '2026-09-23T14:00:00Z' };
  assert.deepEqual(reachedSteps(full, 4).map((s) => s.seq), [1, 2, 3, 4]);
  assert.equal(reachedSteps(full, 4)[3].at, '2026-09-23T14:00:00Z', 'OC Enviada 시각은 SAT 입력 시각');
  // 지시서·포장 없이 곧바로 실제 SAT 로 전환: 1 과 4 만
  const direct = { created_at: t0, converted_at: '2026-09-23T13:00:00Z', sat_entered_at: '2026-09-23T13:00:00Z' };
  assert.deepEqual(reachedSteps(direct, 4).map((s) => s.seq), [1, 4]);
  // 포장 없이 전환해 SAT 대기: 1 · 3
  assert.deepEqual(reachedSteps({ created_at: t0, converted_at: t0 }, 3).map((s) => s.seq), [1, 3]);
  // 지금보다 높은 단계는 절대 없다
  assert.deepEqual(reachedSteps(full, 2).map((s) => s.seq), [1, 2]);
  assert.deepEqual(reachedSteps(full, 0), []);
});

test('본문 — 계약서 이름 그대로, 빈 선택 필드는 키째 뺀다', () => {
  const o = { id: 142, quote_no: 'COT-1', external_quote_no: 'COT-1', rfc: 'AIAC8310204A0',
    sat_no: 'A1B2-C3', customer_po_no: '' };
  const p2 = buildOrderPayload(o, 2, '2026-09-23T16:05:12.345Z', 'admin');
  assert.deepEqual(Object.keys(p2).sort(), ['cotizacionCrm', 'cotizacionErp', 'estatus', 'estatusTexto',
    'eventoId', 'fechaEstatus', 'rfc', 'secuencia', 'transactionUser'].sort());
  assert.equal(p2.eventoId, 'ERP-142-2', '같은 단계의 재전송은 같은 eventoId — CRM 이 걸러 낼 수 있게');
  assert.equal(p2.estatus, 'surtiendo');
  assert.equal(p2.fechaEstatus, '2026-09-23T16:05:12Z');
  assert.equal(p2.folioSat, undefined, 'SAT 번호는 OC Enviada 에만 싣는다');
  const p4 = buildOrderPayload({ ...o, customer_po_no: 'OC-77' }, 4, null, 'admin');
  assert.equal(p4.folioSat, 'A1B2-C3');
  assert.equal(p4.ordenCompraCliente, 'OC-77');
  assert.equal(buildOrderPayload({ ...o, sat_no: 'TMP-9' }, 4, null, 'x').folioSat, undefined,
    '임시 SAT 번호(TMP-)는 보내지 않는다');
});

test('단계를 바꾸는 지점마다 훅이 있다(즉시 전송)', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const q = read('../src/routes/quoteRoutes.js');
  assert.ok(/kickOrderStatus\(id, \{ origin: 'packing_printed'/.test(q), '포장지시서 출력 → Surtiendo');
  assert.ok(/kickOrderStatus\(id, \{ origin: 'converted'/.test(q), '전환');
  assert.ok(/kickOrderStatus\(id, \{ origin: 'packed' \}\)/.test(read('../src/packedGate.js')), '포장완료');
  assert.ok(/kickOrderStatusByInvoice\(id, \{ origin: 'sat_entered'/.test(read('../src/routes/salesRoutes.js')), 'SAT 입력');
  assert.ok(/kickOrderStatus\(result\.q\.id, \{ origin: 'crm_quote_created'/.test(read('../src/routes/crmQuoteRoutes.js')), '웹 견적 접수');
  const s = read('../src/server.js');
  assert.ok(/startOrderStatusWorker\(app\)/.test(s), '감시(안전망)가 서버에 등록돼야 한다 — 빠지면 놓친 단계가 영영 안 나간다');
});

// ── ② 실제 DB + 모의 CRM ───────────────────────────────────────
const dbTest = PG ? test : test.skip;

dbTest('오더상태 전송 — 전 과정 (실 DB · 모의 CRM)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const { invalidateEndpointCache } = await import('../src/integrations.js');
  const { drainOutbox } = await import('../src/crmSync.js');
  const os = await import('../src/orderStatusSync.js');

  // 모의 CRM — 받은 요청을 적고, 모드에 따라 성공/500 을 돌려준다.
  const got = [];
  let mode = 'ok';
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null; try { body = JSON.parse(raw); } catch (_) {}
      got.push({ url: req.url, body });
      if (mode === 'fail') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"codigoError":"ERR_INTERNAL"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"codigoError":"0","mensaje":"Estatus actualizado"}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const KEY = 'rfx_test_commercial_key_0227';
  const INKEY = 'rfx_test_quote_key_0227';

  // 찌꺼기 정리
  const clean = async () => {
    await query(`DELETE FROM crm_order_status_events WHERE quote_id IN (SELECT id FROM quotes WHERE external_quote_no LIKE 'COT-OS%' OR quote_no LIKE 'Q-OS%')`);
    await query(`DELETE FROM crm_customer_outbox WHERE endpoint_key='order_status'`);
    await query(`DELETE FROM product_dev_requests WHERE source_quote_id IN (SELECT id FROM quotes WHERE external_quote_no LIKE 'COT-OS%' OR quote_no LIKE 'Q-OS%')`);
    await query(`DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM quotes WHERE external_quote_no LIKE 'COT-OS%' OR quote_no LIKE 'Q-OS%')`);
    await query(`UPDATE quotes SET invoice_id=NULL WHERE external_quote_no LIKE 'COT-OS%' OR quote_no LIKE 'Q-OS%'`);
    await query(`DELETE FROM quotes WHERE external_quote_no LIKE 'COT-OS%' OR quote_no LIKE 'Q-OS%'`);
    await query(`DELETE FROM sales_invoices WHERE memo='T-OS'`);
    await query(`DELETE FROM crm_inbound_log WHERE endpoint_key='crm_quote_request'`);
    // 포장지시서 출력은 고객 영업단계를 자동 전진시킨다(autoStage) — 그 흔적부터 치운다.
    for (const tb of ['stage_log', 'customer_meetings', 'customer_stage_history', 'product_dev_requests',
      'crm_inbound_log', 'crm_customer_outbox', 'transactions']) {
      try { await query(`DELETE FROM ${tb} WHERE customer_id IN (SELECT id FROM customers WHERE code='T-OS01')`); } catch (_) {}
    }
    await query(`DELETE FROM customers WHERE code='T-OS01'`);
    await query(`DELETE FROM products WHERE code='OSTEST01'`);
  };
  await clean();

  // 「고객 상거래정보」 = 쿼리스트링 키(운영 실측과 같은 모양)
  const commercialUrl = `http://127.0.0.1:${port}/api/integrations/erp/customer-commercial`;
  await query(`UPDATE integration_endpoints SET url_test=$1, env='test', auth_in='query', auth_param='apiKey',
                 auth_token_test=$2 WHERE key='customer_commercial'`, [commercialUrl, KEY]);
  await query(`UPDATE integration_endpoints SET enabled=true, env='test', auth_token_test=$1 WHERE key='crm_quote_request'`, [INKEY]);

  // 0227 시드를 **지금 설정 위에서** 다시 태운다 — 주소 도출·키 물려받기를 실제 SQL 로 확인.
  await query(`DELETE FROM integration_endpoints WHERE key='order_status'`);
  await query(readFileSync(new URL('../migrations/0227_crm_order_status.sql', import.meta.url), 'utf8'));
  invalidateEndpointCache();

  const cust = Number((await query(
    `INSERT INTO customers (code, name, rfc, discount, credit_days, approval_status)
     VALUES ('T-OS01','CLIENTE ESTATUS SA','OSE010203AA1',10,30,'approved') RETURNING id`)).rows[0].id);
  await query(`INSERT INTO products (code, name, list_price, stock_qty, is_active) VALUES ('OSTEST01','PRODUCTO',100,50,true)`);
  // 사용자는 감사로그가 참조하므로 지우지 않고 다시 쓴다.
  const dirId = Number(((await query(`SELECT id FROM users WHERE login_id='t_os_dir'`)).rows[0]
    || (await query(`INSERT INTO users (login_id, name, role, pin_hash) VALUES ('t_os_dir','오더상태 디렉터','director','x') RETURNING id`)).rows[0]).id);

  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret-0227' });
  await app.register((await import('../src/routes/crmQuoteRoutes.js')).default);
  await app.register((await import('../src/routes/quoteRoutes.js')).default);
  await app.register((await import('../src/routes/salesRoutes.js')).default);
  await app.register((await import('../src/routes/integrationRoutes.js')).default);
  await app.ready();
  const tok = app.jwt.sign({ sub: dirId });
  const asDir = (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tok } });
  const postQuote = (payload) => app.inject({ method: 'POST', url: '/api/integrations/crm/quote',
    headers: { 'x-api-key': INKEY }, payload });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { await sleep(1900); await drainOutbox({ limit: 50 }); await sleep(50); };
  const orderMsgs = () => got.filter((g) => /order-status/.test(g.url));
  const events = async (qid) => (await query(
    `SELECT seq, status, outbox_id FROM crm_order_status_events WHERE quote_id=$1 ORDER BY seq`, [qid])).rows;

  t.after(async () => {
    try { await clean(); } catch (e) { console.error('cleanup', e.message); }
    await query(`UPDATE integration_endpoints SET auth_token_test=NULL, auth_in='header' WHERE key='customer_commercial'`);
    await query(`UPDATE integration_endpoints SET auth_token_test=NULL WHERE key='crm_quote_request'`);
    await query(`UPDATE integration_endpoints SET enabled=false WHERE key='order_status'`);
    await app.close();
    srv.close();
    await pool.end();
  });

  await t.test('주소는 같은 서버의 …/order-status · 키는 상거래정보에서 물려받는다', async () => {
    const ep = (await query(`SELECT * FROM integration_endpoints WHERE key='order_status'`)).rows[0];
    assert.equal(ep.url_test, `http://127.0.0.1:${port}/api/integrations/erp/order-status`);
    assert.equal(ep.auth_from, 'customer_commercial');
    assert.equal(ep.auth_in, 'query', '키 싣는 자리도 상거래정보와 같게');
    assert.equal(ep.auth_param, 'apiKey');
    assert.equal(ep.auth_token_test, null, '키를 복사하지 않는다 — 두 곳에 두면 언젠가 한쪽만 바뀐다');
    assert.equal(ep.enabled, false, '처음에는 꺼진 채로 들어간다');
  });

  let qid = null;
  await t.test('꺼져 있으면 웹 견적이 들어와도 아무것도 쌓지 않는다', async () => {
    const r = await postQuote({ cotizacionCrm: 'COT-OS-0001', rfc: 'OSE010203AA1',
      lineas: [{ codigo: 'OSTEST01', cantidad: 2 }] });
    assert.equal(r.statusCode, 200);
    qid = r.json().quoteId;
    await settle();
    assert.deepEqual(await events(qid), []);
    assert.equal(orderMsgs().length, 0);
  });

  await t.test('켜고 따라잡기 → Solicitud nueva 1건 · 키가 실려 나간다', async () => {
    const put = await asDir('PUT', '/api/integrations/order_status', { enabled: true });
    assert.equal(put.statusCode, 200, put.body);
    invalidateEndpointCache();
    const sw = await asDir('POST', '/api/order-status/sweep', {});
    assert.equal(sw.statusCode, 200, sw.body);
    assert.equal(sw.json().queued, 1);
    await settle();
    const m = orderMsgs();
    assert.equal(m.length, 1);
    assert.equal(m[0].body.estatus, 'solicitud_nueva');
    assert.equal(m[0].body.cotizacionCrm, 'COT-OS-0001');
    assert.equal(m[0].body.rfc, 'OSE010203AA1');
    assert.equal(m[0].body.eventoId, `ERP-${qid}-1`);
    assert.ok(m[0].url.includes('apiKey=' + KEY), '상거래정보의 키가 쿼리스트링으로 실려야 한다');
    const ob = (await query(`SELECT status, entity, customer_id FROM crm_customer_outbox WHERE endpoint_key='order_status'`)).rows;
    assert.equal(ob[0].status, 'sent');
    assert.equal(ob[0].entity, 'order');
    assert.equal(ob[0].customer_id, null, '고객 건으로 섞이면 「고객을 보낸 적 있다」 판정이 흐려진다');
  });

  await t.test('다시 훑어도 같은 단계는 다시 안 나간다 (동시에 5번)', async () => {
    const outs = await Promise.all([1, 2, 3, 4, 5].map(() => os.syncOrderStatus(qid, { origin: 'sweep' })));
    assert.equal(outs.reduce((s, o) => s + o.queued.length, 0), 0);
    await settle();
    assert.equal(orderMsgs().length, 1);
  });

  await t.test('포장지시서 출력(실제 라우트) → Surtiendo 가 즉시 나간다', async () => {
    const r = await asDir('POST', `/api/quotes/${qid}/packing-printed`, {});
    assert.equal(r.statusCode, 200, r.body);
    await settle();
    const m = orderMsgs();
    assert.equal(m.length, 2);
    assert.equal(m[1].body.estatus, 'surtiendo');
    assert.equal(m[1].body.secuencia, 2);
    const ob = (await query(`SELECT origin FROM crm_customer_outbox WHERE endpoint_key='order_status' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(ob.origin, 'order_packing_printed', '감시가 아니라 훅이 보냈어야 한다');
  });

  let invId = null;
  await t.test('포장완료 → Preparando despacho · 전환(TMP SAT)으로는 더 안 나간다', async () => {
    await query(`UPDATE quotes SET packed_at=now() WHERE id=$1`, [qid]);
    await os.sweepOrderStatus();
    await settle();
    assert.equal(orderMsgs().length, 3);
    assert.equal(orderMsgs()[2].body.estatus, 'preparando_despacho');
    invId = Number((await query(
      `INSERT INTO sales_invoices (sat_no, customer_id, inv_date, due_date, total_mxn, memo)
       VALUES ('TMP-OS-1',$1,CURRENT_DATE,CURRENT_DATE+30,232,'T-OS') RETURNING id`, [cust])).rows[0].id);
    await query(`UPDATE quotes SET status='converted', invoice_id=$1 WHERE id=$2`, [invId, qid]);
    await os.sweepOrderStatus();
    await settle();
    assert.equal(orderMsgs().length, 3, 'SAT 대기도 같은 3단계 — 새로 보낼 것이 없다');
  });

  await t.test('SAT 번호 등록(실제 라우트) → OC Enviada + folioSat', async () => {
    const r = await asDir('POST', `/api/sales/${invId}/sat-no`, { sat_no: 'OS-SAT-0001' });
    assert.equal(r.statusCode, 200, r.body);
    await settle();
    const m = orderMsgs();
    assert.equal(m.length, 4);
    assert.equal(m[3].body.estatus, 'oc_enviada');
    assert.equal(m[3].body.estatusTexto, 'OC Enviada');
    assert.equal(m[3].body.folioSat, 'OS-SAT-0001');
    assert.deepEqual((await events(qid)).map((e) => Number(e.seq)), [1, 2, 3, 4]);
    // 4 단계에 닿은 견적은 감시 대상에서 빠진다
    const again = await os.sweepOrderStatus();
    assert.equal(again.queued, 0);
  });

  await t.test('건너뛴 단계는 지어내지 않는다 — 곧바로 실제 SAT 면 1 · 4 만', async () => {
    const r = await postQuote({ cotizacionCrm: 'COT-OS-0002', rfc: 'OSE010203AA1',
      lineas: [{ codigo: 'OSTEST01', cantidad: 1 }] });
    const q2 = r.json().quoteId;
    await settle();   // 접수 훅 → 1
    const inv2 = Number((await query(
      `INSERT INTO sales_invoices (sat_no, sat_entered_at, customer_id, inv_date, due_date, total_mxn, memo)
       VALUES ('OS-SAT-0002', now(), $1, CURRENT_DATE, CURRENT_DATE+30, 116, 'T-OS') RETURNING id`, [cust])).rows[0].id);
    await query(`UPDATE quotes SET status='converted', invoice_id=$1 WHERE id=$2`, [inv2, q2]);
    await os.sweepOrderStatus();
    await settle();
    assert.deepEqual((await events(q2)).map((e) => Number(e.seq)), [1, 4]);
    const mine = orderMsgs().filter((g) => g.body.cotizacionCrm === 'COT-OS-0002').map((g) => g.body.estatus);
    assert.deepEqual(mine, ['solicitud_nueva', 'oc_enviada'], '접수는 훅으로 즉시, 나머지는 실제로 거친 것만');
  });

  await t.test('ERP 화면 견적 · 취소된 견적은 보내지 않는다', async () => {
    const own = Number((await query(
      `INSERT INTO quotes (quote_no, customer_id, status) VALUES ('Q-OS-9001',$1,'draft') RETURNING id`, [cust])).rows[0].id);
    const r = await os.syncOrderStatus(own);
    assert.equal(r.reason, 'not_crm_quote');
    const r3 = await postQuote({ cotizacionCrm: 'COT-OS-0003', rfc: 'OSE010203AA1',
      lineas: [{ codigo: 'OSTEST01', cantidad: 1 }] });
    const q3 = r3.json().quoteId;
    await settle();
    await query(`UPDATE quotes SET status='cancelled', packing_printed_at=now() WHERE id=$1`, [q3]);
    const out = await os.syncOrderStatus(q3);
    assert.equal(out.queued.length, 0, '취소는 4단계에 없다');
    assert.deepEqual((await events(q3)).map((e) => Number(e.seq)), [1]);
  });

  await t.test('CRM 이 500 을 주면 재시도 대기 · 단계 장부는 하나 · 재전송은 같은 eventoId', async () => {
    const r = await postQuote({ cotizacionCrm: 'COT-OS-0004', rfc: 'OSE010203AA1',
      lineas: [{ codigo: 'OSTEST01', cantidad: 1 }] });
    const q4 = r.json().quoteId;
    mode = 'fail';
    await settle();
    const row = (await query(`SELECT id, status, attempts FROM crm_customer_outbox
      WHERE endpoint_key='order_status' AND entity_id=$1`, [q4])).rows;
    assert.equal(row.length, 1);
    assert.equal(row[0].status, 'pending', '실패는 사라지지 않고 재시도를 기다린다');
    assert.equal(Number(row[0].attempts), 1);
    const le = (await query(`SELECT last_error FROM crm_customer_outbox WHERE id=$1`, [row[0].id])).rows[0].last_error;
    assert.equal(/신원/.test(le || ''), false, '오더 건에는 고객 신원 대조 문구를 붙이지 않는다');
    await os.sweepOrderStatus();
    assert.equal((await events(q4)).length, 1, '실패 중에 감시가 돌아도 새 건을 만들지 않는다');
    mode = 'ok';
    await query(`UPDATE crm_customer_outbox SET next_attempt_at=now() WHERE id=$1`, [row[0].id]);
    await drainOutbox({ limit: 50 });
    const last = orderMsgs().filter((g) => g.body.cotizacionCrm === 'COT-OS-0004');
    assert.equal(last.length, 2, '실패 1번 + 재시도 1번');
    assert.equal(last[0].body.eventoId, last[1].body.eventoId, '재시도는 같은 eventoId');
  });

  await t.test('연결 테스트는 오더 본문을 보낸다(고객 본문 아님)', async () => {
    const n0 = orderMsgs().length;
    const r = await asDir('POST', '/api/integrations/order_status/test', { customer_query: 'T-OS01' });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.equal(b.ok, true);
    assert.ok(b.request.payload.estatus, '오더 단계가 실려야 한다');
    assert.equal(b.request.payload.discountPercent, undefined, '고객 상거래 본문이 나가면 안 된다');
    assert.equal(orderMsgs().length, n0 + 1);
    assert.equal(b.request.auth.borrowed_from != null, true, '물려받은 키라고 알려 줘야 한다');
  });

  await t.test('현황 · 견적 1건 확인', async () => {
    const ov = await asDir('GET', '/api/order-status/overview');
    assert.equal(ov.statusCode, 200, ov.body);
    const d = ov.json();
    assert.equal(d.ready, true);
    assert.ok(d.counts[4] >= 2);
    assert.ok(d.recent.length >= 5);
    const one = await asDir('GET', '/api/order-status/quote?q=COT-OS-0001');
    assert.equal(one.json().crm_status, 'oc_enviada');
    assert.equal(one.json().sent.length, 4);
    // 꺼져 있을 때 따라잡기를 누르면 이유를 말한다
    await asDir('PUT', '/api/integrations/order_status', { enabled: false });
    invalidateEndpointCache();
    const sw = await asDir('POST', '/api/order-status/sweep', {});
    assert.equal(sw.statusCode, 409);
    assert.equal(sw.json().error, 'endpoint_disabled');
  });
});
