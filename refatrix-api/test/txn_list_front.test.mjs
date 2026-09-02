// =====================================================================
// 재무 > 거래목록 「출처」 열 + 계좌미지정 필터 — refatrix-finance.html 인라인 JS 를
// jsdom 에서 실제로 구동해 검증한다 (build fin-0902r).
//   요구(디렉터): "거래목록에 고정비 외에도 마케팅과 같은 지출계획도 나와야 한다."
//   → 마케팅·수금 계획은 계좌가 없어 계좌 열이 '—' 라 눈에 안 띄었다. 출처 배지로 구분하고,
//     계좌 필터의 「(계좌 미지정)」으로 그 계획들만 모아 볼 수 있게 했다.
// =====================================================================
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const HTML = readFileSync(new URL('../../refatrix-finance.html', import.meta.url), 'utf8');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const ACCOUNTS = [{ id: 1, name: 'BBVA', currency: 'MXN', balance: 0, balance_mxn: 0, can_detail: true }];

// 백엔드가 source 를 내려주는 최신 형태
const TXNS = [
  { id: 101, txn_date: '2026-09-15', direction: 'out', amount: 10000, amount_mxn: 10000, fx_rate: 1, currency: 'MXN',
    category_code: '6020', category_name: '임차료', status: 'plan', kind: 'general', approved: true,
    memo: '[고정비] renta bodega', account_id: 1, account_name: 'BBVA', recurring_rule_id: 5,
    sales_invoice_id: null, source: 'recurring', change_count: 0, edit_count: 0, editable: true },
  { id: 102, txn_date: '2026-09-20', direction: 'out', amount: 3000, amount_mxn: 3000, fx_rate: 1, currency: 'MXN',
    category_code: '6070', category_name: '마케팅비', status: 'plan', kind: 'general', approved: true,
    memo: '[마케팅] 전시회 · 일시불 · Expo', account_id: null, account_name: null, recurring_rule_id: null,
    sales_invoice_id: null, source: 'marketing', change_count: 0, edit_count: 0, editable: true },
  { id: 103, txn_date: '2026-09-05', direction: 'out', amount: 1500, amount_mxn: 1500, fx_rate: 1, currency: 'MXN',
    category_code: '6030', category_name: '기타', status: 'actual', kind: 'general', approved: true,
    memo: '사무용품', account_id: 1, account_name: 'BBVA', recurring_rule_id: null,
    sales_invoice_id: null, source: 'manual', change_count: 0, edit_count: 0, editable: true },
  { id: 104, txn_date: '2026-09-01', direction: 'in', amount: 11600, amount_mxn: 11600, fx_rate: 1, currency: 'MXN',
    category_code: '4010', category_name: '제품 매출', status: 'plan', kind: 'general', approved: true,
    memo: null, sat_no: 'A-1', customer_name: 'Cliente A', account_id: null, account_name: null,
    recurring_rule_id: null, sales_invoice_id: 77, source: 'sales', change_count: 0, edit_count: 0, editable: false },
];
// 구백엔드(source 없음) — 프런트가 메모·링크로 보완하는지 확인용
const TXNS_LEGACY = TXNS.map(({ source, ...rest }) => rest);

function boot({ director = true, txns = TXNS } = {}) {
  const calls = [];
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  const j = (o, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => o });
  w.fetch = async (url, opt = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (opt.method || 'GET').toUpperCase() });
    if (u.includes('/api/transactions?') || /\/api\/transactions$/.test(u.split('?')[0]) && !u.includes('pending')) {
      return j({ items: JSON.parse(JSON.stringify(txns)) });
    }
    if (u.includes('/api/accounts')) return j({ items: JSON.parse(JSON.stringify(ACCOUNTS)) });
    return j({ items: [] });
  };
  w.alert = () => {};
  w.eval(`session={token:'t',user:{id:1,name:'Dir',role:'${director ? 'director' : 'treasury'}'},api:''}; accounts=${JSON.stringify(ACCOUNTS)};`);
  return { w, calls };
}

const headers = (w) => Array.from(w.document.querySelectorAll('#txnBody thead th')).map((h) => h.textContent.trim());
const rows = (w) => Array.from(w.document.querySelectorAll('#txnBody tbody tr.txn-row'));
const cellText = (w, id, idx) => {
  const r = rows(w).find((x) => x.dataset.id === String(id));
  return r ? r.cells[idx].textContent.trim() : null;
};
// 디렉터에게는 맨 앞에 예정 선택 체크박스 열이 붙는다(계획 삭제용) → 열 위치가 1 밀린다.
const hasSel = (w) => !!w.document.getElementById('txn-selall');
const SRC = (w) => (hasSel(w) ? 4 : 3);   // 일자·구분·계좌 다음
const ACC = (w) => (hasSel(w) ? 3 : 2);

