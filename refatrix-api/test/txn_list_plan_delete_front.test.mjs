// =====================================================================
// 거래목록에서 계획(예정) 삭제 — refatrix-finance.html 을 jsdom 에서 구동해 검증 (build fin-0902r).
//   요구(디렉터): "지난 날짜의 계획을 지우려는데 그 기능이 거래등록에만 있다. **거래목록에서도** 되게 해달라."
//   → 예정 행에 체크박스 + 상단 삭제 바(전체선택 / 경과만 선택 / 선택 해제 / 선택한 계획 삭제).
//     한 건은 행을 열어 [예정 삭제] 로도 가능하며, 양쪽 모두 같은 API·같은 확인 문구를 쓴다.
// =====================================================================
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const HTML = readFileSync(new URL('../../refatrix-finance.html', import.meta.url), 'utf8');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const ACCOUNTS = [{ id: 1, name: 'BBVA', currency: 'MXN', disabled: false, can_detail: true }];
const base = { currency: 'MXN', fx_rate: 1, kind: 'general', approved: true, change_count: 0,
  edit_count: 0, editable: true, sales_invoice_id: null, recurring_rule_id: null, plan_account_manual: false };
// 오늘(테스트 실행일) 기준으로 과거/미래가 갈리도록 상대 날짜로 만든다.
const d = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const PAST_A = d(-60), PAST_B = d(-30), FUTURE = d(+30);

const TXNS = [
  // 지난 날짜의 고정비 예정 — 이번 요청의 핵심 대상
  { ...base, id: 501, txn_date: PAST_A, plan_date: PAST_A, direction: 'out', amount: 10000, amount_mxn: 10000,
    plan_amount: 10000, category_code: '6020', category_name: '임차료', status: 'plan',
    memo: '[고정비] renta bodega', account_id: 1, account_name: 'BBVA', recurring_rule_id: 5, source: 'recurring' },
  // 지난 날짜의 마케팅 예정(계좌 미지정)
  { ...base, id: 502, txn_date: PAST_B, plan_date: PAST_B, direction: 'out', amount: 3000, amount_mxn: 3000,
    plan_amount: 3000, category_code: '6070', category_name: '마케팅비', status: 'plan',
    memo: '[마케팅] 전시회 · 일시불', account_id: null, account_name: null, source: 'marketing' },
  // 미래 예정
  { ...base, id: 503, txn_date: FUTURE, plan_date: FUTURE, direction: 'out', amount: 1500, amount_mxn: 1500,
    plan_amount: 1500, category_code: '6030', category_name: '기타', status: 'plan',
    memo: '앞으로 나갈 돈', account_id: 1, account_name: 'BBVA', source: 'manual' },
  // 실적 — 삭제 대상 아님
  { ...base, id: 504, txn_date: PAST_B, plan_date: null, direction: 'out', amount: 777, amount_mxn: 777,
    plan_amount: null, category_code: '6030', category_name: '기타', status: 'actual',
    memo: '사무용품', account_id: 1, account_name: 'BBVA', source: 'manual' },
  // 매출 수금 예정 — 삭제 불가
  { ...base, id: 505, txn_date: FUTURE, plan_date: FUTURE, direction: 'in', amount: 11600, amount_mxn: 11600,
    plan_amount: 11600, category_code: '4010', category_name: '제품 매출', status: 'plan', memo: null,
    sat_no: 'A-1', customer_name: 'Cliente A', account_id: null, account_name: null,
    sales_invoice_id: 77, source: 'sales', editable: false },
];

function boot({ director = true, deleteResponse = null, txns = TXNS } = {}) {
  const calls = []; const alerts = [];
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  const j = (o, ok = true, status = 200) => ({ ok, status, json: async () => o });
  w.fetch = async (url, opt = {}) => {
    const u = String(url); const method = (opt.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: opt.body ? JSON.parse(opt.body) : null });
    if (u.includes('/api/transactions/plans/delete')) {
      return j(deleteResponse || { ok: true, deleted: (JSON.parse(opt.body).ids || []).length, skipped: [] });
    }
    if (u.includes('/api/transactions?') || u.split('?')[0].endsWith('/api/transactions')) {
      return j({ items: JSON.parse(JSON.stringify(txns)) });
    }
    if (u.includes('/api/accounts')) return j({ items: JSON.parse(JSON.stringify(ACCOUNTS)) });
    return j({ items: [] });
  };
  w.alert = (m) => alerts.push(String(m));
  w.confirm = () => true;
  w.prompt = () => '';
  w.eval(`session={token:'t',user:{id:1,name:'Dir',role:'${director ? 'director' : 'treasury'}'},api:''}; accounts=${JSON.stringify(ACCOUNTS)};`);
  return { w, calls, alerts };
}

