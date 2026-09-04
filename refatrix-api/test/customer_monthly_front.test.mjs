// =====================================================================
// refatrix-customers.html 「📈 월별 견적·매출·수금」 프런트 (jsdom, 2026-09-04)
//   목록 행 버튼 → 모달 · 고객 상세 카드 · 연도 ◀▶ · 합계행 · 잠금 · 경합 가드 ·
//   엑셀 페이로드 · XSS.
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-customers.html', import.meta.url), 'utf8');

let dom, win, fetchLog, fetchRoutes;
function route(method, urlPart, payload, status = 200) { fetchRoutes.push({ method, urlPart, payload, status }); }

function months(fill = {}) {
  const out = [];
  for (let i = 1; i <= 12; i++) {
    out.push({
      month: i, ym: `2026-${String(i).padStart(2, '0')}`,
      quote_count: 0, quote_amount: 0, quote_converted_count: 0, quote_converted_amount: 0,
      sales_count: 0, sales_amount: 0, sales_amount_incl: 0,
      collect_count: 0, collect_amount: 0, collect_amount_incl: 0,
      nc_amount: 0, nc_amount_incl: 0, advance_amount_incl: 0,
      settled_count: 0, delay_avg: null,
      ...(fill[i] || {}),
    });
  }
  return out;
}
function payload(over = {}) {
  const ms = over.months || months({
    3: { quote_count: 2, quote_amount: 3000 },
    4: { quote_count: 2, quote_amount: 3500, quote_converted_count: 1, quote_converted_amount: 3000,
      sales_count: 1, sales_amount: 2500, sales_amount_incl: 2900 },
    5: { sales_count: 1, sales_amount: 1000, sales_amount_incl: 1160,
      collect_count: 1, collect_amount: 1000, collect_amount_incl: 1160,
      settled_count: 1, delay_avg: -12 },
    6: { settled_count: 2, delay_avg: 10 },
    7: { settled_count: 1, delay_avg: 0 },
  });
  return {
    customer: { id: 34, code: 'C-0034', name: 'FRENOS NORTE' },
    year: 2026, years: [2026, 2025], locked: false, months: ms,
    totals: {
      quote_count: 4, quote_amount: 6500, quote_converted_count: 1, quote_converted_amount: 3000,
      sales_count: 2, sales_amount: 3500, sales_amount_incl: 4060,
      collect_count: 1, collect_amount: 1000, collect_amount_incl: 1160,
      nc_amount: 0, nc_amount_incl: 0, advance_amount_incl: 0, conversion_pct: 46.2,
    },
    ar: { outstanding: 1240, overdue: 0 },
    delay: {
      settled_count: 4, avg_delay: 14.4, median_delay: 0, on_time_count: 3, on_time_pct: 60,
      worst: { delay: 76, sat_no: 'A-123', due_date: '2026-03-31', settled_date: '2026-06-15', amount: 580 },
      buckets: { early_ontime: 3, d1_7: 0, d8_30: 1, d30plus: 1 },
      avg_actual_days: 44.6, avg_credit_days: 30,
      open_overdue: { count: 1, amount: 1160, max_days: 62 }, open_not_due: 0,
    },
    ...over,
  };
}

beforeEach(() => {
  fetchLog = []; fetchRoutes = [];
  dom = new JSDOM(html, {
    url: 'https://example.test/refatrix-customers.html',
    runScripts: 'dangerously',
    beforeParse(w) {
      w.fetch = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        fetchLog.push({ url: String(url), method });
        const m = fetchRoutes.find((r) => r.method === method && String(url).includes(r.urlPart));
        const p = m ? m.payload : {};
        const status = m ? m.status : 200;
        if (m && m.delay) await new Promise((r) => setTimeout(r, m.delay));
        return { ok: status < 400, status, json: async () => p };
      };
      w.alert = (msg) => { w.__alert = String(msg); };
      w.XLSX = { utils: { aoa_to_sheet: (a) => ({ __aoa: a }), book_new: () => ({ sheets: [] }),
        book_append_sheet: (wb, ws, name) => { wb.sheets.push({ ws, name }); } },
      writeFile: (wb, name) => { w.__xlsx = { wb, name }; } };
    },
  });
  win = dom.window;
  win.eval("session = { token:'tok', user:{ id:2, name:'Ana', role:'director' }, api:'' };");
  win.eval('loadCustomers = async () => {}; loadRfcExempt = async () => {}; loadClaimBadge = async () => {};');
});

