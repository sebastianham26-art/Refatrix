// =====================================================================
// 0228 · OE 순정번호 — 화면 (jsdom)  refatrix-products.html oe-0923a · refatrix-quote.html qt-0923oe
//   운영 HTML 을 그대로 로드하고 fetch 만 스텁한다. SheetJS 는 실제 xlsx 0.18.5 를 창에 넣는다.
//   실행: node --test test/product_oe_front.test.mjs   (jsdom · xlsx 필요)
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const P_HTML = resolve(here, '..', '..', 'refatrix-products.html');
const Q_HTML = resolve(here, '..', '..', 'refatrix-quote.html');
const require = createRequire(import.meta.url);
let JSDOM = null, XLSX = null;
try { ({ JSDOM } = await import('jsdom')); XLSX = require('xlsx'); } catch { /* 미설치 → skip */ }
const SKIP = !JSDOM || !XLSX || !existsSync(P_HTML) || !existsSync(Q_HTML);
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const $ = (d, id) => d.getElementById(id);
const FOR_NOTE = '해당 OE번호 부품의 조립품에 해당하는 OE부품입니다';

function xlsxSpy() {
  const written = [];
  const X = Object.assign({}, XLSX, { writeFile: (wb, name) => { written.push({ wb, name }); } });
  return { X, written };
}

async function bootProducts(routes = {}, opts = {}) {
  const calls = []; const confirms = []; const spy = xlsxSpy();
  const dom = new JSDOM(readFileSync(P_HTML, 'utf-8'), {
    runScripts: 'dangerously',
    url: 'https://example.test/refatrix-products.html#tab=' + (opts.tab || 'search'),
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'D', role: 'director' } }));
      w.alert = () => {}; w.confirm = (m) => { confirms.push(String(m)); return opts.confirm !== false; };
      w.XLSX = spy.X;
      w.fetch = async (url, o = {}) => {
        const u = String(url); const body = o.body ? JSON.parse(o.body) : null;
        calls.push({ url: u, method: o.method || 'GET', body });
        const json = (d, ok = true, status = 200) => ({ ok, status, json: async () => d });
        for (const [re, fn] of Object.entries(routes)) if (new RegExp(re).test(u)) return json(typeof fn === 'function' ? fn(u, o, body) : fn);
        return json({ items: [], total: 0 });
      };
    },
  });
  const w = dom.window;
  // 바깥에서 SheetJS 를 덮어쓴다(CDN 스크립트는 jsdom 에서 받지 않는다)
  Object.defineProperty(w, 'XLSX', { value: spy.X, writable: true });
  await new Promise((r) => { if (w.document.readyState === 'complete') r(); else w.addEventListener('load', r); });
  await tick(100);
  return { w, d: w.document, calls, confirms, written: spy.written };
}

const LIST = { items: [
  { id: 1, code: 'CQ0728R', name: 'HORQUILLA', scode: '54500-8H310', app: 'NISSAN X-Trail 2002-2007', stock_qty: 5, is_active: true,
    oe: '54500-8H310 // 54500-8H31A // FOR 40160-8H300 // 48530-3S125 (SYD)' },
  { id: 2, code: 'PRO001', name: 'GORRA', scode: null, app: null, stock_qty: 3, is_active: true, oe: null },
], total: 2 };
const DRILL = { product: { id: 1, code: 'CQ0728R', name: 'HORQUILLA', stock_qty: 5, is_active: true },
  sales: [], total_sold: 0, customer_count: 0, can_manage_status: false,
  oe: [{ code: '54500-8H310', rel: 'oe', source: 'master' }, { code: '48530-3S125', rel: 'oe', source: 'syd' },
       { code: '40160-8H300', rel: 'for', source: 'master' }], oe_for_note: FOR_NOTE };