const load = async (ctx) => { await ctx.w.loadTxns(); await tick(); };
const boxes = (w) => Array.from(w.document.querySelectorAll('#txnBody .txn-sel'));
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const btn = (w, id) => w.document.getElementById(id);
const delPost = (ctx) => ctx.calls.find((c) => c.method === 'POST' && c.url.includes('/plans/delete'));

test('① 예정 행에만 체크박스가 생긴다 — 실적·매출 수금은 제외', async () => {
  const ctx = boot(); await load(ctx);
  assert.deepEqual(boxes(ctx.w).map((b) => b.dataset.id), ['501', '502', '503'],
    '실적(504)·매출 수금(505)에는 체크박스 없음');
  assert.equal(btn(ctx.w, 'txn-delbar').classList.contains('hidden'), false, '삭제 바 노출');
  assert.ok(ctx.w.document.getElementById('txn-selall'), '헤더 전체선택');
});

test('② 비디렉터에게는 체크박스도 삭제 바도 없다', async () => {
  const ctx = boot({ director: false }); await load(ctx);
  assert.equal(boxes(ctx.w).length, 0);
  assert.equal(ctx.w.document.getElementById('txn-selall'), null);
  assert.equal(btn(ctx.w, 'txn-delbar').classList.contains('hidden'), true);
  assert.equal(ctx.w.document.querySelectorAll('#txnBody tbody tr.txn-row').length, 5, '목록은 그대로');
});

test('③ 예정이 하나도 없으면 삭제 바가 숨는다', async () => {
  const onlyActual = [TXNS[3]];
  const ctx = boot({ txns: onlyActual }); await load(ctx);
  assert.equal(btn(ctx.w, 'txn-delbar').classList.contains('hidden'), true);
  assert.equal(ctx.w.document.getElementById('txn-selall'), null, '체크박스 열 자체가 없다');
});

test('④ ★ 「경과된 예정만 선택」 — 지난 날짜 계획만 골라준다', async () => {
  const ctx = boot(); await load(ctx);
  click(ctx.w, btn(ctx.w, 'txn-sel-overdue'));
  await tick();
  const checked = boxes(ctx.w).filter((b) => b.checked).map((b) => b.dataset.id);
  assert.deepEqual(checked, ['501', '502'], '미래 예정(503)은 안 골라야 한다');
  assert.match(btn(ctx.w, 'txn-selinfo').textContent, /선택 2건/);
  assert.match(btn(ctx.w, 'txn-selinfo').textContent, /13,000\.00 MXN/);
});

test('⑤ 전체선택 → 삭제 가능한 예정 3건만 (실적·매출 제외)', async () => {
  const ctx = boot(); await load(ctx);
  click(ctx.w, btn(ctx.w, 'txn-sel-visible'));
  await tick();
  assert.equal(boxes(ctx.w).filter((b) => b.checked).length, 3);
  assert.equal(ctx.w.document.getElementById('txn-selall').checked, true);
  assert.match(btn(ctx.w, 'txn-selinfo').textContent, /선택 3건/);
});

test('⑥ 선택한 계획 삭제 — 거래등록과 같은 확인 문구·같은 API', async () => {
  const ctx = boot(); await load(ctx);
  let asked = '';
  ctx.w.confirm = (m) => { asked = String(m); return true; };
  ctx.w.prompt = () => '지난 계획 정리';
  click(ctx.w, btn(ctx.w, 'txn-sel-overdue'));
  await tick();
  click(ctx.w, btn(ctx.w, 'txn-del-sel'));
  await tick(20);
  assert.match(asked, /예정\(계획\) 2건을 삭제/);
  assert.match(asked, /경과 2건 포함/);
  assert.match(asked, /고정비 회차 1건/);
  assert.match(asked, /마케팅 지출계획 1건/);
  assert.match(asked, /현금흐름/);
  const post = delPost(ctx);
  assert.ok(post, '삭제 요청 전송');
  assert.deepEqual(post.body.ids.slice().sort((a, b) => a - b), [501, 502]);
  assert.equal(post.body.reason, '지난 계획 정리');
});

