// 수신 전용 키 **되돌리기** (2026-09-17)
//
//   실제로 막혔던 상황: 견적요청 창구는 「신규고객 등록」의 키로 들어오게 설계돼 있는데,
//   그 창구에 전용 키가 한 번 발급되면서 공용 키가 401 로 거절됐다.
//   개발자는 「키는 고객정보 수신과 같은 걸 쓴다」고 하는데 ERP 는 계속 거절했고,
//   **전용 키를 지울 방법이 화면에도 API 에도 없었다.**
//
//   여기서 잠그는 것: 만들 수 있는 것은 되돌릴 수도 있어야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

test('전용 키가 공용 키를 막고 있으면 화면이 말해 주고 되돌릴 버튼을 준다', () => {
  const g = readFileSync(new URL('../../refatrix-integrations.html', import.meta.url), 'utf8');
  assert.ok(/btnClearInKey/.test(g), '되돌리기 버튼이 있어야 한다');
  assert.ok(/clearInboundKey/.test(g));
  assert.ok(/method:'DELETE'/.test(g), 'DELETE 로 지워야 한다');
  assert.ok(/boxKeyOwn/.test(g) && /401 로 거절됩니다/.test(g),
    '왜 막히는지 화면이 말해 줘야 한다 — 상대는 「같은 키를 쓴다」는데 우리가 거절하는 상황이다');
});

const dbTest = PG ? test : test.skip;

