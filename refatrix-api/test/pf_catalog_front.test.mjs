// =====================================================================
// pf_catalog_front.test.mjs — REFATRIX Platform(Netlify) catalog.html (0302 · 2026-10-27)
//   원본 templates/catalog_platform.html 을 jsdom 으로 띄우고, fetch 를 **실제 ERP 서버**(buildApp · 실 PostgreSQL)로 돌린다.
//   플랫폼 세션 확인(app_log)만 스텁.
//   ① 플랫폼 세션 → 로그인 → 상태 칸 · 목록(가격·재고 없음)
//   ② 부품 열기 → 적용차종 수정 → 버튼에 「1칸 ERP 반영」 → 확인완료 → ERP 반영 · 다음 부품 자동 열림
//   ③ 수정안 저장 중 ERP 현장 수정 → 확인완료 409 → 고르기 칸 → ERP 값 선택 → 확인완료
//   ④ 플랫폼 세션 없음 → 안내(ERP 호출 없음) · 인라인 onclick 없음
//   실행: TEST_PG_URL=postgres://... node --test --test-concurrency=1 test/pf_catalog_front.test.mjs   (jsdom 필요)
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pf-catalog-front';
const here = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = resolve(here, '..', 'templates', 'catalog_platform.html');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const SKIP = !JSDOM ? 'jsdom 없음' : !PG ? 'TEST_PG_URL 없음' : false;
const LIVE = 'https://refatrix-production.up.railway.app';
const T1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await tick(40); }
}

test('정적 — 인라인 onclick 없음 · 가격/재고 칸 없음 · 플랫폼 세션 키', () => {
  const html = readFileSync(HTML_PATH, 'utf-8');
  assert.ok(!/\sonclick=/i.test(html), '인라인 onclick 없음');
  assert.ok(!/list_price|stock_qty|precioLista|precioCompra|it\.existencia|it\.precio/i.test(html), '가격·재고 칸을 다루지 않는다');
  assert.ok(html.includes("sessionStorage.getItem('rfx_sess')"));
  assert.ok(html.includes(LIVE), '운영 ERP 주소');
});

