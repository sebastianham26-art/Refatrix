// jsdom: 견적 작성 「🧰 Kit 보기 — 전체 / Kit만 / Kit 제외」 (qt-1103kitq · 2026-11-02)
//   · 자동완성: kit 파라미터 전달 · Kit만은 빈 칸에서도 목록 · 키트 줄에 구성품 제품명
//   · 전체 가격표 / 전체 견적: kit 파라미터 · Producto 칸 = 구성품 제품명(줄바꿈 · 행 높이) · 파일명 태그
//   · 구버전 서버(kit 무시)여도 화면에서 한 번 더 거른다 · 선택은 브라우저에 기억
// 실행: QUOTE_HTML=../refatrix-quote.html node --test test/quote_kit_filter_front.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XS = require('xlsx-js-style');
const HTML = fs.readFileSync(process.env.QUOTE_HTML || path.resolve('..', 'refatrix-quote.html'), 'utf8')
  .replace(/<script src="[^"]+"><\/script>/g, '');

const KIT = { ctr_code: 'K0009', name: 'KIT T VERSA 2012-2019_CB1x2_CE2', syd_codes: '', app: 'NISSAN Versa 2012-2019', list_price: 500, stock_qty: 3,
  is_kit: true, kit_no: 'K0009', kit_items: [{ ctr_code: 'CB1', qty: 2, name: 'ROTULA INFERIOR' }, { ctr_code: 'CE2', qty: 1, name: 'TERMINAL EXTERIOR' }],
  kit_desc: 'ROTULA INFERIOR ×2\nTERMINAL EXTERIOR' };
const PART = { ctr_code: 'CB1', name: 'ROTULA INFERIOR', syd_codes: '1', app: 'NISSAN Versa 2012-2019', list_price: 100, stock_qty: 5 };
const KXA = { ctr_code: 'KXA-100', name: 'K 글자 코드(키트 아님)', syd_codes: '', app: '', list_price: 10, stock_qty: 1 };
const AC_KIT = { product_id: 9, ctr_code: 'K0009', name: KIT.name, app: '', list_price: 500, syd_codes: [], is_active: true, is_kit: true,
  kit: { promo_no: 'K0009', items: [{ product_id: 1, ctr_code: 'CB1', qty: 2, name: 'ROTULA INFERIOR' }, { product_id: 2, ctr_code: 'CE2', qty: 1, name: 'TERMINAL EXTERIOR' }] },
  kit_desc: 'ROTULA INFERIOR ×2 · TERMINAL EXTERIOR' };
const AC_PART = { product_id: 1, ctr_code: 'CB1', name: 'ROTULA INFERIOR', app: 'Versa', list_price: 100, syd_codes: [], is_active: true, kit: null, is_kit: false };

async function boot(store = {}) {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quote.html', pretendToBeVisual: true,
    beforeParse(win) { for (const [k, v] of Object.entries(store)) win.localStorage.setItem(k, v); },
  });
  const w = dom.window;
  const calls = [];
  w.fetch = async (u) => {
    u = String(u); calls.push(u);
    // 구버전 서버 흉내: kit 파라미터를 무시하고 섞어서 준다 → 화면이 걸러야 한다
    if (u.includes('/api/quotes/price-list')) return { ok: true, json: async () => ({ items: [KIT, PART, KXA], discountRate: 10 }) };
    if (u.includes('/api/quotes/search-code')) return { ok: true, json: async () => ({ items: [AC_KIT, AC_PART] }) };
    return { ok: true, json: async () => ({}), text: async () => '' };
  };
  w.alert = () => {};
  await new Promise((r) => setTimeout(r, 30));
  const files = [];
  w.XLSX = Object.assign({}, XS, { writeFile: (wb, name) => { files.push({ name, raw: wb, wb: XS.read(XS.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellStyles: true }) }); } });
  w.eval("session={token:'t',api:'https://api.test',user:{name:'d',role:'director'}}");
  const $ = (id) => w.document.getElementById(id);
  const mode = (v) => { const r = w.document.querySelector(`input[name=kitMode][value=${v}]`); r.checked = true; r.dispatchEvent(new w.Event('change')); };
  const guest = () => { $('custSel').innerHTML = '<option value="">—</option><option value="__guest__">g</option>'; $('custSel').value = '__guest__'; w.eval('onCustChange()'); $('guestName').value = 'Taller'; };
  return { w, $, calls, files, mode, guest };
}
const tick = (ms = 260) => new Promise((r) => setTimeout(r, ms));
const rowsOf = (ws, col, from) => { const out = []; for (let r = from; ws['B' + r] || ws['C' + r]; r++) out.push(ws[col + r] ? ws[col + r].v : ''); return out; };

