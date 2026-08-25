// 표 제목 클릭 정렬 — refatrix-tablesort.js 단위 + refatrix-funnel/quotelist 통합 테스트.
// 실제 페이지 HTML 을 jsdom 에서 구동해 렌더 → 헤더 클릭 → 행 순서를 검증한다.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const SORT_JS = readFileSync(new URL('../../refatrix-tablesort.js', import.meta.url), 'utf8');
const FUNNEL = readFileSync(new URL('../../refatrix-funnel.html', import.meta.url), 'utf8');
const QLIST = readFileSync(new URL('../../refatrix-quotelist.html', import.meta.url), 'utf8');

// 외부 <script src> 는 제거하고(nav/xlsx/CDN), tablesort 만 인라인으로 되살린다.
function inlineSort(html) {
  return html.replace(/<script src=[^>]*><\/script>/g, (m) =>
    /refatrix-tablesort\.js/.test(m) ? '<script>' + SORT_JS + '</script>' : ''
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(w, n = 12) { for (let i = 0; i < n; i++) { await tick(); } }

function rowsOf(w, sel, col) {
  const tb = w.document.querySelector(sel + ' tbody');
  return Array.from(tb.rows)
    .filter((r) => !/(^|\s)sub(\s|$)/.test(r.className || ''))
    .map((r) => (r.cells[col] ? r.cells[col].textContent.trim() : ''));
}
function clickTh(w, sel, col) {
  const th = w.document.querySelector(sel + ' thead tr').cells[col];
  th.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
}

// ---------------------------------------------------------------- 단위 테스트
function sandbox() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously' });
  dom.window.eval(SORT_JS);
  return dom.window;
}

test('값 파싱: 통화·단위·백분율에서 첫 숫자만 읽고 음수 기호를 정규화한다', () => {
  const { toNum, toDate } = sandbox().RTSort._internal;
  assert.equal(toNum('1,234.56'), 1234.56);
  assert.equal(toNum('MX$1,234.56'), 1234.56);
  assert.equal(toNum('12일 ⚠'), 12);
  assert.equal(toNum('85%'), 85);
  assert.equal(toNum('−250'), -250);            // U+2212
  assert.equal(toNum('1,234.00실매출 1,200.00'), 1234);  // 줄바꿈 병기 셀 → 앞 숫자
  assert.equal(toNum('-'), null);
  assert.equal(toNum('—'), null);
  assert.equal(toNum(''), null);
  assert.equal(toDate('→ 2026-08-01'), '2026-08-01');
  assert.equal(toDate('미전환'), null);
});

test('열 타입 판별: data-type > class="r" > 날짜 다수결 > 텍스트', () => {
  const w = sandbox();
  w.document.body.innerHTML =
    '<table data-sort="t"><thead><tr>' +
    '<th>코드</th><th class="r">수량</th><th>일자</th><th data-type="text">숫자지만텍스트</th>' +
    '</tr></thead><tbody>' +
    '<tr><td>PRO2</td><td>10</td><td>2026-01-02</td><td>10</td></tr>' +
    '<tr><td>PRO10</td><td>2</td><td>2026-01-10</td><td>2</td></tr>' +
    '</tbody></table>';
  const { detectType, groupsOf } = w.RTSort._internal;
  const tb = w.document.querySelector('tbody');
  const gs = groupsOf(tb);
  const th = (i) => w.document.querySelector('thead tr').cells[i];
  assert.equal(detectType(th(0), 0, gs), 'text');
  assert.equal(detectType(th(1), 1, gs), 'num');
  assert.equal(detectType(th(2), 2, gs), 'date');
  assert.equal(detectType(th(3), 3, gs), 'text');
});

test('클릭: 오름 → 내림 토글, 빈 값은 두 방향 모두 마지막', () => {
  const w = sandbox();
  w.document.body.innerHTML =
    '<div id="w"><table data-sort="t"><thead><tr><th>이름</th><th class="r">금액</th></tr></thead><tbody>' +
    '<tr><td>B</td><td>1,000.00</td></tr>' +
    '<tr><td>A</td><td>-</td></tr>' +
    '<tr><td>C</td><td>250.00</td></tr>' +
    '<tr><td>D</td><td>20,000.00</td></tr>' +
    '</tbody></table></div>';
  w.RTSort.apply(w.document.getElementById('w'));
  assert.deepEqual(rowsOf(w, 'table', 0), ['B', 'A', 'C', 'D']);   // 초기엔 그대로

  clickTh(w, 'table', 1);                                          // 금액 ▲
  assert.deepEqual(rowsOf(w, 'table', 0), ['C', 'B', 'D', 'A']);
  clickTh(w, 'table', 1);                                          // 금액 ▼
  assert.deepEqual(rowsOf(w, 'table', 0), ['D', 'B', 'C', 'A']);   // 빈 값(A)은 여전히 끝
  clickTh(w, 'table', 0);                                          // 이름 ▲
  assert.deepEqual(rowsOf(w, 'table', 0), ['A', 'B', 'C', 'D']);
});

test('텍스트 정렬은 자연수 정렬(PRO2 < PRO10)', () => {
  const w = sandbox();
  w.document.body.innerHTML =
    '<table data-sort="t"><thead><tr><th>코드</th></tr></thead><tbody>' +
    '<tr><td>PRO10</td></tr><tr><td>PRO2</td></tr><tr><td>PRO1</td></tr></tbody></table>';
  w.RTSort.apply(w.document.body);
  clickTh(w, 'table', 0);
  assert.deepEqual(rowsOf(w, 'table', 0), ['PRO1', 'PRO2', 'PRO10']);
});

test('펼침 상세행(tr.sub)은 본행에 붙어 함께 이동한다', () => {
  const w = sandbox();
  w.document.body.innerHTML =
    '<table data-sort="t"><thead><tr><th>이름</th><th class="r">값</th></tr></thead><tbody>' +
    '<tr><td>A</td><td>3</td></tr><tr class="sub"><td colspan="2">A-detail</td></tr>' +
    '<tr><td>B</td><td>1</td></tr>' +
    '<tr><td>C</td><td>2</td></tr><tr class="sub"><td colspan="2">C-detail</td></tr>' +
    '</tbody></table>';
  w.RTSort.apply(w.document.body);
  clickTh(w, 'table', 1);
  const all = Array.from(w.document.querySelector('tbody').rows).map((r) => r.textContent.trim());
  assert.deepEqual(all, ['B1', 'C2', 'C-detail', 'A3', 'A-detail']);
});

test('data-nosort 열은 클릭해도 정렬되지 않는다', () => {
  const w = sandbox();
  w.document.body.innerHTML =
    '<table data-sort="t"><thead><tr><th>이름</th><th data-nosort>작업</th></tr></thead><tbody>' +
    '<tr><td>C</td><td>x</td></tr><tr><td>A</td><td>y</td></tr></tbody></table>';
  w.RTSort.apply(w.document.body);
  const th = w.document.querySelector('thead tr').cells[1];
  assert.equal(th.hasAttribute('data-rts'), false);
  clickTh(w, 'table', 1);
  assert.deepEqual(rowsOf(w, 'table', 0), ['C', 'A']);
});

test('정렬 상태는 data-sort 키 단위로 유지되어 재렌더 후에도 재적용된다', () => {
  const w = sandbox();
  const box = w.document.createElement('div');
  w.document.body.appendChild(box);
  const paint = () => {
    box.innerHTML =
      '<table data-sort="keep"><thead><tr><th>이름</th><th class="r">값</th></tr></thead><tbody>' +
      '<tr><td>A</td><td>3</td></tr><tr><td>B</td><td>1</td></tr><tr><td>C</td><td>2</td></tr>' +
      '</tbody></table>';
    w.RTSort.apply(box);
  };
  paint();
  clickTh(w, 'table', 1);
  assert.deepEqual(rowsOf(w, 'table', 0), ['B', 'C', 'A']);
  paint();                                        // 표를 통째로 다시 그림
  assert.deepEqual(rowsOf(w, 'table', 0), ['B', 'C', 'A']);
  const th = w.document.querySelector('thead tr').cells[1];
  assert.equal(th.getAttribute('data-rts-active'), '1');
  assert.ok(th.textContent.includes('▲'));
});

// ------------------------------------------------------- 통합: 매출확정목록
function bootFunnel(routes) {
  const dom = new JSDOM(inlineSort(FUNNEL), {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://x.test/#token=T&api=https://api.test&user=' +
      encodeURIComponent(JSON.stringify({ name: 'D', role: 'director' })) + '&tab=immediate&months=2026-08',
  });
  const w = dom.window;
  w.fetch = async (url) => {
    const u = String(url);
    for (const [re, body] of routes) if (re.test(u)) return { ok: true, status: 200, json: async () => body };
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  return w;
}

const DONE = [
  { invoice_id: 1, quote_no: 'Q-003', inv_date: '2026-08-02', sat_no: 'A1', customer_name: '가나상사', owner_name: '박', inv_sku: 3, inv_qty: 30, total_mxn: 1000 },
  { invoice_id: 2, quote_no: 'Q-001', inv_date: '2026-08-20', sat_no: 'B2', customer_name: '다라산업', owner_name: '김', inv_sku: 1, inv_qty: 5, total_mxn: 25000.5 },
  { invoice_id: 3, quote_no: 'Q-002', inv_date: '2026-08-11', sat_no: '', temp_sat: true, customer_name: '마바테크', owner_name: '', inv_sku: 9, inv_qty: 120, total_mxn: 300 },
];

test('통합(매출확정목록): 총액·인보이스일 제목 클릭으로 정렬된다', async () => {
  const w = bootFunnel([[/funnel\/immediate/, { able: [], done: DONE, can_filter: false }]]);
  await settle(w, 40);
  const sel = 'table[data-sort="funnel:done"]';
  assert.ok(w.document.querySelector(sel), '매출확정목록 표가 렌더되어야 함');
  assert.deepEqual(rowsOf(w, sel, 0), ['Q-003', 'Q-001', 'Q-002']);   // 서버 순서 그대로

  clickTh(w, sel, 7);                                                 // 총액 ▲
  assert.deepEqual(rowsOf(w, sel, 0), ['Q-002', 'Q-003', 'Q-001']);
  clickTh(w, sel, 7);                                                 // 총액 ▼
  assert.deepEqual(rowsOf(w, sel, 0), ['Q-001', 'Q-003', 'Q-002']);

  clickTh(w, sel, 1);                                                 // 인보이스일 ▲
  assert.deepEqual(rowsOf(w, sel, 0), ['Q-003', 'Q-002', 'Q-001']);

  clickTh(w, sel, 3);                                                 // 고객 ▲ (한국어)
  assert.deepEqual(rowsOf(w, sel, 3), ['가나상사', '다라산업', '마바테크']);
});

test('통합(매출확정목록): 정렬 후 행을 펼쳐도 정렬과 상세행 위치가 유지된다', async () => {
  const w = bootFunnel([
    [/funnel\/immediate/, { able: [], done: DONE, can_filter: false }],
    [/funnel\/invoice-lines/, { invoice: { subtotal_mxn: 100, iva_mxn: 16, total_mxn: 116, sat_no: 'A1' }, items: [{ ctr_code: 'CB0001', product_name: 'p', qty: 1, unit_price: 100, line_amount_mxn: 100 }] }],
  ]);
  await settle(w, 40);
  const sel = 'table[data-sort="funnel:done"]';
  clickTh(w, sel, 7);                       // 총액 ▲ → Q-002, Q-003, Q-001
  w.toggleInvoice(3);                       // 맨 위(Q-002) 펼치기
  await settle(w, 40);
  assert.deepEqual(rowsOf(w, sel, 0), ['Q-002', 'Q-003', 'Q-001'], '재렌더 후에도 정렬 유지');
  const rows = Array.from(w.document.querySelector(sel + ' tbody').rows);
  assert.ok(/(^|\s)sub(\s|$)/.test(rows[1].className), '상세행은 펼친 본행 바로 아래');
  assert.ok(w.document.querySelector('table[data-sort="funnel:invlines"]'), '상세 SKU 표도 정렬 대상');
});

// ------------------------------------------------------- 통합: 견적·매출 추적
test('통합(견적·매출 추적): 견적액·견적일 제목 클릭으로 정렬되고 작업 열은 제외된다', async () => {
  const dom = new JSDOM(inlineSort(QLIST), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://x.test/' });
  const w = dom.window;
  w.session = { token: 'T', user: { name: 'D', role: 'director' }, api: 'https://api.test' };
  w.qRowsById = w.qRowsById || {};
  w.render([
    { id: 1, quote_no: 'Q-A', quote_date: '2026-08-10', party_name: '나상사', creator_name: '김', sku_count: 2, total_qty: 20, total_mxn: 5000, status: 'confirmed' },
    { id: 2, quote_no: 'Q-B', quote_date: '2026-08-01', party_name: '가상사', creator_name: '박', sku_count: 7, total_qty: 70, total_mxn: 120000, status: 'draft' },
    { id: 3, quote_no: 'Q-C', quote_date: '2026-08-22', party_name: '다상사', creator_name: '이', sku_count: 1, total_qty: 3, total_mxn: 900, status: 'converted', sale_date: '2026-08-23', sale_total: 900 },
  ]);
  const sel = 'table[data-sort="quotelist:main"]';
  assert.ok(w.document.querySelector(sel));
  assert.deepEqual(rowsOf(w, sel, 0), ['Q-A', 'Q-B', 'Q-C']);

  clickTh(w, sel, 7);                                   // 견적액 ▲
  assert.deepEqual(rowsOf(w, sel, 0), ['Q-C', 'Q-A', 'Q-B']);
  clickTh(w, sel, 7);                                   // 견적액 ▼
  assert.deepEqual(rowsOf(w, sel, 0), ['Q-B', 'Q-A', 'Q-C']);
  clickTh(w, sel, 1);                                   // 견적일 ▲
  assert.deepEqual(rowsOf(w, sel, 0), ['Q-B', 'Q-A', 'Q-C']);
  clickTh(w, sel, 1);                                   // 견적일 ▼
  assert.deepEqual(rowsOf(w, sel, 0), ['Q-C', 'Q-A', 'Q-B']);

  // 매출일 열: 미전환은 방향과 무관하게 뒤로
  clickTh(w, sel, 9);
  assert.deepEqual(rowsOf(w, sel, 0)[0], 'Q-C');
  clickTh(w, sel, 9);
  assert.deepEqual(rowsOf(w, sel, 0)[0], 'Q-C');

  const ths = w.document.querySelector(sel + ' thead tr').cells;
  assert.equal(ths[6].hasAttribute('data-rts'), false, '수주현황 열 정렬 제외');
  assert.equal(ths[10].hasAttribute('data-rts'), false, '작업 열 정렬 제외');
});
