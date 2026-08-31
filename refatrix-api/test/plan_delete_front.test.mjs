// =====================================================================
// 재무 > 거래등록 > 「예정 내역(실적 처리)」 라인 삭제 UI — refatrix-finance.html 인라인 JS 를
// jsdom 에서 실제로 구동해 검증한다 (build fin-0831a).
//   · 디렉터만 체크박스·[🗑 삭제]·일괄삭제 바가 보인다
//   · 매출 수금 예정(can_delete=false)은 선택도 삭제도 안 된다
//   · 확인창 문구가 고정비/마케팅/경과 건수를 정확히 안내한다
//   · 요청 payload = POST /api/transactions/plans/delete {ids, reason}
// =====================================================================
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const HTML = readFileSync(new URL('../../refatrix-finance.html', import.meta.url), 'utf8');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const ITEMS = [
  { id: 11, plan_date: '2026-07-15', txn_date: '2026-07-15', direction: 'out', amount: 10000, plan_amount: 10000,
    currency: 'MXN', category_code: '6020', category_name: '임차료', memo: '[고정비] renta bodega',
    account_id: 1, recurring_rule_id: 5, sales_invoice_id: null, source: 'recurring', overdue: true,
    kind: 'general', can_delete: true },
  { id: 12, plan_date: '2026-08-15', txn_date: '2026-08-15', direction: 'out', amount: 10000, plan_amount: 10000,
    currency: 'MXN', category_code: '6020', category_name: '임차료', memo: '[고정비] renta bodega',
    account_id: 1, recurring_rule_id: 5, sales_invoice_id: null, source: 'recurring', overdue: false,
    kind: 'general', can_delete: true },
  { id: 13, plan_date: '2026-08-20', txn_date: '2026-08-20', direction: 'out', amount: 3000, plan_amount: 3000,
    currency: 'MXN', category_code: '6070', category_name: '마케팅비', memo: '[마케팅] 전시회 · 일시불 · Expo',
    account_id: null, recurring_rule_id: null, sales_invoice_id: null, source: 'manual', overdue: false,
    kind: 'general', can_delete: true },
  { id: 14, plan_date: '2026-08-25', txn_date: '2026-08-25', direction: 'in', amount: 11600, plan_amount: 11600,
    currency: 'MXN', category_code: '4010', category_name: '제품 매출', memo: null, sat_no: 'A-1',
    account_id: null, recurring_rule_id: null, sales_invoice_id: 77, source: 'sales', overdue: false,
    kind: 'sales', can_delete: false, customer_name: 'Cliente A' },
];

function boot({ director = true, deleteResponse = null } = {}) {
  const calls = [];
  const alerts = [];
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  const j = (o, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => o });
  w.fetch = async (url, opt = {}) => {
    const u = String(url); const method = (opt.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: opt.body ? JSON.parse(opt.body) : null });
    if (u.includes('/api/transactions/pending-plans')) return j({ items: JSON.parse(JSON.stringify(ITEMS)) });
    if (u.includes('/api/transactions/plans/delete')) return j(deleteResponse || { ok: true, deleted: (JSON.parse(opt.body).ids || []).length, skipped: [] });
    if (u.includes('/api/accounts')) return j({ items: [{ id: 1, name: 'BBVA', currency: 'MXN' }] });
    return j({ items: [] });
  };
  w.alert = (m) => alerts.push(String(m));
  w.confirm = () => true;
  w.prompt = () => '';
  w.eval(`session={token:'t',user:{id:1,name:'Dir',role:'${director ? 'director' : 'treasury'}'},api:''};`);
  return { w, calls, alerts };
}

async function renderList(ctx) {
  await ctx.w.loadPendingPlans();
  await tick();
}
const rowsOf = (w) => Array.from(w.document.querySelectorAll('#ppBody tbody tr[data-id]'));
const delBtns = (w) => Array.from(w.document.querySelectorAll('#ppBody .pp-del'));
const boxes = (w) => Array.from(w.document.querySelectorAll('#ppBody .pp-sel'));

test('① 디렉터: 예정 행마다 체크박스와 [🗑 삭제] 가 나오고, 매출 수금 예정만 빠진다', async () => {
  const ctx = boot(); await renderList(ctx);
  const w = ctx.w;
  assert.equal(rowsOf(w).length, 4, '예정 4건 렌더');
  assert.deepEqual(delBtns(w).map((b) => b.dataset.id), ['11', '12', '13'], '매출(14)에는 삭제 버튼 없음');
  assert.deepEqual(boxes(w).map((b) => b.dataset.id), ['11', '12', '13'], '매출(14)에는 체크박스 없음');
  assert.ok(w.document.getElementById('pp-selall'), '헤더 전체선택 체크박스');
  assert.equal(w.document.getElementById('pp-delbar').classList.contains('hidden'), false, '삭제 바 노출');
});

test('② 비디렉터: 체크박스·삭제 버튼·삭제 바가 전부 없다', async () => {
  const ctx = boot({ director: false }); await renderList(ctx);
  const w = ctx.w;
  assert.equal(delBtns(w).length, 0);
  assert.equal(boxes(w).length, 0);
  assert.equal(w.document.getElementById('pp-selall'), null);
  assert.equal(w.document.getElementById('pp-delbar').classList.contains('hidden'), true);
  assert.equal(rowsOf(w).length, 4, '목록 자체는 그대로 보인다');
});

