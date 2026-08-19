// =====================================================================
// refatrix-customers.html 「🗣 상담·방문 이력」 프런트 (jsdom, 2026-08-19)
//   고객 상세에서 방문 날짜 표 · 카테고리 단어 · 드릴다운 · 🇰🇷 한국어 토글 검증.
// =====================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../refatrix-customers.html', import.meta.url), 'utf8');

let dom, win, fetchLog, fetchRoutes;
function route(method, urlPart, payload, status = 200, delay = 0) { fetchRoutes.push({ method, urlPart, payload, status, delay }); }

const ES = {
  resumen: 'Hablamos de la cotizacion y del pago pendiente',
  insights: 'Compra a la competencia',
  next_step: 'Visitar en 2 semanas',
  action_items: [{ content: 'Enviar cotizacion', due_date: '2026-08-25' }],
  products: ['CL0001'],
};
const KO = {
  resumen: '견적과 미수금에 대해 이야기함',
  insights: '경쟁사에서 구매 중',
  next_step: '2주 뒤 재방문',
  action_items: [{ content: '견적 발송', due_date: '2026-08-25' }],
  products: ['CL0001'],
};

function payload(extra = {}) {
  return {
    mx_today: '2026-08-19',
    scope: 'all',
    total: 2, visit_cnt: 1, meeting_cnt: 1, open_pendings: 1,
    first_date: '2026-08-15', last_date: '2026-08-18',
    tag_summary: [{ key: 'quote', label: '견적·가격', color: '#0f6b53', cnt: 2 }],
    items: [
      {
        key: 'v10', source: 'visit', id: 10, date: '2026-08-18', time: '11:20',
        by_name: 'Oscar', met_person: 'Luis',
        tags: ['quote', 'payment'],
        tag_chips: [{ key: 'quote', label: '견적·가격', color: '#0f6b53' },
                    { key: 'payment', label: '수금·결제', color: '#a35400' }],
        headline: ES.resumen, plan: 'hablar de precios', insight: ES.insights,
        summary: ES, has_ai: true, rec_id: 77, rec_status: 'done',
        pend_total: 2, pend_done: 1, pend_overdue: 1, fup: 'overdue',
        pendings: [{ id: 1, content: 'Enviar cotizacion', due_date: '2026-08-10', done: false, overdue: true },
                   { id: 2, content: 'Llamar', due_date: null, done: true }],
        stage_move: null,
        ...(extra.v10 || {}),
      },
      {
        key: 'm5', source: 'meeting', id: 5, date: '2026-08-15', time: null,
        by_name: 'Ana', met_person: null,
        tags: ['payment'], tag_chips: [{ key: 'payment', label: '수금·결제', color: '#a35400' }],
        headline: 'Llamada: pago pendiente', plan: 'Llamada: pago pendiente', insight: null,
        summary: null, has_ai: false, rec_id: null, rec_status: null,
        pend_total: 0, pend_done: 0, pend_overdue: 0, fup: 'none', pendings: [],
        stage_move: '3_견적 → 4_협상',
      },
    ],
    ...(extra.top || {}),
  };
}

beforeEach(() => {
  fetchLog = []; fetchRoutes = [];
  dom = new JSDOM(html, {
    url: 'https://example.test/refatrix-customers.html',
    runScripts: 'dangerously',
    beforeParse(w) {
      w.fetch = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        fetchLog.push({ url: String(url), method, body: opts.body ? String(opts.body) : null });
        const m = fetchRoutes.find((r) => r.method === method && String(url).includes(r.urlPart));
        const p = m ? m.payload : {};
        const status = m ? m.status : 200;
        if (m && m.delay) await new Promise((r) => setTimeout(r, m.delay));
        return { ok: status < 400, status, json: async () => p };
      };
      w.alert = (msg) => { w.__alert = String(msg); };
      w.confirm = () => true;
    },
  });
  win = dom.window;
  win.eval("session = { token:'tok', user:{ id:2, name:'Ana', role:'director' }, api:'' };");
});

const $ = (id) => win.document.getElementById(id);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('빈 이력: 「기록 없음」 안내만 표시', async () => {
  route('GET', '/api/customers/3/visits', { items: [], total: 0, visit_cnt: 0, meeting_cnt: 0, open_pendings: 0, tag_summary: [] });
  await win.loadCustVisits(3);
  await tick();
  const h = $('d-visits').innerHTML;
  assert.ok(h.includes('상담·방문 이력'));
  assert.ok(h.includes('아직 등록된 방문·상담 기록이 없습니다'));
  assert.equal($('d-visits').querySelectorAll('.cv-row').length, 0);
});

