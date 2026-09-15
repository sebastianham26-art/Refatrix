// ERP → CRM 제품 카탈로그 전송(계약서 v1.0) — 적재·묶음·마감신호·전송 테스트
//
//   순수 로직(구간·사진주소·본문·묶기)은 DB 없이 돌고,
//   적재·전송·하루1회 잠금은 TEST_PG_URL 이 있을 때만 실제 PostgreSQL + 모의 CRM 으로 돈다.
//
//   ⚠ 두 제품 스위트는 같은 표를 쓴다 — 반드시 직렬로: --test-concurrency=1
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/product_sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;

// 모의 CRM — 받은 본문을 그대로 모아 둔다.
let scenario = { status: 200, body: { codigoError: '0', mensaje: 'OK' } };
const received = [];
const crm = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    res.writeHead(scenario.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scenario.body));
  });
});
await new Promise((r) => crm.listen(0, '127.0.0.1', r));
const CRM_URL = `http://127.0.0.1:${crm.address().port}/api/integrations/erp/productos`;

const {
  stockRange, imageUrlFor, buildProduct, buildLote, chunk, mxNowParts,
  applyMap, PRODUCT_FIELDS, firstSyd,
} = await import('../src/productSync.js');

// ── ① 순수 로직 ──────────────────────────────────────────────────────
test('재고 구간은 경계에서 정확히 갈린다', () => {
  assert.equal(stockRange(0), '0');
  assert.equal(stockRange(-5), '0');          // 마이너스 재고도 0 으로 보인다
  assert.equal(stockRange(1), '1-10');
  assert.equal(stockRange(10), '1-10');
  assert.equal(stockRange(10.9), '1-10');     // 소수 재고는 내림
  assert.equal(stockRange(11), '11-20');
  assert.equal(stockRange(20), '11-20');
  assert.equal(stockRange(21), '21-30');
  assert.equal(stockRange(30), '21-30');
  assert.equal(stockRange(31), '+30');
  assert.equal(stockRange(5000), '+30');
  assert.equal(stockRange(null), '0');
});

test('사진 주소 — 기본주소가 없으면 빈 값, {code} 자리 치환, 없으면 코드.jpg', () => {
  assert.equal(imageUrlFor('', 'CA0032'), '');
  assert.equal(imageUrlFor('https://x.mx/fotos', 'CA0032'), 'https://x.mx/fotos/CA0032.jpg');
  assert.equal(imageUrlFor('https://x.mx/fotos/', 'CA0032'), 'https://x.mx/fotos/CA0032.jpg');
  assert.equal(imageUrlFor('https://x.mx/img/{code}_1.png', 'CA0032'), 'https://x.mx/img/CA0032_1.png');
  assert.equal(imageUrlFor('https://x.mx/fotos', ''), '');
});

test('제품 본문은 계약서의 이름·타입 그대로다', () => {
  const p = buildProduct({
    code: 'CE0427', name: 'TERMINAL EXTERIOR',
    app: 'MITSUBISHI Asx 2013-2015 // MITSUBISHI Lancer 2008-2016',
    scode: '1115007 // 1115008', list_price: '245.499', stock_qty: '15', is_active: true,
  }, 'https://x.mx/fotos');
  assert.deepEqual(Object.keys(p), PRODUCT_FIELDS);
  assert.equal(p.codigo, 'CE0427');
  assert.equal(typeof p.precioLista, 'number');       // NUMERIC 은 문자열로 오므로 숫자로 바꿔야 한다
  assert.equal(p.precioLista, 245.5);
  assert.equal(p.moneda, 'MXN');
  assert.equal(p.existencia, '11-20');
  assert.equal(p.imagenUrl, 'https://x.mx/fotos/CE0427.jpg');
  assert.equal(p.activo, true);
});

test('비활성 제품도 보낸다 — activo:false 로', () => {
  const p = buildProduct({ code: 'X1', name: 'n', list_price: 0, stock_qty: 0, is_active: false }, '');
  assert.equal(p.activo, false);
  assert.equal(p.imagenUrl, '');
  assert.equal(p.aplicaciones, '');
  assert.equal(p.referenciaSyd, '');
});

test('마감 신호는 전체 전송의 마지막 묶음에만 붙는다', () => {
  const meta = { envioId: 'CAT-2026-09-15', fechaCorte: '2026-09-15', totalLotes: 3, totalProductos: 7, transactionUser: 'admin', mode: 'full' };
  assert.equal(buildLote({ ...meta, lote: 1 }, []).esUltimoLote, false);
  assert.equal(buildLote({ ...meta, lote: 2 }, []).esUltimoLote, false);
  assert.equal(buildLote({ ...meta, lote: 3 }, []).esUltimoLote, true);
});

