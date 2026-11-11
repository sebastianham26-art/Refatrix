// =====================================================================
// xref_master_e2e.test.mjs — 0325 · 멕시코 경쟁사 크로스레퍼런스 마스터 (실 PostgreSQL + 실제 서버)
//   ① 업로드: 미리보기(dry_run) · 저장 · 한 칸 여러 코드('//' · '/') 분해 · 숫자 칸 · 디렉터 전용 · 버전 목록 · 원본 내려받기
//   ② 견적: 경쟁사 코드 → 마스터 SYD → ERP SYD → CTR · 브랜드 지정 시 그 칸만(숫자 충돌 방지) · SYD 둘 → 후보 선택
//          CTR 없으면 코드 + 브랜드 기록(quote_lines.input_brand) → 개발요청(input_brand)
//   ③ 개발요청 자동 검수: 제품 추가(SYD 등록) → 자동 개발완료(result_match_via='master') → 팝업 목록 → 확인 후 비움
//          후보 여럿 → match_candidates · 개발필요내용 brands · results · candidates
//   ④ 제품찾기: 경쟁사 코드 → 제품(xref_hit) · CTR 미등록 행 안내(xref_unbridged)
//   ⑤ (선택) 실제 파일 9,490행 업로드 시간 — XREF_AOA=/path/aoa.json
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/xref_master_e2e.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-xref-master';
const SKIP = !PG && 'TEST_PG_URL 없음';
const RUN = String(Date.now() % 9000 + 1000);
const TAG = 'XMT' + RUN;

let query, pool, app;
const ID = {}, tok = {};
const H = (w = 'dir') => ({ authorization: 'Bearer ' + tok[w] });
const get = (url, w) => app.inject({ method: 'GET', url, headers: H(w) });
const post = (url, payload, w) => app.inject({ method: 'POST', url, payload: payload || {}, headers: H(w) });

const HEAD = ['SYD', 'CTR', 'BAW', 'GROB', 'VAZLO', 'KYB', 'MOOG', 'DESCRIPCIÓN', 'PRECIO', 'APLICACIÓN', 'UBICACIÓN'];
const S = (n) => `${TAG}S${n}`;   // SYD 코드
const AOA = [
  HEAD,
  [S(1), null, `${TAG}-B1`, `${TAG}G1`, Number('64' + RUN + '1'), Number('33' + RUN + '1'), null, 'AMORTIGUADOR DELANTERO', 830, 'Honda Accord 2003-2007', 'Delantero'],
  [`${S(2)} // ${S(3)}`, null, `${TAG}-B2`, `${TAG}G2 // ${TAG}G2X`, null, `33${RUN}2/33${RUN}3`, null, 'HORQUILLA', 500, 'Nissan Versa', null],
  ['', null, `${TAG}-B3`, `${TAG}G3`, null, null, null, 'ROTULA', 300, 'Chevrolet Aveo 2008-2017', null],     // SYD 없음
  [S(4), null, `${TAG}-B4`, S(1), null, null, null, 'TERMINAL', 200, 'VW Jetta', null],                         // GROB 칸에 SYD(1)과 같은 번호
  [S(5), null, `${TAG}-B5`, `${TAG}G5`, null, null, `${TAG}M5`, 'BUJE', 150, 'Toyota Hilux', null],            // SYD(5) 는 처음엔 ERP 에 없음
  [null, null, null, null, null, null, null, null, null, null, null],                                          // 빈 행
];