test('표 렌더: 날짜(요일) · 구분 · 담당 · 카테고리 단어 · 요약 · F/UP', async () => {
  route('GET', '/api/customers/3/visits', payload());
  await win.loadCustVisits(3);
  await tick();
  const box = $('d-visits');
  const rows = box.querySelectorAll('.cv-row');
  assert.equal(rows.length, 2, '방문 1 + 미팅 1');
  const r0 = rows[0].innerHTML;
  assert.ok(r0.includes('2026-08-18 (화)'), '날짜 + 요일');
  assert.ok(r0.includes('11:20'));
  assert.ok(r0.includes('🧭 방문'));
  assert.ok(r0.includes('Oscar') && r0.includes('Luis'));
  assert.ok(r0.includes('견적·가격') && r0.includes('수금·결제'), '카테고리 단어 pill');
  assert.ok(r0.includes('Hablamos de la cotizacion'), '요약 헤드라인(원문)');
  assert.ok(r0.includes('⚠ 연체') && r0.includes('1/2'), 'F/UP 배지 + 진행');
  assert.ok(r0.includes('🎙'), 'AI 요약 표식');
  const r1 = rows[1].innerHTML;
  assert.ok(r1.includes('📝 미팅') && r1.includes('3_견적 → 4_협상'));
  assert.ok(box.innerHTML.includes('총 2건 · 방문 1 · 미팅 1'), '헤더 요약');
  assert.ok(box.innerHTML.includes('미완 후속 1건'));
});

test('헤더 접기/펴기 토글', async () => {
  route('GET', '/api/customers/3/visits', payload());
  await win.loadCustVisits(3); await tick();
  assert.notEqual($('cvBody').style.display, 'none');
  $('cv-head').click();
  assert.equal($('cvBody').style.display, 'none');
  $('cv-head').click();
  assert.notEqual($('cvBody').style.display, 'none');
});

test('행 클릭: 드릴다운에 사전계획·AI요약·파악·제품·다음·후속조치 + 🇰🇷 버튼', async () => {
  route('GET', '/api/customers/3/visits', payload());
  await win.loadCustVisits(3); await tick();
  const box = $('d-visits');
  box.querySelector('.cv-row').click();
  const det = box.querySelector('.cv-detail[data-for="v10"]');
  assert.ok(!det.classList.contains('hidden'));
  const h = $('cv-det-v10').innerHTML;
  assert.ok(h.includes('사전 계획') && h.includes('hablar de precios'));
  assert.ok(h.includes('🎙 미팅 요약(AI)') && h.includes('Hablamos de la cotizacion'));
  assert.ok(h.includes('파악한 내용') && h.includes('Compra a la competencia'));
  assert.ok(h.includes('CL0001'));
  assert.ok(h.includes('Visitar en 2 semanas'));
  assert.ok(h.includes('후속조치 (1/2)') && h.includes('⚠ 연체'));
  assert.ok($('cv-det-v10').querySelector('.cv-koBtn'), '한국어 토글 버튼');
  // 다시 클릭 → 닫힘
  box.querySelector('.cv-row').click();
  assert.ok(det.classList.contains('hidden'));
});

test('미팅 행: AI 요약/토글 없음, 미팅 기록 라벨', async () => {
  route('GET', '/api/customers/3/visits', payload());
  await win.loadCustVisits(3); await tick();
  const box = $('d-visits');
  box.querySelectorAll('.cv-row')[1].click();
  const h = $('cv-det-m5').innerHTML;
  assert.ok(h.includes('미팅 기록'));
  assert.ok(h.includes('단계 이동'));
  assert.ok(!h.includes('🎙 미팅 요약(AI)'));
  assert.equal($('cv-det-m5').querySelector('.cv-koBtn'), null);
  assert.ok(!h.includes('녹음 AI 요약이 없습니다'), '미팅에는 녹음 안내를 붙이지 않음');
});

