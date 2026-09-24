// 20260924 · 제품 전송 속도·중지 — 연속 전송(pump) · 고객 우선 · 꺼진 창구가 막지 않음 · 중지 · CRM 불통 시 멈춤
//
//   배경: 예전 엔진은 20건 보내고 60초 쉬었다(분당 20건). 1건씩 형식이면 1,700제품 = 85분.
//   이제 한 번 시작하면 대기함이 빌 때까지 이어서 보낸다.
//
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/product_sync_pump.test.mjs
//   ⚠ 다른 제품 스위트와 같은 표를 쓴다 — 직렬로.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.CRM_SYNC_GAP_MS = '0';

let delayMs = 0;
const received = [];
const crm = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    setTimeout(() => {
      received.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ codigoError: '0', mensaje: 'OK' }));
    }, delayMs);
  });
});
await new Promise((r) => crm.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${crm.address().port}`;

const dbTest = PG ? test : test.skip;
const N = 60;

async function setup({ productEnabled = true, productUrl = `${BASE}/productos` } = {}) {
  const { query } = await import('../src/db.js');
  const { invalidateEndpointCache } = await import('../src/integrations.js');
  await query(`DELETE FROM crm_customer_outbox WHERE entity='product' OR origin='pump_test'`);
  await query(`DELETE FROM product_sync_runs`);
  await query(`DELETE FROM products WHERE code LIKE 'PX%'`);
  for (let i = 1; i <= N; i++) {
    await query(
      `INSERT INTO products (code, name, app, scode, list_price, stock_qty, is_active)
       VALUES ($1,$2,'NISSAN','1603005',100,5,true) ON CONFLICT (code) DO NOTHING`,
      [`PX${String(i).padStart(4, '0')}`, `PIEZA ${i}`]);
  }
  await query(
    `UPDATE integration_endpoints SET enabled=$1, env='test', url_test=$2, body_shape='item',
            timeout_ms=800, auto_send=false WHERE key='product'`, [productEnabled, productUrl]);
  await query(
    `UPDATE integration_endpoints SET enabled=true, env='test', url_test=$1, timeout_ms=3000
      WHERE key='customer_commercial'`, [`${BASE}/clientes`]);
  invalidateEndpointCache();
  return query;
}

/** 제품 적재 **뒤에** 고객 1건을 줄 세운다 — 예전이면 제품 60건 뒤에서 기다렸다. */
async function enqueueCustomer(query) {
  const c = (await query(
    `INSERT INTO customers (code, name, rfc) VALUES ('CX1','CLIENTE PRUEBA','XAXX010101000') RETURNING id`)).rows[0];
  await query(
    `INSERT INTO crm_customer_outbox (customer_id, entity, entity_id, endpoint_key, op, origin, rfc, payload, status)
     VALUES ($1,'customer',$1,'customer_commercial','upsert','pump_test','XAXX010101000','{"rfc":"XAXX010101000"}','pending')`,
    [c.id]);
}

async function waitIdle(pumpState, ms = 15000) {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 50));
  while (pumpState().running && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
}

dbTest('① 한 번 시작하면 끝까지 연속 전송 · 고객 건이 제품보다 먼저', async () => {
  const query = await setup();
  const { runCatalogSync } = await import('../src/productSync.js');
  const { pumpState } = await import('../src/crmSync.js');
  delayMs = 0;
  // 스케줄된 즉시전송이 돌기 전에 고객을 먼저 끼워 넣기 위해 적재만 하고 바로 고객을 넣는다
  const run = await runCatalogSync({ mode: 'full', origin: 'manual' });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.total_lotes, N, '1건씩 형식 — 요청 수 = 제품 수');
  await enqueueCustomer(query);
  received.length = 0;
  const t0 = Date.now();
  await waitIdle(pumpState);
  const pend = (await query(`SELECT COUNT(*)::int n FROM crm_customer_outbox WHERE status='pending' AND (entity='product' OR origin='pump_test')`)).rows[0].n;
  assert.equal(pend, 0, '대기함이 비어야 한다(예전: 20건만 나가고 나머지는 1분 뒤)');
  assert.equal(received.length, N + 1);
  const firstCustomer = received.findIndex((r) => r.url === '/clientes');
  assert.ok(firstCustomer >= 0 && firstCustomer < 25, `고객 건이 제품 60건 뒤에 줄 서지 않는다 (위치 ${firstCustomer})`);
  assert.ok(Date.now() - t0 < 10000, '60초 워커를 기다리지 않는다');
});

dbTest('② 전송 중지 — 남은 제품은 skipped, 더는 나가지 않는다', async () => {
  const query = await setup();
  const { runCatalogSync, cancelCatalogSync, CANCEL_NOTE } = await import('../src/productSync.js');
  const { pumpState } = await import('../src/crmSync.js');
  delayMs = 40;                                   // CRM 이 건당 40ms 로 답한다
  received.length = 0;
  const run = await runCatalogSync({ mode: 'full', origin: 'manual' });
  assert.equal(run.ok, true);
  while (received.length < 8) await new Promise((r) => setTimeout(r, 10));
  const r = await cancelCatalogSync();
  const atCancel = received.length;
  assert.ok(r.cancelled > 30, `남은 건이 닫혀야 한다 (${r.cancelled})`);
  await waitIdle(pumpState);
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(received.length <= atCancel + 1, `중지 후에는 진행 중이던 1건 외에 나가지 않는다 (${atCancel} → ${received.length})`);
  const st = (await query(
    `SELECT status, COUNT(*)::int n FROM crm_customer_outbox WHERE entity='product' GROUP BY status`)).rows;
  const by = Object.fromEntries(st.map((x) => [x.status, x.n]));
  assert.equal(by.pending || 0, 0);
  assert.equal((by.sent || 0) + (by.skipped || 0), N, JSON.stringify(by));
  assert.equal(by.sent, received.length, '이력의 sent 수 = 실제로 나간 수');
  const note = (await query(`SELECT last_error FROM crm_customer_outbox WHERE entity='product' AND status='skipped' LIMIT 1`)).rows[0];
  assert.equal(note.last_error, CANCEL_NOTE);
  delayMs = 0;
});

dbTest('③ 꺼진 창구의 대기 건이 앞자리를 막지 않는다(고객 창구 꺼짐 · 고객 30건 → 제품은 나간다)', async () => {
  const query = await setup();
  const { invalidateEndpointCache } = await import('../src/integrations.js');
  const { runCatalogSync } = await import('../src/productSync.js');
  const { pumpOutbox, pumpState } = await import('../src/crmSync.js');
  await query(`UPDATE integration_endpoints SET enabled=false WHERE key='customer_commercial'`);
  invalidateEndpointCache();
  // 고객 30건(우선순위가 제품보다 높다) — 예전 로직이면 이 30건이 매번 앞자리를 차지해 아무것도 안 나갔다
  const c = (await query(
    `INSERT INTO customers (code, name, rfc) VALUES ('CX1','CLIENTE PRUEBA','XAXX010101000') RETURNING id`)).rows[0];
  for (let i = 0; i < 30; i++) {
    await query(
      `INSERT INTO crm_customer_outbox (customer_id, entity, entity_id, endpoint_key, op, origin, rfc, payload, status)
       VALUES ($1,'customer',$1,'customer_commercial','upsert','pump_test','XAXX010101000','{"rfc":"XAXX010101000"}','pending')`,
      [c.id]);
  }
  received.length = 0;
  await runCatalogSync({ mode: 'full', origin: 'manual' });
  await waitIdle(pumpState);
  await pumpOutbox({});   // 혹시 즉시전송과 엇갈렸으면 한 번 더
  assert.equal(received.filter((x) => x.url === '/productos').length, N, '제품은 전부 나간다');
  const cu = (await query(
    `SELECT COUNT(*)::int n, MAX(attempts)::int a FROM crm_customer_outbox WHERE origin='pump_test' AND status='pending'`)).rows[0];
  assert.equal(cu.n, 30, '꺼진 창구의 건은 그대로 대기');
  assert.equal(cu.a, 0, '시도 횟수를 쓰지 않는다');
  await query(`UPDATE integration_endpoints SET enabled=true WHERE key='customer_commercial'`);
  await query(`DELETE FROM customers WHERE code='CX1'`);
  invalidateEndpointCache();
});

dbTest('④ CRM 이 응답하지 않으면 한 묶음(25건)에서 멈춘다', async () => {
  const query = await setup({ productUrl: 'http://127.0.0.1:1/productos' });
  const { runCatalogSync } = await import('../src/productSync.js');
  const { pumpState } = await import('../src/crmSync.js');
  await runCatalogSync({ mode: 'full', origin: 'manual' });
  await waitIdle(pumpState);
  const tried = (await query(
    `SELECT COUNT(*)::int n FROM crm_customer_outbox WHERE entity='product' AND attempts > 0`)).rows[0].n;
  assert.ok(tried <= 25, `연결 불가면 1,700건을 끝까지 두드리지 않는다 (${tried})`);
  assert.equal(pumpState().stopped, 'network');
  await query(`DELETE FROM crm_customer_outbox WHERE entity='product' OR origin='pump_test'`);
  await query(`DELETE FROM product_sync_runs`);
  await query(`DELETE FROM products WHERE code LIKE 'PX%'`);
  await query(`DELETE FROM customers WHERE code='CX1'`);
});

test('간격 설정 — 기본 50ms, 음수·문자는 기본값, 상한 5초', async () => {
  const { gapMs } = await import('../src/crmSync.js');
  const keep = process.env.CRM_SYNC_GAP_MS;
  delete process.env.CRM_SYNC_GAP_MS; assert.equal(gapMs(), 50);
  process.env.CRM_SYNC_GAP_MS = '-3'; assert.equal(gapMs(), 50);
  process.env.CRM_SYNC_GAP_MS = 'abc'; assert.equal(gapMs(), 50);
  process.env.CRM_SYNC_GAP_MS = '200'; assert.equal(gapMs(), 200);
  process.env.CRM_SYNC_GAP_MS = '99999'; assert.equal(gapMs(), 5000);
  process.env.CRM_SYNC_GAP_MS = keep;
});

test.after(async () => {
  crm.close();
  if (PG) { const { pool } = await import('../src/db.js'); await pool.end().catch(() => {}); }
});
