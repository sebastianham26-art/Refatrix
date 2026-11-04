// =====================================================================
// 견적 목록 › 견적 상세 — 키트 단위 보기 (ql-1104kit · 2026-11-04)
//   · 키트 줄이 먼저(키트 번호 순) → 그 안은 제품 코드 순 → 일반 줄 / KIT 열 맨 앞 / 키트마다 KIT 머리줄
//   · 견적서 PDF(인쇄 HTML) · 엑셀(재고분) 에도 같은 순서 · KIT 열 · 머리줄(번호 · 차종 · 세트 · 구성품 코드)
//   · 키트 없는 견적은 종전 그대로(KIT 열 없음)
//   실행: node --test test/quote_detail_kit_front.test.mjs   (jsdom · xlsx-js-style 필요)
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'refatrix-quotelist.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');
let JSDOM; try { ({ JSDOM } = await import('jsdom')); } catch {}
let XS; try { XS = createRequire(import.meta.url)('xlsx-js-style'); } catch {}
const opts = JSDOM && XS ? {} : { skip: 'jsdom / xlsx-js-style 미설치' };

const ln = (id, code, name, qty, kit) => ({ id, line_no: id, product_id: id, ctr_code: code, product_name: name, qty, kit_no: kit || null,
  reserved_qty: qty, cur_stock: 20, live_avail: 20, live_flag: 'ok', stock_flag: 'ok',
  list_price: 100, discount_rate: 10, final_price: 90, line_subtotal: 90 * qty, line_iva: 14.4 * qty, line_total: 104.4 * qty });
// 저장 순서가 뒤섞여 있어도 화면은 K0002 → K0009 → 일반 순
const LINES = [ln(1, 'AA100', 'AMORTIGUADOR', 1), ln(2, 'CE2', 'TERMINAL EXTERIOR', 1, 'K0009'), ln(3, 'CB1', 'ROTULA INFERIOR', 2, 'K0009'),
  ln(4, 'ZZ7', 'BUJE', 4, 'K0002'), ln(5, 'AA050', 'HORQUILLA', 1)];
const KITS = [
  { kit_no: 'K0002', title: 'Chevrolet Aveo', years: '2008-2018', sets: 2, items: [{ ctr_code: 'ZZ7', qty: 2, name: 'BUJE' }] },
  { kit_no: 'K0009', title: 'Nissan Versa', years: '2012-2019', sets: 1, items: [{ ctr_code: 'CB1', qty: 2, name: 'ROTULA INFERIOR' }, { ctr_code: 'CE2', qty: 1, name: 'TERMINAL EXTERIOR' }] },
];
const QUOTE = { id: 7, quote_no: 'Q-2026-0400', status: 'draft', quote_date: '2026-11-04', party_name: 'Taller', is_guest: false,
  subtotal_mxn: 810, iva_mxn: 129.6, total_mxn: 939.6, total_qty: 9, sku_count: 5,
  reserve_expires_at: new Date(Date.now() + 6 * 3600e3).toISOString(), packing_printed_at: null, cls: { ok: 5 } };

async function boot({ lines = LINES, kits = KITS } = {}) {
  let printed = '';
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-quotelist.html',
    beforeParse(win) {
      win.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { name: 'dir', role: 'director' } }));
      win.alert = () => {}; win.confirm = () => true;
      win.open = () => ({ document: { open() {}, write(h) { printed += h; }, close() {} }, focus() {}, print() {} });
      win.fetch = async (url) => {
        const u = String(url); const json = (o) => ({ ok: true, status: 200, json: async () => o });
        if (/\/api\/quotes\/\d+$/.test(u)) return json({ quote: QUOTE, lines, kits });
        if (/\/api\/quotes\?/.test(u)) return json({ items: [], summary: {} });
        if (/\/api\/quotes\/counts/.test(u)) return json({ open: 0 });
        if (/\/api\/company/.test(u)) return json({});
        if (/\/api\/auth\/(login|me)/.test(u)) return json({ token: 't', user: { name: 'dir', role: 'director' }, perm: {} });
        return json({});
      };
    },
  });
  await new Promise((r) => dom.window.addEventListener('load', r));
  const w = dom.window;
  const files = [];
  w.XLSX = Object.assign({}, XS, { writeFile: (wb, name) => files.push({ name, wb }) });
  w.session = { token: 't', user: { name: 'dir', role: 'director' }, api: 'https://api.test' };
  w.isDirector = true;
  await w.openDetail(7);
  return { w, files, printed: () => printed };
}

