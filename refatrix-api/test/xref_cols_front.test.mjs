// =====================================================================
// xref_cols_front.test.mjs — 0325b · 견적 엑셀 「경쟁사 코드 열」 (jsdom + SheetJS)
//   ① 견적 작성 › 엑셀 다운로드: 체크한 브랜드(BAW · KYB)만 Referencia OE 뒤에 열 · 미등록 줄은 입력 브랜드 칸에 입력 코드
//   ② 전체 가격표: Q 뒤 R · S 열 — 수량·금액 수식(N · O) 위치 그대로
//   ③ Top 500 / 전체 견적 시트(vioSheet): 숨김 O 뒤 P 열부터 · 금액 수식 그대로
//   ④ 체크 없음 → 서버 호출 없이 종전 그대로
//   ⑤ 견적 목록 › 상세 › 📥 엑셀(재고분): Aplicación 뒤 · 단가×수량 수식 열 이름 그대로
//   실행: node --test test/xref_cols_front.test.mjs   (jsdom · xlsx 필요)
// =====================================================================
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
let JSDOM, XLSX;
try { ({ JSDOM } = await import('jsdom')); XLSX = (await import('xlsx')).default || (await import('xlsx')); } catch { /* skip */ }
const opts = JSDOM && XLSX ? {} : { skip: 'jsdom · xlsx 미설치 — skip' };
const DOMS = [];
after(() => { DOMS.forEach((d) => { try { d.window.close(); } catch (_) {} }); });
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const json = (o) => ({ ok: true, status: 200, json: async () => o });
const ITEMS = { CB0007: { BAW: ['SU042'], KYB: ['334368', '334369'] }, CB0008: { BAW: ['SU001'] } };

async function boot(file, extra) {
  const calls = [], books = [];
  const dom = new JSDOM(read(file), {
    runScripts: 'dangerously', url: 'https://example.test/' + file,
    beforeParse(win) {
      win.alert = () => {}; win.confirm = () => true;
      win.fetch = async (url, init) => {
        const u = String(url); calls.push({ u, body: init && init.body });
        if (/codes-for/.test(u)) { const b = JSON.parse(init.body); const it = {}; for (const c of b.codes) if (ITEMS[c]) { it[c] = {}; for (const br of b.brands) if (ITEMS[c][br]) it[c][br] = ITEMS[c][br]; } return json({ ready: true, brands: b.brands, items: it }); }
        const r = extra && (await extra(u, init)); if (r) return r;
        return json({ items: [] });
      };
    },
  });
  DOMS.push(dom);
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window;
  w.localStorage.removeItem('rfx_xref_cols');
  w.eval(read('refatrix-xrefcols.js'));
  w.eval(`session={token:'t',api:'https://api.test',user:{name:'dir',role:'director'}}`);
  const X = Object.assign({}, XLSX, { utils: XLSX.utils, writeFile: (wb, name) => { books.push({ wb, name }); } });
  w.XLSX = X;
  dom.calls = calls; dom.books = books;
  return dom;
}
const cell = (ws, ref) => (ws[ref] ? ws[ref].v : undefined);
const check = (w, root, brands) => { root.querySelectorAll('input[data-xb]').forEach((i) => { i.checked = brands.includes(i.getAttribute('data-xb')); i.dispatchEvent(new w.Event('change')); }); };

