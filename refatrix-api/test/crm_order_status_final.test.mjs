// ERP → CRM 오더상태 (전송) — 끝 상태 expirado · eliminado (0296, 디렉터 지시 2026-10-26)
//
//   이 시험이 잠그는 것
//   ① 24시간 룰로 만료되면 expirado(8), 디렉터가 삭제를 승인하면 eliminado(9) 가 나간다 — 웹(COT) 견적만.
//   ② 끝 상태는 언제나 가장 큰 번호 — 그 뒤로는 진행 단계가 다시 나가지 않는다. 만료 → 삭제는 8 → 9.
//   ③ 삭제 **요청**만으로는 보내지 않는다(반려될 수 있다). 승인한 디렉터가 transactionUser.
//   ④ 훅이 못 나가도 90초 감시가 줍는다. 같은 끝 상태는 한 번만.
//   ⑤ 연동이 꺼져 있으면 아무것도 쌓지 않는다.
//
//   실행: TEST_PG_URL=postgres://... node --test test/crm_order_status_final.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

const { finalStepOf, buildOrderPayload, CRM_FINAL_STEPS, CRM_ORDER_STEPS } =
  await import('../src/orderStatusSync.js');

// ── 순수 로직 ─────────────────────────────────────────────────
test('끝 상태 번호 — 진행 4단계보다 크고, eliminado > expirado', () => {
  assert.deepEqual(CRM_FINAL_STEPS.map((s) => [s.seq, s.code, s.text]),
    [[8, 'expirado', 'Expirado'], [9, 'eliminado', 'Eliminado']]);
  assert.equal(CRM_ORDER_STEPS.length, 4, '진행 4단계는 그대로');
  assert.ok(Math.min(...CRM_FINAL_STEPS.map((s) => s.seq)) > Math.max(...CRM_ORDER_STEPS.map((s) => s.seq)));
});

test('finalStepOf — 언제 끝났다고 보나', () => {
  const del = '2026-10-26T15:00:00Z', exp = '2026-10-25T15:00:00Z';
  assert.equal(finalStepOf({ status: 'delete_pending', deleted_at: del }).code, 'eliminado', '삭제 승인');
  assert.equal(finalStepOf({ status: 'delete_pending', deleted_at: del }).at, del, '시각 = 승인 시각');
  assert.equal(finalStepOf({ status: 'delete_pending', deleted_at: null }), null, '요청만으로는 아니다(반려될 수 있다)');
  assert.equal(finalStepOf({ status: 'expired', deleted_at: null, reserve_expires_at: exp }).code, 'expirado');
  assert.equal(finalStepOf({ status: 'expired', reserve_expires_at: exp }).at, exp, '시각 = 예약 마감(만료) 시각');
  for (const st of ['draft', 'confirmed', 'converted', 'cancelled', 'pricelist']) {
    assert.equal(finalStepOf({ status: st, deleted_at: null }), null, `${st} 는 끝 상태가 아니다`);
  }
});

test('본문 — 끝 상태도 같은 계약서 모양, folioSat 없음', () => {
  const o = { id: 77, quote_no: 'COT-9', external_quote_no: 'COT-9', rfc: 'AAA010101AA1', sat_no: 'X-1' };
  const p8 = buildOrderPayload(o, 8, '2026-10-25T15:00:00.000Z', 'erp');
  assert.equal(p8.eventoId, 'ERP-77-8');
  assert.equal(p8.estatus, 'expirado');
  assert.equal(p8.estatusTexto, 'Expirado');
  assert.equal(p8.secuencia, 8);
  assert.equal(p8.fechaEstatus, '2026-10-25T15:00:00Z');
  assert.equal(p8.folioSat, undefined);
  const p9 = buildOrderPayload(o, 9, null, 'sebastian');
  assert.equal(p9.estatus, 'eliminado');
  assert.equal(p9.estatusTexto, 'Eliminado');
  assert.equal(p9.transactionUser, 'sebastian');
});