test('jsdom + 실제 ERP 서버', { skip: SKIP }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  const MINE = `SELECT id FROM products WHERE code LIKE 'PFF%'`;
  async function cleanup() {
    await query(`DELETE FROM pf_catalog_confirms WHERE product_id IN (${MINE}); DELETE FROM pf_catalog_review WHERE product_id IN (${MINE});`);
    for (const tb of ['product_change_log', 'product_syd_codes', 'product_applications', 'product_oe_codes']) await query(`DELETE FROM ${tb} WHERE product_id IN (${MINE})`);
    await query(`DELETE FROM products WHERE id IN (${MINE})`);
  }
  after(async () => { await cleanup().catch(() => {}); await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });

  const V = await import('../src/surveyViewer.js');
  const keepLog = V.platformApi.log;
  V.platformApi.log = async (tok) => (tok === T1 ? { ok: true } : { ok: false, invalid: true });
  t.after(() => { V.platformApi.log = keepLog; });

  const { buildApp } = await import('../src/server.js');
  const app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  const LOCAL = `http://127.0.0.1:${app.server.address().port}`;

  await cleanup();
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  const SFX = Date.now().toString(36).slice(-5);
  const dir = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x',$2) RETURNING id`, [`PFF Dir ${SFX}`, `pffdir${SFX}`]);
  const D = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(dir.id), role: 'director' }) };
  const mk = (code, name, app_, scode) => one(
    `INSERT INTO products (code, name, app, scode, list_price, stock_qty, is_active) VALUES ($1,$2,$3,$4,321,9,true) RETURNING id`,
    [code, name, app_, scode]);
  const a = await mk('PFF001', 'ROTULA SUPERIOR', 'NISSAN Tsuru 1992-2017', '1603100');
  const b = await mk('PFF002', 'HORQUILLA INFERIOR', 'VOLKSWAGEN Jetta 2006-2010', '2201001');
  await mk('PFF003', 'BUJE', 'CHEVROLET Aveo 2008-2018', null);

  const fetchCalls = [];
  function boot({ pf = { t: T1, e: Date.now() + 3600e3, u: { id: 12, name: 'Park CTR', role: 'dev' } } } = {}) {
    return new JSDOM(readFileSync(HTML_PATH, 'utf-8'), {
      runScripts: 'dangerously', url: 'https://refatrix-platform.netlify.app/catalog.html',
      beforeParse(w) {
        if (pf) w.sessionStorage.setItem('rfx_sess', JSON.stringify(pf));
        w.confirm = () => true;
        w.scrollTo = () => {};
        // 위치 · 엑셀 도구 흉내 — geoMode: ok | denied | timeout
        Object.defineProperty(w.navigator, 'geolocation', { configurable: true, value: {
          getCurrentPosition(ok, bad) {
            if (w.__geoMode === 'denied') return bad({ code: 1 });
            if (w.__geoMode === 'timeout') return bad({ code: 3 });
            ok({ coords: { latitude: 25.6866, longitude: -100.3161, accuracy: 25 } });
          } } });
        w.__xlsx = [];
        w.XLSX = { utils: { book_new: () => ({ sheets: [] }), json_to_sheet: (rows) => ({ rows }), aoa_to_sheet: (a) => ({ a }),
          book_append_sheet: (wb, ws, n) => { wb.sheets.push({ n, ws }); } },
          writeFile: (wb, name) => { w.__xlsx.push({ wb, name }); } };
        w.HTMLElement.prototype.scrollIntoView = function () {};
        w.fetch = async (url, opt = {}) => {
          const u = String(url).replace(LIVE, LOCAL);
          fetchCalls.push({ u, method: opt.method || 'GET' });
          const r = await fetch(u, { method: opt.method || 'GET', headers: opt.headers, body: opt.body });
          const txt = await r.text();
          return { ok: r.ok, status: r.status, json: async () => (txt ? JSON.parse(txt) : {}) };
        };
      },
    });
  }

  // ① 로그인 · 상태 칸 · 목록
  const dom = boot();
  const w = dom.window; const $ = (id) => w.document.getElementById(id);
  await until(() => !$('app').classList.contains('hidden'));
  assert.ok(!$('app').classList.contains('hidden'), $('gate').textContent);
  assert.match($('who').textContent, /Park CTR/);
  $('q').value = 'PFF'; $('q').dispatchEvent(new w.Event('input'));
  await until(() => fetchCalls.some((c) => c.u.includes('/items?q=PFF')));
  await until(() => $('rows').querySelectorAll('tr[data-i]').length === 3);
  const rows = [...$('rows').querySelectorAll('tr[data-i]')];
  assert.deepEqual(rows.map((r) => r.querySelector('.code').textContent), ['PFF001', 'PFF002', 'PFF003']);
  assert.ok(rows.every((r) => /미검토/.test(r.textContent)));
  assert.ok(!/321|precio/i.test($('rows').textContent), '가격 없음');
  assert.ok($('chips').querySelectorAll('.chip').length === 5);

  // ② 열기 → 적용차종 한 줄 추가 → 확인완료 → ERP 반영 · 다음 부품 열림
  rows[0].click();
  await until(() => $('dr').classList.contains('on') && $('e_app'));
  assert.equal($('dCode').textContent, 'PFF001');
  assert.match($('bOk').textContent, /그대로 맞음/);
  // 사진 창(좁은 화면 → 서랍 안) — CTR 사진 · SYD 사진, SYD 코드가 여럿이면 화살표로 넘김
  assert.ok($('ppIn').querySelector('#g_ctr') && $('ppIn').querySelector('#g_syd'), 'CTR · SYD 사진 칸');
  assert.match($('gim_ctr').getAttribute('src'), /r2\.dev\/products\/PFF001\/PFF001_1\.webp$/);
  assert.match($('gim_syd').getAttribute('src'), /syd\.com\.mx\/Catalogo\/fotos\/1603100\.jpg$/);
  assert.ok($('gr_syd').classList.contains('hidden'), 'SYD 코드 하나면 화살표 없음');
  $('e_scode').value = '1603100\n1603101\n1603102'; $('e_scode').dispatchEvent(new w.Event('input'));
  assert.equal($('gn_syd').textContent, '1 / 3');
  $('gr_syd').click(); $('gr_syd').click();
  assert.equal($('gc_syd').textContent, '1603102'); assert.match($('gim_syd').getAttribute('src'), /1603102\.jpg$/);
  assert.ok($('gr_syd').disabled, '끝에서는 다음 없음');
  $('gl_syd').click(); assert.equal($('gc_syd').textContent, '1603101');
  $('e_scode').value = '1603100'; $('e_scode').dispatchEvent(new w.Event('input'));
  // 제품명 · 소재 — 고르기 우선, 목록에 없으면 직접 입력
  const sName = $('s_name'), sMat = $('s_material');
  assert.ok(sName && sMat, '고르기 칸');
  assert.equal(sName.value, 'ROTULA SUPERIOR'); assert.ok($('e_name').classList.contains('hidden'), '목록에 있으면 입력칸 숨김');
  assert.ok([...sMat.options].some((o) => o.value === 'aluminio'), '알루미늄 고르기');
  sMat.value = 'aluminio'; sMat.dispatchEvent(new w.Event('change'));
  assert.equal($('e_material').value, 'aluminio'); assert.ok($('w_material').classList.contains('chg'));
  sMat.value = '__manual'; sMat.dispatchEvent(new w.Event('change'));
  assert.ok(!$('e_material').classList.contains('hidden'), '직접 입력 칸 열림');
  sMat.value = ''; sMat.dispatchEvent(new w.Event('change'));
  assert.ok(!$('w_material').classList.contains('chg'), '없음으로 되돌리면 변경 아님');
  $('e_app').value = 'NISSAN Tsuru 1992-2017\nNISSAN Sentra 1991-1994';
  $('e_app').dispatchEvent(new w.Event('input'));
  assert.match($('bOk').textContent, /1칸 ERP 반영/);
  assert.ok($('w_app').classList.contains('chg'));
  await until(() => $('pvApp').querySelectorAll('tbody tr').length === 2, 2000);
  assert.equal($('pvApp').querySelectorAll('tbody tr').length, 2, '나눠 저장할 모양 미리보기');
  $('bOk').click();
  await until(() => $('dCode').textContent === 'PFF002');
  assert.equal((await one(`SELECT app FROM products WHERE id=$1`, [a.id])).app, 'NISSAN Tsuru 1992-2017 // NISSAN Sentra 1991-1994');
  assert.equal($('dCode').textContent, 'PFF002', '확인 후 다음 부품 자동');
  assert.match($('toast').textContent, /PFF001 확인완료 · 1칸 ERP 반영/);
  assert.match([...$('rows').querySelectorAll('tr[data-i]')][0].textContent, /확인완료/);

  // ③ 수정안 저장 → ERP 현장 수정 → 확인완료 409 → ERP 값 고르기 → 확인완료
  $('e_name').value = 'HORQUILLA INF. DER.'; $('e_name').dispatchEvent(new w.Event('input'));
  $('bSave').click();
  await until(() => /임시저장/.test($('dMsg').textContent));
  assert.match($('dMsg').textContent, /임시저장 · 1칸/);
  assert.equal((await one(`SELECT name FROM products WHERE id=$1`, [b.id])).name, 'HORQUILLA INFERIOR', '임시저장은 ERP 를 바꾸지 않는다');
  const pr = await app.inject({ method: 'PATCH', url: `/api/products/${b.id}`, headers: D, payload: { name: 'HORQUILLA INF. IZQ.' } });
  assert.equal(pr.statusCode, 200);
  $('bOk').click();
  await until(() => w.document.querySelector('input[name=r_name]'));
  assert.ok(w.document.querySelector('.cbox'), '고르기 칸');
  assert.match($('dMsg').textContent, /아무것도 반영하지 않았습니다/);
  assert.equal((await one(`SELECT name FROM products WHERE id=$1`, [b.id])).name, 'HORQUILLA INF. IZQ.');
  const pickErp = w.document.querySelector('input[name=r_name][value=erp]');
  pickErp.checked = true; pickErp.dispatchEvent(new w.Event('change'));
  assert.equal($('e_name').value, 'HORQUILLA INF. IZQ.', '고른 값이 편집칸에 들어간다');
  $('goNext').checked = false;
  $('bOk').click();
  await until(() => /PFF002 확인완료/.test($('toast').textContent));
  assert.match($('toast').textContent, /PFF002 확인완료 · 변경 없음/);
  assert.equal((await one(`SELECT name FROM products WHERE id=$1`, [b.id])).name, 'HORQUILLA INF. IZQ.', '현장 값 유지');
  assert.match($('dSt').textContent, /확인완료/);
  // 확인완료 → 잠금: 칸이 막히고 저장 · 확인 버튼이 사라진다
  assert.ok($('dBody').querySelector('.lockb'), '잠금 안내');
  assert.ok($('e_name').disabled && $('e_app').disabled && $('s_name').disabled, '칸 막힘');
  assert.ok($('bOk').classList.contains('hidden') && $('bSave').classList.contains('hidden'), '버튼 숨김');
  assert.match($('rows').textContent, /🔒 확인완료/);
  dom.window.close();

  // ⑤ 엑셀 다운로드 — 위치 거부면 막고, 허용이면 기록 후 파일(카탈로그 · 적용차종 · Info)
  await query(`DELETE FROM pf_catalog_exports`);
  const dom3 = boot(); const w3 = dom3.window; const $3 = (id) => w3.document.getElementById(id);
  await until(() => !$3('app').classList.contains('hidden'));
  fetchCalls.length = 0;
  $3('q').value = 'PFF'; $3('q').dispatchEvent(new w3.Event('input'));
  await until(() => fetchCalls.some((c) => c.u.includes('/items?q=PFF')));   // 검색어가 실제로 걸린 뒤
  await until(() => $3('rows').querySelectorAll('tr[data-i]').length === 3);
  w3.__geoMode = 'denied';
  $3('bXlsx').click();
  await until(() => /위치 권한/.test($3('xMsg').textContent));
  assert.match($3('xMsg').textContent, /위치 권한이 필요합니다/);
  assert.equal(w3.__xlsx.length, 0);
  assert.equal((await one(`SELECT count(*)::int n FROM pf_catalog_exports`)).n, 0, '거부 → 기록 · 데이터 없음');
  w3.__geoMode = 'ok';
  $3('bXlsx').click();
  await until(() => w3.__xlsx.length === 1);
  const file = w3.__xlsx[0];
  assert.match(file.name, /^REFATRIX_Catalogo_\d{8}_\d{4}_\d+\.xlsx$/);
  assert.deepEqual(file.wb.sheets.map((x) => x.n), ['Catalogo', 'Aplicaciones', 'Info']);
  const cat = file.wb.sheets[0].ws.rows;
  assert.deepEqual(cat.map((r) => r['Clave CTR']), ['PFF001', 'PFF002', 'PFF003']);
  assert.ok(!Object.keys(cat[0]).some((k) => /precio|existencia|stock|price/i.test(k)), '가격 · 재고 열 없음');
  assert.equal(cat[0]['Revisión CTR'], 'Confirmado (CTR)');
  assert.ok(file.wb.sheets[1].ws.rows.some((r) => r['Clave CTR'] === 'PFF001' && r.Marca === 'NISSAN' && r['Año desde'] === 1991));
  assert.ok(file.wb.sheets[2].ws.a.some((row) => row[0] === 'Descargado por' && row[1] === 'Park CTR'));
  const exRow = await one(`SELECT pf_user_name, row_count, gps_status, gps_lat, gps_lng, filters FROM pf_catalog_exports ORDER BY id DESC LIMIT 1`);
  assert.equal(exRow.pf_user_name, 'Park CTR'); assert.equal(exRow.row_count, 3); assert.equal(exRow.gps_status, 'ok');
  assert.equal(Number(exRow.gps_lat), 25.6866); assert.equal(exRow.filters.q, 'PFF');
  assert.match($3('xMsg').textContent, /다운로드 3건 · 기록 #\d+/);
  w3.__geoMode = 'timeout';
  $3('bXlsx').click();
  await until(() => w3.__xlsx.length === 2);
  assert.match($3('xMsg').textContent, /IP 위치로 기록/);
  assert.equal((await one(`SELECT gps_status FROM pf_catalog_exports ORDER BY id DESC LIMIT 1`)).gps_status, 'unavailable');
  dom3.window.close();
  await query(`DELETE FROM pf_catalog_exports`);

  // ④ 플랫폼 세션 없음 → 안내 · ERP 호출 없음
  fetchCalls.length = 0;
  const dom2 = boot({ pf: null });
  await tick(300);
  assert.ok(!dom2.window.document.getElementById('gate').classList.contains('hidden'));
  assert.match(dom2.window.document.getElementById('gate').textContent, /로그인한 뒤/);
  assert.equal(fetchCalls.length, 0);
  dom2.window.close();
});
