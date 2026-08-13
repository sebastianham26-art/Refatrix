// =====================================================================
// refatrix-pipeline.html 방문 상담 녹음·브리핑 프런트 (jsdom, 2026-08-03)
//   실제 HTML 전체를 로드하고 fetch/MediaRecorder/geolocation 을 스텁해
//   녹음 → 업로드 → 요약 렌더 → 브리핑 UI 흐름을 검증.
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-pipeline.html', import.meta.url), 'utf8');

let dom, win, fetchLog, fetchRoutes;
function route(method, urlPart, payload, status = 200) { fetchRoutes.push({ method, urlPart, payload, status }); }

beforeEach(() => {
  fetchLog = []; fetchRoutes = [];
  dom = new JSDOM(html, {
    url: 'https://example.test/refatrix-pipeline.html',
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
      w.navigator.geolocation = { getCurrentPosition: (ok) => ok({ coords: { latitude: 25.6, longitude: -100.3, accuracy: 10 } }) };
      class FakeRecorder {
        constructor(stream, opts) { this.stream = stream; this.opts = opts; this.state = 'inactive'; w.__lastRec = this; }
        static isTypeSupported(t) { return t.startsWith('audio/webm'); }
        start() { this.state = 'recording'; }
        pause() { this.state = 'paused'; }
        resume() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
      }
      w.MediaRecorder = FakeRecorder;
      w.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
    },
  });
  win = dom.window;
  // 페이지 최상위 let session 바인딩에 대입(전역 eval — window 프로퍼티 대입은 let 을 못 덮음)
  win.eval(`session = { token: 'tok', user: { id: 2, name: 'Oscar', role: 'sales' }, api: '' };`);
});

const $ = (id) => win.document.getElementById(id);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('초기 상태: 녹음 카드는 숨김, 브리핑 카드는 표시(디렉터 영역만 숨김)', () => {
  assert.ok($('vl-recCard').classList.contains('hidden'));
  assert.ok($('vl-brDir').classList.contains('hidden'));
  assert.ok(!$('vl-brPreview').classList.contains('hidden'));
});

test('vlShowRec: 카드 표시 + 대상 라벨 + 녹음 목록 로드(빈 목록 힌트)', async () => {
  route('GET', '/api/visits/100/recordings', { items: [] });
  win.vlShowRec(100, 'Refaccionaria Aguila');
  await tick();
  assert.ok(!$('vl-recCard').classList.contains('hidden'));
  assert.ok($('vl-recTarget').textContent.includes('Refaccionaria Aguila'));
  assert.ok($('vl-recList').innerHTML.includes('아직 녹음이 없습니다'));
});

test('녹음 → 종료 → 업로드: POST 본문(mode/data_url) 확인 + 처리중 안내', async () => {
  route('GET', '/api/visits/100/recordings', { items: [] });
  route('POST', '/api/visits/100/recordings', { id: 9, status: 'queued', stt_ready: true, ai_ready: true });
  win.vlShowRec(100, 'Aguila');
  await tick();
  // 모드 전환(상담 전체)
  $('vl-recModeFull').click();
  await win.vlRecStart();
  assert.equal(win.__lastRec.state, 'recording');
  assert.ok($('vl-recStart').classList.contains('hidden') && !$('vl-recStop').classList.contains('hidden'));
  // 데이터 조각 + 종료
  win.__lastRec.ondataavailable({ data: new win.Blob(['aaa'], { type: 'audio/webm' }) });
  win.vlRecStop();
  await tick();
  assert.ok(!$('vl-recReady').classList.contains('hidden'), '종료 후 업로드 패널 표시');
  await win.vlRecUpload();
  await tick(30);
  const post = fetchLog.find((f) => f.method === 'POST' && f.url.includes('/api/visits/100/recordings'));
  assert.ok(post, '업로드 POST 발생');
  const body = JSON.parse(post.body);
  assert.equal(body.mode, 'full');
  assert.ok(String(body.data_url).startsWith('data:audio/webm'));
  assert.ok($('vl-recMsg').textContent.includes('처리 중'));
});

