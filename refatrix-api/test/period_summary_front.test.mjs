// 오늘 요약 화면(refatrix-daily.html) 프런트 동작 테스트 — 인라인 JS 를 jsdom 에서 실제로 돌린다.
//   ① 기간 묶음 요약: 선택 검증 → 없는 일자별 요약 선행 생성 → 묶음 호출 → 보관함/열람
//   ② 나의 기록: 원본 보기·헤드라인 수치 노출
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert/strict';

const HTML = readFileSync(new URL('../../refatrix-daily.html', import.meta.url), 'utf8');

function boot({ daily = [], periods = [] } = {}) {
  const calls = [];
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
  });
  const w = dom.window;
  const state = {
    daily: daily.slice(),                 // [{summary_date, stats, content_md, digest}]
    periods: periods.slice(),             // [{id, title, ...}]
    nextId: 100,
  };
  const j = (o, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => o });
  w.fetch = async (url, opt = {}) => {
    const u = String(url); const method = (opt.method || 'GET').toUpperCase();
    const body = opt.body ? JSON.parse(opt.body) : null;
    calls.push({ url: u, method, body });
    if (u.includes('/api/daily-summary/list')) {
      return j({ ai_enabled: true, wa_enabled: false, items: state.daily.map((d) => ({ ...d, id: 1, has_memo: false })) });
    }
    if (u.includes('/api/daily-summary/generate')) {
      for (const d of body.dates) if (!state.daily.find((x) => x.summary_date === d)) state.daily.push({ summary_date: d, stats: { journal: 1, schedule: 2 } });
      return j({ model: 'm', results: body.dates.map((d) => ({ date: d, ok: true, id: 1 })) });
    }
    if (u.includes('/api/period-summary/generate')) {
      const missing = body.dates.filter((d) => !state.daily.find((x) => x.summary_date === d));
      if (missing.length) return j({ error: 'missing_dates', missing }, false);
      const id = state.nextId++;
      state.periods.unshift({
        id, title: body.title || '기간 라벨', label: '라벨', dates: body.dates,
        date_from: body.dates[0], date_to: body.dates[body.dates.length - 1], day_count: body.dates.length,
        stats: { journal: 2, schedule: 6 }, content_md: '### 기간 한눈에\n- 스토리 본문', memo: '', has_memo: false,
      });
      return j({ ok: true, id, regenerated: false, title: body.title || '기간 라벨', label: '라벨' });
    }
    if (u.includes('/api/period-summary/list')) return j({ ai_enabled: true, items: state.periods });
    const pm = u.match(/\/api\/period-summary\/(\d+)(\/memo)?$/);
    if (pm) {
      const id = Number(pm[1]);
      const idx = state.periods.findIndex((p) => p.id === id);
      if (method === 'GET') return idx < 0 ? j({ error: 'not_found' }, false) : j(state.periods[idx]);
      if (method === 'PUT') { state.periods[idx].memo = body.memo; return j({ ok: true, id }); }
      if (method === 'DELETE') { state.periods.splice(idx, 1); return j({ ok: true, id }); }
    }
    if (u.includes('/api/daily-summary/wa/status')) return j({ enabled: false, ai_enabled: true, send_hour_mx: 5, recent: [] });
    const dm = u.match(/\/api\/daily-summary\/(\d{4}-\d{2}-\d{2})$/);
    if (dm) { const d = state.daily.find((x) => x.summary_date === dm[1]); return d ? j({ ...d, memo: '', content_md: d.content_md || '### 오늘 한눈에\n- 내용' }) : j({ error: 'not_found' }, false); }
    return j({});
  };
  w.confirm = () => true;
  w.alert = () => {};
  w.eval(`session={token:'t',user:{id:1,name:'디렉터',role:'director'},api:''}; isDirector=true; aiEnabled=true;`);
  return { w, calls, state };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('묶음 카드와 보관함이 화면에 존재한다', () => {
  const { w } = boot();
  assert.ok(w.document.getElementById('perBtn'), '묶기 버튼');
  assert.ok(w.document.getElementById('perTitle'), '제목 입력');
  assert.ok(w.document.getElementById('perList'), '묶음 보관함');
  assert.ok(w.document.getElementById('perView'), '묶음 열람 영역');
});

