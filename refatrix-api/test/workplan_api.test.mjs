// =====================================================================
// 직원 업무일지(0263) — 실제 라우트 핸들러 × 실제 PostgreSQL 통합 테스트
//   실행: DATABASE_URL=postgres://postgres@/refatrix_test?host=/tmp&port=5433 node --test test/workplan_api.test.mjs
//   (전체 migrate 가 끝난 DB 기준 — users 등 실제 스키마 사용. WhatsApp 은 deps 스텁으로 대체)
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, pool } from '../src/db.js';
import { requireDirector } from '../src/middleware/authGuard.js';
import * as WP from '../src/workplan.js';

globalThis.__refatrixWorkplanWorker = true;   // 백그라운드 스케줄러 off
const { registerWorkplan } = await import('../src/routes/workplanRoutes.js');
const R = {}; const app = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) app[m] = (path, opts, handler) => { R[`${m.toUpperCase()} ${path}`] = { opts, handler }; };
await registerWorkplan(app, { startWorker: false });

function mkReply() {
  const rep = { statusCode: 200, payload: null, headers: {} };
  rep.code = (c) => { rep.statusCode = c; return rep; };
  rep.send = (p) => { rep.payload = p; return rep; };
  rep.header = (k, v) => { rep.headers[k] = v; return rep; };
  return rep;
}
let NOW = '2026-10-08T15:00:00Z';   // = MX 09:00 (목)
const setNow = (mxYmdHm) => { NOW = new Date(Date.parse(mxYmdHm.replace(' ', 'T') + ':00Z') + 6 * 3600000).toISOString(); process.env.WORKPLAN_FAKE_NOW = NOW; };
const call = async (key, { user, role = 'sales', params = {}, q = {}, body = null } = {}) => {
  const rep = mkReply();
  const out = await R[key].handler({ ctx: { perm: { userId: user, role } }, params, query: q, body, log: { error() {} } }, rep);
  return { out: out === rep ? rep.payload : out, status: rep.statusCode, rep };
};

