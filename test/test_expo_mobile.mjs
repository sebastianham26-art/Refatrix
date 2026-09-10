// 🎪 전시회 시간표 — 폰에서 저장 버튼이 안 보이던 문제 (2026-09-10) · Chromium 실렌더 검증
//   값이 아니라 「실제로 눌리는가」를 잰다: 버튼 중앙에서 elementFromPoint 가 그 버튼인지(히트테스트).
//   수정 전 390×844: 신규 [미팅 계획 저장] → 하단 탭바(.mt)가 잡힘 / ✕ → [로그아웃](rlogout)이 잡힘.
//   실행: repo 루트에서  node test/test_expo_mobile.mjs
import { chromium } from 'playwright';

const SUM = { isDirector: false, role: 'sales', name: 'Oscar', pages: ['quote', 'sales', 'customers', 'pipeline'], badges: {} };
const SUM_DIR = { isDirector: true, role: 'director', name: 'Sebastian', pages: [], badges: {} };
const USER = { id: 2, name: 'Oscar', login_id: 'oscar', role: 'sales' };
const USER_DIR = { id: 1, name: 'Sebastian', login_id: 'admin', role: 'director' };
const VPS = [['iPhone SE급', 390, 664], ['iPhone 14급', 390, 844], ['Android', 360, 600], ['소형', 320, 568],
  ['태블릿', 768, 900], ['좁은 PC 창', 1000, 800], ['PC', 1400, 900]];

const hours = (s, e) => Array.from({ length: e - s }, (_, i) => {
  const h = s + i, p = (n) => String(n).padStart(2, '0');
  return { hour: h, label: p(h) + ':00', range: p(h) + ':00–' + p(h + 1) + ':00' };
});
const M1 = { id: 1, day_no: 1, slot_hour: 9, meet_date: '2026-09-16', owner_user_id: 2, owner_name: 'Oscar', customer_id: null,
  company_name: 'Grupo Zeta', contact_name: 'Juan', wa_phone: '81-1234-5678', goal_note: '연간 계약 의향', memo: '',
  target_quote: 850000, target_order: 400000, actual_quote: null, actual_order: null, status: 'planned', is_walkin: false,
  consult_id: null, has_ai: false, created_by: 2, kind: 'meeting', is_confirmed: false };
function makeBoard(meetings) {
  return {
    exhibition: { id: 10, name: 'RUJAC 2026', venue: 'Expo Guadalajara', start_date: '2026-09-16', day_count: 3,
      start_hour: 8, end_hour: 21, currency: 'MXN', is_active: true },
    days: [{ day_no: 1, date: '2026-09-16', label: '1st day', weekday: '수' }, { day_no: 2, date: '2026-09-17', label: '2nd day', weekday: '목' },
      { day_no: 3, date: '2026-09-18', label: '3rd day', weekday: '금' }],
    hours: hours(8, 21), owners: [{ id: 2, name: 'Oscar', bg: '#FBEEDA', fg: '#8A6512', border: '#EBD5A6' }], meetings,
    totals: { total: meetings.length, meeting: meetings.length, booth: 0, confirmed: 0, unconfirmed: meetings.length,
      target_quote: 0, target_order: 0, actual_quote: 0, actual_order: 0, qual: {} },
    owner_totals: [], unset_color: { bg: '#F2F0EA', fg: '#6B6B6B', border: '#DED9CE' },
    booth_color: { bg: '#EDEBE4', fg: '#5B5B57', border: '#D8D3C6' }, now: { day_no: 1, hour: 9 }, is_director: false, me: 2,
  };
}

let pass = 0, fail = 0; const F = [];
const ok = (c, m) => { c ? pass++ : (fail++, F.push(m)); };
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

