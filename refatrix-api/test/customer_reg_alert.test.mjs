// 🔒 신규 고객 등록 승인 — 전역 팝업 알림 (refatrix-nav.js) 계약/동작 테스트
//
//   배경: 09-03 모바일 셸에서 고객화면 탭바가 display:none 이 되면서
//         「등록 승인 대기」·「RFC 선점 이관」 탭이 네비에도 없어 접근 불가가 됐다.
//         → 네비 등록 복구 + 화면과 무관하게 뜨는 전역 팝업(디렉터·60초)을 nav.js 에 넣었다.
//   이 테스트가 지키는 것:
//     ① 두 탭이 네비 트리(관리 그룹, 디렉터 전용)에 등록되어 있을 것
//     ② 팝업이 디렉터에게만, 새 건에만 강제로 뜨고, 임시닫기·seen 규칙을 지킬 것
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const NAV = readFileSync(new URL('../../refatrix-nav.js', import.meta.url), 'utf-8');

// ── ① 네비 등록(정적 계약) ────────────────────────────────────────
test('SCREENS 에 custReg(tab:reg) · custClaim(tab:claim) 가 있다', () => {
  assert.match(NAV, /custReg:\{file:'refatrix-customers\.html'[^}]*tab:'reg'\}/);
  assert.match(NAV, /custClaim:\{file:'refatrix-customers\.html'[^}]*tab:'claim'\}/);
});

test('두 화면은 디렉터 전용이고 관리 그룹에 노출된다', () => {
  assert.match(NAV, /custReg:'__director__'/);
  assert.match(NAV, /custClaim:'__director__'/);
  assert.match(NAV, /'custApprove','custReg','custClaim'/);
});

test("이동 버튼은 nav('custReg') 를 타고, nav() 는 SCREENS.tab 을 해시에 붙인다", () => {
  assert.match(NAV, /__rnavCregGo=function\(\)\{[\s\S]*?nav\('custReg'\)/);
  assert.match(NAV, /if\(s\.tab\) hash\+='&tab='/);
});

// ── ② 팝업 동작(jsdom) ────────────────────────────────────────────
async function boot({ role = 'director', href = 'https://x/refatrix-quote.html', alerts = [], seed = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="rnav"></div></body></html>',
    { url: href, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'http://api.test', user: { role } }));
  if (seed) for (const [k, v] of Object.entries(seed)) w.sessionStorage.setItem(k, v);
  const calls = [];
  w.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/api/portal/summary'))
      return { ok: true, status: 200, json: async () => ({ pages: ['customers'], isDirector: role === 'director', role }) };
    if (String(url).includes('/api/portal/customer-reg-alert'))
      return { ok: true, status: 200, json: async () => ({ items: alerts, count: alerts.length }) };
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  w.AudioContext = undefined; w.webkitAudioContext = undefined;  // 알림음 없는 환경에서도 죽지 않아야 한다
  w.eval(NAV);
  await new Promise((r) => setTimeout(r, 60));
  const modal = w.document.getElementById('rnavCregModal');
  return {
    w, modal, calls, close(){ try{ w.close(); }catch(_){} },
    shown: !!modal && modal.style.display === 'flex',
    text: modal ? modal.textContent.replace(/\s+/g, ' ').trim() : '',
    asked: calls.some((u) => u.includes('/api/portal/customer-reg-alert')),
  };
}

const pending = (id, extra = {}) => ([{
  id, code: 'C90' + id, name: 'PENDIENTE ' + id, rfc: null, discount: null,
  registered_at: '2026-09-04 17:30', team_name: '01_Monterrey', owner_name: 'Oscar', ...extra,
}]);

test('디렉터: 대기 건이 있으면 팝업이 뜨고 건수·고객·담당이 보인다', async () => {
  const r = await boot({ alerts: pending(1) });
  assert.equal(r.shown, true);
  assert.match(r.text, /1건/);
  assert.match(r.text, /PENDIENTE 1/);
  assert.match(r.text, /Oscar/);
  assert.match(r.text, /RFC 없음/);   // 선점 안 된 건은 눈에 띄어야 한다
  assert.equal(r.asked, true);
  r.close();
});

test('영업사원에게는 팝업도 없고 요청도 나가지 않는다', async () => {
  const r = await boot({ role: 'sales', alerts: pending(1) });
  assert.equal(r.shown, false);
  assert.equal(r.asked, false);
  r.close();
});

test('대기 0건이면 팝업이 뜨지 않는다', async () => {
  const r = await boot({ alerts: [] });
  assert.equal(r.shown, false);
  r.close();
});

test('승인 화면(#tab=reg)을 보고 있는 동안에는 방해하지 않는다', async () => {
  const r = await boot({ href: 'https://x/refatrix-customers.html#tab=reg', alerts: pending(1) });
  assert.equal(r.shown, false);
  r.close();
});

test('이미 본 건만 남아 있고 임시닫기 상태면 다시 뜨지 않는다', async () => {
  const r = await boot({ alerts: pending(1), seed: { refatrix_custreg_seen: '[1]', refatrix_custreg_dismissed: '1' } });
  assert.equal(r.shown, false);
  r.close();
});

test('새 건이 들어오면 임시닫기를 무시하고 강제로 뜬다', async () => {
  const r = await boot({ alerts: pending(2), seed: { refatrix_custreg_seen: '[1]', refatrix_custreg_dismissed: '1' } });
  assert.equal(r.shown, true);
  assert.ok(JSON.parse(r.w.sessionStorage.getItem('refatrix_custreg_seen') || '[]').includes(2));
  r.close();
});

test('대기가 0건이 되면 임시닫기·본 목록이 초기화된다(다음 건에 다시 울리도록)', async () => {
  const r = await boot({ alerts: [], seed: { refatrix_custreg_seen: '[1,2]', refatrix_custreg_dismissed: '1' } });
  assert.equal(r.w.sessionStorage.getItem('refatrix_custreg_dismissed'), null);
  assert.equal(r.w.sessionStorage.getItem('refatrix_custreg_seen'), '[]');
  r.close();
});

test('「임시로 닫기」는 닫고 플래그를 남긴다', async () => {
  const r = await boot({ alerts: pending(1) });
  r.w.__rnavCregDismiss();
  assert.equal(r.modal.style.display, 'none');
  assert.equal(r.w.sessionStorage.getItem('refatrix_custreg_dismissed'), '1');
  r.close();
});
