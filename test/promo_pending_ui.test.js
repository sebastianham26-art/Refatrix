/* 프로모션 화면 — 작업버튼 노출 + 실사 반영 대기 표시 (build sc0922promo2)
   실행:  node test/promo_pending_ui.test.js   (REPO 환경변수로 다른 경로 지정 가능) */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const REPO = process.env.REPO || path.resolve(__dirname, '..');
const FILE = path.join(REPO, 'refatrix-stockcount.html');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastScript = (html) => html.match(/<script>[\s\S]*?<\/script>/g).pop().replace(/^<script>/, '').replace(/<\/script>$/, '');

// 2026-09-22 운영 데이터 형태를 그대로 축약
const PRO = [
  { id: 1711, code: 'PRO015', name: 'material promocion_CALCETINAS CTR', ean: '', rack_location: '', stock_qty: 16, list_price: null, is_active: true },
  { id: 1712, code: 'PRO016', name: 'material promocion_LLAVEROS AMORTIGUADOR', ean: '', rack_location: '', stock_qty: 31, list_price: null, is_active: true },
  { id: 1715, code: 'PRO_019', name: 'Bolsa CTR', ean: '', rack_location: '', stock_qty: 0, list_price: null, is_active: true },
  { id: 1716, code: 'PRO019', name: 'Bolsa CTR', ean: '', rack_location: '', stock_qty: 77, list_price: null, is_active: true },
  { id: 1720, code: 'PRO021', name: 'SIN CONTEO', ean: '', rack_location: '', stock_qty: 3, list_price: 10, is_active: true },
];
const LEGACY = [{ id: 7, code: 'PRO200', name: '테스트', barcode: '', rack_location: '', stock_qty: 999, unit_cost: 0, active: true }];
const SESSIONS = [
  { id: 24, code: 'SC-2026-0012', status: 'submitted', mode: 'full' },
  { id: 23, code: 'SP-2026-0011', status: 'submitted', mode: 'spot' },
  { id: 20, code: 'SC-2026-0011', status: 'submitted', mode: 'full' },
  { id: 18, code: 'SC-2026-0010', status: 'submitted', mode: 'full' },
  { id: 9, code: 'SC-2026-0005', status: 'reconciled', mode: 'full' },
  { id: 8, code: 'SC-2026-0004', status: 'draft', mode: 'full' },
];
const LINES = {
  24: [{ item_kind: 'part', product_id: 1712, counted_qty: 20 }, { item_kind: 'part', product_id: 1712, counted_qty: 11 }],
  20: [{ item_kind: 'part', product_id: 1711, counted_qty: 18 }],
  18: [{ item_kind: 'part', product_id: 1715, counted_qty: 88 }, { item_kind: 'unknown', product_id: null, counted_qty: 5 }, { item_kind: 'promo', promo_item_id: 7, counted_qty: 990 }],
  9: [{ item_kind: 'part', product_id: 1721, counted_qty: 1 }],
  8: [{ item_kind: 'part', product_id: 1721, counted_qty: 1 }],
  23: [{ item_kind: 'part', product_id: 1721, counted_qty: 1 }],
};

function mkDom({ sessions = SESSIONS } = {}) {
  const html = fs.readFileSync(FILE, 'utf8').replace(/<script src="refatrix-nav\.js[^"]*"><\/script>/, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://x.test/refatrix-stockcount.html', pretendToBeVisual: true });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 9, name: 'U', role: 'warehouse' } }));
  w.confirm = () => true; w.alert = () => {};
  const calls = [];
  w.fetch = (url, opt) => {
    const u = String(url); const method = (opt && opt.method) || 'GET';
    calls.push({ u, method });
    let out = {};
    let m;
    if (/\/api\/promo-products/.test(u)) out = { items: PRO };
    else if (/\/api\/promo-items/.test(u)) out = { items: LEGACY };
    else if ((m = u.match(/\/api\/stock-counts\/(\d+)\/reconcile/))) out = { count: { id: Number(m[1]), code: 'X', status: 'submitted' }, can_apply: false, summary: { match: 0, short: 0, over: 0, uncounted: 0, unknown: 0, diff_qty_total: 0 }, rows: [] };
    else if ((m = u.match(/\/api\/stock-counts\/(\d+)$/))) out = { id: Number(m[1]), status: 'submitted', lines: LINES[m[1]] || [] };
    else if (/\/api\/stock-counts/.test(u)) out = { items: sessions };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(out) });
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(lastScript(html));
  return { w, doc: w.document, calls };
}
const rowOf = (doc, body, code) => [...doc.getElementById(body).rows].find((r) => r.cells[1] && r.cells[1].textContent.trim().startsWith(code));

