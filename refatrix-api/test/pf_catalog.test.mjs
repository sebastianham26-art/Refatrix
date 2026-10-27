// =====================================================================
// pf_catalog.test.mjs — REFATRIX Platform 「제품 카탈로그 점검」 (0302 · 2026-10-27)
//   A. 순수 규칙 — 정규화 · 수정안 병합(base 유지) · 칸 상태 · 확인 계획(겹친 칸)
//   B. 실제 서버 + PostgreSQL(TEST_PG_URL):
//      로그인(플랫폼 세션 확인) · 토큰 분리 · 목록에 가격·재고 없음 · 대상 제외(PRO·키트) ·
//      수정안 → ERP 그대로 · 확인완료 → ERP 즉시 반영(파생표·이력·확인자) · 그대로 맞음 확인 ·
//      ERP 현장 수정 → 재확인 · 수정안 중 현장 수정 → 409(아무것도 안 바뀜) → 내 것/ERP 것 고르기 ·
//      신규 품목 → 바로 미검토로 보임 · CRM 즉시 전송(확인완료 · ERP 수정 모두)
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/pf_catalog.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pf-catalog';
process.env.PRODUCT_PUSH_DEBOUNCE_MS = '20';
process.env.CRM_SYNC_GAP_MS = '0';
const C = await import('../src/pfCatalog.js');

test('A1. 정규화 · 같은 값', () => {
  assert.equal(C.normValue('name', '  RÓTULA  '), 'RÓTULA');
  assert.equal(C.normValue('scode', '   '), null);
  assert.equal(C.normValue('material', 'Aluminum'), 'aluminio');
  assert.equal(C.normValue('oe', ''), null);
  assert.ok(C.same(null, ''), 'null = 빈칸');
  assert.ok(C.same(' A ', 'A'));
  assert.ok(!C.same('A', 'B'));
});

test('A2. 수정안 병합 — base 는 처음 고칠 때의 ERP 값 · 같은 값이면 빠짐 · 제품명 비움 거절', () => {
  const cur = { name: 'ROTULA', scode: '111', app: 'NISSAN Versa 2012-2019', oe: null, material: null };
  let m = C.mergeDraft(cur, {}, { app: 'NISSAN Versa 2012-2020', scode: '111' });
  assert.deepEqual(Object.keys(m.draft), ['app'], 'SYD 는 같은 값 → 빠짐');
  assert.equal(m.draft.app.base, 'NISSAN Versa 2012-2019');
  // ERP 가 그사이 바뀌어도 다시 저장할 때 base 는 그대로(처음 값)
  const cur2 = { ...cur, app: 'NISSAN Versa 2012-2018' };
  m = C.mergeDraft(cur2, m.draft, { app: 'NISSAN Versa 2012-2021' });
  assert.equal(m.draft.app.base, 'NISSAN Versa 2012-2019');
  assert.equal(m.draft.app.value, 'NISSAN Versa 2012-2021');
  // 지금 ERP 값과 같게 되돌리면 칸이 빠진다
  m = C.mergeDraft(cur, m.draft, { app: 'NISSAN Versa 2012-2019' });
  assert.deepEqual(m.draft, {});
  assert.equal(C.mergeDraft(cur, {}, { name: '  ' }).errors[0].error, 'name_required');
  assert.deepEqual(C.mergeDraft(cur, {}, { list_price: 1, stock_qty: 9 }).draft, {}, '가격·재고 칸은 모른다');
});

test('A3. 칸 상태 · 확인 계획', () => {
  const cur = { name: 'A', scode: 'S2', app: 'X', oe: null, material: null };
  const draft = {
    name: { base: 'A', value: 'A2' },          // ok
    scode: { base: 'S1', value: 'S3' },        // conflict (ERP S1→S2)
    app: { base: 'W', value: 'X' },            // moot (ERP 가 이미 제안 값)
  };
  const st = C.draftState(cur, draft);
  assert.equal(st.name.state, 'ok'); assert.equal(st.scode.state, 'conflict'); assert.equal(st.app.state, 'moot');
  let p = C.planConfirm(cur, draft, {});
  assert.deepEqual(p.apply, { name: { from: 'A', to: 'A2' } });
  assert.deepEqual(p.unresolved.map((x) => x.field), ['scode']);
  p = C.planConfirm(cur, draft, { scode: 'mine' });
  assert.equal(p.apply.scode.to, 'S3'); assert.equal(p.chosen.scode.chose, 'mine'); assert.equal(p.unresolved.length, 0);
  p = C.planConfirm(cur, draft, { scode: 'erp' });
  assert.equal(p.apply.scode, undefined); assert.equal(p.chosen.scode.chose, 'erp');
});

