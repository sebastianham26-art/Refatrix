// 카탈로그 조회 API (0221) — 접속창·가격·커서·권한 테스트
//
//   순수 로직은 DB 없이 돌고, HTTP 스모크는 TEST_PG_URL 이 있을 때만 실제 PostgreSQL 로 돈다.
//   ⚠ 제품 스위트들과 같은 표를 쓰므로 반드시 직렬로: --test-concurrency=1
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/catalog_pull.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

const {
  windowState, purchasePrice, usedDiscount, posicionMontaje, stockValue, catalogStockRange,
  excludePrefixes, refSource, scodeRefs,
  encodeCursor, decodeCursor, pageLimit, normCode, notaOf, buildProducto, mxIso,
} = await import('../src/catalogPull.js');

// 2026-09-19 는 토요일. 멕시코 05:30 = UTC 11:30 (UTC−6 고정)
const SAB = (hhmmUtc) => Date.parse(`2026-09-19T${hhmmUtc}:00Z`);
const SABADO = { window_enforced: true, window_dow: 6, window_start_hour: 5, window_end_hour: 9 };

// ── ① 접속창 ────────────────────────────────────────────────────────
test('토요일 05:00~09:00 안에서만 열린다', () => {
  assert.equal(windowState(SABADO, SAB('11:30')).open, true, '05:30 MX — 열림');
  assert.equal(windowState(SABADO, SAB('11:00')).open, true, '05:00 정각 — 열림');
  assert.equal(windowState(SABADO, SAB('14:59')).open, true, '08:59 — 열림');
  assert.equal(windowState(SABADO, SAB('15:00')).open, false, '09:00 정각 — 닫힘(미만까지)');
  assert.equal(windowState(SABADO, SAB('10:59')).open, false, '04:59 — 아직 안 열림');
});

test('닫혀 있으면 다음 개방 시각을 정확히 알려 준다', () => {
  // 토요일 04:00 MX → 오늘 05:00 에 열린다
  assert.equal(windowState(SABADO, SAB('10:00')).nextOpen, '2026-09-19T05:00:00-06:00');
  // 토요일 10:00 MX(이미 닫힘) → 다음 주 토요일
  assert.equal(windowState(SABADO, SAB('16:00')).nextOpen, '2026-09-26T05:00:00-06:00');
  // 금요일 → 다음 날 토요일
  const viernes = Date.parse('2026-09-18T16:00:00Z');
  assert.equal(windowState(SABADO, viernes).nextOpen, '2026-09-19T05:00:00-06:00');
});

test('접속창을 끄면 언제나 열린다', () => {
  const libre = { ...SABADO, window_enforced: false };
  assert.equal(windowState(libre, SAB('20:00')).open, true);
});

test('periodKey 는 멕시코 날짜다 — 주 1회를 세는 열쇠', () => {
  // UTC 로는 20일 03:00 이지만 멕시코는 아직 19일 21:00 이다
  assert.equal(windowState(SABADO, Date.parse('2026-09-20T03:00:00Z')).periodKey, '2026-09-19');
});

// ── ② 가격 — 이 연동의 심장 ─────────────────────────────────────────
test('구매단가 = 정가 × (1 − 할인율) · 청구서와 같은 공식', () => {
  assert.equal(purchasePrice(1000, 20), 800);
  assert.equal(purchasePrice(764, 20.7), 605.85);      // 반올림 2자리
  assert.equal(purchasePrice('546.00', 10), 491.4);    // node-pg 는 NUMERIC 을 문자열로 준다
});

test('할인율이 없거나 이상하면 0% — 정가가 그대로 나간다', () => {
  assert.equal(purchasePrice(1000, null), 1000);
  assert.equal(purchasePrice(1000, 0), 1000);
  assert.equal(purchasePrice(1000, undefined), 1000);
  assert.equal(purchasePrice(1000, -5), 1000, '음수 할인율은 무시한다');
  assert.equal(purchasePrice(1000, 120), 1000, '100% 넘는 값으로 0원을 만들지 않는다');
  assert.equal(usedDiscount(null), 0);
  assert.equal(usedDiscount(20.7), 20.7);
});

