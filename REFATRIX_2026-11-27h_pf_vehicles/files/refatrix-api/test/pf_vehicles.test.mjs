// =====================================================================
// pf_vehicles.test.mjs — 2026-11-27 · 플랫폼 신규 차종 수신 API + 제품찾기 반영 (0346)
//   A. 순수 — 본문 검사(brand/model 필수 · 연식) · 이름 키 · 적용차종 메이커(대문자 아님) 읽기 · 알림
//   B. 실제 서버 + PostgreSQL(TEST_PG_URL):
//      인증(토큰 없음 · ERP 토큰 401) · 0346 전 501 · 422 · 201 · 200 existed(이름 키 · ref) · 동시 2건 1건만 ·
//      OE 매칭 후보 · 만든 사람/출처 · 제품찾기 메이커 · 연식 · 모델 목록(연결 제품 없어도 🆕) · 차량 도면 pf_vehicle ·
//      ERP 제품 수정(대문자 아닌 'Geely Emgrand') → product_applications maker=GEELY → 도면에 그 제품 · GET 목록 products 1 ·
//      pf-catalog 확인완료 적용차종 → 바로 반영 · 경고(메이커 · 연식 못 읽음)
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/pf_vehicles.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pf-veh';
process.env.PRODUCT_PUSH_DEBOUNCE_MS = '20';
const V = await import('../src/pfVehicles.js');
const PI = await import('../src/productImport.js');

test('A. 본문 검사 · 이름 키 · 적용차종 읽기', () => {
  const ok = V.normVehicleInput({ brand: ' Geely ', model: 'Emgrand', year_from: 2025, year_to: null, segment: 'A SEDAN', origin: 'China',
    kind: 'passenger', source: 'refatrix-market', ref: 'NEW|GEELY|Emgrand', sales_ytd: 16406,
    oe: [{ cat: 'BALL JOINT', pos: 'Front Lower', oe: '4017020200', price: 1816.76, src: '견적서' }, { foo: 1 }] });
  assert.equal(ok.error, undefined);
  assert.equal(ok.brand, 'Geely'); assert.equal(ok.norm_key, 'GEELY|EMGRAND');
  assert.equal(ok.year_from, 2025); assert.equal(ok.year_to, null); assert.equal(ok.sales_ytd, 16406);
  assert.equal(ok.oe.length, 1, '빈 OE 줄은 버린다');
  assert.equal(V.normVehicleInput({ brand: 'GEELY', model: 'EX5 EM-i' }).norm_key, V.normVehicleInput({ brand: 'geely', model: 'ex5-em.i' }).norm_key, '대소문자 · 공백 · 하이픈 · 점 무시');
  assert.equal(V.normVehicleInput({ brand: 'Geely' }).error, 'brand/model 필수');
  assert.equal(V.normVehicleInput({ model: 'X' }).error, 'brand/model 필수');
  assert.equal(V.normVehicleInput({ brand: '--', model: 'X' }).error, 'brand/model 필수', '기호만이면 없음');
  assert.equal(V.normVehicleInput(null).error, 'brand/model 필수');
  assert.ok(V.normVehicleInput({ brand: 'A', model: 'B', year_from: 'x' }).error, '연식 형식');
  assert.ok(V.normVehicleInput({ brand: 'A', model: 'B', year_from: 2025, year_to: 2020 }).error, '연식 거꾸로');

  // 적용차종 — 대문자 아닌 메이커도 알려진 이름이면 메이커로
  const p = (t) => PI.parseApplications(t)[0];
  assert.deepEqual([p('Geely Emgrand 2025-2026').maker, p('Geely Emgrand 2025-2026').model], ['GEELY', 'Emgrand']);
  assert.equal(p('NISSAN Versa 2012-2019').maker, 'NISSAN', '기존 대문자 규칙 그대로');
  assert.equal(p('DODGE, CHRYSLER Neon 2000').maker, 'DODGE, CHRYSLER', '쉼표 메이커 그대로');
  assert.equal(p('Mercedes-Benz Clase C 2015').maker, 'MERCEDES-BENZ');
  assert.equal(p('great wall Poer 2022').maker, 'GREAT WALL');
  assert.equal(p('Versa 2012-2019').maker, null, '모르는 낱말은 메이커로 추측하지 않는다');
  assert.equal(p('Geely 2025').maker, null, '모델 낱말이 남아야 한다');
  const w = PI.appWarnings(PI.parseApplications('Versa 2012-2019 // GEELY Emgrand // KIA K4 2025'));
  assert.deepEqual(w.map((x) => x.issue), ['no_maker', 'no_year']);
});