test('훅 — 만료 처리와 삭제 승인 둘 다에 있다', () => {
  const q = readFileSync(new URL('../src/routes/quoteRoutes.js', import.meta.url), 'utf8');
  assert.ok(/kickOrderFinal\(id, \{ origin: 'expired', app \}\)/.test(q), '24시간 만료 → expirado');
  assert.ok(/kickOrderFinal\(id, \{ origin: 'delete_approved', actorUserId: req\.ctx\.perm\.userId, app \}\)/.test(q),
    '삭제 승인 → eliminado');
  const approve = q.slice(q.indexOf("'/api/quotes/:id/delete-approve'"), q.indexOf("'/api/quotes/:id/delete-reject'"));
  assert.ok(approve.includes('kickOrderFinal'), '훅은 승인 라우트 안에 있어야 한다');
  const request = q.slice(q.indexOf("'/api/quotes/:id/delete-request'"), q.indexOf("'/api/quotes/:id/delete-approve'"));
  assert.equal(request.includes('kickOrderFinal'), false, '요청 단계에서는 보내지 않는다');
});

test('0296 마이그레이션 — 단계 장부가 8·9 를 받는다', () => {
  const sql = readFileSync(new URL('../migrations/0296_crm_order_status_final.sql', import.meta.url), 'utf8');
  assert.ok(/CHECK \(seq IN \(1, 2, 3, 4, 8, 9\)\)/.test(sql));
});

// ── 실제 DB + 모의 CRM ───────────────────────────────────────
const dbTest = PG ? test : test.skip;

