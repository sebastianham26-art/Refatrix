// 운영 파일에서 "창고 종료(0187)" 블록을 그대로 추출해 jsdom 에서 실행한다(복붙 아님).
import fs from 'fs';
import { JSDOM } from 'jsdom';

const FILE = '/home/claude/repo/refatrix-inbound.html';
const html = fs.readFileSync(FILE, 'utf8');
function block(a, b) {
  const i = html.indexOf(a); if (i < 0) throw new Error('not found: ' + a);
  const j = html.indexOf(b, i); if (j < 0) throw new Error('end not found: ' + b);
  return html.slice(i, j);
}
const src =
  block('  /* ===== 창고 종료(0187) — 적치까지 끝난 선적을 잠가', '  var PAL_LBL=') +
  '\n' +
  block('  /* ===== 창고 종료(0187) — [마감] 탭 맨 아래 =====', '  /* ============ 자동 갱신(25초)');

const dom = new JSDOM('<!doctype html><html><body><div id="stepbody"></div></body></html>');
const doc = dom.window.document;

let DETAIL = null, isDir = false;
const posts = [], toasts = [];
let apiResp = { ok: true, body: { ok: true } };

const ctx = {
  get DETAIL() { return DETAIL; },
  S: { user: { name: 'Ana', role: 'warehouse' } },
  SHIP: 77,
  get isDir() { return isDir; },
  $: (id) => doc.getElementById(id),
  L: (ko) => ko,                                   // 테스트는 한국어 기준
  esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  toast: (m) => toasts.push(m),
  sndErr: () => {}, sndSaved: () => {},
  confirm: () => true,
  refreshDetail: (cb) => { if (cb) cb(); },
  renderDetail: () => {},
  api: (url, opt) => { posts.push({ url, body: JSON.parse((opt && opt.body) || '{}') }); return Promise.resolve(apiResp); },
};
// getter 를 그대로 넘기기 위해 Function 인자는 이름만 쓰고 값은 프록시로 읽는다
const names = ['DETAIL', 'S', 'SHIP', 'isDir', '$', 'L', 'esc', 'toast', 'sndErr', 'sndSaved', 'confirm', 'refreshDetail', 'renderDetail', 'api'];
function build() {
  const fn = new Function(...names, src + '\n; return {renderWhFinish, whPost, applyLock, whLocked, whCheck, whIsRequester, dt, whErrMsg};');
  return fn(...names.map((n) => ctx[n]));
}

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + (extra ? ' — ' + extra : '')); } };
const body = () => doc.getElementById('stepbody');
function render(shipment) {
  DETAIL = { shipment: Object.assign({ id: 1, invoice_no: 'D26-81319563', status: 'closed' }, shipment), pallets: [] };
  body().innerHTML = '';
  const api2 = build();
  api2.renderWhFinish(body());
  return api2;
}
const txt = () => body().textContent;
const has = (id) => !!doc.getElementById(id);

// ── ① 적치 미완료 → 종료 불가
render({ wh_check: { ready: false, reason: 'put_pending', pallets: 5, put_pending: 2, recv_pending: 0 } });
t('적치 미완료: 종료 불가 안내', txt().includes('아직 종료할 수 없습니다'));
t('적치 미완료: 팔렛 수 표시', txt().includes('적치 미완료 2팔렛'), txt());
t('적치 미완료: 신청 버튼 없음', !has('btnWhReq'));

// ── ② 입고 미반영 → 종료 불가 (먼저 마감)
render({ wh_check: { ready: false, reason: 'recv_pending', pallets: 5, put_pending: 0, recv_pending: 3 } });
t('입고 미반영: 먼저 마감 안내', txt().includes('입고 미반영 3팔렛') && txt().includes('먼저 입고'), txt());
t('입고 미반영: 신청 버튼 없음', !has('btnWhReq'));

// ── ③ 팔렛 없음
render({ wh_check: { ready: false, reason: 'no_pallets', pallets: 0, put_pending: 0, recv_pending: 0 } });
t('팔렛 없음 안내', txt().includes('팔렛이 없습니다'));

// ── ④ 조건 충족 + 미신청 → 창고 담당자가 신청
const READY = { ready: true, reason: null, pallets: 5, put_pending: 0, recv_pending: 0 };
render({ wh_check: READY });
t('종료 가능 안내', txt().includes('전 팔렛 적치·입고 완료'));
t('신청 버튼 있음', has('btnWhReq'));
t('승인 버튼 없음(신청 전)', !has('btnWhAppr'));
posts.length = 0;
doc.getElementById('btnWhReq').click();
t('신청 POST 경로', posts.length === 1 && /\/api\/inbound\/77\/wh-finish\/request$/.test(posts[0].url), JSON.stringify(posts));

// ── ⑤ 신청됨 · 창고 담당자(신청자 본인)
render({ wh_check: READY, wh_req_at: '2026-08-27T10:30:00Z', wh_req_by_name: 'Ana', wh_req_is_me: true });
t('승인 대기 표시', txt().includes('디렉터 승인 대기') && txt().includes('Ana'));
t('창고: 승인 버튼 없음', !has('btnWhAppr'));
t('창고: 신청자 본인은 취소 가능', has('btnWhCancel'));
posts.length = 0; doc.getElementById('btnWhCancel').click();
t('취소 POST 경로', posts.length === 1 && /wh-finish\/cancel$/.test(posts[0].url));

