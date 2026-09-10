// =====================================================================
// refatrix-consult.html 「🎪 전시회 미팅 시간표」 프런트 (jsdom, 2026-08-26)
//   실제 HTML 전체를 로드하고 fetch/MediaRecorder 를 스텁해
//   모드 전환 → 보드 렌더(하루씩/전체) → 미팅 등록·수정 → 녹음 연결 →
//   정성목표 판단 → 담당자 색상/필터 를 검증.
// =====================================================================
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-consult.html', import.meta.url), 'utf8');

let dom, win, fetchLog, fetchRoutes;
function route(method, urlPart, payload, status = 200) { fetchRoutes.push({ method, urlPart, payload, status }); }
function routeThrow(method, urlPart) { fetchRoutes.push({ method, urlPart, throwErr: true, payload: {}, status: 0 }); }
function sent(method, urlPart) {
  const r = [...fetchLog].reverse().find((x) => x.method === method && x.url.includes(urlPart));
  return r ? JSON.parse(r.body || '{}') : null;
}

const OWNERS = [
  { id: 1, name: 'Sebastian', login_id: 'admin', bg: '#DFF1EA', fg: '#0F6E56', border: '#B4DCCC' },
  { id: 2, name: 'Oscar', login_id: 'oscar', bg: '#FBEEDA', fg: '#8A6512', border: '#EBD5A6' },
  { id: 3, name: 'Maria', login_id: 'maria', bg: '#F9DEDE', fg: '#9A1F1F', border: '#EEBDBD' },
];
const M1 = {
  id: 1, day_no: 1, slot_hour: 9, meet_date: '2026-09-16', owner_user_id: 2, owner_name: 'Oscar',
  customer_id: 101, company_name: 'Grupo Zeta <b>', contact_name: 'Juan', wa_phone: '81-1234-5678', email: null,
  goal_note: '연간 계약 의향 확인', memo: '', target_quote: 850000, target_order: 400000,
  actual_quote: null, actual_order: null, status: 'planned', is_walkin: false,
  consult_id: null, consult_hidden: false, rec_status: null, rec_id: null, duration_sec: null,
  has_ai: false, summary: null, qual_result: null, qual_eval: null, qual_eval_json: null, created_by: 2,
  kind: 'meeting', is_confirmed: false, confirmed_at: null,
};
const M2 = {
  id: 2, day_no: 1, slot_hour: 11, meet_date: '2026-09-16', owner_user_id: 3, owner_name: 'Maria',
  customer_id: null, company_name: 'El Aguila', contact_name: null, wa_phone: null, email: null,
  goal_note: '신뢰 회복', memo: '정산 확인', target_quote: 420000, target_order: 250000,
  actual_quote: 460000, actual_order: 250000, status: 'done', is_walkin: false,
  consult_id: 500, consult_hidden: false, rec_status: 'done', rec_id: 900, duration_sec: 1122,
  has_ai: true, summary: { resumen: 'ok' },
  qual_result: 'partial', qual_eval: '합의 없음',
  qual_eval_json: { result: 'partial', evidence: ['근거1'], quote_amount: 460000, order_amount: null, next_step: '재제안' },
  created_by: 3, kind: 'meeting', is_confirmed: true, confirmed_at: '2026-09-10T00:00:00Z',
};
const M3 = {
  ...M1, id: 3, day_no: 2, slot_hour: 12, meet_date: '2026-09-17', company_name: 'Llantas',
  is_walkin: true, status: 'done', target_quote: 0, target_order: 0, goal_note: null, created_by: 2,
};
// 약속 없이 고객 부스를 직접 찾아가는 영업 — 담당자 색이 아니라 공통 회색
const M4 = {
  ...M1, id: 4, day_no: 3, slot_hour: 15, meet_date: '2026-09-18', company_name: 'Frenos del Golfo',
  kind: 'booth', is_confirmed: false, status: 'planned', target_quote: 0, target_order: 0, created_by: 2,
};

function boardPayload(extra) {
  const meetings = (extra && extra.meetings) || [M1, M2, M3, M4];
  return {
    exhibition: { id: 10, name: 'RUJAC 2026', venue: 'Expo Guadalajara', start_date: '2026-09-16',
      day_count: 3, start_hour: 8, end_hour: 18, currency: 'MXN', is_active: true },
    days: [
      { day_no: 1, date: '2026-09-16', label: '1st day', weekday: '수' },
      { day_no: 2, date: '2026-09-17', label: '2nd day', weekday: '목' },
      { day_no: 3, date: '2026-09-18', label: '3rd day', weekday: '금' },
    ],
    hours: Array.from({ length: 10 }, (_, i) => ({
      hour: 8 + i, label: String(8 + i).padStart(2, '0') + ':00',
      range: String(8 + i).padStart(2, '0') + ':00–' + String(9 + i).padStart(2, '0') + ':00',
    })),
    owners: OWNERS, meetings,
    totals: { total: 4, meeting: 3, booth: 1, confirmed: 1, unconfirmed: 2,
      planned: 2, done: 2, noshow: 0, walkin: 1, cancelled: 0, recorded: 1,
      target_quote: 1270000, target_order: 650000, actual_quote: 460000, actual_order: 250000,
      rate_quote: 36.2, rate_order: 38.5, qual: { achieved: 0, partial: 1, missed: 0 } },
    owner_totals: [
      { owner_user_id: 2, count: 3, booth: 1, target_quote: 850000, target_order: 400000, actual_quote: 0, actual_order: 0 },
      { owner_user_id: 3, count: 1, target_quote: 420000, target_order: 250000, actual_quote: 460000, actual_order: 250000 },
    ],
    unset_color: { bg: '#F2F0EA', fg: '#6B6B6B', border: '#DED9CE' },
    booth_color: { bg: '#EDEBE4', fg: '#5B5B57', border: '#D8D3C6' },
    mx_today: '2026-09-17', now: { day_no: 2, hour: 12, date: '2026-09-17' },
    is_director: true, me: 1, ai_ready: true,
  };
}

function boot(user) {
  if (dom) { try { dom.window.close(); } catch (_) {} }   // 이전 창의 타이머(보드 재조회 등)를 정리
  fetchLog = []; fetchRoutes = [];
  dom = new JSDOM(html, {
    url: 'https://example.test/refatrix-consult.html',
    runScripts: 'dangerously',
    beforeParse(w) {
      w.fetch = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        fetchLog.push({ url: String(url), method, body: opts.body ? String(opts.body) : null });
        const m = [...fetchRoutes].reverse().find((r) => r.method === method && String(url).includes(r.urlPart));
        if (m && m.throwErr) throw new TypeError('Failed to fetch');
        const payload = m ? m.payload : {};
        const status = m ? m.status : 200;
        return { ok: status < 400, status, json: async () => payload };
      };
      w.alert = () => {}; w.confirm = () => true;
      w.navigator.geolocation = { getCurrentPosition: (ok) => ok({ coords: { latitude: 25.6, longitude: -100.3, accuracy: 10 } }) };
      class FakeRecorder {
        constructor(stream, opts) { this.stream = stream; this.opts = opts; this.state = 'inactive'; this._chunks = []; w.__lastRec = this; }
        static isTypeSupported(t) { return t.startsWith('audio/webm'); }
        start() { this.state = 'recording'; }
        pause() { this.state = 'paused'; }
        resume() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; if (this.ondataavailable) this.ondataavailable({ data: { size: 2048, type: 'audio/webm' } }); if (this.onstop) this.onstop(); }
      }
      w.MediaRecorder = FakeRecorder;
      w.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ stop() {}, readyState: 'live' }] }) };
      w.FileReader = class { readAsDataURL() { this.result = 'data:audio/webm;base64,QUJD'; if (this.onload) this.onload(); } };
      w.Blob = class { constructor(parts, o) { this.parts = parts; this.type = (o && o.type) || ''; this.size = 1234; } slice() { return this; } };
    },
  });
  win = dom.window;
  win.eval(`session = { token: 'tok', user: ${JSON.stringify(user)}, api: '' };`);
}