async function purgeRefs(table, ids) {
  if (!ids.length) return;
  const fks = (await query(
    `SELECT c.conrelid::regclass::text AS t, a.attname AS col
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.confrelid = $1::regclass AND c.contype='f'`, [table])).rows;
  for (let pass = 0; pass < 3; pass++) for (const f of fks) { if (f.t === table) continue; await query(`DELETE FROM ${f.t} WHERE ${f.col} = ANY($1::bigint[])`, [ids]).catch(() => {}); }
}
async function cleanup() {
  try {
    const cids = (await query(`SELECT id FROM customers WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
    const qids = (await query(`SELECT id FROM quotes WHERE customer_id = ANY($1::bigint[])`, [cids])).rows.map((r) => Number(r.id));
    await query(`DELETE FROM product_dev_requests WHERE input_code LIKE '${TAG}%' OR source_quote_id = ANY($1::bigint[])`, [qids]);
    await purgeRefs('quotes', qids);
    await query(`DELETE FROM quote_lines WHERE quote_id = ANY($1::bigint[])`, [qids]);
    await query(`DELETE FROM quotes WHERE id = ANY($1::bigint[])`, [qids]);
    const pids = (await query(`SELECT id FROM products WHERE code LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
    await query(`DELETE FROM stock_shortages WHERE product_id = ANY($1::bigint[])`, [pids]).catch(() => {});
    await purgeRefs('products', pids);
    await query(`DELETE FROM products WHERE id = ANY($1::bigint[])`, [pids]);
    await purgeRefs('customers', cids);
    await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [cids]);
    await query(`DELETE FROM xref_master_versions WHERE filename LIKE '${TAG}%'`);
    const uids = (await query(`SELECT id FROM users WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
    await query(`DELETE FROM dev_match_seen WHERE user_id = ANY($1::bigint[])`, [uids]);
    await query(`DELETE FROM todos WHERE assignee_id = ANY($1::bigint[]) OR created_by = ANY($1::bigint[])`, [uids]).catch(() => {});
    await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [uids]).catch(() => {});
    await purgeRefs('users', uids);
    await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [uids]);
  } catch (e) { console.log('# cleanup(무시)', e.message); }
}

test('boot', { skip: SKIP }, async () => {
  ({ query, pool } = await import('../src/db.js'));
  const { hashPin } = await import('../src/auth.js');
  await cleanup();
  const mkU = async (n, role) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,$3,$4) RETURNING id`, [TAG + n, role, hashPin('4321'), (TAG + n).toLowerCase()])).rows[0].id);
  ID.dir = await mkU('dir', 'director');
  ID.sales = await mkU('sales', 'sales');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'products','anywhere','view'),($1,'quote','anywhere','edit')`, [ID.sales]);
  const mkP = async (code, syd, stock = 5) => {
    const id = Number((await query(`INSERT INTO products (code, name, stock_qty, avg_cost, list_price, scode) VALUES ($1,$2,$3,30,100,$4) RETURNING id`, [code, 'AMORTIGUADOR ' + code, stock, syd])).rows[0].id);
    if (syd) await query(`INSERT INTO product_syd_codes (product_id, syd_code) VALUES ($1,$2)`, [id, syd]);
    return id;
  };
  ID.A = await mkP(`${TAG}-A`, S(1));
  ID.B = await mkP(`${TAG}-B`, S(2));
  ID.C = await mkP(`${TAG}-C`, S(3));
  ID.cust = Number((await query(
    `INSERT INTO customers (name, code, credit_days, rfc, owner_id, created_by) VALUES ($1,$2,30,$4,$3,$3) RETURNING id`,
    [`${TAG}고객`, `${TAG}-C`, ID.dir, 'XMT0101' + RUN + 'A1'])).rows[0].id);
  const { buildApp } = await import('../src/server.js');
  app = buildApp(); await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.sales = app.jwt.sign({ sub: ID.sales });
});
after(async () => { if (!PG) return; await cleanup(); try { await app.close(); } catch (_) {} await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });

test('① 업로드 — 미리보기 · 디렉터 전용 · 저장 · 분해 · 버전 · 내려받기', { skip: SKIP }, async () => {
  const fake = Buffer.from('PK\u0003\u0004 fake-xlsx-' + RUN);
  const dry = await post('/api/xref-master/upload', { dry_run: true, filename: `${TAG}_cross.xlsx`, aoa: AOA });
  assert.equal(dry.statusCode, 200, dry.body);
  const d = dry.json();
  assert.equal(d.dry_run, true);
  assert.equal(d.rows, 5, '빈 행 제외 5행');
  assert.equal(d.empty_rows, 1);
  assert.equal(d.brand_counts.SYD, 5, "SYD: 1 + '2 // 3' 둘 + 4 + 5");
  assert.equal(d.brand_counts.KYB, 3, "KYB '/' 분해");
  assert.equal(d.brand_counts.GROB, 6);
  assert.equal(d.bridged_rows, 2, 'SYD 칸 기준: S1 행 · S2//S3 행 (S4 · S5 는 ERP 미등록, GROB 칸의 S1 은 세지 않음)');
  assert.equal(d.no_syd_rows, 1);
  assert.equal((await post('/api/xref-master/upload', { filename: 'x.xlsx', aoa: AOA }, 'sales')).statusCode, 403, '디렉터만');
  assert.equal((await post('/api/xref-master/upload', { aoa: [['A', 'B'], ['1', '2']] })).statusCode, 400, '헤더 없음');

  const up = await post('/api/xref-master/upload', { filename: `${TAG}_cross.xlsx`, aoa: AOA, file_b64: fake.toString('base64') });
  assert.equal(up.statusCode, 200, up.body);
  const u = up.json();
  assert.ok(u.version_id > 0);
  ID.ver = u.version_id;
  const codes = (await query(`SELECT brand, code FROM xref_master_codes WHERE version_id=$1 ORDER BY brand, code`, [u.version_id])).rows;
  assert.ok(codes.some((c) => c.brand === 'VAZLO' && /^64\d+1$/.test(c.code)), '숫자 칸 → 문자열 코드');
  assert.ok(codes.some((c) => c.code === `${TAG}G2X`), "'//' 분해");
  const act = (await query(`SELECT COUNT(*)::int n FROM xref_master_versions WHERE is_active`)).rows[0].n;
  assert.equal(act, 1, '활성 버전 1개');

  const vl = (await get('/api/xref-master/versions', 'sales')).json();
  assert.equal(vl.items[0].id, u.version_id);
  assert.equal(vl.items[0].is_active, true);
  assert.equal(vl.items[0].has_file, true);
  const dl = await get('/api/xref-master/latest/file', 'sales');
  assert.equal(dl.statusCode, 200);
  assert.match(dl.headers['content-type'], /spreadsheetml/);
  assert.equal(Buffer.compare(dl.rawPayload, fake), 0, '올린 원본 그대로');
  assert.match(decodeURIComponent(dl.headers['x-filename']), new RegExp(`${TAG}_cross\\.xlsx`));
  assert.equal((await get(`/api/xref-master/versions/${u.version_id}/file`)).statusCode, 200);
});

test('② 견적 — 경쟁사 → SYD → CTR · 브랜드 칸 · 후보 · 미등록 기록', { skip: SKIP }, async () => {
  const rc = async (code, brand) => (await get(`/api/quotes/resolve-code?code=${encodeURIComponent(code)}${brand ? '&brand=' + brand : ''}`)).json();
  let r = await rc(`${TAG}-B1`);
  assert.equal(r.matches.length, 1); assert.equal(r.matches[0].ctr_code, `${TAG}-A`);
  assert.equal(r.matches[0].matched_by, 'xref'); assert.equal(r.matches[0].xref.brand, 'BAW'); assert.equal(r.matches[0].xref.syd, S(1));
  r = await rc(`33${RUN}1`, 'KYB');
  assert.equal(r.matches[0].ctr_code, `${TAG}-A`, 'KYB 숫자 코드');
  r = await rc(`${TAG}G2X`, 'GROB');
  assert.equal(r.matches.length, 2, 'SYD 둘(2 // 3) → 후보 2');
  // GROB 칸의 S(1) — 자동이면 SYD S1 → A, GROB 를 고르면 그 행의 SYD S4(미등록) → 못 찾음
  r = await rc(S(1));
  assert.equal(r.matches[0].ctr_code, `${TAG}-A`); assert.equal(r.matches[0].matched_by, 'syd');
  r = await rc(S(1), 'GROB');
  assert.equal(r.matches.length, 0, 'GROB 를 고르면 SYD 칸을 보지 않는다');
  r = await rc(`${TAG}-B1`, 'KYB');
  assert.equal(r.matches.length, 0, '다른 브랜드 칸은 안 본다');
  r = await rc(`${TAG}-A`, 'BAW');
  assert.equal(r.matches[0].ctr_code, `${TAG}-A`, 'CTR 코드를 그대로 붙여넣은 경우는 받는다');

  const pv = (await post('/api/quotes/preview', { customer_id: ID.cust, lines: [
    { code: `${TAG}-B1`, qty: 2, brand: 'BAW' }, { code: `${TAG}G2`, qty: 1, brand: 'GROB' }, { code: `${TAG}-B5`, qty: 3, brand: 'BAW' }] })).json();
  assert.equal(pv.lines[0].matched, true); assert.equal(pv.lines[0].xref.code, `${TAG}-B1`); assert.equal(pv.lines[0].input_brand, 'BAW');
  assert.equal(pv.lines[1].ambiguous, true); assert.equal(pv.lines[1].candidates.length, 2);
  assert.equal(pv.lines[2].matched, false); assert.equal(pv.lines[2].input_brand, 'BAW');

  const sv = await post('/api/quotes', { customer_id: ID.cust, lines: [
    { code: `${TAG}-B1`, qty: 2, brand: 'BAW' }, { code: `${TAG}-B5`, qty: 3, brand: 'BAW' }, { code: `${TAG}-B3`, qty: 1, brand: 'BAW' },
    { code: `${TAG}G2`, qty: 1, brand: 'GROB', product_id: ID.C }] });
  assert.equal(sv.statusCode, 200, sv.body);
  ID.q = Number(sv.json().id);
  const ql = (await query(`SELECT input_code, input_brand, ctr_code, match_source FROM quote_lines WHERE quote_id=$1 ORDER BY line_no`, [ID.q])).rows;
  assert.deepEqual(ql.map((l) => [l.input_code, l.input_brand, l.ctr_code]), [
    [`${TAG}-B1`, 'BAW', `${TAG}-A`], [`${TAG}-B5`, 'BAW', null], [`${TAG}-B3`, 'BAW', null], [`${TAG}G2`, 'GROB', `${TAG}-C`]]);
  assert.equal(ql[0].match_source, 'xref');
  const dev = sv.json().dev_lines;
  assert.deepEqual(dev.map((x) => [x.code, x.brand]).sort(), [[`${TAG}-B3`, 'BAW'], [`${TAG}-B5`, 'BAW']]);
  const dr = (await query(`SELECT input_code, input_brand, status FROM product_dev_requests WHERE source_quote_id=$1 ORDER BY input_code`, [ID.q])).rows;
  assert.deepEqual(dr.map((x) => [x.input_code, x.input_brand, x.status]), [[`${TAG}-B3`, 'BAW', 'received'], [`${TAG}-B5`, 'BAW', 'received']]);
});

test('③ 개발요청 자동 검수 — 제품 추가 → 개발완료(master) → 팝업 · 후보 여럿', { skip: SKIP }, async () => {
  // 팝업 기준: 처음 보는 사용자 → 최근 14일. 시작 전에 「확인」해 둔다.
  assert.equal((await post('/api/dev-requests/auto-matches/seen', {})).statusCode, 200);
  // 후보 여럿: GROB G2 를 브랜드와 함께 수동 접수
  const cr = await post('/api/dev-requests', { input_code: `${TAG}G2`, input_brand: 'GROB', customer_id: ID.cust, requested_qty: 4 });
  assert.equal(cr.statusCode, 200, cr.body);
  ID.ambReq = Number(cr.json().id);
  // S(5) 를 SYD 로 가진 제품 추가 → 즉시 스위퍼
  const np = await post('/api/products', { code: `${TAG}-D`, name: 'BUJE TEST', scode: S(5), list_price: 120 });
  assert.equal(np.statusCode, 200, np.body);
  assert.ok(np.json().dev_match.matched >= 1, np.body);
  const b5 = (await query(`SELECT status, result_ctr_code, result_match_via, auto_matched_at FROM product_dev_requests WHERE source_quote_id=$1 AND input_code=$2`, [ID.q, `${TAG}-B5`])).rows[0];
  assert.equal(b5.status, 'developed'); assert.equal(b5.result_ctr_code, `${TAG}-D`); assert.equal(b5.result_match_via, 'master'); assert.ok(b5.auto_matched_at);
  const amb = (await query(`SELECT status, match_candidates FROM product_dev_requests WHERE id=$1`, [ID.ambReq])).rows[0];
  assert.equal(amb.status, 'received', '후보 여럿 → 자동 완료 안 함');
  assert.equal(amb.match_candidates, `${TAG}-B / ${TAG}-C`);
  const b3 = (await query(`SELECT status FROM product_dev_requests WHERE source_quote_id=$1 AND input_code=$2`, [ID.q, `${TAG}-B3`])).rows[0];
  assert.equal(b3.status, 'received', 'SYD 없는 행은 그대로');

  const am = (await get('/api/dev-requests/auto-matches')).json();
  assert.equal(am.ready, true);
  const hit = am.items.find((x) => x.input_code === `${TAG}-B5`);
  assert.ok(hit, JSON.stringify(am));
  assert.deepEqual([hit.ctr_code, hit.via, hit.input_brand], [`${TAG}-D`, 'master', 'BAW']);
  assert.ok(am.ambiguous.some((x) => x.id === ID.ambReq && x.candidates.length === 2));
  await post('/api/dev-requests/auto-matches/seen', {});
  const am2 = (await get('/api/dev-requests/auto-matches')).json();
  assert.equal(am2.items.filter((x) => x.input_code.startsWith(TAG)).length, 0, '확인 후 비움');

  // 개발필요내용 — 브랜드 · 매칭결과 · 후보
  const dm = (await get('/api/dev-requests/demand?scope=all')).json();
  const g5 = dm.items.find((g) => g.code === `${TAG}-B5`);
  assert.deepEqual(g5.brands, ['BAW']);
  assert.deepEqual(g5.results.map((x) => [x.ctr, x.via, x.auto]), [[`${TAG}-D`, 'master', true]]);
  const g2 = dm.items.find((g) => g.code === `${TAG}G2`);
  assert.deepEqual(g2.brands, ['GROB']);
  assert.deepEqual(g2.candidates, [`${TAG}-B`, `${TAG}-C`]);
  assert.equal(g2.events[0].brand, 'GROB');

  // 수동 개발완료 — 경쟁사 브랜드 코드는 SYD 표가 아니라 교차참조로 붙는다
  const dv = await app.inject({ method: 'PUT', url: `/api/dev-requests/${ID.ambReq}/develop`, payload: { result_ctr_code: `${TAG}-B` }, headers: H() });
  assert.equal(dv.statusCode, 200, dv.body);
  const after1 = (await query(`SELECT result_match_via, match_candidates FROM product_dev_requests WHERE id=$1`, [ID.ambReq])).rows[0];
  assert.deepEqual([after1.result_match_via, after1.match_candidates], ['manual', null]);
  assert.equal((await query(`SELECT COUNT(*)::int n FROM product_syd_codes WHERE syd_code=$1`, [`${TAG}G2`])).rows[0].n, 0, 'GROB 코드가 SYD 로 둔갑하지 않음');
  assert.equal((await query(`SELECT brand FROM product_xref_codes WHERE product_id=$1 AND xref_code=$2`, [ID.B, `${TAG}G2`])).rows[0].brand, 'GROB');
});

test('④ 제품찾기 — 경쟁사 코드 · 미등록 행 안내', { skip: SKIP }, async () => {
  let d = (await get(`/api/products?q=${encodeURIComponent(`${TAG}G1`)}`, 'sales')).json();
  const a = d.items.find((p) => p.code === `${TAG}-A`);
  assert.ok(a, JSON.stringify(d).slice(0, 400));
  assert.deepEqual([a.xref_hit.brand, a.xref_hit.code, a.xref_hit.syd], ['GROB', `${TAG}G1`, S(1)]);
  d = (await get(`/api/products?q=${encodeURIComponent(`${TAG}M5`)}`, 'sales')).json();
  assert.ok(d.items.some((p) => p.code === `${TAG}-D` && p.xref_hit.brand === 'MOOG'), 'MOOG 코드 → 새로 등록된 D');
  d = (await get(`/api/products?q=${encodeURIComponent(`${TAG}-B3`)}`, 'sales')).json();
  assert.equal(d.items.length, 0);
  assert.equal(d.xref_unbridged[0].brand, 'BAW'); assert.equal(d.xref_unbridged[0].descripcion, 'ROTULA');
  d = (await get(`/api/products?q=${encodeURIComponent(`${TAG}G2`)}`, 'sales')).json();
  assert.ok(d.items.some((p) => p.code === `${TAG}-B`) && d.items.some((p) => p.code === `${TAG}-C`), '앞부분 일치(G2 · G2X) → B · C');
  // 3자 이하는 마스터를 보지 않는다
  d = (await get(`/api/products?q=G1`, 'sales')).json();
  assert.ok(!d.items.some((p) => p.xref_hit));
});

test('④-b 견적 엑셀 경쟁사 코드 열 — /api/xref-master/codes-for', { skip: SKIP }, async () => {
  // A(SYD S1) → 마스터 행: BAW B1 · GROB G1 · VAZLO · KYB / B(S2) · C(S3) → 같은 행 · GROB 둘
  const r = await post('/api/xref-master/codes-for', { codes: [`${TAG}-A`, `${TAG}-B`, `${TAG}-C`, `${TAG}-NOPE`], brands: ['BAW', 'GROB', 'kyb', 'SYD', 'XXX'] }, 'sales');
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.deepEqual(d.brands, ['BAW', 'GROB', 'KYB'], '경쟁사 브랜드만 · 대소문자 정리');
  assert.deepEqual(d.items[`${TAG}-A`].BAW, [`${TAG}-B1`]);
  assert.deepEqual(d.items[`${TAG}-A`].KYB, [`33${RUN}1`]);
  assert.deepEqual(d.items[`${TAG}-B`].GROB, [`${TAG}G2`, `${TAG}G2X`, `${TAG}G2`].filter((v, i, a) => a.indexOf(v) === i), '한 칸 여러 코드 · 교차참조(수동 개발완료 G2)와 중복 제거');
  assert.deepEqual(d.items[`${TAG}-B`].KYB, [`33${RUN}2`, `33${RUN}3`]);
  assert.ok(!d.items[`${TAG}-NOPE`]);
  assert.ok(!d.items[`${TAG}-A`].VAZLO, '고르지 않은 브랜드는 없음');
  const e = (await post('/api/xref-master/codes-for', { codes: [`${TAG}-A`], brands: [] }, 'sales')).json();
  assert.deepEqual(e.items, {});
});

test('⑤ 재업로드 — 새 버전만 검색 · 이전 원본은 목록에 남음', { skip: SKIP }, async () => {
  const aoa2 = AOA.slice(0, 2);
  const up = await post('/api/xref-master/upload', { filename: `${TAG}_v2.xlsx`, aoa: aoa2, file_b64: Buffer.from('v2').toString('base64') });
  assert.equal(up.statusCode, 200, up.body);
  const v = (await get('/api/xref-master/versions')).json().items;
  assert.equal(v[0].is_active, true); assert.equal(v[1].is_active, false); assert.equal(v[1].has_file, true);
  assert.equal((await query(`SELECT COUNT(*)::int n FROM xref_master_codes WHERE version_id=$1`, [ID.ver])).rows[0].n, 0, '이전 버전 검색 코드 정리');
  const { invalidateXrefMaster } = await import('../src/xrefMaster.js'); invalidateXrefMaster();
  const r = (await get(`/api/quotes/resolve-code?code=${TAG}-B4&brand=BAW`)).json();
  assert.equal(r.matches.length, 0, '새 버전에 없는 행');
  const prev = await get(`/api/xref-master/versions/${ID.ver}/file`);
  assert.equal(prev.statusCode, 200, '이전 원본도 내려받기');
});

test('⑥ 실제 파일(9,490행) 업로드 시간', { skip: SKIP || (!process.env.XREF_AOA && 'XREF_AOA 없음') }, async () => {
  const aoa = JSON.parse(readFileSync(process.env.XREF_AOA, 'utf8'));
  const file = process.env.XREF_FILE && existsSync(process.env.XREF_FILE) ? readFileSync(process.env.XREF_FILE) : Buffer.from('x');
  const t0 = Date.now();
  const dry = (await post('/api/xref-master/upload', { dry_run: true, filename: `${TAG}_real.xlsx`, aoa })).json();
  const t1 = Date.now();
  const up = await post('/api/xref-master/upload', { filename: `${TAG}_real.xlsx`, aoa, file_b64: file.toString('base64') });
  const t2 = Date.now();
  assert.equal(up.statusCode, 200, up.body.slice(0, 300));
  const u = up.json();
  console.log(`# 실제 파일: 행 ${u.rows} · 코드 ${u.codes} · 브랜드 ${JSON.stringify(u.brand_counts)} · 미리보기 ${t1 - t0}ms · 저장 ${t2 - t1}ms`);
  assert.equal(u.rows, dry.rows);
  assert.ok(u.rows >= 9400);
  const { invalidateXrefMaster } = await import('../src/xrefMaster.js'); invalidateXrefMaster();
  // 실제 행: BAW SU042 → SYD 7000199 (ERP 에 없으니 견적은 못 찾음 · 제품찾기는 안내)
  const d = (await get(`/api/products?q=SU042`, 'sales')).json();
  assert.ok((d.xref_unbridged || []).some((x) => x.code === 'SU042' && x.syd.includes('7000199')), JSON.stringify(d).slice(0, 300));
  const t3 = Date.now();
  await get(`/api/quotes/resolve-code?code=G4368&brand=GROB`);
  console.log(`# resolve-code 1건 ${Date.now() - t3}ms`);
});
