// 로그인 게이트 jsdom 테스트 (2026-10-21)
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const REPO = new URL('../../', import.meta.url).pathname;   // 저장소 루트(HTML 위치)
const NAV = fs.readFileSync(REPO + 'refatrix-nav.js', 'utf8');
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const tok = (exp, id = 1) => 'h.' + b64({ id, exp }) + '.s';
const now = () => Math.floor(Date.now() / 1000);
const LIVE = tok(now() + 3600, 1), LIVE2 = tok(now() + 3600, 2), OLD = tok(now() - 60, 3);
const API = 'https://api.test';
let results = [];
const T = async (name, fn) => { try { await fn(); results.push('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ' :: ' + e.message); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

function makeDom(file, { hash = '', store = null, coarse = true, summary = {} } = {}) {
  let html = fs.readFileSync(REPO + file, 'utf8');
  // 외부 스크립트는 제거하고 nav.js 만 인라인으로 실행
  html = html.replace(/<script[^>]+src="[^"]*"[^>]*><\/script>/g, '');
  const replaced = [];
  const vc = new VirtualConsole();
  const dom = new JSDOM(html, {
    url: 'https://erp.test/' + file + hash, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      if (store) { w.sessionStorage.setItem('refatrix_session', JSON.stringify(store)); }
      w.matchMedia = q => ({ matches: coarse && /coarse/.test(q), addListener() {}, addEventListener() {} });
      w.fetch = async (url, opt = {}) => {
        const auth = (opt.headers && (opt.headers.Authorization || opt.headers.authorization)) || '';
        const t = auth.replace('Bearer ', '');
        if (String(url).includes('/api/login')) return { ok: true, status: 200, json: async () => ({ token: LIVE2, user: { name: 'Sebastian', role: 'director' } }) };
        if (String(url).includes('/api/portal/summary')) {
          if (summary[t] === 401) return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
          return { ok: true, status: 200, json: async () => ({ isDirector: true, role: 'director', pages: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };
      // location.replace 기록 (jsdom 은 탐색 미구현)
      w.__replaced = replaced;
    },
  });
  const w = dom.window;
  try { w.location.replace = u => replaced.push(u); } catch (e) {}
  return { dom, w, replaced };
}
function runNav(w) { const s = w.document.createElement('script'); s.textContent = NAV; w.document.body.appendChild(s); }
const gateScript = f => { const m = fs.readFileSync(REPO + f, 'utf8').match(/<!-- __loginGate --><script>([\s\S]*?)<\/script>/); return m && m[1]; };

// 게이트 스크립트 자체(헤드) 로직 단위 검사 — location.replace 는 jsdom 에서 가로채기 어렵기 때문에 함수로 감싸 실행
function runGate(f, { store = null, hash = '' } = {}) {
  const code = gateScript(f); assert.ok(code, 'gate missing in ' + f);
  const dom = new JSDOM('<html><body>x</body></html>', { url: 'https://erp.test/' + f + hash, runScripts: 'outside-only' });
  const w = dom.window; if (store) w.sessionStorage.setItem('refatrix_session', JSON.stringify(store));
  const calls = [];
  w.__rep = u => calls.push(u);
  w.eval(code.replace('location.replace(', '__rep('));
  return { calls, hidden: w.document.documentElement.style.visibility === 'hidden' };
}

await T('G1 헤드 게이트: 세션 없음 → 숨김 + 포털로', () => { const r = runGate('refatrix-quote.html'); assert.deepEqual(r.calls, ['refatrix-portal.html']); assert.ok(r.hidden); });
await T('G2 헤드 게이트: 만료 세션 → 포털로', () => { const r = runGate('refatrix-finance.html', { store: { token: OLD, api: API } }); assert.equal(r.calls.length, 1); });
await T('G3 헤드 게이트: 유효 세션 → 통과', () => { const r = runGate('refatrix-finance.html', { store: { token: LIVE, api: API } }); assert.equal(r.calls.length, 0); assert.ok(!r.hidden); });
await T('G4 헤드 게이트: 해시 토큰(유효) → 통과', () => { const r = runGate('refatrix-inbound.html', { hash: '#token=' + LIVE }); assert.equal(r.calls.length, 0); });
await T('G5 헤드 게이트: 해시 토큰 "undefined" → 포털로', () => { const r = runGate('refatrix-salesperf.html', { hash: '#token=undefined' }); assert.equal(r.calls.length, 1); });

await T('P1 포털 미로그인(모바일): 상단 메뉴·하단 탭·전체메뉴 없음', async () => {
  const { w } = makeDom('refatrix-portal.html'); runNav(w); await wait(300);
  const nv = w.document.getElementById('rnav');
  assert.equal(nv.style.display, 'none'); assert.equal(nv.innerHTML, '');
  assert.equal(w.document.getElementById('rmtab'), null, '하단 탭이 그려짐');
  w.__rnavDrawer(1); const d = w.document.getElementById('rmdrawer');
  assert.ok(!d || !d.classList.contains('show'), '전체메뉴가 열림');
  assert.ok(!w.document.getElementById('loginCard').classList.contains('hidden'), '로그인 카드가 안 보임');
});

await T('P2 포털: 만료 해시 토큰이 있어도 로그인 화면, 로그인 후 메뉴 정상', async () => {
  const { w } = makeDom('refatrix-portal.html', { hash: '#token=' + OLD + '&api=' + API });
  runNav(w); await wait(200);
  assert.equal(w.document.getElementById('rmtab'), null);
  w.document.getElementById('lid').value = 'sebastian'; w.document.getElementById('pin').value = '1234';
  w.document.getElementById('api').value = API;
  w.document.getElementById('go').click(); await wait(1200);
  assert.ok(w.document.getElementById('loginCard').classList.contains('hidden'), '로그인 카드가 그대로');
  const nv = w.document.getElementById('rnav');
  assert.notEqual(nv.style.display, 'none'); assert.match(nv.textContent, /로그아웃/);
  const tab = w.document.getElementById('rmtab'); assert.ok(tab, '로그인 후 하단 탭 없음'); assert.match(tab.textContent, /전체/);
});

await T('P3 포털: 거절된 옛 토큰(401) 처리 중 로그인해도 새 세션이 지워지지 않음', async () => {
  const { w } = makeDom('refatrix-portal.html', { hash: '#token=' + LIVE + '&api=' + API, summary: { [LIVE]: 401 } });
  runNav(w);
  // 401 응답 전에 바로 로그인
  w.document.getElementById('lid').value = 'sebastian'; w.document.getElementById('pin').value = '1234';
  w.document.getElementById('api').value = API; w.document.getElementById('go').click();
  await wait(1500);
  const s = JSON.parse(w.sessionStorage.getItem('refatrix_session') || 'null');
  assert.ok(s && s.token === LIVE2, '새 세션이 지워짐');
  assert.match(w.document.getElementById('rnav').textContent, /로그아웃/);
  assert.ok(w.document.getElementById('rmtab'), '하단 탭 없음');
});

await T('P4 포털: 401 토큰으로 무한 재시도하지 않음', async () => {
  let calls = 0;
  const { w } = makeDom('refatrix-portal.html', { hash: '#token=' + LIVE + '&api=' + API, summary: { [LIVE]: 401 } });
  const f = w.fetch; w.fetch = (u, o) => { if (String(u).includes('summary')) calls++; return f(u, o); };
  runNav(w); await wait(1500);
  assert.ok(calls <= 1, 'summary 호출 ' + calls + '회');
  assert.equal(w.document.getElementById('rnav').style.display, 'none');
});

await T('N1 일반 화면 미로그인: nav.js 도 포털로 보냄', async () => {
  const { w, replaced } = makeDom('refatrix-salesperf.html'); runNav(w); await wait(200);
  assert.ok(replaced.includes('refatrix-portal.html') || w.document.documentElement.style.visibility === 'hidden', JSON.stringify(replaced));
});

await T('N2 일반 화면 로그인 상태: 메뉴 정상', async () => {
  const { w } = makeDom('refatrix-salesperf.html', { store: { token: LIVE, api: API, user: { name: 'Sebastian' } } }); runNav(w); await wait(400);
  assert.match(w.document.getElementById('rnav').textContent, /로그아웃/);
  assert.ok(w.document.getElementById('rmtab'));
});

await T('D1 데스크톱 포털 로그인 후 상단 메뉴', async () => {
  const { w } = makeDom('refatrix-portal.html', { coarse: false }); runNav(w); await wait(100);
  w.document.getElementById('lid').value = 'sebastian'; w.document.getElementById('pin').value = '1234';
  w.document.getElementById('api').value = API; w.document.getElementById('go').click(); await wait(1200);
  assert.match(w.document.getElementById('rnav').textContent, /로그아웃/);
});

console.log(results.join('\n'));
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