test('제품 화면 — OE (jsdom)', { skip: SKIP }, async (t) => {
  await t.test('① 목록 칸에 OE 한 줄 + 개수, 검색어에 걸린 OE 가 먼저', async () => {
    const c = await bootProducts({ '/api/products\\?': LIST });
    c.d.getElementById('q').value = '8H31A'; c.w.doSearch(); await tick(120);
    const line = c.d.querySelector('.prow[data-code="CQ0728R"] .oeline');
    assert.ok(line, 'OE 줄'); assert.match(line.textContent, /OE 54500-8H31A \+3/);
    assert.doesNotMatch(line.textContent, /\(SYD\)/, '내부 표식은 목록에 안 보인다');
    assert.equal(c.d.querySelector('.prow[data-code="PRO001"] .oeline'), null, 'OE 없는 제품(PRO)은 줄 없음');
    assert.match(c.d.querySelector('th[title*="OE"]').textContent, /OE/);
  });
  await t.test('② 드릴다운 — 직접 OE · SYD 출처 배지 · FOR 칩 + 부연설명', async () => {
    const c = await bootProducts({ '/api/products/\\d+/drilldown': DRILL, '/api/products\\?': LIST });
    c.d.getElementById('q').value = 'CQ0728R'; c.w.doSearch(); await tick(120);
    c.d.querySelector('.prow[data-code="CQ0728R"]').dispatchEvent(new c.w.Event('click')); await tick(120);
    const chips = [...c.d.querySelectorAll('.oesec .oe')];
    assert.equal(chips.length, 3);
    assert.equal(chips[2].classList.contains('for'), true); assert.match(chips[2].textContent, /^FOR 40160-8H300/);
    assert.equal(chips[2].getAttribute('title'), FOR_NOTE);
    assert.match(chips[1].querySelector('.src').textContent, /SYD/);
    assert.match(c.d.querySelector('.oesec .oenote').textContent, new RegExp(FOR_NOTE));
  });
  await t.test('③ 수정 모달 — OE 칸 채움 · 저장 본문에 oe · 참조 신규는 OE 복사(D4)', async () => {
    const master = { id: 1, code: 'CQ0728R', name: 'HORQUILLA', scode: '54500-8H310', app: 'X', oe: '54500-8H310 // FOR 40160-8H300', stock_qty: 5 };
    const c = await bootProducts({ '/api/products/\\d+/master': master, '/api/products/changelog': { items: [] },
      '/api/products/1$': { ok: true, changed: ['oe'] }, '/api/products\\?': LIST }, { tab: 'upload' });
    c.w.openProductEditor(1); await tick(80);
    assert.equal($(c.d, 'pe_oe').value, '54500-8H310 // FOR 40160-8H300');
    $(c.d, 'pe_oe').value = '54500-8H310';
    $(c.d, 'peSave').dispatchEvent(new c.w.Event('click')); await tick(80);
    const patch = c.calls.find((x) => x.method === 'PATCH');
    assert.equal(patch.body.oe, '54500-8H310');
    c.w.peClose && c.w.peClose();
    c.w.openProductEditor(null, 1); await tick(40);
    await c.w.peApplyRef(1); await tick(60);
    assert.equal($(c.d, 'pe_oe').value, '54500-8H310 // FOR 40160-8H300', 'D4 — 참조 신규는 OE 도 복사');
    assert.ok($(c.d, 'pe_oe').classList.contains('reffill'), '노란 칸(참조 그대로) 표시');
    assert.equal($(c.d, 'pe_code').value, '', '코드는 여전히 비움');
  });
  await t.test('④ 업로드 미리보기 — 없는 열 안내 · OE 요약 · 전부 지워짐 경고 → 반영 전 확인', async () => {
    const pv = { total: 2, new_items: [], updated: [{ code: 'A', name: 'N', changes: { oe: { from: 'X', to: null } }, oe_changed: true, oe_from: ['X-1'], oe_to: [] }],
      unchanged: 1, errors: [], duplicates: [], oe_products: 1, oe_added_codes: 0, oe_cleared: ['A'],
      oe_column: true, oe_ready: true, oe_collisions: { count: 1, items: [{ code: 'A', oe: 'X-1', kind: 'syd', other: 'B' }] },
      columns_absent: ['name', 'scode', 'app'] };
    const c = await bootProducts({ '/api/products/import/preview': pv, '/api/products/import/commit': { ok: true, created: 0, updated: 1, unchanged: 1 } },
      { tab: 'upload', confirm: false });
    c.w.parsedPayload = null;
    // handleFile 을 거치지 않고 미리보기만 부른다(파일 파싱은 별도 시험이 있다)
    c.w.eval("parsedPayload={header:['Clave CTR','OE'],rows:[['A',''],['B','Y-2']]}");
    await c.w.loadPreview(); await tick(40);
    const html = $(c.d, 'pv-detail').innerHTML;
    assert.match(html, /Nombre del producto · Clave SyD · Aplicacion/);
    assert.match(html, /그대로 둡니다/);
    assert.match(html, /OE 가 모두 지워지는 제품 1개/);
    assert.match(html, /다른 제품의 CTR·SyD 코드와 같은 OE <b>1<\/b>건/);
    assert.match(html, /OE: <span[^>]*>X-1<\/span> → <b>—<\/b>/);
    assert.doesNotMatch(html, />OE: <span[^>]*>X<\/span>/, 'changes.oe 원문은 중복 표시하지 않는다');
    await c.w.commit(); await tick(40);
    assert.ok(c.confirms.some((m) => /OE 가 모두 지워지는 제품이 1개/.test(m)));
    assert.equal(c.calls.filter((x) => /import\/commit/.test(x.url)).length, 0, '확인에서 취소하면 반영하지 않는다');
  });
  await t.test('⑤ 0228 전 서버 — OE 는 반영되지 않는다는 경고', async () => {
    const pv = { total: 1, new_items: [], updated: [], unchanged: 1, errors: [], duplicates: [], oe_column: true, oe_ready: false, columns_absent: ['scode', 'app'] };
    const c = await bootProducts({ '/api/products/import/preview': pv }, { tab: 'upload' });
    c.w.eval("parsedPayload={header:['Clave CTR','Nombre del producto','OE'],rows:[['A','N','X']]}");
    await c.w.loadPreview(); await tick(40);
    assert.match($(c.d, 'pv-detail').innerHTML, /npm run migrate/);
  });
  await t.test('⑥ 마스터 다운로드 — OE 가 맨 오른쪽 열 · 양식에도 OE', async () => {
    const c = await bootProducts({ '/api/products/master-export': { items: [{ code: 'CQ0728R', name: 'H', scode: 'S', app: 'A', oe: '54500-8H310 // FOR 40160-8H300' }], price_included: false } });
    await c.w.downloadMaster(); await tick(40);
    const ws = c.written[0].wb.Sheets['Plantilla Articulo'];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 });
    assert.equal(aoa[0][aoa[0].length - 1], 'OE');
    assert.equal(aoa[1][aoa[0].length - 1], '54500-8H310 // FOR 40160-8H300');
    assert.ok(c.w.eval('TEMPLATE_COLS').some((x) => x[0] === 'OE' && x[4] === 'oe'));
    assert.ok(c.w.eval('TEMPLATE_COLS').length <= 20, '업로드 파서 상한 20열 이내');
  });
});

