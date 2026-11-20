// =====================================================================
// 📱 원클릭 빠른 미팅 녹음 — 프런트 (jsdom, 2026-11-20 · b20261120qr2)
//   refatrix-consult.html#quick=1 로 열면: 빠른 패널만 · 녹음 자동 시작 · 상담 자동 생성(quick:true + 위치)
//   · 입력칸 자동 저장(PATCH, 등록 고객 자동 연결) · 종료 시 그 상담으로 업로드 · 마이크 거부 시 빈 상담 없음
//   · 종합표 「⚠ 정보 입력 필요」 + ✏ 정보 입력 · 전체 화면 전환 · nav.js 하단 🎙 버튼
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-consult.html', import.meta.url), 'utf8');
const navJs = readFileSync(new URL('../../refatrix-nav.js', import.meta.url), 'utf8');

let dom, win, fetchLog, fetchRoutes;
const ALL = [];   // 끝나면 모두 닫는다(창 안의 setInterval 이 프로세스를 붙잡지 않게)
after(() => { for (const w of ALL) { try { w.close(); } catch (_) {} } });
function route(method, urlPart, payload, status = 200) { fetchRoutes.unshift({ method, urlPart, payload, status }); }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function boot({ quick = true, micOk = true, geo = true } = {}) {
  fetchLog = []; fetchRoutes = [];
  dom = new JSDOM(html, {
    url: 'https://example.test/refatrix-consult.html' + (quick ? '#g=sales&quick=1' : ''),
    runScripts: 'dangerously',
    beforeParse(w) {
      w.fetch = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        fetchLog.push({ url: String(url), method, body: opts.body ? String(opts.body) : null });
        const m = fetchRoutes.find((r) => r.method === method && String(url).includes(r.urlPart));
        const payload = m ? m.payload : {};
        const status = m ? m.status : 200;
        return { ok: status < 400, status, json: async () => payload };
      };
      w.alert = () => {}; w.confirm = () => true;
      w.scrollTo = () => {};
      w.navigator.geolocation = geo
        ? { getCurrentPosition: (ok) => ok({ coords: { latitude: 25.6, longitude: -100.3, accuracy: 10 } }) }
        : { getCurrentPosition: (ok, bad) => bad({ code: 1 }) };
      class FakeRecorder {
        constructor(stream, opts) { this.state = 'inactive'; w.__lastRec = this; }
        static isTypeSupported(t) { return t.startsWith('audio/webm'); }
        start() { this.state = 'recording'; }
        pause() { this.state = 'paused'; }
        resume() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; if (this.ondataavailable) this.ondataavailable({ data: { size: 2048, type: 'audio/webm' } }); if (this.onstop) this.onstop(); }
      }
      w.MediaRecorder = FakeRecorder;
      w.navigator.mediaDevices = { getUserMedia: async () => {
        if (!micOk) { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }
        return { getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ stop() {}, readyState: 'live' }] };
      } };
      w.FileReader = class { readAsDataURL() { this.result = 'data:audio/webm;base64,QUJD'; if (this.onload) this.onload(); } };
      w.Blob = class { constructor(parts, o) { this.type = (o && o.type) || ''; this.size = 1234; } slice() { return this; } };
    },
  });
  win = dom.window; ALL.push(win);
  win.eval(`session = { token: 'tok', user: {id:2,name:'Oscar',role:'sales'}, api: '' };`);
}
const $ = (id) => win.document.getElementById(id);
const posts = (part) => fetchLog.filter((f) => f.method === 'POST' && f.url.includes(part));
const patches = () => fetchLog.filter((f) => f.method === 'PATCH');

async function startQuick(opts) {
  boot(opts);
  route('POST', '/api/consults', { id: 88, company_name: '(업체 미입력)', info_pending: true });
  route('GET', '/api/visits/customer-options', { items: [{ id: 5, name: 'Refaccionaria Águila' }, { id: 6, name: 'Zeta' }] });
  route('GET', '/api/consults?', { items: [], categories: [] });
  win.eval('csInit()');
  await tick(60);
}

test('① #quick=1 — 빠른 패널만 보이고 녹음이 바로 시작 · 녹음 카드가 패널 안으로', async () => {
  await startQuick();
  assert.ok(win.document.body.classList.contains('cs-quick'));
  assert.ok(!$('qk-panel').classList.contains('hidden'));
  assert.equal($('cs-recCard').parentNode.id, 'qk-recSlot');
  assert.equal($('cs-restoreCard').parentNode.id, 'qk-restoreSlot');
  assert.equal(win.eval('csRecActive'), true, '녹음 자동 시작');
  assert.ok(!$('cs-recStop').classList.contains('hidden'), '⏹ 종료 버튼이 보인다');
  assert.equal(win.eval('csRecMode'), 'full');
  assert.match($('qk-status').textContent, /녹음 중/);
  assert.ok(!win.location.hash.includes('quick=1'), '새로고침해도 두 번 안 생기게 quick 을 지운다');
  assert.ok(win.location.hash.includes('g=sales'), '다른 해시 값은 유지');
});