test('🇰🇷 토글: translate POST → 한국어 렌더 + 버튼이 원문으로', async () => {
  route('GET', '/api/customers/3/visits', payload());
  route('POST', '/api/visits/recordings/77/translate', { id: 77, ko: KO, cached: false });
  await win.loadCustVisits(3); await tick();
  $('d-visits').querySelector('.cv-row').click();
  $('cv-det-v10').querySelector('.cv-koBtn').click();
  await tick(30);
  const h = $('cv-det-v10').innerHTML;
  assert.ok(h.includes('견적과 미수금에 대해 이야기함'), '한국어 요약');
  assert.ok(h.includes('경쟁사에서 구매 중'), '한국어 파악');
  assert.ok(h.includes('2주 뒤 재방문'), '한국어 다음 계획');
  assert.ok(h.includes('견적 발송') && h.includes('2026-08-25'), '해야 할 일 기한 유지');
  assert.ok(h.includes('CL0001'), '제품 코드는 그대로');
  assert.ok(h.includes('🇰🇷 AI 한국어 번역본'));
  assert.equal($('cv-det-v10').querySelector('.cv-koBtn').textContent, '🇲🇽 원문(스페인어)');
  assert.equal(fetchLog.filter((f) => f.method === 'POST' && f.url.includes('/translate')).length, 1);
});

test('🇰🇷 → 원문 복귀 후 재클릭: 캐시 사용(추가 POST 없음)', async () => {
  route('GET', '/api/customers/3/visits', payload());
  route('POST', '/api/visits/recordings/77/translate', { id: 77, ko: KO, cached: false });
  await win.loadCustVisits(3); await tick();
  $('d-visits').querySelector('.cv-row').click();
  $('cv-det-v10').querySelector('.cv-koBtn').click(); await tick(30);
  $('cv-det-v10').querySelector('.cv-koBtn').click();          // 원문 복귀
  assert.ok($('cv-det-v10').innerHTML.includes('Hablamos de la cotizacion'));
  $('cv-det-v10').querySelector('.cv-koBtn').click(); await tick(20);  // 다시 한국어
  assert.ok($('cv-det-v10').innerHTML.includes('견적과 미수금'));
  assert.equal(fetchLog.filter((f) => f.method === 'POST' && f.url.includes('/translate')).length, 1, '번역 호출 1회뿐');
});

test('서버가 이미 ko 캐시를 내려준 경우: POST 없이 즉시 전환', async () => {
  route('GET', '/api/customers/3/visits', payload({ v10: { summary: { ...ES, ko: KO } } }));
  await win.loadCustVisits(3); await tick();
  $('d-visits').querySelector('.cv-row').click();
  $('cv-det-v10').querySelector('.cv-koBtn').click(); await tick(20);
  assert.ok($('cv-det-v10').innerHTML.includes('견적과 미수금'));
  assert.equal(fetchLog.filter((f) => f.url.includes('/translate')).length, 0);
});

test('번역 실패(키 미설정): 원문 유지 + 버튼 복구 + 안내', async () => {
  route('GET', '/api/customers/3/visits', payload());
  route('POST', '/api/visits/recordings/77/translate', { error: 'no_anthropic_key' }, 503);
  await win.loadCustVisits(3); await tick();
  $('d-visits').querySelector('.cv-row').click();
  $('cv-det-v10').querySelector('.cv-koBtn').click(); await tick(30);
  assert.ok($('cv-det-v10').innerHTML.includes('Hablamos de la cotizacion'), '원문 유지');
  const btn = $('cv-det-v10').querySelector('.cv-koBtn');
  assert.equal(btn.textContent, '🇰🇷 한국어');
  assert.equal(btn.disabled, false);
  assert.ok(String(win.__alert).includes('ANTHROPIC_API_KEY'));
});

test('요약 없는 방문: 안내 문구 + 토글 없음', async () => {
  route('GET', '/api/customers/3/visits',
    payload({ v10: { summary: null, has_ai: false, rec_id: null, rec_status: 'failed', headline: 'plan only' } }));
  await win.loadCustVisits(3); await tick();
  $('d-visits').querySelector('.cv-row').click();
  const h = $('cv-det-v10').innerHTML;
  assert.ok(h.includes('녹음 AI 요약이 없습니다') && h.includes('failed'));
  assert.equal($('cv-det-v10').querySelector('.cv-koBtn'), null);
  assert.ok(h.includes('Compra a la competencia'), 'AI 없으면 수기 파악내용 표시');
});

test('권한 오류(다른 팀): 안내만 표시', async () => {
  route('GET', '/api/customers/3/visits', { error: 'forbidden_team' }, 403);
  await win.loadCustVisits(3); await tick();
  assert.ok($('d-visits').innerHTML.includes('다른 팀 고객'));
});

