// 2026-11-25 · 가격 마스터 ⑤-2 SYD 가격표 화면 (jsdom)
//   실행: node test/pricemaster_syd_items_ui.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const html = readFileSync(new URL('../../refatrix-pricemaster.html', import.meta.url), 'utf8');
const ITEMS = { list: { id: 2, date: '2026-11-01', file_name: 'syd.xlsx', prev_id: 1, prev_date: '2026-09-01' },
  familias: [{ v: 'ROTULAS', n: 1 }, { v: '__none__', n: 1 }], kpi: { codes: 2, linked: 1, avg_price: 862.5, up: 0, down: 1, new: 1 }, total: 2,
  rows: [
    { syd_code: '1026018', syd_norm: '1026018', price: 225, familia: 'ROTULAS', descripcion: 'ROTULA DODGE', prev_price: 250, change: -0.1, is_new: false, ctr_codes: ['CB0011', 'CB0012'], ctr_list: 400, ratio: 1.7778 },
    { syd_code: 'GY-421', syd_norm: 'GY421', price: 1500, familia: null, descripcion: 'AMORTIGUADOR', prev_price: null, change: null, is_new: true, ctr_codes: [], ctr_list: null, ratio: null },
  ] };
const calls = []; let saved = null;
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://erp.refatrix.com/refatrix-pricemaster.html',
  beforeParse(w) {
    w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api', user: { name: 'Seb', role: 'director' } }));
    w.fetch = async (url) => { calls.push(String(url)); const u = new URL(url);
      const body = u.pathname === '/api/price-master/facets' ? { ready: true, today: '2026-11-25', fx: { rate: 18.35, date: '2026-11-25' }, origin: [], cat: [], maker: [], material: [], can_edit: true }
        : u.pathname === '/api/price-master/table' ? { fx: null, kpi: { total: 0, fob: 0, list: 0 }, rows: [] }
        : u.pathname === '/api/price-master/syd/lists' ? { items: [{ id: 2, list_date: '2026-11-01', code_count: 2 }, { id: 1, list_date: '2026-09-01', code_count: 1 }] }
        : u.pathname === '/api/price-master/syd/items' ? ITEMS
        : u.pathname === '/api/price-master/syd/items/history' ? { code: '1026018', history: [{ list_date: '2026-11-01', price: 225, familia: 'ROTULAS', descripcion: 'ROTULA DODGE' }, { list_date: '2026-09-01', price: 250 }], ctr: [{ code: 'CB0011', name: 'ROTULA', list_price: 344 }] }
        : {};
      return { ok: true, status: 200, json: async () => body }; };
    w.HTMLCanvasElement.prototype.getContext = () => null;
    w.XLSX = { utils: { aoa_to_sheet: (a) => { saved = { ...(saved || {}), aoa: a }; return {}; }, book_new: () => ({}), book_append_sheet: () => {} }, writeFile: (wb, name) => { saved = { ...(saved || {}), name }; } };
    const orig = w.Node.prototype.appendChild;
    w.Node.prototype.appendChild = function (el) { if (el && el.tagName === 'SCRIPT' && el.src && el.src.includes('xlsx')) { setTimeout(() => el.onload && el.onload(), 0); return el; } return orig.call(this, el); };
  } });