test('A5. 구분자 모양 · 열 때 본 값(loaded) · 오래된 화면', () => {
  assert.equal(C.normValue('scode', 'A//B'), 'A // B');
  assert.ok(C.eqF('app', 'X 2001//Y 2002', ' X 2001 // Y 2002 '));
  const cur = { name: 'ERP-NEW', scode: 'A//B', app: 'X', oe: null, material: null };
  // 구분자만 다른 값은 수정이 아니다
  assert.deepEqual(C.mergeDraft(cur, {}, { scode: 'A // B' }).draft, {});
  // 화면이 OLD 를 보고 손대지 않은 칸 → 수정안 아님 · stale 로 잡힌다
  const loaded = { name: 'OLD-SEEN', scode: 'A // B', app: 'X', oe: null, material: null };
  const m = C.mergeDraft(cur, {}, { ...loaded }, loaded);
  assert.deepEqual(m.draft, {}, '오래된 화면 값이 수정안이 되지 않는다');
  assert.deepEqual(C.staleFields(cur, m.draft, loaded), ['name']);
  // 오래된 화면에서 손댄 칸 → base = 열 때 값 → 겹침
  const m2 = C.mergeDraft(cur, {}, { ...loaded, name: 'MINE' }, loaded);
  assert.equal(m2.draft.name.base, 'OLD-SEEN');
  assert.deepEqual(C.planConfirm(cur, m2.draft).unresolved.map((x) => x.field), ['name']);
});

test('A4. 미리보기 — 적용차종 · SYD · OE 나누기', () => {
  const v = C.previewDerived({ scode: '1115007 // 1115008', app: 'MITSUBISHI Asx 2013-2015 // NISSAN Versa 2012-2019', oe: null });
  assert.deepEqual(v.syd, ['1115007', '1115008']);
  assert.equal(v.apps.length, 2); assert.equal(v.apps[0].marca, 'MITSUBISHI'); assert.equal(v.apps[0].desde, 2013);
  assert.deepEqual(v.oe, []);
});

