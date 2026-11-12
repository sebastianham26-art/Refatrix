// =====================================================================
// pf_catalog_create.test.mjs — 2026-11-11 · 신규 CTR 생성 POST /api/pf-catalog/items (0326)
//   v2 2026-11-12: 행 검토(source refatrix-rowreview) · 품목 별칭 · 모르는 품목 = 경고 · 409 existing.source
//   A. 순수 — 코드 대문자 · 형식 · 예약 코드 · 제품명 필수 · category · pos 표기
//   B. 실제 서버 + PostgreSQL(TEST_PG_URL):
//      201 + item(status ok · confirmed_by_name · confirmed_at) · 목록 GET /items 에 바로 · 단건 이력 create ·
//      SYD · 적용차종 · OE 파생 · 장착위치 · 개발 중 · 판매 비활성 · 가격 · 재고 0 · 생성 기록(category) ·
//      같은 코드 409 CODE_EXISTS(대소문자 · ERP 기존 · 삭제 제품) · 동시 2건 → 1건만 · 400 형식 오류 ·
//      SYD 다른 CTR 연결 경고 · 0326 전 501 · 토큰 없음 / ERP 토큰 401
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/pf_catalog_create.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pf-catalog';
process.env.PRODUCT_PUSH_DEBOUNCE_MS = '20';
const K = await import('../src/pfCatalogCreate.js');

test('A. 본문 검사 · 정규화', () => {
  const ok = K.parseCreate({ code: ' cb-0812x ', name: '  ROTULA  INFERIOR ', scode: '1006035//1006036', app: 'HYUNDAI Accent 2018-2022//KIA Rio 2018-2023',
    pos: 'Front Lower', category: 'BALL', note: ' 메모 ' });
  assert.equal(ok.values.code, 'CB-0812X');
  assert.equal(ok.values.name, 'ROTULA  INFERIOR');
  assert.equal(ok.values.scode, '1006035 // 1006036');
  assert.equal(ok.values.app, 'HYUNDAI Accent 2018-2022 // KIA Rio 2018-2023');
  assert.equal(ok.values.pos, 'Delantera Inferior');
  assert.equal(ok.category, 'ball'); assert.equal(ok.source, 'refatrix-sample-review'); assert.equal(ok.note, '메모');
  const err = (b) => K.parseCreate(b).error;
  assert.equal(err(null), 'bad_body'); assert.equal(err([1]), 'bad_body');
  assert.equal(err({ name: 'X' }), 'code_required');
  assert.equal(err({ code: 'C B01', name: 'X' }), undefined, '공백은 지운다');
  assert.equal(err({ code: 'CB_01', name: 'X' }), 'bad_code');
  assert.equal(err({ code: 'AB', name: 'X' }), 'bad_code');
  assert.equal(err({ code: 'PRO123', name: 'X' }), 'code_reserved');
  assert.equal(err({ code: 'K0001', name: 'X' }), 'code_reserved');
  assert.equal(err({ code: 'KB0001', name: 'X' }), undefined, 'K 로 시작해도 키트 모양이 아니면 된다');
  assert.equal(err({ code: 'CB0001', name: '  ' }), 'name_required');
  // v2 — 모르는 품목은 막지 않고 경고
  const unk = K.parseCreate({ code: 'CB0001', name: 'X', category: 'wheel' });
  assert.equal(unk.error, undefined); assert.equal(unk.category, null); assert.equal(unk.category_in, 'wheel');
  assert.equal(unk.warnings[0].type, 'category_unknown');
  for (const [v, k] of [['Rótula', 'ball'], ['볼조인트', 'ball'], ['Terminal de dirección', 'tre'], ['타이로드 엔드 · 이너', 'tre'], ['Horquilla', 'ctl'],
    ['Tornillo estabilizador', 'stb'], ['BUJE', 'bush'], ['Amortiguador', 'shk'], ['Soporte', 'mnt'], ['Brazo loco', 'idl'], ['Brazo Pitman', 'idl'], ['기타', 'other'], ['tre', 'tre']]) {
    assert.equal(K.canonCategory(v), k, v);
  }
  assert.deepEqual(K.parseCreate({ code: 'CB0001', name: 'X', category: 'Rotula' }).warnings, []);
  assert.equal(K.parseCreate({ code: 'CB0001', name: 'X', source: ' Refatrix-RowReview ' }).source, 'refatrix-rowreview');
  assert.equal(K.sourceLabel('refatrix-rowreview'), 'SYD 카탈로그 행 검토'); assert.equal(K.sourceLabel('x'), '플랫폼');
  assert.equal(err({ code: 'CB0001', name: 'X', pos: 'arriba' }), 'bad_pos');
  assert.equal(K.parseCreate({ code: 'CB0001', name: 'X', category: '', pos: '' }).category, null, '빈 category · pos 허용');
});

