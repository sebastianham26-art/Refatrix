// =====================================================================
// refatrix-wbr.html 「🤖 나의 기록으로 초안 만들기」 프런트 (jsdom)
//   버튼 노출 조건 · 이번 주 월~금 계산 · **검토 패널(문장별 카테고리 선택)** ·
//   적용/취소 · 보드 반영(추가/중복) · 저장(PUT) · 오류 안내 · XSS.
//   실행: node --test test/wbr_journal_draft_front.test.mjs
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-wbr.html', import.meta.url), 'utf8');

let dom, win, fetchLog, fetchRoutes;
function route(method, urlPart, payload, status = 200) { fetchRoutes.push({ method, urlPart, payload, status }); }

const GOOD_DRAFT = {
  sales: { this: ['9/1 Autozone 견적 발송 → 9/3 수주 확정'], next: ['미결 견적 3건 팔로업'] },
  support: { this: ['RFC 누락 고객 4건 보완'], next: [] },
  pm: { this: [], next: ['신규 품번 12개 카탈로그 반영'] },
  wh: { this: ['9/2 컨테이너 1대 입고'], next: [] },
  mgmt: { this: ['마케팅 담당자 채용 공고 게시'], next: ['최종 면접 2명 일정 확정'] },
};
const okDraft = (over = {}) => ({
  ok: true, from: '2026-08-31', to: '2026-09-04', entry_count: 3,
  model: 'claude-sonnet-4-5', days: [], draft: GOOD_DRAFT, ...over,
});

beforeEach(() => {
  fetchLog = []; fetchRoutes = [];
  dom = new JSDOM(html, {
    url: 'https://example.test/refatrix-wbr.html',
    runScripts: 'dangerously',
    beforeParse(w) {
      w.fetch = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        fetchLog.push({ url: String(url), method, body: opts.body ? JSON.parse(opts.body) : null });
        const m = fetchRoutes.find((r) => r.method === method && String(url).includes(r.urlPart));
        const status = m ? m.status : 200;
        return { ok: status < 400, status, json: async () => (m ? m.payload : {}) };
      };
      w.confirm = () => true;
      w.alert = (msg) => { w.__alert = String(msg); };
      w.print = () => {};
      // 원본 Date 를 유지한 채 「인자 없는 new Date()」만 고정
      w.__freezeDate = (iso) => {
        const R = w.__RealDate || (w.__RealDate = w.Date);
        function F(...a) { return a.length ? new R(...a) : new R(iso); }
        F.prototype = R.prototype; F.now = () => new R(iso).getTime(); F.parse = R.parse; F.UTC = R.UTC;
        w.Date = F;
      };
    },
  });
  win = dom.window;
  win.eval("session={token:'tok',user:{id:1,name:'Seb',role:'director'},api:''};");
  win.eval('isDirector=true; canEdit=true; viewMode=null; jdraftAllowed=true;');
  win.eval('board=normalizeBoard({}); renderIssues();');
  win.__freezeDate('2026-09-02T10:00:00');
});

const $ = (id) => win.document.getElementById(id);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const bullets = (tk, wk) => JSON.parse(win.eval(`JSON.stringify(board.issues['${tk}']['${wk}'])`));
const rows = () => $('jdList').querySelectorAll('.jdrow');
const panelOpen = () => !$('jdOverlay').classList.contains('hidden');
const fire = (el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true }));

async function openPanel(payload = okDraft()) {
  route('POST', '/api/wbr/journal-draft', payload);
  await win.runJournalDraft(); await tick();
}

// ── 버튼 노출 ────────────────────────────────────────────────────────
test('① 버튼 — 디렉터 + 수정권한 + 라이브일 때만 보인다', () => {
  win.eval('applyReadOnly();');
  assert.equal($('jdraftBtn').classList.contains('hidden'), false);
  win.eval('canEdit=false; applyReadOnly();');
  assert.equal($('jdraftBtn').classList.contains('hidden'), true, '열람 전용이면 숨김');
  win.eval('canEdit=true; jdraftAllowed=false; applyReadOnly();');
  assert.equal($('jdraftBtn').classList.contains('hidden'), true, '서버 AI 키 없으면 숨김');
});

test('② 저장본 열람으로 들어가면 버튼도 검토 패널도 닫힌다', async () => {
  await openPanel();
  assert.equal(panelOpen(), true);
  win.eval("viewMode={id:9,label:'2026-W35'}; applyReadOnly();");
  assert.equal($('jdraftBtn').classList.contains('hidden'), true);
  assert.equal(panelOpen(), false, '패널도 닫혀야 한다');
  win.eval('viewMode=null; applyReadOnly();');
  assert.equal($('jdraftBtn').classList.contains('hidden'), false);
});