// ── ⑤-2 신청됨 · 남이 신청 → 취소 버튼 없음
render({ wh_check: READY, wh_req_at: '2026-08-27T10:30:00Z', wh_req_by_name: 'Beto', wh_req_is_me: false });
t('남의 신청은 취소 버튼 없음', !has('btnWhCancel'));

// ── ⑥ 신청됨 · 디렉터 → PIN 승인
isDir = true;
render({ wh_check: READY, wh_req_at: '2026-08-27T10:30:00Z', wh_req_by_name: 'Ana', wh_req_is_me: false });
t('디렉터: 승인 버튼·PIN', has('btnWhAppr') && has('whPin'));
t('디렉터: 남의 신청도 취소 가능', has('btnWhCancel'));
posts.length = 0; toasts.length = 0;
doc.getElementById('btnWhAppr').click();
t('PIN 없이 승인 시 전송 안 함', posts.length === 0 && toasts.some((m) => m.includes('PIN')), JSON.stringify(toasts));
doc.getElementById('whPin').value = '1234';
doc.getElementById('btnWhAppr').click();
t('승인 POST 경로·PIN 전달', posts.length === 1 && /wh-finish\/approve$/.test(posts[0].url) && posts[0].body.pin === '1234', JSON.stringify(posts));

// ── ⑦ 잠김 · 창고 담당자
isDir = false;
render({ wh_check: READY, wh_req_by_name: 'Ana', wh_locked_at: '2026-08-27T11:00:00Z', wh_locked_by_name: 'Kim' });
t('잠금 배너', txt().includes('창고 종료됨') && txt().includes('Kim'));
t('창고: 해제 버튼 없음', !has('btnWhUnlock'));
t('창고: 디렉터에게 요청 안내', txt().includes('잠금 해제를 요청'));

// ── ⑧ 잠김 · 디렉터 → 해제
isDir = true;
const A = render({ wh_check: READY, wh_locked_at: '2026-08-27T11:00:00Z', wh_locked_by_name: 'Kim' });
t('디렉터: 해제 버튼', has('btnWhUnlock'));
t('해제 버튼은 잠금에서 제외(data-lockok)', doc.getElementById('btnWhUnlock').hasAttribute('data-lockok'));
t('해제 PIN도 data-lockok', doc.getElementById('whPin').hasAttribute('data-lockok'));
posts.length = 0; toasts.length = 0;
doc.getElementById('btnWhUnlock').click();
t('PIN 없이 해제 시 전송 안 함', posts.length === 0);
doc.getElementById('whPin').value = '9999';
doc.getElementById('btnWhUnlock').click();
t('해제 POST 경로·PIN', posts.length === 1 && /wh-finish\/unlock$/.test(posts[0].url) && posts[0].body.pin === '9999');

// ── ⑨ applyLock — 잠긴 선적은 단계 화면 전체가 읽기 전용
body().innerHTML = '<button id="x1">a</button><input id="x2"><select id="x3"></select>'
  + '<div id="x4" role="button">pallet</div>'
  + '<button id="ok1" data-lockok>unlock</button><input id="ok2" data-lockok>';
A.applyLock();
t('잠금: 버튼 비활성', doc.getElementById('x1').disabled);
t('잠금: 입력 비활성', doc.getElementById('x2').disabled);
t('잠금: select 비활성', doc.getElementById('x3').disabled);
t('잠금: role=button 클릭 차단', doc.getElementById('x4').style.pointerEvents === 'none');
t('잠금: data-lockok 는 살아 있음', !doc.getElementById('ok1').disabled && !doc.getElementById('ok2').disabled);
t('잠금: rolock 클래스', body().classList.contains('rolock'));

// 잠금 해제 상태에서는 아무것도 건드리지 않는다
const B = render({ wh_check: READY });
body().innerHTML = '<button id="y1">a</button>';
B.applyLock();
t('미잠금: 버튼 그대로', !doc.getElementById('y1').disabled && !body().classList.contains('rolock'));

// ── ⑩ 서버 거부 메시지 매핑
isDir = true;
const C = render({ wh_check: READY, wh_req_at: '2026-08-27T10:30:00Z', wh_req_by_name: 'Ana' });
toasts.length = 0;
apiResp = { ok: true, body: { error: 'recv_pending' } };
await C.whPost('approve', { pin: '1' }, 'ok');
await new Promise((r) => setTimeout(r, 0));
t('recv_pending 안내', toasts.some((m) => m.includes('입고 반영이 안 된')), JSON.stringify(toasts));
toasts.length = 0;
apiResp = { ok: true, body: { error: 'not_requested' } };
await C.whPost('approve', { pin: '1' }, 'ok');
await new Promise((r) => setTimeout(r, 0));
t('not_requested 안내', toasts.some((m) => m.includes('종료 신청이 먼저')), JSON.stringify(toasts));
t('wh_locked 공통 문구', /디렉터가 잠금을 해제/.test(C.whErrMsg('wh_locked') || ''));
t('무관한 에러는 null', C.whErrMsg('bad_pin') === null);

// ── ⑪ 날짜 표기
t('dt 포맷', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(C.dt('2026-08-27T11:00:00Z')), C.dt('2026-08-27T11:00:00Z'));
t('dt 빈값', C.dt(null) === '');

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