// ── ③ 제품 객체 ─────────────────────────────────────────────────────
test('장착 위치는 제품명에서 알아본다 — 모르면 null', () => {
  assert.equal(posicionMontaje('ROTULA INFERIOR'), 'Inferior');
  assert.equal(posicionMontaje('TERMINAL EXTERIOR'), 'Exterior');
  assert.equal(posicionMontaje('HORQUILLA INFERIOR DERECHA'), 'Inferior / Derecha');
  assert.equal(posicionMontaje('BRAZO AUXILIAR'), null, '지어내지 않는다');
  assert.equal(posicionMontaje(null), null);
});

test('재고 구간은 경계에서 정확히 갈린다', () => {
  assert.equal(catalogStockRange(0), '0');
  assert.equal(catalogStockRange(-3), '0', '마이너스 재고도 0 으로 보인다');
  assert.equal(catalogStockRange(1), '1-5');
  assert.equal(catalogStockRange(5), '1-5');
  assert.equal(catalogStockRange(6), '6-10');
  assert.equal(catalogStockRange(10), '6-10');
  assert.equal(catalogStockRange(11), '11-20');
  assert.equal(catalogStockRange(20), '11-20');
  assert.equal(catalogStockRange(21), '21-50');
  assert.equal(catalogStockRange(50), '21-50');
  assert.equal(catalogStockRange(51), '51-100');
  assert.equal(catalogStockRange(100), '51-100');
  assert.equal(catalogStockRange(101), '101+');
  assert.equal(catalogStockRange(9999), '101+');
  assert.equal(catalogStockRange('12.7'), '11-20', '소수 재고는 내림');
});

test('기본은 구간 — 수량은 설정을 바꿔야 나온다', () => {
  assert.equal(stockValue(24), '21-50', '모드를 안 주면 구간');
  assert.equal(stockValue(24, 'range'), '21-50');
  assert.equal(stockValue(24, 'qty'), 24);
  assert.equal(stockValue(-3, 'qty'), 0);
  assert.equal(stockValue('12.7', 'qty'), 12);
});

test('제외 접두어 — 기본은 PRO', () => {
  assert.deepEqual(excludePrefixes({}), ['PRO'], '칼럼이 없으면 안전한 쪽으로 — PRO 를 막는다');
  assert.deepEqual(excludePrefixes({ exclude_prefixes: 'PRO' }), ['PRO']);
  assert.deepEqual(excludePrefixes({ exclude_prefixes: 'pro, kit ' }), ['PRO', 'KIT'], '대문자·공백 정리');
  assert.deepEqual(excludePrefixes({ exclude_prefixes: '' }), [], '빈 값 = 제외 없음');
  assert.deepEqual(excludePrefixes({ exclude_prefixes: null }), [], '사람이 지웠으면 전부 내보낸다');
});

test('대응품번 출처 — 기본은 화면과 같은 scode', () => {
  assert.equal(refSource({}), 'scode', '설정이 없으면 화면과 같은 출처');
  assert.equal(refSource({ ref_source: 'xref' }), 'xref');
  assert.equal(refSource({ ref_source: 'BOTH' }), 'both');
  assert.equal(refSource({ ref_source: '이상한값' }), 'scode', '이상한 값은 안전한 기본으로');
});

test('scode 를 대응품번 배열로 쪼갠다 — 화면이 보여 주는 그 값', () => {
  assert.deepEqual(scodeRefs('1603005 // 1516049'),
    [{ brand: 'SYD', xref_code: '1603005' }, { brand: 'SYD', xref_code: '1516049' }]);
  assert.deepEqual(scodeRefs('6Q0-407-365-A'), [{ brand: 'SYD', xref_code: '6Q0-407-365-A' }]);
  assert.deepEqual(scodeRefs(' 1603005 //  1603005 '), [{ brand: 'SYD', xref_code: '1603005' }], '중복 제거');
  assert.deepEqual(scodeRefs(''), []);
  assert.deepEqual(scodeRefs(null), []);
});