const $ = (id) => win.document.getElementById(id);
const qsa = (sel) => Array.from(win.document.querySelectorAll(sel));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function openBoard(extra) {
  route('GET', '/api/exhibitions', { items: [{ id: 10, name: 'RUJAC 2026', start_date: '2026-09-16', is_active: true }], active_id: 10 });
  route('GET', '/board', boardPayload(extra));
  $('modeExpo').click();
  await tick(40);
}

beforeEach(() => boot({ id: 1, name: 'Sebastian', role: 'director' }));
after(() => { if (dom) { try { dom.window.close(); } catch (_) {} } });

// ── 모드 전환 ───────────────────────────────────────────────────────
test('초기: 모드 버튼 2개가 있고 전시회 섹션은 숨겨져 있다', () => {
  assert.ok($('modeNormal') && $('modeExpo'));
  assert.ok($('expoMode').classList.contains('ex-hidden'));
  assert.ok(!$('normalMode').classList.contains('ex-hidden'));
});

test('🎪 버튼: 전시회 보드가 열리고 일반 고객상담 화면은 감춰진다', async () => {
  await openBoard();
  assert.ok(!$('expoMode').classList.contains('ex-hidden'));
  assert.ok($('normalMode').classList.contains('ex-hidden'));
  assert.ok($('modeExpo').classList.contains('on'));
  assert.equal($('ex-name').textContent, 'RUJAC 2026');
  assert.ok($('ex-meta').textContent.includes('08:00–18:00'));
  assert.ok($('ex-meta').textContent.includes('MXN'));
});

test('🧾 버튼: 다시 일반 고객상담으로 돌아온다', async () => {
  await openBoard();
  $('modeNormal').click();
  assert.ok($('expoMode').classList.contains('ex-hidden'));
  assert.ok(!$('normalMode').classList.contains('ex-hidden'));
});

test('전시회가 없으면 등록 안내가 나온다', async () => {
  route('GET', '/api/exhibitions', { items: [], active_id: null });
  $('modeExpo').click();
  await tick(40);
  assert.ok($('ex-boardBox').textContent.includes('등록된 전시회가 없습니다'));
});

// ── 시간표 렌더 ─────────────────────────────────────────────────────
test('전체 보기: 가로축 3일 × 세로축 10칸 시간표가 만들어진다', async () => {
  await openBoard();
  win.eval("exSetView('grid')");
  const th = qsa('table.ex-tt thead th');
  assert.equal(th.length, 4, '시간 열 + 3일');
  assert.ok(th[1].textContent.includes('1st day') && th[1].textContent.includes('2026-09-16'));
  assert.ok(th[3].textContent.includes('3rd day'));
  assert.equal(qsa('table.ex-tt tbody tr').length, 10, '08:00~17:00 10칸');
  assert.equal(qsa('.ex-cell').length, 30);
});

test('하루씩 보기(모바일 기본): 선택한 날의 10개 시간 슬롯만 나온다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  assert.equal(qsa('.ex-slot').length, 10);
  assert.equal(qsa('.ex-daytab').length, 3);
  // now.day_no = 2 이므로 2일차가 선택돼 있고 그 날 미팅(즉석 1건)만 보인다
  assert.ok($('ex-daytabs').querySelector('.ex-daytab.on').textContent.includes('2nd day'));
  assert.equal(qsa('.ex-chip').length, 1);
  assert.ok(qsa('.ex-chip')[0].textContent.includes('Llantas'));
});

test('날짜 탭을 누르면 그 날 미팅으로 바뀐다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click();
  await tick();
  assert.equal(qsa('.ex-chip').length, 2, '1일차 미팅 2건');
  assert.ok($('ex-boardBox').textContent.includes('El Aguila'));
});

test('오늘 날짜·시간 칸이 강조된다(지금 미팅 기록 안내)', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  const nowSlot = qsa('.ex-slot.now');
  assert.equal(nowSlot.length, 1);
  assert.ok(nowSlot[0].textContent.includes('12:00'));
  assert.ok($('ex-daytabs').querySelector('.ex-daytab.today').textContent.includes('오늘'));
});

test('칩: 담당자 색·상태 마크·목표금액이 표시되고 업체명은 이스케이프된다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click();
  await tick();
  const chips = qsa('.ex-chip');
  const zeta = chips.find((c) => c.textContent.includes('Grupo Zeta'));
  assert.ok(zeta.getAttribute('style').includes('#FBEEDA'), 'Oscar 색');
  assert.ok(zeta.textContent.includes('Oscar'));
  assert.ok(zeta.textContent.includes('견적 850k'));
  assert.ok(!$('ex-boardBox').innerHTML.includes('Zeta <b>'), 'XSS 이스케이프');
  const aguila = chips.find((c) => c.textContent.includes('El Aguila'));
  assert.ok(aguila.textContent.includes('완료'));
  assert.ok(aguila.textContent.includes('정성 △'));
  assert.ok(aguila.textContent.includes('🎙'));
});

test('KPI: 목표·달성·정성목표 현황이 나온다', async () => {
  await openBoard();
  const t = $('ex-kpis').textContent;
  assert.ok(t.includes('$1,270,000'), '견적 목표 합계');
  assert.ok(t.includes('$460,000'), '견적 달성 합계');
  assert.ok(t.includes('36.2%'));
  assert.ok(t.includes('부분 1'));
});

test('담당자 범례: 색상 칩과 건수가 나오고 누르면 그 사람만 강조된다', async () => {
  await openBoard();
  win.eval("exSetView('grid')");
  const lgs = qsa('.ex-lg');
  assert.ok(lgs.length >= 2);
  const oscar = lgs.find((b) => b.textContent.includes('Oscar'));
  assert.ok(oscar.innerHTML.includes('#FBEEDA'));
  oscar.click();
  await tick();
  assert.ok(qsa('.ex-lg.solo')[0].textContent.includes('Oscar'));
  const maria = qsa('.ex-chip').find((c) => c.textContent.includes('El Aguila'));
  assert.ok(maria.getAttribute('style').includes('opacity:.3'), '다른 담당자는 흐려진다');
});

test('담당자별 목표·달성 표가 렌더된다', async () => {
  await openBoard();
  const t = $('ex-ownerBox').textContent;
  assert.ok(t.includes('Oscar') && t.includes('Maria'));
  assert.ok(t.includes('$850,000'));
});

