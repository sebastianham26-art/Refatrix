// =====================================================================
// refatrix-wbr.html 「🤖 나의 기록으로 초안 채우기」 프런트 (jsdom)
//   버튼 노출 조건 · 이번 주 월~금 계산 · 확인창 · 보드 반영(추가/중복) ·
//   저장(PUT) · 오류 안내 · XSS.
//   실행: node --test test/wbr_journal_draft_front.test.mjs
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-wbr.html', import.meta.url), 'utf8');

let dom, win, fetchLog, fetchRoutes, confirmAnswer;
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
  fetchLog = []; fetchRoutes = []; confirmAnswer = true;
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
      w.confirm = (msg) => { w.__confirm = String(msg); return confirmAnswer; };
      w.alert = (msg) => { w.__alert = String(msg); };
      w.print = () => {};
      // 원본 Date 를 유지한 채 「인자 없는 new Date()」만 고정할 수 있게 하는 도우미
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
});

const $ = (id) => win.document.getElementById(id);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const bullets = (tk, wk) => win.eval(`JSON.stringify(board.issues['${tk}']['${wk}'])`);

// ── 버튼 노출 ────────────────────────────────────────────────────────
test('① 버튼 — 디렉터 + 수정권한 + 라이브일 때만 보인다', () => {
  win.eval('applyReadOnly();');
  assert.equal($('jdraftBtn').classList.contains('hidden'), false);

  win.eval('canEdit=false; applyReadOnly();');
  assert.equal($('jdraftBtn').classList.contains('hidden'), true, '열람 전용이면 숨김');

  win.eval('canEdit=true; jdraftAllowed=false; applyReadOnly();');
  assert.equal($('jdraftBtn').classList.contains('hidden'), true, '서버 AI 키 없으면 숨김');
});

test('② 버튼 — 저장본 열람 중에는 숨고, 라이브로 돌아오면 다시 보인다', () => {
  win.eval("viewMode={id:9,label:'2026-W35'}; applyReadOnly();");
  assert.equal($('jdraftBtn').classList.contains('hidden'), true);
  win.eval('viewMode=null; applyReadOnly();');
  assert.equal($('jdraftBtn').classList.contains('hidden'), false);
});

// ── 이번 주 월~금 ────────────────────────────────────────────────────
test('③ weekMonFri — 주중·월요일·일요일 모두 그 주의 월~금', () => {
  const cases = [
    ['2026-09-02T10:00:00', '2026-08-31', '2026-09-04'],  // 수요일
    ['2026-08-31T00:30:00', '2026-08-31', '2026-09-04'],  // 월요일
    ['2026-09-06T23:00:00', '2026-08-31', '2026-09-04'],  // 일요일 → 지난 월요일
    ['2026-09-05T12:00:00', '2026-08-31', '2026-09-04'],  // 토요일
    ['2026-12-31T09:00:00', '2026-12-28', '2027-01-01'],  // 연말 경계
  ];
  for (const [iso, from, to] of cases) {
    win.__freezeDate(iso);
    const r = JSON.parse(win.eval('JSON.stringify(weekMonFri())'));
    assert.deepEqual(r, { from, to }, iso);
  }
});

test('④ mdLabel — 8/31(월) 형태', () => {
  assert.equal(win.eval("mdLabel('2026-08-31')"), '8/31(월)');
  assert.equal(win.eval("mdLabel('2026-09-04')"), '9/4(금)');
});

// ── 실행 ─────────────────────────────────────────────────────────────
test('⑤ 확인창에서 취소하면 서버를 부르지 않는다', async () => {
  win.__freezeDate('2026-09-02T10:00:00');
  confirmAnswer = false;
  await win.runJournalDraft(); await tick();
  assert.ok(win.__confirm.includes('8/31(월)~9/4(금)'), '기간이 확인창에 보인다');
  assert.equal(fetchLog.filter((f) => f.url.includes('journal-draft')).length, 0);
});

