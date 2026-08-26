// =====================================================================
// 거래목록 예정 행 [계획 수정] 의 「자금출처 계좌」 select — refatrix-finance.html 을
// jsdom 에서 실제로 구동해 검증한다 (build fin-0826c).
//   요구(디렉터): 목록에서 클릭해 수정할 때 **어느 은행계좌에서 출금되는지** 고칠 수 있어야 한다.
// =====================================================================
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const HTML = readFileSync(new URL('../../refatrix-finance.html', import.meta.url), 'utf8');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const ACCOUNTS = [
  { id: 1, name: 'BBVA', currency: 'MXN', disabled: false, can_detail: true },
  { id: 2, name: '금고', currency: 'MXN', disabled: false, can_detail: true },
];

const base = { direction: 'out', currency: 'MXN', fx_rate: 1, kind: 'general', approved: true,
  change_count: 0, edit_count: 0, editable: true, sales_invoice_id: null };
const TXNS = [
  { ...base, id: 201, txn_date: '2026-09-15', plan_date: '2026-09-15', amount: 10000, amount_mxn: 10000,
    plan_amount: 10000, category_code: '6020', category_name: '임차료', status: 'plan',
    memo: '[고정비] renta bodega', account_id: 1, account_name: 'BBVA', recurring_rule_id: 5,
    source: 'recurring', plan_account_manual: false },
  { ...base, id: 202, txn_date: '2026-09-20', plan_date: '2026-09-20', amount: 3000, amount_mxn: 3000,
    plan_amount: 3000, category_code: '6070', category_name: '마케팅비', status: 'plan',
    memo: '[마케팅] 전시회 · 일시불', account_id: null, account_name: null, recurring_rule_id: null,
    source: 'marketing', plan_account_manual: false },
  { ...base, id: 203, txn_date: '2026-08-10', plan_date: null, amount: 777, amount_mxn: 777,
    plan_amount: null, category_code: '6030', category_name: '기타', status: 'actual',
    memo: '사무용품', account_id: 1, account_name: 'BBVA', recurring_rule_id: null,
    source: 'manual', plan_account_manual: false },
  { ...base, id: 204, txn_date: '2026-10-15', plan_date: '2026-10-15', amount: 10000, amount_mxn: 10000,
    plan_amount: 10000, category_code: '6020', category_name: '임차료', status: 'plan',
    memo: '[고정비] renta bodega', account_id: 2, account_name: '금고', recurring_rule_id: 5,
    source: 'recurring', plan_account_manual: true },
];

function boot({ planResponse = null, planStatus = 200 } = {}) {
  const calls = [];
  const alerts = [];
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  const j = (o, ok = true, status = 200) => ({ ok, status, json: async () => o });
  w.fetch = async (url, opt = {}) => {
    const u = String(url); const method = (opt.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: opt.body ? JSON.parse(opt.body) : null });
    if (method === 'PATCH' && /\/plan$/.test(u)) {
      const ok = planStatus === 200;
      return j(planResponse || { ok: true, changed: true, account_changed: true, account_id: 2 }, ok, planStatus);
    }
    if (u.includes('/api/transactions?') || u.split('?')[0].endsWith('/api/transactions')) {
      return j({ items: JSON.parse(JSON.stringify(TXNS)) });
    }
    if (u.includes('/api/accounts')) return j({ items: JSON.parse(JSON.stringify(ACCOUNTS)) });
    return j({ items: [] });
  };
  w.alert = (m) => alerts.push(String(m));
  w.confirm = () => true;
  w.eval(`session={token:'t',user:{id:1,name:'Dir',role:'director'},api:''}; accounts=${JSON.stringify(ACCOUNTS)};`);
  return { w, calls, alerts };
}