// ── 미팅 상세 ───────────────────────────────────────────────────────
test('칩을 누르면 상세 시트가 열리고 목표·정성목표·간단내용이 채워진다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip').find((c) => c.textContent.includes('Grupo Zeta')).click();
  await tick();
  assert.ok(!$('ex-sheet').classList.contains('ex-hidden'));
  assert.equal($('ex-fCompany').value, 'Grupo Zeta <b>');
  assert.equal($('ex-fTq').value, '850000');
  assert.equal($('ex-fTo').value, '400000');
  assert.equal($('ex-fAq').value, '');
  assert.equal($('ex-fGoal').value, '연간 계약 의향 확인');
  assert.equal($('ex-fOwner').value, '2');
  assert.equal($('ex-fDay').value, '1');
  assert.equal($('ex-fHour').value, '9');
  assert.ok($('ex-shS').textContent.includes('1st day'));
  assert.ok($('ex-shS').textContent.includes('09:00–10:00'));
});

test('상세: 정성목표 AI 판단 결과와 근거·다음조치가 보인다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip').find((c) => c.textContent.includes('El Aguila')).click();
  await tick();
  const t = $('ex-qualBox').textContent;
  assert.ok(t.includes('부분 달성'));
  assert.ok(t.includes('합의 없음'));
  assert.ok(t.includes('근거1'));
  assert.ok(t.includes('재제안'));
  assert.ok($('ex-applyAmt'), '확인된 금액을 달성액으로 넣는 버튼');
});

test('상세 저장: 바뀐 값만 담아 PATCH 한다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip').find((c) => c.textContent.includes('Grupo Zeta')).click();
  await tick();
  $('ex-fAq').value = '900000';
  $('ex-fTo').value = '500000';
  $('ex-fMemo').value = '샘플 테스트 합의';
  route('PATCH', '/api/exhibitions/meetings/1', { ok: true, id: 1 });
  $('ex-saveBtn').click();
  await tick(40);
  const body = sent('PATCH', '/api/exhibitions/meetings/1');
  assert.equal(body.actual_quote, 900000);
  assert.equal(body.target_order, 500000);
  assert.equal(body.memo, '샘플 테스트 합의');
  assert.equal(body.day_no, 1);
  assert.equal(body.slot_hour, 9);
});

test('상세: 달성액을 비우면 null 로 보낸다(0 으로 덮어쓰지 않는다)', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip').find((c) => c.textContent.includes('El Aguila')).click();
  await tick();
  $('ex-fAq').value = '';
  route('PATCH', '/api/exhibitions/meetings/2', { ok: true, id: 2 });
  $('ex-saveBtn').click();
  await tick(40);
  assert.equal(sent('PATCH', '/api/exhibitions/meetings/2').actual_quote, null);
});

test('상세: [✅ 미팅 완료] 는 status 만 바꿔 PATCH 한다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip').find((c) => c.textContent.includes('Grupo Zeta')).click();
  await tick();
  route('PATCH', '/api/exhibitions/meetings/1', { ok: true, id: 1 });
  $('ex-doneBtn').click();
  await tick(40);
  assert.deepEqual(sent('PATCH', '/api/exhibitions/meetings/1'), { status: 'done' });
});

// ── 새 미팅 ─────────────────────────────────────────────────────────
test('빈 칸을 누르면 그 날짜·시간이 미리 채워진 등록 폼이 열린다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[2].click(); await tick();          // 3rd day
  const slot = qsa('.ex-slot')[2].querySelector('.b'); // 10:00
  slot.click();
  await tick();
  assert.ok($('ex-nCompany'), '등록 폼');
  assert.equal($('ex-nDay').value, '3');
  assert.equal($('ex-nHour').value, '10');
  assert.equal($('ex-nWalk').checked, false, '지금 시간이 아니면 계획 미팅');
  assert.ok($('ex-shT').textContent.includes('미팅 계획 추가'));
});

test('지금 시간 칸을 누르면 즉석 미팅으로 미리 체크된다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  const nowSlot = win.document.querySelector('.ex-slot.now .b');
  nowSlot.click();
  await tick();
  assert.equal($('ex-nWalk').checked, true);
  assert.ok($('ex-shT').textContent.includes('지금 미팅 기록'));
  assert.ok($('ex-nSave').textContent.includes('바로 녹음'));
});

test('미팅 계획 저장: 고객·담당자·목표·정성목표를 담아 POST 한다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-slot')[5].querySelector('.b').click();     // 13:00
  await tick();
  $('ex-nCompany').value = 'Frenos del Golfo';
  $('ex-nContact').value = 'Sr. Peña';
  $('ex-nOwner').value = '3';
  $('ex-nTq').value = '700000';
  $('ex-nTo').value = '500000';
  $('ex-nGoal').value = '신규 SKU 12종 등재 합의';
  route('POST', '/api/exhibitions/10/meetings', { id: 77 });
  route('GET', '/board', boardPayload());
  $('ex-nSave').click();
  await tick(50);
  const b = sent('POST', '/api/exhibitions/10/meetings');
  assert.equal(b.company_name, 'Frenos del Golfo');
  assert.equal(b.contact_name, 'Sr. Peña');
  assert.equal(b.owner_user_id, 3);
  assert.equal(b.day_no, 1);
  assert.equal(b.slot_hour, 13);
  assert.equal(b.target_quote, 700000);
  assert.equal(b.target_order, 500000);
  assert.equal(b.goal_note, '신규 SKU 12종 등재 합의');
  assert.equal(b.is_walkin, false);
  assert.equal(b.status, 'planned');
});

test('즉석 미팅 저장: is_walkin/status=done 으로 보내고 바로 녹음을 연다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  win.document.querySelector('.ex-slot.now .b').click();
  await tick();
  $('ex-nCompany').value = 'Llantas y Más';
  route('POST', '/api/exhibitions/10/meetings', { id: 78 });
  route('GET', '/board', boardPayload({ meetings: [M1, M2, M3, { ...M3, id: 78, company_name: 'Llantas y Más' }] }));
  route('POST', '/meetings/78/consult', { consult_id: 601, created: true });
  route('GET', '/api/consults/601/recordings', { items: [] });
  $('ex-nSave').click();
  await tick(60);
  const b = sent('POST', '/api/exhibitions/10/meetings');
  assert.equal(b.is_walkin, true);
  assert.equal(b.status, 'done');
  assert.ok(fetchLog.some((x) => x.method === 'POST' && x.url.includes('/meetings/78/consult')), '녹음용 상담 자동 생성');
});

test('업체명이 비면 저장하지 않는다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-slot')[1].querySelector('.b').click();
  await tick();
  $('ex-nSave').click();
  await tick(30);
  assert.equal(sent('POST', '/meetings'), null);
  assert.ok($('ex-toast').textContent.includes('업체명'));
});