test('② 상담은 녹음과 함께 자동 생성 — quick:true + 위치 + 오늘 날짜, 한 번만', async () => {
  await startQuick();
  const p = posts('/api/consults').filter((f) => /\/api\/consults$/.test(f.url));
  assert.equal(p.length, 1, '정확히 한 번');
  const b = JSON.parse(p[0].body);
  assert.equal(b.quick, true);
  assert.equal(b.geo_lat, 25.6);
  assert.equal(b.geo_lng, -100.3);
  assert.match(b.consult_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(b.company_name, null, '업체명 비워도 된다');
  assert.equal(win.eval('csRecConsult.id'), 88, '녹음이 그 상담에 붙는다');
  assert.match($('qk-geo').textContent, /위치 확보/);
  win.eval('qkTick()'); await tick(30);
  assert.equal(posts('/api/consults').filter((f) => /\/api\/consults$/.test(f.url)).length, 1, 'tick 이 다시 만들지 않는다');
});

test('③ 입력칸 자동 저장 — 등록 고객 이름(강세 무시)이면 고객으로 연결 · 직함/연락처', async () => {
  await startQuick();
  route('PATCH', '/api/consults/88', { ok: true, id: 88 });
  $('qk-company').value = 'refaccionaria aguila';
  $('qk-title').value = 'Compras';
  $('qk-contact').value = 'Pedro';
  $('qk-phone').value = '8112345678';
  $('qk-company').dispatchEvent(new win.Event('input'));
  await tick(800);
  const ps = patches();
  assert.equal(ps.length, 1, '디바운스 — 한 번만');
  const b = JSON.parse(ps[0].body);
  assert.equal(b.company_name, 'Refaccionaria Águila', '고객 정식 이름으로');
  assert.equal(b.customer_id, 5);
  assert.equal(b.contact_title, 'Compras');
  assert.equal(b.contact_name, 'Pedro');
  assert.equal(b.wa_phone, '8112345678');
  assert.match($('qk-saved').textContent, /저장됨/);
  assert.match($('qk-saved').textContent, /등록 고객으로 연결/);
  // 바뀐 게 없으면 다시 보내지 않는다
  $('qk-company').dispatchEvent(new win.Event('blur'));
  await tick(30);
  assert.equal(patches().length, 1);
  // 대상자만 바꾸면 그 칸만
  $('qk-contact').value = 'Pedro López';
  $('qk-contact').dispatchEvent(new win.Event('change'));
  await tick(30);
  assert.deepEqual(JSON.parse(patches()[1].body), { contact_name: 'Pedro López' });
  assert.equal($('cs-recTarget').textContent, '— Refaccionaria Águila');
});

test('④ ⏹ 종료 → 그 상담(88)으로 자동 분할 업로드 → 완료 상태 + 새 녹음 버튼', async () => {
  await startQuick();
  route('POST', '/recordings/parts', { ok: true });
  route('POST', '/recordings/commit', { id: 900, status: 'queued', stt_ready: true, ai_ready: true });
  route('GET', '/api/consults/88/recordings', { items: [] });
  route('GET', '/recordings/pending-uploads', { items: [] });
  win.eval('csRecSec = 42;');
  $('cs-recStop').click();
  await tick(500);
  assert.ok(posts('/api/consults/88/recordings/parts').length >= 1, '조각이 88 로');
  assert.ok(posts('/api/consults/88/recordings/commit').length === 1);
  win.eval('qkTick()');
  assert.match($('qk-status').textContent, /업로드 완료/);
  assert.match($('qk-status').textContent, /업체 정보는/, '업체 미입력이면 나중 입력 안내');
  assert.ok(!$('qk-after').classList.contains('hidden'));
});

test('⑤ 상담 생성이 늦거나 실패해도 녹음은 계속 — 업로드 전에 다시 만들어 붙인다', async () => {
  boot();
  route('POST', '/api/consults', { error: 'db' }, 500);
  route('GET', '/api/visits/customer-options', { items: [] });
  route('GET', '/api/consults?', { items: [] });
  win.eval('csInit()');
  await tick(60);
  assert.equal(win.eval('csRecActive'), true, '서버가 실패해도 녹음은 시작돼 있다');
  assert.equal(win.eval('csRecConsult.id'), 0);
  route('POST', '/api/consults', { id: 91, company_name: '(업체 미입력)', info_pending: true });
  route('POST', '/recordings/parts', { ok: true });
  route('POST', '/recordings/commit', { id: 901, status: 'queued', stt_ready: true, ai_ready: true });
  route('GET', '/recordings', { items: [] });
  await tick(1400);                         // 첫 재시도(1.2초) 뒤 성공
  assert.equal(win.eval('csRecConsult.id'), 91);
  win.eval('csRecSec = 30;');
  $('cs-recStop').click();
  await tick(500);
  assert.ok(posts('/api/consults/91/recordings/commit').length === 1, '만들어진 상담으로 업로드');
});

test('⑥ 마이크 거부 — 빈 상담을 만들지 않고 큰 [● 미팅 녹음] 안내', async () => {
  await startQuick({ micOk: false });
  assert.equal(win.eval('csRecActive'), false);
  assert.equal(posts('/api/consults').filter((f) => /\/api\/consults$/.test(f.url)).length, 0, '녹음이 없으면 상담도 없다');
  assert.ok(!$('cs-recStart').classList.contains('hidden'), '시작 버튼이 보인다');
  win.eval('qkStartedAt = Date.now() - 5000; qkTick();');
  assert.match($('qk-status').textContent, /미팅 녹음\]을 누르면/);
});