test('B. 실제 서버 + PostgreSQL — 신규 CTR 생성', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  const MINE = `SELECT id FROM products WHERE code LIKE 'PFN%'`;
  async function cleanup() {
    for (const tb of ['pf_catalog_confirms', 'pf_catalog_review', 'pf_catalog_rounds', 'pf_catalog_creates', 'product_factory_log']) await query(`DELETE FROM ${tb} WHERE product_id IN (${MINE})`).catch(() => {});
    for (const tb of ['product_change_log', 'product_syd_codes', 'product_applications', 'product_oe_codes']) await query(`DELETE FROM ${tb} WHERE product_id IN (${MINE})`).catch(() => {});
    await query(`DELETE FROM crm_customer_outbox WHERE entity='product'`).catch(() => {});
    await query(`DELETE FROM products WHERE id IN (${MINE})`);
  }
  after(async () => { await cleanup().catch((e) => console.error('cleanup', e.message)); await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });

  const V = await import('../src/surveyViewer.js');
  const keepLog = V.platformApi.log;
  const plog = [];
  V.platformApi.log = async (tok, txt) => { plog.push(txt); return tok.startsWith('aaaaaaaa') ? { ok: true } : { ok: false, invalid: true }; };
  t.after(() => { V.platformApi.log = keepLog; });
  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  t.after(() => app.close());
  const call = (h, method, url, payload) => app.inject({ method, url, payload, headers: h });
  const one = async (sql, a) => (await query(sql, a)).rows[0];

  await cleanup();
  // ERP 에 이미 있는 제품 2개(하나는 삭제됨) · SYD 1006035 는 PFN900 에 이미 연결
  const ex = await one(`INSERT INTO products (code, name, scode, list_price, stock_qty) VALUES ('PFN900','ROTULA','1006035',100,5) RETURNING id`);
  await query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,'1006035')`, [ex.id]);
  await one(`INSERT INTO products (code, name, deleted_at) VALUES ('PFN901','BORRADO', now()) RETURNING id`);

  // ── 인증 ──
  const url = '/api/pf-catalog/items';
  const body = {
    code: 'pfn0812', name: 'ROTULA INFERIOR', scode: '1006035 // 1006099',
    app: 'HYUNDAI Accent 2018-2022 // KIA Rio 2018-2023', oe: '54530-H8000', material: '', pos: 'Delantera Inferior',
    category: 'ball', note: '샘플 검토 신규 생성 (SYD 1006035) · Park · 시험', source: 'refatrix-sample-review',
  };
  assert.equal((await call({}, 'POST', url, body)).statusCode, 401, '토큰 없음');
  const erpTok = app.jwt.sign({ sub: 1, typ: 'erp' });
  assert.equal((await call({ authorization: 'Bearer ' + erpTok }, 'POST', url, body)).statusCode, 401, 'ERP 토큰 401');
  const lg = await call({}, 'POST', '/api/pf-catalog/login', { token: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Park CTR', user_key: '12' });
  assert.equal(lg.statusCode, 200, lg.body);
  const H = { authorization: 'Bearer ' + lg.json().token };

  // ── 0326 전 → 501(플랫폼은 「ERP 전송 대기」) · 아무것도 안 만든다 ──
  K.setPfCreateReady(false);
  let r = await call(H, 'POST', url, body);
  assert.equal(r.statusCode, 501, r.body); assert.equal(r.json().error, 'migration_required');
  assert.equal((await one(`SELECT count(*)::int AS n FROM products WHERE code='PFN0812'`)).n, 0);
  K.setPfCreateReady(true);

  // ── 성공 201 ──
  r = await call(H, 'POST', url, body);
  assert.equal(r.statusCode, 201, r.body);
  const it = r.json().item;
  assert.equal(it.code, 'PFN0812', '대문자'); assert.equal(it.status, 'ok', '확정 상태');
  assert.equal(it.confirmed_by_name, 'Park CTR'); assert.ok(it.confirmed_at, 'confirmed_at');
  assert.ok(it.id > 0 && typeof it.rev === 'string' && it.rev, 'id · rev');
  assert.equal(it.scode, '1006035 // 1006099'); assert.equal(it.oe, '54530-H8000');
  assert.equal(it.pos, 'Delantera Inferior'); assert.equal(it.pos_src, 'erp'); assert.equal(it.material, null);
  assert.equal(it.activo, false, '판매 비활성');
  assert.equal(it.confirm_count, 1);
  assert.ok(it.history.some((h) => h.action === 'create' && h.by === 'Park CTR'), '제품 이력 create(Platform)');
  assert.ok(it.confirms[0].note.includes('신규 CTR 생성 · 볼조인트') && it.confirms[0].note.includes('Park'), '확정 메모에 작업자');
  assert.deepEqual(r.json().warnings, [{ type: 'syd_linked_elsewhere', syd: '1006035', codes: ['PFN900'] }], 'SYD 다른 CTR 연결 경고');
  for (const k of ['list_price', 'stock_qty', 'avg_cost']) assert.ok(!(k in it), `${k} 없음`);

  const row = await one(`SELECT * FROM products WHERE code='PFN0812'`);
  assert.equal(row.is_active, false); assert.equal(row.factory_status, 'development');
  assert.ok(row.inactive_reason.includes('개발 중'));
  assert.equal(Number(row.list_price), 0); assert.equal(Number(row.stock_qty), 0); assert.equal(Number(row.avg_cost), 0);
  assert.equal(row.mount_pos, 'Delantera Inferior'); assert.equal(row.created_by, null);
  assert.deepEqual((await query(`SELECT syd_code FROM product_syd_codes WHERE product_id=$1 ORDER BY 1`, [row.id])).rows.map((x) => x.syd_code), ['1006035', '1006099']);
  const apps = (await query(`SELECT maker, model, year_from, year_to FROM product_applications WHERE product_id=$1 ORDER BY id`, [row.id])).rows;
  assert.equal(apps.length, 2); assert.equal(apps[0].maker, 'HYUNDAI'); assert.equal(apps[1].maker, 'KIA');
  assert.equal((await one(`SELECT count(*)::int AS n FROM product_oe_codes WHERE product_id=$1`, [row.id])).n, 1, 'OE 파생');
  const cr = await one(`SELECT * FROM pf_catalog_creates WHERE product_id=$1`, [row.id]);
  assert.equal(cr.category, 'ball'); assert.equal(cr.source, 'refatrix-sample-review'); assert.equal(cr.pf_user_name, 'Park CTR');
  assert.ok(!('list_price' in cr.payload));
  assert.equal((await one(`SELECT new_value FROM product_factory_log WHERE product_id=$1`, [row.id])).new_value, 'development');
  assert.ok(plog.some((x) => x.includes('신규 CTR 생성 · PFN0812')), '플랫폼 비트코라');

  // ── 목록에 바로 · SYD 로도 찾힘 ──
  let L = (await call(H, 'GET', '/api/pf-catalog/items?q=PFN0812')).json();
  assert.equal(L.items.length, 1); assert.equal(L.items[0].status, 'ok');
  L = (await call(H, 'GET', '/api/pf-catalog/items?q=1006099')).json();
  assert.ok(L.items.some((x) => x.code === 'PFN0812'));

  // ── 같은 코드 409 (대소문자 무시 · 기존 ERP · 삭제 제품) ──
  r = await call(H, 'POST', url, { ...body, code: 'PFN0812' });
  assert.equal(r.statusCode, 409, r.body); assert.equal(r.json().error, 'CODE_EXISTS');
  assert.equal(r.json().existing.from_sample_review, true);
  r = await call(H, 'POST', url, { ...body, code: 'pfn900' });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error, 'CODE_EXISTS'); assert.equal(r.json().existing.from_sample_review, false);
  r = await call(H, 'POST', url, { ...body, code: 'PFN901' });
  assert.equal(r.statusCode, 409); assert.equal(r.json().existing.deleted, true);
  assert.equal((await one(`SELECT name FROM products WHERE code='PFN900'`)).name, 'ROTULA', '기존 제품 그대로');

  // ── 400 형식 오류 — 메시지(detail) 포함 · 아무것도 안 만든다 ──
  for (const [b, e] of [[{ ...body, code: 'PFN0813', name: '' }, 'name_required'],
    [{ ...body, code: 'PFN0813', pos: 'arriba' }, 'bad_pos'], [{ ...body, code: 'PFN_13' }, 'bad_code'], [{ ...body, code: 'PRO0813' }, 'code_reserved']]) {
    r = await call(H, 'POST', url, b);
    assert.equal(r.statusCode, 400, `${e}: ${r.body}`); assert.equal(r.json().error, e); assert.ok(r.json().detail);
  }
  assert.equal((await one(`SELECT count(*)::int AS n FROM products WHERE code LIKE 'PFN0813%' OR code LIKE 'PFN_13'`)).n, 0);

  // ── v2 · 행 검토(SYD 카탈로그 · 매칭테스트 「ERP에 CTR 없음」) ──
  const rb = { code: 'PFN0814', name: 'TERMINAL DIRECCION EXT', scode: '1006200', app: 'NISSAN Versa 2012-2019', oe: '48520-3AN0A',
    category: 'Terminal de dirección', note: 'SYD 1006200 행 검토 · Kim', source: 'refatrix-rowreview' };
  r = await call(H, 'POST', url, rb);
  assert.equal(r.statusCode, 201, r.body);
  assert.ok(r.json().item.confirms[0].note.startsWith('[신규 CTR 생성 · 타이로드 엔드 · 이너 · SYD 카탈로그 행 검토]'), r.json().item.confirms[0].note);
  assert.deepEqual(r.json().warnings, []);
  const rrow = await one(`SELECT p.inactive_reason, p.is_active, p.factory_status, c.category, c.source FROM products p JOIN pf_catalog_creates c ON c.product_id=p.id WHERE p.code='PFN0814'`);
  assert.equal(rrow.category, 'tre'); assert.equal(rrow.source, 'refatrix-rowreview');
  assert.equal(rrow.inactive_reason, '개발 중 — REFATRIX Platform SYD 카탈로그 행 검토 신규 생성');
  assert.equal(rrow.is_active, false); assert.equal(rrow.factory_status, 'development');
  assert.ok(plog.some((x) => x.includes('SYD 카탈로그 행 검토 신규 CTR 생성 · PFN0814')), '비트코라 출처');
  // 응답이 끊겨 다시 보낸 경우 → 409 · 출처와 SYD 로 「이미 만든 건」 판단 가능
  r = await call(H, 'POST', url, rb);
  assert.equal(r.statusCode, 409);
  const exi = r.json().existing;
  assert.equal(exi.source, 'refatrix-rowreview'); assert.equal(exi.from_platform, true); assert.equal(exi.from_sample_review, true);
  assert.deepEqual(exi.syd_codes, ['1006200']); assert.ok(exi.created_at);
  r = await call(H, 'POST', url, { ...body, code: 'pfn900' });
  assert.equal(r.json().existing.source, null); assert.deepEqual(r.json().existing.syd_codes, ['1006035']);
  // 모르는 품목 → 그래도 만든다 + 경고 · 원문은 생성 기록에
  r = await call(H, 'POST', url, { ...rb, code: 'PFN0815', scode: '', category: 'rueda' });
  assert.equal(r.statusCode, 201, r.body);
  assert.deepEqual(r.json().warnings.map((w) => w.type), ['category_unknown']);
  const ucr = await one(`SELECT c.category, c.payload FROM pf_catalog_creates c JOIN products p ON p.id=c.product_id WHERE p.code='PFN0815'`);
  assert.equal(ucr.category, null); assert.equal(ucr.payload.category_in, 'rueda');

  // ── 최소 본문(code · name) · 동시 2건 → 1건만 ──
  const [a1, a2] = await Promise.all([call(H, 'POST', url, { code: 'PFN0900', name: 'BUJE' }), call(H, 'POST', url, { code: 'pfn0900', name: 'BUJE' })]);
  assert.deepEqual([a1.statusCode, a2.statusCode].sort(), [201, 409], `${a1.body} ${a2.body}`);
  assert.equal((await one(`SELECT count(*)::int AS n FROM products WHERE upper(code)='PFN0900'`)).n, 1);
  const m = [a1, a2].find((x) => x.statusCode === 201).json();
  assert.equal(m.item.scode, null); assert.deepEqual(m.warnings, []);

  // ── 생성한 품목은 카탈로그 점검 규칙 그대로 — ERP 에서 값을 바꾸면 재확인 ──
  await query(`UPDATE products SET name='ROTULA INF' WHERE code='PFN0812'`);
  assert.equal((await call(H, 'GET', `/api/pf-catalog/items/${it.id}`)).json().status, 'changed');
  await new Promise((res) => setTimeout(res, 120));   // CRM 묶음 전송 · 개발요청 매칭 점검이 끝나도록
});
