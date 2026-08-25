// 일지(나의 기록) 프런트 동작 테스트 — refatrix-board.html 인라인 JS 를 jsdom 에서 실제로 돌린다.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert';

const HTML = readFileSync(new URL('../../refatrix-board.html', import.meta.url), 'utf8');

function boot({ director = true, journal = {} } = {}) {
  const calls = [];
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  const store = JSON.parse(JSON.stringify(journal)); // {date: content}
  w.fetch = async (url, opt = {}) => {
    const u = String(url); const method = (opt.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: opt.body ? JSON.parse(opt.body) : null });
    const j = (o, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => o });
    const m = u.match(/\/api\/journal\/(\d{4}-\d{2}-\d{2})/);
    if (m) {
      const d = m[1];
      if (method === 'GET') return j({ date: d, content: store[d] || '', exists: !!store[d], updated_at: store[d] ? '2026-08-24T10:00:00.000Z' : null });
      if (method === 'PUT') {
        const c = String(opt.body ? JSON.parse(opt.body).content : '').trim();
        if (!c) { delete store[d]; return j({ ok: true, deleted: true, date: d, content: '' }); }
        const created = !store[d]; store[d] = c;
        return j({ ok: true, date: d, content: c, created, updated_at: '2026-08-24T11:00:00.000Z' });
      }
      if (method === 'DELETE') { delete store[d]; return j({ ok: true, deleted: true }); }
    }
    if (u.includes('/api/journal?')) return j({ items: [], dates: Object.keys(store) });
    if (u.includes('/api/calendar')) return j({ items: [] });
    if (u.includes('/api/todos')) return j({ items: [] });
    return j({});
  };
  w.confirm = () => true;
  w.eval(`session={token:'t',user:{id:1,name:'디렉터'},api:''}; isDirector=${director ? 'true' : 'false'}; users=[]; teams=[];`);
  return { w, calls, store, dom };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('디렉터: 날짜 상세 모달에 「나의 기록」 칸이 생기고 기존 내용이 불러와진다', async () => {
  const { w } = boot({ journal: { '2026-08-24': '어제 쓴 기록' } });
  w.openDay('2026-08-24');
  await tick();
  const ta = w.document.getElementById('jr-content');
  assert.ok(ta, '기록 입력칸 존재');
  assert.equal(ta.value, '어제 쓴 기록');
  assert.match(w.document.getElementById('dmBody').textContent, /나의 기록/);
  assert.match(w.document.getElementById('dmBody').textContent, /나만 보임 · 나만 수정/);
  assert.equal(w.document.getElementById('jr-delBtn').style.display, '', '기록이 있으면 삭제 버튼 노출');
});

test('일반 직원: 기록 칸이 아예 렌더되지 않는다', async () => {
  const { w, calls } = boot({ director: false });
  w.openDay('2026-08-24');
  await tick();
  assert.equal(w.document.getElementById('jr-content'), null);
  assert.equal(calls.filter((c) => c.url.includes('/api/journal')).length, 0, '일지 API 호출도 없음');
});

test('신규 날짜는 빈 칸 + 「아직 기록 없음」, 삭제 버튼 숨김', async () => {
  const { w } = boot();
  w.openDay('2026-08-25');
  await tick();
  assert.equal(w.document.getElementById('jr-content').value, '');
  assert.equal(w.document.getElementById('jr-stamp').textContent, '아직 기록 없음');
  assert.equal(w.document.getElementById('jr-delBtn').style.display, 'none');
});

test('저장 → PUT 으로 내용 전송, 성공 메시지, 표식 등록', async () => {
  const { w, calls, store } = boot();
  w.openDay('2026-08-25');
  await tick();
  w.document.getElementById('jr-content').value = '오늘 창고 점검 완료';
  await w.saveJournal();
  await tick();
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put, 'PUT 호출됨');
  assert.equal(put.url, '/api/journal/2026-08-25');
  assert.equal(put.body.content, '오늘 창고 점검 완료');
  assert.equal(store['2026-08-25'], '오늘 창고 점검 완료');
  assert.match(w.document.getElementById('jr-msg').textContent, /저장했습니다/);
  assert.equal(w.document.getElementById('jr-delBtn').style.display, '');
});