test('vlLoadRecs: 완료 요약 렌더(XSS 이스케이프) · 실패 건 재시도 버튼', async () => {
  route('GET', '/api/visits/100/recordings', {
    items: [
      { id: 2, mode: 'memo', status: 'done', duration_sec: 65, transcript: 'texto',
        summary: { resumen: 'Habló de <script>alert(1)</script> balatas', insights: 'in', products: ['CL0001'],
          action_items: [{ content: 'Enviar cotización', due_date: '2026-08-05' }], next_step: 'lunes' } },
      { id: 1, mode: 'full', status: 'failed', error: 'stt: timeout' },
    ],
  });
  route('POST', '/api/visits/recordings/1/retry', { ok: true });
  win.vlShowRec(100, 'Aguila');
  await tick(30);
  const htmlOut = $('vl-recList').innerHTML;
  assert.ok(htmlOut.includes('✅ 완료') && htmlOut.includes('❌ 실패'));
  assert.ok(htmlOut.includes('&lt;script&gt;'), 'XSS 이스케이프');
  assert.ok(!$('vl-recList').querySelector('script'), '실제 script 태그 없음');
  assert.ok(htmlOut.includes('Enviar cotización') && htmlOut.includes('2026-08-05'));
  assert.ok(htmlOut.includes('CL0001') && htmlOut.includes('stt: timeout'));
  const retry = $('vl-recList').querySelector('.vl-recRetry');
  assert.ok(retry, '재시도 버튼');
  retry.click();
  await tick(30);
  assert.ok(fetchLog.some((f) => f.method === 'POST' && f.url.includes('/recordings/1/retry')));
});

test('브리핑 미리보기: 텍스트 렌더 + 번호 미설정 경고', async () => {
  route('GET', '/api/visits/briefing/preview', {
    text: '*📋 Buenos días, Oscar*\n...', wa_phone_set: false, wa_enabled: true, hour: 7,
  });
  await win.vlBrPreview();
  await tick();
  assert.ok(!$('vl-brText').classList.contains('hidden'));
  assert.ok($('vl-brText').textContent.includes('Buenos días'));
  assert.ok($('vl-brSelfHint').textContent.includes('미설정'));
});

test('디렉터: 발송 현황 로드 + 사원 선택 발송 POST(user_id)', async () => {
  win.eval(`session.user = { id: 1, name: 'director', role: 'director' };`);
  route('GET', '/api/visits/briefing/status', {
    enabled: true, hour: 7, stt_ready: true,
    recipients: [{ id: 2, name: 'Oscar', wa_masked: '521****5678' }],
    sends: [{ user_id: 2, name: 'Oscar', brief_date: '2026-08-02', status: 'sent_text', attempts: 1 }],
  });
  route('POST', '/api/visits/briefing/send', { date: '2026-08-03', results: [{ user_id: 2, ok: true, mode: 'text' }] });
  await win.vlBrLoadDir();
  await tick();
  assert.ok(!$('vl-brDir').classList.contains('hidden'));
  assert.ok($('vl-brStatus').textContent.includes('자동 발송 사용 중'));
  assert.ok($('vl-brUser').innerHTML.includes('Oscar'));
  assert.ok($('vl-brSends').innerHTML.includes('sent_text'));
  $('vl-brUser').value = '2';
  await win.vlBrSend();
  await tick();
  const post = fetchLog.find((f) => f.method === 'POST' && f.url.includes('/briefing/send'));
  assert.ok(post && JSON.parse(post.body).user_id === 2);
  assert.ok($('vl-brMsg').textContent.includes('✔ 발송됨'));
});

test('방문 목록: 녹음 뱃지 + 본인 방문에 🎙 버튼 → vlShowRec 연결', async () => {
  route('GET', '/api/visits/dates', { mx_today: '2026-08-03', items: [{ d: '2026-08-03', cnt: 1 }] });
  route('GET', '/api/visits?dates=', {
    items: [{ id: 100, visit_date: '2026-08-03', visited_at: '2026-08-03T10:00:00Z', customer_id: 10,
      place_name: 'Aguila', geo_lat: 25.6, geo_lng: -100.3, created_by: 2, by_name: 'Oscar',
      photo_cnt: 0, pendings: [], rec_cnt: 1, last_rec_status: 'done' }],
  });
  route('GET', '/api/visits/100/recordings', { items: [] });
  await win.vlLoadDates();
  await tick(30);
  const list = $('vl-list').innerHTML;
  assert.ok(list.includes('🎙 1 ✅'), '녹음 뱃지+상태');
  const btn = $('vl-list').querySelector('.vl-rec');
  assert.ok(btn, '본인 방문 🎙 버튼');
  btn.click();
  await tick();
  assert.ok(!$('vl-recCard').classList.contains('hidden'));
  assert.ok($('vl-recTarget').textContent.includes('Aguila'));
});

test('타인 방문(영업사원 시점): 🎙 버튼 없음', async () => {
  route('GET', '/api/visits/dates', { mx_today: '2026-08-03', items: [{ d: '2026-08-03', cnt: 1 }] });
  route('GET', '/api/visits?dates=', {
    items: [{ id: 101, visit_date: '2026-08-03', visited_at: '2026-08-03T10:00:00Z', customer_id: 10,
      place_name: 'Otro', geo_lat: 25.6, geo_lng: -100.3, created_by: 3, by_name: 'Maria',
      photo_cnt: 0, pendings: [], rec_cnt: 0, last_rec_status: null }],
  });
  await win.vlLoadDates();
  await tick(30);
  assert.ok(!$('vl-list').querySelector('.vl-rec'));
});

