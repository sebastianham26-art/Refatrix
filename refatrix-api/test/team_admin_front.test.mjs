// =====================================================================
// 영업팀 관리 카드 (refatrix-users.html · build u15) — jsdom 동작 검증
//   실행: node --test test/team_admin_front.test.mjs        (jsdom 필요)
//
// 이 카드는 2026-08-19(build u14)에 만들어졌지만 같은 날 다른 작업이
// 옛 파일을 덮어쓰면서 사라졌다(커밋 5cf0e3c). 같은 사고를 다시 겪지
// 않도록, 화면이 실제로 동작하는지 여기서 고정해 둔다.
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = readFileSync(new URL('../../refatrix-users.html', import.meta.url), 'utf8');

const TEAMS = [
  { id: 1, name: '01_Monterrey_01', is_sales: true, sort_order: 1, member_count: 3, customer_count: 42 },
  { id: 2, name: '02_Merida', is_sales: true, sort_order: 2, member_count: 1, customer_count: 7 },
  { id: 9, name: 'director', is_sales: false, sort_order: 99, member_count: 0, customer_count: 0 },
];

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function boot({ teams = TEAMS, responses = {} } = {}) {
  const calls = [];
  const confirms = [];
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  let list = JSON.parse(JSON.stringify(teams));

  // 화면은 fetch 를 두 갈래로 쓴다: 목록은 res.json(), 쓰기는 fetchJsonHard(res.text()).
  // 두 경로 모두 통과하도록 json() 과 text() 를 함께 제공한다.
  const reply = (body, { ok = true, status = 200 } = {}) => ({
    ok, status, json: async () => body, text: async () => JSON.stringify(body),
  });
  w.fetch = async (url, opt = {}) => {
    const u = String(url);
    const method = (opt.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: opt.body ? JSON.parse(opt.body) : null });
    const hit = responses[method + ' ' + (u.split('?')[0])];
    if (hit) return reply(hit.body || {}, { ok: hit.ok !== false, status: hit.status || (hit.ok === false ? 409 : 200) });
    if (u.includes('/api/team-admin/teams')) {
      if (method === 'POST') {
        list.push({ id: 77, name: opt.body ? JSON.parse(opt.body).name : 'x', is_sales: true, sort_order: 0, member_count: 0, customer_count: 0 });
        return reply({ ok: true, id: 77 });
      }
      if (method === 'DELETE') { list = list.filter((t) => t.id !== 9); return reply({ ok: true }); }
      if (method === 'PATCH') return reply({ ok: true });
      return reply({ items: JSON.parse(JSON.stringify(list)) });
    }
    return reply({ items: [] });
  };
  w.alert = () => {};
  w.confirm = (m) => { confirms.push(String(m)); return true; };
  w.eval("session={token:'t',user:{id:1,name:'Dir',role:'director'},api:''};");
  w.eval('loadUsers=async()=>{};');   // 사용자 목록 재조회는 이 테스트 범위 밖
  return { w, calls, confirms };
}

const rows = (w) => Array.from(w.document.querySelectorAll('#teamList tbody tr'));

test('① 카드와 입력 폼이 화면에 있다', () => {
  const { w } = boot();
  assert.ok(w.document.getElementById('teamCard'), '영업팀 관리 카드');
  assert.ok(w.document.getElementById('t-name'), '팀 이름 입력칸');
  assert.ok(w.document.getElementById('t-sort'), '정렬 순서 입력칸');
  assert.ok(w.document.getElementById('t-issales'), '유형 선택');
  assert.ok(w.document.getElementById('t-add'), '＋ 팀 추가 버튼');
  assert.match(w.document.getElementById('teamCard').textContent, /영업팀 관리/);
});

test('② 팀 목록이 이름·유형·정렬·인원·고객과 함께 렌더된다', async () => {
  const { w } = boot();
  await w.loadTeams(); await tick();
  assert.equal(rows(w).length, 3);
  assert.equal(w.document.getElementById('t-name-1').value, '01_Monterrey_01');
  assert.equal(w.document.getElementById('t-is-9').value, '0', 'director 는 비영업');
  assert.equal(w.document.getElementById('t-is-1').value, '1', '영업팀');
  assert.equal(w.document.getElementById('t-sort-2').value, '2');
  assert.match(rows(w)[0].textContent, /3명/);
  assert.match(rows(w)[0].textContent, /42개/);
});

test('③ 소속 인원·고객이 있는 팀은 삭제 버튼이 잠긴다', async () => {
  const { w } = boot();
  await w.loadTeams(); await tick();
  const btns = (id) => Array.from(w.document.getElementById('t-row-' + id).querySelectorAll('button'));
  assert.equal(btns(1).find((b) => b.textContent === '삭제').disabled, true, '인원·고객 있음 → 잠김');
  assert.equal(btns(9).find((b) => b.textContent === '삭제').disabled, false, '둘 다 0 → 삭제 가능');
});

