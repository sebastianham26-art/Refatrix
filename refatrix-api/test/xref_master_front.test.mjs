// =====================================================================
// xref_master_front.test.mjs — 0325 · 화면(jsdom) 검증
//   ① 견적: 엑셀 붙여넣기 파싱(탭 · 머리줄 · 수량 없음 → 1 · 「CODE 4」) · 고른 브랜드로 미리보기 요청 ·
//          CTR 미등록 줄에 브랜드+코드 · 크로스레퍼런스 경로 표시 · 후보 선택 버튼으로 그 줄 교체
//   ② 개발요청: 개발필요내용 「브랜드」 · 「매칭결과」 열 · 자동 검수 팝업(확인 → seen)
//   ③ 제품: 경쟁사 코드로 찾은 제품 표시 · CTR 미등록 안내 · 크로스레퍼런스 업로드(미리보기 → 적용 → 버전 목록) · 최신본 내려받기
//   실행: node --test test/xref_master_front.test.mjs   (jsdom 필요)
// =====================================================================
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
let JSDOM;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const opts = JSDOM ? {} : { skip: 'jsdom 미설치 — skip (npm i -D jsdom)' };
const DOMS = [];
after(() => { DOMS.forEach((d) => { try { d.window.close(); } catch (_) {} }); });
const J = (x) => JSON.parse(JSON.stringify(x));   // jsdom 배열 → 이 쪽 배열(realm 차이)
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, headers: { get: () => null } });

async function boot(file, onFetch) {
  const calls = [];
  const dom = new JSDOM(read(file), {
    runScripts: 'dangerously', url: 'https://example.test/' + file,
    beforeParse(win) {
      win.alert = () => {}; win.confirm = () => true;
      win.fetch = async (url, init) => { const u = String(url); const body = init && init.body ? init.body : null; calls.push({ u, method: (init && init.method) || 'GET', body }); return (await onFetch(u, init, body)) || json({}); };
    },
  });
  DOMS.push(dom);
  await new Promise((r) => dom.window.addEventListener('load', r));
  dom.window.eval(read('refatrix-devmatch.js'));   // 외부 스크립트(src)는 jsdom 이 받지 않으므로 직접 올린다
  dom.window.eval(`session={token:'t',api:'https://api.test',user:{name:'dir',role:'director'}}`);
  dom.calls = calls;
  return dom;
}