test('① 선택 UI · 기본 전체 · 바꾸면 on 표시와 기억(localStorage)', async () => {
  const { w, $, mode } = await boot();
  const labs = [...w.document.querySelectorAll('#kitSeg label')].map((x) => x.textContent.trim());
  assert.deepEqual(labs, ['전체', 'Kit만', 'Kit 제외']);
  assert.equal(w.eval('kitMode()'), 'all');
  mode('excl');
  assert.equal(w.eval('kitMode()'), 'excl');
  assert.ok(w.document.querySelector('input[value=excl]').parentNode.classList.contains('on'));
  assert.ok(!w.document.querySelector('input[value=all]').parentNode.classList.contains('on'));
  assert.equal(w.localStorage.getItem('rfx_quote_kitmode'), 'excl');
  assert.match(w.document.title, /qt-1103kitq/);
});

test('② 기억된 선택(only)으로 시작', async () => {
  const { w } = await boot({ rfx_quote_kitmode: 'only' });
  assert.equal(w.eval('kitMode()'), 'only');
  assert.ok(w.document.querySelector('input[value=only]').checked);
});

test('③ 자동완성 Kit만 — 빈 칸에서도 목록 · kit=only 전달 · 구성품 제품명 · 일반 SKU 숨김', async () => {
  const { w, $, calls, mode } = await boot();
  mode('only'); await tick();
  const u = calls.find((x) => x.includes('search-code'));
  assert.ok(u && u.includes('q=&') && u.includes('kit=only'), u);
  const box = $('acBox');
  assert.ok(!box.classList.contains('hidden'));
  const items = [...box.querySelectorAll('.acitem')];
  assert.equal(items.length, 1, '일반 SKU(CB1)는 화면에서 걸러짐');
  assert.match(items[0].textContent, /K0009/);
  assert.equal(items[0].querySelector('.kitcomp').textContent, 'ROTULA INFERIOR ×2 · TERMINAL EXTERIOR');
  // 포커스만 해도(빈 칸) 다시 목록
  $('acBox').classList.add('hidden'); calls.length = 0;
  $('inCode').dispatchEvent(new w.Event('focus')); await tick();
  assert.ok(calls.some((x) => x.includes('kit=only')));
});

test('④ 자동완성 Kit 제외 — kit=excl · 키트 숨김 · 빈 칸은 조회 안 함', async () => {
  const { w, $, calls, mode } = await boot();
  mode('excl'); await tick();
  assert.equal(calls.filter((x) => x.includes('search-code')).length, 0);
  $('inCode').value = 'C'; w.eval('onCodeInput()'); await tick();
  const u = calls.find((x) => x.includes('search-code'));
  assert.ok(u.includes('kit=excl'), u);
  const txt = [...$('acBox').querySelectorAll('.acitem')].map((x) => x.textContent).join('|');
  assert.ok(!/K0009/.test(txt) && /CB1/.test(txt), txt);
});

test('⑤ 자동완성 전체 — kit 파라미터 없음 · 키트·부품 둘 다', async () => {
  const { w, $, calls } = await boot();
  $('inCode').value = 'K'; w.eval('onCodeInput()'); await tick();
  const u = calls.find((x) => x.includes('search-code'));
  assert.ok(!u.includes('kit='), u);
  assert.equal($('acBox').querySelectorAll('.acitem').length, 2);
});