test('① 상세 표 — KIT 열 맨 앞 · 키트 번호 순 → 제품 코드 순 → 일반 줄 · 머리줄', opts, async () => {
  const { w } = await boot();
  assert.match(w.document.title, /ql-1104kit/);
  const tb = w.document.querySelector('#dtBody table');
  assert.equal(tb.querySelector('thead th').textContent, 'KIT');
  const rows = [...tb.querySelectorAll('tbody tr')];
  const seq = rows.map((r) => r.classList.contains('qlkh') ? 'H:' + r.textContent.split('·')[0].replace('🧰', '').trim()
    : r.cells[0].textContent + '|' + r.cells[1].textContent);
  assert.deepEqual(seq, ['H:KIT K0002', 'K0002|ZZ7', 'H:KIT K0009', 'K0009|CB1', 'K0009|CE2', 'H:일반 품목', '|AA050', '|AA100']);
  const h = rows[2].textContent;
  assert.match(h, /KIT K0009 · Nissan Versa 2012-2019 · 1 juego/);
  assert.match(h, /Componentes: CB1 ROTULA INFERIOR ×2 · CE2 TERMINAL EXTERIOR/);
});

test('② 정렬을 바꿔도(수량순) 키트 묶음이 먼저 · 키트 순서 유지', opts, async () => {
  const { w } = await boot();
  w.dtSetSort('qty');
  const codes = w.dtSortedLines().map((l) => (l.kit_no || '-') + ':' + l.ctr_code);
  assert.deepEqual(codes.slice(0, 3).map((x) => x.split(':')[0]), ['K0002', 'K0009', 'K0009']);
  assert.ok(codes.slice(3).every((x) => x.startsWith('-:')));
});

test('③ 견적서 PDF — KIT 열(첫 열) · 키트 머리줄 · 키트 순서', opts, async () => {
  const { w, printed } = await boot();
  await w.printQuotePdf();
  const h = printed();
  assert.match(h, /<thead><tr><th>KIT<\/th><th>CTR<\/th>/);
  assert.match(h, /KIT K0009<\/b> · Nissan Versa 2012-2019 · 1 juego/);
  assert.match(h, /Componentes: CB1 ROTULA INFERIOR ×2 · CE2 TERMINAL EXTERIOR/);
  assert.match(h, /Piezas sueltas/);
  const order = ['KIT K0002', 'ZZ7', 'KIT K0009', 'CB1', 'CE2', 'Piezas sueltas', 'AA050', 'AA100'].map((s) => h.indexOf(s));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), JSON.stringify(order));
});

test('④ 엑셀(재고분) — KIT 열(# 다음) · 머리줄(병합) · 순서 · Importe/Subtotal 수식 범위', opts, async () => {
  const { w, files } = await boot();
  w.downloadStockExcel();
  assert.equal(files.length, 1);
  const ws = files[0].wb.Sheets['Cotización'];
  assert.equal(ws.B6.v, 'KIT'); assert.equal(ws.C6.v, 'Clave CTR');
  const col = (c, r) => (ws[c + r] ? ws[c + r].v : '');
  const seq = []; for (let r = 7; r <= 16; r++) seq.push(col('A', r) + '|' + col('B', r) + '|' + col('C', r));
  assert.deepEqual(seq.slice(0, 8), ['KIT K0002|Chevrolet Aveo 2008-2018 · 2 juegos · Componentes: ZZ7 BUJE ×2|', '1|K0002|ZZ7',
    'KIT K0009|Nissan Versa 2012-2019 · 1 juego · Componentes: CB1 ROTULA INFERIOR ×2 / CE2 TERMINAL EXTERIOR|', '2|K0009|CB1', '3|K0009|CE2',
    '|Piezas sueltas|', '4||AA050', '5||AA100']);
  assert.ok(ws['!merges'].some((m) => m.s.r === 6 && m.s.c === 1));
  const imp = Object.keys(ws).find((k) => ws[k] && ws[k].v === 'Subtotal (sin IVA)');
  const valCell = ws[String.fromCharCode(imp.charCodeAt(0) + 1) + imp.slice(1)];
  assert.match(valCell.f, /^SUM\([A-Z]+7:[A-Z]+14\)$/, valCell.f);
});

test('⑤ 키트 없는 견적 — KIT 열 · 머리줄 없음(종전 그대로)', opts, async () => {
  const { w, files, printed } = await boot({ lines: [ln(1, 'AA100', 'AMORTIGUADOR', 1), ln(5, 'AA050', 'HORQUILLA', 1)], kits: [] });
  const tb = w.document.querySelector('#dtBody table');
  assert.notEqual(tb.querySelector('thead th').textContent, 'KIT');
  assert.equal(tb.querySelectorAll('tr.qlkh').length, 0);
  await w.printQuotePdf(); assert.ok(!/<th>KIT<\/th>/.test(printed()));
  w.downloadStockExcel(); assert.equal(files[0].wb.Sheets['Cotización'].B6.v, 'Clave CTR');
});