test('⑦ 위치 거부 — 위치 없이 녹음 · 안내', async () => {
  await startQuick({ geo: false });
  assert.equal(win.eval('csRecActive'), true);
  assert.match($('qk-geo').textContent, /거부/);
  const b = JSON.parse(posts('/api/consults').find((f) => /\/api\/consults$/.test(f.url)).body);
  assert.equal(b.geo_lat, undefined);
});

test('⑧ 전체 화면으로 — 녹음은 계속 · 카드는 원래 자리로', async () => {
  await startQuick();
  $('qk-full').click();
  await tick(20);
  assert.ok(!win.document.body.classList.contains('cs-quick'));
  assert.ok($('qk-panel').classList.contains('hidden'));
  assert.equal($('cs-recCard').nextElementSibling.id, 'cs-recHome');
  assert.equal($('cs-restoreCard').nextElementSibling.id, 'cs-recCard');
  assert.equal(win.eval('csRecActive'), true, '녹음은 끊기지 않는다');
});

test('⑨ 일반 화면(quick 없음)은 예전 그대로 — 패널 숨김 · 자동 녹음 없음 · 🎙 버튼은 바로 시작', async () => {
  boot({ quick: false });
  route('GET', '/api/visits/customer-options', { items: [] });
  route('GET', '/api/consults?', { items: [] });
  win.eval('csInit()');
  await tick(40);
  assert.ok($('qk-panel').classList.contains('hidden'));
  assert.equal(win.eval('csRecActive'), false);
  assert.ok(!posts('/api/consults').length);
  route('POST', '/api/consults', { id: 95 });
  win.__csQuickStart();                      // 하단 🎙 를 이 화면에서 누른 경우
  await tick(60);
  assert.ok(win.document.body.classList.contains('cs-quick'));
  assert.equal(win.eval('csRecActive'), true);
});

test('⑩ 종합표 — 정보 입력 필요 배지 · 직함 · ✏ 입력 폼 자동 열림 → 저장 PATCH', async () => {
  boot({ quick: false });
  route('GET', '/api/visits/customer-options', { items: [{ id: 5, name: 'Refaccionaria Águila' }] });
  route('GET', '/api/consults?', { items: [
    { id: 70, consult_date: '2026-11-20', company_name: '(업체 미입력)', info_pending: true, contact_name: 'Pedro', contact_title: 'Gerente',
      wa_phone: null, email: null, created_by: 2, by_name: 'Oscar', pendings: [], pend_total: 0, pend_done: 0, fup: 'none' },
    { id: 71, consult_date: '2026-11-19', company_name: 'Zeta', info_pending: false, contact_name: 'Ana', contact_title: 'Dueña',
      created_by: 2, by_name: 'Oscar', pendings: [], pend_total: 0, pend_done: 0, fup: 'none' },
  ] });
  win.eval('csInit()');
  await tick(60);
  const t = $('cs-table').innerHTML;
  assert.match(t, /⚠ 정보 입력 필요/);
  assert.ok(!t.includes('(업체 미입력)'), '자리표시자는 표에 그대로 안 보인다');
  assert.match($('cs-table').textContent, /Gerente/);
  win.document.querySelector('tr.crow[data-id="70"]').click();
  await tick(10);
  const box = win.document.querySelector('.cs-edit[data-id="70"]');
  assert.ok(box, '정보 입력 필요 건은 입력 폼이 바로 열린다');
  assert.equal(box.querySelector('.cs-eCompany').value, '', '자리표시자는 입력칸에 안 넣는다');
  assert.equal(box.querySelector('.cs-eTitle').value, 'Gerente');
  route('PATCH', '/api/consults/70', { ok: true, id: 70 });
  box.querySelector('.cs-eCompany').value = 'Refaccionaria Aguila';
  box.querySelector('.cs-editSave').click();
  await tick(30);
  const b = JSON.parse(patches()[0].body);
  assert.equal(b.company_name, 'Refaccionaria Águila');
  assert.equal(b.customer_id, 5);
  assert.equal(b.contact_title, 'Gerente');
  assert.ok(!$('cs-table').innerHTML.includes('⚠ 정보 입력 필요'), '저장 후 배지 사라짐');
  // 일반 건은 ✏ 버튼을 눌러야 열린다 · 업체명을 비우면 저장 거절
  win.document.querySelector('tr.crow[data-id="71"]').click();
  await tick(10);
  assert.ok(!win.document.querySelector('.cs-edit[data-id="71"]'));
  win.document.querySelector('.cs-editBtn[data-id="71"]').click();
  await tick(10);
  const b71 = win.document.querySelector('.cs-edit[data-id="71"]');
  b71.querySelector('.cs-eCompany').value = '';
  b71.querySelector('.cs-editSave').click();
  await tick(20);
  assert.equal(patches().length, 1, '빈 업체명은 보내지 않는다');
  assert.match(b71.querySelector('.cs-eMsg').textContent, /비울 수 없습니다/);
});