// ── 방문 리뷰 탭 ──────────────────────────────────────────────────────
function seedReviewRoutes() {
  route('GET', '/api/pipeline/salespeople', { items: [{ id: 2, name: 'Oscar' }] });
  route('GET', '/api/visits/review', {
    mx_today: '2026-08-04', from: '2026-07-29', to: '2026-08-04',
    days: [{ date: '2026-08-04', visits: [
      { id: 100, name: 'Refaccionaria Aguila', is_customer: true, by_name: 'Oscar', met_person: 'Sr. Juan',
        headline: 'Habló de balatas y precios.', has_ai: true, rec_status: 'done',
        plan: '사전 계획 텍스트', insight: 'Cliente compra a competidor X.',
        summary: { resumen: 'Habló de balatas y precios.', insights: 'Cliente compra a competidor X.',
          products: ['CL0001'], next_step: 'Visitar lunes',
          action_items: [{ content: 'Enviar cotización', due_date: '2026-08-05' }] },
        pend_total: 2, pend_done: 1, pend_overdue: 1, pend_head: 'Enviar cotización', fup: 'overdue',
        pendings: [
          { id: 11, content: 'Enviar cotización', due_date: '2026-08-05', done: false, overdue: 3 },
          { id: 12, content: 'Hecho ya', due_date: null, done: true, overdue: 0 },
        ] },
      { id: 101, name: 'Nueva Tienda', is_customer: false, by_name: 'Oscar', met_person: null,
        headline: null, has_ai: false, rec_status: null, plan: null, insight: null, summary: null,
        pend_total: 0, pend_done: 0, pend_overdue: 0, pend_head: null, fup: 'none', pendings: [] },
    ] }],
  });
  route('PATCH', '/api/visits/pendings/11', { ok: true, done: true });
}

test('방문 리뷰: 탭 전환 → 표 렌더(날짜 그룹·함축·F/UP 배지)', async () => {
  seedReviewRoutes();
  win.document.getElementById('vt-review').click();
  await tick(40);
  assert.ok(!$('viewReview').classList.contains('hidden'), '리뷰 뷰 표시');
  assert.ok($('viewVisit').classList.contains('hidden') && $('viewPipe').classList.contains('hidden'));
  const t = $('rv-table').innerHTML;
  assert.ok(t.includes('8/4') && t.includes('방문 2건'), '날짜 그룹 헤더');
  assert.ok(t.includes('Refaccionaria Aguila') && t.includes('Nueva Tienda'));
  assert.ok(t.includes('Habló de balatas'), '미팅 함축');
  assert.ok(t.includes('연체 1'), '펜딩 함축');
  assert.ok(t.includes('⚠ 연체') && t.includes('— 펜딩 없음'), 'F/UP 배지');
  assert.ok($('rv-count').textContent.includes('방문 2건'));
});

test('방문 리뷰 드릴다운: 상세(AI 요약·펜딩 체크리스트) + 펜딩 토글 PATCH', async () => {
  seedReviewRoutes();
  win.document.getElementById('vt-review').click();
  await tick(40);
  const row = $('rv-table').querySelector('.rv-row[data-id="100"]');
  row.click();
  const det = $('rv-det-100').innerHTML;
  assert.ok(det.includes('사전 계획') && det.includes('사전 계획 텍스트'));
  assert.ok(det.includes('미팅 요약(AI)') && det.includes('balatas'));
  assert.ok(det.includes('competidor X') && det.includes('CL0001') && det.includes('Visitar lunes'));
  assert.ok(det.includes('F/UP 1/2') && det.includes('⚠ 3일 초과'));
  // 펜딩 체크 → PATCH
  const cb = $('rv-det-100').querySelector('input[type=checkbox]:not(:checked)');
  cb.checked = true; cb.dispatchEvent(new win.Event('change'));
  await tick(40);
  const patch = fetchLog.find((f) => f.method === 'PATCH' && f.url.includes('/api/visits/pendings/11'));
  assert.ok(patch && JSON.parse(patch.body).done === true);
  // 다시 클릭하면 닫힘
  const row2 = $('rv-table').querySelector('.rv-row[data-id="101"]');
  row2.click();
  assert.ok($('rv-det-101').innerHTML.includes('녹음 AI 요약이 없습니다'), '녹음 없음 안내');
  row2.click();
  assert.ok(win.document.querySelector('.rv-detail[data-for="101"]').classList.contains('hidden'), '토글 닫힘');
});

