// =====================================================================
// refatrix-consult.html 「고객상담」 프런트 (jsdom, 2026-08-19)
//   실제 HTML 전체를 로드하고 fetch/MediaRecorder/geolocation 을 스텁해
//   상담 저장 → 녹음 → 요약 렌더 → 한국어 토글 → 표 정렬·선택 → 인사이트를 검증.
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-consult.html', import.meta.url), 'utf8');

let dom, win, fetchLog, fetchRoutes;
function route(method, urlPart, payload, status = 200) { fetchRoutes.push({ method, urlPart, payload, status }); }
function routeThrow(method, urlPart) { fetchRoutes.push({ method, urlPart, throwErr: true, payload: {}, status: 0 }); }

const SUMMARY = {
  resumen: 'Se habló de precios de balatas.',
  bullets: [{ category: 'precio', text: 'Pide 8% de descuento' }, { category: 'producto', text: 'Sin stock CL0002' }],
  insights: 'SYD ofrece 10% menos.',
  action_items: [{ content: 'Enviar cotización', category: 'precio', due_date: '2026-08-21' }],
  products: ['CL0001'],
  next_step: 'Visitar el lunes',
};
const KO = {
  resumen: '브레이크 패드 가격을 이야기했다.',
  bullets: [{ category: 'precio', text: '8% 할인 요청' }, { category: 'producto', text: 'CL0002 재고 없음' }],
  insights: '경쟁사 SYD가 10% 싸다.',
  action_items: [{ content: '견적 발송', category: 'precio', due_date: '2026-08-21' }],
  products: ['CL0001'],
  next_step: '월요일 방문',
};
const LIST = {
  mx_today: '2026-08-19', from: '2026-07-21', to: '2026-08-19', is_director: true, me: 1,
  categories: [{ key: 'precio', ko: '가격·견적' }, { key: 'producto', ko: '제품·재고' },
    { key: 'competencia', ko: '경쟁사' }, { key: 'logistica', ko: '물류·납품' },
    { key: 'pago', ko: '결제·여신' }, { key: 'calidad', ko: '품질·클레임' }, { key: 'relacion', ko: '관계·기타' }],
  items: [
    {
      id: 10, consult_date: '2026-08-18', company_name: 'Zeta Refacciones', contact_name: 'Juan',
      wa_phone: '81-1234-5678', email: 'juan@zeta.mx', place_label: 'Monterrey',
      geo_lat: 25.6, geo_lng: -100.3, geo_accuracy: 12, note: null,
      created_by: 2, by_name: 'Oscar', by_login: 'oscar', is_private: false, private_by: null,
      rec_id: 110, rec_status: 'done', duration_sec: 900, has_ai: true, summary: SUMMARY,
      headline: 'Se habló de precios de balatas.',
      pend_total: 2, pend_done: 0, pend_overdue: 1, fup: 'overdue',
      pendings: [
        { id: 501, content: 'Enviar cotización', category: 'precio', due_date: '2026-08-10', done: false, overdue: 9 },
        { id: 502, content: 'Confirmar entrega', category: 'logistica', due_date: null, done: false, overdue: 0 },
      ],
    },
    {
      id: 11, consult_date: '2026-08-19', company_name: 'Alfa Autopartes', contact_name: 'Maria',
      wa_phone: null, email: null, place_label: null, geo_lat: null, geo_lng: null, geo_accuracy: null, note: null,
      created_by: 3, by_name: 'Maria', by_login: 'maria', is_private: true, private_by: 1,
      rec_id: null, rec_status: null, duration_sec: null, has_ai: false, summary: null, headline: null,
      pend_total: 0, pend_done: 0, pend_overdue: 0, fup: 'none', pendings: [],
    },
  ],
};