// ── 견적 화면 ──
async function bootQuote(routes) {
  const calls = []; const spy = xlsxSpy();
  const dom = new JSDOM(readFileSync(Q_HTML, 'utf-8'), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quote.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'D', role: 'director' } }));
      w.alert = () => {}; w.confirm = () => true; w.prompt = () => '';
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
      w.fetch = async (url, o = {}) => {
        const u = String(url); calls.push({ url: u, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : null });
        const json = (d) => ({ ok: true, status: 200, json: async () => d });
        if (u.includes('/api/customers')) return json({ items: [{ id: 1, code: 'C001', name: 'REFACCIONARIA NORTE', discount: 30 }] });
        for (const [re, v] of Object.entries(routes)) if (new RegExp(re).test(u)) return json(typeof v === 'function' ? v(u) : v);
        return json({ items: [] });
      };
    },
  });
  const w = dom.window;
  Object.defineProperty(w, 'XLSX', { value: spy.X, writable: true });
  await tick(250);
  w.document.getElementById('custSel').value = '1'; w.onCustChange(); await tick(150);
  return { w, d: w.document, calls, written: spy.written };
}

test('견적 화면 — OE (jsdom)', { skip: SKIP }, async (t) => {
  await t.test('⑦ FOR 로만 걸린 1건 — 자동으로 담지 않고 후보창 + 부연설명', async () => {
    const c = await bootQuote({ '/api/quotes/resolve-code': { source: 'oe_for', pick_required: true,
      matches: [{ product_id: 3, ctr_code: 'GV1187', name: 'BUJE', app: 'X-Trail', list_price: 200, matched_by: 'oe_for', oe_codes: [] }] },
      '/api/quotes/preview': { lines: [], totals: {} } });
    c.d.getElementById('inCode').value = '40160-8H300'; c.d.getElementById('inQty').value = '1';
    await c.w.addLine(); await tick(80);
    assert.equal(c.d.getElementById('candModal').style.display, 'flex', '후보창이 뜬다');
    assert.match(c.d.getElementById('candFor').textContent, new RegExp(FOR_NOTE));
    assert.match(c.d.getElementById('candBody').textContent, /FOR \(조립품 OE\)/);
    assert.equal(c.calls.filter((x) => /quotes\/preview/.test(x.url)).length, 0, '줄이 담기지 않았다');
  });
  await t.test('⑧ 직접 OE 1건은 예전처럼 바로 담는다', async () => {
    const c = await bootQuote({ '/api/quotes/resolve-code': { source: 'oe', pick_required: false,
      matches: [{ product_id: 4, ctr_code: 'CB0011', matched_by: 'oe', is_active: true }] },
      '/api/quotes/preview': { lines: [], totals: {} } });
    c.d.getElementById('inCode').value = '68224650AA'; c.d.getElementById('inQty').value = '1';
    await c.w.addLine(); await tick(120);
    assert.notEqual(c.d.getElementById('candModal').style.display, 'flex');
    const pv = c.calls.find((x) => /quotes\/preview/.test(x.url));
    assert.equal(pv.body.lines[0].product_id, 4);
  });
  await t.test('⑨ 자동완성 — 「OE … 로 찾음」 · FOR 는 부연설명 툴팁', async () => {
    const c = await bootQuote({});
    c.w.eval(`acItems=[{product_id:4,ctr_code:'CB0011',name:'RÓTULA',list_price:344,syd_codes:['1006019'],oe_hit:{code:'5085914AB',rel:'oe'}},
                     {product_id:3,ctr_code:'GV1187',name:'BUJE',list_price:200,syd_codes:[],oe_hit:{code:'54500-8H310',rel:'for'}}]; renderAc();`);
    const box = c.d.getElementById('acBox');
    assert.match(box.textContent, /OE 5085914AB 로 찾음/);
    assert.match(box.textContent, /FOR 54500-8H310 로 찾음/);
    assert.ok(box.innerHTML.includes(FOR_NOTE));
  });
  await t.test('⑩ 견적 엑셀(Cotización) — 맨 끝 열 Referencia OE (D2 · 기존 열 위치 불변)', async () => {
    const c = await bootQuote({});
    c.w.eval(`lastPreview={lines:[{matched:true,product_id:4,ctr_code:'CB0011',syd_codes:['1006019'],product_name:'RÓTULA',app_text:'DODGE 200',qty:2,
      list_price:344,discount_rate:30,final_price:240.8,line_iva:77.06,line_total:558.66,avail_stock:46,stock_flag:'ok',oe_ref:'5085914AB / 68224650AA'}],
      totals:{totalQty:2,iva:77.06,total:558.66,skuCount:1,subtotal:481.6}};`);
    c.w.exportExcel(); await tick(40);
    const hit = c.written.find((x) => x.wb.Sheets.Cotizacion);
    assert.ok(hit, '견적 엑셀이 만들어진다');
    const aoa = XLSX.utils.sheet_to_json(hit.wb.Sheets.Cotizacion, { header: 1 });
    const hdr = aoa.find((r) => r[0] === 'CTR');
    assert.deepEqual(hdr.slice(0, 11), ['CTR', 'SYD', 'Producto / Aplicación', 'Cantidad', 'List', 'Desc%', 'P.Unit', 'IVA', 'Total c/IVA', 'Stock', 'Estado']);
    assert.equal(hdr[11], 'Referencia OE');
    const row = aoa[aoa.indexOf(hdr) + 1];
    assert.equal(row[11], '5085914AB / 68224650AA');
  });
  await t.test('⑪ 빌드 토큰', async () => {
    const c = await bootQuote({});
    assert.match(c.d.title, /qt-0923oe/);
  });
});