test('시험 전송은 절대 마감하지 않는다 (카탈로그가 통째로 감춰지는 사고 방지)', () => {
  const meta = { envioId: 'TEST-202609151230', fechaCorte: '2026-09-15', totalLotes: 1, totalProductos: 5, transactionUser: 'admin', mode: 'test' };
  assert.equal(buildLote({ ...meta, lote: 1 }, []).esUltimoLote, false);
});

test('묶기 — 크기대로 나누고 범위를 벗어난 값은 조정한다', () => {
  const list = Array.from({ length: 25 }, (_, i) => i);
  assert.deepEqual(chunk(list, 10).map((c) => c.length), [10, 10, 5]);
  assert.equal(chunk(list, 0).length, 1);              // 0 → 기본 500
  assert.equal(chunk(list, 1).length, 3);              // 1 → 최소 10
  assert.equal(chunk(list, 999999).length, 1);         // 상한 2000
  assert.deepEqual(chunk([], 10), []);
});

test('멕시코 날짜는 UTC 가 아니라 현지(UTC-6) 기준이다', () => {
  // 2026-09-16 03:00 UTC = 멕시코 2026-09-15 21:00
  const p = mxNowParts(Date.parse('2026-09-16T03:00:00Z'));
  assert.equal(p.ymd, '2026-09-15');
  assert.equal(p.hour, 21);
});

test('CRM 열 이름으로 갈아 끼울 수 있다 — 빈 이름은 그 필드를 뺀다', () => {
  const p = buildProduct({
    code: 'CA0032', name: 'BRAZO AUXILIAR', app: 'NISSAN Frontier 4X2 1998-2004',
    scode: '48530-3S125', list_price: 764, stock_qty: 15, is_active: true,
    sat_code: '25174200', origin: 'KR', iva_rate: 16, ean: '7501234567890',
    location: 'A-12', list_price_syd: 800, price_customer_ctr: 433.01,
  }, '');
  const map = {
    codigo: 'claveCTR', descripcion: 'producto', aplicaciones: 'aplicacion',
    referenciaSyd: 'claveSYD', precioLista: 'precio', sat: 'sat', origen: 'origen',
    iva: 'iva', ean13: 'ean13', ubicacion: 'ubicacion',
    precioListaComp: 'precioListaComp', customerPrice: 'customerPrice',
    moneda: '',                                    // 빈 이름 = 보내지 않는다
  };
  const out = applyMap(p, map, PRODUCT_FIELDS);
  assert.equal(out.claveCTR, 'CA0032');
  assert.equal(out.producto, 'BRAZO AUXILIAR');
  assert.equal(out.claveSYD, '48530-3S125');
  assert.equal(out.precio, 764);
  assert.equal(out.customerPrice, 433.01);
  assert.equal(out.ean13, '7501234567890');
  assert.equal('codigo' in out, false, '옛 이름은 남으면 안 된다');
  assert.equal('moneda' in out, false, '빈 이름으로 지정한 필드는 빠진다');
  assert.equal(out.existencia, '11-20', '지정 없는 필드는 우리 이름 그대로');
});

test('본문 형식 — 묶음 · 제품 배열 · 1건씩', () => {
  const meta = { envioId: 'CAT-2026-09-15', fechaCorte: '2026-09-15', lote: 1, totalLotes: 1,
    totalProductos: 2, transactionUser: 'admin', mode: 'full' };
  const ps = [
    buildProduct({ code: 'A1', name: 'n1', list_price: 10, stock_qty: 1, is_active: true }, ''),
    buildProduct({ code: 'A2', name: 'n2', list_price: 20, stock_qty: 2, is_active: true }, ''),
  ];
  const lote = buildLote(meta, ps, { shape: 'lote' });
  assert.equal(lote.productos.length, 2);
  assert.equal(lote.esUltimoLote, true);

  const arr = buildLote(meta, ps, { shape: 'array' });
  assert.ok(Array.isArray(arr), '루트가 배열이어야 한다');
  assert.equal(arr.length, 2);
  assert.equal(arr[0].codigo, 'A1');

  const item = buildLote(meta, ps, { shape: 'item' });
  assert.equal(Array.isArray(item), false);
  assert.equal(item.codigo, 'A1', '1건씩이면 봉투 없이 제품 하나만');
  assert.equal(item.esUltimoLote, undefined, '봉투가 없으니 마감 신호도 없다');

  // 봉투 이름도 갈아 끼울 수 있다
  const renamed = buildLote(meta, ps, { shape: 'lote', map: { productos: 'items', envioId: 'idEnvio' } });
  assert.equal(renamed.items.length, 2);
  assert.equal(renamed.idEnvio, 'CAT-2026-09-15');
  assert.equal('productos' in renamed, false);
});

