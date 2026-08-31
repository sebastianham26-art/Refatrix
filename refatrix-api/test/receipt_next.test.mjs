// =====================================================================
// 영수증 번호 「다음 번호」 제안 — 순수 함수 + 거래등록 화면 동작 검증 (2026-08-31)
//   실행: node --test test/receipt_next.test.mjs        (jsdom 필요)
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { nextReceiptNo, RECEIPT_NO_MAX } from '../src/receiptNo.js';

// ---------- ① 순수 함수 ----------
test('맨 뒤 숫자 덩어리를 +1 하고 접두사를 보존한다', () => {
  assert.equal(nextReceiptNo('A-12345'), 'A-12346');
  assert.equal(nextReceiptNo('12345'), '12346');
  assert.equal(nextReceiptNo('FAC 900'), 'FAC 901');
});

test('앞자리 0 채움 폭을 유지한다', () => {
  assert.equal(nextReceiptNo('F0087'), 'F0088');
  assert.equal(nextReceiptNo('0099'), '0100');
  assert.equal(nextReceiptNo('009'), '010');
});

test('폭이 모자라면 자리수가 늘어난다', () => {
  assert.equal(nextReceiptNo('99'), '100');
  assert.equal(nextReceiptNo('A-9'), 'A-10');
});

test('숫자가 여러 덩어리면 맨 뒤 덩어리만 올린다(연도 보존)', () => {
  assert.equal(nextReceiptNo('REC-2026-0012'), 'REC-2026-0013');
  assert.equal(nextReceiptNo('2026/08/0001'), '2026/08/0002');
});

test('숫자 뒤에 꼬리표가 붙어 있어도 뒤 덩어리를 올린다', () => {
  assert.equal(nextReceiptNo('A-12345 (1)'), 'A-12345 (2)'); // ⚠ 알려진 한계 — 괄호 안이 올라간다, 사람이 고침
  assert.equal(nextReceiptNo('B-77-MX'), 'B-78-MX');
});

test('숫자가 없거나 빈 값이면 제안하지 않는다(null)', () => {
  assert.equal(nextReceiptNo('FACTURA'), null);
  assert.equal(nextReceiptNo(''), null);
  assert.equal(nextReceiptNo('   '), null);
  assert.equal(nextReceiptNo(null), null);
  assert.equal(nextReceiptNo(undefined), null);
});

test('앞뒤 공백은 정리하고, 비정상적으로 긴 숫자는 제안하지 않는다', () => {
  assert.equal(nextReceiptNo('  A-1  '), 'A-2');
  assert.equal(nextReceiptNo('1234567890123456'), null); // 16자리 — 번호로 보지 않음
});

test('저장 한도(60자)를 넘기는 결과는 제안하지 않는다', () => {
  const long = 'X'.repeat(RECEIPT_NO_MAX - 2) + '99'; // +1 하면 61자
  assert.equal(long.length, RECEIPT_NO_MAX);
  assert.equal(nextReceiptNo(long), null);
});

// ---------- ② 거래등록 화면 (refatrix-finance.html 인라인 JS 를 jsdom 에서 실제 실행) ----------
const HTML = readFileSync(new URL('../../refatrix-finance.html', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 5));

function boot({ reply = { suggest: 'A-12346', last: { receipt_no: 'A-12345', txn_date: '2026-08-29', visible: true, category_name: '소모품비', memo: '문구류' } }, status = 200 } = {}) {
  const calls = [];
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  w.fetch = async (url, opt = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (opt.method || 'GET').toUpperCase(), body: opt.body ? JSON.parse(opt.body) : null });
    const j = (o, ok = true, st = 200) => ({ ok, status: st, json: async () => o });
    if (u.includes('/api/transactions/receipt-next')) {
      return status === 200 ? j(reply) : j({ error: 'not_found' }, false, status);
    }
    return j({ items: [] });
  };
  w.eval("session={token:'t',user:{id:1,name:'디렉터'},api:''};");
  return { w, calls };
}