// ── C. 화면(공용 모듈 refatrix-vehiclemap.js · jsdom) — 🆕 표시 · 연결된 제품 없음 안내 · 메이커 다시 불러도 선택 유지 ──
test('C. 차종 찾기 화면 — 🆕 · 연결된 제품 없음', async (t) => {
  let JSDOM = null;
  try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
  if (!JSDOM) return t.skip('jsdom 미설치');
  const fs = await import('node:fs'); const path = await import('node:path'); const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = fs.readFileSync(path.join(here, '..', '..', 'refatrix-vehiclemap.js'), 'utf8');
  for (const f of ['refatrix-products.html', 'refatrix-quote.html']) {
    assert.match(fs.readFileSync(path.join(here, '..', '..', f), 'utf8'), /refatrix-vehiclemap\.js\?v=20261127h/, f + ' 캐시 토큰');
  }
  const dom = new JSDOM('<select id="mk"></select><select id="yr"></select><select id="md"></select><button id="go"></button><div id="res"></div>', { runScripts: 'outside-only', url: 'https://x.test/' });
  const w = dom.window;
  let makers = { items: ['GEELY', 'NISSAN'], groups: [{ key: 'GEELY', label: 'GEELY', variants: ['GEELY', 'Geely'], n: 0, pf_only: true }, { key: 'NISSAN', label: 'NISSAN', variants: ['NISSAN'], n: 9 }] };
  const VM = { vehicle: { maker: 'GEELY', model: 'Emgrand', year: null }, items: [], competitors: [], counts: { ctr: 0 },
    pf_vehicle: { id: 1, brand: 'Geely', model: 'Emgrand', year_from: 2025, year_to: null, source: 'refatrix-market', oe_ref: [{ cat: 'BALL JOINT', pos: 'Front Lower', oe: '4017020200' }] } };
  w.fetch = async (u) => {
    u = String(u);
    const j = (d) => ({ ok: true, status: 200, json: async () => d });
    if (u.includes('app-makers')) return j(makers);
    if (u.includes('app-years')) return j({ items: [2026, 2025] });
    if (u.includes('app-models')) return j({ items: ['Emgrand'], groups: [{ key: 'EMGRAND', label: 'Emgrand', variants: ['Emgrand'], n: 0, pf_only: true }] });
    if (u.includes('vehicle-map')) return j(VM);
    return j({});
  };
  w.eval(js);
  const $ = (id) => w.document.getElementById(id);
  const inst = w.RefatrixVehicleMap.create({ els: { maker: $('mk'), model: $('md'), year: $('yr'), btn: $('go'), result: $('res') },
    api: () => 'https://api.test', headers: () => ({}), mode: 'browse' });
  await inst.loadMakers();
  const opt = [...$('mk').options].find((o) => o.value === 'GEELY');
  assert.ok(opt && opt.textContent.includes('🆕'), '신규 차종 메이커 🆕');
  assert.ok(![...$('mk').options].find((o) => o.value === 'NISSAN').textContent.includes('🆕'));
  $('mk').value = 'GEELY';
  makers = { items: ['GEELY', 'NISSAN'], groups: [] };
  await inst.loadMakers();
  assert.equal($('mk').value, 'GEELY', '다시 불러도 고른 메이커 그대로');
  $('md').innerHTML = '<option value="Emgrand">Emgrand</option>'; $('md').value = 'Emgrand';
  await inst.search();
  await new Promise((r) => setTimeout(r, 30));
  const txt = $('res').textContent;
  assert.match(txt, /연결된 제품 없음/); assert.match(txt, /Geely Emgrand · 2025~/); assert.match(txt, /refatrix-market/);
  assert.match(txt, new RegExp("GEELY Emgrand 2025-" + Math.max(2025, new Date().getFullYear())), "예시 적용차종 문구"); assert.match(txt, /4017020200/);
  VM.pf_vehicle = null;
  await inst.search(); await new Promise((r) => setTimeout(r, 30));
  assert.match($('res').textContent, /이 차종에 맞는 부품이 없습니다/, '신규 차종이 아니면 예전 문구');
});