async function open(w, h, { dir = false } = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: w < 1100, isMobile: w <= 768 });
  const p = await ctx.newPage();
  const st = { meetings: [{ ...M1 }], log: [] };
  await p.route('**/api/**', (r) => {
    const req = r.request(), u = req.url(), m = req.method();
    let body = {};
    if (u.includes('portal/summary')) body = dir ? SUM_DIR : SUM;
    else if (u.includes('/board')) body = makeBoard(st.meetings);
    else if (/\/api\/exhibitions(\?|$)/.test(u) && m === 'GET') body = { items: [{ id: 10, name: 'RUJAC 2026', is_active: true }], active_id: 10 };
    else if (/\/api\/exhibitions\/10\/meetings$/.test(u) && m === 'POST') {
      const d = JSON.parse(req.postData() || '{}'); st.log.push({ m, u, d });
      const nm = { ...M1, ...d, id: 99, meet_date: '2026-09-16', owner_name: 'Oscar', created_by: 2 };
      st.meetings.push(nm); body = { id: 99 };
    } else if (/\/api\/exhibitions\/meetings\/\d+$/.test(u) && m === 'PATCH') {
      const d = JSON.parse(req.postData() || '{}'); st.log.push({ m, u, d });
      const id = Number(u.split('/').pop()); const x = st.meetings.find((q) => q.id === id); if (x) Object.assign(x, d);
      body = { ok: true, id };
    }
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await p.addInitScript(([u]) => {
    sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://x', user: u }));
    localStorage.removeItem('rfx_m');
  }, [dir ? USER_DIR : USER]);
  await p.goto('file://' + process.cwd() + '/refatrix-consult.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1000);
  await p.click('#modeExpo');
  await p.waitForTimeout(500);
  return { ctx, p, st };
}

// 버튼이 화면 안에 있고, 그 중앙을 누르면 정말 그 버튼이 눌리는가
const probe = (p, ids) => p.evaluate((ids) => ids.map((id) => {
  const e = document.getElementById(id); if (!e) return { id, exists: false };
  const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { id, exists: true, inView: r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.width > 0, h: Math.round(r.height),
    hit: !!hit && (hit === e || e.contains(hit)), who: hit ? (hit.id || hit.className || hit.tagName) : 'null' };
}), ids);
const sheetMetrics = (p) => p.evaluate(() => {
  const sh = document.getElementById('ex-sheet'), sb = document.getElementById('ex-shB');
  const nav = document.getElementById('rnav'), r = sh.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), navB: nav ? Math.round(nav.getBoundingClientRect().bottom) : 0,
    pageOvf: document.scrollingElement.scrollWidth - innerWidth, sbOvf: sb.scrollWidth - sb.clientWidth,
    mob: document.documentElement.classList.contains('rfxm') };
});
function check(tag, rs) {
  for (const r of rs) {
    ok(r.exists, `${tag}: #${r.id} 없음`);
    if (!r.exists) continue;
    ok(r.inView, `${tag}: #${r.id} 화면 밖`);
    ok(r.hit, `${tag}: #${r.id} 를 누르면 다른 요소(${r.who})가 눌림`);
    ok(r.h >= 40, `${tag}: #${r.id} 높이 ${r.h}px < 40`);
  }
}

// A. 폭별 — 기존 미팅 상세 · 새 미팅 · (디렉터) 설정 시트의 버튼이 실제로 눌리는가
for (const [vl, w, h] of VPS) {
  const { ctx, p } = await open(w, h);
  await p.evaluate(() => exOpenMeeting(1)); await p.waitForTimeout(w >= 1100 ? 900 : 250);
  check(`${vl} ${w}×${h} 상세`, await probe(p, ['ex-saveBtn', 'ex-confBtn', 'ex-doneBtn', 'ex-delBtn', 'ex-shX']));
  let sm = await sheetMetrics(p);
  ok(sm.pageOvf <= 0, `${vl} 상세: 페이지 가로 넘침 ${sm.pageOvf}px`);
  ok(sm.sbOvf <= 0, `${vl} 상세: 시트 안 가로 넘침 ${sm.sbOvf}px`);
  if (w >= 1100) ok(sm.top >= sm.navB, `${vl} 상세: 오른쪽 패널 윗부분이 고정 헤더 밑으로 들어감(${sm.top} < ${sm.navB})`);
  if (w <= 760) ok(sm.top === 0 && sm.bottom === h, `${vl} 상세: 전체화면 시트가 아님(${sm.top}..${sm.bottom})`);
  await p.evaluate(() => exCloseSheet(true));
  await p.evaluate(() => exOpenNew(1, 20)); await p.waitForTimeout(w >= 1100 ? 900 : 250);
  check(`${vl} ${w}×${h} 신규`, await probe(p, ['ex-nSave', 'ex-nCancel', 'ex-shX']));
  ok(await p.evaluate(() => document.getElementById('ex-nHour').value) === '20', `${vl} 신규: 20:00 칸이 선택되지 않음`);
  sm = await sheetMetrics(p);
  ok(sm.sbOvf <= 0, `${vl} 신규: 시트 안 가로 넘침 ${sm.sbOvf}px`);
  await ctx.close();
}
for (const [vl, w, h] of VPS.filter((v) => v[1] <= 768 || v[1] === 1400)) {
  const { ctx, p } = await open(w, h, { dir: true });
  await p.click('#ex-setBtn'); await p.waitForTimeout(w >= 1100 ? 900 : 250);
  check(`${vl} 설정(디렉터)`, await probe(p, ['ex-sSave', 'ex-sClose', 'ex-shX']));
  ok(await p.evaluate(() => [...document.getElementById('ex-sEh').options].some((o) => o.value === '21')), `${vl} 설정: 종료 21:00 선택지 없음`);
  await ctx.close();
}