test('상대 규격이 요구하는 다른 모양 — 첫 SYD 코드 · active 문자열 · 코드 두 번 · 작업자', () => {
  assert.equal(firstSyd('12345 // 67890'), '12345');
  assert.equal(firstSyd('  1603005  //  1516049 '), '1603005');
  assert.equal(firstSyd(''), '');
  assert.equal(firstSyd(null), '');

  const on = buildProduct({ code: 'GV0022', name: 'BRAZO', scode: '12345 // 67890',
    list_price: 403.9, stock_qty: 5, is_active: true }, '');
  assert.equal(on.internalSku, 'GV0022', '제품코드를 두 번째 이름으로도 보낼 수 있어야 한다');
  assert.equal(on.sydCode1, '12345');
  assert.equal(on.statusCode, 'active', 'true/false 가 아니라 문자열');
  const off = buildProduct({ code: 'X', name: 'n', list_price: 0, stock_qty: 0, is_active: false }, '');
  assert.equal(off.statusCode, 'inactive');
  assert.equal(off.activo, false, '옛 boolean 필드도 남는다(다른 상대를 위해)');
});

test('개발자 규격(2026-09-15) 그대로 만들어진다 — 1건씩 · 없는 필드는 빠진다', () => {
  const row = { code: 'GV0022', name: 'BRAZO AUXILIAR', app: 'NISSAN X 2000-2005',
    scode: '12345 // 67890', list_price: 403.9, stock_qty: 5, is_active: true,
    sat_code: '25172000', origin: 'KR', iva_rate: 16, ean: '7500000000000',
    location: 'A1', list_price_syd: 500, price_customer_ctr: 350 };
  const map = {
    codigo: 'ctrCode', internalSku: 'internalSku', descripcion: 'descriptionEs',
    sydCode1: 'sydCode1', sat: 'satClass', ean13: 'ean13', origen: 'originCode',
    precioLista: 'listPriceMxn', statusCode: 'statusCode', transactionUser: 'transactionUser',
    // 그 규격에 없는 것들은 뺀다
    aplicaciones: '', referenciaSyd: '', moneda: '', existencia: '', imagenUrl: '',
    activo: '', iva: '', ubicacion: '', precioListaComp: '', customerPrice: '',
  };
  const body = buildLote(
    { envioId: 'TEST-1', fechaCorte: '2026-09-15', lote: 1, totalLotes: 1,
      totalProductos: 1, transactionUser: 'usuario_erp', mode: 'test' },
    [buildProduct(row, '')], { map, shape: 'item' });

  assert.deepEqual(Object.keys(body).sort(), [
    'ctrCode', 'descriptionEs', 'ean13', 'internalSku', 'listPriceMxn',
    'originCode', 'satClass', 'statusCode', 'sydCode1', 'transactionUser'].sort());
  assert.equal(body.ctrCode, 'GV0022');
  assert.equal(body.internalSku, 'GV0022');
  assert.equal(body.descriptionEs, 'BRAZO AUXILIAR');
  assert.equal(body.sydCode1, '12345', 'SYD 는 첫 번째 하나만');
  assert.equal(body.listPriceMxn, 403.9);
  assert.equal(body.statusCode, 'active');
  assert.equal(body.transactionUser, 'usuario_erp', '봉투가 없으므로 제품 안에 들어간다');
  assert.equal('aplicaciones' in body, false);
  assert.equal('codigo' in body, false);
});

test('봉투 형식에서는 transactionUser 가 제품 안에 중복되지 않는다', () => {
  const p = buildProduct({ code: 'A', name: 'n', list_price: 1, stock_qty: 1, is_active: true }, '');
  const lote = buildLote({ envioId: 'C', fechaCorte: '2026-09-15', lote: 1, totalLotes: 1,
    totalProductos: 1, transactionUser: 'admin', mode: 'full' }, [p], { shape: 'lote' });
  assert.equal(lote.transactionUser, 'admin');
  assert.equal('transactionUser' in lote.productos[0], false);
});