async function openRow(ctx, id) {
  await ctx.w.loadTxns(); await tick();
  const row = Array.from(ctx.w.document.querySelectorAll('#txnBody tbody tr.txn-row'))
    .find((r) => r.dataset.id === String(id));
  row.dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(15);
  return ctx.w.document.querySelector(`#txnBody .txn-det-body[data-id="${id}"]`);
}
const openPlanEdit = (body) => {
  body.querySelector('.cf-planedit').dispatchEvent(new body.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
};

test('① 예정 행 [계획 수정] 에 「자금출처 계좌」 select 가 있다', async () => {
  const ctx = boot();
  const body = await openRow(ctx, 201);
  openPlanEdit(body);
  const sel = body.querySelector('.pe-acc');
  assert.ok(sel, '계좌 select 존재');
  assert.equal(sel.value, '1', '현재 계좌(BBVA)가 선택되어 있다');
  const opts = Array.from(sel.options).map((o) => o.value);
  assert.deepEqual(opts, ['', '1', '2'], '(미지정) + 계좌 2개');
  assert.match(body.querySelector('.planedit').textContent, /어느 은행계좌에서 나가는지/);
});

test('② 계좌를 바꿔 저장하면 account_id 가 실려 나간다', async () => {
  const ctx = boot();
  const body = await openRow(ctx, 201);
  openPlanEdit(body);
  body.querySelector('.pe-acc').value = '2';
  body.querySelector('.pe-memo').value = '금고에서 지급';
  body.querySelector('.pe-save').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(20);
  const patch = ctx.calls.find((c) => c.method === 'PATCH' && /\/plan$/.test(c.url));
  assert.ok(patch, '계획 저장 요청');
  assert.equal(patch.body.account_id, 2);
  assert.equal(patch.body.amount, 10000);
  assert.equal(patch.body.memo, '금고에서 지급');
});

test('③ (미지정)으로 저장하면 account_id: null 을 보낸다', async () => {
  const ctx = boot();
  const body = await openRow(ctx, 201);
  openPlanEdit(body);
  body.querySelector('.pe-acc').value = '';
  body.querySelector('.pe-save').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(20);
  const patch = ctx.calls.find((c) => c.method === 'PATCH' && /\/plan$/.test(c.url));
  assert.strictEqual(patch.body.account_id, null);
});

test('④ 계좌가 바뀌면 안내 문구가 은행계좌별 반영을 알려준다', async () => {
  const ctx = boot();
  const body = await openRow(ctx, 201);
  openPlanEdit(body);
  body.querySelector('.pe-acc').value = '2';
  body.querySelector('.pe-save').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(20);
  const msg = ctx.alerts.join('\n');
  assert.match(msg, /출금 계좌 변경/);
  assert.match(msg, /은행계좌별 구분/);
  assert.match(msg, /예외로 보존/, '고정비 회차라 예외 보존 안내도 함께');
});

test('⑤ 계좌를 안 바꾸면 기존 문구 그대로', async () => {
  const ctx = boot({ planResponse: { ok: true, changed: true, account_changed: false, account_id: 1 } });
  const body = await openRow(ctx, 201);
  openPlanEdit(body);
  body.querySelector('.pe-amt').value = '9000';
  body.querySelector('.pe-save').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(20);
  const msg = ctx.alerts.join('\n');
  assert.match(msg, /현금흐름 계획선에 반영/);
  assert.ok(!/출금 계좌 변경/.test(msg));
});

test('⑥ 고정비 회차에는 「이 회차만 예외로 보존」 안내가 뜬다 (일반 예정에는 없음)', async () => {
  const ctx = boot();
  const fx = await openRow(ctx, 201);
  openPlanEdit(fx);
  assert.match(fx.querySelector('.planedit').textContent, /이 회차만 예외로 보존/);

  const ctx2 = boot();
  const mkt = await openRow(ctx2, 202);
  openPlanEdit(mkt);
  assert.ok(!/이 회차만 예외로 보존/.test(mkt.querySelector('.planedit').textContent));
  assert.ok(mkt.querySelector('.pe-acc'), '마케팅 계획에도 계좌 select 는 있다');
  assert.equal(mkt.querySelector('.pe-acc').value, '', '계좌 미지정 상태');
});

test('⑦ 권한 오류(403)는 사람 말로 안내한다', async () => {
  const ctx = boot({ planResponse: { error: 'account_not_operable' }, planStatus: 403 });
  const body = await openRow(ctx, 201);
  openPlanEdit(body);
  body.querySelector('.pe-acc').value = '2';
  body.querySelector('.pe-save').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(20);
  assert.match(body.querySelector('.cf-msg').textContent, /등록\(운영\) 권한이 없습니다/);
  assert.equal(ctx.alerts.length, 0, '실패했으면 성공 알림이 뜨면 안 된다');
});

test('⑧ 이미 예외 지정된 고정비 회차는 목록에 「계좌 예외」 배지가 보인다', async () => {
  const ctx = boot();
  await ctx.w.loadTxns(); await tick();
  const rowOf = (id) => Array.from(ctx.w.document.querySelectorAll('#txnBody tbody tr.txn-row'))
    .find((r) => r.dataset.id === String(id));
  assert.match(rowOf(204).textContent, /계좌 예외/);
  assert.ok(!/계좌 예외/.test(rowOf(201).textContent), '일반 회차에는 없음');
});

test('⑨ 실적 행에는 계획 수정 패널이 아니라 기존 거래 수정 패널이 열린다(회귀)', async () => {
  const ctx = boot();
  const body = await openRow(ctx, 203);
  assert.equal(body.querySelector('.pe-acc'), null);
  assert.ok(body.querySelector('.e-acc'), '실적은 종전대로 거래 수정의 계좌 select');
});

test('⑩ 빌드 마커', () => {
  assert.match(HTML, /build fin-0826c/);
});