// ── 녹음 연결 ───────────────────────────────────────────────────────
test('🎙 녹음: 상담을 만들고 기존 녹음 카드를 미팅 상세 안으로 가져온다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip').find((c) => c.textContent.includes('Grupo Zeta')).click();
  await tick();
  route('POST', '/meetings/1/consult', { consult_id: 600, created: true });
  route('GET', '/api/consults/600/recordings', { items: [] });
  $('ex-recBtn').click();
  await tick(50);
  assert.ok(fetchLog.some((x) => x.url.includes('/meetings/1/consult')));
  assert.equal($('cs-recCard').parentElement.id, 'ex-recSlot', '녹음 카드가 시트 안으로 이동');
  assert.ok(!$('cs-recCard').classList.contains('hidden'));
  assert.ok($('cs-recTarget').textContent.includes('Grupo Zeta'));
});

test('시트를 닫으면 녹음 카드가 원래 자리로 돌아간다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip').find((c) => c.textContent.includes('Grupo Zeta')).click();
  await tick();
  route('POST', '/meetings/1/consult', { consult_id: 600, created: true });
  route('GET', '/api/consults/600/recordings', { items: [] });
  $('ex-recBtn').click();
  await tick(50);
  $('ex-shX').click();
  await tick(20);
  assert.equal($('cs-recCard').parentElement.id, 'normalMode');
  assert.ok($('ex-sheet').classList.contains('ex-hidden'));
});

// ── 정성목표 판단 ───────────────────────────────────────────────────
test('🤖 정성목표 달성 판단: 요약이 있는 미팅에서만 버튼이 나오고 POST 한다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip').find((c) => c.textContent.includes('Grupo Zeta')).click();
  await tick();
  assert.equal($('ex-evalBtn'), null, '요약 없으면 버튼 없음');

  qsa('.ex-chip').find((c) => c.textContent.includes('El Aguila')).click();
  await tick();
  assert.ok($('ex-evalBtn'));
  route('POST', '/meetings/2/evaluate', { ok: true, id: 2, evaluation: { result: 'achieved' } });
  route('GET', '/board', boardPayload({ meetings: [M1, { ...M2, qual_result: 'achieved', qual_eval: '달성했습니다' }, M3] }));
  $('ex-evalBtn').click();
  await tick(60);
  assert.ok(fetchLog.some((x) => x.method === 'POST' && x.url.includes('/meetings/2/evaluate')));
  assert.ok($('ex-qualBox').textContent.includes('정성목표 달성'));
});

test('판단이 찾아낸 금액을 달성액 칸에 넣어준다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip').find((c) => c.textContent.includes('El Aguila')).click();
  await tick();
  $('ex-fAq').value = '';
  $('ex-applyAmt').click();
  assert.equal($('ex-fAq').value, '460000');
});

// ── 전시회 설정 ─────────────────────────────────────────────────────
test('⚙ 설정: 디렉터는 이름·날짜·시간대를 바꿔 PATCH 한다', async () => {
  await openBoard();
  $('ex-setBtn').click();
  await tick();
  assert.equal($('ex-sName').value, 'RUJAC 2026');
  assert.equal($('ex-sDays').value, '3');
  assert.equal($('ex-sSh').value, '8');
  assert.equal($('ex-sEh').value, '18');
  $('ex-sVenue').value = 'Expo Santa Fe';
  route('PATCH', '/api/exhibitions/10', { ok: true, id: 10 });
  route('GET', '/api/exhibitions', { items: [{ id: 10, name: 'RUJAC 2026', start_date: '2026-09-16', is_active: true }], active_id: 10 });
  route('GET', '/board', boardPayload());
  $('ex-sSave').click();
  await tick(50);
  const b = sent('PATCH', '/api/exhibitions/10');
  assert.equal(b.venue, 'Expo Santa Fe');
  assert.equal(b.day_count, 3);
  assert.equal(b.start_hour, 8);
  assert.equal(b.end_hour, 18);
});

test('⚙ 설정: 종료 시각이 시작보다 이르면 저장하지 않는다', async () => {
  await openBoard();
  $('ex-setBtn').click();
  await tick();
  $('ex-sSh').value = '12';
  $('ex-sEh').value = '13';
  $('ex-sEh').value = '13';
  $('ex-sSh').value = '12';
  // 정상 케이스는 통과해야 하므로 비정상만 확인
  $('ex-sSh').value = '12';
  $('ex-sEh').innerHTML += '<option value="10">10:00</option>';
  $('ex-sEh').value = '10';
  $('ex-sSave').click();
  await tick(30);
  assert.equal(sent('PATCH', '/api/exhibitions/10'), null);
  assert.ok($('ex-toast').textContent.includes('종료 시각'));
});

test('영업사원 계정: 전시회 설정은 안내만 나오고 폼이 없다', async () => {
  boot({ id: 2, name: 'Oscar', role: 'sales' });
  await openBoard();
  $('ex-setBtn').click();
  await tick();
  assert.equal($('ex-sName'), null);
  assert.ok($('ex-shB').textContent.includes('디렉터'));
});

// ── 약속 확정 · 부스 직접 방문 ───────────────────────────────────────
test('확정 안 된 약속은 점선 + 「확정대기」, 확정된 약속은 「확정 ✓」', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  const zeta = qsa('.ex-chip').find((c) => c.textContent.includes('Grupo Zeta'));
  assert.ok(zeta.classList.contains('wait'), '미확정 계획은 점선(wait)');
  assert.ok(zeta.textContent.includes('확정대기'));
  const aguila = qsa('.ex-chip').find((c) => c.textContent.includes('El Aguila'));
  assert.ok(aguila.textContent.includes('확정 ✓'));
  assert.ok(!aguila.classList.contains('wait'));
});

test('부스 직접 방문은 담당자 색이 아니라 공통 회색이고 담당자 이름이 붙는다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[2].click(); await tick();
  const booth = qsa('.ex-chip').find((c) => c.textContent.includes('Frenos del Golfo'));
  assert.ok(booth, '3일차에 부스 방문이 보여야 함');
  const style = booth.getAttribute('style');
  assert.ok(style.includes('#EDEBE4'), '공통 회색 배경');
  assert.ok(!style.includes('#FBEEDA'), 'Oscar 색을 쓰지 않는다');
  assert.ok(booth.textContent.includes('Oscar'), '담당자 이름은 표시한다');
  assert.ok(booth.textContent.includes('🚶'));
  assert.ok(!booth.textContent.includes('확정'), '부스 방문에 확정 개념은 없다');
});

test('범례에 부스 방문 칩이 따로 생기고 누르면 부스만 강조된다', async () => {
  await openBoard();
  win.eval("exSetView('grid')");
  const boothLg = qsa('.ex-lg').find((b) => b.textContent.includes('부스 방문'));
  assert.ok(boothLg);
  assert.ok(boothLg.innerHTML.includes('#EDEBE4'));
  boothLg.click();
  await tick();
  const booth = qsa('.ex-chip').find((c) => c.textContent.includes('Frenos del Golfo'));
  const zeta = qsa('.ex-chip').find((c) => c.textContent.includes('Grupo Zeta'));
  assert.ok(!booth.getAttribute('style').includes('opacity:.3'));
  assert.ok(zeta.getAttribute('style').includes('opacity:.3'), '약속 미팅은 흐려진다');
});

test('KPI 에 약속/부스 구분과 약속 확정 현황이 나온다', async () => {
  await openBoard();
  const t = $('ex-kpis').textContent;
  assert.ok(t.includes('약속 3'));
  assert.ok(t.includes('부스 1'));
  assert.ok(t.includes('1 / 3'), '확정 1 / 약속 3');
  assert.ok(t.includes('확정 대기 2'));
});