// B. 시간표 08:00~21:00 (13칸)
{
  const { ctx, p } = await open(390, 844);
  const d = await p.evaluate(() => { exSetView('day'); const s = [...document.querySelectorAll('.ex-slot .t b')].map((e) => e.textContent);
    return { n: s.length, first: s[0], last: s[s.length - 1], meta: document.getElementById('ex-meta').textContent }; });
  ok(d.n === 13, `하루씩: 슬롯 ${d.n}칸 (13칸이어야 함)`);
  ok(d.first === '08:00' && d.last === '20:00', `하루씩: ${d.first}~${d.last}`);
  ok(d.meta.includes('08:00–21:00'), `헤더 표기: ${d.meta}`);
  const g = await p.evaluate(() => { exSetView('grid'); return document.querySelectorAll('table.ex-tt tbody tr').length; });
  ok(g === 13, `전체: ${g}행 (13행이어야 함)`);
  const lastCell = await p.evaluate(() => { exSetView('day'); const s = [...document.querySelectorAll('.ex-slot')].pop();
    s.scrollIntoView(); const r = s.querySelector('.b').getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20));
    return { ok: !!hit && s.contains(hit), who: hit ? (hit.className || hit.tagName) : 'null' }; });
  ok(lastCell.ok, `하루씩: 마지막 20:00 칸이 하단 탭바에 가려 안 눌림(${lastCell.who})`);
  await ctx.close();
}

// C. 키보드가 올라온 상태(visualViewport 축소) — 저장 버튼이 키보드 위에 남는가
{
  const { ctx, p } = await open(390, 844);
  await p.evaluate(() => exOpenMeeting(1)); await p.waitForTimeout(200);
  const has = await p.evaluate(() => typeof exFitViewport === 'function');
  ok(has, '키보드: 대응 함수(exFitViewport) 없음');
  if (has) {
  await p.evaluate(() => {
    const fake = { height: 430, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
    document.getElementById('ex-fMemo').focus(); exFitViewport();
  });
  const k = await p.evaluate(() => { const sh = document.getElementById('ex-sheet'), r = sh.getBoundingClientRect();
    const sv = document.getElementById('ex-saveBtn').getBoundingClientRect(), sec = sh.querySelector('.ex-sfsec');
    return { kb: sh.classList.contains('kb'), h: Math.round(r.height), saveB: Math.round(sv.bottom), secHidden: getComputedStyle(sec).display === 'none' }; });
  ok(k.kb, '키보드: .kb 모드가 켜지지 않음');
  ok(k.h === 430, `키보드: 시트 높이 ${k.h} ≠ 보이는 영역 430`);
  ok(k.saveB <= 430, `키보드: 저장 버튼 하단 ${k.saveB} > 430 (키보드에 가림)`);
  ok(k.secHidden, '키보드: 보조 버튼이 접히지 않음');
  check('키보드 390×430', await probe(p, ['ex-saveBtn']));
  await p.evaluate(() => { Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => ({ height: innerHeight, width: 390, offsetTop: 0 }) }); exFitViewport(); });
  const r = await p.evaluate(() => { const sh = document.getElementById('ex-sheet'); return { kb: sh.classList.contains('kb'), h: sh.style.height }; });
  ok(!r.kb && r.h === '', '키보드 내림: 원래대로 돌아오지 않음');
  }
  await ctx.close();
}