test('B. 실제 서버 + PostgreSQL — 신규 차종 · 제품찾기', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  const { hashPin } = await import('../src/auth.js');
  const TAG = 'PFV' + String(Date.now() % 9000 + 1000).replace(/\d/g, (d) => 'ABCDEFGHIJ'[d]);   // 숫자 없이(연식으로 읽히지 않게)
  const BR = TAG + 'Geely';            // 시험용 메이커(실데이터와 안 겹치게) — 대문자 규칙에 안 맞는 표기
  const MINE = `SELECT id FROM products WHERE code LIKE '${TAG}%'`;
  async function cleanup() {
    for (const tb of ['pf_catalog_confirms', 'pf_catalog_review', 'product_change_log', 'product_syd_codes', 'product_applications', 'product_oe_codes'])
      await query(`DELETE FROM ${tb} WHERE product_id IN (${MINE})`).catch(() => {});
    await query(`DELETE FROM crm_customer_outbox WHERE entity='product'`).catch(() => {});
    await query(`DELETE FROM products WHERE id IN (${MINE})`).catch(() => {});
    await query(`DELETE FROM pf_vehicles WHERE brand ILIKE '${TAG}%' OR ref LIKE '${TAG}%'`).catch(() => {});
    const uids = (await query(`SELECT id FROM users WHERE name LIKE '${TAG}%'`)).rows.map((r) => Number(r.id));
    await query(`DELETE FROM user_page_access WHERE user_id = ANY($1::bigint[])`, [uids]).catch(() => {});
    await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [uids]).catch(() => {});
    await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [uids]).catch(() => {});
  }
  after(async () => { await cleanup().catch((e) => console.error('cleanup', e.message)); await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });

  const SV = await import('../src/surveyViewer.js');
  const keepLog = SV.platformApi.log;
  const plog = [];
  SV.platformApi.log = async (tok, txt) => { plog.push(txt); return tok.startsWith('aaaaaaaa') ? { ok: true } : { ok: false, invalid: true }; };
  t.after(() => { SV.platformApi.log = keepLog; });
  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  t.after(() => app.close());
  const call = (h, method, url, payload) => app.inject({ method, url, payload, headers: h });
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  await cleanup();

  // 알려진 메이커 목록에 시험 메이커를 잠시 넣는다(실데이터 GEELY 와 안 겹치게) — 대문자 아닌 표기 읽기 시험
  PI.KNOWN_MAKERS.push(BR);
  const dir = Number((await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director',$2,$3) RETURNING id`, [TAG + 'dir', hashPin('4321'), (TAG + 'dir').toLowerCase()])).id);
  const D = { authorization: 'Bearer ' + app.jwt.sign({ sub: dir }) };

  const url = '/api/pf-catalog/vehicles';
  const body = { brand: BR, model: 'Emgrand', year_from: 2025, year_to: null, segment: 'A SEDAN', origin: 'China', kind: 'passenger',
    source: 'refatrix-market', ref: `${TAG}|NEW|GEELY|Emgrand`, sales_ytd: 16406,
    oe: [{ cat: 'BALL JOINT', pos: 'Front Lower', oe: TAG + '4017020200', price: 1816.76, src: '견적서 · Geely · EMGRAND · 24/11/2026' }] };

  // ── 인증 ──
  assert.equal((await call({}, 'POST', url, body)).statusCode, 401, '토큰 없음');
  assert.equal((await call(D, 'POST', url, body)).statusCode, 401, 'ERP 토큰은 pf-catalog 아님');
  const lg = await call({}, 'POST', '/api/pf-catalog/login', { token: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Park CTR', user_key: '12' });
  assert.equal(lg.statusCode, 200, lg.body);
  const H = { authorization: 'Bearer ' + lg.json().token };

  // ── 0346 전 501 ──
  V.setPfVehReady(false);
  assert.equal((await call(H, 'POST', url, body)).statusCode, 501);
  assert.equal((await call(H, 'GET', url)).statusCode, 501);
  V.setPfVehReady(true);

  // ── 422 ──
  let r = await call(H, 'POST', url, { model: 'Emgrand' });
  assert.equal(r.statusCode, 422); assert.deepEqual(r.json(), { error: 'brand/model 필수' });

  // OE 매칭 후보용 ERP 제품(같은 OE)
  const pOe = await one(`INSERT INTO products (code, name, list_price, stock_qty) VALUES ($1,'ROTULA INFERIOR',100,3) RETURNING id`, [TAG + 'CB1']);
  await query(`INSERT INTO product_oe_codes (product_id, oe_code, oe_norm, rel, source) VALUES ($1,$2,$3,'oe','master')`, [pOe.id, TAG + '40170-20200', (TAG + '4017020200').toUpperCase()]);

  // ── 201 ──
  r = await call(H, 'POST', url, body);
  assert.equal(r.statusCode, 201, r.body);
  const v1 = r.json().vehicle;
  assert.ok(v1.id > 0); assert.equal(v1.brand, BR); assert.equal(v1.model, 'Emgrand');
  assert.equal(v1.year_from, 2025); assert.equal(v1.year_to, null); assert.equal(v1.source, 'refatrix-market'); assert.equal(v1.ref, body.ref);
  assert.equal(v1.created_by, 'Park CTR', '만든 사람 = pf-catalog 로그인 이름');
  assert.deepEqual(r.json().matches, [{ code: TAG + 'CB1', oe: TAG + '40170-20200' }], 'OE 같은 제품 후보');
  const db = await one(`SELECT oe_ref, source, created_by FROM pf_vehicles WHERE id=$1`, [v1.id]);
  assert.equal(db.oe_ref[0].oe, TAG + '4017020200'); assert.equal(db.oe_ref[0].price, 1816.76);
  assert.ok(plog.some((x) => x.includes('신규 차종 → ERP 등록')), '플랫폼 활동 로그');

  // ── 200 existed — 이름 키(대소문자 · 하이픈) · 같은 ref ──
  r = await call(H, 'POST', url, { ...body, brand: BR.toUpperCase(), model: 'EM-GRAND', ref: null });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().existed, true); assert.equal(r.json().vehicle.id, v1.id);
  r = await call(H, 'POST', url, { ...body, brand: TAG + 'Otro', model: 'Otro' });
  assert.equal(r.statusCode, 200, '같은 ref'); assert.equal(r.json().vehicle.id, v1.id);
  assert.equal((await one(`SELECT count(*)::int AS n FROM pf_vehicles WHERE brand ILIKE $1`, [TAG + '%'])).n, 1, '새로 안 만든다');
  // 동시 2건 → 1건
  const two = await Promise.all([1, 2].map(() => call(H, 'POST', url, { brand: BR, model: 'EX5 EM-i', year_from: 2025 })));
  assert.deepEqual(two.map((x) => x.statusCode).sort(), [200, 201]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM pf_vehicles WHERE brand_key=$1 AND model_key='EX5EMI'`, [BR.toUpperCase()])).n, 1);

  // ── 제품찾기 목록 — 연결된 제품 없어도 보인다(🆕 pf_only) ──
  let m = (await call(D, 'GET', '/api/products/app-makers')).json();
  const g = m.groups.find((x) => x.key === BR.toUpperCase());
  assert.ok(g, '메이커 목록에 신규 차종 메이커'); assert.equal(g.pf_only, true); assert.equal(g.n, 0);
  let y = (await call(D, 'GET', `/api/products/app-years?maker=${encodeURIComponent(BR)}`)).json().items;
  assert.ok(y.includes(2025) && y.includes(new Date().getFullYear() + 1) && !y.includes(2024), '연식 2025~올해+1: ' + y.join(','));
  let md = (await call(D, 'GET', `/api/products/app-models?maker=${encodeURIComponent(BR)}&year=2025`)).json();
  assert.ok(md.items.includes('Emgrand') && md.items.includes('EX5 EM-i'), md.items.join(','));
  md = (await call(D, 'GET', `/api/products/app-models?maker=${encodeURIComponent(BR)}&year=2024`)).json();
  assert.equal(md.items.includes('Emgrand'), false, '2024 는 범위 밖');
  let vm = (await call(D, 'GET', `/api/products/vehicle-map?maker=${encodeURIComponent(BR)}&model=Emgrand&year=2025`)).json();
  assert.equal(vm.items.length, 0, '연결된 제품 없음'); assert.equal(vm.pf_vehicle.id, v1.id); assert.equal(vm.pf_vehicle.source, 'refatrix-market');
  assert.equal(vm.pf_vehicle.oe_ref.length, 1);
  let ls = (await call(H, 'GET', url + '?q=' + encodeURIComponent(BR + ' emgrand'))).json().items;
  assert.equal(ls.length, 1); assert.equal(ls[0].products, 0); assert.equal(ls[0].app_year_from, null);

  // ── ERP 제품 수정 — 대문자 아닌 'Geely Emgrand 2025-2026' 도 메이커로 읽어 바로 제품찾기에 ──
  const p = await one(`INSERT INTO products (code, name, list_price, stock_qty) VALUES ($1,'ROTULA INFERIOR',100,7) RETURNING id`, [TAG + 'CB2']);
  r = await call(D, 'PATCH', `/api/products/${p.id}`, { app: `${BR} Emgrand 2025-2026 // Versa 2012-2019` });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().app_warnings.map((x) => x.issue), ['no_maker'], 'Versa(메이커 없음) 만 알림');
  const pa = await one(`SELECT maker, model, year_from, year_to FROM product_applications WHERE product_id=$1 ORDER BY id LIMIT 1`, [p.id]);
  assert.deepEqual(pa, { maker: BR.toUpperCase(), model: 'Emgrand', year_from: 2025, year_to: 2026 });
  vm = (await call(D, 'GET', `/api/products/vehicle-map?maker=${encodeURIComponent(BR)}&model=Emgrand&year=2025`)).json();
  assert.deepEqual(vm.items.map((x) => x.code), [TAG + 'CB2'], '저장 즉시 도면에');
  m = (await call(D, 'GET', '/api/products/app-makers')).json();
  const g2 = m.groups.find((x) => x.key === BR.toUpperCase());
  assert.equal(g2.n, 1); assert.equal(g2.pf_only, undefined, '제품이 생기면 🆕 아님'); assert.equal(m.items.filter((x) => x.toUpperCase() === BR.toUpperCase()).length, 1, '한 줄로 묶임');
  ls = (await call(H, 'GET', url + '?q=' + encodeURIComponent(BR))).json().items;
  const le = ls.find((x) => x.model === 'Emgrand');
  assert.equal(le.products, 1); assert.equal(le.app_year_from, 2025); assert.equal(le.app_year_to, 2026, 'ERP 에서 다듬은 연식');

  // ── pf-catalog 확인완료(제품검색 → 수정)로 적용차종 → 바로 반영 ──
  const p3 = await one(`INSERT INTO products (code, name, list_price, stock_qty, app) VALUES ($1,'TERMINAL',100,0,'') RETURNING id`, [TAG + 'CT3']);
  r = await call(H, 'POST', `/api/pf-catalog/items/${p3.id}/confirm`, { fields: { app: `${BR} EX5 EM-i 2025` }, loaded: { app: '' } });
  assert.equal(r.statusCode, 200, r.body); assert.deepEqual(r.json().app_warnings, []);
  vm = (await call(D, 'GET', `/api/products/vehicle-map?maker=${encodeURIComponent(BR)}&model=${encodeURIComponent('EX5 EM-i')}`)).json();
  assert.deepEqual(vm.items.map((x) => x.code), [TAG + 'CT3']);
  r = await call(H, 'POST', `/api/pf-catalog/items/${p3.id}/confirm`, { fields: { app: `${BR} EX5 EM-i` }, loaded: { app: `${BR} EX5 EM-i 2025` } });
  assert.equal(r.statusCode, 200, r.body); assert.deepEqual(r.json().app_warnings.map((x) => x.issue), ['no_year'], '연식 없음 알림');

  // 가격 · 재고는 그대로
  const px = await one(`SELECT list_price, stock_qty FROM products WHERE id=$1`, [p.id]);
  assert.equal(Number(px.list_price), 100); assert.equal(Number(px.stock_qty), 7);
  PI.KNOWN_MAKERS.pop();
});