test('⑥ 전체 가격표 Kit만 — kit=only · 키트만 · Producto 구성품 줄바꿈 · 행 높이 · 파일명', async () => {
  const { w, $, calls, files, mode, guest } = await boot();
  guest(); mode('only');
  await w.eval('downloadPriceList()'); await tick(120);
  assert.ok(calls.some((x) => x.includes('/api/quotes/price-list?') && x.includes('kit=only')));
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^lista_precios_kits_Taller/);
  const ws = files[0].wb.Sheets.Lista;
  assert.deepEqual(rowsOf(ws, 'B', 6), ['K0009']);
  assert.equal(ws.D6.v, 'ROTULA INFERIOR ×2\nTERMINAL EXTERIOR');
  const raw = files[0].raw.Sheets.Lista;   // 스타일은 쓰기 전 시트로 확인(읽기 왕복은 alignment 를 버린다)
  assert.equal(raw.D6.s.alignment.wrapText, true);
  assert.equal(raw['!rows'][5].hpt, 30);   // 2줄
  assert.match($('lineMsg').textContent, /Kit만.*Kit 1개는 Producto에 구성품 제품명/);
});

test('⑦ 전체 가격표 Kit 제외 — 키트 빠지고 KXA-(K+글자)는 남음 · 제품명 그대로', async () => {
  const { w, files, mode, guest } = await boot();
  guest(); mode('excl');
  await w.eval('downloadPriceList()'); await tick(120);
  const ws = files[0].wb.Sheets.Lista;
  assert.deepEqual(rowsOf(ws, 'B', 6), ['CB1', 'KXA-100']);
  assert.equal(ws.D6.v, 'ROTULA INFERIOR');
  assert.match(files[0].name, /^lista_precios_sin_kits_/);
});

test('⑧ 전체 가격표 전체 — 키트는 구성품, 부품은 제품명 · 파일명 태그 없음', async () => {
  const { w, files, guest } = await boot();
  guest();
  await w.eval('downloadPriceList()'); await tick(120);
  const ws = files[0].wb.Sheets.Lista;
  assert.deepEqual(rowsOf(ws, 'B', 6), ['K0009', 'CB1', 'KXA-100']);
  assert.equal(ws.D6.v, 'ROTULA INFERIOR ×2\nTERMINAL EXTERIOR');
  assert.equal(ws.D7.v, 'ROTULA INFERIOR');
  assert.match(files[0].name, /^lista_precios_Taller/);
});

test('⑨ 전체 견적(지역 선택) Kit만 — kit=only · Producto(E) 구성품 · 파일명 kits_', async () => {
  const { w, $, calls, files, mode, guest } = await boot();
  guest(); mode('only');
  await w.eval('downloadAllQuote()'); await tick(120);
  assert.ok(calls.some((x) => x.includes('price-list?all=1') && x.includes('kit=only')));
  w.document.querySelectorAll('#rgList input[type=checkbox]').forEach((x) => { if (!x.disabled) x.checked = true; });
  w.eval('rgRefresh()');
  $('rgGo').click(); await tick(200);
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^cotizacion_completa_kits_/);
  const wb = files[0].raw; const all = [];
  for (const sn of wb.SheetNames) { const ws = wb.Sheets[sn]; for (let r = 9; ws['C' + r]; r++) all.push([ws['C' + r].v, ws['E' + r].v, ws['E' + r].s && ws['E' + r].s.alignment && ws['E' + r].s.alignment.wrapText]); }
  assert.ok(all.length >= 1 && all.every((x) => x[0] === 'K0009'), JSON.stringify(all));
  assert.equal(all[0][1], 'ROTULA INFERIOR ×2\nTERMINAL EXTERIOR');
  assert.equal(all[0][2], true);
  assert.match($('lineMsg').textContent, /Kit만/);
});