test('① 견적 — 붙여넣기 · 브랜드 · 미등록 기록 · 후보 선택', opts, async () => {
  let lastPreview = null;
  const dom = await boot('refatrix-quote.html', async (u, init, body) => {
    if (/\/api\/quotes\/preview/.test(u)) {
      lastPreview = JSON.parse(body);
      const lines = lastPreview.lines.map((l) => {
        if (l.product_id) return { input_code: l.code, matched: true, product_id: l.product_id, ctr_code: 'CTR-' + l.product_id, syd_codes: ['7000001'], product_name: 'X', qty: l.qty, list_price: 100, discount_rate: 0, final_price: 100, line_subtotal: 100 * l.qty, line_total: 116 * l.qty, avail_stock: 9, stock_flag: 'ok', input_brand: l.brand || null };
        if (l.code === 'SU042') return { input_code: 'SU042', matched: true, product_id: 7, ctr_code: 'CB0007', syd_codes: ['7000199'], product_name: 'AMORT', qty: l.qty, list_price: 100, discount_rate: 0, final_price: 100, line_subtotal: 100, line_total: 116, avail_stock: 5, stock_flag: 'ok', input_brand: l.brand, xref: { brand: 'KYB', code: 'SU042', syd: '7000199' } };
        if (l.code === 'G2X') return { input_code: 'G2X', qty: l.qty, ambiguous: true, candidates: [{ product_id: 21, ctr_code: 'CB0021', name: 'A', list_price: 1, xref: { brand: 'KYB', code: 'G2X', syd: '7000002' } }, { product_id: 22, ctr_code: 'CB0022', name: 'B', list_price: 1 }], input_brand: l.brand };
        return { input_code: l.code, qty: l.qty, stock_flag: 'not_found', matched: false, input_brand: l.brand || null };
      });
      return json({ lines, totals: { subtotal: 0, total: 0, totalQty: 0, skuCount: 0 } });
    }
    return json({ items: [] });
  });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  assert.match(w.document.title, /qt-1111xr/);
  // 파싱
  const p = w.parsePaste('Codigo\tCantidad\nSU042\t4\n334368\t\nG2X\nXX-9 3\n\t5\n');
  assert.deepEqual(J(p.items.map((x) => [x.code, x.qty])), [['SU042', 4], ['334368', 1], ['G2X', 1], ['XX-9', 3]]);
  assert.equal(p.headerSkipped, 1); assert.equal(p.noQty, 2);
  const p2 = w.parsePaste('CB0001\tAMORTIGUADOR\t2\nCB0002;7\n');
  assert.deepEqual(J(p2.items.map((x) => [x.code, x.qty])), [['CB0001', 2], ['CB0002', 7]], '설명 칸은 건너뛰고 숫자 칸을 수량으로');
  // 화면 흐름
  $('custSel').innerHTML = '<option value="5" selected>CLIENTE</option>';
  $('inBrand').value = 'KYB';
  $('pasteArea').value = 'SU042\t1\n334368\nG2X\t2\n';
  $('pasteArea').dispatchEvent(new w.Event('input'));
  assert.match($('pasteInfo').textContent, /3줄 인식/);
  $('pasteAdd').click(); await tick(80);
  assert.deepEqual(lastPreview.lines, [{ code: 'SU042', qty: 1, brand: 'KYB' }, { code: '334368', qty: 1, brand: 'KYB' }, { code: 'G2X', qty: 2, brand: 'KYB' }]);
  const wrap = $('linesWrap').innerHTML;
  assert.match(wrap, /KYB SU042 → 7000199/, '크로스레퍼런스 경로');
  assert.match(wrap, /<span class="brbadge">KYB<\/span><br>334368/, '미등록 줄 = 브랜드 + 코드');
  assert.match(wrap, /CTR 미등록 1줄/);
  assert.match($('lineMsg').textContent, /3줄 추가 \(KYB\) — CTR 매칭 1 · 후보 선택 필요 1 · CTR 미등록 1/);
  assert.equal($('pasteArea').value, '');
  // 후보 선택 → 그 줄 교체(브랜드 유지)
  $('linesWrap').querySelector('.pickbtn[data-amb="2"]').click();
  assert.equal($('candModal').style.display, 'flex');
  assert.match($('candBody').innerHTML, /KYB G2X → SYD 7000002/);
  w.pickCand(22, 0); await tick(80);
  assert.deepEqual(J(w.eval('lines')[2]), { code: 'G2X', product_id: 22, qty: 2, brand: 'KYB' });
  assert.equal(w.eval('lines').length, 3, '줄이 늘지 않고 바뀐다');
  // 단건 입력도 브랜드를 보낸다
  $('inBrand').value = 'GROB'; $('inCode').value = 'G4368'; $('inQty').value = '2';
  await w.addLine(); await tick(60);
  assert.ok(dom.calls.some((c) => /resolve-code\?code=G4368&brand=GROB/.test(c.u)));
});

