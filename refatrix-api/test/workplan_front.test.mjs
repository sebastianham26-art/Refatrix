// 직원 업무일지(0263) 프런트 — refatrix-board.html 인라인 JS + refatrix-workplan.js 를 jsdom 에서 실제로 돌린다.
//   실행: node --test test/workplan_front.test.mjs   (jsdom 필요: npm i --no-save jsdom)
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import test from 'node:test';
import assert from 'node:assert/strict';

const HTML = readFileSync(new URL('../../refatrix-board.html', import.meta.url), 'utf8');
const WPJS = readFileSync(new URL('../../refatrix-workplan.js', import.meta.url), 'utf8');
const TODAY = '2026-10-08';
const S = { plan_deadline: '10:00', done_deadline: '18:00', workdays: [1, 2, 3, 4, 5, 6], remind_enabled: true, remind_plan_at: '09:30', remind_done_at: '17:30',
  summary_enabled: true, summary_plan_at: '10:15', summary_done_at: '18:15', remind_template: null, remind_template_lang: 'es_MX', summary_user_ids: [] };
const emptyDay = { plan_saved_at: null, plan_late: false, plan_hm: null, done_saved_at: null, done_late: false, done_hm: null, extra_done: '' };

function boot({ director = false, enabled = true, nowMin = 545, items = null, day = null, date = TODAY, status = 200, team = null, marks = {} } = {}) {
  const calls = [];
  const dom = new JSDOM(HTML.replace(/<script src=[^>]*><\/script>/g, ''), { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/' });
  const w = dom.window;
  let nextId = 100;
  const st = { items: items || [{ id: 11, title: 'Leal 견적 후속', status: 'open', note: '', carried: true, carry_count: 1, added_late: false }], day: day || { ...emptyDay } };
  const sumOf = () => { const c = { total: st.items.length, done: 0, partial: 0 }; st.items.forEach((i) => { if (c[i.status] != null) c[i.status]++; });
    return { ...c, score: c.done + c.partial / 2, rate: 50, plan_written: !!st.day.plan_saved_at, done_written: !!st.day.done_saved_at }; };
  const me = () => ({ today: TODAY, now_min: nowMin, enabled, workday: true, settings: S, date, day: st.day, items: st.items, sum: sumOf(),
    can_plan: enabled && (date >= TODAY || !st.day.plan_saved_at), can_done: enabled && date <= TODAY && (date === TODAY || !st.day.done_saved_at) });
  w.fetch = async (url, opt = {}) => {
    const u = String(url); const method = (opt.method || 'GET').toUpperCase(); const body = opt.body ? JSON.parse(opt.body) : null;
    calls.push({ url: u, method, body });
    const j = (o, s = 200) => ({ ok: s < 400, status: s, json: async () => o, blob: async () => new w.Blob(['x']) });
    if (u.includes('/api/workplan/')) {
      if (status !== 200) return j({ error: 'migration_required' }, status);
      if (u.includes('/api/workplan/settings') && method === 'GET') return j({ settings: S, today: TODAY, wa_ready: true, next: [{ kind: 'sum_done', date: TODAY, at: '18:15' }] });
      if (u.includes('/api/workplan/settings') && method === 'PUT') return j({ ok: true, settings: { ...S, ...body }, next: [] });
      if (u.includes('/api/workplan/marks')) return j({ today: TODAY, enabled, marks });
      if (u.includes('/api/workplan/me')) return j(me());
      if (u.includes('/api/workplan/plan/')) {
        st.items = body.items.map((x, k) => { const old = st.items.find((i) => i.id === x.id); return old ? { ...old, title: x.title, sort: k } : { id: nextId++, title: x.title, status: 'open', note: '', carried: false, carry_count: 0, added_late: false }; });
        st.day = { ...st.day, plan_saved_at: st.day.plan_saved_at || '2026-10-08T15:12:00Z', plan_hm: st.day.plan_hm || '09:12' };
        return j({ ok: true, ...me() });
      }
      if (u.includes('/api/workplan/done/')) {
        st.items = st.items.map((i) => { const m = body.items.find((x) => x.id === i.id); return { ...i, status: m ? m.status : 'missed', note: m ? m.note : i.note }; });
        st.day = { ...st.day, done_saved_at: '2026-10-08T23:40:00Z', done_hm: '17:40', extra_done: body.extra_done };
        return j({ ok: true, ...me() });
      }
      if (u.includes('/api/workplan/team')) return j(team || { date: TODAY, today: TODAY, now_min: nowMin, workday: true, settings: S,
        kpi: { members: 2, plan_written: 1, done_written: 0, rate: null, plan_missing: ['Luis'], done_missing: ['Maria', 'Luis'] },
        members: [
          { user_id: 2, name: 'Maria', role: 'sales', day: { ...emptyDay, plan_saved_at: 'x', plan_hm: '09:12' }, items: [{ id: 1, title: '<img src=x onerror=alert(1)>', status: 'open', note: '', carried: true, carry_count: 3, added_late: false }], sum: { total: 1, done: 0, partial: 0, score: 0, rate: 0 } },
          { user_id: 3, name: 'Luis', role: 'sales', day: { ...emptyDay }, items: [], sum: { total: 0, done: 0, partial: 0, score: 0, rate: null } }] });
      if (u.includes('/api/workplan/users/')) return j({ ok: true });
      if (u.includes('/api/workplan/users')) return j({ items: [{ id: 1, name: '관리자', role: 'director', director: true, enabled: false, has_phone: true, phone_masked: '528****0001' }, { id: 2, name: 'Maria', role: 'sales', enabled: true, has_phone: true, phone_masked: '528****5678' }, { id: 3, name: 'Luis', role: 'sales', enabled: true, has_phone: false, phone_masked: null }] });
      if (u.includes('/api/workplan/wa/status')) return j({ wa_ready: true, today: TODAY, next: [], recipients: [], log: [{ kind: 'remind_plan', work_date: TODAY, name: 'Maria', to_masked: '528****5678', status: 'sent_template', error: null, attempts: 1, sent_at: 'x' }] });
      if (u.includes('/api/workplan/wa/send')) return j({ ok: true, results: [{ ok: true }] });
      if (u.includes('/api/workplan/preview')) return j({});
    }
    if (u.includes('/api/calendar')) return j({ items: [] });
    if (u.includes('/api/todos')) return j({ items: [] });
    if (u.includes('/api/journal')) return j({ items: [], dates: [] });
    return j({});
  };
  const confirms = [];
  w.confirm = (m) => { confirms.push(m); return true; };
  w.URL.createObjectURL = () => 'blob:x';
  w.eval(`session={token:'t',user:{id:${director ? 1 : 2},name:'${director ? '관리자' : 'Maria'}'},api:''}; isDirector=${director}; users=[]; teams=[];`);
  w.eval(WPJS);
  w.document.getElementById('app').classList.remove('hidden');
  return { w, calls, st, confirms, $: (id) => w.document.getElementById(id) };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

test('F1 직원 아침: 모달 맨 위 「오늘 할 일」 — 이월 표시·Enter 추가·빼기·저장 PUT·달력 표식', async () => {
  const { w, calls, $ } = boot();
  w.openDay(TODAY); await tick();
  const box = $('wpBox');
  assert.ok(box.querySelector('.wptab.on').textContent.includes('오늘 할 일'), '오전엔 할 일 탭');
  assert.ok($('dmBody').firstElementChild.id === 'wpBox', '모달 맨 위');
  assert.match(box.textContent, /이월/);
  const nw = $('wpBox').querySelector('[data-wpin="new"]'); nw.value = 'SAT 인보이스 3건';
  nw.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  $('wpBox').querySelector('[data-wpin="new"]').value = '지울 것'; click(w, box.querySelector('[data-wp="add"]'));
  assert.equal(box.querySelectorAll('input.wpt').length, 3);
  click(w, box.querySelectorAll('[data-wp="del"]')[2]);
  box.querySelector('input.wpt').value = 'Leal 견적 후속 (전화)';
  click(w, $('wp-savePlan')); await tick();
  const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/plan/2026-10-08'));
  assert.deepEqual(put.body.items, [{ id: 11, title: 'Leal 견적 후속 (전화)' }, { id: null, title: 'SAT 인보이스 3건' }]);
  assert.match($('wp-msg').textContent, /저장했습니다/);
  assert.match($('wpBox').textContent, /09:12 작성/);
  assert.match(w.wpMark(TODAY), /할 일 2/);
  assert.equal(w.wpDirty(), false);
});

test('F2 직원 저녁: 기본 탭 「오늘 한 일」 — 완료→일부→못함 순환·메모·계획 외·미표시=못함', async () => {
  const items = [{ id: 1, title: 'A', status: 'open', note: '', carried: false, carry_count: 0, added_late: false },
    { id: 2, title: 'B', status: 'open', note: '', carried: false, carry_count: 0, added_late: false },
    { id: 3, title: 'C', status: 'open', note: '', carried: false, carry_count: 0, added_late: false }];
  const { w, calls, $ } = boot({ nowMin: 17 * 60, items, day: { ...emptyDay, plan_saved_at: 'x', plan_hm: '09:00' } });
  w.openDay(TODAY); await tick();
  assert.ok($('wpBox').querySelector('.wptab.on').textContent.includes('오늘 한 일'));
  const btn = (id) => $('wpBox').querySelector(`[data-wp="cycle"][data-id="${id}"]`);
  click(w, btn(1));                                  // 완료
  click(w, btn(2)); click(w, btn(2));                // 일부
  assert.equal(btn(1).textContent, '완료'); assert.equal(btn(2).textContent, '일부');
  const note = $('wpBox').querySelector('input[data-wp="note"][data-id="2"]');
  assert.ok(note && /어디까지/.test(note.placeholder)); note.value = '절반';
  $('wpBox').querySelector('[data-wpin="extra"]').value = '반품 검수';
  click(w, $('wp-saveDone')); await tick();
  const put = calls.find((c) => c.url.includes('/done/2026-10-08'));
  assert.deepEqual(put.body.items.map((x) => [x.id, x.status]), [[1, 'done'], [2, 'partial'], [3, 'missed']]);
  assert.equal(put.body.items[1].note, '절반'); assert.equal(put.body.extra_done, '반품 검수');
  assert.match($('wp-msg').textContent, /수고하셨습니다/);
  assert.match(w.wpMark(TODAY), /한 일 1\.5\/3/);
});

test('F3 지난 날짜 이미 작성 → 읽기 전용(입력칸·저장 버튼 없음)', async () => {
  const items = [{ id: 1, title: 'A', status: 'done', note: '끝', carried: false, carry_count: 0, added_late: false }];
  const { w, $ } = boot({ date: '2026-10-07', items, day: { ...emptyDay, plan_saved_at: 'x', plan_hm: '09:00', done_saved_at: 'y', done_hm: '17:50', extra_done: '기타' } });
  w.openDay('2026-10-07'); await tick();
  const box = $('wpBox');
  assert.equal(box.querySelector('#wp-saveDone'), null); assert.equal(box.querySelector('[data-wpin="extra"]'), null);
  assert.ok(box.querySelector('[data-wp="cycle"]').disabled);
  click(w, box.querySelector('[data-tab="plan"]'));
  assert.equal($('wpBox').querySelector('input.wpt'), null); assert.match($('wpBox').textContent, /읽기 전용/);
});

test('F4 디렉터(대상 아님): 입력 칸 없이 「이 날 팀 업무 보기」 → 팀 업무 탭', async () => {
  const { w, calls, $ } = boot({ director: true, enabled: false });
  w.openDay(TODAY); await tick();
  assert.equal($('wpBox').querySelector('.wptabs'), null);
  click(w, $('wpBox').querySelector('[data-wp="team"]')); await tick(20);
  assert.equal($('dayModal').style.display, 'none');
  assert.ok(!$('paneTeam').classList.contains('hidden')); assert.ok($('paneCal').classList.contains('hidden'));
  assert.ok(calls.some((c) => c.url.includes('/api/workplan/team?date=2026-10-08')));
  // XSS: 항목 제목은 글자로만
  assert.equal($('wpTeamBody').querySelector('img'), null);
  assert.match($('wpTeamBody').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match($('wpTeamBody').textContent, /3회 이월/);
  assert.match($('wpTeamBody').textContent, /할 일 미작성 — Luis/);
  // 디렉터 설정 카드
  assert.match($('wpAdmin').textContent, /업무일지 설정/);
});

test('F5 디렉터 설정: 펼치기 → 시각 바꾸고 근무일 토글 → 저장 PUT · 대상 해제 PUT', async () => {
  const { w, calls, $ } = boot({ director: true, enabled: false });
  await tick();   // DOMContentLoaded 후 버튼 바인딩
  click(w, $('wpTeamBtn')); await tick(20);
  click(w, $('wpAdmin').querySelector('[data-wpa="toggle"]'));
  const h = $('wpAdmin').querySelector('select[data-wpk="done_deadline"][data-part="h"]'); h.value = '19';
  click(w, $('wpAdmin').querySelector('[data-wpa="day"][data-d="6"]'));   // 토 끄기
  $('wpAdmin').querySelector('input[data-wpk="remind_template"]').value = 'recordatorio_bitacora';
  click(w, $('wpAdmin').querySelector('input[data-wpa="rcpt"][value="2"]'));
  click(w, $('wpAdmin').querySelector('[data-wpa="save"]')); await tick();
  const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/api/workplan/settings'));
  assert.equal(put.body.done_deadline, '19:00'); assert.deepEqual(put.body.workdays, [1, 2, 3, 4, 5]);
  assert.equal(put.body.remind_template, 'recordatorio_bitacora'); assert.deepEqual(put.body.summary_user_ids, [2]);
  assert.match($('wpa-msg').textContent, /저장했습니다/);
  assert.ok($('wpAdmin').querySelector('input[data-wpa="rcpt"][value="3"]').disabled, '번호 없는 사람은 받는 사람으로 못 고름');
  const tgt = $('wpAdmin').querySelector('input[data-wpa="target"][value="3"]'); tgt.checked = false;
  tgt.dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
  const up = calls.find((c) => c.url.endsWith('/api/workplan/users/3'));
  assert.deepEqual(up.body, { enabled: false });
  assert.match($('wpAdmin').textContent, /sent_template|template/);
});

test('F6 달력 표식 규칙 — 도입일 전·휴일 없음, 지난 근무일 미작성, 할 일만=한 일 미작성', async () => {
  const { w } = boot({ marks: { '2026-10-06': { total: 2, done: 2, partial: 0, plan: true, done_saved: true }, '2026-10-07': { total: 3, done: 0, partial: 0, plan: true, done_saved: false } } });
  await w.wpLoadMarks(new w.Date('2026-09-27T00:00:00'), new w.Date('2026-10-31T00:00:00'));
  assert.match(w.wpMark('2026-10-06'), /✅ 2\/2/);
  assert.match(w.wpMark('2026-10-07'), /한 일 미작성/);
  assert.equal(w.wpMark('2026-10-05'), '', '도입일(10/8) 전 빈 날짜는 표시 안 함');
  assert.equal(w.wpMark(TODAY), '', '오늘 아직 안 썼으면 표시 안 함');
  assert.equal(w.wpMark('2026-10-11'), '', '일요일·미래');
});

test('F7 미저장 보호 — 고치고 닫으면 확인창', async () => {
  const { w, confirms, $ } = boot();
  w.openDay(TODAY); await tick();
  $('wpBox').querySelector('input.wpt').value = '바꿈';
  click(w, $('wpBox').querySelector('[data-tab="done"]'));   // 탭 이동은 입력 보존
  w.closeDay();
  assert.ok(confirms.some((m) => /업무일지/.test(m)));
});

test('F8 마이그레이션 전 503 → 안내만, 달력·일정은 정상', async () => {
  const { w, $ } = boot({ status: 503 });
  w.openDay(TODAY); await tick();
  assert.match($('wpBox').textContent, /npm run migrate/);
  assert.ok($('dmBody').textContent.includes('일정'));
  await w.wpLoadMarks(new w.Date('2026-10-01T00:00:00'), new w.Date('2026-10-31T00:00:00'));
  assert.equal(w.wpMark('2026-10-07'), '');
});
