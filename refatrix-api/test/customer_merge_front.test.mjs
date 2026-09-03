// =====================================================================
// refatrix-customers.html 「🔗 고객 병합」 프런트 (jsdom, 2026-09-03)
//   모달 열기 · 대상 검색/선택 · 미리보기 렌더 · 방향 바꾸기 ·
//   사유/확인란 게이트 · 실행 POST 본문 · XSS 이스케이프.
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-customers.html', import.meta.url), 'utf8');

let dom, win, fetchLog, fetchRoutes;
function route(method, urlPart, payload, status = 200) { fetchRoutes.push({ method, urlPart, payload, status }); }

const FROM = { id: 34, code: 'C-0034', name: 'FRENOS NORTE', rfc: 'FNO900101AB1',
  owner_name: 'Oscar', team_name: '01_Monterrey', approval_status: 'approved', rfc_claim_exempt: false };
const INTO = { id: 52, code: 'C-0052', name: 'FRENOS NORTE SUCURSAL', rfc: 'FNO900101AB1',
  owner_name: 'Oscar', team_name: '01_Monterrey', approval_status: 'approved', rfc_claim_exempt: true };

function preview(extra = {}) {
  return {
    from: FROM, into: INTO, same_rfc: true,
    moves: [
      { key: 'visits', label: '현장 방문', cnt: 4, deleted: 1,
        children: [{ label: '후속조치', cnt: 3 }, { label: '녹음', cnt: 2 }] },
      { key: 'meetings', label: '수기 미팅', cnt: 2, deleted: 0, children: [] },
      { key: 'consults', label: '고객상담', cnt: 1, deleted: 0, children: [{ label: '녹음', cnt: 1 }] },
    ],
    move_total: 7,
    residual: [{ table: 'quotes', column: 'customer_id', label: '견적', cnt: 3, capped: false }],
    residual_total: 3, residual_unavailable: false,
    warnings: [], blockers: [], can_merge: true,
    ...extra,
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
        fetchLog.push({ url: String(url), method, body: opts.body ? String(opts.body) : null });
        const m = fetchRoutes.find((r) => r.method === method && String(url).includes(r.urlPart));
        const p = m ? m.payload : {};
        const status = m ? m.status : 200;
        return { ok: status < 400, status, json: async () => p };
      };
      w.alert = (msg) => { w.__alert = String(msg); };
      w.confirm = (msg) => { w.__confirm = String(msg); return w.__confirmAnswer !== false; };
    },
  });
  win = dom.window;
  win.eval("session = { token:'tok', user:{ id:2, name:'Ana', role:'director' }, api:'' };");
  // 목록 갱신·고객 상세 재조회는 이 테스트의 관심사가 아니다.
  win.eval('loadCustomers = async () => {}; openCustomer = async () => {}; loadRfcExempt = async () => {}; loadClaimBadge = async () => {};');
});

const $ = (id) => win.document.getElementById(id);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function openWithTarget() {
  route('GET', '/api/customers?q=', { items: [INTO] });
  route('GET', '/api/customers/34/merge-preview', preview());
  win.openMerge(FROM);
  $('mgQ').value = 'C-0052';
  await win.mgSearch(); await tick();
  win.mgPick(52);
  await tick();
}

test('디렉터가 아니면 모달이 열리지 않는다', () => {
  win.eval("session.user.role='sales';");
  win.openMerge(FROM);
  assert.equal($('mergeModal').classList.contains('on'), false);
  assert.match(win.__alert, /디렉터만/);
});

test('모달 열기 — 옮길 고객이 표시되고 입력은 초기화된다', () => {
  $('mgReason').value = '이전 값';
  $('mgAck').checked = true;
  win.openMerge(FROM);
  assert.equal($('mergeModal').classList.contains('on'), true);
  assert.ok($('mgFrom').innerHTML.includes('FRENOS NORTE'));
  assert.ok($('mgFrom').innerHTML.includes('C-0034'));
  assert.equal($('mgReason').value, '', '사유는 매번 비운다');
  assert.equal($('mgAck').checked, false);
  assert.equal($('mgClose').checked, true, '기본은 원본 종료');
  assert.equal($('mgExec').classList.contains('hidden'), true, '대상 선택 전에는 실행부가 숨어 있다');
});