const $ = (id) => win.document.getElementById(id);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('① 고객 목록 행에 [📈 거래] 버튼이 붙는다', async () => {
  win.eval(`lastCustomers=[{id:34,code:'C-0034',name:'FRENOS NORTE',owner_name:'Oscar',stage_name:'견적',
    sales_total:1000,overdue:0,branch_count:1,doc_count:0}]; renderCustTable();`);
  const h = $('custList').innerHTML;
  assert.ok(h.includes('openTxnModal(34)'), '행 버튼이 그 고객 id 로 모달을 연다');
  assert.ok(h.includes('📈 거래'));
  assert.ok(h.includes('openCustomer(34)'), '기존 [열기] 버튼은 그대로');
});

test('② 모달 — 올바른 URL 로 조회하고 12개월 + 합계행을 그린다', async () => {
  route('GET', '/api/customers/34/monthly-summary', payload());
  win.openTxnModal(34); await tick();
  assert.ok($('txnModal').className.includes('on'), '모달이 열린다');
  assert.ok(fetchLog.some((f) => f.url.includes('/api/customers/34/monthly-summary')), '연도 없이 첫 조회');
  const host = $('txnModalHost');
  const rows = host.querySelectorAll('tbody tr');
  assert.equal(rows.length, 13, '12개월 + 합계 1행');
  assert.ok(host.innerHTML.includes('견적 (ex-IVA)'));
  assert.ok(host.innerHTML.includes('수금 (실입금·IVA 포함)'));
  assert.ok(host.innerHTML.includes('결제 지연'));
  assert.equal(rows[0].querySelectorAll('td').length, 8, '월 + 6개 금액/건수 + 결제 지연');
  assert.ok(rows[12].textContent.includes('합계'));
  assert.equal($('txnModalTitle').textContent, '📈 FRENOS NORTE — 월별 견적 · 매출 · 수금');
});

test('③ 금액 — ex-IVA 와 실입금이 각 칸에, 0 은 대시', async () => {
  route('GET', '/api/customers/34/monthly-summary', payload());
  win.openTxnModal(34); await tick();
  const rows = $('txnModalHost').querySelectorAll('tbody tr');
  const may = rows[4].querySelectorAll('td');           // 5월
  assert.equal(may[4].textContent.trim(), '1,000.00', '매출 ex-IVA');
  assert.equal(may[5].textContent.trim(), '1,000.00', '수금 ex-IVA');
  assert.equal(may[6].textContent.trim(), '1,160.00', '수금 실입금(IVA 포함)');
  const jan = rows[0].querySelectorAll('td');
  assert.equal(jan[2].textContent.trim(), '—', '거래 없는 달은 대시');
  const foot = rows[12].querySelectorAll('td');
  assert.equal(foot[2].textContent.trim(), '6,500.00');
  assert.equal(foot[4].textContent.trim(), '3,500.00');
});

test('④ 표 아래 — 전환율 · 미수 · (있을 때만) NC·선수금', async () => {
  route('GET', '/api/customers/34/monthly-summary', payload());
  win.openTxnModal(34); await tick();
  let h = $('txnModalHost').innerHTML;
  assert.ok(h.includes('견적 → 매출 전환'));
  assert.ok(h.includes('46.2%'));
  assert.ok(h.includes('현재 미수'));
  assert.ok(!h.includes('NC 비현금 반제'), 'NC 가 0 이면 줄이 안 나온다');
  assert.ok(!h.includes('선수금'), '선수금이 0 이면 줄이 안 나온다');

  fetchRoutes = [];
  const p = payload();
  p.totals.nc_amount = 431.03; p.totals.nc_amount_incl = 500; p.totals.advance_amount_incl = 290;
  p.ar = { outstanding: 5000, overdue: 1200 };
  route('GET', '/api/customers/34/monthly-summary', p);
  win.openTxnModal(34); await tick();
  h = $('txnModalHost').innerHTML;
  assert.ok(h.includes('NC 비현금 반제'));
  assert.ok(h.includes('선수금(미배분 입금)'));
  assert.ok(h.includes('연체 1,200.00'));
});

test('⑤ 연도 ◀▶ — 이동하면 그 해로 다시 조회, 경계에서는 비활성', async () => {
  route('GET', '/api/customers/34/monthly-summary', payload());
  win.openTxnModal(34); await tick();
  const btns = $('txnModalHost').querySelectorAll('button');
  const prev = [...btns].find((b) => b.textContent.includes('◀'));
  const next = [...btns].find((b) => b.textContent.includes('▶'));
  assert.equal(prev.disabled, false, '2025 거래가 있으므로 뒤로 갈 수 있다');
  assert.equal(next.disabled, true, '올해보다 앞으로는 못 간다');

  fetchRoutes = []; fetchLog = [];
  route('GET', '/api/customers/34/monthly-summary', payload({ year: 2025 }));
  win.txYearMove('modal', -1); await tick();
  assert.ok(fetchLog.some((f) => f.url.includes('year=2025')), 'year=2025 로 재조회');
  assert.ok($('txnModalHost').innerHTML.includes('2025'));
});