test('적용차종 주석만 뽑아 nota 로 싣는다', () => {
  assert.equal(notaOf('NISSAN Np300 2009-2015 [perno grueso]'), 'perno grueso');
  assert.equal(notaOf('NISSAN Np300 2009-2015'), null);
});

test('제품 객체는 계약서 6항 모양이다', () => {
  const p = buildProducto(
    { id: 1, code: 'CE0427', name: 'ROTULA INFERIOR', app: 'NISSAN Frontier 4X2 1998-2004',
      list_price: '764.00', stock_qty: '24', is_active: true, iva_rate: '16',
      material: 'Acero forjado', updated_at: '2026-09-18T18:40:02.000Z' },
    [{ brand: 'SYD', xref_code: '1603005' }, { brand: 'MOOG', xref_code: '' }],
    [{ maker: 'NISSAN', model: 'Frontier 4X2', year_from: 1998, year_to: 2004,
       app_text: 'NISSAN Frontier 4X2 1998-2004 [perno grueso]' }],
    { discount: 20.7, stockMode: 'range', imgBase: 'https://fotos/{code}.webp' });

  assert.equal(p.codigo, 'CE0427');
  assert.equal(p.activo, true);
  assert.equal(p.precio.precioLista, 764);
  assert.equal(p.precio.precioCompra, 605.85);
  assert.equal(p.precio.moneda, 'MXN');
  assert.equal(p.precio.ivaIncluido, false);
  assert.equal(p.existencia, '21-50', '고객에게는 구간으로 나간다');
  assert.equal(p.caracteristicas.material, 'Acero forjado');
  assert.equal(p.caracteristicas.posicionMontaje, 'Inferior');
  assert.equal(p.referencias.length, 1, '코드가 빈 대응품번은 내보내지 않는다');
  assert.deepEqual(p.referencias[0], { marca: 'SYD', codigo: '1603005' });
  assert.equal(p.aplicaciones[0].nota, 'perno grueso');
  assert.equal(p.aplicaciones[0].anioHasta, 2004);
  assert.equal(p.imagenUrl, 'https://fotos/CE0427.webp');
});

test('대응품번이 없으면 빈 배열이다 — null 이 아니다', () => {
  const p = buildProducto({ code: 'X1', name: 'PIEZA', list_price: 0, stock_qty: 0 }, [], [], {});
  assert.deepEqual(p.referencias, []);
  assert.deepEqual(p.aplicaciones, []);
  assert.equal(p.imagenUrl, null);
});

// ── ④ 커서·페이지 ───────────────────────────────────────────────────
test('커서는 왕복하고, 망가진 커서는 처음부터 준다', () => {
  assert.equal(decodeCursor(encodeCursor(500)), 500);
  assert.equal(decodeCursor('no-es-un-cursor'), null);
  assert.equal(decodeCursor(''), null);
  assert.equal(decodeCursor(null), null);
});

test('페이지 크기는 10~1000 으로 잘린다', () => {
  assert.equal(pageLimit(null, 500), 500);
  assert.equal(pageLimit(5000, 500), 1000);
  assert.equal(pageLimit(1, 500), 10);
  assert.equal(pageLimit('abc', 500), 500);
  assert.equal(pageLimit(250, 500), 250);
});

test('코드 정규화 — 하이픈·공백을 흡수한다', () => {
  assert.equal(normCode('6Q0-407-365-A'), '6Q0407365A');
  assert.equal(normCode(' 1603005 '), '1603005');
});

test('mxIso 는 멕시코 표기를 그대로 만든다', () => {
  assert.equal(mxIso('2026-09-19', 5), '2026-09-19T05:00:00-06:00');
});

