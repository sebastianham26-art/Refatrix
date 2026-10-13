// 디렉터 코멘트 팝업(refatrix-wpnotice.js) — jsdom 동작 테스트
//   실행: node --test test/wpnotice_front.test.mjs   (jsdom 필요)
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert/strict';

const POP = readFileSync(new URL('../../refatrix-wpnotice.js', import.meta.url), 'utf8');
const BOARD = readFileSync(new URL('../../refatrix-board.html', import.meta.url), 'utf8');
const WPJS = readFileSync(new URL('../../refatrix-workplan.js', import.meta.url), 'utf8');
const PORTAL = readFileSync(new URL('../../refatrix-portal.html', import.meta.url), 'utf8');

const ITEMS = [{ work_date: '2026-10-12', show_date: '2026-10-13', day_comment: '종합: <b>좋아요</b>', day_comment_at: '2026-10-12T23:00:00Z',
  items: [{ id: 7, title: 'Norte <img src=x onerror=alert(1)>', status: 'missed', note: '부재', dir_comment: '금요일까지', dir_comment_at: '2026-10-12T23:01:00Z' }] }];

const WINS = [];
test.after(() => { WINS.forEach((w) => { try { w.close(); } catch (_) {} }); });
function boot({ html = '<!doctype html><html><head></head><body><div id="noticePopModal" style="display:none"></div></body></html>', items = ITEMS, session = true, seenOk = true } = {}) {
  const calls = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/' });
  const w = dom.window; WINS.push(w);
  let current = items.slice();
  w.fetch = async (url, opt = {}) => {
    const u = String(url); const method = (opt.method || 'GET').toUpperCase();
    calls.push({ url: u, method, headers: opt.headers || {}, body: opt.body ? JSON.parse(opt.body) : null });
    const j = (o, s = 200) => ({ ok: s < 400, status: s, json: async () => o });
    if (u.endsWith('/api/workplan/inbox/unseen')) return j({ items: current });
    if (u.endsWith('/api/workplan/inbox/seen')) { if (!seenOk) return j({ error: 'x' }, 500); current = []; return j({ ok: true, updated: 1 }); }
    if (u.includes('/api/workplan/me')) return j({ today: '2026-10-13', now_min: 500, enabled: false, workday: true, settings: {}, date: '2026-10-13', day: {}, items: [], sum: {}, inbox: [{ ...ITEMS[0], seen_at: null }] });
    if (u.includes('/api/workplan/marks')) return j({ today: '2026-10-13', enabled: true, marks: { '2026-10-13': { total: 0, done: 0, partial: 0, plan: false, done_saved: false, dir: 'new' } } });
    if (u.includes('/api/workplan/settings')) return j({ settings: { workdays: [1, 2, 3, 4, 5, 6] }, today: '2026-10-13' });
    return j({ items: [] });
  };
  if (session) w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'tok', api: 'https://api.example/', user: { id: 2 } }));
  return { w, calls, $: (id) => w.document.getElementById(id), setItems: (x) => { current = x; } };
}
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

test('N1 미확인 코멘트가 있으면 팝업 — 내용·건수·이스케이프·토큰', async () => {
  const { w, calls, $ } = boot();
  w.eval(POP); w.wpNoticeCheck(); await tick();
  const m = $('wpnModal');
  assert.equal(m.style.display, 'flex');
  assert.equal($('wpnTitle').textContent, '📌 디렉터 코멘트 2건');
  const t = $('wpnList').textContent;
  assert.match(t, /10\/12\(월\) 업무에 대해/); assert.match(t, /종합: <b>좋아요<\/b>/); assert.match(t, /못함/); assert.match(t, /내 코멘트: 부재/); assert.match(t, /금요일까지/);
  assert.equal($('wpnList').querySelector('img'), null); assert.equal($('wpnList').querySelector('b'), null, 'XSS 없음');
  const get = calls.find((c) => c.url.endsWith('/inbox/unseen'));
  assert.equal(get.url, 'https://api.example/api/workplan/inbox/unseen'); assert.equal(get.headers.Authorization, 'Bearer tok');
});