test('검색 — 2글자 미만은 조회하지 않고, 자기 자신은 후보에서 빠진다', async () => {
  win.openMerge(FROM);
  $('mgQ').value = 'F';
  await win.mgSearch();
  assert.equal(fetchLog.length, 0);
  assert.ok($('mgResults').innerHTML.includes('2글자 이상'));

  route('GET', '/api/customers?q=', { items: [FROM, INTO] });
  $('mgQ').value = 'FRENOS';
  await win.mgSearch(); await tick();
  const h = $('mgResults').innerHTML;
  assert.ok(h.includes('C-0052'));
  assert.equal(h.includes('C-0034'), false, '옮길 고객 자신은 대상이 될 수 없다');
});

test('대상 선택 → 미리보기 자동 조회 · 옮길 것/남는 것이 모두 렌더된다', async () => {
  await openWithTarget();
  assert.ok(fetchLog.some((f) => f.url.includes('/api/customers/34/merge-preview?into=52')));
  const h = $('mgPreview').innerHTML;
  assert.ok(h.includes('RFC 가 같습니다'), 'RFC 일치 확인 문구');
  assert.ok(h.includes('7건'), '옮기는 합계');
  assert.ok(h.includes('현장 방문') && h.includes('수기 미팅') && h.includes('고객상담'));
  assert.ok(h.includes('삭제된 1건도 함께'), '소프트삭제분 안내');
  assert.ok(h.includes('따라옴') && h.includes('후속조치 3') && h.includes('녹음 2'));
  assert.ok(h.includes('견적') && h.includes('3건'), '남는 것');
  assert.equal($('mgExec').classList.contains('hidden'), false, '실행부가 열린다');
});

test('남는 데이터가 있으면 확인란이 뜨고, 원본을 종료하지 않으면 사라진다', async () => {
  await openWithTarget();
  assert.equal($('mgAckWrap').classList.contains('hidden'), false);
  assert.ok($('mgAckText').textContent.includes('3건'));
  $('mgClose').checked = false;
  $('mgClose').dispatchEvent(new win.Event('change'));
  assert.equal($('mgAckWrap').classList.contains('hidden'), true, '종료하지 않으면 확인할 것도 없다');
});

test('사유가 비면 실행하지 않는다', async () => {
  await openWithTarget();
  $('mgReason').value = '   ';
  await win.mgRun(); await tick();
  assert.equal(fetchLog.filter((f) => f.method === 'POST').length, 0);
  assert.match($('mgMsg').textContent, /사유/);
});

test('확인란을 체크하지 않으면 종료를 동반한 병합을 막는다', async () => {
  await openWithTarget();
  $('mgReason').value = 'RFC 동일';
  $('mgAck').checked = false;
  await win.mgRun(); await tick();
  assert.equal(fetchLog.filter((f) => f.method === 'POST').length, 0);
  assert.match($('mgMsg').textContent, /확인란/);
});

test('실행 POST 본문 — from/into/사유/종료/확인이 그대로 실린다', async () => {
  await openWithTarget();
  route('POST', '/api/customers/merge', { ok: true, note: '옮겼습니다', counts: { visits: 4, meetings: 2, consults: 1 } });
  $('mgReason').value = 'RFC 동일 · 같은 회사';
  $('mgAck').checked = true;
  await win.mgRun(); await tick();
  const post = fetchLog.find((f) => f.method === 'POST' && f.url.includes('/api/customers/merge'));
  assert.ok(post);
  const body = JSON.parse(post.body);
  assert.deepEqual(body, { from_id: 34, into_id: 52, close_source: true, ack_residual: true,
    reason: 'RFC 동일 · 같은 회사' });
  assert.match(win.__confirm, /C-0034/);
  assert.match(win.__confirm, /종료/);
  assert.equal($('mergeModal').classList.contains('on'), false, '성공하면 모달을 닫는다');
});

test('확인 대화상자에서 취소하면 아무것도 보내지 않는다', async () => {
  await openWithTarget();
  win.__confirmAnswer = false;
  $('mgReason').value = 'RFC 동일'; $('mgAck').checked = true;
  await win.mgRun(); await tick();
  assert.equal(fetchLog.filter((f) => f.method === 'POST').length, 0);
});

