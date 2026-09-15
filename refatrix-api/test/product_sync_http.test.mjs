// 제품 카탈로그 전송 — 실서버(buildApp) HTTP 스모크
//   권한(디렉터 전용) · 설정 저장 검증 · 미리보기 · 적재 · 이력 조회까지 실제 라우트를 때린다.
//   실행: TEST_PG_URL=postgres://... node --test test/product_sync_http.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const PG = process.env.TEST_PG_URL || '';
if (!PG) { test.skip('TEST_PG_URL 없음 — HTTP 스모크 생략', () => {}); }
else {
  process.env.DATABASE_URL = PG;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-para-pruebas-0218';

  const received = [];
  const crm = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      received.push({ headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ codigoError: '0', mensaje: 'OK', recibidos: (raw ? JSON.parse(raw).productos.length : 0) }));
    });
  });
  await new Promise((r) => crm.listen(0, '127.0.0.1', r));
  const CRM_URL = `http://127.0.0.1:${crm.address().port}/api/integrations/erp/productos`;

  const { buildApp } = await import('../src/server.js');
  const { query } = await import('../src/db.js');
  const { invalidateEndpointCache } = await import('../src/integrations.js');

  const app = buildApp();
  await app.ready();

  // 적재 직후 엔진이 **스스로** 즉시 전송한다(scheduleDrain). 테스트는 그 결과를 기다린다 —
  // 여기서 drainOutbox 를 또 부르면 이미 보낸 뒤라 "보낸 게 없다"가 되어 헛되이 실패한다.
  async function waitSent(runId, ms = 5000) {
    const until = Date.now() + ms;
    for (;;) {
      const r = (await query(
        `SELECT COUNT(*)::int AS n FROM crm_customer_outbox
          WHERE entity='product' AND entity_id=$1 AND status='sent'`, [runId])).rows[0];
      if (Number(r.n) > 0) return Number(r.n);
      if (Date.now() > until) return 0;
      await new Promise((x) => setTimeout(x, 100));
    }
  }
  const lotesDe = (envioId) => received.filter((r) => r.body && r.body.envioId === envioId);

  // 사용자 2명 — 디렉터와 영업사원(권한 경계 확인용)
  async function mkUser(role, login) {
    const cur = (await query(`SELECT id FROM users WHERE login_id=$1 LIMIT 1`, [login])).rows[0];
    if (cur) {
      await query(`UPDATE users SET role=$1 WHERE id=$2`, [role, cur.id]);
      return Number(cur.id);
    }
    const r = (await query(
      `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`,
      [`T ${role}`, role, login])).rows[0];
    return Number(r.id);
  }
  const dirId = await mkUser('director', 't_dir_0218');
  const salesId = await mkUser('sales', 't_sales_0218');
  const bearer = (id) => ({ Authorization: 'Bearer ' + app.jwt.sign({ sub: id }) });

  await query(`DELETE FROM crm_customer_outbox WHERE entity='product'`);
  await query(`DELETE FROM product_sync_runs`);
  await query(`DELETE FROM products WHERE code LIKE 'H%'`);
  for (let i = 1; i <= 25; i++) {
    await query(
      `INSERT INTO products (code, name, app, scode, list_price, stock_qty, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT (code) DO NOTHING`,
      [`H${i}`, `PIEZA H${i}`, 'NISSAN Np300 Pickup 4X2 2009-2015', '1603005', 250.5, 12]);
  }
  await query(
    `UPDATE integration_endpoints SET enabled=true, env='test', url_test=$1,
            auth_in='header', auth_header='x-api-key', auth_token_test='k-0218',
            batch_size=500, img_base_url='', auto_send=false WHERE key='product'`, [CRM_URL]);
  invalidateEndpointCache();

  test('토큰 없으면 401, 영업사원은 403 — 카탈로그 전송은 디렉터만', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/product-sync/status' })).statusCode, 401);
    assert.equal((await app.inject({
      method: 'GET', url: '/api/product-sync/status', headers: bearer(salesId),
    })).statusCode, 403);
    assert.equal((await app.inject({
      method: 'POST', url: '/api/product-sync/run', headers: bearer(salesId), payload: { mode: 'test' },
    })).statusCode, 403);
  });

  test('상태 — 제품 수·묶음 예상·전송 가능 여부를 알려 준다', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/product-sync/status', headers: bearer(dirId) });
    assert.equal(r.statusCode, 200);
    const d = r.json();
    assert.equal(d.migration_ready, true);
    assert.equal(d.can_send, true);
    assert.equal(d.blocked_reason, null);
    assert.ok(d.products.total >= 25);
    assert.equal(d.settings.batch_size, 500);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d.mx_today));
  });

  test('미리보기는 보내지 않는다 — 본문만 보여 준다', async () => {
    const before = (await query(`SELECT COUNT(*)::int AS n FROM crm_customer_outbox WHERE entity='product'`)).rows[0].n;
    const d = (await app.inject({ method: 'GET', url: '/api/product-sync/preview', headers: bearer(dirId) })).json();
    assert.equal(d.found, true);
    assert.equal(d.sample_lote.moneda, undefined);          // 묶음에는 통화가 없다(제품에 있다)
    assert.equal(d.productos[0].moneda, 'MXN');
    assert.ok(Array.isArray(d.sample_lote.productos));
    const after = (await query(`SELECT COUNT(*)::int AS n FROM crm_customer_outbox WHERE entity='product'`)).rows[0].n;
    assert.equal(after, before, '미리보기는 아무것도 적재하지 않는다');
  });

  test('설정 검증 — 잘못된 묶음 크기·사진 주소는 저장 자체가 막힌다', async () => {
    const bad = async (patch) => (await app.inject({
      method: 'PUT', url: '/api/integrations/product', headers: bearer(dirId), payload: patch,
    }));
    let r = await bad({ batch_size: 5 });
    assert.equal(r.statusCode, 400); assert.equal(r.json().error, 'batch_size_invalid');
    r = await bad({ send_hour_mx: 99 });
    assert.equal(r.statusCode, 400); assert.equal(r.json().error, 'send_hour_invalid');
    r = await bad({ img_base_url: 'fotos.refatrix.mx/ctr' });
    assert.equal(r.statusCode, 400); assert.equal(r.json().error, 'img_base_invalid');
    r = await bad({ img_base_url: 'https://fotos.refatrix.mx/ctr  Content-Type: application/json' });
    assert.equal(r.statusCode, 400); assert.equal(r.json().error, 'img_base_space');
    assert.ok(r.json().note, '사람이 읽을 안내 문구가 함께 온다');
  });

  test('설정 저장 — 사진 기본주소가 실제 본문에 반영된다', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/api/integrations/product', headers: bearer(dirId),
      payload: { img_base_url: 'https://fotos.refatrix.mx/ctr', batch_size: 10, send_hour_mx: 7, auto_send: true },
    });
    assert.equal(r.statusCode, 200);
    const got = (await app.inject({ method: 'GET', url: '/api/integrations/product', headers: bearer(dirId) })).json();
    assert.equal(got.endpoint.img_base_url, 'https://fotos.refatrix.mx/ctr');
    assert.equal(got.endpoint.batch_size, 10);
    assert.equal(got.endpoint.send_hour_mx, 7);
    assert.equal(got.endpoint.auto_send, true);
    const pv = (await app.inject({ method: 'GET', url: '/api/product-sync/preview?code=H1', headers: bearer(dirId) })).json();
    assert.equal(pv.productos[0].imagenUrl, 'https://fotos.refatrix.mx/ctr/H1.jpg');
  });

  test('시험 전송 → 적재 · 이력 · 묶음 조회', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/product-sync/run', headers: bearer(dirId),
      payload: { mode: 'test', limit: 2 },
    });
    assert.equal(r.statusCode, 200);
    const d = r.json();
    assert.equal(d.total_productos, 2);
    assert.match(d.envio_id, /^TEST-/);

    const runs = (await app.inject({ method: 'GET', url: '/api/product-sync/runs', headers: bearer(dirId) })).json();
    assert.equal(runs.runs[0].envio_id, d.envio_id);

    const lotes = (await app.inject({
      method: 'GET', url: `/api/product-sync/runs/${d.run_id}/lotes`, headers: bearer(dirId),
    })).json();
    assert.equal(lotes.lotes.length, d.total_lotes);
    assert.match(lotes.lotes[0].label, /TEST-/);

    // 실제 전송까지 — 모의 CRM 이 받은 본문에 마감 신호가 없어야 한다(시험 전송)
    assert.ok(await waitSent(d.run_id) > 0, '적재 직후 스스로 전송된다');
    const got = lotesDe(d.envio_id);
    assert.ok(got.length >= 1);
    assert.equal(got[got.length - 1].body.esUltimoLote, false, '시험 전송은 마감하지 않는다');
    assert.equal(got[0].headers['x-api-key'], 'k-0218');
  });

  test('전체 전송 — 마지막 묶음에 마감 신호가 실려 나간다', async () => {
    await query(`UPDATE integration_endpoints SET batch_size=10 WHERE key='product'`);
    invalidateEndpointCache();
    const d = (await app.inject({
      method: 'POST', url: '/api/product-sync/run', headers: bearer(dirId), payload: { mode: 'full' },
    })).json();
    assert.ok(d.total_lotes >= 2, '25제품 · 묶음 10 → 3묶음');
    assert.equal(await waitSent(d.run_id, 8000), d.total_lotes, '모든 묶음이 전송된다');
    const got = lotesDe(d.envio_id);
    assert.equal(got.length, d.total_lotes);
    const last = got[got.length - 1].body;
    assert.equal(last.esUltimoLote, true);
    assert.equal(last.envioId, d.envio_id);
    assert.equal(last.fechaCorte, d.fecha_corte);
    assert.equal(typeof last.transactionUser, 'string');
  });

  test.after(async () => {
    await query(`DELETE FROM crm_customer_outbox WHERE entity='product'`);
    await query(`DELETE FROM product_sync_runs`);
    await query(`DELETE FROM products WHERE code LIKE 'H%'`);
    await query(`DELETE FROM users WHERE login_id IN ('t_dir_0218','t_sales_0218')`);
    await app.close();
    crm.close();
  });
}