test('③ 고정비 라인 1건 삭제 — 확인 문구가 "이 회차만"임을 안내하고 payload 는 ids 1건', async () => {
  const ctx = boot(); await renderList(ctx);
  let asked = '';
  ctx.w.confirm = (m) => { asked = String(m); return true; };
  ctx.w.prompt = () => '이번 달 면제';
  delBtns(ctx.w).find((b) => b.dataset.id === '12').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(15);
  assert.match(asked, /예정\(계획\) 1건을 삭제/);
  assert.match(asked, /고정비 회차 1건/);
  assert.match(asked, /다음 달 회차는 그대로 유지/);
  assert.match(asked, /현금흐름/);
  const post = ctx.calls.find((c) => c.method === 'POST' && c.url.includes('/plans/delete'));
  assert.ok(post, '삭제 요청 전송');
  assert.deepEqual(post.body, { ids: [12], reason: '이번 달 면제' });
});

test('④ 확인창에서 취소하면 아무 요청도 보내지 않는다', async () => {
  const ctx = boot(); await renderList(ctx);
  ctx.w.confirm = () => false;
  delBtns(ctx.w)[0].dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(10);
  assert.equal(ctx.calls.filter((c) => c.url.includes('/plans/delete')).length, 0);
});

test('⑤ 사유 입력창에서 취소(prompt=null)해도 요청하지 않는다', async () => {
  const ctx = boot(); await renderList(ctx);
  ctx.w.prompt = () => null;
  delBtns(ctx.w)[0].dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(10);
  assert.equal(ctx.calls.filter((c) => c.url.includes('/plans/delete')).length, 0);
});

test('⑥ 전체선택 → 삭제 가능한 3건만 선택되고 선택 합계가 표시된다', async () => {
  const ctx = boot(); await renderList(ctx);
  const w = ctx.w;
  w.document.getElementById('pp-sel-visible').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.match(w.document.getElementById('pp-selinfo').textContent, /선택 3건/);
  assert.match(w.document.getElementById('pp-selinfo').textContent, /23,000\.00 MXN/);
  assert.equal(boxes(w).filter((b) => b.checked).length, 3);
  assert.equal(w.document.getElementById('pp-selall').checked, true);
});

test('⑦ 일괄 삭제 — 고정비·마케팅·경과 건수를 안내하고 ids 3건을 한 번에 보낸다', async () => {
  const ctx = boot(); await renderList(ctx);
  const w = ctx.w;
  let asked = '';
  w.confirm = (m) => { asked = String(m); return true; };
  w.prompt = () => '';
  w.document.getElementById('pp-sel-visible').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  w.document.getElementById('pp-del-sel').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(15);
  assert.match(asked, /예정\(계획\) 3건을 삭제/);
  assert.match(asked, /고정비 회차 2건/);
  assert.match(asked, /마케팅 지출계획 1건/);
  assert.match(asked, /경과 1건 포함/);
  const post = ctx.calls.find((c) => c.method === 'POST' && c.url.includes('/plans/delete'));
  assert.deepEqual(post.body.ids.slice().sort((a, b) => a - b), [11, 12, 13]);
  assert.equal(post.body.reason, null, '빈 사유는 null 로 보낸다');
});

test('⑧ 선택 해제 버튼은 선택을 비우고 삭제 버튼을 비활성화한다', async () => {
  const ctx = boot(); await renderList(ctx);
  const w = ctx.w;
  w.document.getElementById('pp-sel-visible').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  w.document.getElementById('pp-sel-clear').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.match(w.document.getElementById('pp-selinfo').textContent, /선택 0건/);
  assert.equal(w.document.getElementById('pp-del-sel').disabled, true);
});

test('⑨ 서버가 일부를 건너뛰면(sales_linked 등) 그 사유를 사람 말로 알려준다', async () => {
  const ctx = boot({ deleteResponse: { ok: true, deleted: 1, deleted_ids: [11], skipped: [{ id: 12, error: 'not_plan' }] } });
  await renderList(ctx);
  ctx.w.confirm = () => true; ctx.w.prompt = () => '';
  delBtns(ctx.w)[0].dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(15);
  const msg = ctx.alerts.join('\n');
  assert.match(msg, /삭제 1건 완료/);
  assert.match(msg, /이미 실적으로 처리된 거래입니다/);
});

test('⑩ 삭제 후 목록을 다시 불러온다(현금흐름 화면은 탭 전환 시 재조회)', async () => {
  const ctx = boot(); await renderList(ctx);
  const before = ctx.calls.filter((c) => c.url.includes('pending-plans')).length;
  ctx.w.confirm = () => true; ctx.w.prompt = () => '';
  delBtns(ctx.w)[0].dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
  await tick(20);
  const after = ctx.calls.filter((c) => c.url.includes('pending-plans')).length;
  assert.ok(after > before, '삭제 후 예정 목록 재조회');
});

test('⑪ 빌드 마커', () => {
  assert.match(HTML, /build fin-0831a/);
});