// ── 녹음 유지(화면꺼짐/앱전환 대응 · b20260813rec1) ──────────────────
test('중단 자동 이어녹음: 예기치 못한 stop → 새 구간 재개 → 종료 → data_urls 2개 업로드', async () => {
  route('GET', '/api/visits/100/recordings', { items: [] });
  route('POST', '/api/visits/100/recordings', { id: 9, status: 'queued', stt_ready: true, ai_ready: true });
  win.vlShowRec(100, 'Aguila');
  await tick();
  await win.vlRecStart();
  const rec1 = win.__lastRec;
  rec1.ondataavailable({ data: new win.Blob(['seg1'], { type: 'audio/webm' }) });
  // 예기치 못한 중단(절전·앱 전환) — 사용자가 종료를 누르지 않았는데 recorder 가 멈춤
  rec1.stop();
  await tick(40);
  const rec2 = win.__lastRec;
  assert.notEqual(rec2, rec1, '새 레코더로 자동 재개');
  assert.equal(rec2.state, 'recording');
  assert.ok($('vl-recMsg').textContent.includes('이어서'), '이어녹음 안내 표시');
  assert.ok(!$('vl-recStop').classList.contains('hidden'), '종료 전이므로 녹음 UI 유지');
  rec2.ondataavailable({ data: new win.Blob(['seg2'], { type: 'audio/webm' }) });
  win.vlRecStop();
  await tick();
  assert.ok(!$('vl-recReady').classList.contains('hidden'), '업로드 패널');
  assert.ok($('vl-recInfo').textContent.includes('구간 2개'), '구간 수 안내');
  await win.vlRecUpload();
  await tick(40);
  const post = fetchLog.find((f) => f.method === 'POST' && f.url.includes('/api/visits/100/recordings'));
  assert.ok(post, '업로드 POST');
  const body = JSON.parse(post.body);
  assert.ok(Array.isArray(body.data_urls) && body.data_urls.length === 2, '구간 2개가 data_urls 로 전송');
  assert.ok(body.data_urls.every((u) => String(u).startsWith('data:audio/webm')));
  assert.equal(body.data_url, undefined, '다중 구간이면 data_url 미사용');
});

test('Wake Lock: 녹음 시작 시 화면꺼짐 방지 획득 · 종료 시 해제', async () => {
  let acquired = 0, released = 0;
  const sentinel = { release() { released++; if (this._f) this._f(); }, addEventListener(ev, fn) { if (ev === 'release') this._f = fn; } };
  win.navigator.wakeLock = { request: async () => { acquired++; return sentinel; } };
  route('GET', '/api/visits/100/recordings', { items: [] });
  win.vlShowRec(100, 'Aguila');
  await tick();
  await win.vlRecStart();
  await tick();
  assert.equal(acquired, 1, '시작 시 wake lock 요청');
  win.__lastRec.ondataavailable({ data: new win.Blob(['a'], { type: 'audio/webm' }) });
  win.vlRecStop();
  await tick();
  assert.ok(released >= 1, '종료 시 해제');
  assert.equal(acquired, 1, '종료 후 재획득 없음');
});

test('재개 실패(마이크 재획득 불가): 지금까지 구간 보존 + 업로드 패널 전환', async () => {
  route('GET', '/api/visits/100/recordings', { items: [] });
  win.vlShowRec(100, 'Aguila');
  await tick();
  await win.vlRecStart();
  const rec1 = win.__lastRec;
  rec1.ondataavailable({ data: new win.Blob(['seg1'], { type: 'audio/webm' }) });
  win.navigator.mediaDevices.getUserMedia = async () => { throw new Error('denied'); };
  rec1.stop();                                   // 사용자 종료 아님 → 자동 재개 시도 → 실패
  await tick(40);
  assert.ok(!$('vl-recReady').classList.contains('hidden'), '보존 구간 업로드 패널 표시');
  assert.ok($('vl-recMsg').textContent.includes('보존'), '보존 안내 문구');
  assert.ok($('vl-recStop').classList.contains('hidden'), '녹음 UI 는 종료 상태');
});

test('단일 구간(중단 없음): 기존 방식 그대로 data_url 단일 필드 업로드', async () => {
  route('GET', '/api/visits/100/recordings', { items: [] });
  route('POST', '/api/visits/100/recordings', { id: 9, status: 'queued', stt_ready: true, ai_ready: true });
  win.vlShowRec(100, 'Aguila');
  await tick();
  await win.vlRecStart();
  win.__lastRec.ondataavailable({ data: new win.Blob(['aaa'], { type: 'audio/webm' }) });
  win.vlRecStop();
  await tick();
  await win.vlRecUpload();
  await tick(40);
  const post = fetchLog.find((f) => f.method === 'POST' && f.url.includes('/api/visits/100/recordings'));
  const body = JSON.parse(post.body);
  assert.ok(String(body.data_url).startsWith('data:audio/webm'), '단일 구간은 data_url');
  assert.equal(body.data_urls, undefined);
});
