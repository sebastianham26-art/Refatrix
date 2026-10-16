// salestrend_front.test.mjs (2026-10-16) — refatrix-salestrend.html jsdom 동작 테스트(fetch 목업, 계산은 실제 salesTrend.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { analyzeSku, monthKeys, partKind, pairCode, trendCat, TREND_CATS } from '../src/salesTrend.js';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'refatrix-salestrend.html'), 'utf8')
  .replace(/<script src="https:[^"]+"><\/script>/g, '').replace(/<script src="refatrix-nav[^"]+"><\/script>/, '');
const months = monthKeys('2026-10', 24);
function item(id, code, name, series, stock, backorder, extra = {}) {
  const a = analyzeSku({ series, months, curYm: '2026-10', firstSaleYm: extra.first || '2024-11', stock, backorder, lead: 4, safe: 1, lostSeries: extra.lost });
  return { product_id: id, code, name, app: 'TOYOTA Yaris 2018', syd: 'S' + id, kind: partKind(name, code), cat: trendCat(name, code), pair: pairCode(code), is_active: true,
    stock, backorder, incoming: extra.incoming || 0, shortage_open: extra.open || 0, series, lost: extra.lost || null, top_share: 0.6,
    type: a.type, total: a.total, sale_months: a.sale_months, adi: a.adi, cv2: a.cv2, avg6: a.avg6, trend: a.trend, since_last: a.since_last,
    last_ym: a.last_ym, fc: a.fc, fc_lost: a.fc_lost, lost_total: a.lost_total, supply: a.supply };
}
const steady = [...new Array(23).fill(10), 4];
const inter = new Array(24).fill(0); for (let i = 2; i < 23; i += 3) inter[i] = 6;
const dead = new Array(24).fill(0); dead[5] = 5;
const lostOnly = new Array(24).fill(0); lostOnly[21] = 4; lostOnly[22] = 5;
const ITEMS = [item(1, 'CB0401', 'ROTULA INFERIOR', steady, 15, 20, { incoming: 8 }), item(2, 'CE0351L', 'TERMINAL EXTERIOR "L"', inter, 0, 0),
  item(3, 'CQ0001', 'HORQUILLA', dead, 30, 0, { first: '2024-04' }), item(4, 'CB9999', 'ROTULA SUPERIOR', new Array(24).fill(0), 0, 0, { lost: lostOnly, open: 5, first: null })];
for (let i = 0; i < 400; i++) ITEMS.push(item(100 + i, 'LD' + String(i).padStart(4, '0'), 'BUJE', steady.map((q) => q % 3), 1, 0));
ITEMS.push(item(900, 'PRO-CAP', 'GORRA', [...new Array(23).fill(1), 0], 50, 0), item(901, 'CL0387', 'TORNILLO ESTABILIZADOR', steady, 3, 0));
const LIST = { months, cur_ym: '2026-10', today: '2026-10-16', lead: 4, safe: 1, all: false, done_months: 23, cats: TREND_CATS, count: ITEMS.length, items: ITEMS };

function setup({ status = 200 } = {}) {
  const calls = [];
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'https://erp.refatrix.com/refatrix-salestrend.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.x', user: { name: 'Sebastian', role: 'director' } }));
      w.fetch = async (url) => {
        calls.push(String(url));
        if (status !== 200) return { ok: false, status, json: async () => ({ error: 'director_or_socio_only' }) };
        if (/\/api\/salestrend\/2\?/.test(url)) {
          const it = ITEMS[1];
          return { ok: true, status: 200, json: async () => ({ ...LIST, items: undefined, ...it,
            product: { id: 2, code: it.code, name: it.name, app: it.app, syd: 'S2', kind: it.kind, stock: 0, backorder: 0, incoming: 0, incoming_eta: null },
            done_months: 23, avg_size: 6, next_in: 1, cover: null, suggest: 0,
            customers: [{ id: 1, name: 'Refacc Uno', qty: 30, inv_n: 5, last_date: '2026-07-15', share: 0.71 }, { id: 2, name: 'Dos', qty: 12, inv_n: 2, last_date: '2026-04-15', share: 0.29 }],
            invoices: [{ id: 9, inv_date: '2026-07-15', sat_no: 'A1', customer_name: 'Refacc Uno', qty: 6, unit_price: 55 }],
            pair: { product_id: 5, code: 'CE0351R', name: 'R', stock: 2, backorder: 0, total: 40, fc: 2, type: 'inter', cover: 1, suggest: 8 } }) };
        }
        return { ok: true, status: 200, json: async () => LIST };
      };
      w.HTMLElement.prototype.scrollIntoView = function () {};
    } });
  return { dom, w: dom.window, d: dom.window.document, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 30));
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const rowOf = (d, code) => [...d.querySelectorAll('#tb tr.clk')].find((tr) => tr.querySelector('.code').textContent.startsWith(code));