const w = dom.window; const $ = (id) => w.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const ok = (n, f) => { f(); pass++; console.log('  ✔', n); };
for (let i = 0; i < 40 && !$('tth').querySelector('th'); i++) await sleep(50);
ok('빌드 pm-1125sp · 탭 「⑤-2 SYD 가격표」가 ⑤ 바로 뒤', () => {
  assert.match(w.document.title, /pm-1125sp/);
  const tabs = [...w.document.querySelectorAll('.tab')].map((t) => t.textContent);
  assert.equal(tabs[tabs.indexOf('⑤ 경쟁사 SYD') + 1], '⑤-2 SYD 가격표');
});
w.document.querySelector('.tab[data-t="sydp"]').click();
for (let i = 0; i < 40 && !$('spTb').querySelector('tr td'); i++) await sleep(50);
ok('탭 열면 리스트 선택(최신 표시) + 최신 리스트 조회', () => {
  assert.ok(!$('t-sydp').classList.contains('hidden'));
  assert.equal($('spList').options[0].textContent, '2026-11-01 (최신) · 2개'); assert.equal($('spList').options.length, 2);
  assert.ok(calls.some((u) => /\/syd\/items\?list_id=2&sort=code&dir=asc&offset=0&limit=200/.test(u)), calls.join('\n'));
});
ok('표: 9열 · SYD List · 앞 리스트 · 변동 · CTR 여러 개 · 신규 배지 · 비율', () => {
  const tr = [...$('spTb').querySelectorAll('tr')]; assert.equal(tr[0].children.length, 9);
  const c = (r, i) => tr[r].children[i].textContent;
  assert.equal(c(0, 0), '1026018'); assert.equal(c(0, 3), '225.00'); assert.equal(c(0, 4), '250.00'); assert.equal(c(0, 5), '-10.0%'); assert.ok(tr[0].children[5].classList.contains('down'));
  assert.equal(c(0, 6), 'CB0011, CB0012'); assert.equal(tr[0].children[6].querySelectorAll('.codeLink').length, 2); assert.equal(c(0, 8), '1.78');
  assert.equal(c(1, 0), 'GY-421 신규'); assert.equal(c(1, 5), '—'); assert.equal(c(1, 6), '—');
  assert.match($('spInfo').textContent, /기준일 2026-11-01 · syd\.xlsx · 비교 대상 2026-09-01/);
  const k = [...$('spKpis').querySelectorAll('.kpi b')].map((b) => b.textContent); assert.deepEqual(k, ['2', '1', '$ 862.50', '0', '1', '1']);
  assert.deepEqual([...$('spFam').options].map((o) => o.textContent), ['전체', 'ROTULAS (1)', '(없음) (1)']);
});
$('spView').value = 'down'; $('spView').dispatchEvent(new w.Event('change')); await sleep(60);
ok('보기 바꾸면 view=down 으로 다시 조회', () => assert.ok(calls.some((u) => /view=down/.test(u))));
w.document.querySelector('#spTh th[data-sk="price"]').click(); await sleep(60);
ok('SYD List Price 제목 정렬 → sort=price&dir=desc', () => assert.ok(calls.some((u) => /sort=price&dir=desc/.test(u))));
w.document.querySelector('#spTb .spHist').click(); await sleep(80);
ok('SYD 코드 누르면 가격 이력 창(리스트별 가격 · 변동 · 연결 CTR)', () => {
  const m = $('modalRoot'); assert.match(m.textContent, /SYD 1026018/); assert.match(m.textContent, /2026-11-01225\.00-10\.0%/); assert.match(m.textContent, /CB0011ROTULA344\.00/);
  m.querySelector('[data-close]').click();
});
$('btnSpXlsx').click(); for (let i = 0; i < 40 && !(saved && saved.name); i++) await sleep(50);
ok('엑셀 다운로드: limit=50000 · 파일명 · 10열', () => {
  assert.ok(calls.some((u) => /syd\/items\?.*limit=50000/.test(u)));
  assert.equal(saved.name, 'Refatrix_SYD_lista_2026-11-01.xlsx');
  const a = JSON.parse(JSON.stringify(saved.aoa));
  assert.ok(!calls.some((u) => /price-master\/product\?/.test(u)), 'SYD 코드 클릭이 제품 이력으로 새면 안 됨');
  assert.deepEqual(a[0], ['Clave SyD', 'Descripcion', 'Familia', 'Precio Lista SyD (2026-11-01)', 'Precio anterior (2026-09-01)', 'Cambio %', 'Nuevo', 'Clave CTR', 'List Price CTR', 'CTR/SYD']);
  assert.deepEqual(a[1], ['1026018', 'ROTULA DODGE', 'ROTULAS', 225, 250, -10, '', 'CB0011, CB0012', 400, 1.7778]);
  assert.deepEqual(a[2], ['GY-421', 'AMORTIGUADOR', '', 1500, null, null, 'Si', '', null, null]);
});
console.log(`\n${pass} passed`); process.exit(0);