test('날짜를 1개만 고르면 안내만 뜨고 서버를 부르지 않는다', async () => {
  const { w, calls } = boot();
  w.eval(`selDates=new Set(['2026-08-25']);`);
  w.document.getElementById('perBtn').click();
  await tick(20);
  assert.equal(calls.length, 0, '네트워크 호출 없음');
  assert.match(w.document.getElementById('perHint').textContent, /2개 이상/);
});

test('31일을 넘겨 고르면 막는다', async () => {
  const { w, calls } = boot();
  const many = Array.from({ length: 32 }, (_, i) => '2026-07-' + String(i + 1).padStart(2, '0'));
  w.eval(`selDates=new Set(${JSON.stringify(many)});`);
  w.document.getElementById('perBtn').click();
  await tick(20);
  assert.equal(calls.length, 0);
  assert.match(w.document.getElementById('perHint').textContent, /최대 31일/);
});

test('일자별 요약이 없는 날짜는 먼저 일자별로 생성한 뒤 묶는다', async () => {
  const { w, calls } = boot({ daily: [{ summary_date: '2026-08-25', stats: { journal: 1 } }] });
  await w.loadList();
  w.eval(`selDates=new Set(['2026-08-25','2026-08-26','2026-08-27']);`);
  w.document.getElementById('perBtn').click();
  await tick(60);
  const gen = calls.find((c) => c.url.includes('/api/daily-summary/generate'));
  assert.ok(gen, '일자별 선행 생성 호출');
  assert.deepEqual(gen.body.dates, ['2026-08-26', '2026-08-27'], '이미 있는 25일은 다시 만들지 않음');
  const per = calls.find((c) => c.url.includes('/api/period-summary/generate'));
  assert.ok(per, '묶음 호출');
  assert.deepEqual(per.body.dates, ['2026-08-25', '2026-08-26', '2026-08-27'], '오름차순 전체 날짜');
});

test('모두 이미 있으면 일자별 생성 없이 바로 묶는다', async () => {
  const { w, calls } = boot({ daily: [{ summary_date: '2026-08-25' }, { summary_date: '2026-08-26' }] });
  await w.loadList();
  w.eval(`selDates=new Set(['2026-08-25','2026-08-26']);`);
  w.document.getElementById('perBtn').click();
  await tick(60);
  assert.ok(!calls.some((c) => c.url.includes('/api/daily-summary/generate')), '불필요한 AI 호출 없음');
  assert.ok(calls.some((c) => c.url.includes('/api/period-summary/generate')));
});

test('제목을 입력하면 그대로 전송되고, 성공하면 선택이 비워지고 결과가 열린다', async () => {
  const { w, calls } = boot({ daily: [{ summary_date: '2026-08-25' }, { summary_date: '2026-08-26' }] });
  await w.loadList();
  w.document.getElementById('perTitle').value = '8월 4주차 주간 요약';
  w.eval(`selDates=new Set(['2026-08-25','2026-08-26']);`);
  w.document.getElementById('perBtn').click();
  await tick(60);
  const per = calls.find((c) => c.url.includes('/api/period-summary/generate'));
  assert.equal(per.body.title, '8월 4주차 주간 요약');
  assert.equal(w.eval('selDates.size'), 0, '선택 초기화');
  const view = w.document.getElementById('perView');
  assert.ok(!view.classList.contains('hidden'), '열람 뷰가 열림');
  assert.match(view.textContent, /스토리 본문/);
  assert.match(view.textContent, /8월 4주차 주간 요약/);
  assert.match(w.document.getElementById('perHint').textContent, /묶음 요약을 만들었습니다/);
});

test('서버가 missing_dates 를 주면 어떤 날짜가 빠졌는지 보여준다', async () => {
  const { w } = boot();
  await w.loadList();
  w.eval(`selDates=new Set(['2026-08-25','2026-08-26']); sumMap={'2026-08-25':{},'2026-08-26':{}};`);
  w.document.getElementById('perBtn').click();
  await tick(60);
  assert.match(w.document.getElementById('perHint').textContent, /일자별 요약이 없는 날짜/);
  assert.match(w.document.getElementById('perHint').textContent, /2026-08-25/);
});