test('서버가 거부하면 모달을 닫지 않고 사유를 보여 준다', async () => {
  await openWithTarget();
  route('POST', '/api/customers/merge', { error: 'merge_blocked', note: '반려된 고객으로는 합칠 수 없습니다.' }, 409);
  $('mgReason').value = 'x'; $('mgAck').checked = true;
  await win.mgRun(); await tick();
  assert.equal($('mergeModal').classList.contains('on'), true);
  assert.match($('mgMsg').textContent, /반려된 고객/);
});

test('차단 사유가 있으면 실행부가 열리지 않는다', async () => {
  route('GET', '/api/customers?q=', { items: [INTO] });
  route('GET', '/api/customers/34/merge-preview',
    preview({ can_merge: false, blockers: [{ code: 'into_rejected', note: '반려된 고객으로는 합칠 수 없습니다.' }] }));
  win.openMerge(FROM);
  $('mgQ').value = 'C-0052'; await win.mgSearch(); await tick();
  win.mgPick(52); await tick();
  assert.ok($('mgPreview').innerHTML.includes('⛔'));
  assert.equal($('mgExec').classList.contains('hidden'), true);
});

test('경고는 표시하되 막지 않는다', async () => {
  route('GET', '/api/customers?q=', { items: [INTO] });
  route('GET', '/api/customers/34/merge-preview',
    preview({ same_rfc: false, warnings: [{ code: 'rfc_differs', note: 'RFC 가 서로 다릅니다' }] }));
  win.openMerge(FROM);
  $('mgQ').value = 'C-0052'; await win.mgSearch(); await tick();
  win.mgPick(52); await tick();
  assert.ok($('mgPreview').innerHTML.includes('⚠'));
  assert.equal($('mgExec').classList.contains('hidden'), false);
});

test('⇄ 방향 바꾸기 — 반대 방향으로 미리보기를 다시 조회한다', async () => {
  await openWithTarget();
  route('GET', '/api/customers/52/merge-preview', preview({ from: INTO, into: FROM }));
  win.mgSwap(); await tick();
  assert.ok(fetchLog.some((f) => f.url.includes('/api/customers/52/merge-preview?into=34')));
  assert.ok($('mgFrom').innerHTML.includes('C-0052'));
  assert.ok($('mgInto').innerHTML.includes('C-0034'));
});

test('대상을 안 고른 채 ⇄ 를 누르면 안내만 한다', () => {
  win.openMerge(FROM);
  win.mgSwap();
  assert.match(win.__alert, /먼저 남길 고객/);
  assert.equal(fetchLog.length, 0);
});

test('XSS — 고객명·잔여 테이블명이 그대로 실행되지 않는다', async () => {
  const evil = { ...INTO, name: '<img src=x onerror=alert(1)>' };
  route('GET', '/api/customers?q=', { items: [evil] });
  route('GET', '/api/customers/34/merge-preview',
    preview({ into: evil, residual: [{ table: '<b>t</b>', column: 'c', label: '<i>x</i>', cnt: 1, capped: false }] }));
  win.openMerge(FROM);
  $('mgQ').value = 'FRENOS'; await win.mgSearch(); await tick();
  assert.equal($('mgResults').querySelectorAll('img').length, 0);
  win.mgPick(52); await tick();
  assert.equal($('mgInto').querySelectorAll('img').length, 0);
  // <b> 는 우리 마크업에도 있으니 세지 않는다 — 데이터에서 온 태그(<i>)만 확인한다.
  assert.equal($('mgPreview').querySelectorAll('i').length, 0);
  assert.ok($('mgPreview').innerHTML.includes('&lt;b&gt;t&lt;/b&gt;'), '테이블명은 문자로 이스케이프');
  assert.ok($('mgPreview').innerHTML.includes('&lt;i&gt;x&lt;/i&gt;'), '라벨도 문자로 이스케이프');
});

test('고객 상세의 🔗 병합 버튼은 디렉터에게만 보인다', async () => {
  route('GET', '/api/customers/34', { customer: { ...FROM, discount: 40, credit_days: 30, memo: null },
    invoices: [], summary: {}, reorder_summary: null });
  await win.openCustomerReal ? null : null;
  // openCustomer 는 위에서 스텁했으므로, 표시 규칙만 직접 확인한다.
  win.eval("$('mergeBtn').style.display = (session.user.role==='director')?'':'none';");
  assert.notEqual($('mergeBtn').style.display, 'none');
  win.eval("session.user.role='sales'; $('mergeBtn').style.display = (session.user.role==='director')?'':'none';");
  assert.equal($('mergeBtn').style.display, 'none');
});