test('⑥ 고객 상세 카드 — d-txn 에 접을 수 있는 카드로 렌더', async () => {
  route('GET', '/api/customers/34/monthly-summary', payload());
  win.txLoad('card', 34, null); await tick();
  const h = $('d-txn').innerHTML;
  assert.ok(h.includes('📈 월별 견적 · 매출 · 수금'));
  assert.equal($('d-txn').querySelectorAll('tbody tr').length, 13);
  win.txToggle('card');
  assert.equal($('d-txn').querySelectorAll('tbody tr').length, 0, '접으면 표가 사라진다');
  win.txToggle('card');
  assert.equal($('d-txn').querySelectorAll('tbody tr').length, 13, '다시 펴면 돌아온다');
});

test('⑦ 잠금 — 금액 권한이 없으면 표 대신 안내', async () => {
  route('GET', '/api/customers/34/monthly-summary',
    { customer: { id: 34, code: 'C', name: 'X' }, year: 2026, years: [2026], locked: true, months: [], totals: null });
  win.openTxnModal(34); await tick();
  const h = $('txnModalHost').innerHTML;
  assert.ok(h.includes('🔒'));
  assert.equal($('txnModalHost').querySelectorAll('tbody tr').length, 0);
});

test('⑧ 오류 — 다른 팀 고객·서버 오류는 안내 문구', async () => {
  route('GET', '/api/customers/34/monthly-summary', { error: 'forbidden_team' }, 403);
  win.openTxnModal(34); await tick();
  assert.ok($('txnModalHost').textContent.includes('다른 팀 고객'));
});

test('⑨ 경합 가드 — 늦게 온 이전 고객 응답이 덮어쓰지 않는다', async () => {
  fetchRoutes.push({ method: 'GET', urlPart: '/api/customers/34/monthly-summary',
    payload: payload({ customer: { id: 34, code: 'C-0034', name: '늦은고객' } }), status: 200, delay: 60 });
  route('GET', '/api/customers/77/monthly-summary',
    payload({ customer: { id: 77, code: 'C-0077', name: '나중고객' } }));
  win.txLoad('card', 34, null);
  await tick(5);
  win.txLoad('card', 77, null);
  await tick(120);
  assert.ok($('d-txn').innerHTML.includes('월별 견적'), '표는 그려져 있고');
  assert.equal(win.eval('txViews.card.data.customer.name'), '나중고객', '마지막으로 연 고객의 데이터만 남는다');
  assert.ok(!$('d-txn').innerHTML.includes('늦은고객'));
});

test('⑩ 엑셀 — 헤더·12개월·합계가 담긴다', async () => {
  route('GET', '/api/customers/34/monthly-summary', payload());
  win.openTxnModal(34); await tick();
  win.txExcel('modal');
  const aoa = win.__xlsx.wb.sheets[0].ws.__aoa;
  assert.equal(win.__xlsx.name, 'refatrix_C-0034_2026_월별거래.xlsx');
  assert.deepEqual([...aoa[0]].slice(0, 2), ['고객', 'FRENOS NORTE']);
  assert.deepEqual([...aoa[2]], ['월', '견적 건', '견적 (ex-IVA)', '견적 전환 (ex-IVA)', '매출 건', '매출 (ex-IVA)',
    '수금 (ex-IVA)', '수금 (실입금·IVA 포함)', '완납 건', '평균 지연(일)']);
  assert.equal(aoa[3][0], '1월');
  assert.equal(aoa[14][0], '12월');
  assert.deepEqual([...aoa[15]].slice(0, 3), ['합계', 4, 6500]);
});