test('⑥ 성공 — 이번 주 월~금을 보내고, 5개 조직의 이번주/다음주에 채운다', async () => {
  win.__freezeDate('2026-09-02T10:00:00');
  route('POST', '/api/wbr/journal-draft', okDraft());
  await win.runJournalDraft(); await tick();

  const req = fetchLog.find((f) => f.url.includes('journal-draft'));
  assert.deepEqual(req.body, { from: '2026-08-31', to: '2026-09-04' });

  assert.deepEqual(JSON.parse(bullets('sales', 'this')), GOOD_DRAFT.sales.this);
  assert.deepEqual(JSON.parse(bullets('sales', 'next')), GOOD_DRAFT.sales.next);
  assert.deepEqual(JSON.parse(bullets('pm', 'next')), GOOD_DRAFT.pm.next);
  assert.deepEqual(JSON.parse(bullets('support', 'next')), []);

  const h = $('issueGrid').innerHTML;
  assert.ok(h.includes('Autozone 견적 발송'), '화면에도 그려진다');
  assert.ok(h.includes('최종 면접 2명 일정 확정'));
  assert.ok($('jdraftHint').textContent.includes('7개 항목'), '채운 개수를 알려준다');
  assert.ok($('jdraftHint').textContent.includes('고쳐 주세요'), '직접 수정하라는 안내');
});

test('⑦ 기존 항목은 지우지 않고 뒤에 추가 · 같은 문장은 중복 제외', async () => {
  win.__freezeDate('2026-09-02T10:00:00');
  win.eval("board.issues.sales.this=['직접 쓴 기존 항목','9/1 Autozone 견적 발송 → 9/3 수주 확정']; renderIssues();");
  route('POST', '/api/wbr/journal-draft', okDraft());
  await win.runJournalDraft(); await tick();

  assert.deepEqual(JSON.parse(bullets('sales', 'this')),
    ['직접 쓴 기존 항목', '9/1 Autozone 견적 발송 → 9/3 수주 확정'],
    '기존 항목 유지 + 같은 문장은 다시 안 들어간다');
  assert.ok($('jdraftHint').textContent.includes('중복 1개 제외'));
  assert.ok(win.__confirm.includes('기존 항목 2개'), '확인창이 기존 개수를 알려준다');
});

test('⑧ 채운 뒤 서버에 보드를 저장한다(PUT /api/wbr/board)', async () => {
  win.__freezeDate('2026-09-02T10:00:00');
  route('POST', '/api/wbr/journal-draft', okDraft());
  route('PUT', '/api/wbr/board', { ok: true });
  await win.runJournalDraft();
  await tick(950);                                   // 저장은 800ms 디바운스
  const put = fetchLog.find((f) => f.method === 'PUT' && f.url.includes('/api/wbr/board'));
  assert.ok(put, '보드 저장 PUT 이 나가야 한다');
  assert.equal(put.body.data.issues.wh.this[0], '9/2 컨테이너 1대 입고');
  assert.ok($('issueSave').textContent.includes('저장'), '저장 표시가 뜬다');
});

test('⑨ 기록이 없으면 안내만 뜨고 보드는 그대로', async () => {
  win.__freezeDate('2026-09-02T10:00:00');
  route('POST', '/api/wbr/journal-draft', { error: 'no_journal' }, 404);
  await win.runJournalDraft(); await tick();
  assert.ok($('jdraftHint').textContent.includes('「📝 나의 기록」이 없습니다'));
  assert.deepEqual(JSON.parse(bullets('sales', 'this')), []);
});

test('⑩ 서버 오류 종류별 안내 문구', async () => {
  win.__freezeDate('2026-09-02T10:00:00');
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
    assert.ok($('jdraftHint').textContent.includes(expect), payload.error + ' → ' + $('jdraftHint').textContent);
  }
});

test('⑪ 저장본 열람 중·열람 전용이면 실행 자체를 안 한다', async () => {
  win.__freezeDate('2026-09-02T10:00:00');
  route('POST', '/api/wbr/journal-draft', okDraft());
  win.eval("viewMode={id:9,label:'x'};");
  await win.runJournalDraft(); await tick();
  win.eval('viewMode=null; canEdit=false;');
  await win.runJournalDraft(); await tick();
  assert.equal(fetchLog.filter((f) => f.url.includes('journal-draft')).length, 0);
});

test('⑫ XSS — 초안에 태그가 섞여 와도 이스케이프된다', async () => {
  win.__freezeDate('2026-09-02T10:00:00');
  route('POST', '/api/wbr/journal-draft', okDraft({
    draft: { ...GOOD_DRAFT, sales: { this: ['<img src=x onerror=alert(1)>위험'], next: [] } },
  }));
  await win.runJournalDraft(); await tick();
  assert.equal($('issueGrid').querySelectorAll('img[onerror]').length, 0, 'img 태그가 생기면 안 된다');
  assert.ok($('issueGrid').innerHTML.includes('&lt;img'), '문자열로 이스케이프되어 보인다');
});