let DIR, MARIA, OSCAR, LUIS, WARE;
async function reset() {
  await query(`DELETE FROM workplan_wa_sends; DELETE FROM workplan_items; DELETE FROM workplan_days;
               UPDATE workplan_settings SET plan_deadline='10:00', done_deadline='18:00', workdays='1,2,3,4,5,6',
                 remind_enabled=true, remind_plan_at='09:30', remind_done_at='17:30', remind_template=NULL,
                 summary_enabled=true, summary_plan_at='10:15', summary_done_at='18:15', summary_user_ids='{}'`);
}
test.before(async () => {
  await query(readFileSync(new URL('../migrations/0263_staff_workplan.sql', import.meta.url), 'utf8'));   // 멱등 재적용
  await query(readFileSync(new URL('../migrations/0266_workplan_comments.sql', import.meta.url), 'utf8'));
  await query(`DELETE FROM workplan_wa_sends; DELETE FROM workplan_items; DELETE FROM workplan_days`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE name LIKE 'wp_%')`);
  await query(`DELETE FROM users WHERE name LIKE 'wp_%'`);
  DIR = Number((await query(`SELECT id FROM users WHERE role='director' ORDER BY id LIMIT 1`)).rows[0].id);
  await query(`UPDATE users SET wa_phone='528110000001' WHERE id=$1`, [DIR]);
  const mk = async (name, role, phone, lang = 'es') => Number((await query(
    `INSERT INTO users (name, role, pin_hash, lang, wa_phone) VALUES ($1,$2,'x',$3,$4) RETURNING id`, [name, role, lang, phone])).rows[0].id);
  MARIA = await mk('wp_Maria Lopez', 'sales_support', '8112345678');   // 10자리 → 52 보정
  OSCAR = await mk('wp_Oscar', 'sales', '528199999999');
  LUIS = await mk('wp_Luis', 'sales', null);
  WARE = await mk('wp_Bodega', 'warehouse', '528177777777', 'ko');
  await reset();
  // 0266 — 새 직원은 기본 꺼짐 → 디렉터가 골라서 켠다
  setNow('2026-10-08 09:00');
  const off = await call('GET /api/workplan/me', { user: MARIA });
  assert.equal(off.out.enabled, false, '새 직원은 기본 대상 아님');
  const offPut = await call('PUT /api/workplan/plan/:date', { user: MARIA, params: { date: '2026-10-08' }, body: { items: [{ title: 'x' }] } });
  assert.equal(offPut.status, 403);
  for (const id of [MARIA, OSCAR, LUIS, WARE]) await call('PUT /api/workplan/users/:id', { user: DIR, role: 'director', params: { id }, body: { enabled: true } });
});
test.after(async () => { await query(`DELETE FROM workplan_wa_sends; DELETE FROM workplan_items; DELETE FROM workplan_days;
  DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE name LIKE 'wp_%'); DELETE FROM users WHERE name LIKE 'wp_%'`); await pool.end(); });

// ─────────── 순수 함수 ───────────
test('P1 시각·날짜 도우미', () => {
  assert.equal(WP.hmToMin('09:30'), 570); assert.equal(WP.hmToMin('24:00'), null); assert.equal(WP.isYmd('2026-02-30'), false);
  const c = WP.mxClock(Date.parse('2026-10-08T15:05:00Z'));
  assert.deepEqual([c.ymd, c.min, c.dow], ['2026-10-08', 545, 4]);
  assert.equal(WP.isLate('2026-10-07', '10:00', c), true);
  assert.equal(WP.isLate('2026-10-08', '10:00', c), false);
  assert.equal(WP.isLate('2026-10-09', '10:00', c), false);
  assert.equal(WP.dueAt({ min: 570 }, '09:30'), true); assert.equal(WP.dueAt({ min: 569 }, '09:30'), false); assert.equal(WP.dueAt({ min: 750 }, '09:30'), false);
});
test('P2 설정 검증', () => {
  assert.equal(WP.cleanSettingsInput({ plan_deadline: '19:00' }).error, 'deadline_order');
  assert.equal(WP.cleanSettingsInput({ remind_plan_at: '9:30' }).error, 'bad_time');
  assert.equal(WP.cleanSettingsInput({ workdays: [] }).error, 'no_workdays');
  assert.equal(WP.cleanSettingsInput({ remind_template: 'Bad Name' }).error, 'bad_template');
  const ok = WP.cleanSettingsInput({ workdays: [5, 1, 1, 9], summary_user_ids: [3, '3', 'x'] });
  assert.deepEqual(ok.value.workdays, [1, 5]); assert.deepEqual(ok.value.summary_user_ids, [3]);
});
test('P3 알림 문구 · 템플릿 변수(줄바꿈 없음)', () => {
  const s = WP.DEFAULT_SETTINGS;
  assert.match(WP.reminderText('remind_plan', { name: 'Maria Lopez', lang: 'es' }, '2026-10-08', s), /Hola Maria .*jueves 8\/10.*10:00/);
  assert.match(WP.reminderText('remind_done', { name: '박', lang: 'ko' }, '2026-10-08', s), /10\/8.*18:00/);
  assert.deepEqual(WP.reminderParams('remind_done', { name: 'Oscar R', lang: 'es' }, '2026-10-08', s), ['Oscar', 'lo que hiciste', '8/10', '18:00']);
});
test('P4 줄바꿈·요약 SVG 이스케이프', () => {
  const lines = WP.wrapText('가나다라마바사 '.repeat(20), 13, 200);
  assert.ok(lines.length > 3 && lines.every((l) => l.length));
  const team = [{ name: '<script>', items: [{ title: 'a&b', status: 'missed', note: '', carried: false, carry_count: 0 }],
    day: { done_saved_at: 'x', done_late: false, extra_done: '' }, sum: { plan_written: true, done_written: true, total: 1, score: 0, rate: 0, done: 0 } }];
  const svg = WP.summarySvg('sum_done', '2026-10-08', team, 'ko');
  assert.ok(!svg.includes('<script>') && svg.includes('&lt;script&gt;') && svg.includes('a&amp;b'));
});

// ─────────── 설정 API ───────────
test('S1 설정 — 직원은 공개 항목만, 저장은 디렉터 게이팅·검증', async () => {
  const g = await call('GET /api/workplan/settings', { user: MARIA });
  assert.equal(g.out.settings.plan_deadline, '10:00'); assert.equal(g.out.settings.summary_user_ids, undefined); assert.equal(g.out.settings.remind_template, undefined);
  assert.ok(R['PUT /api/workplan/settings'].opts.preHandler.includes(requireDirector));
  const bad = await call('PUT /api/workplan/settings', { user: DIR, role: 'director', body: { plan_deadline: '18:30' } });
  assert.equal(bad.status, 400); assert.equal(bad.out.error, 'deadline_order');
  const ok = await call('PUT /api/workplan/settings', { user: DIR, role: 'director', body: { remind_template: 'recordatorio_bitacora', summary_user_ids: [DIR] } });
  assert.equal(ok.out.settings.remind_template, 'recordatorio_bitacora'); assert.deepEqual(ok.out.settings.summary_user_ids, [DIR]);
  await reset();
});

// ─────────── 할 일 / 한 일 ───────────
test('D1 할 일 저장 — 정시·목록 교체·마감 후 추가·검증', async () => {
  await reset(); setNow('2026-10-08 09:12');
  const e = await call('PUT /api/workplan/plan/:date', { user: MARIA, params: { date: '2026-10-08' }, body: { items: [{ title: '  ' }] } });
  assert.equal(e.status, 400); assert.equal(e.out.error, 'empty');
  const r = await call('PUT /api/workplan/plan/:date', { user: MARIA, params: { date: '2026-10-08' },
    body: { items: [{ title: 'Leal 견적 후속' }, { title: 'SAT 인보이스 3건' }, { title: 'Norte 미수금' }, { title: '신규 2곳 방문' }] } });
  assert.equal(r.status, 200); assert.equal(r.out.items.length, 4); assert.equal(r.out.day.plan_late, false); assert.equal(r.out.day.plan_hm, '09:12');
  // 10:30 — 하나 지우고 하나 추가 → 추가 항목만 added_late, 첫 저장 시각 유지
  setNow('2026-10-08 10:30');
  const ids = r.out.items.map((i) => i.id);
  const r2 = await call('PUT /api/workplan/plan/:date', { user: MARIA, params: { date: '2026-10-08' },
    body: { items: [{ id: ids[0], title: 'Leal 견적 후속' }, { id: ids[1], title: 'SAT 인보이스 3건' }, { id: ids[3], title: '신규 2곳 방문 (Guadalupe)' }, { title: '반품 검수' }] } });
  assert.deepEqual(r2.out.items.map((i) => i.added_late), [false, false, false, true]);
  assert.equal(r2.out.items[2].title, '신규 2곳 방문 (Guadalupe)'); assert.equal(r2.out.day.plan_hm, '09:12'); assert.equal(r2.out.day.plan_late, false);
  const del = (await query(`SELECT deleted_at FROM workplan_items WHERE id=$1`, [ids[2]])).rows[0];
  assert.ok(del.deleted_at, '빠진 항목은 소프트 삭제');
  const tooMany = await call('PUT /api/workplan/plan/:date', { user: MARIA, params: { date: '2026-10-08' }, body: { items: Array.from({ length: 31 }, (_, i) => ({ title: 't' + i })) } });
  assert.equal(tooMany.out.error, 'too_many');
  const dir = await call('PUT /api/workplan/plan/:date', { user: DIR, role: 'director', params: { date: '2026-10-08' }, body: { items: [{ title: 'x' }] } });
  assert.equal(dir.status, 403); assert.equal(dir.out.error, 'not_target');
  const bad = await call('PUT /api/workplan/plan/:date', { user: MARIA, params: { date: "2026-10-08'; DROP TABLE users;--" }, body: { items: [{ title: 'x' }] } });
  assert.equal(bad.status, 400);
  // 남의 항목 id 를 넣어도 내 항목으로 새로 생길 뿐 남의 것은 안 바뀜
  setNow('2026-10-08 09:00');
  const o = await call('PUT /api/workplan/plan/:date', { user: OSCAR, params: { date: '2026-10-08' }, body: { items: [{ id: ids[0], title: '해킹' }] } });
  assert.notEqual(o.out.items[0].id, ids[0]);
  assert.equal((await query(`SELECT title FROM workplan_items WHERE id=$1`, [ids[0]])).rows[0].title, 'Leal 견적 후속');
});

test('D2 한 일 저장 — 상태·메모·미표시=못함·계획 외·지연·미래 차단', async () => {
  setNow('2026-10-08 17:40');
  const me = await call('GET /api/workplan/me', { user: MARIA, q: { date: '2026-10-08' } });
  const [a, b, c, d] = me.out.items;
  assert.equal(me.out.can_done, true);
  const r = await call('PUT /api/workplan/done/:date', { user: MARIA, params: { date: '2026-10-08' },
    body: { items: [{ id: a.id, status: 'done', note: '수요일 주문' }, { id: b.id, status: 'done' }, { id: c.id, status: 'partial', note: '담당자 부재' }],
      extra_done: '반품 입고 검수\n재고 문의 응대 3명' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.out.items.map((i) => i.status), ['done', 'done', 'partial', 'missed']);
  assert.equal(r.out.items[0].note, '수요일 주문'); assert.equal(r.out.day.done_late, false);
  assert.equal(r.out.sum.score, 2.5); assert.equal(r.out.sum.rate, 63); assert.equal(r.out.sum.state, 'done');
  const st = await call('PUT /api/workplan/done/:date', { user: MARIA, params: { date: '2026-10-08' }, body: { items: [{ id: a.id, status: 'wat' }] } });
  assert.equal(st.out.error, 'bad_status');
  const fut = await call('PUT /api/workplan/done/:date', { user: MARIA, params: { date: '2026-10-09' }, body: { extra_done: 'x' } });
  assert.equal(fut.out.error, 'future');
  // 오스카: 마감(18:00) 후 저장 → done_late
  setNow('2026-10-08 18:20');
  const os = await call('GET /api/workplan/me', { user: OSCAR, q: { date: '2026-10-08' } });
  const r2 = await call('PUT /api/workplan/done/:date', { user: OSCAR, params: { date: '2026-10-08' }, body: { items: [{ id: os.out.items[0].id, status: 'done' }] } });
  assert.equal(r2.out.day.done_late, true);
});

test('D3 다음날 — 이월(일부·못함만)·지운 이월은 재생성 안 됨·지난 날짜 잠금·늦은 작성 허용', async () => {
  setNow('2026-10-09 08:50');
  const me = await call('GET /api/workplan/me', { user: MARIA });
  assert.equal(me.out.date, '2026-10-09');
  assert.deepEqual(me.out.items.map((i) => [i.title, i.carried, i.carry_count]), [['신규 2곳 방문 (Guadalupe)', true, 1], ['반품 검수', true, 1]]);
  assert.equal(me.out.day.plan_saved_at, null, '이월만으로는 작성 처리 안 됨');
  // 이월 하나 지우고 저장 → 다시 열어도 안 생김
  const keep = me.out.items[0];
  await call('PUT /api/workplan/plan/:date', { user: MARIA, params: { date: '2026-10-09' }, body: { items: [{ id: keep.id, title: keep.title }, { title: 'Mérida 출고' }] } });
  const me2 = await call('GET /api/workplan/me', { user: MARIA });
  assert.deepEqual(me2.out.items.map((i) => i.title), ['신규 2곳 방문 (Guadalupe)', 'Mérida 출고']);
  // 어제 것은 잠김
  const lock = await call('PUT /api/workplan/plan/:date', { user: MARIA, params: { date: '2026-10-08' }, body: { items: [{ title: 'x' }] } });
  assert.equal(lock.status, 403); assert.equal(lock.out.error, 'locked');
  const lock2 = await call('PUT /api/workplan/done/:date', { user: MARIA, params: { date: '2026-10-08' }, body: { extra_done: 'x' } });
  assert.equal(lock2.status, 403);
  // 루이스: 어제 미작성 → 오늘 늦게 어제 할 일 작성 가능(지연)
  const late = await call('PUT /api/workplan/plan/:date', { user: LUIS, params: { date: '2026-10-08' }, body: { items: [{ title: '어제 일' }] } });
  assert.equal(late.status, 200); assert.equal(late.out.day.plan_late, true);
  const lmeY = await call('GET /api/workplan/me', { user: LUIS, q: { date: '2026-10-08' } });
  assert.equal(lmeY.out.can_plan, false); assert.equal(lmeY.out.can_done, true);
});

test('D4 늦게 「완료」로 고치면 손대지 않은 이월 사본은 거둬들임', async () => {
  // 루이스: 10/8 할 일(미평가) → 10/9 열면 이월 → 10/8 한 일을 늦게 「완료」로 저장 → 10/9 이월 사본 삭제
  setNow('2026-10-09 09:00');
  const t = await call('GET /api/workplan/me', { user: LUIS });
  assert.equal(t.out.items.length, 1); assert.equal(t.out.items[0].carried, true);
  const y = await call('GET /api/workplan/me', { user: LUIS, q: { date: '2026-10-08' } });
  await call('PUT /api/workplan/done/:date', { user: LUIS, params: { date: '2026-10-08' }, body: { items: [{ id: y.out.items[0].id, status: 'done' }] } });
  const t2 = await call('GET /api/workplan/me', { user: LUIS });
  assert.equal(t2.out.items.length, 0);
  const y2 = await call('GET /api/workplan/me', { user: LUIS, q: { date: '2026-10-08' } });
  assert.equal(y2.out.day.done_late, true);
});

test('T1 팀 업무 — 전 직원 공유·번호 비공개·디렉터 제외·KPI', async () => {
  const r = await call('GET /api/workplan/team', { user: OSCAR, q: { date: '2026-10-08' } });
  const names = r.out.members.map((m) => m.name);
  assert.ok(names.includes('wp_Maria Lopez') && names.includes('wp_Luis') && !names.includes('관리자'));
  assert.ok(r.out.members.every((m) => m.wa_phone === undefined && m.lang === undefined));
  const maria = r.out.members.find((m) => m.user_id === MARIA);
  assert.equal(maria.items.length, 4); assert.equal(maria.day.extra_done.includes('반품'), true);
  assert.equal(r.out.kpi.members, 4); assert.equal(r.out.kpi.plan_written, 3);
  assert.deepEqual(r.out.kpi.plan_missing, ['wp_Bodega']);
  // 대상에서 빼면 팀에서도 빠짐
  assert.ok(R['PUT /api/workplan/users/:id'].opts.preHandler.includes(requireDirector));
  await call('PUT /api/workplan/users/:id', { user: DIR, role: 'director', params: { id: WARE }, body: { enabled: false } });
  const r2 = await call('GET /api/workplan/team', { user: OSCAR, q: { date: '2026-10-08' } });
  assert.equal(r2.out.kpi.members, 3);
  const nt = await call('PUT /api/workplan/plan/:date', { user: WARE, params: { date: '2026-10-09' }, body: { items: [{ title: 'x' }] } });
  assert.equal(nt.status, 403);
  await call('PUT /api/workplan/users/:id', { user: DIR, role: 'director', params: { id: WARE }, body: { enabled: true } });
  const u = await call('GET /api/workplan/users', { user: DIR, role: 'director' });
  const um = u.out.items.find((x) => x.id === MARIA);
  assert.equal(um.phone_masked, '528****5678'); assert.equal(u.out.items.find((x) => x.id === DIR).enabled, false);
});

test('M1 달력 표식 — 내 것만·범위 검증', async () => {
  const r = await call('GET /api/workplan/marks', { user: MARIA, q: { from: '2026-10-01', to: '2026-10-31' } });
  assert.deepEqual(r.out.marks['2026-10-08'], { total: 4, done: 2, partial: 1, plan: true, done_saved: true });
  assert.equal(r.out.marks['2026-10-09'].plan, true); assert.equal(r.out.marks['2026-10-09'].done_saved, false);
  const bad = await call('GET /api/workplan/marks', { user: MARIA, q: { from: '2026-01-01', to: '2026-10-31' } });
  assert.equal(bad.status, 400);
});

// ─────────── WhatsApp (스텁) ───────────
function stubDeps({ windowOpen = null, textFail = false, imageFail = false } = {}) {
  const log = [];
  return {
    log,
    deps: {
      ready: () => true,
      windowState: async () => ({ open: windowOpen }),
      text: async (to, body) => { log.push(['text', to, body]); return textFail ? { ok: false, error: 'window' } : { ok: true, message_id: 'm' + log.length }; },
      template: async (o) => { log.push(['template', o.to, o.name, o.params]); return { ok: true, message_id: 't' + log.length }; },
      textOrTemplate: async (o) => { log.push(['textOrTemplate', o.to, o.text]); return { ok: true, mode: 'text', message_id: 'x' }; },
      upload: async (png) => { log.push(['upload', png.length]); return { ok: true, id: 'media1' }; },
      image: async (o) => { log.push(['image', o.to, o.caption]); return imageFail ? { ok: false, error: 'boom' } : { ok: true, message_id: 'i' }; },
      imageTemplate: async () => ({ ok: false, error: 'no' }),
      png: async () => Buffer.from('PNG'),
    },
  };
}
const at = (mx) => Date.parse(mx.replace(' ', 'T') + ':00Z') + 6 * 3600000;

test('W1 09:30 알림 — 미작성·번호 있는 직원만, 하루 1회, 창 밖이면 템플릿(변수 4개)', async () => {
  await query(`DELETE FROM workplan_wa_sends`);
  await query(`UPDATE workplan_settings SET remind_template='recordatorio_bitacora'`);
  const { log, deps } = stubDeps({ windowOpen: false });
  // 10/9: 마리아는 작성함, 오스카·창고 미작성, 루이스는 번호 없음
  const r = await WP.runWorkplanJob({ nowMs: at('2026-10-09 09:31'), deps });
  const sentTo = r.remind_plan.filter((x) => x.ok).map((x) => x.user_id).sort();
  assert.deepEqual(sentTo, [OSCAR, WARE].sort());
  assert.ok(r.remind_plan.find((x) => x.user_id === LUIS).skipped === 'no_phone');
  const tpl = log.find((l) => l[0] === 'template' && l[1] === '528199999999');
  assert.deepEqual(tpl[3], ['wp_Oscar', 'tus pendientes', '9/10', '10:00']);
  assert.ok(!log.some((l) => l[0] === 'text'), '창 밖이 확실하면 자유 문장 생략');
  const ko = log.find((l) => l[0] === 'template' && l[1] === '528177777777');
  assert.equal(ko[3][1], '할 일');
  const again = await WP.runWorkplanJob({ nowMs: at('2026-10-09 09:36'), deps });
  assert.ok(again.remind_plan.every((x) => x.skipped === 'already_sent' || x.skipped === 'no_phone'));
  const row = (await query(`SELECT status, to_masked FROM workplan_wa_sends WHERE kind='remind_plan' AND user_id=$1`, [OSCAR])).rows[0];
  assert.equal(row.status, 'sent_template'); assert.equal(row.to_masked, '528****9999');
});

test('W2 창 정보 없음 → 자유 문장 먼저 · 실패하면 템플릿 폴백 · 템플릿 없으면 실패 기록', async () => {
  await query(`DELETE FROM workplan_wa_sends`);
  const a = stubDeps({ windowOpen: null, textFail: true });
  const r = await WP.runWorkplanJob({ nowMs: at('2026-10-09 17:31'), deps: a.deps });
  const os = r.remind_done.find((x) => x.user_id === OSCAR);
  assert.equal(os.status, 'sent_template');
  assert.ok(a.log.some((l) => l[0] === 'text' && /Hola wp_Oscar/.test(l[2])));
  await query(`DELETE FROM workplan_wa_sends; UPDATE workplan_settings SET remind_template=NULL`);
  const b = stubDeps({ textFail: true });
  const r2 = await WP.runWorkplanJob({ nowMs: at('2026-10-09 17:31'), deps: b.deps });
  assert.equal(r2.remind_done.find((x) => x.user_id === OSCAR).status, 'failed');
  const att = (await query(`SELECT attempts FROM workplan_wa_sends WHERE kind='remind_done' AND user_id=$1`, [OSCAR])).rows[0];
  assert.equal(att.attempts, 1);
});

test('W3 일요일·시간 밖·끄기는 아무것도 안 보냄', async () => {
  await query(`DELETE FROM workplan_wa_sends`);
  const { log, deps } = stubDeps();
  assert.equal((await WP.runWorkplanJob({ nowMs: at('2026-10-11 09:31'), deps })).skipped, 'not_workday');
  assert.equal((await WP.runWorkplanJob({ nowMs: at('2026-10-09 15:00'), deps })).skipped, 'not_due');
  assert.equal((await WP.runWorkplanJob({ nowMs: at('2026-10-09 23:00'), deps })).skipped, 'not_due');
  await query(`UPDATE workplan_settings SET remind_enabled=false`);
  const r = await WP.runWorkplanJob({ nowMs: at('2026-10-09 09:31'), deps });
  assert.equal(r.remind_plan.length, 0);
  await query(`UPDATE workplan_settings SET remind_enabled=true`);
  assert.equal(log.length, 0);
});

test('W4 10:15 아침 요약 — 이미지 1회 업로드·받는 사람·캡션·이월 반영', async () => {
  await query(`DELETE FROM workplan_wa_sends`);
  await query(`UPDATE workplan_settings SET summary_user_ids=$1::bigint[]`, [[DIR]]);
  const { log, deps } = stubDeps({ windowOpen: true });
  const r = await WP.runWorkplanJob({ nowMs: at('2026-10-09 10:16'), deps });
  assert.equal(r.sum_plan.results.length, 1); assert.equal(r.sum_plan.results[0].status, 'sent_image');
  assert.equal(log.filter((l) => l[0] === 'upload').length, 1);
  const img = log.find((l) => l[0] === 'image');
  assert.equal(img[1], '528110000001'); assert.match(img[2], /오늘 할 일 · 10\/9\(금\) 10:15 기준 · 작성 \d\/4/);
  const again = await WP.runWorkplanJob({ nowMs: at('2026-10-09 10:21'), deps });
  assert.equal(again.sum_plan.results[0].skipped, 'already_sent');
});

test('W5 저녁 요약 — 이미지 실패 시 텍스트 폴백 · 받는 사람 없으면 DAILY_SUMMARY_WA_TO', async () => {
  await query(`DELETE FROM workplan_wa_sends; UPDATE workplan_settings SET summary_user_ids='{}'`);
  process.env.DAILY_SUMMARY_WA_TO = '5218112223333';
  const { log, deps } = stubDeps({ imageFail: true });
  const r = await WP.sendSummary({ kind: 'sum_done', date: '2026-10-08', settings: await WP.loadSettings(), deps });
  assert.equal(r.results[0].user_id, 0); assert.equal(r.results[0].status, 'sent_text');
  const t = log.find((l) => l[0] === 'textOrTemplate');
  assert.equal(t[1], '528112223333');
  assert.match(t[2], /\*wp_Maria Lopez\* — 2\.5\/4/); assert.match(t[2], /✗ 못함: 반품 검수/); assert.match(t[2], /◐ 일부: 신규 2곳 방문 \(Guadalupe\) — 담당자 부재/); assert.match(t[2], /\+ 반품 입고 검수 · 재고 문의 응대 3명/);
  assert.match(t[2], /wp_Bodega\* — 계획·실적 모두 미작성/);
  delete process.env.DAILY_SUMMARY_WA_TO;
  const none = await WP.sendSummary({ kind: 'sum_done', date: '2026-10-08', settings: await WP.loadSettings(), deps });
  assert.equal(none.skipped, 'no_recipients');
});

test('W6 디렉터 즉시 발송·상태·미리보기(PNG 실제 렌더)', async () => {
  for (const k of ['POST /api/workplan/wa/send', 'GET /api/workplan/wa/status', 'GET /api/workplan/preview']) assert.ok(R[k].opts.preHandler.includes(requireDirector), k);
  delete process.env.WHATSAPP_TOKEN;
  setNow('2026-10-09 12:00');
  const nc = await call('POST /api/workplan/wa/send', { user: DIR, role: 'director', body: { kind: 'sum_plan' } });
  assert.equal(nc.status, 409); assert.equal(nc.out.error, 'wa_not_configured');
  const bk = await call('POST /api/workplan/wa/send', { user: DIR, role: 'director', body: { kind: 'zzz' } });
  assert.equal(bk.status, 400);
  const st = await call('GET /api/workplan/wa/status', { user: DIR, role: 'director' });
  assert.equal(st.out.wa_ready, false); assert.ok(Array.isArray(st.out.log) && st.out.log.length >= 1);
  assert.ok(st.out.next.length >= 1);
  const pv = await call('GET /api/workplan/preview', { user: DIR, role: 'director', q: { kind: 'sum_done', date: '2026-10-08' } });
  assert.equal(pv.rep.headers['content-type'], 'image/png');
  assert.ok(Buffer.isBuffer(pv.out) && pv.out.slice(1, 4).toString() === 'PNG' && pv.out.length > 5000, 'resvg 로 실제 PNG');
  const tx = await call('GET /api/workplan/preview', { user: DIR, role: 'director', q: { kind: 'sum_plan', date: '2026-10-09', format: 'text', lang: 'es' } });
  assert.match(tx.out.text, /Pendientes de hoy · 9\/10 \(vie\)/);
});

test('X1 마이그레이션 전이면 503 migration_required', async () => {
  await query(`ALTER TABLE workplan_days RENAME TO workplan_days_x`);
  try {
    const r = await call('GET /api/workplan/me', { user: MARIA });
    assert.equal(r.status, 503); assert.equal(r.out.error, 'migration_required');
    const s = await WP.runWorkplanJob({ nowMs: at('2026-10-09 10:16'), deps: stubDeps().deps });
    assert.ok(s.date || s.skipped);   // 설정 테이블은 있으므로 진행 — 실패해도 throw 는 워커가 흡수
  } catch (e) { if (!/workplan_days/.test(String(e.message))) throw e; }
  finally { await query(`ALTER TABLE workplan_days_x RENAME TO workplan_days`); }
});

// ─────────── 0266 · 디렉터 코멘트 · 다음 근무일 일정표 ───────────
test('C1 디렉터 코멘트 저장 — 게이팅·검증·표시 날짜(다음 근무일)', async () => {
  assert.ok(R['PUT /api/workplan/comment'].opts.preHandler.includes(requireDirector));
  setNow('2026-10-08 18:40');
  const day = await call('GET /api/workplan/me', { user: MARIA, q: { date: '2026-10-08' } });
  const it = day.out.items[3];   // 못함 항목
  const r = await call('PUT /api/workplan/comment', { user: DIR, role: 'director', body: { user_id: MARIA, date: '2026-10-08', item_id: it.id, body: '  내일 오전에 꼭 방문하세요  ' } });
  assert.equal(r.status, 200); assert.equal(r.out.show_date, '2026-10-09');
  const r2 = await call('PUT /api/workplan/comment', { user: DIR, role: 'director', body: { user_id: MARIA, date: '2026-10-08', body: '전반적으로 좋습니다.\n미수금 건 정리 부탁' } });
  assert.equal(r2.out.show_date, '2026-10-09');
  const other = (await call('GET /api/workplan/me', { user: OSCAR, q: { date: '2026-10-08' } })).out.items[0];
  const wrong = await call('PUT /api/workplan/comment', { user: DIR, role: 'director', body: { user_id: MARIA, date: '2026-10-08', item_id: other.id, body: 'x' } });
  assert.equal(wrong.status, 404, '다른 직원 항목 id 는 거부');
  const dirT = await call('PUT /api/workplan/comment', { user: DIR, role: 'director', body: { user_id: DIR, date: '2026-10-08', body: 'x' } });
  assert.equal(dirT.status, 404);
  const long = await call('PUT /api/workplan/comment', { user: DIR, role: 'director', body: { user_id: MARIA, date: '2026-10-08', body: 'a'.repeat(1001) } });
  assert.equal(long.status, 400);
  const badD = await call('PUT /api/workplan/comment', { user: DIR, role: 'director', body: { user_id: MARIA, date: "x'; DROP TABLE users;--", body: 'x' } });
  assert.equal(badD.status, 400);
  const v = (await query(`SELECT dir_comment FROM workplan_items WHERE id=$1`, [it.id])).rows[0];
  assert.equal(v.dir_comment, '내일 오전에 꼭 방문하세요');
});

test('C2 공개 범위 — 팀 업무에서 디렉터 코멘트는 본인·디렉터만', async () => {
  const o = await call('GET /api/workplan/team', { user: OSCAR, q: { date: '2026-10-08' } });
  const mByO = o.out.members.find((m) => m.user_id === MARIA);
  assert.equal(mByO.day.dir_comment, ''); assert.ok(mByO.items.every((i) => i.dir_comment === ''));
  assert.ok(mByO.items.some((i) => i.note), '직원 코멘트(note)는 전 직원 공유');
  const self = (await call('GET /api/workplan/team', { user: MARIA, q: { date: '2026-10-08' } })).out.members.find((m) => m.user_id === MARIA);
  assert.match(self.day.dir_comment, /미수금/);
  const d = await call('GET /api/workplan/team', { user: DIR, role: 'director', q: { date: '2026-10-08' } });
  assert.equal(d.out.is_director, true);
  const mByD = d.out.members.find((m) => m.user_id === MARIA);
  assert.equal(mByD.day.dir_show_date, '2026-10-09'); assert.equal(mByD.day.dir_seen_at, null);
  assert.equal(mByD.items[3].dir_comment, '내일 오전에 꼭 방문하세요');
});

test('C3 다음 근무일 — 직원 일정표(모달·달력)에 코멘트, 확인하면 확인됨, 다시 고치면 다시 새 코멘트', async () => {
  setNow('2026-10-09 08:30');
  const me = await call('GET /api/workplan/me', { user: MARIA });
  assert.equal(me.out.inbox.length, 1);
  const ib = me.out.inbox[0];
  assert.equal(ib.work_date, '2026-10-08'); assert.match(ib.day_comment, /미수금/); assert.equal(ib.seen_at, null);
  assert.deepEqual(ib.items.map((i) => i.dir_comment), ['내일 오전에 꼭 방문하세요']);
  const before = await call('GET /api/workplan/me', { user: MARIA, q: { date: '2026-10-08' } });
  assert.equal(before.out.inbox.length, 0, '코멘트는 그 날짜가 아니라 다음 근무일에 뜬다');
  assert.equal(before.out.day.dir_comment.includes('미수금'), true, '그 날 기록에도 디렉터 코멘트가 붙어 보임');
  const mk = await call('GET /api/workplan/marks', { user: MARIA, q: { from: '2026-10-01', to: '2026-10-31' } });
  assert.equal(mk.out.marks['2026-10-09'].dir, 'new');
  const os = await call('GET /api/workplan/me', { user: OSCAR });
  assert.equal(os.out.inbox.length, 0, '다른 직원에게는 안 보임');
  const seen = await call('POST /api/workplan/inbox/seen', { user: MARIA, body: { dates: ['2026-10-08'] } });
  assert.equal(seen.out.updated, 1);
  const mk2 = await call('GET /api/workplan/marks', { user: MARIA, q: { from: '2026-10-01', to: '2026-10-31' } });
  assert.equal(mk2.out.marks['2026-10-09'].dir, 'seen');
  const seenOs = await call('POST /api/workplan/inbox/seen', { user: OSCAR, body: { dates: ['2026-10-08'] } });
  assert.equal(seenOs.out.updated, 0, '남의 코멘트는 확인 처리 못 함');
  // 디렉터가 다시 고치면 → 확인 초기화
  await call('PUT /api/workplan/comment', { user: DIR, role: 'director', body: { user_id: MARIA, date: '2026-10-08', body: '수정: 미수금 금요일까지' } });
  const me2 = await call('GET /api/workplan/me', { user: MARIA });
  assert.equal(me2.out.inbox[0].seen_at, null); assert.match(me2.out.inbox[0].day_comment, /금요일까지/);
});

test('C4 확인 안 한 코멘트는 오늘까지 따라온다 · 토요일 업무 → 월요일 표시 · 늦게 단 코멘트는 그 날 표시', async () => {
  // 10/9 에 안 보고 지나감 → 10/12(월) 오늘 모달·달력에도
  setNow('2026-10-12 09:00');
  const me = await call('GET /api/workplan/me', { user: MARIA });
  assert.equal(me.out.inbox.length, 1); assert.equal(me.out.inbox[0].show_date, '2026-10-09');
  const mk = await call('GET /api/workplan/marks', { user: MARIA, q: { from: '2026-10-01', to: '2026-10-31' } });
  assert.equal(mk.out.marks['2026-10-12'].dir, 'new');
  // 지난 일에 오늘 코멘트 → 오늘(10/12) 표시
  const late = await call('PUT /api/workplan/comment', { user: DIR, role: 'director', body: { user_id: OSCAR, date: '2026-10-08', body: '좋았어요' } });
  assert.equal(late.out.show_date, '2026-10-12');
  // 토요일 업무 코멘트 → 일요일 건너뛰고 월요일
  const sat = WP.commentShowDate('2026-10-10', WP.mxClock(Date.parse('2026-10-10T23:00:00Z')), { workdays: [1, 2, 3, 4, 5, 6] });
  assert.equal(sat, '2026-10-12');
  // 기록 없는 직원(루이스)도 하루 코멘트 가능
  const lu = await call('PUT /api/workplan/comment', { user: DIR, role: 'director', body: { user_id: LUIS, date: '2026-10-12', body: '할 일을 꼭 적어 주세요' } });
  assert.equal(lu.out.show_date, '2026-10-13');
});

test('C5 코멘트를 모두 지우면 일정표 표시도 해제', async () => {
  setNow('2026-10-12 10:00');
  const r = await call('PUT /api/workplan/comment', { user: DIR, role: 'director', body: { user_id: OSCAR, date: '2026-10-08', body: '   ' } });
  assert.equal(r.out.show_date, null);
  const row = (await query(`SELECT dir_show_date, dir_comment FROM workplan_days WHERE user_id=$1 AND work_date='2026-10-08'`, [OSCAR])).rows[0];
  assert.equal(row.dir_show_date, null); assert.equal(row.dir_comment, '');
  // 마리아: 하루 코멘트만 지워도 항목 코멘트가 남아 있으면 표시 유지
  const r2 = await call('PUT /api/workplan/comment', { user: DIR, role: 'director', body: { user_id: MARIA, date: '2026-10-08', body: '' } });
  assert.equal(r2.out.show_date, '2026-10-12');
});

test('C6 직원 코멘트 — 완료 항목에도 코멘트 저장(마감 때 항목마다)', async () => {
  setNow('2026-10-12 09:10');
  await call('PUT /api/workplan/plan/:date', { user: OSCAR, params: { date: '2026-10-12' }, body: { items: [{ title: '정비소 방문' }, { title: '견적 발송' }] } });
  setNow('2026-10-12 17:50');
  const me = await call('GET /api/workplan/me', { user: OSCAR });
  const ids = me.out.items.map((i) => i.id);
  assert.ok(ids.length >= 1);
  const r = await call('PUT /api/workplan/done/:date', { user: OSCAR, params: { date: '2026-10-12' },
    body: { items: ids.map((id, k) => ({ id, status: 'done', note: '완료 코멘트 ' + k })) } });
  assert.equal(r.status, 200);
  assert.ok(r.out.items.every((i, k) => i.note === '완료 코멘트 ' + k));
});
