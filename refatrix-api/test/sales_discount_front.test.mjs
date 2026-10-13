// 2026-10-13 · 매출확정목록 「할인율로 매출액 수정」 + 「최종단가 엑셀」 — 운영 refatrix-funnel.html 을 jsdom 에서 구동
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert/strict';
import { repriceByDiscount } from '../src/sales.js';

const FUNNEL = readFileSync(new URL('../../refatrix-funnel.html', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

const ITEMS = [
  { ctr_code: 'CB0001', syd_codes: 'S1', product_name: 'Amort', app: 'Versa', qty: 3, list_price: 1000, discount_rate: 45, unit_price: 550, line_amount_mxn: 1650 },
  { ctr_code: 'CB0002', syd_codes: '', product_name: 'Brazo', app: '', qty: 7, list_price: 333.33, discount_rate: 45, unit_price: 183.33, line_amount_mxn: 1283.31 },
];
const INV = (over = {}) => ({ invoice: { id: 7, sat_no: 'SAT-77', folio_no: 'F9', inv_date_str: '2026-10-05', customer_code: 'C-1', customer_name: 'Cliente', customer_rfc: 'RFC1',
  subtotal_mxn: 2933.31, iva_mxn: 469.33, total_mxn: 3402.64, iva_rate: 16, can_adjust: true, is_director: true, can_price_xls: true, past_edit_enabled: false, ...over }, items: ITEMS.map((x) => ({ ...x })) });

function boot(data, role = 'director') {
  const html = FUNNEL.replace(/<script src=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://x.test/' });
  const w = dom.window;
  const calls = [];
  w.fetch = async (url, opt) => {
    const u = String(url); calls.push({ u, opt });
    if (/invoice-lines/.test(u)) return { ok: true, status: 200, json: async () => data };
    if (/adjust-discount/.test(u)) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  w.eval(`session={token:'T',user:{name:'D',role:${JSON.stringify(role)}},api:'https://api.test'}; loadImmediate=async function(){ const k=Object.keys(openRows).find(x=>x[0]==='i'); document.body.innerHTML='<div id="box">'+(k&&openRows[k]!=='loading'?openRows[k]:'')+'</div>'; };`);
  return { w, calls };
}

test('디렉터: 매출액 수정 박스에 ① 할인율 + ② 총액 직접 입력, 최종단가 엑셀 버튼', async () => {
  const { w } = boot(INV());
  await w.toggleInvoice(7); await settle();
  const d = w.document;
  assert.ok(d.getElementById('rpx-basis-7'), '기준 선택');
  assert.ok(d.getElementById('rpx-rate-7'), '할인율 입력');
  assert.ok(d.querySelector('[data-rpx-apply="7"]'), '할인율 적용 버튼');
  assert.ok(d.getElementById('adj-tot-7'), '기존 총액 직접 입력 유지');
  assert.ok(d.querySelector('[data-pxls="7"]'), '최종단가 엑셀 버튼');
  assert.equal(d.getElementById('rpx-basis-7').value, 'list', '정가가 모두 있으면 정가 대비가 기본');
  assert.match(d.body.textContent, /현재 정가 대비 실효 할인율: 45\.00%/);
  assert.equal(d.querySelectorAll('[onclick*="rpx"],[oninput*="rpx"]').length, 0, '새 요소는 addEventListener(위임)만');
});

test('할인율 입력 → 미리보기 = 서버 계산과 동일 (정가 대비 / 현재 대비)', async () => {
  const { w } = boot(INV());
  await w.toggleInvoice(7); await settle();
  const d = w.document;
  const rate = d.getElementById('rpx-rate-7');
  rate.value = '50'; rate.dispatchEvent(new w.Event('input', { bubbles: true }));
  const srv = repriceByDiscount(ITEMS.map((l, i) => ({ ...l, id: i })), { basis: 'list', rate: 50 });
  const out = d.getElementById('rpx-out-7').textContent;
  const money = (n) => Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.ok(out.includes(money(srv.subtotal)) && out.includes(money(srv.iva)) && out.includes(money(srv.total)), out);
  const sel = d.getElementById('rpx-basis-7'); sel.value = 'current'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  const srv2 = repriceByDiscount(ITEMS.map((l, i) => ({ ...l, id: i })), { basis: 'current', rate: 50 });
  assert.ok(d.getElementById('rpx-out-7').textContent.includes(money(srv2.total)));
  rate.value = '120'; rate.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.match(d.getElementById('rpx-out-7').textContent, /100 미만/);
});

test('할인율 적용 → POST /adjust-discount {basis, rate} (확인창 취소 시 미전송)', async () => {
  const { w, calls } = boot(INV());
  await w.toggleInvoice(7); await settle();
  const d = w.document;
  d.getElementById('rpx-rate-7').value = '48';
  w.confirm = () => false;
  d.querySelector('[data-rpx-apply="7"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(calls.filter((c) => /adjust-discount/.test(c.u)).length, 0);
  w.confirm = () => true;
  d.querySelector('[data-rpx-apply="7"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle();
  const c = calls.find((x) => /adjust-discount/.test(x.u));
  assert.ok(c, 'POST 호출');
  assert.equal(c.u, 'https://api.test/api/sales/7/adjust-discount');
  assert.deepEqual(JSON.parse(c.opt.body), { basis: 'list', rate: 48 });
});

test('정가 없는 품목이 있으면 정가 대비 비활성 · 현재 대비가 기본', async () => {
  const data = INV(); data.items[1].list_price = 0;
  const { w } = boot(data);
  await w.toggleInvoice(7); await settle();
  const sel = w.document.getElementById('rpx-basis-7');
  assert.equal(sel.value, 'current');
  assert.equal(sel.querySelector('option[value="list"]').disabled, true);
});

test('영업지원(Maria): 매출액 수정 박스 없음 · 최종단가 엑셀 버튼 있음 / 영업사원: 둘 다 없음', async () => {
  const s = boot(INV({ can_adjust: false, is_director: false, can_price_xls: true }), 'sales_support');
  await s.w.toggleInvoice(7); await settle();
  assert.equal(s.w.document.getElementById('rpx-rate-7'), null);
  assert.ok(s.w.document.querySelector('[data-pxls="7"]'));
  const v = boot(INV({ can_adjust: false, is_director: false, can_price_xls: false }), 'sales');
  await v.w.toggleInvoice(7); await settle();
  assert.equal(v.w.document.querySelector('[data-pxls="7"]'), null);
});

test('최종단가 엑셀 — 품목별 최종단가·금액·합계가 인보이스 최종 매출액과 일치, 파일명', async () => {
  // 할인 적용 뒤 상태(정가 대비 50%)
  const data = INV({ subtotal_mxn: 2666.69, iva_mxn: 426.67, total_mxn: 3093.36 });
  data.items[0].unit_price = 500; data.items[0].line_amount_mxn = 1500;
  data.items[1].unit_price = 166.67; data.items[1].line_amount_mxn = 1166.69;
  const { w } = boot(data);
  await w.toggleInvoice(7); await settle();
  let written = null;
  const J = (x) => JSON.parse(JSON.stringify(x));
  w.XLSX = {
    utils: {
      aoa_to_sheet: (aoa) => { written = aoa; return { '!ref': 'A1:K30' }; },
      decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 29, c: 10 } }), encode_cell: ({ r, c }) => r + ':' + c,
      book_new: () => ({}), book_append_sheet: () => {},
    },
    writeFile: (wb, name) => { w.__fname = name; },
  };
  w.document.querySelector('[data-pxls="7"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const head = written.findIndex((r) => r[0] === '#');
  assert.deepEqual(J(written[head]), ['#', 'Código CTR', 'SYD', 'Descripción', 'Cant.', 'Precio lista', 'Desc. %', 'Precio unit. final (sin IVA)', 'Importe (sin IVA)', 'IVA', 'Importe (con IVA)']);
  assert.deepEqual(J(written[head + 1].slice(0, 9)), [1, 'CB0001', 'S1', 'Amort', 3, 1000, 50, 500, 1500]);
  assert.deepEqual(J(written[head + 2].slice(4, 9)), [7, 333.33, 50, 166.67, 1166.69]);
  const flat = JSON.stringify(written);
  assert.ok(flat.includes('"Subtotal (sin IVA)",2666.69') && flat.includes('"Total (con IVA)",3093.36'));
  assert.match(flat, /✔ Σ Importe = Subtotal de la factura/);
  assert.match(flat, /Cant\. × Precio unit\. = Importe en todas las líneas/);
  assert.match(w.__fname, /^precios_finales_SAT-77_\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('최종단가 엑셀 — 총액 직접 입력으로 비례 조정된 줄은 6자리 단가로 금액을 맞춘다', () => {
  const { w } = boot(INV());
  const d = INV({ subtotal_mxn: 100.01 });
  d.items = [{ ctr_code: 'X', qty: 3, list_price: 100, unit_price: 33.34, line_amount_mxn: 100.01 }];
  const b = w.pxlsBuildAoa(d);
  const row = b.aoa[b.headRow + 1];
  assert.equal(row[7], 33.336667);
  assert.equal(Math.round(row[7] * 3 * 100) / 100, 100.01);
  assert.equal(b.exact, false); assert.equal(b.okSum, true);
  assert.match(JSON.stringify(b.aoa), /6 decimales/);
});