test('상세: [✓ 약속 확정] 을 누르면 is_confirmed 만 PATCH 한다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip').find((c) => c.textContent.includes('Grupo Zeta')).click();
  await tick();
  assert.equal($('ex-confBtn').textContent, '✓ 약속 확정');
  route('PATCH', '/api/exhibitions/meetings/1', { ok: true, id: 1 });
  $('ex-confBtn').click();
  await tick(40);
  assert.deepEqual(sent('PATCH', '/api/exhibitions/meetings/1'), { is_confirmed: true });
});

test('상세: 부스 방문에는 확정 버튼이 없다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[2].click(); await tick();
  qsa('.ex-chip').find((c) => c.textContent.includes('Frenos del Golfo')).click();
  await tick();
  assert.equal($('ex-confBtn'), null);
  assert.ok($('ex-shS').textContent.includes('부스 방문'));
  assert.equal($('ex-fKind').querySelector('button.on').dataset.k, 'booth');
});

test('새 미팅: 부스 방문을 고르면 kind=booth 로 보내고 확정·즉석 칸은 감춘다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-slot')[4].querySelector('.b').click();
  await tick();
  assert.ok($('ex-nKind'), '종류 선택이 있어야 함');
  assert.equal($('ex-nConfirm').closest('label').style.display, '');
  $('ex-nKind').querySelector('[data-k="booth"]').click();
  await tick();
  assert.equal($('ex-nConfirm').closest('label').style.display, 'none');
  assert.equal($('ex-nWalk').closest('label').style.display, 'none');
  $('ex-nCompany').value = 'Suspensión Total';
  route('POST', '/api/exhibitions/10/meetings', { id: 79 });
  $('ex-nSave').click();
  await tick(50);
  const b = sent('POST', '/api/exhibitions/10/meetings');
  assert.equal(b.kind, 'booth');
  assert.equal(b.is_confirmed, false);
  assert.equal(b.is_walkin, false);
  assert.equal(b.company_name, 'Suspensión Total');
});

test('새 미팅: 고객 약속에 「확정」을 체크하면 is_confirmed 로 보낸다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-slot')[4].querySelector('.b').click();
  await tick();
  $('ex-nKind').querySelector('[data-k="meeting"]').click();
  $('ex-nCompany').value = 'Autopartes del Norte';
  $('ex-nConfirm').checked = true;
  route('POST', '/api/exhibitions/10/meetings', { id: 80 });
  $('ex-nSave').click();
  await tick(50);
  const b = sent('POST', '/api/exhibitions/10/meetings');
  assert.equal(b.kind, 'meeting');
  assert.equal(b.is_confirmed, true);
});

// ── 스크롤 잠금 (화면이 멈춰버리던 버그) ────────────────────────────
test('시트를 열면 뒤 화면을 잠그고, 닫으면 반드시 푼다', async () => {
  await openBoard();
  const html = win.document.documentElement;
  assert.ok(!html.classList.contains('ex-locked'));
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip')[0].click(); await tick();
  assert.ok(html.classList.contains('ex-locked'), '열면 잠긴다');
  assert.ok(!$('ex-backdrop').classList.contains('ex-hidden'), '뒷막이 보인다');
  $('ex-shX').click(); await tick();
  assert.ok(!html.classList.contains('ex-locked'), '닫으면 풀린다');
  assert.ok($('ex-backdrop').classList.contains('ex-hidden'));
});

test('시트를 연 채 일반 고객상담으로 넘어가도 잠금이 풀린다(화면 멈춤 방지)', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip')[0].click(); await tick();
  assert.ok(win.document.documentElement.classList.contains('ex-locked'));
  $('modeNormal').click();
  await tick();
  assert.ok(!win.document.documentElement.classList.contains('ex-locked'), '모드를 바꿔도 반드시 풀린다');
  assert.equal(win.document.body.style.overflow, '');
  assert.ok($('ex-sheet').classList.contains('ex-hidden'));
});

test('뒷막을 누르면 시트가 닫힌다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip')[0].click(); await tick();
  $('ex-backdrop').click(); await tick();
  assert.ok($('ex-sheet').classList.contains('ex-hidden'));
  assert.ok(!win.document.documentElement.classList.contains('ex-locked'));
});

// ── 전시회 등록 폼에서도 고객 이름으로 찾기 ─────────────────────────
test('새 미팅: 고객 이름을 쳐서 찾고 하나만 남으면 업체명까지 채워진다', async () => {
  route('GET', '/api/visits/customer-options', { items: [
    { id: 101, name: 'Refaccionaria El Águila' },
    { id: 102, name: 'Autopartes del Norte' },
    { id: 103, name: 'Aguilar Refacciones' },
  ] });
  await openBoard();
  await win.csLoadCustOptions();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-slot')[4].querySelector('.b').click(); await tick();

  assert.ok($('ex-nCustQ'), '검색칸이 있어야 함');
  assert.equal($('ex-nCust').options.length, 4);

  $('ex-nCustQ').value = 'agui';
  $('ex-nCustQ').dispatchEvent(new win.Event('input'));
  assert.equal($('ex-nCust').options.length, 3, '안내 1 + 2건');

  $('ex-nCustQ').value = 'norte';
  $('ex-nCustQ').dispatchEvent(new win.Event('input'));
  assert.equal($('ex-nCust').value, '102');
  assert.equal($('ex-nCompany').value, 'Autopartes del Norte', '업체명이 자동으로 채워진다');

  route('POST', '/api/exhibitions/10/meetings', { id: 90 });
  $('ex-nSave').click();
  await tick(50);
  const b = sent('POST', '/api/exhibitions/10/meetings');
  assert.equal(b.customer_id, 102, '등록 고객으로 연결된다');
  assert.equal(b.company_name, 'Autopartes del Norte');
});

// ── 2026-09-10 · 21시까지 · 폰 저장 흐름 ─────────────────────────────
function board21(extra) {
  const b = boardPayload(extra);
  b.exhibition = { ...b.exhibition, end_hour: 21 };
  b.hours = Array.from({ length: 13 }, (_, i) => ({
    hour: 8 + i, label: String(8 + i).padStart(2, '0') + ':00',
    range: String(8 + i).padStart(2, '0') + ':00–' + String(9 + i).padStart(2, '0') + ':00',
  }));
  return b;
}
async function openMeeting(name) {
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-chip').find((c) => c.textContent.includes(name)).click();
  await tick();
}
const typeIn = (el, v) => { el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); };

test('21시: 08:00~21:00 보드면 하루씩 13칸 · 전체 13행 · 헤더 08:00–21:00', async () => {
  route('GET', '/api/exhibitions', { items: [{ id: 10, name: 'RUJAC 2026', start_date: '2026-09-16', is_active: true }], active_id: 10 });
  route('GET', '/board', board21());
  $('modeExpo').click(); await tick(40);
  assert.ok($('ex-meta').textContent.includes('08:00–21:00'));
  win.eval("exSetView('day')");
  assert.equal(qsa('.ex-slot').length, 13);
  assert.equal(qsa('.ex-slot .t b').pop().textContent, '20:00');
  win.eval("exSetView('grid')");
  assert.equal(qsa('table.ex-tt tbody tr').length, 13);
});