test('XSS: 요약/카테고리 라벨은 이스케이프된다', async () => {
  const bad = '<img src=x onerror=alert(1)>';
  route('GET', '/api/customers/3/visits', payload({ v10: { headline: bad, met_person: bad } }));
  await win.loadCustVisits(3); await tick();
  const h = $('d-visits').innerHTML;
  assert.ok(!h.includes('<img src=x'), '원본 태그가 그대로 들어가지 않음');
  assert.ok(h.includes('&lt;img src=x'));
});

test('openCustomer 가 상담·방문 이력을 함께 부른다', async () => {
  route('GET', '/api/customers/3/visits', payload());
  route('GET', '/api/customers/3', { customer: { id: 3, name: 'Aguila', code: 'C003', discount: 0, credit_days: 0 },
    invoices: [], summary: {}, reorder_summary: null });
  route('GET', '/api/customers/3/documents', { items: [] });
  route('GET', '/api/customers/3/terms-history', { items: [] });
  await win.openCustomer(3);
  await tick(40);
  assert.ok(fetchLog.some((f) => f.url.includes('/api/customers/3/visits')), '/visits 호출');
  assert.ok($('d-visits').querySelectorAll('.cv-row').length === 2);
});

test('경합 방지: 느린 A 응답이 뒤늦게 와도 이미 연 B 를 덮어쓰지 않는다', async () => {
  const a = payload(); a.items[0].headline = 'AAA 고객의 방문';
  const b = payload(); b.items[0].headline = 'BBB 고객의 방문';
  route('GET', '/api/customers/3/visits', a, 200, 60);   // A 는 느리게
  route('GET', '/api/customers/4/visits', b, 200, 0);    // B 는 즉시
  const pA = win.loadCustVisits(3);
  const pB = win.loadCustVisits(4);
  await Promise.all([pA, pB]);
  await tick(80);
  const h = $('d-visits').innerHTML;
  assert.ok(h.includes('BBB 고객의 방문'), '나중에 연 고객(B)의 이력이 남아야 한다');
  assert.ok(!h.includes('AAA 고객의 방문'), '먼저 연 고객(A)의 늦은 응답은 버려져야 한다');
});

test('카테고리 4개 초과: 4개만 칩으로, 나머지는 +N', async () => {
  const p = payload();
  p.items[0].tag_chips = [
    { key: 'quote', label: '견적·가격', color: '#0f6b53' },
    { key: 'order', label: '주문·수주', color: '#1d6fa5' },
    { key: 'claim', label: '클레임·품질', color: '#c0392b' },
    { key: 'delivery', label: '납기·물류', color: '#b8860b' }];
  p.items[0].tag_more = 2;
  route('GET', '/api/customers/3/visits', p);
  await win.loadCustVisits(3); await tick();
  const row = $('d-visits').querySelectorAll('.cv-row')[0].innerHTML;
  assert.ok(row.includes('납기·물류') && row.includes('+2'));
});

test('상한 도달(truncated): 최근 N건까지만 표시 안내', async () => {
  route('GET', '/api/customers/3/visits', payload({ top: { truncated: true, limit: 300 } }));
  await win.loadCustVisits(3); await tick();
  assert.ok($('d-visits').innerHTML.includes('최근 300건까지만 표시'));
});

test('상한 미도달: 안내 없음', async () => {
  route('GET', '/api/customers/3/visits', payload());
  await win.loadCustVisits(3); await tick();
  assert.ok(!$('d-visits').innerHTML.includes('까지만 표시'));
});

test('본인 기록만 보이는 사용자: 「내 기록만」 배지 + 빈 상태 안내가 달라진다', async () => {
  route('GET', '/api/customers/3/visits', payload({ top: { scope: 'own' } }));
  await win.loadCustVisits(3); await tick();
  assert.ok($('d-visits').innerHTML.includes('내 기록만'));

  fetchRoutes = [];
  route('GET', '/api/customers/9/visits',
    { scope: 'own', items: [], total: 0, visit_cnt: 0, meeting_cnt: 0, open_pendings: 0, tag_summary: [] });
  await win.loadCustVisits(9); await tick();
  const h = $('d-visits').innerHTML;
  assert.ok(h.includes('내가 기록한 방문·상담이 없습니다'));
  assert.ok(h.includes('디렉터만'));
});

test('디렉터(scope=all): 「내 기록만」 배지 없음', async () => {
  route('GET', '/api/customers/3/visits', payload());
  await win.loadCustVisits(3); await tick();
  assert.ok(!$('d-visits').innerHTML.includes('내 기록만'));
});
