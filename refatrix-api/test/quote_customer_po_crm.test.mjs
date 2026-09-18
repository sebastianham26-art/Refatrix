// =====================================================================
// 고객 PO번호 — CRM 수신 창구 · 화면 API 종단 시험 (0225)
//
//   앞의 두 파일이 각각 「SQL 이 도는가」(quote_customer_po_sql)와 「종이에 찍히는가」
//   (quote_customer_po_front)를 본다면, 여기서는 **진짜 라우트에 진짜 인증을 태워**
//   요청 하나가 들어가면 PO 가 실제로 어디까지 따라가는지 본다.
//
//     · CRM 이 ordenCompraCliente 를 보내면 견적에 붙는다
//     · 필드 이름이 달라도(poCliente · ordenCompra · purchaseOrder …) 놓치지 않는다
//     · **재전송에 PO 만 새로 붙어 오면 채운다 — 이미 있으면 덮지 않는다**(디렉터 지정)
//     · 화면에서 만든 견적도 같은 칸을 쓴다(수신과 화면이 갈리면 검색이 한쪽만 걸린다)
//     · 전환된 견적도 PO 만 따로 고칠 수 있다 — 현장의 순서가 그렇다
//     · 창고 패킹리스트 조회가 PO 를 같이 준다
//
//   실행: TEST_PG_URL=postgres://... node --test test/quote_customer_po_crm.test.mjs
//   환경변수가 없으면 순수 함수 시험만 돌고 DB 블록은 건너뛴다.
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

const { mapQuote } = await import('../src/crmInbound.js');
const dbTest = (name, fn) => test(name, { skip: PG ? false : '실 DB 없음 — TEST_PG_URL 설정 시 실행' }, fn);

// ── 본문 매핑 (DB 불필요) ─────────────────────────────────────────────
test('ordenCompraCliente — 계약서 이름이 정식, 나머지는 놓치지 않기 위한 그물', () => {
  const L = [{ codigo: 'A', cantidad: 1 }];
  const po = (b) => mapQuote({ rfc: 'X', lineas: L, ...b }).ordenCompraCliente;
  assert.equal(po({ ordenCompraCliente: 'OC-2026-118' }), 'OC-2026-118', '정식 이름');
  for (const k of ['poCliente', 'ordenCompra', 'oc', 'ordenDeCompra', 'numeroOrdenCompra',
                   'noOrdenCompra', 'purchaseOrder', 'purchaseOrderNo', 'poNumber', 'po']) {
    assert.equal(po({ [k]: '4471' }), '4471', `별칭 ${k} 도 받는다`);
  }
  assert.equal(po({}), null, '안 보내면 null — 없는 번호를 지어내지 않는다');
});

test('우리 견적번호(COT)와 고객 PO 는 절대 섞이지 않는다', () => {
  // 섞이면 패킹리스트에 같은 번호가 두 번 찍히고, 대조라는 행위 자체가 무의미해진다.
  const m = mapQuote({ rfc: 'X', cotizacionCrm: 'COT-20260918120000001',
    ordenCompraCliente: 'OC-2026-118', lineas: [{ codigo: 'A', cantidad: 1 }] });
  assert.equal(m.crmQuoteNo, 'COT-20260918120000001');
  assert.equal(m.ordenCompraCliente, 'OC-2026-118');

  // COT 번호만 오면 PO 칸은 비어 있어야 한다(COT 를 PO 로 베껴 넣지 않는다).
  const only = mapQuote({ rfc: 'X', cotizacionCrm: 'COT-ABC1', lineas: [{ codigo: 'A', cantidad: 1 }] });
  assert.equal(only.ordenCompraCliente, null);
});

test('한 겹 감싼 본문에서도 PO 를 꺼낸다', () => {
  // 이 창구가 원래 풀어 주는 껍데기(data/payload/body/cliente/customer/datos)에서만 꺼낸다.
  // 새 껍데기를 여기서 늘리지 않는다 — 껍데기 목록은 이 창구 전체의 규칙이라 PO 하나 때문에
  // 넓히면 다른 필드까지 같이 넓어진다.
  for (const wrap of ['data', 'payload', 'datos']) {
    const m = mapQuote({ [wrap]: { rfc: 'X', ordenCompraCliente: 'OC-9' }, lineas: [{ codigo: 'A', cantidad: 1 }] });
    assert.equal(m.ordenCompraCliente, 'OC-9', `${wrap} 껍데기`);
  }
});