test('② 개발요청 — 브랜드 · 매칭결과 열 · 자동 검수 팝업', opts, async () => {
  const DEMAND = { items: [
    { rank: 1, code: 'SU042', norm: 'SU042', brands: ['BAW'], results: [{ ctr: 'CB0007', via: 'master', auto: true }], candidates: null, category: null, vehicle: null, vio: null, total_qty: 4, customer_count: 1, last_at: '2026-11-10', open_count: 0, developed_count: 1, events: [{ customer: 'A', date: '2026-11-10', qty: 4, source: '견적 Q-1', status: 'developed', brand: 'BAW' }] },
    { rank: 2, code: 'G2X', norm: 'G2X', brands: ['GROB'], results: [], candidates: ['CB0021', 'CB0022'], category: null, vehicle: null, vio: null, total_qty: 1, customer_count: 1, last_at: '2026-11-09', open_count: 1, developed_count: 0, events: [] },
    { rank: 3, code: 'ZZ1', norm: 'ZZ1', brands: [], results: [], candidates: null, category: null, vehicle: null, vio: null, total_qty: 1, customer_count: 1, last_at: '2026-11-08', open_count: 1, developed_count: 0, events: [] }] };
  const AUTO = { ready: true, items: [{ id: 1, input_code: 'SU042', input_brand: 'BAW', ctr_code: 'CB0007', via: 'master', customer_name: 'A', qty: 4, stock_qty: 0, product_name: 'AMORT' }],
    ambiguous: [{ id: 2, input_code: 'G2X', input_brand: 'GROB', candidates: ['CB0021', 'CB0022'] }] };
  const dom = await boot('refatrix-devrequest.html', async (u) => {
    if (/\/demand\?/.test(u)) return json(DEMAND);
    if (/auto-matches\/seen/.test(u)) return json({ ok: true });
    if (/auto-matches/.test(u)) return json(AUTO);
    return json({ items: [] });
  });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  assert.match(w.document.title, /20261111xr/);
  await w.loadDemand(); await tick();
  const th = [...$('dmWrap').querySelectorAll('thead th')].map((x) => x.textContent.replace(/[▲▼]/g, '').trim());
  assert.ok(th.includes('브랜드') && th.includes('매칭결과'), th.join('|'));
  const rows = [...$('dmWrap').querySelector('table > tbody').children].filter((tr) => !tr.classList.contains('dm-ev'));
  assert.match(rows[0].innerHTML, /<span class="brb">BAW<\/span>/);
  assert.match(rows[0].innerHTML, /CB0007 ↗<\/a> <span class="vib master">크로스레퍼런스→SYD<\/span>/);
  assert.match(rows[1].innerHTML, /⚠ 후보: CB0021 \/ CB0022/);
  assert.match(rows[2].innerHTML, /미매칭/);
  assert.equal(rows[0].children.length, 12, '열 수(10 + 진행 + 이력)');
  assert.match(w.document.querySelector('.dm-ev').innerHTML, /<th>브랜드<\/th>/);
  // 팝업
  w.devMatchPopup(0); await tick(60);
  const ov = $('rdmOv');
  assert.ok(ov, '팝업');
  assert.match(ov.innerHTML, /새로 매칭된 코드 1건/);
  assert.match(ov.innerHTML, /BAW<\/span><b>SU042<\/b>/);
  assert.match(ov.innerHTML, /크로스레퍼런스 → SYD/);
  assert.match(ov.innerHTML, /후보가 여러 제품이라 자동 완료하지 않은 1건/);
  assert.equal($('rdmOpen'), null, '개발요청 화면 안에서는 「화면 열기」 없음');
  $('rdmOk').click(); await tick();
  assert.ok(dom.calls.some((c) => /auto-matches\/seen/.test(c.u) && c.method === 'POST'));
  assert.equal($('rdmOv'), null);
  // 새 매칭이 없으면 팝업 없음
  AUTO.items = []; AUTO.ambiguous = [];
  w.devMatchPopup(0); await tick(60);
  assert.equal($('rdmOv'), null);
});