test('F1 자동 로그인 → 목록·칩·KPI·페이지 300행', async () => {
  const { w, d, calls } = setup(); await tick();
  assert.match(calls[0], /\/api\/salestrend\?months=24&lead=4&safe=1/);
  assert.equal(d.querySelectorAll('#tb tr.clk').length, 300);
  assert.ok(!d.getElementById('moreBox').classList.contains('hidden'));
  click(w, d.getElementById('bMore')); assert.equal(d.querySelectorAll('#tb tr.clk').length, 406);
  assert.match(d.getElementById('chips').textContent, /전체406/);
  assert.match(d.getElementById('chips').textContent, /간헐1/);
  assert.match(d.getElementById('kpis').textContent, /정지 SKU/);
  const r = rowOf(d, 'CB0401'); const cells = r.querySelectorAll('td');
  assert.equal(cells[3].textContent.trim(), '234'); assert.match(cells[13].textContent, /3\.5개월/); assert.equal(cells[15].textContent.trim(), '15');
  assert.equal(r.querySelectorAll('.heat i').length, 24); assert.ok(r.querySelector('.heat i.cur'));
  assert.match(cells[11].textContent, /🚢 8/);
});
test('F2 리드타임 변경 → 제안 즉시 재계산 · 견적부족 포함 토글', async () => {
  const { w, d } = setup(); await tick();
  const q = d.getElementById('fQ'); q.value = 'CB'; q.dispatchEvent(new w.Event('input')); await new Promise((r) => setTimeout(r, 250));
  const lead = d.getElementById('fLead'); lead.value = '6'; lead.dispatchEvent(new w.Event('input'));
  assert.equal(rowOf(d, 'CB0401').querySelectorAll('td')[15].textContent.trim(), '35');   // 10×7 − 35
  assert.equal(rowOf(d, 'CB9999').querySelectorAll('td')[15].textContent.trim(), '0');
  const lost = d.getElementById('fLost'); lost.checked = true; lost.dispatchEvent(new w.Event('change'));
  assert.notEqual(rowOf(d, 'CB9999').querySelectorAll('td')[15].textContent.trim(), '0');
  assert.match(rowOf(d, 'CB9999').querySelectorAll('td')[12].textContent, /9미해소 5/);
});
test('F3 검색·유형 칩·정렬', async () => {
  const { w, d } = setup(); await tick();
  click(w, d.querySelector('.chip[data-t="dead"]'));
  assert.equal(d.querySelectorAll('#tb tr.clk').length, 1); assert.ok(rowOf(d, 'CQ0001'));
  click(w, d.querySelector('.chip[data-t=""]'));
  const q = d.getElementById('fQ'); q.value = 'cb0'; q.dispatchEvent(new w.Event('input')); await new Promise((r) => setTimeout(r, 250));
  assert.equal(d.querySelectorAll('#tb tr.clk').length, 1);
  q.value = ''; q.dispatchEvent(new w.Event('input')); await new Promise((r) => setTimeout(r, 250));
  click(w, d.querySelector('th[data-s="code"]'));
  assert.equal(d.querySelector('#tb tr.clk .code').textContent.slice(0, 6), 'CB0401');
  click(w, d.querySelector('th[data-s="code"]'));
  assert.equal(d.querySelector('#tb tr.clk .code').textContent.slice(0, 6), 'PRO-CA');
});
test('F4 행 클릭 → 상세(차트·고객 집중 경고·짝·인보이스)', async () => {
  const { w, d, calls } = setup(); await tick();
  click(w, rowOf(d, 'CE0351L')); await tick();
  assert.ok(calls.some((u) => /\/api\/salestrend\/2\?months=24&lead=4&safe=1/.test(u)));
  const dr = d.getElementById('drill');
  assert.ok(!dr.classList.contains('hidden')); assert.match(dr.textContent, /간헐수요 Croston/);
  assert.ok(dr.querySelectorAll('svg rect').length >= 24);
  assert.match(dr.textContent, /Refacc Uno 한 곳이 71%/); assert.match(dr.textContent, /L\/R 짝 — CE0351R/);
  assert.match(dr.textContent, /약 1개월 후/); assert.match(dr.textContent, /\$55\.00/);
  click(w, d.getElementById('dX')); assert.ok(dr.classList.contains('hidden'));
});
test('F5 403 → 디렉터·소시오 안내 · 엑셀 라이브러리 없음 안내', async () => {
  const a = setup({ status: 403 }); await tick();
  assert.match(a.d.getElementById('msg').textContent, /디렉터·소시오 전용/);
  const b = setup(); await tick();
  click(b.w, b.d.getElementById('bXls')); assert.match(b.d.getElementById('msg').textContent, /엑셀 라이브러리/);
  // XLSX 스텁 → 시트 머리글·월 열·진행 표시
  let written = null; b.w.XLSX = { utils: { aoa_to_sheet: (a) => (written = a, {}), book_new: () => ({}), book_append_sheet() {} }, writeFile: (wb, name) => { written.name = name; } };
  click(b.w, b.d.getElementById('bXls'));
  assert.equal(written.name, 'refatrix_sales_trend_20261016.xlsx'); assert.equal(written[2][7], '2024-11'); assert.equal(written[2][30], '2026-10(진행)');
  assert.equal(written.length, 3 + 406); assert.equal(written[2][2], '카테고리');
});