dbTest('끝 상태 전송 — 전 과정 (실 DB · 모의 CRM)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const { invalidateEndpointCache } = await import('../src/integrations.js');
  const { drainOutbox } = await import('../src/crmSync.js');
  const os = await import('../src/orderStatusSync.js');

  const got = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null; try { body = JSON.parse(raw); } catch (_) {}
      got.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"codigoError":"0","mensaje":"Estatus actualizado"}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const KEY = 'rfx_test_commercial_key_0296';
  const INKEY = 'rfx_test_quote_key_0296';

  const LIKE = `(external_quote_no LIKE 'COT-OF%' OR quote_no LIKE 'Q-OF%')`;
  const clean = async () => {
    await query(`DELETE FROM crm_order_status_events WHERE quote_id IN (SELECT id FROM quotes WHERE ${LIKE})`);
    await query(`DELETE FROM crm_customer_outbox WHERE endpoint_key='order_status'`);
    for (const tb of ['product_dev_requests', 'quote_lines', 'stock_shortages', 'quote_shortages', 'stock_reservations']) {
      try { await query(`DELETE FROM ${tb} WHERE ${tb === 'product_dev_requests' ? 'source_quote_id' : 'quote_id'} IN (SELECT id FROM quotes WHERE ${LIKE})`); } catch (_) {}
    }
    await query(`DELETE FROM quotes WHERE ${LIKE}`);
    await query(`DELETE FROM crm_inbound_log WHERE endpoint_key='crm_quote_request'`);
    for (const tb of ['stage_log', 'customer_meetings', 'customer_stage_history', 'product_dev_requests',
      'crm_inbound_log', 'crm_customer_outbox', 'transactions']) {
      try { await query(`DELETE FROM ${tb} WHERE customer_id IN (SELECT id FROM customers WHERE code='T-OF01')`); } catch (_) {}
    }
    await query(`DELETE FROM customers WHERE code='T-OF01'`);
    await query(`DELETE FROM products WHERE code='OFTEST01'`);
  };
  await clean();

  const commercialUrl = `http://127.0.0.1:${port}/api/integrations/erp/customer-commercial`;
  await query(`UPDATE integration_endpoints SET url_test=$1, env='test', auth_in='query', auth_param='apiKey',
                 auth_token_test=$2 WHERE key='customer_commercial'`, [commercialUrl, KEY]);
  await query(`UPDATE integration_endpoints SET enabled=true, env='test', auth_token_test=$1 WHERE key='crm_quote_request'`, [INKEY]);
  await query(`UPDATE integration_endpoints SET url_test=$1, env='test', enabled=false, updated_by=NULL WHERE key='order_status'`,
    [`http://127.0.0.1:${port}/api/integrations/erp/order-status`]);
  invalidateEndpointCache();

  await query(`INSERT INTO customers (code, name, rfc, discount, credit_days, approval_status)
               VALUES ('T-OF01','CLIENTE FINAL SA','OFE010203AA1',10,30,'approved')`);
  await query(`INSERT INTO products (code, name, list_price, stock_qty, is_active) VALUES ('OFTEST01','PRODUCTO',100,50,true)`);
  const dirId = Number(((await query(`SELECT id FROM users WHERE login_id='t_of_dir'`)).rows[0]
    || (await query(`INSERT INTO users (login_id, name, role, pin_hash) VALUES ('t_of_dir','끝상태 디렉터','director','x') RETURNING id`)).rows[0]).id);

  const mkApp = async () => {
    const app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-0296' });
    await app.register((await import('../src/routes/crmQuoteRoutes.js')).default);
    await app.register((await import('../src/routes/quoteRoutes.js')).default);
    await app.register((await import('../src/routes/integrationRoutes.js')).default);
    await app.ready();
    return app;
  };
  const app = await mkApp();
  const tok = app.jwt.sign({ sub: dirId });
  const asDir = (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tok } });
  const postQuote = (cot) => app.inject({ method: 'POST', url: '/api/integrations/crm/quote',
    headers: { 'x-api-key': INKEY }, payload: { cotizacionCrm: cot, rfc: 'OFE010203AA1', lineas: [{ codigo: 'OFTEST01', cantidad: 1 }] } });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { await sleep(1900); await drainOutbox({ limit: 50 }); await sleep(50); };
  const msgs = (cot) => got.filter((g) => /order-status/.test(g.url) && (!cot || g.body.cotizacionCrm === cot));
  const seqs = async (qid) => (await query(
    `SELECT seq FROM crm_order_status_events WHERE quote_id=$1 ORDER BY seq`, [qid])).rows.map((r) => Number(r.seq));
  // 만료 스위퍼를 지금 한 번 돌린다 — 실제 코드 경로(finalizeExpiredQuotes → 훅). 라우트 등록 시 즉시 1회 돈다.
  const runExpirySweep = async () => {
    clearInterval(globalThis.__refatrixExpirySweeper); delete globalThis.__refatrixExpirySweeper;
    const a2 = Fastify(); await a2.register(fastifyJwt, { secret: 'x' });
    await a2.register((await import('../src/routes/quoteRoutes.js')).default); await a2.ready();
    await sleep(700); await a2.close();
  };

  t.after(async () => {
    clearInterval(globalThis.__refatrixExpirySweeper); delete globalThis.__refatrixExpirySweeper;
    try { await clean(); } catch (e) { console.error('cleanup', e.message); }
    await query(`UPDATE integration_endpoints SET auth_token_test=NULL, auth_in='header' WHERE key='customer_commercial'`);
    await query(`UPDATE integration_endpoints SET auth_token_test=NULL WHERE key='crm_quote_request'`);
    await query(`UPDATE integration_endpoints SET enabled=false WHERE key='order_status'`);
    await app.close(); srv.close(); await pool.end();
  });

  let qOff = null;
  await t.test('꺼져 있으면 만료돼도 아무것도 쌓지 않는다', async () => {
    qOff = (await postQuote('COT-OF-0000')).json().quoteId;
    await query(`UPDATE quotes SET reserve_expires_at = now() - interval '1 minute' WHERE id=$1`, [qOff]);
    await runExpirySweep();
    await settle();
    assert.equal((await query(`SELECT status FROM quotes WHERE id=$1`, [qOff])).rows[0].status, 'expired');
    assert.deepEqual(await seqs(qOff), []);
    assert.equal(msgs().length, 0);
    const r = await os.syncOrderFinal(qOff);
    assert.equal(r.reason, 'endpoint_disabled');
  });

  await t.test('켜고 따라잡기 → 이미 만료된 웹 견적은 expirado 1건(진행 단계를 지어내지 않는다)', async () => {
    await asDir('PUT', '/api/integrations/order_status', { enabled: true });
    invalidateEndpointCache();
    const sw = await asDir('POST', '/api/order-status/sweep', {});
    assert.equal(sw.statusCode, 200, sw.body);
    await settle();
    assert.deepEqual(await seqs(qOff), [8]);
    const m = msgs('COT-OF-0000');
    assert.deepEqual(m.map((x) => x.body.estatus), ['expirado']);
    assert.equal(m[0].body.eventoId, `ERP-${qOff}-8`);
    assert.ok(m[0].url.includes('apiKey=' + KEY), '상거래정보 키를 물려받아 실어야 한다');
  });

  let q1 = null;
  await t.test('24시간 룰 만료(실제 스위퍼) → Solicitud nueva 다음에 Expirado', async () => {
    q1 = (await postQuote('COT-OF-0001')).json().quoteId;
    await settle();
    assert.deepEqual(await seqs(q1), [1]);
    await query(`UPDATE quotes SET reserve_expires_at = now() - interval '1 minute' WHERE id=$1`, [q1]);
    await runExpirySweep();
    await settle();
    assert.deepEqual(await seqs(q1), [1, 8]);
    const m = msgs('COT-OF-0001');
    assert.deepEqual(m.map((x) => x.body.estatus), ['solicitud_nueva', 'expirado']);
    assert.equal(m[1].body.secuencia, 8);
    assert.equal(m[1].body.transactionUser, 'erp', '자동 만료는 erp');
    const ob = (await query(`SELECT origin FROM crm_customer_outbox WHERE endpoint_key='order_status' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [q1])).rows[0];
    assert.equal(ob.origin, 'order_expired', '감시가 아니라 만료 훅이 보냈어야 한다');
  });

  await t.test('같은 끝 상태는 한 번만 — 훅·감시가 동시에 와도', async () => {
    const outs = await Promise.all([1, 2, 3, 4].map(() => os.syncOrderFinal(q1, { origin: 'sweep' })));
    assert.equal(outs.reduce((s, o) => s + o.queued.length, 0), 0);
    const sw = await os.sweepOrderStatus();
    assert.equal(sw.queued, 0);
    await settle();
    assert.equal(msgs('COT-OF-0001').length, 2);
  });

  await t.test('만료된 견적을 삭제 승인 → Eliminado(9) 가 이어서 나간다 · 승인한 디렉터 이름', async () => {
    const rq = await asDir('POST', `/api/quotes/${q1}/delete-request`, { reason: 'cliente canceló' });
    assert.equal(rq.statusCode, 200, rq.body);
    await settle();
    assert.deepEqual(await seqs(q1), [1, 8], '요청만으로는 보내지 않는다');
    const ap = await asDir('POST', `/api/quotes/${q1}/delete-approve`, {});
    assert.equal(ap.statusCode, 200, ap.body);
    await settle();
    assert.deepEqual(await seqs(q1), [1, 8, 9]);
    const last = msgs('COT-OF-0001').at(-1).body;
    assert.equal(last.estatus, 'eliminado');
    assert.equal(last.estatusTexto, 'Eliminado');
    assert.equal(last.secuencia, 9);
    assert.equal(last.transactionUser, 't_of_dir');
  });

  await t.test('포장 중(Surtiendo) 견적 삭제 승인 → Eliminado · 그 뒤 진행 단계는 다시 안 나간다', async () => {
    const q2 = (await postQuote('COT-OF-0002')).json().quoteId;
    await settle();
    const pr = await asDir('POST', `/api/quotes/${q2}/packing-printed`, {});
    assert.equal(pr.statusCode, 200, pr.body);
    await settle();
    assert.deepEqual(await seqs(q2), [1, 2]);
    await asDir('POST', `/api/quotes/${q2}/delete-request`, { reason: 'duplicada' });
    await asDir('POST', `/api/quotes/${q2}/delete-approve`, {});
    await settle();
    assert.deepEqual(await seqs(q2), [1, 2, 9]);
    // 삭제된 견적에 진행 단계를 다시 보내려 해도 나가지 않는다
    const again = await os.syncOrderStatus(q2, { origin: 'sweep' });
    assert.equal(again.queued.length, 0);
    await os.sweepOrderStatus();
    await settle();
    assert.deepEqual(msgs('COT-OF-0002').map((x) => x.body.estatus), ['solicitud_nueva', 'surtiendo', 'eliminado']);
  });

  await t.test('삭제 반려는 보내지 않는다', async () => {
    const q3 = (await postQuote('COT-OF-0003')).json().quoteId;
    await settle();
    await asDir('POST', `/api/quotes/${q3}/delete-request`, { reason: 'x' });
    const rj = await asDir('POST', `/api/quotes/${q3}/delete-reject`, {});
    assert.equal(rj.statusCode, 200, rj.body);
    await os.sweepOrderStatus();
    await settle();
    assert.deepEqual(await seqs(q3), [1]);
  });

  await t.test('훅이 못 나갔어도 감시가 줍는다 (삭제 승인 · 만료)', async () => {
    const q4 = (await postQuote('COT-OF-0004')).json().quoteId;
    const q5 = (await postQuote('COT-OF-0005')).json().quoteId;
    await settle();
    // 훅 없이 DB 만 바뀐 상황(예: 서버 재시작 직전)
    await query(`UPDATE quotes SET status='delete_pending', deleted_at=now() WHERE id=$1`, [q4]);
    await query(`UPDATE quotes SET status='expired' WHERE id=$1`, [q5]);
    const sw = await os.sweepOrderStatus();
    assert.ok(sw.queued >= 2, JSON.stringify(sw));
    await settle();
    assert.deepEqual(await seqs(q4), [1, 9]);
    assert.deepEqual(await seqs(q5), [1, 8]);
  });

  await t.test('ERP 화면 견적은 삭제 승인해도 보내지 않는다', async () => {
    const own = Number((await query(
      `INSERT INTO quotes (quote_no, customer_id, status) VALUES ('Q-OF-9001',(SELECT id FROM customers WHERE code='T-OF01'),'draft') RETURNING id`)).rows[0].id);
    await asDir('POST', `/api/quotes/${own}/delete-request`, { reason: 'x' });
    await asDir('POST', `/api/quotes/${own}/delete-approve`, {});
    await settle();
    assert.equal((await os.syncOrderFinal(own)).reason, 'not_crm_quote');
    assert.deepEqual(await seqs(own), []);
  });

  await t.test('현황(8·9 집계) · 견적 1건 확인(삭제된 견적도)', async () => {
    const ov = await asDir('GET', '/api/order-status/overview');
    assert.equal(ov.statusCode, 200, ov.body);
    const d = ov.json();
    assert.deepEqual(d.steps.map((s) => s.seq), [1, 2, 3, 4, 8, 9]);
    assert.ok(d.counts[9] >= 3, JSON.stringify(d.counts));
    assert.ok(d.counts[8] >= 2, JSON.stringify(d.counts));
    const one = await asDir('GET', '/api/order-status/quote?q=COT-OF-0001');
    assert.equal(one.statusCode, 200, one.body);
    assert.equal(one.json().crm_status, 'eliminado');
    assert.equal(one.json().deleted, true);
    assert.deepEqual(one.json().sent.map((s) => Number(s.seq)), [1, 8, 9]);
  });
});