// ── ② 화면(연동 관리) 정적 점검 ──────────────────────────────────────
test('연동 관리 화면에 제품 전송 카드가 있고, 쓰는 id 가 전부 실제로 있다', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../../refatrix-integrations.html', import.meta.url), 'utf8');
  for (const id of ['boxProduct', 'fImgBase', 'fBatch', 'fSendHour', 'fAutoSend',
    'btnCatalogSend', 'btnCatalogTest', 'btnCatalogPreview', 'btnCatalogReload',
    'catalogMsg', 'catalogRuns',
    'fBodyShape', 'fieldMapRows', 'btnMapPreset', 'btnMapClear', 'shapeHint']) {
    const n = html.split('id="' + id + '"').length - 1;
    assert.equal(n, 1, id + ' 는 정확히 한 번 있어야 한다');
  }
  // 스크립트가 참조하는 id 는 모두 마크업에 있어야 한다(오타 방지)
  const script = html.slice(html.indexOf('loadCatalogStatus'), html.indexOf('function cfgPatch'));
  for (const m of script.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)) {
    assert.ok(html.includes('id="' + m[1] + '"'), '화면에 없는 id 를 씁니다: ' + m[1]);
  }
  // 인라인 스크립트는 문법이 맞아야 한다
  const blocks = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 2);
  for (const b of blocks) new Function(b[1]);          // 던지면 테스트 실패
  // 제품 창구에서는 고객 전용 버튼·칸이 숨겨져야 한다(제품 화면의 「전체 동기화」는 고객을 보낸다)
  const dir = html.slice(html.indexOf('function applyDirection'), html.indexOf('function fillCfg'));
  assert.ok(/category==='product'/.test(dir), '제품 창구를 구분해야 한다');
  assert.ok(/\$\('btnBulk'\)\.classList\.toggle\('hidden',!!prod\)/.test(dir), '전체 동기화(고객) 버튼을 숨겨야 한다');
  assert.ok(/\$\('tCustomer'\)\.classList\.toggle\('hidden',!!inb\|\|!!prod\)/.test(dir), '시험 전송할 고객 칸을 숨겨야 한다');
  // 이 저장소 규약: 인라인 onclick 금지
  assert.ok(!/onclick=/.test(html.slice(html.indexOf('boxProduct'), html.indexOf('boxTokens'))));
});

// ── ③ 실 DB + 모의 CRM ───────────────────────────────────────────────
const dbTest = PG ? test : test.skip;