test('⑪ XSS — 고객명이 스크립트로 실행되지 않는다', async () => {
  route('GET', '/api/customers/34/monthly-summary',
    payload({ customer: { id: 34, code: '<img src=x>', name: '<img src=x onerror=alert(1)>' } }));
  win.openTxnModal(34); await tick();
  assert.equal($('txnModalTitle').querySelectorAll('img').length, 0, '제목은 textContent 로 넣는다');
  assert.ok($('txnModalTitle').textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(win.__alert, undefined);
});

test('⑬ 지연 — 월 행에 평균 지연과 건수, 조기는 「조기」로 표시', async () => {
  route('GET', '/api/customers/34/monthly-summary', payload());
  win.openTxnModal(34); await tick();
  const rows = $('txnModalHost').querySelectorAll('tbody tr');
  assert.equal(rows[4].querySelectorAll('td')[7].textContent.replace(/\s+/g, ' ').trim(), '12일 조기 (1건)', '5월');
  assert.equal(rows[5].querySelectorAll('td')[7].textContent.replace(/\s+/g, ' ').trim(), '+10일 (2건)', '6월');
  assert.equal(rows[6].querySelectorAll('td')[7].textContent.replace(/\s+/g, ' ').trim(), '정시 (1건)', '7월');
  assert.equal(rows[0].querySelectorAll('td')[7].textContent.trim(), '—', '완납 건 없는 달');
  assert.ok(rows[12].querySelectorAll('td')[7].textContent.includes('+14.4일'), '합계 행은 연간 평균');
});

test('⑭ 지연 — 요약 배지 · 분포 칩 · 상세 줄', async () => {
  route('GET', '/api/customers/34/monthly-summary', payload());
  win.openTxnModal(34); await tick();
  const h = $('txnModalHost').innerHTML;
  assert.ok(h.includes('평균 14.4일 늦게 결제'), '한 줄 판정');
  assert.ok(h.includes('완납 4건'));
  assert.ok(h.includes('조기·정시 3') && h.includes('8~30일 1') && h.includes('30일+ 1'), '분포 칩');
  assert.ok(h.includes('중앙값'));
  assert.ok(h.includes('정시 이상') && h.includes('60%'));
  assert.ok(h.includes('최장') && h.includes('A-123') && h.includes('2026-06-15'));
  assert.ok(h.includes('실제 결제일수 평균') && h.includes('44.6일') && h.includes('약정 외상 30일'));
});

test('⑮ 지연 — 판정 문구가 값에 따라 바뀐다 (조기·정시·지연 없음)', async () => {
  const cases = [
    [-3.2, '평균 3.2일 일찍 결제'],
    [0, '정시 결제'],
    [2, '평균 2일 늦게 결제'],
  ];
  for (const [avg, txt] of cases) {
    fetchRoutes = [];
    const p = payload(); p.delay.avg_delay = avg;
    route('GET', '/api/customers/34/monthly-summary', p);
    win.openTxnModal(34); await tick();
    assert.ok($('txnModalHost').innerHTML.includes(txt), txt);
  }
  fetchRoutes = [];
  const none = payload();
  none.delay = { settled_count: 0, avg_delay: null, median_delay: null, on_time_count: 0, on_time_pct: null,
    worst: null, buckets: { early_ontime: 0, d1_7: 0, d8_30: 0, d30plus: 0 },
    avg_actual_days: null, avg_credit_days: null, open_overdue: { count: 0, amount: 0, max_days: null }, open_not_due: 0 };
  route('GET', '/api/customers/34/monthly-summary', none);
  win.openTxnModal(34); await tick();
  const h = $('txnModalHost').innerHTML;
  assert.ok(h.includes('완납된 건이 없어 지연을 잴 수 없습니다'));
  assert.ok(!h.includes('조기·정시 0'), '완납이 없으면 분포 칩도 안 나온다');
});

test('⑯ 지연 — 아직 안 낸 연체는 빨간 경고로 따로', async () => {
  route('GET', '/api/customers/34/monthly-summary', payload());
  win.openTxnModal(34); await tick();
  const h = $('txnModalHost').innerHTML;
  assert.ok(h.includes('아직 안 낸 연체 1건'));
  assert.ok(h.includes('62일 경과'));
  assert.ok(h.includes('평균 지연에는 안 들어갑니다'));

  fetchRoutes = [];
  const p = payload(); p.delay.open_overdue = { count: 0, amount: 0, max_days: null };
  route('GET', '/api/customers/34/monthly-summary', p);
  win.openTxnModal(34); await tick();
  assert.ok(!$('txnModalHost').innerHTML.includes('아직 안 낸 연체'), '연체가 없으면 경고도 없다');
});

test('⑰ 엑셀 — 지연 컬럼과 요약 블록이 담긴다', async () => {
  route('GET', '/api/customers/34/monthly-summary', payload());
  win.openTxnModal(34); await tick();
  win.txExcel('modal');
  const aoa = win.__xlsx.wb.sheets[0].ws.__aoa.map((r) => [...r]);
  assert.deepEqual(aoa[2].slice(-2), ['완납 건', '평균 지연(일)']);
  assert.deepEqual(aoa[7].slice(-2), [1, -12], '5월 행 (완납 1건 · −12일)');
  assert.deepEqual(aoa[15].slice(-2), [4, 14.4], '합계 행');
  const flat = aoa.map((r) => r.join('|')).join('\n');
  assert.ok(flat.includes('결제 지연 요약'));
  assert.ok(flat.includes('지연 분포(건)'));
  assert.ok(flat.includes('최장 지연'));
  assert.ok(flat.includes('아직 안 낸 연체(건)'));
});

test('⑫ 모달 닫기', async () => {
  route('GET', '/api/customers/34/monthly-summary', payload());
  win.openTxnModal(34); await tick();
  win.closeTxnModal();
  assert.ok(!$('txnModal').className.includes('on'));
});