test('F6 카테고리 토글: 중복 선택 · 선택한 제품군만 · PRO · 전체 보기 · 기억', async () => {
  const { w, d } = setup(); await tick();
  const cats = () => [...d.querySelectorAll('#cats .chip[data-cat]')].filter((b) => b.dataset.cat !== '__all');
  assert.deepEqual(cats().map((b) => b.dataset.cat), ['rotula', 'terminal_ext', 'terminal_int', 'horquilla', 'tornillo', 'pro']);
  assert.match(d.getElementById('cats').textContent, /볼조인트2/); assert.match(d.getElementById('cats').textContent, /PRO1/);
  assert.match(d.getElementById('cats').textContent, /그 외 부품 400개/);
  const btn = (k) => d.querySelector(`#cats .chip[data-cat="${k}"]`);
  click(w, btn('rotula'));
  let codes = [...d.querySelectorAll('#tb tr.clk .code')].map((e) => e.textContent.slice(0, 6));
  assert.deepEqual(codes.sort(), ['CB0401', 'CB9999']);
  assert.equal(btn('rotula').getAttribute('aria-pressed'), 'true');
  click(w, btn('pro'));                                  // 중복 선택
  codes = [...d.querySelectorAll('#tb tr.clk .code')].map((e) => e.textContent.replace(/S\d+$/, ''));
  assert.equal(codes.length, 3); assert.ok(codes.some((c) => c.startsWith('PRO-CAP')));
  assert.match(d.getElementById('kpis').textContent, /^3SKU/);
  click(w, btn('tornillo')); assert.equal(d.querySelectorAll('#tb tr.clk').length, 4);
  click(w, btn('rotula'));   assert.equal(d.querySelectorAll('#tb tr.clk').length, 2);   // 다시 누르면 해제
  assert.deepEqual(JSON.parse(w.localStorage.getItem('refatrix_salestrend_pref')).cats.sort(), ['pro', 'tornillo']);
  // 카테고리 + 수요유형 칩 함께
  click(w, d.querySelector('.chip[data-t="smooth"]')); assert.equal(d.querySelectorAll('#tb tr.clk').length, 2);   // CL0387·PRO-CAP 모두 꾸준
  click(w, d.querySelector('.chip[data-t=""]'));
  click(w, d.querySelector('#cats .chip[data-cat="__all"]'));
  assert.equal(d.querySelectorAll('#tb tr.clk').length, 300); assert.ok(!d.querySelector('#cats .chip.on'));
});