// ── 이번 주 월~금 ────────────────────────────────────────────────────
test('③ weekMonFri — 주중·월요일·일요일·토요일·연말 경계', () => {
  const cases = [
    ['2026-09-02T10:00:00', '2026-08-31', '2026-09-04'],
    ['2026-08-31T00:30:00', '2026-08-31', '2026-09-04'],
    ['2026-09-06T23:00:00', '2026-08-31', '2026-09-04'],
    ['2026-09-05T12:00:00', '2026-08-31', '2026-09-04'],
    ['2026-12-31T09:00:00', '2026-12-28', '2027-01-01'],
  ];
  for (const [iso, from, to] of cases) {
    win.__freezeDate(iso);
    assert.deepEqual(JSON.parse(win.eval('JSON.stringify(weekMonFri())')), { from, to }, iso);
  }
});

// ── 검토 패널 ────────────────────────────────────────────────────────
test('④ 스캔하면 보드에 쓰지 않고 검토 패널부터 연다', async () => {
  await openPanel();
  const req = fetchLog.find((f) => f.url.includes('journal-draft'));
  assert.deepEqual(req.body, { from: '2026-08-31', to: '2026-09-04' });
  assert.equal(panelOpen(), true);
  assert.equal(rows().length, 7, '제안 7개가 문장별 행으로');
  assert.deepEqual(bullets('sales', 'this'), [], '적용 전에는 보드가 그대로');
  assert.ok($('jdMeta').textContent.includes('8/31(월)~9/4(금)'));
  assert.ok($('jdMeta').textContent.includes('제안 7개'));
  assert.equal(fetchLog.filter((f) => f.method === 'PUT').length, 0, '저장도 안 나간다');
});

test('⑤ 각 행에 AI 제안이 미리 선택돼 있다(조직 · 이번주/다음주)', async () => {
  await openPanel();
  const r0 = rows()[0];
  assert.equal(r0.querySelector('textarea').value, '9/1 Autozone 견적 발송 → 9/3 수주 확정');
  assert.equal(r0.querySelector('[data-org]').value, 'sales');
  assert.equal(r0.querySelector('[data-wk]').value, 'this');
  assert.ok(r0.querySelector('.jdsug').textContent.includes('AI 제안: 영업 · 이번주'));
  assert.equal(r0.querySelector('input[type=checkbox]').checked, true, '기본은 전부 선택');
  const last = rows()[6];
  assert.equal(last.querySelector('[data-org]').value, 'mgmt');
  assert.equal(last.querySelector('[data-wk]').value, 'next');
});

test('⑥ 카테고리를 바꾸면 그 칸이 표시되고 바꾼 개수가 집계된다', async () => {
  await openPanel();
  const sel = rows()[0].querySelector('[data-org]');
  sel.value = 'support'; fire(sel, 'change');
  const r0 = rows()[0];
  assert.equal(r0.querySelector('[data-org]').value, 'support');
  assert.ok(r0.querySelector('[data-org]').classList.contains('changed'), '바꾼 칸은 강조');
  assert.ok(r0.querySelector('.jdsug').textContent.includes('AI 제안: 영업 · 이번주'), '원래 제안을 계속 보여준다');
  assert.ok(r0.querySelector('.jdsug').textContent.includes('바꿈'));
  assert.ok($('jdCount').textContent.includes('카테고리 바꾼 항목 1개'));
});

test('⑦ 바꾼 카테고리대로 보드에 들어간다', async () => {
  await openPanel();
  let sel = rows()[0].querySelector('[data-org]');
  sel.value = 'support'; fire(sel, 'change');            // 영업 → 영업지원
  sel = rows()[0].querySelector('[data-wk]');
  sel.value = 'next'; fire(sel, 'change');               // 이번주 → 다음주
  win.applyJdSelection();

  assert.deepEqual(bullets('sales', 'this'), [], '원래 제안 자리에는 안 들어간다');
  assert.deepEqual(bullets('support', 'next'),
    ['9/1 Autozone 견적 발송 → 9/3 수주 확정'], '고른 자리로 들어간다');
  assert.equal(panelOpen(), false, '적용 후 패널이 닫힌다');
});

test('⑧ 체크를 풀면 그 문장은 넣지 않는다', async () => {
  await openPanel();
  const ck = rows()[0].querySelector('input[type=checkbox]');
  ck.checked = false; fire(ck, 'change');
  assert.ok(rows()[0].classList.contains('off'), '해제한 행은 흐리게');
  assert.ok($('jdApply').textContent.includes('(6)'), '적용 버튼에 선택 개수');
  win.applyJdSelection();
  assert.deepEqual(bullets('sales', 'this'), []);
  assert.deepEqual(bullets('sales', 'next'), ['미결 견적 3건 팔로업'], '나머지는 들어간다');
});