test('⑪ XSS — 입력값·고객명은 이스케이프', async () => {
  boot({ quick: false });
  route('GET', '/api/visits/customer-options', { items: [{ id: 9, name: '<img src=x onerror=alert(1)>' }] });
  route('GET', '/api/consults?', { items: [
    { id: 72, consult_date: '2026-11-20', company_name: '(업체 미입력)', info_pending: true, contact_name: '<b>x</b>', contact_title: '"><script>1</script>',
      created_by: 2, pendings: [], pend_total: 0, pend_done: 0, fup: 'none' }] });
  win.eval('csInit()');
  await tick(60);
  assert.ok(!$('cs-table').querySelector('script'));
  assert.ok(!$('cs-custDl').querySelector('img'));
  win.document.querySelector('tr.crow[data-id="72"]').click();
  await tick(10);
  assert.ok(!$('cs-table').querySelector('b x'));
  assert.equal(win.document.querySelector('.cs-edit[data-id="72"] .cs-eTitle').value, '"><script>1</script>');
});

// ── nav.js 하단 🎙 버튼 ─────────────────────────────────────────────
function fakeJwt() {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
  return b({ alg: 'HS256' }) + '.' + b({ sub: 2, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';
}
async function bootNav(summary, file = 'refatrix-customers.html') {
  const d = new JSDOM('<!DOCTYPE html><html><head></head><body><div>page</div></body></html>', {
    url: 'https://example.test/' + file, runScripts: 'dangerously',
    beforeParse(w) {
      w.localStorage.setItem('rfx_m', 'on');
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: fakeJwt(), api: '', user: { id: 2 } }));
      w.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('/api/portal/summary') ? summary : {}) });
      w.navigator.geolocation = { getCurrentPosition() {} };
      w.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} });
    },
  });
  const s = d.window.document.createElement('script'); s.textContent = navJs; d.window.document.body.appendChild(s);
  await tick(80);
  ALL.push(d.window);
  return d.window;
}

test('⑫ nav.js — 영업활동 권한이 있으면 하단 탭바 가운데 🎙 버튼 · 누르면 빠른 녹음', async () => {
  const w = await bootNav({ pages: ['pipeline', 'customers', 'quotelist'], isDirector: false, role: 'sales' });
  const tab = w.document.getElementById('rmtab');
  assert.ok(tab, '모바일 탭바');
  const btns = Array.from(tab.querySelectorAll('button.mt'));
  const rec = tab.querySelector('.mrec');
  assert.ok(rec, '🎙 버튼');
  assert.equal(btns.indexOf(rec), 2, '가운데(세 번째)');
  assert.match(rec.textContent, /녹음/);
  let called = 0; w.__csQuickStart = () => { called++; };
  rec.click();
  assert.equal(called, 1, '고객상담 화면이 이미 열려 있으면 새로고침 없이 바로 시작');
});

test('⑬ nav.js — 영업활동 권한이 없으면(재무 등) 🎙 버튼 없음', async () => {
  const w = await bootNav({ pages: ['finance'], isDirector: false, role: 'treasury' }, 'refatrix-finance.html');
  const tab = w.document.getElementById('rmtab');
  assert.ok(tab);
  assert.ok(!tab.querySelector('.mrec'));
});