test('거래등록 화면을 열면 제안 번호가 영수증 칸에 채워지고 근거가 보인다', async () => {
  const { w, calls } = boot();
  await w.loadRcptSuggest();
  await tick();
  assert.equal(w.document.getElementById('t-receipt').value, 'A-12346');
  const hint = w.document.getElementById('t-rcpt-hint').textContent;
  assert.match(hint, /직전 A-12345/);
  assert.match(hint, /08\/29/);
  assert.match(hint, /소모품비/);
  assert.match(hint, /그대로 두면 이 번호로 등록/);
  assert.equal(calls.filter((c) => c.url.includes('receipt-next')).length, 1);
});

test('사람이 이미 써 넣은 번호는 절대 덮어쓰지 않는다', async () => {
  const { w, calls } = boot();
  w.document.getElementById('t-receipt').value = 'MI-777';
  await w.loadRcptSuggest();
  await tick();
  assert.equal(w.document.getElementById('t-receipt').value, 'MI-777');
  assert.equal(calls.filter((c) => c.url.includes('receipt-next')).length, 0, '호출조차 하지 않음');
  assert.match(w.document.getElementById('t-rcpt-hint').textContent, /직접 입력한 번호로 등록/);
});

test('제안값을 손으로 고치면 안내가 「직접 입력」으로 바뀐다', async () => {
  const { w } = boot();
  await w.loadRcptSuggest();
  await tick();
  const inp = w.document.getElementById('t-receipt');
  inp.value = 'A-19999';
  inp.dispatchEvent(new w.Event('input'));
  assert.match(w.document.getElementById('t-rcpt-hint').textContent, /직접 입력한 번호로 등록/);
});

test('칸을 비우면 「영수증 번호 없이 등록」 안내로 바뀐다', async () => {
  const { w } = boot();
  await w.loadRcptSuggest();
  await tick();
  const inp = w.document.getElementById('t-receipt');
  inp.value = '';
  inp.dispatchEvent(new w.Event('input'));
  assert.match(w.document.getElementById('t-rcpt-hint').textContent, /영수증 번호 없이 등록/);
});

test('「↻ 다시 제안」을 누르면 칸을 비우고 다시 채운다', async () => {
  const { w, calls } = boot();
  await w.loadRcptSuggest();
  await tick();
  const inp = w.document.getElementById('t-receipt');
  inp.value = 'ZZZ';
  inp.dispatchEvent(new w.Event('input'));
  w.document.getElementById('t-rcpt-re').dispatchEvent(new w.Event('click', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(inp.value, 'A-12346');
  assert.equal(calls.filter((c) => c.url.includes('receipt-next')).length, 2);
});

test('제안할 번호가 없으면 칸을 비워두고 안내만 한다', async () => {
  const { w } = boot({ reply: { suggest: null, last: null } });
  await w.loadRcptSuggest();
  await tick();
  assert.equal(w.document.getElementById('t-receipt').value, '');
  assert.match(w.document.getElementById('t-rcpt-hint').textContent, /찾지 못해/);
});

test('백엔드 미배포(404)면 조용히 아무것도 하지 않는다', async () => {
  const { w } = boot({ status: 404 });
  await w.loadRcptSuggest();
  await tick();
  assert.equal(w.document.getElementById('t-receipt').value, '');
  assert.equal(w.document.getElementById('t-rcpt-hint').innerHTML, '');
});

test('권한 밖 계좌의 거래면 번호만 보여주고 내용은 감춘다', async () => {
  const { w } = boot({ reply: { suggest: 'B-101', last: { receipt_no: 'B-100', txn_date: '2026-08-30', visible: false, category_name: null, memo: null } } });
  await w.loadRcptSuggest();
  await tick();
  const hint = w.document.getElementById('t-rcpt-hint').textContent;
  assert.match(hint, /직전 B-100/);
  assert.match(hint, /권한 밖 계좌/);
  assert.equal(w.document.getElementById('t-receipt').value, 'B-101');
});