dbTest('전용 키를 지우면 공용 키로 다시 들어온다 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const crmQuoteRoutes = (await import('../src/routes/crmQuoteRoutes.js')).default;
  const crmInboundRoutes = (await import('../src/routes/crmInboundRoutes.js')).default;
  const { invalidateEndpointCache } = await import('../src/integrations.js');

  const REG_KEY = 'rfx_test_reg_shared_key_0220';
  const OWN_KEY = 'rfx_test_quote_own_key_0220';

  const before = (await query(
    `SELECT key, auth_token_test, auth_token_prod FROM integration_endpoints
      WHERE key IN ('crm_quote_request','crm_customer_registration')`)).rows;

  await query(`DELETE FROM quote_lines WHERE quote_id IN (
                 SELECT id FROM quotes WHERE quote_no LIKE 'COT-KEY%')`);
  await query(`DELETE FROM quotes WHERE quote_no LIKE 'COT-KEY%'`);
  await query(`DELETE FROM crm_inbound_log WHERE endpoint_key='crm_quote_request'`);
  await query(`DELETE FROM customers WHERE code='T-QK01'`);
  await query(`DELETE FROM products WHERE code='QKTEST1'`);
  // 감사 로그가 사용자를 참조하므로 먼저 치운다(앞선 실행이 남긴 것).
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id='t_qk_dir')`);
  await query(`DELETE FROM users WHERE login_id='t_qk_dir'`);

  const cid = Number((await query(
    `INSERT INTO customers (code, name, rfc, discount, credit_days, approval_status)
     VALUES ('T-QK01','CLIENTE LLAVE SA','QKY010203AA1',10,30,'approved') RETURNING id`)).rows[0].id);
  const pid = Number((await query(
    `INSERT INTO products (code, name, list_price, stock_qty, is_active)
     VALUES ('QKTEST1','PRODUCTO LLAVE',100,50,true) RETURNING id`)).rows[0].id);
  const dirId = Number((await query(
    `INSERT INTO users (login_id, name, role, pin_hash) VALUES ('t_qk_dir','키시험 디렉터','director','x')
     RETURNING id`)).rows[0].id);

  // 실제 상황 재현: 견적 창구에 **전용 키가 발급돼 있다.**
  await query(`UPDATE integration_endpoints SET enabled=true, env='test', auth_token_test=$1,
                      auth_token_prod=NULL WHERE key='crm_quote_request'`, [OWN_KEY]);
  await query(`UPDATE integration_endpoints SET enabled=true, env='test', auth_token_test=$1
                WHERE key='crm_customer_registration'`, [REG_KEY]);
  invalidateEndpointCache();

  const app = Fastify();
  await app.register(crmQuoteRoutes);
  const send = (key) => app.inject({ method: 'POST', url: '/api/integrations/crm/quote',
    headers: { 'x-api-key': key },
    payload: { cotizacionCrm: 'COT-KEY-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      rfc: 'QKY010203AA1', lineas: [{ codigo: 'QKTEST1', cantidad: 1 }] } });

  // 관리 화면 쪽(디렉터 전용) — 진짜 가드를 그대로 태운다.
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const admin = Fastify();
  await admin.register(fastifyJwt, { secret: 'test-secret-key-clear' });
  await admin.register(crmInboundRoutes);
  await admin.ready();
  const tok = admin.jwt.sign({ sub: dirId });

  t.after(async () => {
    for (const r of before) {
      await query(`UPDATE integration_endpoints SET auth_token_test=$2, auth_token_prod=$3 WHERE key=$1`,
        [r.key, r.auth_token_test, r.auth_token_prod]);
    }
    await query(`DELETE FROM quote_lines WHERE quote_id IN (
                   SELECT id FROM quotes WHERE quote_no LIKE 'COT-KEY%')`);
    await query(`DELETE FROM quotes WHERE quote_no LIKE 'COT-KEY%'`);
    await query(`DELETE FROM crm_inbound_log WHERE endpoint_key='crm_quote_request'`);
    await query(`DELETE FROM customers WHERE id=$1`, [cid]);
    await query(`DELETE FROM products WHERE id=$1`, [pid]);
    await query(`DELETE FROM audit_log WHERE user_id=$1`, [dirId]);
    await query(`DELETE FROM users WHERE id=$1`, [dirId]);
    invalidateEndpointCache();
    await app.close(); await admin.close(); await pool.end();
  });

  await t.test('전용 키가 있으면 공용 키는 거절된다(지금 겪고 있는 증상)', async () => {
    const r = await send(REG_KEY);
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().codigoError, 'ERR_API_KEY');
    const log = (await query(
      `SELECT mensaje FROM crm_inbound_log WHERE endpoint_key='crm_quote_request'
        ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.match(log.mensaje, /llave propia/, '전용 키와 대조했다고 이력이 말해 줘야 한다');
  });

  await t.test('전용 키를 지운다', async () => {
    const r = await admin.inject({ method: 'DELETE',
      url: '/api/integrations/crm_quote_request/inbound-key',
      headers: { authorization: 'Bearer ' + tok } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().fallback_to, 'crm_customer_registration',
      '어느 창구 키로 되돌아가는지 알려 줘야 한다');
    const row = (await query(
      `SELECT auth_token_test, auth_token_prod, auth_token FROM integration_endpoints
        WHERE key='crm_quote_request'`)).rows[0];
    assert.equal(row.auth_token_test, null);
    assert.equal(row.auth_token_prod, null);
    assert.equal(row.auth_token, null);
  });

  await t.test('이제 고객정보 수신과 같은 키로 들어온다', async () => {
    invalidateEndpointCache();
    const r = await send(REG_KEY);
    assert.equal(r.statusCode, 200, '공용 키로 접수돼야 한다');
    assert.equal(r.json().codigoError, '0');
  });

  await t.test('전송 창구에는 쓸 수 없다(수신 전용)', async () => {
    const r = await admin.inject({ method: 'DELETE',
      url: '/api/integrations/customer_commercial/inbound-key',
      headers: { authorization: 'Bearer ' + tok } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'not_inbound');
  });

  await t.test('디렉터가 아니면 지울 수 없다', async () => {
    const r = await admin.inject({ method: 'DELETE',
      url: '/api/integrations/crm_quote_request/inbound-key' });
    assert.equal(r.statusCode, 401);
  });
});