test('N2 확인했습니다 → seen POST(날짜) · 닫힘 · wpOnSeen 호출 · 다시 안 뜸', async () => {
  const { w, calls, $ } = boot();
  let hook = null; w.wpOnSeen = (d) => { hook = d; };
  w.eval(POP); w.wpNoticeCheck(); await tick();
  click(w, $('wpnOk')); await tick();
  const post = calls.find((c) => c.url.endsWith('/inbox/seen'));
  assert.deepEqual(post.body, { dates: ['2026-10-12'] });
  assert.equal($('wpnModal').style.display, 'none'); assert.deepEqual(hook, ['2026-10-12']);
  w.wpNoticeCheck(); await tick();
  assert.equal($('wpnModal').style.display, 'none');
});

test('N3 나중에 → 이 세션엔 같은 코멘트 안 뜸 · 새 코멘트가 오면 다시 뜸 · Esc = 나중에', async () => {
  const { w, $, setItems } = boot();
  w.eval(POP); w.wpNoticeCheck(); await tick();
  click(w, $('wpnLater'));
  assert.equal($('wpnModal').style.display, 'none');
  w.wpNoticeCheck(); await tick();
  assert.equal($('wpnModal').style.display, 'none', '같은 코멘트는 다시 안 뜸');
  setItems([{ ...ITEMS[0], day_comment: '수정됨', day_comment_at: '2026-10-13T14:00:00Z' }]);
  w.wpNoticeCheck(); await tick();
  assert.equal($('wpnModal').style.display, 'flex', '코멘트가 바뀌면 다시');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal($('wpnModal').style.display, 'none');
});

test('N4 다른 팝업(공지)이 떠 있으면 기다렸다가 닫히면 뜸 · 로그인 전·코멘트 없음은 아무것도 안 함', async () => {
  const a = boot();
  a.$('noticePopModal').style.display = 'flex';
  a.w.eval(POP); a.w.wpNoticeCheck(); await tick();
  assert.equal(a.$('wpnModal'), null, '공지 팝업 위에 겹치지 않음');
  a.$('noticePopModal').style.display = 'none';
  await tick(4200);
  assert.equal(a.$('wpnModal').style.display, 'flex');
  const b = boot({ session: false }); b.w.eval(POP); b.w.wpNoticeCheck(); await tick();
  assert.equal(b.calls.length, 0);
  const c = boot({ items: [] }); c.w.eval(POP); c.w.wpNoticeCheck(); await tick();
  assert.equal(c.$('wpnModal'), null);
});

test('N5 확인 실패 → 「다시 시도」 · 팝업 유지', async () => {
  const { w, $ } = boot({ seenOk: false });
  w.eval(POP); w.wpNoticeCheck(); await tick();
  click(w, $('wpnOk')); await tick();
  assert.equal($('wpnModal').style.display, 'flex'); assert.equal($('wpnOk').textContent, '다시 시도'); assert.equal($('wpnOk').disabled, false);
});

test('N6 일정 화면 — 팝업 확인 → 달력 💬 표식이 확인됨으로', async () => {
  const { w, $ } = boot({ html: BOARD.replace(/<script src=[^>]*><\/script>/g, '') });
  w.eval(`session={token:'tok',user:{id:2,name:'Oscar'},api:'https://api.example'}; isDirector=false; users=[]; teams=[];`);
  w.eval(WPJS); w.eval(POP);
  await w.wpLoadMarks(new w.Date('2026-10-01T00:00:00'), new w.Date('2026-10-31T00:00:00'));
  assert.match(w.wpMark('2026-10-13'), /💬 코멘트/);
  w.wpNoticeCheck(); await tick();
  click(w, $('wpnOk')); await tick();
  assert.match(w.wpMark('2026-10-13'), /wpmk dir seen/);
});

test('N7 포함 위치 — 포털·일정 화면에 스크립트 태그', () => {
  assert.match(PORTAL, /<script src="refatrix-wpnotice\.js\?v=20261013wn"><\/script>/);
  assert.match(BOARD, /<script src="refatrix-wpnotice\.js\?v=20261013wn"><\/script>/);
});