test('① ~ ④ 견적 작성 — 엑셀 다운로드 · 전체 가격표 · Top500 시트', opts, async () => {
  const dom = await boot('refatrix-quote.html', async (u) => {
    if (/price-list/.test(u)) return json({ discountRate: 10, items: [
      { ctr_code: 'CB0007', syd_codes: '7000199', name: 'AMORT', app: 'Honda', list_price: 100, stock_qty: 3 },
      { ctr_code: 'CB0009', syd_codes: '', name: 'X', app: '', list_price: 50, stock_qty: 0 }] });
    return null;
  });
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  assert.match(w.document.title, /qt-1111kb/);
  w.RefXrefCols.picker($('xrefColPick'));
  assert.equal($('xrefColPick').querySelectorAll('input[data-xb]').length, 5, 'BAW · GROB · VAZLO · KYB · MOOG');
  // ④ 체크 없음 → 종전 그대로
  w.eval(`lastPreview={lines:[{matched:true,ctr_code:'CB0007',syd_codes:['7000199'],product_name:'AMORT',qty:2,list_price:100,discount_rate:0,final_price:100,line_iva:32,line_total:232,avail_stock:3,stock_flag:'ok'}],totals:{totalQty:2,total:232,iva:32,subtotal:200,skuCount:1}}`);
  await w.exportExcel();
  let ws = dom.books.at(-1).wb.Sheets.Cotizacion;
  assert.equal(cell(ws, 'M4'), undefined);
  assert.ok(!dom.calls.some((c) => /codes-for/.test(c.u)), '서버 호출 없음');
  // ① BAW · KYB
  check(w, $('xrefColPick'), ['KYB', 'BAW']);
  assert.equal(w.localStorage.getItem('rfx_xref_cols'), '["BAW","KYB"]', '브랜드 순서대로 기억');
  w.eval(`lastPreview={lines:[
    {matched:true,ctr_code:'CB0007',syd_codes:['7000199'],product_name:'AMORT',qty:2,list_price:100,discount_rate:0,final_price:100,line_iva:32,line_total:232,avail_stock:3,stock_flag:'ok',oe_ref:'OE-1'},
    {ambiguous:true,input_code:'G2X',qty:1},
    {matched:false,input_code:'999111',input_brand:'KYB',qty:1,stock_flag:'not_found'},
    {matched:true,ctr_code:'CB0009',syd_codes:[],product_name:'X',qty:1,list_price:50,discount_rate:0,final_price:50,line_iva:8,line_total:58,avail_stock:0,stock_flag:'low_stock'}],totals:{}}`);
  await w.exportExcel();
  ws = dom.books.at(-1).wb.Sheets.Cotizacion;
  assert.deepEqual([cell(ws, 'L4'), cell(ws, 'M4'), cell(ws, 'N4')], ['Referencia OE', 'Código BAW', 'Código KYB']);
  assert.deepEqual([cell(ws, 'A5'), cell(ws, 'L5'), cell(ws, 'M5'), cell(ws, 'N5')], ['CB0007', 'OE-1', 'SU042', '334368 / 334369']);
  assert.equal(cell(ws, 'C6'), '(múltiples coincidencias)'); assert.equal(cell(ws, 'M6'), undefined);
  assert.deepEqual([cell(ws, 'M7') || '', cell(ws, 'N7')], ['', '999111'], '미등록 줄 = 입력 브랜드 칸에 입력 코드');
  assert.deepEqual([cell(ws, 'A8'), cell(ws, 'M8') || '', cell(ws, 'N8') || ''], ['CB0009', '', '']);
  const req = JSON.parse(dom.calls.filter((c) => /codes-for/.test(c.u)).at(-1).body);
  assert.deepEqual(req.brands, ['BAW', 'KYB']);
  assert.deepEqual(req.codes, ['CB0007', 'CB0009'], '매칭된 CTR 만 · 중복 없음');

  // ② 전체 가격표
  $('custSel').innerHTML = '<option value="5" selected>CLIENTE</option>';
  await w.downloadPriceList(); await tick();
  ws = dom.books.at(-1).wb.Sheets.Lista;
  assert.deepEqual([cell(ws, 'Q5'), cell(ws, 'R5'), cell(ws, 'S5')], ['Referencia OE', 'Código BAW', 'Código KYB']);
  assert.deepEqual([cell(ws, 'B6'), cell(ws, 'R6'), cell(ws, 'S6')], ['CB0007', 'SU042', '334368 / 334369']);
  assert.equal(ws.N6.f, 'SUM(I6:M6)'); assert.equal(ws.O6.f, 'H6*N6', '수식 위치 그대로');
  assert.equal(cell(ws, 'R7') || '', '');

  // ③ Top 500 / 전체 견적 시트
  const xc = await w.RefXrefCols.load('https://api.test', 't', ['CB0007']);
  const P = [{ label: 'Honda Accord', vio: 1000, isRep: true, isDup: false, region: 'AS', it: { ctr_code: 'CB0007', syd_codes: '7000199', name: 'AMORT', app: 'Honda', list_price: 100, stock_qty: 3 } }];
  ws = w.vioSheet(P, { all: false, custName: 'X', rateFrac: 0.1, fechaStr: '11/11/2026', scope: null, xc });
  assert.deepEqual([cell(ws, 'O8'), cell(ws, 'P8'), cell(ws, 'Q8')], ['Principal (1=suma)', 'Código BAW', 'Código KYB']);
  assert.deepEqual([cell(ws, 'C9'), cell(ws, 'P9'), cell(ws, 'Q9')], ['CB0007', 'SU042', '334368 / 334369']);
  assert.equal(ws.N9.f, 'M9*K9'); assert.equal(ws['!cols'][15].wch, 18);
  // xc 없으면 종전
  ws = w.vioSheet(P, { all: false, custName: 'X', rateFrac: 0, fechaStr: '', scope: null });
  assert.equal(cell(ws, 'P8'), undefined);
});

test('⑤ 견적 목록 › 상세 › 엑셀(재고분)', opts, async () => {
  const dom = await boot('refatrix-quotelist.html');
  const w = dom.window, $ = (id) => w.document.getElementById(id);
  assert.match(w.document.title, /ql-1111xc/);
  const host = w.document.createElement('span'); host.id = 'dtXcPick'; w.document.body.appendChild(host);
  w.RefXrefCols.picker(host);
  check(w, host, ['GROB', 'BAW']);
  w.eval(`dtData={quote:{id:7,quote_no:'Q-2026-0700',status:'draft',party_name:'CLIENTE',quote_date:'2026-11-11'},lines:[
    {ctr_code:'CB0007',syd_codes:'7000199',product_name:'AMORT',app_text:'Honda',qty:2,final_price:100,live_avail:5},
    {ctr_code:'CB0008',syd_codes:'',product_name:'BUJE',app_text:'',qty:1,final_price:50,live_avail:1}]}`);
  await w.downloadStockExcel(); await tick();
  const ws = dom.books.at(-1).wb.Sheets['Cotización'];
  const head = []; for (let c = 0; c < 14; c++) head.push(cell(ws, XLSX.utils.encode_col(c) + '6'));
  const iApp = head.indexOf('Aplicación');
  assert.deepEqual(head.slice(iApp, iApp + 3), ['Aplicación', 'Código BAW', 'Código GROB']);
  const col = (h) => XLSX.utils.encode_col(head.indexOf(h));
  const r1 = [7, 8].map((r) => cell(ws, col('Clave CTR') + r));
  const iBaw = r1.indexOf('CB0007') + 7;
  assert.equal(cell(ws, col('Código BAW') + iBaw), 'SU042');
  assert.equal(cell(ws, col('Código GROB') + iBaw) || '', '');
  assert.equal(ws[col('Importe (sin IVA)') + iBaw].f, col('Precio unit. (sin IVA)') + iBaw + '*' + col('Cantidad') + iBaw, '수식이 새 열에 밀리지 않음');
});