// ── 종단 (실 DB) ───────────────────────────────────────────────────────
dbTest('PO 가 수신 → 견적 → 창고까지 따라간다 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const crmQuoteRoutes = (await import('../src/routes/crmQuoteRoutes.js')).default;
  const quoteRoutes = (await import('../src/routes/quoteRoutes.js')).default;
  const warehouseRoutes = (await import('../src/routes/warehouseRoutes.js')).default;
  const { invalidateEndpointCache } = await import('../src/integrations.js');

  const KEY = 'rfx_test_po_key_0225';
  await query(`UPDATE integration_endpoints SET enabled=true, env='test', auth_token_test=$1
                WHERE key='crm_quote_request'`, [KEY]);
  invalidateEndpointCache();

  // 앞선 실행이 남긴 찌꺼기 정리 — 시험은 몇 번을 돌려도 같아야 한다.
  await query(`DELETE FROM quote_lines WHERE quote_id IN (
                 SELECT id FROM quotes WHERE quote_no LIKE 'COT-PO%' OR external_quote_no LIKE 'COT-PO%'
                                          OR quote_no LIKE 'Q-PO-%')`);
  await query(`DELETE FROM quotes WHERE quote_no LIKE 'COT-PO%' OR external_quote_no LIKE 'COT-PO%'
                                    OR quote_no LIKE 'Q-PO-%'`);
  await query(`DELETE FROM crm_inbound_log WHERE endpoint_key='crm_quote_request'`);
  // customers 를 참조하는 표에서 이 시험 고객의 행을 먼저 치운다 — 앞선 실행이 중간에
  //   죽었으면 단계 기록(customer_meetings 등)이 남아 고객 삭제가 FK 로 막힌다.
  const custRefTables = async () => (await query(
    `SELECT DISTINCT tc.table_name AS t
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type='FOREIGN KEY' AND ccu.table_name='customers'
        AND tc.table_name <> 'customers'`)).rows.map((r) => r.t);
  const purgeCustomer = async (id) => {
    for (const tbl of await custRefTables()) {
      try { await query(`DELETE FROM ${tbl} WHERE customer_id=$1`, [id]); } catch (_) { /* customer_id 가 아닌 표 */ }
    }
    await query(`DELETE FROM customers WHERE id=$1`, [id]);
  };
  for (const r of (await query(`SELECT id FROM customers WHERE code='T-PO01'`)).rows) await purgeCustomer(r.id);
  await query(`DELETE FROM products WHERE code='POTEST01'`);
  // 감사로그는 사용자를 참조한다 — 시험 사용자를 지우려면 그 줄부터 치운다.
  const purgeUser = async (id) => {
    for (const tbl of ['audit_log', 'crm_quote_notify_targets', 'crm_lead_notify_targets']) {
      try { await query(`DELETE FROM ${tbl} WHERE user_id=$1`, [id]); } catch (_) { /* 없는 표는 무시 */ }
    }
    await query(`DELETE FROM users WHERE id=$1`, [id]);
  };
  for (const r of (await query(`SELECT id FROM users WHERE login_id='t_po_dir'`)).rows) await purgeUser(r.id);

  const rfc = 'POQ010203AA1';
  const cust = Number((await query(
    `INSERT INTO customers (code, name, rfc, discount, credit_days, approval_status)
     VALUES ('T-PO01','CLIENTE PO SA',$1,10,30,'approved') RETURNING id`, [rfc])).rows[0].id);
  const prod = Number((await query(
    `INSERT INTO products (code, name, list_price, stock_qty, is_active)
     VALUES ('POTEST01','PRODUCTO PO',100,50,true) RETURNING id`)).rows[0].id);
  const dirId = Number((await query(
    `INSERT INTO users (login_id, name, role, pin_hash) VALUES ('t_po_dir','PO 시험 디렉터','director','x') RETURNING id`)).rows[0].id);

  const appIn = Fastify();
  await appIn.register(crmQuoteRoutes);
  await appIn.ready();
  const post = (payload) => appIn.inject({ method: 'POST', url: '/api/integrations/crm/quote',
    headers: { 'x-api-key': KEY }, payload });

  const appUi = Fastify();
  await appUi.register(fastifyJwt, { secret: 'test-secret-0225' });
  await appUi.register(quoteRoutes);
  await appUi.register(warehouseRoutes);
  await appUi.ready();
  const token = appUi.jwt.sign({ sub: dirId });
  const asDir = (method, url, payload) => appUi.inject({ method, url, payload,
    headers: { authorization: 'Bearer ' + token } });

  const made = [];
  t.after(async () => {
    for (const id of made) {
      await query(`DELETE FROM quote_lines WHERE quote_id=$1`, [id]);
      await query(`DELETE FROM quotes WHERE id=$1`, [id]);
    }
    await query(`DELETE FROM crm_inbound_log WHERE endpoint_key='crm_quote_request'`);
    // 견적 저장은 고객 단계(autoStage)를 전진시키므로 딸린 기록이 생긴다 — 먼저 치운다.
    await purgeCustomer(cust);
    await query(`DELETE FROM products WHERE id=$1`, [prod]);
    await query(`UPDATE integration_endpoints SET auth_token_test=NULL WHERE key='crm_quote_request'`);
    await purgeUser(dirId);
    await appIn.close(); await appUi.close(); await pool.end();
  });

  const poOf = async (id) => (await query(`SELECT customer_po_no FROM quotes WHERE id=$1`, [id])).rows[0].customer_po_no;

  await t.test('① 수신 — ordenCompraCliente 가 견적에 붙고 응답으로 되돌아온다', async () => {
    const r = await post({ cotizacionCrm: 'COT-PO-0001', rfc, ordenCompraCliente: '  OC-2026-118 ',
      lineas: [{ codigo: 'POTEST01', cantidad: 2 }] });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.codigoError, '0');
    assert.equal(b.ordenCompraCliente, 'OC-2026-118', '개발자가 응답만으로 확인할 수 있어야 한다');
    made.push(b.quoteId);
    assert.equal(await poOf(b.quoteId), 'OC-2026-118', '앞뒤 공백은 정리해 저장한다');
  });

  await t.test('② 재전송 — 견적은 여전히 하나이고, 비어 있던 PO 는 채워진다', async () => {
    // 고객이 웹에서 견적을 먼저 띄우고, PO 를 발행한 뒤 같은 화면에서 다시 보낸다.
    const first = await post({ cotizacionCrm: 'COT-PO-0002', rfc,
      lineas: [{ codigo: 'POTEST01', cantidad: 1 }] });
    const id = first.json().quoteId;
    made.push(id);
    assert.equal(await poOf(id), null, '처음엔 PO 가 없다');

    const again = await post({ cotizacionCrm: 'COT-PO-0002', rfc, ordenCompraCliente: 'OC-TARDE-7',
      lineas: [{ codigo: 'POTEST01', cantidad: 1 }] });
    assert.equal(again.statusCode, 200);
    const b = again.json();
    assert.equal(Number(b.quoteId), Number(id), '견적이 둘 생기면 안 된다(멱등)');
    assert.equal(b.ordenCompraCliente, 'OC-TARDE-7');
    assert.match(b.mensaje, /orden de compra/i, '무엇을 했는지 스페인어로 말해 준다');
    assert.equal(await poOf(id), 'OC-TARDE-7');

    const n = Number((await query(
      `SELECT count(*)::int n FROM quotes WHERE external_quote_no='COT-PO-0002' OR quote_no='COT-PO-0002'`)).rows[0].n);
    assert.equal(n, 1);
  });

  await t.test('③ 재전송 — 사람이 넣어 둔 PO 는 웹이 덮어쓰지 못한다', async () => {
    const r = await post({ cotizacionCrm: 'COT-PO-0001', rfc, ordenCompraCliente: 'OC-WEB-SOBRESCRIBE',
      lineas: [{ codigo: 'POTEST01', cantidad: 2 }] });
    assert.equal(r.statusCode, 200);
    const id = made[0];
    assert.equal(await poOf(id), 'OC-2026-118', '현장 입력이 늘 더 정확했다');
    assert.equal(r.json().ordenCompraCliente, undefined, '안 바꿨으면 바꿨다고 말하지 않는다');
  });

  await t.test('④ 화면에서 만든 견적도 같은 칸을 쓴다', async () => {
    const r = await asDir('POST', '/api/quotes',
      { customer_id: cust, customer_po_no: ' 4471 ', lines: [{ code: 'POTEST01', qty: 3 }] });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    made.push(b.id);
    assert.equal(b.customer_po_no, '4471');
    assert.equal(await poOf(b.id), '4471', '수신과 화면이 갈리면 검색이 한쪽만 걸린다');
  });

  await t.test('⑤ 목록 한 칸 검색 — 고객 PO 로 찾아진다', async () => {
    const r = await asDir('GET', '/api/quotes?from=&to=&q=4471');
    assert.equal(r.statusCode, 200);
    const items = r.json().items;
    assert.equal(items.length, 1);
    assert.equal(items[0].customer_po_no, '4471');
    // 견적번호·고객명도 같은 칸에서 찾아진다
    assert.ok((await asDir('GET', '/api/quotes?from=&to=&q=CLIENTE%20PO')).json().items.length >= 3, '고객명');
    assert.equal((await asDir('GET', '/api/quotes?from=&to=&q=zzz-no-existe')).json().items.length, 0);
  });

  await t.test('⑥ 라인 편집(PUT)은 PO 를 지우지 않는다', async () => {
    const id = made[made.length - 1];
    const r = await asDir('PUT', `/api/quotes/${id}`,
      { customer_id: cust, lines: [{ code: 'POTEST01', qty: 5 }] });
    assert.equal(r.statusCode, 200);
    assert.equal(await poOf(id), '4471', '편집 한 번에 PO 가 사라지면 아무도 눈치채지 못한다');
  });

  await t.test('⑦ 전환된 견적에서도 PO 만 따로 고칠 수 있다', async () => {
    const id = made[made.length - 1];
    // 매출 전환 뒤의 상태를 만든다(전환 그 자체는 다른 시험의 몫이라 상태만 세운다)
    await query(`UPDATE quotes SET status='converted' WHERE id=$1`, [id]);
    const put = await asDir('PUT', `/api/quotes/${id}`, { customer_id: cust, lines: [{ code: 'POTEST01', qty: 5 }] });
    assert.equal(put.statusCode, 409, 'PUT 은 전환된 견적을 거절한다(기존 규칙 그대로)');

    const r = await asDir('POST', `/api/quotes/${id}/customer-po`, { customer_po_no: 'OC-DESPUES-1' });
    assert.equal(r.statusCode, 200, '고객이 PO 를 전환 뒤에 발행하는 일이 흔하다');
    assert.equal(await poOf(id), 'OC-DESPUES-1');

    // 금액·라인은 손대지 않았다
    const q = (await query(`SELECT total_mxn, (SELECT count(*)::int FROM quote_lines WHERE quote_id=$1) n
                              FROM quotes WHERE id=$1`, [id])).rows[0];
    assert.ok(Number(q.total_mxn) > 0);
    assert.equal(Number(q.n), 1);
    await query(`UPDATE quotes SET status='confirmed' WHERE id=$1`, [id]);
  });

  await t.test('⑧ PO 를 비우면 NULL 이 된다 (빈 문자열이 아니다)', async () => {
    const id = made[made.length - 1];
    const r = await asDir('POST', `/api/quotes/${id}/customer-po`, { customer_po_no: '   ' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().customer_po_no, null);
    assert.equal(await poOf(id), null);
    await asDir('POST', `/api/quotes/${id}/customer-po`, { customer_po_no: '4471' });
  });

  await t.test('⑨ 창고 — 패킹리스트가 쓰는 조회가 PO 를 같이 준다', async () => {
    const id = made[made.length - 1];
    await query(`UPDATE quotes SET packed_at=now(), packing_printed_at=now() WHERE id=$1`, [id]);
    const r = await asDir('GET', `/api/warehouse/ship/${id}`);
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.customer_po_no, '4471');
    assert.equal(b.quote_no, (await query(`SELECT quote_no FROM quotes WHERE id=$1`, [id])).rows[0].quote_no);
  });

  await t.test('⑩ 창고 포장 대기 목록에도 PO 가 실린다', async () => {
    const id = made[made.length - 1];
    await query(`UPDATE quotes SET packed_at=NULL, invoice_id=NULL, status='confirmed' WHERE id=$1`, [id]);
    const r = await asDir('GET', '/api/warehouse/packing-queue');
    assert.equal(r.statusCode, 200);
    const row = r.json().items.find((x) => Number(x.quote_id) === Number(id));
    assert.ok(row, '포장 대기에 있어야 한다');
    assert.equal(row.customer_po_no, '4471');
  });
});