test('21시: 새 전시회 등록 폼의 종료 시각 기본값은 21:00, 23:00 까지 고를 수 있다', async () => {
  await openBoard();
  win.eval('exBoard = null; exOpenSettings();');
  await tick();
  assert.equal($('ex-sEh').value, '21');
  assert.ok([...$('ex-sEh').options].some((o) => o.value === '23'));
});

test('폰 저장: 시트는 모바일 셸(탭바 9001·헤더 9000)보다 위 z-index', () => {
  const css = [...win.document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  const z = Number((css.match(/\.ex-sheet\{position:fixed;inset:0;z-index:(\d+)/) || [])[1]);
  assert.ok(z > 9001, 'z-index ' + z);
  const zb = Number((css.match(/\.ex-backdrop\{[^}]*z-index:(\d+)/) || [])[1]);
  assert.ok(zb > 9001 && zb < z, '뒷막은 탭바보다 위, 시트보다 아래');
  assert.ok(!/html\.ex-locked body\{[^}]*touch-action:none/.test(css), 'html/body 에 touch-action:none 금지(iOS 시트 스크롤)');
});

test('폰 저장: 상세 하단은 [💾 저장] 이 주 버튼이고 확정·완료·삭제는 보조 줄', async () => {
  await openBoard();
  await openMeeting('Grupo Zeta');
  const pri = $('ex-shF').querySelector('.ex-pri');
  assert.equal(pri && pri.id, 'ex-saveBtn');
  const sec = $('ex-shF').querySelector('.ex-sfsec');
  assert.ok(sec.contains($('ex-confBtn')) && sec.contains($('ex-doneBtn')) && sec.contains($('ex-delBtn')));
});

test('폰 저장: 입력하면 저장 버튼이 「💾 변경 저장」 으로 바뀌고, 저장하면 「✓ 저장됨」', async () => {
  await openBoard();
  await openMeeting('Grupo Zeta');
  assert.ok(!$('ex-saveBtn').classList.contains('dirty'));
  typeIn($('ex-fMemo'), '샘플 요청');
  assert.ok($('ex-saveBtn').classList.contains('dirty'));
  assert.equal($('ex-saveBtn').textContent, '💾 변경 저장');
  route('PATCH', '/api/exhibitions/meetings/1', { ok: true, id: 1 });
  $('ex-saveBtn').click(); await tick(50);
  assert.equal(sent('PATCH', '/api/exhibitions/meetings/1').memo, '샘플 요청');
  assert.ok(!$('ex-sheet').classList.contains('ex-hidden'), '저장 후에도 상세가 열려 있다');
  assert.ok($('ex-saveBtn').textContent.includes('저장됨'));
  assert.equal(win.eval('exDirty'), false);
});

test('폰 저장: 입력 중에 [✓ 약속 확정] 을 누르면 입력값까지 함께 저장한다', async () => {
  await openBoard();
  await openMeeting('Grupo Zeta');
  typeIn($('ex-fGoal'), '보증 조건 합의');
  route('PATCH', '/api/exhibitions/meetings/1', { ok: true, id: 1 });
  $('ex-confBtn').click(); await tick(50);
  const b = sent('PATCH', '/api/exhibitions/meetings/1');
  assert.equal(b.is_confirmed, true);
  assert.equal(b.goal_note, '보증 조건 합의');
  assert.equal(b.company_name, 'Grupo Zeta <b>');
});

test('폰 저장: 입력 중에 [✅ 미팅 완료] 도 입력값을 버리지 않는다', async () => {
  await openBoard();
  await openMeeting('Grupo Zeta');
  typeIn($('ex-fMemo'), '재방문 약속');
  route('PATCH', '/api/exhibitions/meetings/1', { ok: true, id: 1 });
  $('ex-doneBtn').click(); await tick(50);
  const b = sent('PATCH', '/api/exhibitions/meetings/1');
  assert.equal(b.status, 'done');
  assert.equal(b.memo, '재방문 약속');
});

test('폰 저장: 저장 안 한 채 ✕ — 확인창에서 취소하면 그대로, 확인하면 닫힌다', async () => {
  await openBoard();
  await openMeeting('Grupo Zeta');
  typeIn($('ex-fMemo'), '미저장');
  let asked = 0;
  win.confirm = () => { asked++; return false; };
  $('ex-shX').click(); await tick();
  assert.equal(asked, 1);
  assert.ok(!$('ex-sheet').classList.contains('ex-hidden'), '취소하면 안 닫힌다');
  assert.equal($('ex-fMemo').value, '미저장');
  win.confirm = () => true;
  $('ex-backdrop').click(); await tick();
  assert.ok($('ex-sheet').classList.contains('ex-hidden'));
  assert.ok(!win.document.documentElement.classList.contains('ex-sheet-open'));
});

test('폰 저장: 변경이 없으면 ✕ 는 묻지 않고 닫는다', async () => {
  await openBoard();
  await openMeeting('Grupo Zeta');
  let asked = 0;
  win.confirm = () => { asked++; return true; };
  $('ex-shX').click(); await tick();
  assert.equal(asked, 0);
  assert.ok($('ex-sheet').classList.contains('ex-hidden'));
});

test('신규 확정: 확정 체크는 맨 위 「종류 · 확정」 칸에 있고, 저장 버튼 문구가 따라 바뀐다', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-slot')[5].querySelector('.b').click(); await tick();
  const kindSec = $('ex-nKind').closest('.ex-sec');
  assert.ok(kindSec.contains($('ex-nConfirm')) && kindSec.contains($('ex-nWalk')));
  assert.equal($('ex-nSave').textContent, '💾 미팅 계획 저장');
  $('ex-nConfirm').checked = true; $('ex-nConfirm').dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.equal($('ex-nSave').textContent, '✓ 확정 미팅으로 저장');
  $('ex-nKind').querySelector('[data-k="booth"]').click();
  assert.equal($('ex-nSave').textContent, '🚶 부스 방문 저장');
  $('ex-nKind').querySelector('[data-k="meeting"]').click();
  $('ex-nWalk').checked = true; $('ex-nWalk').dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.ok($('ex-nSave').textContent.includes('바로 녹음'));
});

test('신규 확정: 저장하면 그 미팅 상세로 넘어가고 「확정 미팅 저장됨」 표시', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  qsa('.ex-slot')[5].querySelector('.b').click(); await tick();
  $('ex-nCompany').value = 'Autopartes del Norte';
  $('ex-nConfirm').checked = true;
  route('POST', '/api/exhibitions/10/meetings', { id: 1 });   // 보드의 M1 로 넘어가는 것으로 대체
  $('ex-nSave').click(); await tick(60);
  assert.equal(sent('POST', '/api/exhibitions/10/meetings').is_confirmed, true);
  assert.ok($('ex-saveBtn'), '상세 시트로 전환');
  assert.ok($('ex-saveBtn').textContent.includes('확정 미팅 저장됨'));
  assert.ok($('ex-toast').textContent.includes('확정 미팅'));
});

