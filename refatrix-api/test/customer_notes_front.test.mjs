// =====================================================================
// refatrix-customers.html 「📝 메모」(고객 상세 · 고객정보 아래) 프런트 — jsdom (0304, build tx-1027cn)
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-customers.html', import.meta.url), 'utf8');
let dom, win, fetchLog, fetchRoutes;
const route = (method, urlPart, payload, status = 200) => fetchRoutes.unshift({ method, urlPart, payload, status });

beforeEach(() => {
  fetchLog = []; fetchRoutes = [];
  dom = new JSDOM(html, {
    url: 'https://example.test/refatrix-customers.html', runScripts: 'dangerously',
    beforeParse(w) {
      w.fetch = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        fetchLog.push({ url: String(url), method, body: opts.body ? String(opts.body) : null });
        const m = fetchRoutes.find((r) => r.method === method && String(url).includes(r.urlPart));
        const status = m ? m.status : 200;
        return { ok: status < 400, status, json: async () => (m ? m.payload : {}) };
      };
      w.alert = (msg) => { w.__alert = String(msg); };
      w.confirm = () => true;
    },
  });
  win = dom.window;
  win.eval("session = { token:'tok', user:{ id:2, name:'Ana', role:'sales' }, api:'' };");
});
const $ = (id) => win.document.getElementById(id);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ITEMS = [
  { id: 9, body: '다음주 방문\n<b>재고</b> 확인', created_at: '2026-10-27 15:30', author: 'Ana', can_delete: true },
  { id: 4, body: '첫 통화', created_at: '2026-10-20 09:05', author: 'Oscar', can_delete: false },
];

test('자리: 고객정보(d-info) 바로 아래에 메모 칸이 있다', () => {
  const info = $('d-info');
  assert.equal(info.nextElementSibling.id, 'd-notes');
});

test('목록: 최신순 · 일시 · 작성자 · 줄바꿈 유지 · HTML 이스케이프 · 본인 것만 ✕', async () => {
  route('GET', '/api/customers/3/notes', { items: ITEMS, can_write: true });
  await win.loadNotes(3); await tick();
  const box = $('d-notes');
  assert.ok(box.innerHTML.includes('📝 메모'));
  assert.ok($('cn-input') && $('cn-save'), '입력칸 + 저장 버튼');
  const items = box.querySelectorAll('.cn-item');
  assert.equal(items.length, 2);
  assert.ok(items[0].textContent.includes('2026-10-27 15:30') && items[0].textContent.includes('Ana'));
  assert.ok(items[0].innerHTML.includes('&lt;b&gt;재고&lt;/b&gt;'), '본문 이스케이프');
  assert.equal(items[0].querySelector('div:last-child').style.whiteSpace, 'pre-wrap');
  assert.equal(box.querySelectorAll('.cn-del').length, 1, '삭제 버튼은 can_delete 인 것만');
});

test('빈 목록 · 쓰기 권한 없음 → 안내만, 입력칸 없음', async () => {
  route('GET', '/api/customers/3/notes', { items: [], can_write: false });
  await win.loadNotes(3); await tick();
  assert.ok($('d-notes').innerHTML.includes('아직 메모가 없습니다'));
  assert.ok($('d-notes').innerHTML.includes('보기만 가능'));
  assert.equal($('cn-input'), null);
});

test('저장: POST 본문 → 다시 불러와 맨 위에 표시', async () => {
  route('GET', '/api/customers/3/notes', { items: [], can_write: true });
  await win.loadNotes(3); await tick();
  route('POST', '/api/customers/3/notes', { ok: true, item: ITEMS[0] });
  route('GET', '/api/customers/3/notes', { items: [ITEMS[0]], can_write: true });
  $('cn-input').value = '  다음주 방문  ';
  $('cn-save').click(); await tick(40);
  const post = fetchLog.find((f) => f.method === 'POST');
  assert.ok(post.url.endsWith('/api/customers/3/notes'));
  assert.deepEqual(JSON.parse(post.body), { body: '다음주 방문' });
  assert.equal($('d-notes').querySelectorAll('.cn-item').length, 1);
  assert.equal($('cn-input').value, '', '저장 후 입력칸 비움');
});

test('Ctrl+Enter 저장 · 빈 내용은 서버로 안 보냄', async () => {
  route('GET', '/api/customers/3/notes', { items: [], can_write: true });
  await win.loadNotes(3); await tick();
  $('cn-save').click(); await tick();
  assert.equal(fetchLog.filter((f) => f.method === 'POST').length, 0);
  assert.ok($('cn-msg').textContent.includes('입력하세요'));
  route('POST', '/api/customers/3/notes', { ok: true, item: ITEMS[1] });
  $('cn-input').value = '첫 통화';
  $('cn-input').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await tick(40);
  assert.equal(fetchLog.filter((f) => f.method === 'POST').length, 1);
});

test('저장 실패: 서버 안내 문구 표시 · 입력 내용 유지', async () => {
  route('GET', '/api/customers/3/notes', { items: [], can_write: true });
  await win.loadNotes(3); await tick();
  route('POST', '/api/customers/3/notes', { error: 'forbidden_team', note: '다른 팀 고객에는 메모를 쓸 수 없습니다.' }, 403);
  $('cn-input').value = '메모';
  $('cn-save').click(); await tick(40);
  assert.ok($('cn-msg').textContent.includes('다른 팀 고객에는'));
  assert.equal($('cn-input').value, '메모');
  assert.equal($('cn-save').disabled, false);
});

test('삭제: DELETE …/notes/:id → 다시 불러옴', async () => {
  route('GET', '/api/customers/3/notes', { items: ITEMS, can_write: true });
  await win.loadNotes(3); await tick();
  route('DELETE', '/api/customers/3/notes/9', { ok: true });
  route('GET', '/api/customers/3/notes', { items: [ITEMS[1]], can_write: true });
  $('d-notes').querySelector('.cn-del').click(); await tick(40);
  assert.ok(fetchLog.some((f) => f.method === 'DELETE' && f.url.endsWith('/api/customers/3/notes/9')));
  assert.equal($('d-notes').querySelectorAll('.cn-item').length, 1);
});

test('늦게 온 응답: 다른 고객으로 넘어간 뒤의 메모는 그리지 않는다', async () => {
  let release;
  fetchRoutes.unshift({ method: 'GET', urlPart: '/api/customers/3/notes', payload: { items: ITEMS, can_write: true }, status: 200 });
  const origFetch = win.fetch;
  win.fetch = async (url, opts) => { if (String(url).includes('/3/notes')) await new Promise((r) => { release = r; }); return origFetch(url, opts); };
  const p3 = win.loadNotes(3);
  route('GET', '/api/customers/5/notes', { items: [], can_write: true });
  await win.loadNotes(5); await tick();
  release(); await p3; await tick();
  assert.ok($('d-notes').innerHTML.includes('아직 메모가 없습니다'), '고객 5 화면 유지');
});