test('보관함: 목록 렌더 → 열람 → 메모 자동 저장 → 삭제', async () => {
  const { w, calls, state } = boot({
    periods: [{ id: 7, title: '지난주', label: '라벨', dates: ['2026-08-18', '2026-08-19'], date_from: '2026-08-18', date_to: '2026-08-19', day_count: 2, stats: { journal: 1, schedule: 3 }, content_md: '### 기간 한눈에\n- 지난주 본문', memo: '', has_memo: false }],
  });
  await w.loadPeriodList();
  const list = w.document.getElementById('perList');
  assert.match(list.textContent, /지난주/);
  assert.match(list.textContent, /📝기록 1/, '기록 건수가 헤드라인에 표시');

  list.querySelector('.per-open').click();
  await tick(20);
  assert.match(w.document.getElementById('perView').textContent, /지난주 본문/);
  assert.match(w.document.getElementById('perView').textContent, /2026-08-18 · 2026-08-19/, '묶은 날짜 표시');

  const memo = w.document.getElementById('perMemo');
  memo.textContent = '다음 주 확인';
  memo.dispatchEvent(new w.Event('input'));
  await tick(1200);
  const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/api/period-summary/7/memo'));
  assert.ok(put, '메모 PUT 호출');
  assert.equal(put.body.memo, '다음 주 확인');

  w.document.getElementById('perList').querySelector('.per-del').click();
  await tick(30);
  assert.equal(state.periods.length, 0, '삭제됨');
  assert.match(w.document.getElementById('perList').textContent, /아직 묶음 요약이 없습니다/);
});

test('묶음 본문 렌더는 스크립트를 이스케이프한다(XSS 방어)', async () => {
  const { w } = boot({
    periods: [{ id: 8, title: '<img src=x onerror=alert(1)>', label: 'L', dates: ['2026-08-18'], date_from: '2026-08-18', date_to: '2026-08-18', day_count: 1, stats: {}, content_md: '### <script>alert(1)</script>\n- <b>굵게 아님</b>', memo: '' }],
  });
  await w.loadPeriodList();
  w.document.getElementById('perList').querySelector('.per-open').click();
  await tick(20);
  const v = w.document.getElementById('perView');
  assert.equal(v.querySelectorAll('script').length, 0, 'script 태그가 만들어지지 않음');
  assert.equal(v.querySelectorAll('img').length, 0, '제목의 img 태그도 이스케이프');
  assert.match(v.textContent, /alert\(1\)/, '텍스트로만 남음');
});

test('일자별 원본 보기에 「나의 기록」 섹션이 나온다', async () => {
  const { w } = boot({
    daily: [{ summary_date: '2026-08-27', stats: { journal: 1, schedule: 1 }, content_md: '### 오늘 한눈에\n- 내용',
      digest: { journal: [{ author: 'Sebastian', content: '수요일 일지\n둘째 줄' }], schedule: [], todos: {} } }],
  });
  await w.loadList();
  w.document.querySelector('#archList .arch-open').click();
  await tick(20);
  w.document.getElementById('rawBtn').click();
  await tick(10);
  const raw = w.document.getElementById('rawBody');
  assert.match(raw.textContent, /나의 기록 \(1건/);
  assert.match(raw.textContent, /수요일 일지/);
  assert.match(raw.textContent, /Sebastian/);
});

test('일자별 보관함 헤드라인에 기록 건수가 표시된다', async () => {
  const { w } = boot({ daily: [{ summary_date: '2026-08-27', stats: { journal: 2, schedule: 4 } }] });
  await w.loadList();
  assert.match(w.document.getElementById('archList').textContent, /📝기록 2/);
});

test('기존 일자별 생성 흐름은 그대로 동작한다(무회귀)', async () => {
  const { w, calls } = boot();
  await w.loadList();
  w.eval(`selDates=new Set(['2026-08-25','2026-08-26']); renderCal();`);
  w.document.getElementById('genBtn').click();
  await tick(60);
  const gen = calls.find((c) => c.url.includes('/api/daily-summary/generate'));
  assert.deepEqual(gen.body.dates, ['2026-08-25', '2026-08-26']);
  assert.match(w.document.getElementById('genHint').textContent, /2개 날짜 요약 저장/);
});

test('0189 미적용(migration_required)이면 안내만 뜨고 화면은 살아 있다', async () => {
  const { w } = boot();
  w.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('period-summary/list') ? { migration_required: true, items: [] } : {}) });
  await w.loadPeriodList();
  assert.match(w.document.getElementById('perList').textContent, /npm run migrate/);
});