test('정성목표 판단: 저장 안 한 정성목표가 있으면 먼저 저장하고 판단한다', async () => {
  await openBoard();
  await openMeeting('El Aguila');
  typeIn($('ex-fGoal'), '신뢰 회복 + 재주문');
  route('PATCH', '/api/exhibitions/meetings/2', { ok: true, id: 2 });
  route('POST', '/meetings/2/evaluate', { ok: true, id: 2, evaluation: { result: 'achieved' } });
  $('ex-evalBtn').click(); await tick(80);
  const iP = fetchLog.findIndex((x) => x.method === 'PATCH' && x.url.includes('/meetings/2'));
  const iE = fetchLog.findIndex((x) => x.method === 'POST' && x.url.includes('/meetings/2/evaluate'));
  assert.ok(iP >= 0 && iE > iP, '저장 → 판단 순서');
  assert.equal(JSON.parse(fetchLog[iP].body).goal_note, '신뢰 회복 + 재주문');
});

test('녹음 카드 안 조작은 「저장 안 한 변경」 으로 치지 않는다', async () => {
  await openBoard();
  await openMeeting('Grupo Zeta');
  const card = $('cs-recCard'); $('ex-recSlot').appendChild(card);
  const inp = win.document.createElement('input'); card.appendChild(inp);
  typeIn(inp, 'x');
  assert.equal(win.eval('exDirty'), false);
});

// ── 2026-09-10 · 완료 미팅을 진하게 ─────────────────────────────────
test('완료 미팅: 칩을 담당자 진한 색으로 채우고 흰 글자 + ✅ · 「완료」 배지', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  const ag = qsa('.ex-chip').find((c) => c.textContent.includes('El Aguila'));   // M2: done, Maria(#9A1F1F)
  const ze = qsa('.ex-chip').find((c) => c.textContent.includes('Grupo Zeta'));  // M1: planned
  assert.ok(ag.classList.contains('done'));
  assert.ok(!ze.classList.contains('done'));
  const st = ag.getAttribute('style').replace(/\s/g, '').toLowerCase();
  assert.ok(st.includes('background:#9a1f1f') && st.includes('color:#fff'), st);
  assert.ok(ag.querySelector('.ok') && ag.querySelector('.ok').textContent === '완료');
  assert.ok(ag.textContent.includes('✅'));
  assert.ok(ag.textContent.includes('460k/420k'), '완료 칩 금액은 달성/목표');
  assert.ok(ze.getAttribute('style').replace(/\s/g, '').toLowerCase().includes('background:#fbeeda'), '미완료는 연한 바탕 그대로');
});

test('완료 미팅: 그 칸의 미팅이 전부 끝났으면 슬롯 자체도 완료 표시(하루씩·전체 둘 다)', async () => {
  await openBoard();
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  const slots = qsa('.ex-slot');
  assert.ok(slots[3].classList.contains('done'), '11:00 — El Aguila 완료');
  assert.ok(!slots[1].classList.contains('done'), '09:00 — 계획 미팅');
  assert.ok(!slots[0].classList.contains('done'), '빈 칸은 표시 안 함');
  win.eval("exSetView('grid')");
  assert.equal(qsa('.ex-cell.done').length, 2, '1일차 11시 + 2일차 12시(즉석 완료)');
});

test('완료 미팅: 같은 칸에 아직 안 끝난 미팅이 섞여 있으면 칸은 표시하지 않는다(칩만)', async () => {
  const P = { ...M1, id: 9, day_no: 1, slot_hour: 11, company_name: 'Pendiente', status: 'planned' };
  await openBoard({ meetings: [M1, M2, P] });
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  assert.ok(!qsa('.ex-slot')[3].classList.contains('done'));
  assert.equal(qsa('.ex-slot')[3].querySelectorAll('.ex-chip.done').length, 1);
});

test('완료 미팅: 취소 건은 완료 판정에서 빼고, 날짜 탭·KPI 에 완료 수가 나온다', async () => {
  const C = { ...M1, id: 8, day_no: 1, slot_hour: 11, company_name: 'Cancelado', status: 'cancelled' };
  await openBoard({ meetings: [M1, M2, M3, M4, C] });
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  assert.ok(qsa('.ex-slot')[3].classList.contains('done'), '취소 + 완료 → 완료 칸');
  assert.ok(qsa('.ex-daytab')[0].textContent.includes('✅ 1'));
  assert.ok($('ex-kpis').textContent.includes('✅ 완료 2'));
});

test('완료 미팅: 달성액 입력 전이면 「목표」 로 표기(달성으로 오해 안 하게)', async () => {
  const D = { ...M1, id: 11, status: 'done', actual_quote: null, actual_order: null };
  await openBoard({ meetings: [D] });
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
  const c = qsa('.ex-chip')[0];
  assert.ok(c.classList.contains('done'));
  assert.ok(c.querySelector('.am').textContent.startsWith('목표 견적 850k'));
});

// ── 2026-09-10 · 📋 미팅 기록 상시보기 ─────────────────────────────
const SUMA = { resumen: 'Cliente pide 10 muestras de amortiguadores.', insights: 'Precio sensible',
  bullets: [{ category: 'producto', text: 'Amortiguadores Tsuru' }],
  action_items: [{ category: 'logistica', content: 'Enviar muestras', due_date: '2026-09-20' }], next_step: 'Cotizar' };
const SUMB = { resumen: 'Nota de voz: confirmar precio.' };
function mLog(extra) { return { ...M2, id: 2, memo: '샘플 10종 요청', recs: [
  { id: 900, mode: 'full', duration_sec: 1122, summary: SUMA },
  { id: 905, mode: 'memo', duration_sec: 60, summary: SUMB }], rec_pending: 0, summary: SUMB, rec_id: 905, ...extra }; }
async function openDay1(meetings) {
  await openBoard({ meetings });
  win.eval("exSetView('day')");
  qsa('.ex-daytab')[0].click(); await tick();
}

test('상시보기: 완료+요약 미팅은 칩에 최근 요약 한두 줄이 늘 보인다(누르지 않아도)', async () => {
  await openDay1([M1, mLog()]);
  const c = qsa('.ex-chip').find((x) => x.textContent.includes('El Aguila'));
  const sn = c.querySelector('.sn');
  assert.ok(sn, '요약 줄');
  assert.ok(sn.textContent.includes('Nota de voz'), '가장 최근 녹음 요약');
  assert.ok(!qsa('.ex-chip').find((x) => x.textContent.includes('Grupo Zeta')).querySelector('.sn'), '기록 없는 계획 미팅은 없음');
});

test('상시보기: 상세를 열면 맨 위 「📋 미팅 기록」 에 메모 + 요약 전부(최근이 위)가 바로 펼쳐져 있다', async () => {
  await openDay1([M1, mLog()]);
  win.eval('exOpenMeeting(2)'); await tick();
  const first = $('ex-shB').firstElementChild;
  assert.equal(first.id, 'ex-logWrap', '시트 맨 위');
  const log = first.querySelector('.ex-sec.log');
  assert.ok(log, '기록 칸');
  const t = log.textContent;
  assert.ok(t.includes('샘플 10종 요청'), '현장 메모');
  assert.ok(t.includes('Cliente pide 10 muestras') && t.includes('Amortiguadores Tsuru') && t.includes('Enviar muestras'), '요약·핵심·펜딩');
  assert.ok(t.includes('요약 2건'));
  const sums = log.querySelectorAll('.ex-rsum');
  assert.equal(sums.length, 2);
  assert.ok(sums[0].textContent.includes('Nota de voz'), '최근 녹음이 위');
  assert.ok(sums[1].textContent.includes('18:42'), '녹음 길이');
  assert.equal(fetchLog.filter((x) => x.url.includes('/recordings')).length, 0, '🎙 를 누르지 않아도(추가 요청 없음)');
  assert.ok($('ex-recBtn').textContent.includes('추가 녹음'));
});

