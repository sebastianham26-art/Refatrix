// jsdom: 견적 작성 — 키트로 담은 줄 표시 (qt-1104kitc · 2026-11-04)
//   · 줄 표: 키트 첫 줄 앞 KIT 머리줄(번호 · 차종 · 세트 · 구성품 CTR 코드 + 제품명), 구성 줄 Producto 「CTR 제품명」
//   · 견적 엑셀: KIT 머리줄(강조) + 구성 줄 Producto 「[K0009] CB1 ROTULA INFERIOR」 · 일반 줄은 종전 그대로
//   · 견적서 인쇄: KIT 머리줄 + [K0009] CTR 제품명
// 실행: QUOTE_HTML=../refatrix-quote.html node --test test/quote_kit_lines_front.test.mjs
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

const L = (code, pid, name, qty, kit) => ({ input_code: code, matched: true, product_id: pid, ctr_code: code, syd_codes: [], product_name: name, qty,
  list_price: 100, discount_rate: 10, final_price: 90, line_subtotal: 90 * qty, line_iva: 14.4 * qty, line_total: 104.4 * qty, avail_stock: 9, stock_flag: 'ok', kit_no: kit || null });
const PREVIEW = {
  lines: [L('CB1', 1, 'ROTULA INFERIOR', 2, 'K0009'), L('CE2', 2, 'TERMINAL EXTERIOR', 1, 'K0009'), L('ZZ9', 3, 'AMORTIGUADOR', 1)],
  totals: { totalQty: 4, subtotal: 360, iva: 57.6, total: 417.6, skuCount: 3 },
  kits: [{ kit_no: 'K0009', title: 'Nissan Versa', years: '2012-2019', sets: 1, consistent: true,
    items: [{ ctr_code: 'CB1', qty: 2, name: 'ROTULA INFERIOR' }, { ctr_code: 'CE2', qty: 1, name: 'TERMINAL EXTERIOR' }] }],
};

async function boot() {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://example.test/refatrix-quote.html', pretendToBeVisual: true });
  const w = dom.window;
  let printed = '';
  w.fetch = async (u) => {
    u = String(u);
    if (u.includes('/api/quotes/preview')) return { ok: true, json: async () => PREVIEW };
    if (u.includes('/api/company')) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({}), text: async () => '' };
  };
  w.alert = () => {};
  w.open = () => ({ document: { open() {}, write(h) { printed += h; }, close() {} }, focus() {}, print() {}, addEventListener() {} });
  await new Promise((r) => setTimeout(r, 30));
  const files = [];
  w.XLSX = Object.assign({}, XS, { writeFile: (wb, name) => files.push({ name, wb }) });
  w.eval("session={token:'t',api:'https://api.test',user:{name:'d',role:'director'}}");
  const $ = (id) => w.document.getElementById(id);
  $('custSel').innerHTML = '<option value="">—</option><option value="__guest__">g</option>';
  $('custSel').value = '__guest__'; w.eval('onCustChange()'); $('guestName').value = 'Taller';
  w.eval("lines=[{code:'CB1',product_id:1,qty:2,kit_no:'K0009'},{code:'CE2',product_id:2,qty:1,kit_no:'K0009'},{code:'ZZ9',product_id:3,qty:1}]");
  await w.eval('recalc()');
  return { w, $, files, printed: () => printed };
}

test('① 줄 표 — KIT 머리줄 1개(번호 · 차종 · 세트 · 구성품 CTR 코드) · 구성 줄 Producto = CTR + 제품명', async () => {
  const { w, $ } = await boot();
  assert.match(w.document.title, /qt-1111xc/);
  const heads = [...$('linesWrap').querySelectorAll('tr.kithead')];
  assert.equal(heads.length, 1);
  const t = heads[0].textContent;
  assert.match(t, /KIT K0009 · Nissan Versa 2012-2019 · 1 juego/);
  assert.match(t, /CB1 ROTULA INFERIOR ×2 · CE2 TERMINAL EXTERIOR/);
  const rows = [...$('linesWrap').querySelectorAll('tbody tr')];
  assert.ok(rows[0].classList.contains('kithead'), '머리줄이 키트 첫 줄 앞');
  assert.match(rows[1].querySelector('td.prod').textContent, /🧰 K0009\s*CB1 ROTULA INFERIOR/);
  assert.equal(rows[3].querySelector('td.prod').textContent, 'AMORTIGUADOR', '일반 줄은 제품명 그대로');
  // 삭제 버튼 번호는 줄 순서 그대로(머리줄이 끼어도 어긋나지 않음)
  assert.match(rows[3].querySelector('button.delx').getAttribute('onclick'), /removeLine\(2\)/);
});

test('② 견적 엑셀 — KIT 머리줄(강조·병합) + 구성 줄 「[K0009] CTR 제품명」 · 일반 줄 종전', async () => {
  const { w, files } = await boot();
  await w.eval('exportExcel()');   // 0325b · 경쟁사 코드 열 때문에 async
  assert.equal(files.length, 1);
  const ws = files[0].wb.Sheets.Cotizacion;
  assert.equal(ws.A5.v, 'KIT K0009');
  assert.match(ws.C5.v, /^Nissan Versa 2012-2019 · 1 juego · Componentes: CB1 ROTULA INFERIOR ×2 \/ CE2 TERMINAL EXTERIOR$/);
  assert.equal(ws.A5.s.font.bold, true);
  assert.ok((ws['!merges'] || []).some((m) => m.s.r === 4 && m.s.c === 2));
  assert.equal(ws.A6.v, 'CB1'); assert.equal(ws.C6.v, '[K0009] CB1 ROTULA INFERIOR');
  assert.equal(ws.C7.v, '[K0009] CE2 TERMINAL EXTERIOR');
  assert.equal(ws.A8.v, 'ZZ9'); assert.equal(ws.C8.v, 'AMORTIGUADOR');
  assert.equal(ws.D6.v, 2);
});

test('③ 견적서 인쇄 — KIT 머리줄 + [K0009] CTR 제품명', async () => {
  const { w, printed } = await boot();
  try { await w.eval('printQuote()'); } catch (_) {}
  const h = printed();
  assert.ok(h.length > 0, '인쇄 HTML 이 만들어져야 함');
  assert.match(h, /KIT K0009 · Nissan Versa 2012-2019 · 1 juego/);
  assert.match(h, /Componentes: CB1 ROTULA INFERIOR ×2 · CE2 TERMINAL EXTERIOR/);
  assert.match(h, /\[K0009\] CB1 ROTULA INFERIOR/);
});