dbTest('적재 → 전송 → 이력까지 (실 PostgreSQL)', async (t) => {
  const { query } = await import('../src/db.js');
  const { invalidateEndpointCache } = await import('../src/integrations.js');
  const { runCatalogSync, listRuns, autoRanToday, mxNowParts: mx } = await import('../src/productSync.js');
  const { drainOutbox } = await import('../src/crmSync.js');

  // 깨끗한 상태에서 시작
  await query(`DELETE FROM crm_customer_outbox WHERE entity='product'`);
  await query(`DELETE FROM product_sync_runs`);
  await query(`DELETE FROM products WHERE code LIKE 'T%'`);
  for (let i = 1; i <= 25; i++) {
    await query(
      `INSERT INTO products (code, name, app, scode, list_price, stock_qty, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (code) DO UPDATE SET stock_qty=EXCLUDED.stock_qty`,
      [`T${String(i).padStart(4, '0')}`, `PIEZA ${i}`, 'NISSAN Frontier 4X2 1998-2004',
       '1603005 // 1516049', 100 + i, i, i !== 7]);       // 7번은 비활성
  }
  await query(
    `UPDATE integration_endpoints
        SET enabled=true, env='test', url_test=$1, auth_in='header', auth_header='x-api-key',
            auth_token_test='llave-de-pruebas', batch_size=10, img_base_url='https://fotos.refatrix.mx/ctr',
            auto_send=false, send_hour_mx=6, timeout_ms=3000
      WHERE key='product'`, [CRM_URL]);
  invalidateEndpointCache();

  // ── 전체 전송 적재
  const run = await runCatalogSync({ mode: 'full', origin: 'manual', actorUserId: null });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.total_productos, 25);
  assert.equal(run.total_lotes, 3);                       // 10 · 10 · 5
  assert.match(run.envio_id, /^CAT-\d{4}-\d{2}-\d{2}$/);
  assert.equal(run.queued_only, false);

  const rows = (await query(
    `SELECT * FROM crm_customer_outbox WHERE entity='product' AND entity_id=$1 ORDER BY id`,
    [run.run_id])).rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].customer_id, null, '제품 건은 고객이 없다');
  assert.equal(rows[0].endpoint_key, 'product');
  assert.equal(rows[0].status, 'pending');

  const p1 = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
  const p3 = typeof rows[2].payload === 'string' ? JSON.parse(rows[2].payload) : rows[2].payload;
  assert.equal(p1.lote, 1); assert.equal(p1.totalLotes, 3); assert.equal(p1.totalProductos, 25);
  assert.equal(p1.esUltimoLote, false);
  assert.equal(p3.esUltimoLote, true, '마지막 묶음에만 마감 신호');
  assert.equal(p1.productos.length, 10);
  assert.equal(p3.productos.length, 5);
  assert.equal(p1.envioId, p3.envioId, '같은 실행의 묶음은 envioId 가 같다');
  assert.equal(p1.productos[0].imagenUrl, 'https://fotos.refatrix.mx/ctr/T0001.jpg');
  const inactivo = [...p1.productos, ...p3.productos].find((x) => x.codigo === 'T0007');
  assert.equal(inactivo.activo, false, '비활성도 보내되 activo:false');

  // ── 실제 전송
  received.length = 0;
  const d = await drainOutbox({ limit: 10 });
  assert.equal(d.sent, 3, JSON.stringify(d));
  assert.equal(received.length, 3);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].headers['x-api-key'], 'llave-de-pruebas', '키가 헤더로 실려 나간다');
  assert.equal(received[2].body.esUltimoLote, true);
  const after = (await query(
    `SELECT status, http_status FROM crm_customer_outbox WHERE entity_id=$1 AND entity='product' ORDER BY id`,
    [run.run_id])).rows;
  assert.deepEqual(after.map((r) => r.status), ['sent', 'sent', 'sent']);

  // ── 실행 이력 집계
  const runs = await listRuns({ limit: 5 });
  assert.equal(runs[0].envio_id, run.envio_id);
  assert.equal(runs[0].sent, 3);
  assert.equal(runs[0].total_productos, 25);

  // ── 시험 전송: 몇 건만, TEST- 로 시작, 마감하지 않는다
  const t2 = await runCatalogSync({ mode: 'test', limit: 3, origin: 'manual' });
  assert.equal(t2.total_productos, 3);
  assert.match(t2.envio_id, /^TEST-/);
  const tp = (await query(
    `SELECT payload FROM crm_customer_outbox WHERE entity='product' AND entity_id=$1`, [t2.run_id])).rows;
  for (const r of tp) {
    const b = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
    assert.equal(b.esUltimoLote, false, '시험 전송에는 마감 신호가 없어야 한다');
  }

  // ── 같은 날 두 번째 전체 전송은 envioId 가 달라야 한다
  const run2 = await runCatalogSync({ mode: 'full', origin: 'manual' });
  assert.notEqual(run2.envio_id, run.envio_id);
  assert.match(run2.envio_id, /-2$/);

  // ── 자동 전송은 하루 한 번만 (DB 유니크 인덱스가 최종 방어)
  const { ymd } = mx();
  assert.equal(await autoRanToday(ymd), false);
  const auto1 = await runCatalogSync({ mode: 'full', origin: 'auto' });
  assert.equal(auto1.ok, true);
  assert.equal(await autoRanToday(ymd), true);
  const auto2 = await runCatalogSync({ mode: 'full', origin: 'auto' });
  assert.equal(auto2.ok, undefined, '같은 날 두 번째 자동 전송은 DB 가 막는다');
  assert.equal(auto2.error, 'enqueue_failed');

  // ── 연동이 꺼져 있으면: 적재는 되고, 전송은 시도 횟수를 쓰지 않고 대기한다
  await query(`UPDATE integration_endpoints SET enabled=false WHERE key='product'`);
  invalidateEndpointCache();
  const off = await runCatalogSync({ mode: 'test', limit: 2, origin: 'manual' });
  assert.equal(off.queued_only, true);
  assert.equal(off.note, 'endpoint_disabled');
  const d2 = await drainOutbox({ limit: 10 });
  assert.equal(d2.sent, 0);
  assert.ok(d2.held >= 1, '꺼진 연동은 held — 시도 횟수를 깎지 않는다');
  const heldRow = (await query(
    `SELECT attempts, status FROM crm_customer_outbox WHERE entity='product' AND entity_id=$1 LIMIT 1`,
    [off.run_id])).rows[0];
  assert.equal(Number(heldRow.attempts), 0);
  assert.equal(heldRow.status, 'pending');

  // 이 테스트 데이터는 다른 스위트(고객 전송 이력 건수 등)를 흔든다 — 반드시 치운다.
  await query(`DELETE FROM crm_customer_outbox WHERE entity='product'`);
  await query(`DELETE FROM product_sync_runs`);
  await query(`DELETE FROM products WHERE code LIKE 'T%'`);

  t.diagnostic(`묶음 전송 확인 완료 — 실행 ${run.envio_id}, 25제품 / 3묶음`);
});

test.after(() => { crm.close(); });