test('상시보기: 녹음 없이 완료+메모만 있어도 칩과 기록 칸에 메모가 보인다', async () => {
  await openDay1([{ ...M2, recs: [], summary: null, has_ai: false, memo: '재방문 약속, 카탈로그 전달' }]);
  const c = qsa('.ex-chip').find((x) => x.textContent.includes('El Aguila'));
  assert.ok(c.querySelector('.sn').textContent.includes('📝 재방문 약속'));
  win.eval('exOpenMeeting(2)'); await tick();
  assert.ok($('ex-logWrap').textContent.includes('재방문 약속'));
});

test('상시보기: 계획 단계 메모(사전 메모)만 있으면 칩·기록 칸을 띄우지 않는다', async () => {
  await openDay1([{ ...M1, memo: '가격표 챙기기' }]);
  assert.ok(!qsa('.ex-chip')[0].querySelector('.sn'));
  win.eval('exOpenMeeting(1)'); await tick();
  assert.equal($('ex-logWrap').innerHTML, '');
});

test('상시보기: 요약 대기 중이면 「⏳ AI 요약 중」 표시 + 20초 뒤 조용히 다시 읽기 예약', async () => {
  await openDay1([M1, { ...M2, recs: [], summary: null, has_ai: false, memo: null, rec_pending: 1 }]);
  const c = qsa('.ex-chip').find((x) => x.textContent.includes('El Aguila'));
  assert.ok(c.querySelector('.sn.wait').textContent.includes('AI 요약 중'));
  assert.ok(win.eval('exPollH !== null'), '재조회 예약');
  win.eval('exOpenMeeting(2)'); await tick();
  assert.ok($('ex-logWrap').textContent.includes('요약 중'));
});

test('상시보기: 대기 중인 녹음이 없으면 재조회를 예약하지 않는다', async () => {
  await openDay1([M1, mLog()]);
  assert.ok(win.eval('exPollH === null'));
});

test('상시보기: 조용한 재조회는 보던 날짜를 유지하고, 기록 칸만 갈아 끼운다(입력 중 값 보존)', async () => {
  await openDay1([M1, { ...M2, recs: [], summary: null, has_ai: false, memo: null, rec_pending: 1 }]);
  qsa('.ex-daytab')[2].click(); await tick();
  win.eval('exOpenMeeting(2)'); await tick();
  typeIn($('ex-fGoal'), '입력 중');
  route('GET', '/board', boardPayload({ meetings: [M1, mLog({ memo: null })] }));
  await win.eval('exLoadBoard(10, true)'); await tick(30);
  assert.equal(win.eval('exDay'), 3, '날짜 탭 유지(오늘로 튀지 않음)');
  assert.ok($('ex-logWrap').textContent.includes('Cliente pide'), '요약이 새로고침 없이 붙음');
  assert.equal($('ex-fGoal').value, '입력 중');
  assert.equal(win.eval('exDirty'), true);
});

test('상시보기: 🔒 감춘 상담이면 칩·기록 칸에 아무것도 내보이지 않는다', async () => {
  await openDay1([{ ...mLog(), consult_hidden: true }]);
  assert.ok(!qsa('.ex-chip')[0].querySelector('.sn'));
  win.eval('exOpenMeeting(2)'); await tick();
  assert.equal($('ex-logWrap').innerHTML, '');
});

test('상시보기: 🇰🇷 요약 한국어 — 번역본 없는 요약만 요청하고 칩·기록 칸이 한국어로', async () => {
  const withKo = { ...SUMA, ko: { resumen: '고객이 쇼바 샘플 10개 요청' } };
  await openDay1([M1, mLog({ recs: [{ id: 900, summary: withKo }, { id: 905, summary: SUMB }] })]);
  route('POST', '/recordings/905/translate', { ko: { resumen: '음성 메모: 가격 확인' } });
  $('ex-koBtn').click(); await tick(60);
  const tr = fetchLog.filter((x) => x.method === 'POST' && x.url.includes('/translate'));
  assert.equal(tr.length, 1, '이미 번역된 900 은 다시 요청하지 않는다');
  assert.ok(tr[0].url.includes('/recordings/905/translate'));
  const c = qsa('.ex-chip').find((x) => x.textContent.includes('El Aguila'));
  assert.ok(c.querySelector('.sn').textContent.includes('음성 메모: 가격 확인'));
  win.eval('exOpenMeeting(2)'); await tick();
  assert.ok($('ex-logWrap').textContent.includes('고객이 쇼바 샘플 10개 요청'));
  assert.ok($('ex-koBtn').textContent.includes('원문'));
  $('ex-logKo').click(); await tick(20);
  assert.ok($('ex-logWrap').textContent.includes('Cliente pide'), '원문으로 되돌리기');
});

test('녹음 카드 보호: 녹음 카드를 연 채 저장해도 카드가 사라지지 않고 시트 안에 다시 붙는다', async () => {
  await openDay1([M1, M2]);
  win.eval('exOpenMeeting(1)'); await tick();
  route('POST', '/meetings/1/consult', { consult_id: 600, created: true });
  route('GET', '/api/consults/600/recordings', { items: [] });
  $('ex-recBtn').click(); await tick(50);
  const card = $('cs-recCard');
  assert.equal(card.parentElement.id, 'ex-recSlot');
  typeIn($('ex-fMemo'), '녹음 중 메모');
  route('PATCH', '/api/exhibitions/meetings/1', { ok: true, id: 1 });
  $('ex-saveBtn').click(); await tick(60);
  assert.ok(win.document.contains(card), '카드가 문서에서 떨어져 나가지 않음');
  assert.equal($('cs-recCard').parentElement.id, 'ex-recSlot', '새로 그린 시트 안에 다시 붙음');
});

test('녹음 카드 보호: 녹음 중에는 다른 미팅·새 미팅으로 넘어가지 않는다', async () => {
  await openDay1([M1, M2]);
  win.eval('exOpenMeeting(1)'); await tick();
  route('POST', '/meetings/1/consult', { consult_id: 600, created: true });
  route('GET', '/api/consults/600/recordings', { items: [] });
  $('ex-recBtn').click(); await tick(50);
  win.eval('csRecActive = true');
  win.eval('exOpenMeeting(2)'); await tick();
  assert.ok($('ex-toast').textContent.includes('녹음 중'));
  assert.equal(win.eval('exSel'), 1);
  win.eval('exOpenNew(1, 15)'); await tick();
  assert.ok(!$('ex-nCompany'), '새 미팅 폼으로 안 넘어감');
  assert.equal($('cs-recCard').parentElement.id, 'ex-recSlot');
  win.eval('csRecActive = false');
});