test('B. 실제 서버 + PostgreSQL', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  const { invalidateEndpointCache } = await import('../src/integrations.js');
  // 다른 제품 스위트가 같은 창구를 쓴다 — 끝나면 원래대로(풀을 닫기 **전에** 돌도록 먼저 등록)
  let epKeep = null;
  const MINE = `SELECT id FROM products WHERE code LIKE 'PFC%' OR code LIKE 'PROPF%' OR code = 'K0991'`;
  async function cleanup() {   // 다른 스위트는 「제품 표에 자기 것만 있다」고 센다 — 남기지 않는다
    await query(`DELETE FROM pf_catalog_confirms; DELETE FROM pf_catalog_review; DELETE FROM pf_catalog_exports; DELETE FROM pf_catalog_bulk_batches;`);
    await query(`DELETE FROM crm_customer_outbox WHERE entity='product'`);
    await query(`DELETE FROM product_sync_state; DELETE FROM product_sync_runs;`);
    for (const tb of ['product_change_log', 'product_syd_codes', 'product_applications', 'product_oe_codes', 'product_status_log', 'product_price_history']) {
      await query(`DELETE FROM ${tb} WHERE product_id IN (${MINE})`).catch(() => {});
    }
    await query(`DELETE FROM products WHERE id IN (${MINE})`);
  }
  after(async () => {
    await cleanup().catch((e) => console.error('cleanup', e.message));
    if (!epKeep) return;
    await query(`UPDATE integration_endpoints SET enabled=$1, env=$2, url_test=$3, body_shape=$4, timeout_ms=$5, auto_send=$6, delta_auto=$7 WHERE key='product'`,
      [epKeep.enabled, epKeep.env, epKeep.url_test, epKeep.body_shape, epKeep.timeout_ms, epKeep.auto_send, epKeep.delta_auto]).catch(() => {});
    invalidateEndpointCache();
  });
  after(async () => { await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });

  // CRM 받는 쪽 흉내
  const received = [];
  const crm = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      received.push(raw ? JSON.parse(raw) : null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ codigoError: '0', mensaje: 'OK' }));
    });
  });
  await new Promise((r) => crm.listen(0, '127.0.0.1', r));
  t.after(() => crm.close());
  const CRM_URL = `http://127.0.0.1:${crm.address().port}/productos`;

  // 플랫폼 세션 확인 흉내 — aaaaaaaa… 유효 · eeeeeeee… 무응답 · 그 외 무효
  const V = await import('../src/surveyViewer.js');
  const keepLog = V.platformApi.log; const pfLogs = [];
  V.platformApi.log = async (tok, txt) => {
    pfLogs.push([tok, txt]);
    if (tok.startsWith('aaaaaaaa')) return { ok: true };
    if (tok.startsWith('eeeeeeee')) return { ok: false, error: 'platform_timeout' };
    return { ok: false, invalid: true };
  };
  t.after(() => { V.platformApi.log = keepLog; });

  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  t.after(() => app.close());
  const call = (h, method, url, payload) => app.inject({ method, url, payload, headers: h });

  const one = async (sql, a) => (await query(sql, a)).rows[0];
  await cleanup();
  const SFX = Date.now().toString(36).slice(-5);
  const dir = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x',$2) RETURNING id`, [`PF Dir ${SFX}`, `pfdir${SFX}`]);
  const D = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(dir.id), role: 'director' }) };
  const mk = (code, name, app_, scode, extra = {}) => one(
    `INSERT INTO products (code, name, app, scode, list_price, stock_qty, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [code, name, app_, scode, extra.price ?? 245.5, extra.stock ?? 17, extra.active ?? true]);
  const p1 = await mk('PFC001', 'ROTULA INFERIOR', 'NISSAN Versa 2012-2019', '1603005');
  const p2 = await mk('PFC002', 'TERMINAL EXTERIOR', 'MITSUBISHI Asx 2013-2015', '1115007');
  const p3 = await mk('PFC003', 'BUJE HORQUILLA', 'CHEVROLET Aveo 2008-2018', null, { active: false });
  await mk('PROPF1', 'CODIGO INTERNO', null, null);
  await mk('K0991', 'KIT VIO', null, null);

  // CRM 제품 창구 — 켜고, 변경분 자동도 켠다(즉시 전송은 그 설정을 따른다)
  epKeep = await one(`SELECT enabled, env, url_test, body_shape, timeout_ms, auto_send, delta_auto FROM integration_endpoints WHERE key='product'`);
  await query(`UPDATE integration_endpoints SET enabled=true, env='test', url_test=$1, body_shape='item', timeout_ms=3000,
                      auto_send=false, delta_auto=true WHERE key='product'`, [CRM_URL]);
  invalidateEndpointCache();
  const PS = await import('../src/productSync.js');
  const { pumpState } = await import('../src/crmSync.js');
  async function crmIdle() {
    await PS.flushProductPush();
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 60));
    while (pumpState().running && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20));
  }
  const sentCodes = () => received.map((b) => (b && (b.codigo || (b.productos && b.productos[0] && b.productos[0].codigo)))).filter(Boolean);

  // ── 로그인 ───────────────────────────────────────────────
  assert.equal((await call({}, 'POST', '/api/pf-catalog/login', { token: 'nope' })).statusCode, 401, 'uuid 아님 → 플랫폼에 묻지 않음');
  assert.equal((await call({}, 'POST', '/api/pf-catalog/login', { token: 'bbbbbbbb-1111-4111-8111-111111111111' })).statusCode, 401);
  assert.equal((await call({}, 'POST', '/api/pf-catalog/login', { token: 'eeeeeeee-1111-4111-8111-111111111111' })).statusCode, 502);
  const T1 = 'aaaaaaaa-1111-4111-8111-111111111111';
  const lg = await call({}, 'POST', '/api/pf-catalog/login', { token: T1, name: 'Park CTR', user_key: '12' });
  assert.equal(lg.statusCode, 200, lg.body);
  const H = { authorization: 'Bearer ' + lg.json().token };
  assert.equal((await call(H, 'GET', '/api/products')).statusCode, 401, '플랫폼 토큰으로 ERP API 불가');
  assert.equal((await call(D, 'GET', '/api/pf-catalog/summary')).statusCode, 401, 'ERP 토큰으로 플랫폼 화면 API 불가');
  assert.equal((await call({}, 'GET', '/api/pf-catalog/items')).statusCode, 401);

  // ── 최초 상태: 전부 미검토 · 가격/재고 없음 · PRO·키트 제외 ─────────
  let L = (await call(H, 'GET', '/api/pf-catalog/items?q=PFC&limit=50')).json();
  assert.deepEqual(L.items.map((x) => x.code), ['PFC001', 'PFC002', 'PFC003']);
  assert.ok(L.items.every((x) => x.status === 'pending'));
  for (const k of ['list_price', 'stock_qty', 'precio', 'existencia', 'avg_cost']) assert.ok(!(k in L.items[0]), `${k} 없음`);
  assert.equal((await call(H, 'GET', '/api/pf-catalog/items?q=PROPF')).json().total, 0, 'PRO 제외');
  assert.equal((await call(H, 'GET', '/api/pf-catalog/items?q=K0991')).json().total, 0, '키트 제외');
  assert.equal((await call(H, 'GET', '/api/pf-catalog/items?q=PFC&active=1')).json().total, 2, '판매중만');
  assert.equal((await call(H, 'GET', `/api/pf-catalog/items/${p3.id}`)).json().activo, false);

  // ── 수정안: ERP 는 그대로 ────────────────────────────────
  let r = await call(H, 'PUT', `/api/pf-catalog/items/${p1.id}/draft`, { fields: { app: 'NISSAN Versa 2012-2019 // NISSAN March 2012-2020', list_price: 1 }, note: '카탈로그 대조' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().fields, ['app']);
  assert.equal(r.json().item.status, 'draft');
  assert.equal(r.json().item.draft.app.state, 'ok');
  assert.equal((await one(`SELECT app FROM products WHERE id=$1`, [p1.id])).app, 'NISSAN Versa 2012-2019', '수정안은 ERP 를 바꾸지 않는다');
  assert.equal((await one(`SELECT list_price FROM products WHERE id=$1`, [p1.id])).list_price, '245.50', '가격은 건드리지 않는다');

  // ── 확인완료: ERP 즉시 반영 ──────────────────────────────
  received.length = 0;
  r = await call(H, 'POST', `/api/pf-catalog/items/${p1.id}/confirm`, { fields: { scode: '1603005 // 1603006' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(Object.keys(r.json().applied).sort(), ['app', 'scode']);
  const p1now = await one(`SELECT app, scode, stock_qty FROM products WHERE id=$1`, [p1.id]);
  assert.equal(p1now.app, 'NISSAN Versa 2012-2019 // NISSAN March 2012-2020');
  assert.equal(p1now.scode, '1603005 // 1603006');
  assert.equal(Number(p1now.stock_qty), 17, '재고 그대로');
  assert.equal((await one(`SELECT count(*)::int n FROM product_applications WHERE product_id=$1`, [p1.id])).n, 2, '적용차종 표 재구성');
  assert.equal((await one(`SELECT count(*)::int n FROM product_syd_codes WHERE product_id=$1`, [p1.id])).n, 2, 'SYD 표 재구성');
  const log1 = await one(`SELECT source, changes, changed_by FROM product_change_log WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [p1.id]);
  assert.equal(log1.source, 'platform'); assert.equal(log1.changes._pf.to, 'Park CTR'); assert.equal(log1.changed_by, null);
  assert.equal(r.json().item.status, 'ok');
  assert.equal(r.json().item.locked, true, '확인완료 → 잠금');
  assert.equal(r.json().item.confirmed_source, 'platform');
  // 잠긴 품목은 플랫폼에서 더 고칠 수 없다
  let lk = await call(H, 'PUT', `/api/pf-catalog/items/${p1.id}/draft`, { fields: { name: 'X' } });
  assert.equal(lk.statusCode, 409); assert.equal(lk.json().error, 'locked');
  lk = await call(H, 'POST', `/api/pf-catalog/items/${p1.id}/confirm`, { fields: { name: 'X' } });
  assert.equal(lk.statusCode, 409); assert.equal(lk.json().error, 'locked');
  assert.equal(r.json().item.confirmed_by_name, 'Park CTR');
  assert.equal(r.json().item.draft_note, null, '확인하면 수정안·메모 비움');
  assert.equal((await one(`SELECT note FROM pf_catalog_confirms WHERE product_id=$1`, [p1.id])).note, '카탈로그 대조', '메모는 확인 이력에');
  assert.ok(pfLogs.some(([tok, txt]) => tok === T1 && /확인완료 · PFC001 · 수정 2칸/.test(txt)), '플랫폼 활동 로그');
  // ERP 제품 이력 화면: 변경자 = 플랫폼 확인자, 출처 = platform, _pf 는 항목에 안 보임
  const hist = (await call(D, 'GET', `/api/products/history?product_id=${p1.id}`)).json();
  const h0 = hist.items.find((x) => x.source === 'platform');
  assert.ok(h0, JSON.stringify(hist).slice(0, 300));
  assert.equal(h0.changed_by_name, 'Park CTR');
  assert.ok(h0.parts.every((x) => x.field !== '_pf'));
  // CRM 즉시 전송
  await crmIdle();
  assert.ok(sentCodes().includes('PFC001'), 'CTR 확인완료 → CRM 즉시: ' + JSON.stringify(PS.pushState.last));

  // ── 그대로 맞음 확인(변경 없음) ───────────────────────────
  received.length = 0;
  r = await call(H, 'POST', `/api/pf-catalog/items/${p2.id}/confirm`, {});
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().applied, {});
  assert.equal(r.json().item.status, 'ok');
  assert.equal((await one(`SELECT count(*)::int n FROM product_change_log WHERE product_id=$1`, [p2.id])).n, 0, '바뀐 게 없으면 제품 이력도 없음');
  await crmIdle();
  assert.ok(!sentCodes().includes('PFC002'), '바뀐 게 없으면 CRM 도 보내지 않음');

  // ── ERP 현장 수정 → 재확인 + CRM 즉시 ────────────────────
  received.length = 0;
  r = await call(D, 'PATCH', `/api/products/${p2.id}`, { app: 'MITSUBISHI Asx 2013-2016' });
  assert.equal(r.statusCode, 200, r.body);
  let it2 = (await call(H, 'GET', `/api/pf-catalog/items/${p2.id}`)).json();
  assert.equal(it2.status, 'changed', '확인 뒤 현장 수정 → 재확인');
  assert.equal(it2.app, 'MITSUBISHI Asx 2013-2016', '플랫폼은 ERP 지금 값을 바로 본다');
  assert.ok(it2.history.some((h) => h.source === 'manual' && h.parts.some((p) => p.field === 'app')), 'ERP 이력이 보인다');
  await crmIdle();
  assert.ok(sentCodes().includes('PFC002'), 'ERP 현장 수정 → CRM 즉시');
  const sum = (await call(H, 'GET', '/api/pf-catalog/summary')).json();
  assert.ok(sum.all.changed >= 1 && sum.all.ok >= 1);

  // ── 수정안 작성 중 현장 수정 → 409 · 아무것도 안 바뀜 ──────
  r = await call(H, 'PUT', `/api/pf-catalog/items/${p2.id}/draft`, { fields: { app: 'MITSUBISHI Asx 2013-2017', name: 'TERMINAL EXT.' } });
  assert.equal(r.statusCode, 200, r.body);
  await call(D, 'PATCH', `/api/products/${p2.id}`, { app: 'MITSUBISHI Asx 2013-2018' });   // 그사이 현장 수정
  r = await call(H, 'POST', `/api/pf-catalog/items/${p2.id}/confirm`, {});
  assert.equal(r.statusCode, 409, r.body);
  assert.deepEqual(r.json().conflicts.map((x) => x.field), ['app']);
  assert.equal(r.json().conflicts[0].erp, 'MITSUBISHI Asx 2013-2018');
  assert.equal(r.json().conflicts[0].mine, 'MITSUBISHI Asx 2013-2017');
  let p2now = await one(`SELECT name, app FROM products WHERE id=$1`, [p2.id]);
  assert.equal(p2now.name, 'TERMINAL EXTERIOR', '겹치면 다른 칸도 반영하지 않는다');
  assert.equal(r.json().item.draft.app.state, 'conflict');
  assert.equal(r.json().item.draft.name.state, 'ok', '수정안은 그대로 보존');
  // ERP 것을 쓰기로 → 이름만 반영, 적용차종은 현장 값 유지
  r = await call(H, 'POST', `/api/pf-catalog/items/${p2.id}/confirm`, { resolve: { app: 'erp' } });
  assert.equal(r.statusCode, 200, r.body);
  p2now = await one(`SELECT name, app FROM products WHERE id=$1`, [p2.id]);
  assert.equal(p2now.name, 'TERMINAL EXT.'); assert.equal(p2now.app, 'MITSUBISHI Asx 2013-2018');
  assert.equal(r.json().chosen.app.chose, 'erp');
  assert.equal(r.json().item.status, 'ok');
  // 내 것을 쓰기로 — 확인완료라 잠겨 있으니 ERP 수정으로 먼저 다시 연다(재확인)
  await call(D, 'PATCH', `/api/products/${p2.id}`, { name: 'TERMINAL EXT' });
  assert.equal((await call(H, 'GET', `/api/pf-catalog/items/${p2.id}`)).json().locked, false, 'ERP 에서 바뀌면 다시 열림');
  r = await call(H, 'PUT', `/api/pf-catalog/items/${p2.id}/draft`, { fields: { app: 'MITSUBISHI Asx 2013-2019' } });
  assert.equal(r.statusCode, 200, r.body);
  await call(D, 'PATCH', `/api/products/${p2.id}`, { app: 'MITSUBISHI Asx 2014-2018' });
  r = await call(H, 'POST', `/api/pf-catalog/items/${p2.id}/confirm`, { resolve: { app: 'mine' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await one(`SELECT app FROM products WHERE id=$1`, [p2.id])).app, 'MITSUBISHI Asx 2013-2019');
  assert.equal((await one(`SELECT conflicts FROM pf_catalog_confirms WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [p2.id])).conflicts.app.chose, 'mine');

  // ── 수정안 버리기 ─────────────────────────────────────
  await call(H, 'PUT', `/api/pf-catalog/items/${p3.id}/draft`, { fields: { material: 'aluminum' } });
  assert.equal((await call(H, 'GET', `/api/pf-catalog/items/${p3.id}`)).json().draft.material.value, 'aluminio', '소재 정규화');
  r = await call(H, 'DELETE', `/api/pf-catalog/items/${p3.id}/draft`);
  assert.equal(r.json().item.status, 'pending');
  assert.equal((await call(H, 'PUT', `/api/pf-catalog/items/${p3.id}/draft`, { fields: { name: ' ' } })).statusCode, 400, '제품명 비움 거절');

  // ── ERP 신규 품목 → 플랫폼에 바로 미검토 · CRM 즉시 ───────
  received.length = 0;
  r = await call(D, 'POST', '/api/products', { code: 'PFC004', name: 'TORNILLO ESTABILIZADOR', app: 'KIA Rio 2018-2023', list_price: 99 });
  assert.equal(r.statusCode, 200, r.body);
  L = (await call(H, 'GET', '/api/pf-catalog/items?q=PFC004')).json();
  assert.equal(L.items[0].status, 'pending');
  await crmIdle();
  assert.ok(sentCodes().includes('PFC004'), 'ERP 신규 품목 → CRM 즉시');

  // ── 상태 거르기 · 미리보기 ─────────────────────────────
  assert.deepEqual((await call(H, 'GET', '/api/pf-catalog/items?q=PFC&status=ok')).json().items.map((x) => x.code), ['PFC001', 'PFC002']);
  const pv = (await call(H, 'POST', '/api/pf-catalog/preview', { app: 'NISSAN Versa 2012-2019 // KIA Rio 2018', scode: 'A // B' })).json();
  assert.equal(pv.apps.length, 2); assert.deepEqual(pv.syd, ['A', 'B']);

  // ── 오래된 화면 · 다른 사람의 저장 ─────────────────────
  const p5 = await mk('PFC005', 'BRAZO', 'FORD Fiesta 2011-2019', '3301//3302', { stock: 0 });
  let it5 = (await call(H, 'GET', `/api/pf-catalog/items/${p5.id}`)).json();
  const L5 = { name: it5.name, scode: it5.scode, app: it5.app, oe: it5.oe, material: it5.material };
  // 화면 표기(' // ')로 보내도 구분자만 다르면 수정이 아니다
  r = await call(H, 'POST', `/api/pf-catalog/items/${p5.id}/confirm`, { fields: { ...L5, scode: '3301 // 3302' }, loaded: L5, rev: it5.rev });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().applied, {}, '구분자만 다름 → ERP 를 다시 쓰지 않는다');
  assert.equal((await one(`SELECT scode FROM products WHERE id=$1`, [p5.id])).scode, '3301//3302');
  it5 = r.json().item;
  const L5b = { name: it5.name, scode: it5.scode, app: it5.app, oe: it5.oe, material: it5.material };
  // 화면을 연 뒤 ERP 현장 수정 → 「그대로 맞음」 확인은 409 stale(보지 않은 값을 확인하지 않는다)
  await call(D, 'PATCH', `/api/products/${p5.id}`, { name: 'BRAZO SUSPENSION' });
  r = await call(H, 'POST', `/api/pf-catalog/items/${p5.id}/confirm`, { fields: L5b, loaded: L5b, rev: it5.rev });
  assert.equal(r.statusCode, 409, r.body); assert.equal(r.json().error, 'stale'); assert.deepEqual(r.json().fields, ['name']);
  assert.equal((await one(`SELECT name FROM products WHERE id=$1`, [p5.id])).name, 'BRAZO SUSPENSION', '오래된 화면 값으로 덮지 않는다');
  // 다시 불러온 값으로는 된다
  it5 = r.json().item;
  const L5c = { name: it5.name, scode: it5.scode, app: it5.app, oe: it5.oe, material: it5.material };
  r = await call(H, 'POST', `/api/pf-catalog/items/${p5.id}/confirm`, { fields: L5c, loaded: L5c, rev: it5.rev });
  assert.equal(r.statusCode, 200, r.body);
  // 두 사람: A 가 수정안 저장 → 그 전에 연 B 의 확인은 409 stale_review · A 의 수정안 보존
  //   (확인완료로 잠겼으니 ERP 수정으로 다시 연다)
  await call(D, 'PATCH', `/api/products/${p5.id}`, { material: 'aluminio' });
  it5 = (await call(H, 'GET', `/api/pf-catalog/items/${p5.id}`)).json(); const revB = it5.rev;
  const L5d = { name: it5.name, scode: it5.scode, app: it5.app, oe: it5.oe, material: it5.material };
  r = await call(H, 'PUT', `/api/pf-catalog/items/${p5.id}/draft`, { fields: { ...L5d, app: 'FORD Fiesta 2011-2020' }, loaded: L5d, rev: revB });
  assert.equal(r.statusCode, 200, r.body);
  r = await call(H, 'POST', `/api/pf-catalog/items/${p5.id}/confirm`, { fields: L5d, loaded: L5d, rev: revB });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error, 'stale_review');
  assert.equal(r.json().item.draft.app.value, 'FORD Fiesta 2011-2020', 'A 의 수정안 그대로');
  // 확인완료는 updated_by 를 비운다(ERP 사용자가 아님)
  r = await call(H, 'POST', `/api/pf-catalog/items/${p5.id}/confirm`, { fields: {}, loaded: L5d, rev: r.json().item.rev });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await one(`SELECT updated_by FROM products WHERE id=$1`, [p5.id])).updated_by, null);
  // 점검·확인 기록이 있어도 제품 삭제가 막히지 않는다
  const { hashPin } = await import('../src/auth.js');
  await query(`UPDATE users SET pin_hash=$1 WHERE id=$2`, [hashPin('135790'), dir.id]);
  r = await call(D, 'DELETE', `/api/products/${p5.id}`, { pin: '135790', code: 'PFC005', reason: 'test' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await one(`SELECT count(*)::int n FROM pf_catalog_review WHERE product_id=$1`, [p5.id])).n, 0);
  assert.ok((await one(`SELECT count(*)::int n FROM pf_catalog_confirms WHERE code='PFC005' AND product_id IS NULL`)).n >= 1, '확인 이력은 코드로 남는다');

  // ── 엑셀 다운로드 · 위치 기록 · 디렉터 보기 ─────────────
  await query(`DELETE FROM pf_catalog_exports`);
  assert.equal((await call(H, 'POST', '/api/pf-catalog/export', { filters: {}, gps_status: 'denied' })).statusCode, 403, '위치 거부 → 다운로드 없음');
  assert.equal((await one(`SELECT count(*)::int n FROM pf_catalog_exports`)).n, 0, '거부는 기록도 데이터도 없음');
  r = await call(H, 'POST', '/api/pf-catalog/export', { filters: { q: 'PFC', status: '', active: 'all' }, gps: { lat: 25.7769, lng: -100.1867, acc: 18.4 }, gps_status: 'ok' });
  assert.equal(r.statusCode, 200, r.body);
  const ex = r.json();
  assert.ok(ex.export_id > 0); assert.equal(ex.by, 'Park CTR');
  assert.deepEqual(ex.items.map((x) => x.code), ['PFC001', 'PFC002', 'PFC003', 'PFC004']);
  for (const k of ['list_price', 'stock_qty', 'precio', 'existencia']) assert.ok(!(k in ex.items[0]), `${k} 없음`);
  assert.ok(ex.apps.some((a) => a.code === 'PFC001' && a.marca === 'NISSAN'), '적용차종 줄');
  r = await call(H, 'POST', '/api/pf-catalog/export', { filters: { status: 'ok' }, gps: null, gps_status: 'unavailable' });
  assert.equal(r.statusCode, 200, 'GPS 시간 초과는 허용(IP 로 기록)');
  assert.equal((await call(D, 'POST', '/api/pf-catalog/export', {})).statusCode, 401, 'ERP 토큰으로 내려받기 불가');
  assert.equal((await call(H, 'GET', '/api/pf-catalog/admin/exports')).statusCode, 401, '플랫폼 토큰으로 기록 보기 불가');
  const ad = (await call(D, 'GET', '/api/pf-catalog/admin/exports')).json();
  assert.equal(ad.total, 2);
  assert.equal(ad.items[1].user, 'Park CTR'); assert.equal(ad.items[1].rows, 4);
  assert.deepEqual(ad.items[1].gps, { lat: 25.7769, lng: -100.1867, acc: 18 });
  assert.equal(ad.items[1].filters.q, 'PFC');
  assert.equal(ad.items[0].gps, null); assert.equal(ad.items[0].gps_status, 'unavailable'); assert.equal(ad.items[0].filters.status, 'ok');
  assert.ok(pfLogs.some(([, txt]) => /엑셀 다운로드 · 4건/.test(txt)), '플랫폼 활동 로그');
  assert.equal((await call(H, 'GET', '/api/pf-catalog/items?offset=1e300')).statusCode, 200, '이상한 offset 도 500 아님');
  assert.equal((await call(H, 'GET', '/api/pf-catalog/items?q=PFC%25')).json().total, 0, '% 는 글자 그대로');

  // ── 변경분 자동 끄면 즉시 전송도 쉰다 ───────────────────
  await query(`UPDATE integration_endpoints SET delta_auto=false WHERE key='product'`); invalidateEndpointCache();
  received.length = 0;
  await call(D, 'PATCH', `/api/products/${p1.id}`, { name: 'ROTULA INF.' });
  await crmIdle();
  assert.equal(PS.pushState.last.skipped, 'delta_off');
  assert.ok(!sentCodes().includes('PFC001'));
  assert.equal((await call(H, 'GET', `/api/pf-catalog/items/${p1.id}`)).json().status, 'changed');

  // ── 고르기 목록(제품명 · 소재) ─────────────────────────
  const op = (await call(H, 'GET', '/api/pf-catalog/options')).json();
  assert.ok(op.names.some((x) => x.v === 'ROTULA INF.'), '제품명 목록');
  assert.ok(op.materials.some((x) => x.v === 'aluminio'), '알루미늄은 늘 있다');
  assert.ok(!op.names.some((x) => /CODIGO INTERNO|KIT VIO/.test(x.v)), 'PRO · 키트 이름은 없다');

  // ── ERP 엑셀 일괄 검토완료 ───────────────────────────
  const b1 = await mk('PFCB01', 'BUJE A', 'KIA Rio 2018-2023', '9001');          // 미검토 → 검토완료
  const b2 = await mk('PFCB02', 'BUJE B', 'KIA Rio 2018-2023', '9002');          // CTR 확인완료 → 그대로
  const b3 = await mk('PFCB03', 'BUJE C', 'KIA Rio 2018-2023', '9003');          // 수정안 있음 → 건너뜀
  const b4 = await mk('PFCB04', 'BUJE D', 'KIA Rio 2018-2023', '9004');          // 재확인 → 검토완료
  assert.equal((await call(H, 'POST', `/api/pf-catalog/items/${b2.id}/confirm`, {})).statusCode, 200);
  assert.equal((await call(H, 'PUT', `/api/pf-catalog/items/${b3.id}/draft`, { fields: { name: 'BUJE C2' } })).statusCode, 200);
  assert.equal((await call(H, 'POST', `/api/pf-catalog/items/${b4.id}/confirm`, {})).statusCode, 200);
  await call(D, 'PATCH', `/api/products/${b4.id}`, { name: 'BUJE D2' });
  assert.equal((await call(H, 'POST', '/api/pf-catalog/admin/mark-reviewed', { codes: ['PFCB01'] })).statusCode, 401, '플랫폼 토큰으로 일괄 불가');
  r = await call(D, 'POST', '/api/pf-catalog/admin/mark-reviewed', { codes: [' pfcb01 ', 'PFCB02', 'PFCB03', 'PFCB04', 'PFCB01', 'NOPE-1', 'PROPF1'], file_name: 'revisados.xlsx' });
  assert.equal(r.statusCode, 200, r.body);
  const bk = r.json();
  assert.equal(bk.codes_in, 6, '중복 · 공백 정리'); assert.equal(bk.marked, 2); assert.equal(bk.already, 1);
  assert.deepEqual(bk.skipped_draft, ['PFCB03']); assert.deepEqual(bk.missing.sort(), ['NOPE-1', 'PROPF1']);
  let ib = (await call(H, 'GET', `/api/pf-catalog/items/${b1.id}`)).json();
  assert.equal(ib.status, 'ok'); assert.equal(ib.confirmed_source, 'bulk'); assert.equal(ib.locked, true);
  assert.equal(ib.confirmed_by_name, `PF Dir ${SFX}`);
  assert.equal(ib.confirms[0].source, 'bulk'); assert.match(ib.confirms[0].note, /ERP 엑셀 일괄 검토완료 #\d+ · revisados\.xlsx/);
  assert.equal((await call(H, 'GET', `/api/pf-catalog/items/${b4.id}`)).json().confirmed_source, 'bulk', '재확인 → 검토완료');
  assert.equal((await call(H, 'GET', `/api/pf-catalog/items/${b2.id}`)).json().confirmed_source, 'platform', 'CTR 확인완료는 덮지 않음');
  const ib3 = (await call(H, 'GET', `/api/pf-catalog/items/${b3.id}`)).json();
  assert.equal(ib3.status, 'draft', '수정안 품목은 그대로'); assert.equal(ib3.draft.name.value, 'BUJE C2');
  lk = await call(H, 'PUT', `/api/pf-catalog/items/${b1.id}/draft`, { fields: { name: 'X' } });
  assert.equal(lk.statusCode, 409); assert.equal(lk.json().error, 'locked', '검토완료도 잠금');
  assert.equal((await one(`SELECT name FROM products WHERE id=$1`, [b1.id])).name, 'BUJE A', '검토완료는 ERP 값을 바꾸지 않는다');
  const bl = (await call(D, 'GET', '/api/pf-catalog/admin/bulk')).json();
  assert.equal(bl.items[0].file, 'revisados.xlsx'); assert.equal(bl.items[0].marked, 2); assert.equal(bl.items[0].by, `PF Dir ${SFX}`);
  assert.equal((await call(D, 'POST', '/api/pf-catalog/admin/mark-reviewed', { codes: [] })).statusCode, 400);
  // ERP 에서 바뀌면 다시 열린다
  await call(D, 'PATCH', `/api/products/${b1.id}`, { name: 'BUJE A2' });
  ib = (await call(H, 'GET', `/api/pf-catalog/items/${b1.id}`)).json();
  assert.equal(ib.status, 'changed'); assert.equal(ib.locked, false);
  // 상태 거르기 「ok」 에 두 출처가 함께
  const okList = (await call(H, 'GET', '/api/pf-catalog/items?q=PFCB&status=ok')).json();
  assert.deepEqual(okList.items.map((x) => [x.code, x.confirmed_source]), [['PFCB02', 'platform'], ['PFCB04', 'bulk']]);
});