test('① 「출처」 열이 계좌 다음에 생긴다 (디렉터는 선택 체크박스 열이 앞에 하나 더)', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  const h = headers(w);
  assert.equal(h.length, 11, '체크박스 + 10열');
  assert.equal(h[SRC(w)], '출처');
  assert.deepEqual(h.slice(1, 4), ['일자', '구분', '계좌']);

  const fin = boot({ director: false }); await fin.w.loadTxns(); await tick();
  assert.equal(headers(fin.w).length, 10, '비디렉터는 체크박스 열 없음');
  assert.equal(headers(fin.w)[SRC(fin.w)], '출처');
});

test('② 행마다 출처 배지가 정확하다 — 고정비·마케팅·수동·매출', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  assert.equal(cellText(w, 101, SRC(w)), '고정비');
  assert.equal(cellText(w, 102, SRC(w)), '마케팅');
  assert.equal(cellText(w, 103, SRC(w)), '수동');
  assert.equal(cellText(w, 104, SRC(w)), '매출');
});

test('③ 마케팅 지출계획 행이 실제로 렌더된다(계좌 없음 = —)', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  const r = rows(w).find((x) => x.dataset.id === '102');
  assert.ok(r, '마케팅 예정 행 존재');
  assert.equal(r.cells[ACC(w)].textContent.trim(), '—', '계좌 열은 —');
  assert.match(r.textContent, /마케팅비/);
  assert.match(r.textContent, /예정/);
});

test('④ 구백엔드(source 미제공)에서도 메모·링크로 출처를 판별한다', async () => {
  const { w } = boot({ txns: TXNS_LEGACY }); await w.loadTxns(); await tick();
  assert.equal(cellText(w, 101, SRC(w)), '고정비');
  assert.equal(cellText(w, 102, SRC(w)), '마케팅', '[마케팅] 메모 접두사로 판별');
  assert.equal(cellText(w, 104, SRC(w)), '매출');
});

test('⑤ 계좌 필터에 「(계좌 미지정)」 옵션이 있고, 고르면 account_id=none 으로 조회한다', async () => {
  const ctx = boot();
  await ctx.w.loadAccounts(); await tick();
  const opts = Array.from(ctx.w.document.getElementById('f-acc').options).map((o) => o.value);
  assert.ok(opts.includes('none'), '(계좌 미지정) 옵션');
  assert.match(Array.from(ctx.w.document.getElementById('f-acc').options)
    .find((o) => o.value === 'none').textContent, /마케팅 지출계획/);
  ctx.w.document.getElementById('f-acc').value = 'none';
  await ctx.w.loadTxns(); await tick();
  assert.ok(ctx.calls.some((c) => c.url.includes('account_id=none')), 'account_id=none 전송');
  assert.match(ctx.w.document.getElementById('txnSummary').textContent, /계좌 미지정/);
});

test('⑥ 상세(펼침) 행의 colspan 이 열 수와 맞는다', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  const det = w.document.querySelector('#txnBody tbody tr.txn-det td');
  assert.equal(det.getAttribute('colspan'), '11', '체크박스 열 포함');
});

test('⑦ 출처 열 제목 클릭으로 정렬된다(3회째 기본순서 복귀)', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  const th = () => w.document.querySelector('#txnBody thead th[data-sort="src"]');
  const before = rows(w).map((r) => r.dataset.id);
  th().dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await tick();
  const asc = rows(w).map((r) => r.dataset.id);
  assert.deepEqual(rows(w).map((r) => r.cells[SRC(w)].textContent.trim()), ['고정비', '마케팅', '매출', '수동']);
  th().dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await tick();
  assert.deepEqual(rows(w).map((r) => r.dataset.id), asc.slice().reverse());
  th().dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await tick();
  assert.deepEqual(rows(w).map((r) => r.dataset.id), before, '기본순서 복귀');
});

test('⑧ 마케팅 예정 행을 열면 예정 전용 패널(계획 수정·예정 삭제)이 뜬다', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  rows(w).find((r) => r.dataset.id === '102').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(15);
  const body = w.document.querySelector('#txnBody .txn-det-body[data-id="102"]');
  assert.match(body.textContent, /계획 수정/);
  assert.match(body.textContent, /예정 삭제/, '디렉터는 여기서도 예정을 지울 수 있다');
});

test('⑨ 빌드 마커', () => {
  assert.match(HTML, /build fin-0902r/);
});