test('⑦ 행을 열어 [예정 삭제] 한 건도 같은 경로를 쓴다(사유 기록 포함)', async () => {
  const ctx = boot(); await load(ctx);
  ctx.w.prompt = () => '단건 정리';
  const row = Array.from(ctx.w.document.querySelectorAll('#txnBody tbody tr.txn-row'))
    .find((r) => r.dataset.id === '501');
  click(ctx.w, row);
  await tick(15);
  const body = ctx.w.document.querySelector('#txnBody .txn-det-body[data-id="501"]');
  const del = body.querySelector('.cf-del');
  assert.ok(del, '[예정 삭제] 버튼');
  click(ctx.w, del);
  await tick(20);
  const post = delPost(ctx);
  assert.deepEqual(post.body, { ids: [501], reason: '단건 정리' });
});

test('⑧ 확인/사유 창에서 취소하면 아무 요청도 안 나간다', async () => {
  const c1 = boot(); await load(c1);
  c1.w.confirm = () => false;
  click(c1.w, btn(c1.w, 'txn-sel-visible')); await tick();
  click(c1.w, btn(c1.w, 'txn-del-sel')); await tick(15);
  assert.equal(delPost(c1), undefined);

  const c2 = boot(); await load(c2);
  c2.w.prompt = () => null;
  click(c2.w, btn(c2.w, 'txn-sel-visible')); await tick();
  click(c2.w, btn(c2.w, 'txn-del-sel')); await tick(15);
  assert.equal(delPost(c2), undefined);
});

test('⑨ 선택 해제 → 삭제 버튼 비활성', async () => {
  const ctx = boot(); await load(ctx);
  click(ctx.w, btn(ctx.w, 'txn-sel-visible')); await tick();
  click(ctx.w, btn(ctx.w, 'txn-sel-clear')); await tick();
  assert.match(btn(ctx.w, 'txn-selinfo').textContent, /선택 0건/);
  assert.equal(btn(ctx.w, 'txn-del-sel').disabled, true);
  assert.equal(boxes(ctx.w).filter((b) => b.checked).length, 0);
});

test('⑩ 체크박스를 눌러도 행 상세가 열리지 않는다', async () => {
  const ctx = boot(); await load(ctx);
  const box = boxes(ctx.w).find((b) => b.dataset.id === '501');
  click(ctx.w, box);          // 체크박스 클릭 = 체크 + change (행 클릭으로 번지면 안 된다)
  await tick(15);
  assert.equal(box.checked, true);
  const det = ctx.w.document.querySelector('#txnBody tr.txn-det[data-id="501"]');
  assert.equal(det.classList.contains('hidden'), true, '상세는 닫힌 채로');
  assert.match(btn(ctx.w, 'txn-selinfo').textContent, /선택 1건/);
});

test('⑪ 삭제 후 목록을 다시 불러오고 선택이 비워진다', async () => {
  const ctx = boot(); await load(ctx);
  const before = ctx.calls.filter((c) => c.method === 'GET' && c.url.includes('/api/transactions?')).length;
  click(ctx.w, btn(ctx.w, 'txn-sel-overdue')); await tick();
  click(ctx.w, btn(ctx.w, 'txn-del-sel')); await tick(25);
  const after = ctx.calls.filter((c) => c.method === 'GET' && c.url.includes('/api/transactions?')).length;
  assert.ok(after > before, '목록 재조회');
  assert.match(btn(ctx.w, 'txn-selinfo').textContent, /선택 0건/);
});

test('⑫ 서버가 일부를 건너뛰면 사유를 사람 말로 알려준다', async () => {
  const ctx = boot({ deleteResponse: { ok: true, deleted: 1, deleted_ids: [501],
    skipped: [{ id: 502, error: 'sales_linked' }] } });
  await load(ctx);
  click(ctx.w, btn(ctx.w, 'txn-sel-overdue')); await tick();
  click(ctx.w, btn(ctx.w, 'txn-del-sel')); await tick(25);
  const msg = ctx.alerts.join('\n');
  assert.match(msg, /삭제 1건 완료/);
  assert.match(msg, /매출\(반제\) 연계 수금 예정은 삭제할 수 없습니다/);
});

test('⑬ 빌드 마커', () => {
  assert.match(HTML, /build fin-0902r/);
});