// D. 폰에서 실제 흐름 — 신규(확정) 저장 → 상세 → 수정 저장 → 확정/완료에 입력값 포함 → 미저장 닫기 확인
//    (p.click 은 버튼이 다른 요소에 가려져 있으면 누르지 못하고 시간초과 — 그 자체가 실패 사유)
{
  const { ctx, p, st } = await open(390, 844);
  p.setDefaultTimeout(4000);
  try {
  await p.evaluate(() => { exSetView('day'); });
  await p.locator('.ex-slot').nth(12).locator('.b').click();            // 20:00 칸 탭
  await p.waitForTimeout(250);
  ok(await p.evaluate(() => document.getElementById('ex-nHour').value) === '20', '흐름: 20:00 칸을 눌렀는데 시간이 다름');
  await p.fill('#ex-nCompany', 'Autopartes del Norte');
  await p.check('#ex-nConfirm');
  ok((await p.textContent('#ex-nSave')).includes('확정 미팅으로 저장'), '흐름: 확정 체크 시 저장 버튼 문구가 안 바뀜');
  ok(await p.evaluate(() => document.getElementById('ex-nSave').classList.contains('dirty')), '흐름: 입력했는데 저장 버튼 강조 없음');
  await p.click('#ex-nSave'); await p.waitForTimeout(400);
  const post = st.log.find((x) => x.m === 'POST');
  ok(post && post.d.is_confirmed === true && post.d.slot_hour === 20, '흐름: 신규 POST 에 확정/20시 누락');
  ok(await p.evaluate(() => !!document.getElementById('ex-saveBtn') && document.getElementById('ex-shT').textContent.includes('Autopartes')), '흐름: 저장 후 상세로 안 넘어감');
  ok((await p.textContent('#ex-saveBtn')).includes('저장됨'), '흐름: 저장 완료 표시(✓ 저장됨) 없음');
  // 수정 저장 — 메모칸까지 스크롤한 위치가 저장 후에도 유지
  await p.evaluate(() => { document.getElementById('ex-shB').scrollTop = 400; });
  await p.fill('#ex-fMemo', '샘플 10종 요청');
  ok((await p.textContent('#ex-saveBtn')).includes('변경 저장'), '흐름: 수정 중인데 「변경 저장」 표시 없음');
  const tb = await p.evaluate(() => { const t = document.getElementById('ex-toast').getBoundingClientRect(); return t.top; });
  await p.click('#ex-saveBtn'); await p.waitForTimeout(400);
  const pat = st.log.filter((x) => x.m === 'PATCH').pop();
  ok(pat && pat.d.memo === '샘플 10종 요청', '흐름: 수정 PATCH 에 메모 누락');
  ok(await p.evaluate(() => !document.getElementById('ex-sheet').classList.contains('ex-hidden')), '흐름: 저장 후 시트가 닫혀버림');
  ok(await p.evaluate(() => document.getElementById('ex-shB').scrollTop) > 100, '흐름: 저장 후 맨 위로 튐');
  const toast = await p.evaluate(() => { const t = document.getElementById('ex-toast').getBoundingClientRect(),
    s = document.getElementById('ex-saveBtn').getBoundingClientRect(); return { on: document.getElementById('ex-toast').classList.contains('on'), overlap: !(t.bottom <= s.top || t.top >= s.bottom) }; });
  ok(toast.on && !toast.overlap, '흐름: 토스트가 안 보이거나 저장 버튼을 가림');
  // 입력 중에 [✓ 약속 확정] / [✅ 미팅 완료] — 입력값이 버려지지 않고 함께 저장
  await p.fill('#ex-fGoal', '보증 조건 합의');
  await p.click('#ex-doneBtn'); await p.waitForTimeout(400);
  const pd = st.log.filter((x) => x.m === 'PATCH').pop();
  ok(pd && pd.d.status === 'done' && pd.d.goal_note === '보증 조건 합의', '흐름: 완료 버튼이 입력 중인 정성목표를 버림');
  // 저장 안 하고 ✕ → 확인창 → 취소하면 그대로, 확인하면 닫힘
  await p.fill('#ex-fMemo', '미저장 메모');
  p.once('dialog', (d) => d.dismiss());
  await p.click('#ex-shX'); await p.waitForTimeout(150);
  ok(await p.evaluate(() => !document.getElementById('ex-sheet').classList.contains('ex-hidden')), '흐름: 미저장 닫기 취소했는데 닫힘');
  ok(await p.inputValue('#ex-fMemo') === '미저장 메모', '흐름: 취소 후 입력값이 사라짐');
  p.once('dialog', (d) => d.accept());
  await p.click('#ex-shX'); await p.waitForTimeout(150);
  ok(await p.evaluate(() => document.getElementById('ex-sheet').classList.contains('ex-hidden')), '흐름: 확인했는데 안 닫힘');
  ok(await p.evaluate(() => !document.documentElement.classList.contains('ex-locked') && !document.documentElement.classList.contains('ex-sheet-open')), '흐름: 닫은 뒤 잠금/상태 클래스가 남음');
  ok(await p.evaluate(() => sessionStorage.getItem('refatrix_session') !== null), '흐름: ✕ 가 로그아웃을 눌렀음');
  } catch (e) { ok(false, '흐름 중단: ' + String(e.message).split('\n').find((l) => /intercepts|Timeout|not/.test(l)) || e.message); }
  await ctx.close();
}

await b.close();
console.log(`\n${pass}/${pass + fail} 통과`);
F.forEach((x) => console.log('  ✗ ' + x));
process.exit(fail ? 1 : 0);