test('같은 날 다시 열어 수정하면 갱신된다(일기 수정)', async () => {
  const { w, store } = boot({ journal: { '2026-08-24': '처음 내용' } });
  w.openDay('2026-08-24');
  await tick();
  w.document.getElementById('jr-content').value = '고친 내용';
  await w.saveJournal();
  assert.equal(store['2026-08-24'], '고친 내용');
  w.openDay('2026-08-24');
  await tick();
  assert.equal(w.document.getElementById('jr-content').value, '고친 내용');
});

test('내용을 비우고 저장하면 그 날 기록이 삭제된다', async () => {
  const { w, store } = boot({ journal: { '2026-08-24': '지울 기록' } });
  w.openDay('2026-08-24');
  await tick();
  w.document.getElementById('jr-content').value = '   ';
  await w.saveJournal();
  assert.equal(store['2026-08-24'], undefined);
  assert.equal(w.document.getElementById('jr-stamp').textContent, '아직 기록 없음');
});

test('삭제 버튼 → DELETE 호출 후 칸이 비워진다', async () => {
  const { w, calls, store } = boot({ journal: { '2026-08-24': '지울 기록' } });
  w.openDay('2026-08-24');
  await tick();
  await w.delJournal();
  assert.ok(calls.find((c) => c.method === 'DELETE' && c.url.includes('2026-08-24')));
  assert.equal(store['2026-08-24'], undefined);
  assert.equal(w.document.getElementById('jr-content').value, '');
});

test('달력 월간 칸에 기록 표식(📝)이 본인에게만 찍힌다', async () => {
  const { w } = boot({ journal: { '2026-08-24': '기록' } });
  w.eval("calCursor=new Date(2026,7,24); calView='month';");
  await w.loadCal();
  await tick();
  const cells = [...w.document.querySelectorAll('#calGrid .cgcell')];
  const marked = cells.filter((c) => c.querySelector('.jrdot'));
  assert.equal(marked.length, 1, '기록 있는 하루에만 표식');
  assert.match(marked[0].textContent, /24/);

  const plain = boot({ director: false, journal: { '2026-08-24': '기록' } });
  plain.w.eval("calCursor=new Date(2026,7,24); calView='month';");
  await plain.w.loadCal();
  await tick();
  assert.equal(plain.w.document.querySelectorAll('#calGrid .jrdot').length, 0, '직원 화면엔 표식 없음');
});

test('미저장 상태로 닫으려 하면 확인을 묻고, 취소하면 모달이 닫히지 않는다', async () => {
  const { w } = boot({ journal: { '2026-08-24': '원문' } });
  w.openDay('2026-08-24');
  await tick();
  w.document.getElementById('jr-content').value = '쓰다 만 글';
  let asked = 0;
  w.confirm = () => { asked++; return false; };
  w.closeDay();
  assert.equal(asked, 1, '확인창 호출');
  assert.equal(w.document.getElementById('dayModal').style.display, 'flex', '닫히지 않음');
  w.confirm = () => true;
  w.closeDay();
  assert.equal(w.document.getElementById('dayModal').style.display, 'none');
});

test('서버가 503(마이그레이션 전)이어도 달력은 정상 렌더된다', async () => {
  const { w } = boot();
  w.fetch = async (url) => {
    if (String(url).includes('/api/journal')) return { ok: false, status: 503, json: async () => ({ error: 'migration_required', message: 'npm run migrate 를 실행하세요.' }) };
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  w.eval("calCursor=new Date(2026,7,24); calView='month';");
  await w.loadCal();
  await tick();
  assert.ok(w.document.querySelectorAll('#calGrid .cgcell').length > 0, '달력 칸 렌더됨');
  w.openDay('2026-08-24');
  await tick();
  assert.match(w.document.getElementById('jr-stamp').textContent, /migrate/);
  assert.equal(w.document.getElementById('jr-content').disabled, false, '입력칸은 잠기지 않음');
});