// ── ⑤ HTTP 스모크 (실 DB 가 있을 때만) ───────────────────────────────
if (!PG) {
  test.skip('TEST_PG_URL 없음 — HTTP 스모크 생략', () => {});
} else {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-para-pruebas-0221';
  const { buildApp } = await import('../src/server.js');
  const { query } = await import('../src/db.js');
  const app = buildApp();
  await app.ready();

  async function mkUser(role, login) {
    const cur = (await query(`SELECT id FROM users WHERE login_id=$1 LIMIT 1`, [login])).rows[0];
    if (cur) { await query(`UPDATE users SET role=$1 WHERE id=$2`, [role, cur.id]); return Number(cur.id); }
    return Number((await query(
      `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`,
      [`T ${role}`, role, login])).rows[0].id);
  }
  const dirId = await mkUser('director', 't_dir_0221');
  const salesId = await mkUser('sales', 't_sales_0221');
  const bearer = (id) => ({ Authorization: 'Bearer ' + app.jwt.sign({ sub: id }) });

  // 깨끗한 상태 — 이 스위트가 만든 것만 지운다
  await query(`DELETE FROM catalog_api_calls`);
  await query(`DELETE FROM catalog_api_runs`);
  await query(`DELETE FROM catalog_api_clients`);
  await query(`DELETE FROM product_applications WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'K02210%')`);
  await query(`DELETE FROM product_xref_codes   WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'K02210%')`);
  await query(`DELETE FROM products WHERE code LIKE 'K02210%'`);

  const CUST = 'C-0221-TEST';
  await query(`DELETE FROM customers WHERE code=$1`, [CUST]);
  const custId = Number((await query(
    `INSERT INTO customers (code, name, discount) VALUES ($1,'Cliente Multimarca 0221',20) RETURNING id`,
    [CUST])).rows[0].id);

  // PRO 로 시작하는 제품 — 고객에게 나가면 안 된다
  await query(
    `INSERT INTO products (code, name, app, list_price, stock_qty, is_active)
     VALUES ('PRO02210','PRODUCTO INTERNO','NISSAN',500,50,true)`);

  for (let i = 1; i <= 6; i++) {
    const pid = Number((await query(
      `INSERT INTO products (code, name, app, scode, list_price, stock_qty, is_active, material)
       VALUES ($1,$2,$3,$4,$5,$6,true,'Acero') RETURNING id`,
      [`K02210${i}`, `ROTULA INFERIOR ${i}`, 'NISSAN Frontier 4X2 1998-2004',
       `SYD-K${i} // SYD-B${i}`, 1000, 7])).rows[0].id);
    await query(`INSERT INTO product_xref_codes (product_id, xref_code, norm_code, brand)
                 VALUES ($1,$2,$2,'MOOG')`, [pid, `MOOG-X${i}`]);
    await query(`INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to)
                 VALUES ($1,'NISSAN Frontier 4X2 1998-2004','NISSAN','Frontier 4X2',1998,2004)`, [pid]);
  }

  // 고객사 1곳 등록 — 접속창은 테스트 동안 열어 둔다(시간에 의존하는 테스트는 위 ①에서 끝냈다)
  const created = await app.inject({ method: 'POST', url: '/api/catalog/admin/clients',
    headers: bearer(dirId), payload: { label: 'Comparador Multimarca (test)', customer_id: custId } });
  assert.equal(created.statusCode, 200);
  const clientId = created.json().id;
  await app.inject({ method: 'PATCH', url: `/api/catalog/admin/clients/${clientId}`,
    headers: bearer(dirId), payload: { window_enforced: false, page_limit: 100 } });

  const issued = await app.inject({ method: 'POST', url: `/api/catalog/admin/clients/${clientId}/key`,
    headers: bearer(dirId), payload: { env: 'prod' } });
  const KEY = issued.json().token;

  test('키는 서버가 만든다 — rfx_prod_ 로 시작한다', () => {
    assert.match(KEY, /^rfx_prod_[0-9a-f]{48}$/);
  });

  test('관리 화면에는 키 값이 절대 내려가지 않는다', async () => {
    const d = (await app.inject({ method: 'GET', url: '/api/catalog/admin/clients',
      headers: bearer(dirId) })).json();
    const c = d.items.find((x) => x.id === clientId);
    assert.equal(c.has_prod_key, true);
    assert.equal(JSON.stringify(c).includes(KEY), false, '응답 어디에도 키 평문이 없어야 한다');
  });

  test('관리 라우트는 디렉터 전용', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/catalog/admin/clients' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/catalog/admin/clients',
      headers: bearer(salesId) })).statusCode, 403);
  });

  test('키가 없으면 401 ERR_API_KEY', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/products' });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().codigoError, 'ERR_API_KEY');
  });

  test('틀린 키도 401 — 우리 키인지 아닌지만 말한다', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/products',
      headers: { 'x-api-key': 'rfx_prod_' + '0'.repeat(48) } });
    assert.equal(r.statusCode, 401);
  });

  test('카탈로그를 내려준다 — 가격은 고객 마스터 할인율로 계산된다', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/products?limit=100',
      headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 200);
    const d = r.json();
    assert.ok(Array.isArray(d.productos));
    const p = d.productos.find((x) => x.codigo === 'K022101');
    assert.ok(p, '방금 넣은 제품이 응답에 있어야 한다');
    assert.equal(p.precio.precioLista, 1000);
    assert.equal(p.precio.precioCompra, 800, '할인율 20% → 800');
    assert.equal(p.existencia, '6-10', '재고 7 → 구간 6-10');
    assert.equal(p.caracteristicas.posicionMontaje, 'Inferior');
    assert.equal(p.referencias[0].marca, 'SYD');
    assert.deepEqual(p.referencias.map((x) => x.codigo), ['SYD-K1', 'SYD-B1'],
      '화면이 보여 주는 scode 그대로');
    assert.equal(p.referencias.some((x) => x.marca === 'MOOG'), false,
      '교차참조표(MOOG)는 기본 설정에서 나가지 않는다');
    assert.equal(p.aplicaciones[0].marca, 'NISSAN');
    assert.equal(d.cursor, null, '한 페이지에 다 들어갔으면 커서는 null');
    assert.equal(d.productos.some((x) => x.codigo.startsWith('PRO')), false,
      'PRO 로 시작하는 제품은 고객에게 나가지 않는다');
  });

  test('★ 출처를 교차참조표로 바꾸면 MOOG 가 나온다 — 되돌릴 수 있다', async () => {
    await app.inject({ method: 'PATCH', url: `/api/catalog/admin/clients/${clientId}`,
      headers: bearer(dirId), payload: { ref_source: 'xref' } });
    const d = (await app.inject({ method: 'GET', url: '/api/catalog/v1/products/K022101',
      headers: { 'x-api-key': KEY } })).json();
    assert.equal(d.producto.referencias.some((x) => x.marca === 'MOOG'), true);
    await app.inject({ method: 'PATCH', url: `/api/catalog/admin/clients/${clientId}`,
      headers: bearer(dirId), payload: { ref_source: 'scode' } });
  });

  test('★ PRO 제품은 단건 조회로도 안 나온다 — 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/products/PRO02210',
      headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 404, '목록에만 없고 직접 조회는 되면 구멍이다');
    assert.equal(r.json().codigoError, 'ERR_NOT_FOUND');
  });

  test('제외 접두어를 비우면 PRO 도 나온다 — 설정으로 되돌릴 수 있다', async () => {
    await app.inject({ method: 'PATCH', url: `/api/catalog/admin/clients/${clientId}`,
      headers: bearer(dirId), payload: { exclude_prefixes: '' } });
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/products/PRO02210',
      headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 200);
    await app.inject({ method: 'PATCH', url: `/api/catalog/admin/clients/${clientId}`,
      headers: bearer(dirId), payload: { exclude_prefixes: 'PRO' } });
  });

  test('★ 고객 마스터의 할인율을 바꾸면 다음 호출부터 자동으로 반영된다', async () => {
    await query(`UPDATE customers SET discount=35 WHERE id=$1`, [custId]);
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/products/K022101',
      headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().producto.precio.precioCompra, 650, '35% → 650 (재배포·재적재 없이)');
    await query(`UPDATE customers SET discount=20 WHERE id=$1`, [custId]);
    const r2 = await app.inject({ method: 'GET', url: '/api/catalog/v1/products/K022101',
      headers: { 'x-api-key': KEY } });
    assert.equal(r2.json().producto.precio.precioCompra, 800, '되돌리면 값도 되돌아온다');
  });

  test('한 접속창에 한 번 — 다 내려받은 뒤에는 429 ERR_YA_SINCRONIZADO', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/products?limit=100',
      headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 429);
    const d = r.json();
    assert.equal(d.codigoError, 'ERR_YA_SINCRONIZADO');
    assert.ok(d.proximaVentana, '다음 개방 시각을 함께 준다');
  });

  test('단건 조회는 회차를 소모하지 않는다 — 동기화 뒤에도 열려 있다', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/products/K022102',
      headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().producto.codigo, 'K022102');
  });

  test('없는 코드는 404 ERR_NOT_FOUND', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/products/NO-EXISTE',
      headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().codigoError, 'ERR_NOT_FOUND');
  });

  test('브랜드 목록을 준다 — 고객이 비교 컬럼을 코드에 고정하지 않게', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/brands',
      headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 200);
    const marcas = r.json().marcas;
    assert.ok(marcas.some((m) => m.marca === 'SYD'), '기본 출처(scode)는 SYD 하나다');
    assert.equal(marcas.some((m) => m.marca === 'MOOG'), false,
      '내보내지 않는 브랜드가 목록에 뜨면 안 된다');
  });

  test('접속창 밖이면 403 + proximaVentana', async () => {
    // 지금 이 순간 열려 있지 않은 요일·시간으로 바꿔 둔다
    const otroDia = (new Date(Date.now() - 360 * 60000).getUTCDay() + 3) % 7;
    await app.inject({ method: 'PATCH', url: `/api/catalog/admin/clients/${clientId}`,
      headers: bearer(dirId), payload: { window_enforced: true, window_dow: otroDia,
        window_start_hour: 5, window_end_hour: 9 } });
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/products',
      headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().codigoError, 'ERR_FUERA_DE_VENTANA');
    assert.match(r.json().proximaVentana, /T05:00:00-06:00$/);
    await app.inject({ method: 'PATCH', url: `/api/catalog/admin/clients/${clientId}`,
      headers: bearer(dirId), payload: { window_enforced: false } });
  });

  test('테스트 키는 접속창을 무시한다 — 개발자가 평일에 붙어 볼 수 있어야 한다', async () => {
    const otroDia = (new Date(Date.now() - 360 * 60000).getUTCDay() + 3) % 7;
    await app.inject({ method: 'PATCH', url: `/api/catalog/admin/clients/${clientId}`,
      headers: bearer(dirId), payload: { window_enforced: true, window_dow: otroDia } });
    const tk = (await app.inject({ method: 'POST', url: `/api/catalog/admin/clients/${clientId}/key`,
      headers: bearer(dirId), payload: { env: 'test' } })).json().token;
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/products?limit=2',
      headers: { 'x-api-key': tk } });
    assert.equal(r.statusCode, 200);
    await app.inject({ method: 'PATCH', url: `/api/catalog/admin/clients/${clientId}`,
      headers: bearer(dirId), payload: { window_enforced: false } });
  });

  test('설정 검증 — 끝 시각이 시작보다 빠르면 저장 자체가 막힌다', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/api/catalog/admin/clients/${clientId}`,
      headers: bearer(dirId), payload: { window_start_hour: 9, window_end_hour: 5 } });
    assert.equal(r.statusCode, 400);
    assert.ok(r.json().fields.includes('window_range_invalid'));
  });

  test('미리보기는 고객이 받을 것과 같은 값을 보여 주고 아무것도 소모하지 않는다', async () => {
    const before = (await query(`SELECT count(*)::int AS n FROM catalog_api_calls`)).rows[0].n;
    const d = (await app.inject({ method: 'GET',
      url: `/api/catalog/admin/clients/${clientId}/preview?codigo=K022101`,
      headers: bearer(dirId) })).json();
    assert.equal(d.precio_base.descuento_aplicado, 20);
    assert.equal(d.precio_base.ejemplo.precioCompra, 800);
    assert.equal(d.productos[0].precio.precioCompra, 800);
    const after = (await query(`SELECT count(*)::int AS n FROM catalog_api_calls`)).rows[0].n;
    assert.equal(after, before, '미리보기는 호출 이력을 남기지 않는다');
  });

  test('★ 엑셀용 전체 내보내기 — 고객이 받을 것과 같고, 접속창·회차를 건드리지 않는다', async () => {
    const beforeCalls = (await query(`SELECT count(*)::int AS n FROM catalog_api_calls`)).rows[0].n;
    const beforeRuns = (await query(`SELECT count(*)::int AS n FROM catalog_api_runs`)).rows[0].n;

    const r = await app.inject({ method: 'GET', url: `/api/catalog/admin/clients/${clientId}/export`,
      headers: bearer(dirId) });
    assert.equal(r.statusCode, 200);
    const d = r.json();
    assert.equal(d.total, d.productos.length, 'total 과 실제 건수가 같아야 한다');
    assert.ok(d.productos.length >= 6);
    assert.equal(d.productos.some((p) => p.codigo.startsWith('PRO')), false, 'PRO 는 여기에도 없다');

    const p1 = d.productos.find((x) => x.codigo === 'K022101');
    assert.equal(p1.precio.precioCompra, 800, '가격이 고객이 받을 값과 같다');
    assert.equal(p1.existencia, '6-10', '재고도 고객이 받을 구간 그대로');
    assert.deepEqual(p1.referencias.map((x) => x.codigo), ['SYD-K1', 'SYD-B1']);

    assert.equal((await query(`SELECT count(*)::int AS n FROM catalog_api_calls`)).rows[0].n,
      beforeCalls, '호출 이력을 남기지 않는다');
    assert.equal((await query(`SELECT count(*)::int AS n FROM catalog_api_runs`)).rows[0].n,
      beforeRuns, '주간 회차를 소모하지 않는다');
  });

  test('전체 내보내기는 디렉터만', async () => {
    assert.equal((await app.inject({ method: 'GET',
      url: `/api/catalog/admin/clients/${clientId}/export` })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET',
      url: `/api/catalog/admin/clients/${clientId}/export`, headers: bearer(salesId) })).statusCode, 403);
  });

  test('호출 1건 = 이력 1행 — 실패한 호출도 남는다', async () => {
    const d = (await app.inject({ method: 'GET', url: `/api/catalog/admin/clients/${clientId}/calls`,
      headers: bearer(dirId) })).json();
    assert.ok(d.calls.length > 0);
    assert.ok(d.calls.some((c) => c.codigo_error === 'ERR_YA_SINCRONIZADO'));
    assert.ok(d.runs.length > 0);
    assert.ok(d.runs[d.runs.length - 1].closed_at, '다 받아 간 회차는 닫혀 있다');
  });

  test('키를 폐기하면 그 즉시 막힌다', async () => {
    await app.inject({ method: 'POST', url: `/api/catalog/admin/clients/${clientId}/revoke`,
      headers: bearer(dirId), payload: { env: 'prod' } });
    const r = await app.inject({ method: 'GET', url: '/api/catalog/v1/products/K022101',
      headers: { 'x-api-key': KEY } });
    assert.equal(r.statusCode, 401);
  });

  test.after(async () => {
    await query(`DELETE FROM catalog_api_calls`);
    await query(`DELETE FROM catalog_api_runs`);
    await query(`DELETE FROM catalog_api_clients`);
    await query(`DELETE FROM product_applications WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'K02210%')`);
    await query(`DELETE FROM product_xref_codes   WHERE product_id IN (SELECT id FROM products WHERE code LIKE 'K02210%')`);
    await query(`DELETE FROM products WHERE code LIKE 'K02210%' OR code LIKE 'PRO02210%'`);
    await query(`DELETE FROM customers WHERE code=$1`, [CUST]);
    await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id IN ('t_dir_0221','t_sales_0221'))`);
    await query(`DELETE FROM users WHERE login_id IN ('t_dir_0221','t_sales_0221')`);
    await app.close();
    const { pool } = await import('../src/db.js');
    await pool.end();
  });
}