test('⑨ 모두 해제 → 적용 버튼이 잠기고, 모두 선택으로 되돌아온다', async () => {
  await openPanel();
  win.jdSetAll(false);
  assert.equal($('jdApply').disabled, true);
  assert.ok($('jdCount').textContent.includes('선택 0 / 제안 7개'));
  win.jdSetAll(true);
  assert.equal($('jdApply').disabled, false);
  assert.ok($('jdApply').textContent.includes('(7)'));
});

test('⑩ 문장을 직접 고치면 고친 대로 들어간다(공백 정리)', async () => {
  await openPanel();
  const ta = rows()[0].querySelector('textarea');
  ta.value = '  Autozone   수주 확정(내가 고친 문장)  '; fire(ta, 'input');
  win.applyJdSelection();
  assert.deepEqual(bullets('sales', 'this'), ['Autozone 수주 확정(내가 고친 문장)']);
});

test('⑪ 취소하면 보드에 아무것도 안 들어간다', async () => {
  await openPanel();
  win.closeJdPanel();
  assert.equal(panelOpen(), false);
  assert.deepEqual(bullets('sales', 'this'), []);
  assert.deepEqual(bullets('mgmt', 'next'), []);
});

test('⑫ 적용 — 기존 항목 유지 + 같은 문장 중복 제외 + 저장(PUT)', async () => {
  win.eval("board.issues.sales.this=['직접 쓴 기존 항목','9/1 Autozone 견적 발송 → 9/3 수주 확정']; renderIssues();");
  route('PUT', '/api/wbr/board', { ok: true });
  await openPanel();
  win.applyJdSelection();

  assert.deepEqual(bullets('sales', 'this'),
    ['직접 쓴 기존 항목', '9/1 Autozone 견적 발송 → 9/3 수주 확정'], '기존 유지 · 중복 미추가');
  assert.deepEqual(bullets('wh', 'this'), ['9/2 컨테이너 1대 입고']);
  assert.ok($('jdraftHint').textContent.includes('중복 1개 제외'));
  assert.ok($('issueGrid').innerHTML.includes('컨테이너 1대 입고'), '화면에도 그려진다');

  await tick(950);                                   // 저장은 800ms 디바운스
  const put = fetchLog.find((f) => f.method === 'PUT' && f.url.includes('/api/wbr/board'));
  assert.ok(put, '보드 저장 PUT 이 나가야 한다');
  assert.equal(put.body.data.issues.wh.this[0], '9/2 컨테이너 1대 입고');
});

// ── 오류 처리 ────────────────────────────────────────────────────────
test('⑬ 기록이 없으면 패널을 열지 않고 안내만', async () => {
  route('POST', '/api/wbr/journal-draft', { error: 'no_journal' }, 404);
  await win.runJournalDraft(); await tick();
  assert.equal(panelOpen(), false);
  assert.ok($('jdraftHint').textContent.includes('「📝 나의 기록」이 없습니다'));
  assert.deepEqual(bullets('sales', 'this'), []);
});

test('⑭ 서버 오류 종류별 안내 문구', async () => {
  const cases = [
    [{ error: 'no_api_key' }, 503, 'ANTHROPIC_API_KEY'],
    [{ error: 'migration_required' }, 503, 'npm run migrate'],
    [{ error: 'ai_empty' }, 502, '찾지 못했습니다'],
    [{ error: 'ai_failed', detail: 'timeout' }, 502, 'AI 호출 실패'],
  ];
  for (const [payload, status, expect] of cases) {
    fetchRoutes = [];
    route('POST', '/api/wbr/journal-draft', payload, status);
    await win.runJournalDraft(); await tick();
    assert.equal(panelOpen(), false);
    assert.ok($('jdraftHint').textContent.includes(expect), payload.error + ' → ' + $('jdraftHint').textContent);
  }
});

test('⑮ 열람 전용·저장본 열람 중에는 스캔 자체를 안 한다', async () => {
  route('POST', '/api/wbr/journal-draft', okDraft());
  win.eval("viewMode={id:9,label:'x'};");
  await win.runJournalDraft(); await tick();
  win.eval('viewMode=null; canEdit=false;');
  await win.runJournalDraft(); await tick();
  assert.equal(fetchLog.filter((f) => f.url.includes('journal-draft')).length, 0);
});

test('⑯ XSS — 초안에 태그가 섞여 와도 패널·보드 어디서도 실행되지 않는다', async () => {
  await openPanel(okDraft({
    draft: { ...GOOD_DRAFT, sales: { this: ['<img src=x onerror=alert(1)>위험'], next: [] } },
  }));
  assert.equal($('jdList').querySelectorAll('img[onerror]').length, 0, '패널에 img 태그가 생기면 안 된다');
  assert.equal(rows()[0].querySelector('textarea').value, '<img src=x onerror=alert(1)>위험', '값 자체는 보존');
  win.applyJdSelection();
  assert.equal($('issueGrid').querySelectorAll('img[onerror]').length, 0, '보드에도 생기면 안 된다');
  assert.ok($('issueGrid').innerHTML.includes('&lt;img'));
});
