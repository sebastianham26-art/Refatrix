// =====================================================================
// 재무 > 거래목록 「거래 후 잔고」 열 — refatrix-finance.html 을 jsdom 에서 구동해 검증 (build fin-0930bal)
//   디렉터 요청(2026-09-30): 집행금액만 보이고 거래 후 잔고가 안 보여, 잔고가 틀렸을 때
//   어느 거래부터 어긋났는지 추적할 수 없다.
//   화면 규칙:
//     · 서버가 balance_after 를 주면(응답 balance_after:true) 「거래 후 잔고」 열을 금액 옆에 그린다.
//     · 실적+승인 → 잔고 값(계좌 통화 표기, 음수는 빨강) / 예정·계좌없음 → — / 미승인 → 「승인 후 반영」
//     · 구백엔드(balance_after 플래그 없음)면 열 자체를 그리지 않는다(빈 열 방지).
//     · 계좌 하나를 고르면 요약줄에 「현재 잔고」를 함께 보여 준다.
// =====================================================================
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const HTML = readFileSync(new URL('../../refatrix-finance.html', import.meta.url), 'utf8');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const ACCOUNTS = [
  { id: 1, name: 'BBVA', currency: 'MXN', balance: 14200, balance_mxn: 14200, can_detail: true },
  { id: 2, name: 'Banorte USD', currency: 'USD', balance: 400.5, balance_mxn: 7209, can_detail: true },
];
const base = { category_code: '6030', category_name: '기타', kind: 'general', recurring_rule_id: null,
  sales_invoice_id: null, source: 'manual', change_count: 0, edit_count: 0, editable: true, fx_rate: 1, currency: 'MXN' };
const ITEMS = [
  { ...base, id: 9, account_id: 1, account_name: 'BBVA', txn_date: '2026-09-09', direction: 'in', amount: 100, amount_mxn: 100, status: 'actual', approved: true, balance_after: 14200 },
  { ...base, id: 8, account_id: 1, account_name: 'BBVA', txn_date: '2026-09-07', direction: 'out', amount: 777, amount_mxn: 777, status: 'actual', approved: false, balance_after: null },
  { ...base, id: 7, account_id: 1, account_name: 'BBVA', txn_date: '2026-09-06', direction: 'out', amount: 999, amount_mxn: 999, status: 'plan', approved: true, balance_after: null },
  { ...base, id: 6, account_id: 2, account_name: 'Banorte USD', currency: 'USD', fx_rate: 18, txn_date: '2026-09-04', direction: 'in', amount: 20.5, amount_mxn: 369, status: 'actual', approved: true, balance_after: 400.5 },
  { ...base, id: 5, account_id: null, account_name: null, txn_date: '2026-09-03', direction: 'out', amount: 300, amount_mxn: 300, status: 'plan', approved: true, balance_after: null, memo: '[마케팅] X' },
  { ...base, id: 4, account_id: 1, account_name: 'BBVA', txn_date: '2026-09-02', direction: 'out', amount: 20000, amount_mxn: 20000, status: 'actual', approved: true, balance_after: -3500 },
];

function boot({ legacy = false, director = true } = {}) {
  const calls = [];
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  const j = (o) => ({ ok: true, status: 200, json: async () => o });
  w.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (u.includes('/api/transactions?') && !u.includes('export')) {
      const items = JSON.parse(JSON.stringify(ITEMS));
      if (legacy) return j({ items: items.map(({ balance_after, ...t }) => t) });
      return j({ limit: 200, offset: 0, has_more: false, balance_after: true, items });
    }
    if (u.includes('/api/accounts')) return j({ items: JSON.parse(JSON.stringify(ACCOUNTS)) });
    return j({ items: [] });
  };
  w.alert = () => {};
  w.eval(`session={token:'t',user:{id:1,name:'Dir',role:'${director ? 'director' : 'treasury'}'},api:''}; accounts=${JSON.stringify(ACCOUNTS)}; fxRate=18;`);
  return { w, calls };
}
const headers = (w) => Array.from(w.document.querySelectorAll('#txnBody thead th')).map((h) => h.textContent.trim());
const balCell = (w, id) => w.document.querySelector(`#txnBody tr.txn-row[data-id="${id}"] td.txn-bal`);