(async () => {
  console.log('\n① 작업 버튼이 맨 앞 열');
  {
    const { w, doc } = mkDom();
    await w.showPromo(); await sleep(40);
    const ths = [...doc.querySelectorAll('#promoView table')[0].querySelectorAll('thead th')].map((t) => t.textContent);
    ok('PRO 표 첫 열 = 작업', ths[0] === '작업', ths);
    ok('재고수량 · 실사 반영 대기 가 품명 바로 뒤', ths[3] === '재고수량' && ths[4] === '실사 반영 대기', ths);
    const r = rowOf(doc, 'proBody', 'PRO015');
    ok('첫 칸에 [⚖ 수량조정] 버튼', /수량조정/.test(r.cells[0].textContent) && r.cells[0].querySelector('button[data-act="qty"]'));
    ok('첫 칸에 [편집] 버튼', !!r.cells[0].querySelector('button[data-act="edit"]'));
    ok('작업 칸은 sticky 클래스(act)', r.cells[0].classList.contains('act'));
    ok('인라인 onclick 없음(PRO 표)', !doc.getElementById('proBody').innerHTML.includes('onclick'));
    ok('구 표도 첫 칸 [편집]', !!rowOf(doc, 'promoBody', 'PRO200').cells[0].querySelector('button[data-act="oldedit"]'));
    ok('인라인 onclick 없음(구 표)', !doc.getElementById('promoBody').innerHTML.includes('onclick'));
    ok('CSS: 작업열 sticky', /#promoView td\.act\{position:sticky;left:0/.test(fs.readFileSync(FILE, 'utf8')));
  }

  console.log('\n② 버튼 클릭 → 기존 모달');
  {
    const { w, doc } = mkDom();
    await w.showPromo(); await sleep(40);
    const r = rowOf(doc, 'proBody', 'PRO016');
    r.cells[0].querySelector('button[data-act="qty"]').click(); await sleep(10);
    ok('수량조정 모달이 열린다', doc.querySelector('.modal.on') !== null);
    ok('수량조정 대상 = 클릭한 행(PRO016)', /PRO016/.test(doc.querySelector('.modal.on').textContent), doc.querySelector('.modal.on') && doc.querySelector('.modal.on').textContent.slice(0, 120));
    doc.querySelectorAll('.modal.on').forEach((m) => m.classList.remove('on'));
    r.cells[0].querySelector('button[data-act="edit"]').click(); await sleep(10);
    ok('편집 모달이 열린다', doc.querySelector('.modal.on') !== null);
    doc.querySelectorAll('.modal.on').forEach((m) => m.classList.remove('on'));
    rowOf(doc, 'promoBody', 'PRO200').cells[0].querySelector('button').click(); await sleep(10);
    ok('구 품목 편집 모달 · 코드 PRO200', doc.getElementById('promoModal').classList.contains('on') && doc.getElementById('pmCode').value === 'PRO200');
    // 재바인딩 안전: 두 번 열어도 클릭 1회 = 모달 1회
    await w.showPromo(); await sleep(40);
    let n = 0; const orig = w.openProQty; w.openProQty = (i) => { n++; };
    rowOf(doc, 'proBody', 'PRO015').cells[0].querySelector('button[data-act="qty"]').click();
    ok('화면 재진입 후에도 리스너 중복 없음', n === 1, n); w.openProQty = orig;
  }

  console.log('\n③ 실사 반영 대기');
  {
    const { w, doc, calls } = mkDom();
    await w.showPromo(); await sleep(40);
    const p15 = rowOf(doc, 'proBody', 'PRO015').cells[4].textContent;
    ok('PRO015: SC-2026-0011 · 실사 18 (+2)', /SC-2026-0011/.test(p15) && /실사 18/.test(p15) && /\+2/.test(p15), p15);
    const p16 = rowOf(doc, 'proBody', 'PRO016').cells[4].textContent;
    ok('PRO016: 같은 세션 여러 줄 합산 20+11=31 → 일치', /실사 31/.test(p16) && /일치/.test(p16), p16);
    const p19u = rowOf(doc, 'proBody', 'PRO_019').cells[4].textContent;
    ok('PRO_019: SC-2026-0010 · 실사 88 (+88) — 중복등록이 드러남', /SC-2026-0010/.test(p19u) && /\+88/.test(p19u), p19u);
    ok('PRO019: 대기 없음', rowOf(doc, 'proBody', 'PRO019').cells[4].textContent.trim() === '—');
    ok('PRO021: 대기 없음', rowOf(doc, 'proBody', 'PRO021').cells[4].textContent.trim() === '—');
    const old = rowOf(doc, 'promoBody', 'PRO200').cells[4].textContent;
    ok('구 품목 PRO200: 실사 990 (−9)', /실사 990/.test(old) && /-9/.test(old), old);
    ok('스팟·반영완료·작성중 세션은 안 읽는다', !calls.some((c) => /stock-counts\/(23|9|8)$/.test(c.u)), calls.map((c) => c.u));
    ok('제출된 전체실사 3건만 상세 조회', ['24', '20', '18'].every((id) => calls.some((c) => new RegExp('stock-counts/' + id + '$').test(c.u))));
    ok('POST/PATCH 없음 — 화면 여는 것만으로 재고 안 바뀜', !calls.some((c) => c.method !== 'GET'), calls.filter((c) => c.method !== 'GET'));
    const bar = doc.getElementById('proPendBar').textContent;
    ok('상단 안내: 반영 대기 3건', /반영 대기 중인 재고실사 3건/.test(bar), bar);
    // 대조·반영 링크 → 해당 세션 대조 화면
    rowOf(doc, 'proBody', 'PRO015').cells[4].querySelector('[data-act="recon"]').click(); await sleep(30);
    ok('[대조·반영 ▸] → SC 20 대조 호출', calls.some((c) => /stock-counts\/20\/reconcile/.test(c.u)));
    ok('대조 화면으로 전환', !doc.getElementById('reconView').classList.contains('hidden') && doc.getElementById('promoView').classList.contains('hidden'));
  }

  console.log('\n④ 대기 없음');
  {
    const { w, doc } = mkDom({ sessions: [] });
    await w.showPromo(); await sleep(40);
    ok('안내 바 비어 있음', doc.getElementById('proPendBar').innerHTML === '');
    ok('모든 행 —', [...doc.getElementById('proBody').rows].every((r) => r.cells[4].textContent.trim() === '—'));
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