test('③ 제품 — 경쟁사 코드 검색 · 업로드 · 내려받기', opts, async () => {
  const AOA = [['SYD', 'CTR', 'BAW', 'GROB'], ['7000199', null, 'SU042', 'G4368']];
  let uploads = [];
  const dom = await boot('refatrix-products.html', async (u, init, body) => {
    if (/\/api\/products\?q=SU042/.test(u)) return json({ items: [{ id: 7, code: 'CB0007', scode: '7000199', app: 'Honda', stock_qty: 3, sold_qty: 0, is_active: true, xref_hit: { brand: 'BAW', code: 'SU042', syd: '7000199', source: 'master' } }], total: 1,
      xref_unbridged: [{ brand: 'BAW', code: 'SU0420', syd: ['7000888'], descripcion: 'ROTULA', aplicacion: 'Aveo' }] });
    if (/\/api\/products\?q=NOPE1/.test(u)) return json({ items: [], total: 0, xref_unbridged: [{ brand: 'KYB', code: 'NOPE1', syd: [], descripcion: 'BUJE' }] });
    if (/\/api\/products\?/.test(u)) return json({ items: [], total: 0 });
    if (/xref-master\/upload/.test(u)) { const b = JSON.parse(body); uploads.push(b); return json(b.dry_run ? { dry_run: true, filename: b.filename, rows: 1, codes: 3, brand_counts: { SYD: 1, BAW: 1, GROB: 1 }, bridged_rows: 1, unbridged_rows: 0, no_syd_rows: 0 } : { ok: true, version_id: 3, filename: b.filename, rows: 1, codes: 3, brand_counts: { SYD: 1 }, bridged_rows: 1, unbridged_rows: 0, dev_match: { checked: 4, matched: 0, ambiguous: 0 } }); }
    if (/xref-master\/versions$/.test(u)) return json({ ready: true, items: [{ id: 3, filename: 'mexico_cross_reference_261111.xlsx', file_size: 883534, rows: 9490, codes: 36385, bridged_rows: 640, is_active: true, uploaded_at: '2026-11-11T15:00:00Z', uploaded_by: 'Sebastian', has_file: true }, { id: 2, filename: 'old.xlsx', rows: 10, codes: 20, is_active: false, has_file: false, uploaded_at: '2026-10-01T00:00:00Z' }] });
    if (/xref-master\/latest\/file/.test(u)) return { ok: true, status: 200, blob: async () => new w.Blob(['x']), headers: { get: (h) => (h === 'X-Filename' ? encodeURIComponent('mexico_cross_reference_261111.xlsx') : null) } };
    if (/auto-matches/.test(u)) return json({ ready: true, items: [], ambiguous: [] });
    return json({ items: [] });
  });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  assert.match(w.document.title, /ps-1111xr/);
  $('q').value = 'SU042'; w.doSearch(); await tick(80);
  const r = $('result').innerHTML;
  assert.match(r, /⇄ BAW SU042 → 7000199/, '경쟁사 칸에 찾은 경로');
  assert.match(r, /크로스레퍼런스 마스터에는 있지만 ERP CTR 로 이어지지 않는 코드/);
  assert.match(r, /BAW SU0420<\/b> → SYD 7000888/);
  $('q').value = 'NOPE1'; w.doSearch(); await tick(80);
  assert.match($('result').innerHTML, /KYB NOPE1<\/b> \(SYD 없음\)/);
  assert.match($('result').innerHTML, /일치하는 제품이 없습니다/);
  // 업로드: 미리보기 → 적용 → 버전 목록
  w.XLSX = { read: () => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } }), utils: { sheet_to_json: () => AOA } };
  await w.xmReadFile({ name: 'mexico_cross_reference_261111.xlsx', arrayBuffer: async () => new Uint8Array([80, 75, 3, 4]).buffer });
  assert.equal(uploads[0].dry_run, true); assert.deepEqual(uploads[0].aoa, AOA);
  assert.match($('xmMsg').innerHTML, /미리보기 \[Sheet1\]/);
  assert.equal($('xmApply').disabled, false);
  await w.xmApply(); await tick(60);
  assert.equal(uploads[1].dry_run, undefined); assert.equal(uploads[1].file_b64, 'UEsDBA==', '원본 파일 base64');
  assert.match($('xmMsg').innerHTML, /버전 #3 적용/);
  assert.match($('xmMsg').innerHTML, /새로 매칭 0건/);
  const vb = $('xmVerBox').innerHTML;
  assert.match(vb, /사용 중/); assert.match(vb, /9,490/); assert.match(vb, /원본 정리됨/);
  assert.equal($('xmVerBox').querySelectorAll('.xmDl').length, 1);
  // 최신본 내려받기
  let clicked = null;
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
  const origClick = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = function () { clicked = this.download; };
  $('dlXrefLatest').click(); await tick(60);
  w.HTMLAnchorElement.prototype.click = origClick;
  assert.equal(clicked, 'mexico_cross_reference_261111.xlsx');
});