function boot(user) {
  fetchLog = []; fetchRoutes = [];
  dom = new JSDOM(html, {
    url: 'https://example.test/refatrix-consult.html',
    runScripts: 'dangerously',
    beforeParse(w) {
      w.fetch = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        fetchLog.push({ url: String(url), method, body: opts.body ? String(opts.body) : null });
        const m = fetchRoutes.find((r) => r.method === method && String(url).includes(r.urlPart));
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

beforeEach(() => boot({ id: 1, name: 'director', role: 'director' }));

const $ = (id) => win.document.getElementById(id);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const txt = (id) => ($(id) ? $(id).textContent : '');

// ── 화면 초기 상태 ──────────────────────────────────────────────────
test('초기: 녹음 카드는 숨김 · 표는 안내문 · 상담 폼이 모두 있다', () => {
  assert.ok($('cs-recCard').classList.contains('hidden'));
  assert.ok(txt('cs-table').includes('조회'));
  for (const id of ['cs-company', 'cs-contact', 'cs-phone', 'cs-email', 'cs-date', 'cs-geoBtn', 'cs-recStart', 'cs-recStop']) {
    assert.ok($(id), 'missing #' + id);
  }
  assert.equal($('cs-recStart').textContent, '● 미팅 녹음');
  assert.equal($('cs-recStop').textContent, '⏹ 녹음 종료');
});

test('위치정보: 버튼을 누르면 좌표를 잡고 안내가 바뀐다', () => {
  $('cs-geoBtn').click();
  assert.ok(txt('cs-geo').includes('현재 위치 확보됨'));
  assert.ok(txt('cs-geo').includes('25.60000'));
});

// ── 상담 저장 ───────────────────────────────────────────────────────
test('상담 저장: 업체명·연락처·날짜·위치를 담아 POST 하고 녹음 카드가 열린다', async () => {
  route('POST', '/api/consults', { id: 77, company_name: 'Zeta' });
  route('GET', '/api/consults/77/recordings', { items: [] });
  route('GET', '/api/consults?', { items: [], categories: LIST.categories });
  $('cs-geoBtn').click();
  $('cs-company').value = 'Zeta Refacciones';
  $('cs-contact').value = 'Juan';
  $('cs-phone').value = '81-1234-5678';
  $('cs-email').value = 'juan@zeta.mx';
  $('cs-date').value = '2026-08-18';
  $('cs-save').click();
  await tick(40);
  const post = fetchLog.find((f) => f.method === 'POST' && f.url.includes('/api/consults'));
  assert.ok(post, 'POST /api/consults 없음');
  const b = JSON.parse(post.body);
  assert.equal(b.company_name, 'Zeta Refacciones');
  assert.equal(b.contact_name, 'Juan');
  assert.equal(b.wa_phone, '81-1234-5678');
  assert.equal(b.email, 'juan@zeta.mx');
  assert.equal(b.consult_date, '2026-08-18');
  assert.equal(b.geo_lat, 25.6);
  assert.ok(!$('cs-recCard').classList.contains('hidden'));
  assert.ok(txt('cs-msg').includes('저장했습니다'));
});

test('상담 저장: 업체명이 비면 저장하지 않는다', async () => {
  $('cs-company').value = '';
  $('cs-date').value = '2026-08-18';
  $('cs-save').click();
  await tick();
  assert.ok(!fetchLog.some((f) => f.method === 'POST'));
  assert.ok(txt('cs-msg').includes('업체명'));
});

// ── 녹음 → 자동 분할 업로드 ─────────────────────────────────────────
async function recordAndStop(sec) {
  route('GET', '/api/consults/77/recordings', { items: [] });
  win.csShowRec(77, 'Zeta');
  await tick();
  $('cs-recStart').click();
  await tick(30);
  assert.ok(!$('cs-recStop').classList.contains('hidden'), '종료 버튼이 보여야 함');
  win.eval('csRecSec = ' + sec + ';');
  $('cs-recStop').click();
  await tick(20);
}

test('녹음 종료: 버튼을 누르지 않아도 자동으로 조각을 올리고 commit 까지 간다', async () => {
  route('POST', '/recordings/parts', { ok: true });
  route('POST', '/recordings/commit', { id: 900, status: 'queued', stt_ready: true, ai_ready: true });
  await recordAndStop(30);
  await tick(600);

  const part = fetchLog.find((f) => f.method === 'POST' && f.url.includes('/recordings/parts'));
  assert.ok(part, '조각 전송이 자동으로 시작돼야 함');
  const pb = JSON.parse(part.body);
  assert.equal(pb.seg_no, 0);
  assert.equal(pb.part_no, 0);
  assert.equal(pb.b64, 'QUJD', 'data URL 접두어를 뗀 base64 본문만 보낸다');
  assert.ok(/^[A-Za-z0-9_-]{8,64}$/.test(pb.session_key));

  const cm = fetchLog.find((f) => f.method === 'POST' && f.url.includes('/recordings/commit'));
  assert.ok(cm, 'commit 이 뒤따라야 함');
  const cb = JSON.parse(cm.body);
  assert.equal(cb.session_key, pb.session_key, '같은 세션 키로 조립한다');
  assert.equal(cb.mode, 'full');
  assert.equal(cb.duration_sec, 30);
  assert.equal(cb.mime, 'audio/webm', 'codecs 파라미터는 떼고 보낸다');
  assert.deepEqual(cb.segments, [{ parts: 1 }]);
  assert.ok(txt('cs-recMsg').includes('업로드 완료'));
  assert.ok($('cs-recReady').classList.contains('hidden'), '성공하면 업로드 영역이 닫힌다');
});

test('녹음 종료: 5초 미만이면 자동 업로드하지 않고 안내만 한다', async () => {
  route('POST', '/recordings/parts', { ok: true });
  await recordAndStop(2);
  await tick(600);
  assert.equal(fetchLog.find((f) => f.url.includes('/recordings/parts')), undefined, '실수로 누른 녹음은 안 올린다');
  assert.ok(txt('cs-recMsg').includes('너무 짧아'));
  assert.ok(!$('cs-recReady').classList.contains('hidden'), '수동으로 올릴 수 있게 남겨둔다');
});

test('큰 녹음은 3MB 조각으로 나눠 순서대로 보낸다', async () => {
  route('POST', '/recordings/parts', { ok: true });
  route('POST', '/recordings/commit', { id: 901, status: 'queued' });
  win.eval(`csRecConsult = { id: 77, company: 'Zeta' };
    csRecSegs = [{ size: 7 * 1024 * 1024, type: 'audio/webm', slice() { return this; } }];
    csRecSec = 1300; csRecMime = 'audio/webm'; csRecBlob = null;`);
  win.eval('csRecUpload()');
  await tick(300);
  const parts = fetchLog.filter((f) => f.url.includes('/recordings/parts')).map((f) => JSON.parse(f.body));
  assert.equal(parts.length, 3, '7MB → 3MB 조각 3개');
  assert.deepEqual(parts.map((p) => p.part_no), [0, 1, 2]);
  assert.equal(new Set(parts.map((p) => p.session_key)).size, 1);
  const cb = JSON.parse(fetchLog.find((f) => f.url.includes('/recordings/commit')).body);
  assert.deepEqual(cb.segments, [{ parts: 3 }]);
  assert.equal(cb.duration_sec, 1300);
});

test('전송이 끊기면 몇 조각까지 갔는지 알려주고 녹음은 남겨둔다', async () => {
  routeThrow('POST', '/recordings/parts');
  await recordAndStop(30);
  await tick(3000);
  assert.ok(txt('cs-recMsg').includes('전송이 끊겼습니다'), txt('cs-recMsg'));
  assert.ok(txt('cs-recMsg').includes('녹음 내용은 그대로 남아'));
  assert.ok(!$('cs-recReady').classList.contains('hidden'), '다시 업로드할 수 있어야 한다');
  assert.equal($('cs-recUpload').textContent, '↻ 다시 업로드');
  assert.ok(fetchLog.filter((f) => f.url.includes('/recordings/parts')).length >= 2, '자동 재시도를 한다');
});

test('서버가 거절하면 그 이유를 그대로 보여준다(총량 초과)', async () => {
  route('POST', '/recordings/parts', { ok: true });
  route('POST', '/recordings/commit', { error: 'too_large', max_mb: 58 }, 400);
  await recordAndStop(30);
  await tick(600);
  assert.ok(txt('cs-recMsg').includes('서버가 거절했습니다'));
  assert.ok(txt('cs-recMsg').includes('최대 길이'));
});

test('서버가 거절하면 그 이유를 그대로 보여준다(구간 하나가 25MB 초과)', async () => {
  route('POST', '/recordings/parts', { ok: true });
  route('POST', '/recordings/commit', { error: 'segment_too_large', seg_no: 0, max_mb: 25 }, 400);
  await recordAndStop(30);
  await tick(600);
  assert.ok(txt('cs-recMsg').includes('서버가 거절했습니다'));
  assert.ok(txt('cs-recMsg').includes('25MB'));
});

// ── 긴 녹음: 구간 자동 분할 (2026-09-04) ────────────────────────────
test('구간이 6MB에 닿으면 자동으로 끊고 이어서 녹음한다(녹음은 계속)', async () => {
  route('GET', '/api/consults/77/recordings', { items: [] });
  win.csShowRec(77, 'Zeta');
  await tick();
  $('cs-recStart').click();
  await tick(30);
  const first = win.__lastRec;
  first.ondataavailable({ data: { size: 7 * 1024 * 1024, type: 'audio/webm' } });   // 구간 상한 초과
  await tick(40);
  assert.equal(win.eval('csRecSegs.length'), 1, '앞 구간이 보관돼야 함');
  assert.equal(win.eval('csRecActive'), true, '녹음은 계속돼야 함');
  assert.notEqual(win.__lastRec, first, '새 레코더로 이어 녹음');
  assert.ok(txt('cs-recMsg').includes('구간 2'));
  assert.ok(!fetchLog.some((f) => f.url.includes('/recordings/parts')), '중간 구간에서 업로드하지 않는다');
  win.eval('csRecReset();');     // 타이머 정리(테스트 종료용)
});

test('총량 상한에 닿으면 자동으로 종료하고 업로드한다', async () => {
  route('GET', '/api/consults/77/recordings', { items: [] });
  route('POST', '/recordings/parts', { ok: true });
  route('POST', '/recordings/commit', { id: 901, status: 'queued', stt_ready: true, ai_ready: true });
  win.csShowRec(77, 'Zeta');
  await tick();
  $('cs-recStart').click();
  await tick(30);
  win.eval('csRecSec = 30;');
  win.__lastRec.ondataavailable({ data: { size: 57 * 1024 * 1024, type: 'audio/webm' } });
  await tick(600);
  assert.equal(win.eval('csRecActive'), false, '자동 종료돼야 함');
  assert.ok(fetchLog.some((f) => f.url.includes('/recordings/commit')), '자동 업로드까지 이어진다');
});

test('백엔드가 아직 분할 업로드를 모르면(404) 예전 방식으로 되돌아간다', async () => {
  route('POST', '/recordings/parts', { error: 'Not Found', statusCode: 404 }, 404);
  route('POST', '/api/consults/77/recordings', { id: 902, status: 'queued', stt_ready: true, ai_ready: true });
  await recordAndStop(30);
  await tick(600);
  const legacy = fetchLog.find((f) => f.method === 'POST' && /\/recordings$/.test(f.url));
  assert.ok(legacy, '예전 단일 전송으로 폴백해야 함');
  const b = JSON.parse(legacy.body);
  assert.ok(String(b.data_url).startsWith('data:audio/webm;base64,'));
  assert.equal(b.mode, 'full');
  assert.ok(txt('cs-recMsg').includes('업로드 완료'));
});

test('0185 마이그레이션 전이면(503 migration_required) 예전 방식으로 되돌아간다', async () => {
  route('POST', '/recordings/parts', { error: 'migration_required', migration: '0185' }, 503);
  route('POST', '/api/consults/77/recordings', { id: 903, status: 'queued', stt_ready: true, ai_ready: true });
  await recordAndStop(30);
  await tick(600);
  const legacy = fetchLog.find((f) => f.method === 'POST' && /\/recordings$/.test(f.url));
  assert.ok(legacy, '마이그레이션 전에도 녹음이 올라가야 한다');
  assert.ok(txt('cs-recMsg').includes('업로드 완료'));
});

test('상담이 없어서 나는 404(not_found)는 폴백하지 않고 그대로 알린다', async () => {
  route('POST', '/recordings/parts', { error: 'not_found' }, 404);
  await recordAndStop(30);
  await tick(600);
  assert.equal(fetchLog.find((f) => /\/recordings$/.test(f.url) && f.method === 'POST'), undefined);
  assert.ok(txt('cs-recMsg').includes('상담을 찾을 수 없습니다'));
});

// ── 요약 렌더 + 한국어 토글 ─────────────────────────────────────────
test('요약 렌더: 카테고리 불릿·펜딩·제품이 나오고 한국어 버튼이 붙는다', async () => {
  route('GET', '/api/consults/77/recordings', { items: [{ id: 110, mode: 'full', duration_sec: 900, status: 'done', attempts: 1, transcript: 'texto', summary: SUMMARY }] });
  win.csShowRec(77, 'Zeta');
  await tick(30);
  const h = $('cs-recList').innerHTML;
  assert.ok(h.includes('Se habló de precios'));
  assert.ok(h.includes('가격·견적'));
  assert.ok(h.includes('제품·재고'));
  assert.ok(h.includes('Enviar cotización'));
  assert.ok(h.includes('2026-08-21'));
  assert.ok(h.includes('CL0001'));
  assert.ok(h.includes('🇰🇷 한국어'));
});

test('한국어 토글: POST translate 후 한국어로 바뀌고 다시 누르면 원문 복귀', async () => {
  route('GET', '/api/consults/77/recordings', { items: [{ id: 110, mode: 'full', status: 'done', attempts: 1, summary: SUMMARY }] });
  route('POST', '/api/consults/recordings/110/translate', { id: 110, ko: KO, cached: false });
  win.csShowRec(77, 'Zeta');
  await tick(30);
  $('cs-recList').querySelector('.cs-recKo').click();
  await tick(40);
  let h = $('cs-recList').innerHTML;
  assert.ok(h.includes('브레이크 패드 가격'));
  assert.ok(h.includes('AI 한국어 번역본'));
  assert.ok(h.includes('CL0001'), '제품 코드는 유지');
  assert.ok(h.includes('2026-08-21'), '기한은 유지');
  assert.equal(fetchLog.filter((f) => f.url.includes('/translate')).length, 1);
  // 원문 복귀 → 재요청 없음
  $('cs-recList').querySelector('.cs-recKo').click();
  await tick(20);
  h = $('cs-recList').innerHTML;
  assert.ok(h.includes('Se habló de precios'));
  $('cs-recList').querySelector('.cs-recKo').click();
  await tick(20);
  assert.equal(fetchLog.filter((f) => f.url.includes('/translate')).length, 1, '캐시라 재요청 없음');
});

// ── 종합표 ──────────────────────────────────────────────────────────
async function loadTable() {
  // 매번 깊은 복사 — 화면이 응답 객체를 직접 갱신하므로 테스트 간 상태가 새지 않게 한다
  route('GET', '/api/consults?', JSON.parse(JSON.stringify(LIST)));
  $('cs-from').value = '2026-08-01'; $('cs-to').value = '2026-08-31';
  await win.csLoadList();
  await tick(20);
}

test('표: 담당 직원 이름·아이디, WhatsApp/이메일 링크, 펜딩 수, 🔒 표시', async () => {
  await loadTable();
  const h = $('cs-table').innerHTML;
  assert.ok(h.includes('Oscar') && h.includes('oscar'), '직원 이름·아이디 표시');
  assert.ok(h.includes('Maria') && h.includes('maria'));
  assert.ok(h.includes('wa.me/8112345678'), 'WhatsApp 링크');
  assert.ok(h.includes('mailto:juan@zeta.mx'));
  assert.ok(h.includes('2 / 2'), '열린 펜딩 / 전체');
  assert.ok(h.includes('🔒'), '감춘 상담 표시');
  assert.ok(txt('cs-count').includes('2건'));
});

test('표: 열 제목 클릭으로 정렬 방향이 바뀐다(업체명 오름 → 내림)', async () => {
  await loadTable();
  const head = () => Array.from($('cs-table').querySelectorAll('tr.crow td:nth-child(4)')).map((td) => td.textContent.trim());
  const th = Array.from($('cs-table').querySelectorAll('th.s')).find((x) => x.dataset.k === 'company_name');
  th.click(); await tick();
  const asc = Array.from($('cs-table').querySelectorAll('tr.crow td:nth-child(4)')).map((td) => td.textContent.trim());
  assert.deepEqual(asc, ['Alfa Autopartes', 'Zeta Refacciones']);
  Array.from($('cs-table').querySelectorAll('th.s')).find((x) => x.dataset.k === 'company_name').click();
  await tick();
  assert.deepEqual(head(), ['Zeta Refacciones', 'Alfa Autopartes']);
});

test('표: 기본 정렬은 상담일 내림차순 · 펜딩 수 정렬도 동작', async () => {
  await loadTable();
  const dates = () => Array.from($('cs-table').querySelectorAll('tr.crow td:nth-child(2)')).map((td) => td.textContent.trim().slice(0, 10));
  assert.deepEqual(dates(), ['2026-08-19', '2026-08-18']);
  Array.from($('cs-table').querySelectorAll('th.s')).find((x) => x.dataset.k === 'pend_total').click();
  await tick();
  const first = $('cs-table').querySelector('tr.crow').dataset.id;
  assert.equal(first, '10', '펜딩 많은 건이 위로');
});

test('표: 행을 클릭하면 상세가 열리고 AI 요약·펜딩 체크리스트가 보인다', async () => {
  await loadTable();
  $('cs-table').querySelector('tr.crow[data-id="10"]').click();
  await tick();
  const det = $('cs-table').querySelector('tr.det');
  assert.ok(det, '상세 행이 열려야 함');
  const h = det.innerHTML;
  assert.ok(h.includes('Se habló de precios'));
  assert.ok(h.includes('Enviar cotización'));
  assert.ok(h.includes('연체'));
  assert.ok(h.includes('지도에서 보기'));
  assert.ok(h.includes('🎙 녹음/요약'));
});

test('표: 펜딩 체크 시 PATCH 하고 F/UP 집계가 갱신된다', async () => {
  await loadTable();
  route('PATCH', '/api/consults/pendings/501', { ok: true });
  route('PATCH', '/api/consults/pendings/502', { ok: true });
  $('cs-table').querySelector('tr.crow[data-id="10"]').click();
  await tick();
  $('cs-table').querySelectorAll('.cs-pchk').forEach(() => {});
  const boxes = Array.from($('cs-table').querySelectorAll('.cs-pchk'));
  assert.equal(boxes.length, 2);
  boxes[0].click();
  await tick(20);
  const p = fetchLog.find((f) => f.method === 'PATCH' && f.url.includes('/pendings/501'));
  assert.ok(p);
  assert.equal(JSON.parse(p.body).done, true);
});

// ── 선택 → 카테고리별 펜딩 정리 ─────────────────────────────────────
test('선택: 체크하면 상담 건별 + 카테고리별 펜딩 정리가 렌더된다', async () => {
  await loadTable();
  assert.ok(txt('cs-pendBox').includes('선택하면'));
  const chk = $('cs-table').querySelector('.cs-chk[data-id="10"]');
  chk.click();
  await tick();
  const h = $('cs-pendBox').innerHTML;
  assert.ok(h.includes('상담 건별'));
  assert.ok(h.includes('카테고리별 정리'));
  assert.ok(h.includes('Zeta Refacciones'));
  assert.ok(h.includes('가격·견적'));
  assert.ok(h.includes('물류·납품'));
  assert.ok(h.includes('연체'));
  assert.ok(txt('cs-selInfo').includes('1건'));
});

test('전체 선택 체크박스가 모든 행을 선택한다', async () => {
  await loadTable();
  $('cs-selAll').checked = true;
  $('cs-selAll').dispatchEvent(new win.Event('change'));
  await tick();
  assert.ok(txt('cs-selInfo').includes('2건'));
});

// ── 감추기(디렉터 특별권한) ─────────────────────────────────────────
test('디렉터: 상세에 감추기 버튼이 있고 누르면 POST private', async () => {
  await loadTable();
  route('POST', '/api/consults/10/private', { ok: true, id: 10, is_private: true });
  $('cs-table').querySelector('tr.crow[data-id="10"]').click();
  await tick();
  const btn = $('cs-table').querySelector('.cs-privBtn');
  assert.ok(btn, '감추기 버튼 필요');
  assert.ok(btn.textContent.includes('감추기'));
  btn.click();
  await tick(30);
  const p = fetchLog.find((f) => f.method === 'POST' && f.url.includes('/private'));
  assert.ok(p);
  assert.equal(JSON.parse(p.body).value, true);
});

test('디렉터: 이미 감춘 상담은 「다시 공개」 버튼 · 🔒 필터가 숨긴 건만 남긴다', async () => {
  await loadTable();
  $('cs-table').querySelector('tr.crow[data-id="11"]').click();
  await tick();
  assert.ok($('cs-table').querySelector('.cs-privBtn').textContent.includes('다시 공개'));
  $('cs-privOnly').checked = true;
  $('cs-privOnly').dispatchEvent(new win.Event('change'));
  await tick();
  const ids = Array.from($('cs-table').querySelectorAll('tr.crow')).map((tr) => tr.dataset.id);
  assert.deepEqual(ids, ['11']);
});

test('영업사원 계정: 감추기 버튼과 담당자 필터·🔒 필터가 없다', async () => {
  boot({ id: 2, name: 'Oscar', role: 'sales' });
  await loadTable();
  $('cs-table').querySelector('tr.crow[data-id="10"]').click();
  await tick();
  assert.equal($('cs-table').querySelector('.cs-privBtn'), null);
  assert.ok($('cs-userWrap').classList.contains('hidden'));
  assert.ok($('cs-privWrap').classList.contains('hidden'));
});

// ── 기간 인사이트 ───────────────────────────────────────────────────
test('인사이트: 선택 없이 누르면 안내 · 선택 후에는 POST 하고 카테고리 불릿을 렌더', async () => {
  await loadTable();
  $('cs-insBtn').click();
  await tick();
  assert.ok(txt('cs-insMsg').includes('선택'));
  assert.ok(!fetchLog.some((f) => f.url.includes('/insights')));

  const chk = $('cs-table').querySelector('.cs-chk[data-id="10"]');
  chk.click();
  await tick();
  route('POST', '/api/consults/insights', {
    scope_key: 'c:10', count: 1, cached: false, from: '2026-08-18', to: '2026-08-18',
    insight: {
      headline: '가격 압박이 반복됨',
      period_bullets: [{ category: 'precio', text: '3개 업체가 할인 요구' }],
      themes: ['할인 요구 반복'], risks: ['SYD 침투'],
      next_actions: [{ content: '가격표 재검토', category: 'precio' }],
    },
  });
  $('cs-insBtn').click();
  await tick(40);
  const p = fetchLog.find((f) => f.method === 'POST' && f.url.includes('/insights'));
  assert.ok(p);
  assert.deepEqual(JSON.parse(p.body).ids, [10]);
  const h = $('cs-insBox').innerHTML;
  assert.ok(h.includes('가격 압박이 반복됨'));
  assert.ok(h.includes('3개 업체가 할인 요구'));
  assert.ok(h.includes('반복된 주제'));
  assert.ok(h.includes('위험 신호'));
  assert.ok(h.includes('가격표 재검토'));
});

test('인사이트: 요약이 없으면(no_content) 친절한 안내가 뜬다', async () => {
  await loadTable();
  const chk = $('cs-table').querySelector('.cs-chk[data-id="11"]');
  chk.click();
  await tick();
  route('POST', '/api/consults/insights', { error: 'no_content' }, 409);
  $('cs-insBtn').click();
  await tick(40);
  assert.ok(txt('cs-insMsg').includes('요약·펜딩 내용이 없습니다'));
});

// ── 표 전체 한국어 ──────────────────────────────────────────────────
test('표 전체 한국어: 요약 있는 행만 번역하고 표 요약이 한국어로 바뀐다', async () => {
  await loadTable();
  route('POST', '/api/consults/recordings/110/translate', { id: 110, ko: KO, cached: false });
  $('cs-koAll').click();
  await tick(60);
  assert.equal(fetchLog.filter((f) => f.url.includes('/translate')).length, 1);
  assert.ok($('cs-table').innerHTML.includes('브레이크 패드 가격'));
  assert.ok(txt('cs-tblMsg').includes('한국어'));
});

// ── XSS ─────────────────────────────────────────────────────────────
test('XSS: 업체명·요약의 태그가 이스케이프된다', async () => {
  const evil = JSON.parse(JSON.stringify(LIST));
  evil.items[0].company_name = '<img src=x onerror=alert(1)>';
  evil.items[0].summary.resumen = '<script>bad()</' + 'script>';
  fetchRoutes = [];
  route('GET', '/api/consults?', evil);
  $('cs-from').value = '2026-08-01'; $('cs-to').value = '2026-08-31';
  await win.csLoadList();
  await tick(20);
  const h = $('cs-table').innerHTML;
  assert.ok(!h.includes('<img src=x'));
  assert.ok(h.includes('&lt;img src=x'));
  assert.equal($('cs-table').querySelectorAll('img').length, 0);
});

// ── 고객 이름으로 찾기 ──────────────────────────────────────────────
test('고객 검색: 이름 일부를 치면 드롭다운이 걸러지고 스페인어 강세부호는 무시한다', async () => {
  route('GET', '/api/visits/customer-options', { items: [
    { id: 101, name: 'Refaccionaria El Águila' },
    { id: 102, name: 'Autopartes del Norte' },
    { id: 103, name: 'Aguilar Refacciones' },
  ] });
  await win.csLoadCustOptions();
  const sel = $('cs-cust');
  assert.equal(sel.options.length, 4, '안내 1 + 고객 3');
  assert.ok(txt('cs-custInfo').includes('3개'));

  $('cs-custQ').value = 'agui';
  $('cs-custQ').dispatchEvent(new win.Event('input'));
  const names = [...sel.options].slice(1).map((o) => o.textContent);
  assert.deepEqual(names, ['Refaccionaria El Águila', 'Aguilar Refacciones'], 'Águila 를 agui 로 찾는다');
});

test('고객 검색: 하나만 남으면 자동으로 선택하고, 없으면 직접 입력을 안내한다', async () => {
  route('GET', '/api/visits/customer-options', { items: [
    { id: 101, name: 'Refaccionaria El Águila' },
    { id: 102, name: 'Autopartes del Norte' },
    { id: 103, name: 'Aguilar Refacciones' },
  ] });
  await win.csLoadCustOptions();
  $('cs-custQ').value = 'norte';
  $('cs-custQ').dispatchEvent(new win.Event('input'));
  assert.equal($('cs-cust').value, '102');
  assert.ok(txt('cs-custInfo').includes('자동으로 선택'));

  $('cs-custQ').value = '없는이름';
  $('cs-custQ').dispatchEvent(new win.Event('input'));
  assert.equal($('cs-cust').options.length, 1);
  assert.ok(txt('cs-custInfo').includes('직접 입력'));
});

test('고객 검색: 고른 뒤 검색어를 지워도 선택이 유지된다', async () => {
  route('GET', '/api/visits/customer-options', { items: [
    { id: 101, name: 'Refaccionaria El Águila' },
    { id: 102, name: 'Autopartes del Norte' },
    { id: 103, name: 'Aguilar Refacciones' },
  ] });
  await win.csLoadCustOptions();
  $('cs-cust').value = '103';
  $('cs-custQ').value = '';
  $('cs-custQ').dispatchEvent(new win.Event('input'));
  assert.equal($('cs-cust').value, '103');
});