test('④ 「소속 팀」 드롭다운이 팀 목록을 그대로 반영한다', async () => {
  const { w } = boot();
  await w.loadTeams(); await tick();
  const opts = Array.from(w.document.getElementById('n-team').options).map((o) => o.textContent);
  assert.deepEqual(opts, ['미지정', '01_Monterrey_01', '02_Merida', 'director']);
});

test('⑤ 팀 추가 — POST 로 이름·정렬·유형을 보내고 목록이 갱신된다', async () => {
  const { w, calls } = boot();
  await w.loadTeams(); await tick();
  w.document.getElementById('t-name').value = '  03_CDMX  ';
  w.document.getElementById('t-sort').value = '5';
  w.document.getElementById('t-issales').value = '1';
  w.document.getElementById('t-add').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, '팀 추가 요청 전송');
  assert.deepEqual(post.body, { name: '03_CDMX', sort_order: 5, is_sales: true }, '이름 공백은 다듬어 보낸다');
  assert.equal(rows(w).length, 4, '목록 즉시 갱신');
  assert.equal(w.document.getElementById('t-name').value, '', '입력칸 비움');
  assert.match(w.document.getElementById('teamMsg').textContent, /03_CDMX/);
});

test('⑥ 이름이 비면 서버를 부르지 않고 막는다', async () => {
  const { w, calls } = boot();
  await w.loadTeams(); await tick();
  const before = calls.length;
  w.document.getElementById('t-name').value = '   ';
  w.document.getElementById('t-add').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(20);
  assert.equal(calls.length, before, '요청 없음');
  assert.match(w.document.getElementById('teamMsg').textContent, /팀 이름을 입력하세요/);
});

test('⑦ 중복 이름(409 name_taken)은 한국어로 안내한다', async () => {
  const { w } = boot({ responses: { 'POST /api/team-admin/teams': { ok: false, status: 409, body: { error: 'name_taken' } } } });
  await w.loadTeams(); await tick();
  w.document.getElementById('t-name').value = '02_Merida';
  w.document.getElementById('t-add').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(30);
  assert.match(w.document.getElementById('teamMsg').textContent, /같은 이름의 팀이 이미 있습니다/);
  assert.equal(w.document.getElementById('t-add').disabled, false, '실패해도 버튼은 되살아난다');
});

test('⑧ 이름·정렬·유형 저장은 PATCH 로 나가고 팀 id 는 바뀌지 않는다', async () => {
  const { w, calls } = boot();
  await w.loadTeams(); await tick();
  w.document.getElementById('t-name-2').value = '02_Merida_norte';
  w.document.getElementById('t-is-2').value = '0';
  w.document.getElementById('t-sort-2').value = '7';
  w.saveTeam(2); await tick(30);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'PATCH 전송');
  assert.match(patch.url, /\/api\/team-admin\/teams\/2$/, 'id 그대로');
  assert.deepEqual(patch.body, { name: '02_Merida_norte', is_sales: false, sort_order: 7 });
});

test('⑨ 사용 중인 팀 삭제 시도(409 team_in_use)는 남은 인원·고객 수를 알려준다', async () => {
  const { w } = boot({ responses: { 'DELETE /api/team-admin/teams/1': { ok: false, status: 409, body: { error: 'team_in_use', member_count: 3, customer_count: 42 } } } });
  await w.loadTeams(); await tick();
  w.removeTeam(1); await tick(30);
  const msg = w.document.getElementById('teamMsg').textContent;
  assert.match(msg, /3명/);
  assert.match(msg, /42개/);
});

test('⑩ 빈 팀 삭제 — 확인창을 거쳐 DELETE 하고 목록에서 사라진다', async () => {
  const { w, calls, confirms } = boot();
  await w.loadTeams(); await tick();
  w.removeTeam(9); await tick(30);
  assert.match(confirms[0] || '', /삭제하시겠습니까/);
  assert.ok(calls.find((c) => c.method === 'DELETE' && /\/teams\/9$/.test(c.url)), 'DELETE 전송');
  assert.equal(rows(w).length, 2, '목록에서 제거');
});

test('⑪ 확인창을 취소하면 아무 요청도 보내지 않는다', async () => {
  const { w, calls } = boot();
  await w.loadTeams(); await tick();
  w.confirm = () => false;
  const before = calls.length;
  w.removeTeam(9); await tick(20);
  assert.equal(calls.length, before);
});

test('⑫ 팀 이름의 HTML 은 이스케이프된다(주입 없음)', async () => {
  const { w } = boot({ teams: [{ id: 5, name: '<img src=x onerror=alert(1)>', is_sales: true, sort_order: 0, member_count: 0, customer_count: 0 }] });
  await w.loadTeams(); await tick();
  assert.equal(w.document.querySelectorAll('#teamList img').length, 0, 'img 태그로 해석되지 않음');
  assert.equal(w.document.getElementById('t-name-5').value, '<img src=x onerror=alert(1)>', '값 자체는 원문 유지');
  assert.equal(w.document.querySelectorAll('#n-team img').length, 0, '드롭다운도 안전');
});

test('⑬ 빌드 마커', () => {
  assert.match(HTML, /build u15/);
  assert.match(HTML, /id="teamCard"/);
});