test('① 「거래 후 잔고」 열이 금액 바로 오른쪽에 생긴다', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  const h = headers(w);
  const iAmt = h.findIndex((x) => x.startsWith('금액'));
  assert.ok(iAmt >= 0);
  assert.equal(h[iAmt + 1], '거래 후 잔고');
});

test('② 실적·승인 행은 잔고 값 + 계좌 통화', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  assert.match(balCell(w, 9).textContent, /14,200\.00\s*MXN/);
  assert.match(balCell(w, 6).textContent, /400\.50\s*USD/, 'USD 계좌는 USD 잔고');
});

test('③ 예정·계좌없음은 —, 미승인은 「승인 후 반영」', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  assert.equal(balCell(w, 7).textContent.trim(), '—');
  assert.equal(balCell(w, 5).textContent.trim(), '—');
  assert.match(balCell(w, 8).textContent, /승인 후 반영/);
});

test('④ 음수 잔고는 빨강으로 강조', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  const span = balCell(w, 4).querySelector('span');
  assert.match(span.getAttribute('style') || '', /var\(--expense\)/);
  assert.match(balCell(w, 4).textContent, /-3,500\.00|−3,500\.00/);
});

test('⑤ 세부 행(colspan)이 열 수와 맞는다', async () => {
  const { w } = boot(); await w.loadTxns(); await tick();
  const nTh = w.document.querySelectorAll('#txnBody thead th').length;
  const det = w.document.querySelector('#txnBody tr.txn-det td');
  assert.equal(Number(det.getAttribute('colspan')), nTh);
});

test('⑥ 구백엔드(balance_after 플래그 없음)면 열을 그리지 않는다', async () => {
  const { w } = boot({ legacy: true }); await w.loadTxns(); await tick();
  assert.equal(headers(w).includes('거래 후 잔고'), false);
  assert.equal(w.document.querySelectorAll('#txnBody td.txn-bal').length, 0);
  const nTh = w.document.querySelectorAll('#txnBody thead th').length;
  assert.equal(Number(w.document.querySelector('#txnBody tr.txn-det td').getAttribute('colspan')), nTh);
});

test('⑦ 계좌 하나를 고르면 요약줄에 현재 잔고, 전체 계좌면 없음', async () => {
  const a = boot(); await a.w.loadTxns(); await tick();
  assert.doesNotMatch(a.w.document.getElementById('txnSummary').textContent, /현재 잔고/);
  const b = boot();
  const sel = b.w.document.getElementById('f-acc');
  const o = b.w.document.createElement('option'); o.value = '1'; o.textContent = 'BBVA'; sel.appendChild(o); sel.value = '1';
  await b.w.loadTxns(); await tick();
  assert.match(b.w.document.getElementById('txnSummary').textContent, /현재 잔고\s*14,200\.00 MXN/);
});

test('⑧ 비디렉터(재무)도 같은 열을 본다', async () => {
  const { w } = boot({ director: false }); await w.loadTxns(); await tick();
  assert.ok(headers(w).includes('거래 후 잔고'));
});

test('⑨ 필터 변경 이벤트가 「이어붙이기」로 오작동하지 않는다(offset=0 재조회)', async () => {
  const { w, calls } = boot(); await w.loadTxns(); await tick();
  w.document.getElementById('f-dir').value = 'out';
  w.document.getElementById('f-dir').dispatchEvent(new w.Event('change'));
  await tick(20);
  const last = calls.filter((u) => u.includes('/api/transactions?')).pop();
  assert.match(last, /offset=0/);
  assert.match(last, /direction=out/);
});

test('⑩ 빌드 마커', () => {
  assert.match(HTML, /build fin-0930bal/);
});
