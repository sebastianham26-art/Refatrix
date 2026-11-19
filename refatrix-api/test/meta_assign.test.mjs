// =====================================================================
// meta_assign.test.mjs — 0329 · Meta 광고 문의 영업사원 배분 · 하루 목표 · 고객별 메모 · 실적
//   A. 손님 말이 마지막인가(자동 응답 · Meta 기록은 답장 아님)
//   B. 실제 서버 + PostgreSQL: 대상자 고르기(클릭) · 목표 · 자동 분배(남은 목표 순 · 답 안 한 것 먼저 · 사내 번호 제외 · 목표 다 차면 멈춤)
//      · 직접 맡김/넘김/풀기 · 내 할당 · 대화함(답장 · 상태 · 📞) · 읽기 권한 담당자의 상태 변경 · 메모 · 실적(사람 · 팀 · 목표 대비) · 권한
//   실행: TEST_PG_URL=postgres://... node --test test/meta_assign.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-meta-assign';
process.env.META_ASSIGN_WORKER = '0';
process.env.META_LEADS_WA_LIVE = '0';

test('A. 손님 말이 마지막인가', async () => {
  const { awaitingReply } = await import('../src/metaAssign.js');
  const at = (m) => new Date(Date.UTC(2026, 10, 19, 15, m)).toISOString();
  assert.equal(awaitingReply([{ at: at(0), me: false, text: 'precio horquilla' }]), true);
  assert.equal(awaitingReply([{ at: at(0), me: false, text: 'hola' }, { at: at(0), me: true, text: 'Meta_0001\nHola, tenemos 10%' }]), true, '60초 안 첫 페이지 메시지 = 자동 응답');
  assert.equal(awaitingReply([{ at: at(0), me: false, text: 'hola' }, { at: at(5), me: true, text: 'Claro, ¿qué año?' }]), false, '사람 답장');
  assert.equal(awaitingReply([{ at: at(0), me: false, text: 'hola' }, { at: at(5), me: true, text: 'Claro' }, { at: at(9), me: false, text: '2018' }]), true);
  assert.equal(awaitingReply([]), false);
});

test('A2. 0330 · 비율(%) — 오늘 받은 수까지 합쳐 비율이 맞게', async () => {
  const { pickByShare } = await import('../src/metaAssign.js');
  const mem = [{ user_id: 1, share_pct: 50 }, { user_id: 2, share_pct: 30 }, { user_id: 3, share_pct: 20 }, { user_id: 4, share_pct: 0 }];
  const cnt = new Map(); let total = 0;
  for (let i = 0; i < 100; i++) { const m = pickByShare(mem, cnt, total); cnt.set(m.user_id, (cnt.get(m.user_id) || 0) + 1); total++; }
  assert.deepEqual([1, 2, 3, 4].map((id) => cnt.get(id) || 0), [50, 30, 20, 0]);
  const c2 = new Map([[1, 10]]);   // 1 번이 오늘 이미 10건 → 나머지가 먼저 받는다
  assert.notEqual(pickByShare(mem, c2, 10).user_id, 1);
  assert.equal(pickByShare([{ user_id: 9, share_pct: 0 }], new Map(), 0), null);
});

test('B. 실제 서버 + PostgreSQL', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  after(async () => { await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });
  const keep = { ...process.env }; process.env.DAILY_SUMMARY_WA_TO = '528119990000';
  t.after(() => { process.env = keep; });
  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready(); t.after(() => app.close());
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  await query(`DELETE FROM meta_lead_notes; DELETE FROM meta_assignments; DELETE FROM meta_assign_members; UPDATE meta_assign_settings SET auto=true, default_target=20, pool_days=7, work_start=8, work_end=19;
               DELETE FROM meta_ad_touches; DELETE FROM meta_threads; DELETE FROM wa_messages WHERE phone LIKE '52811000%';`);
  const SFX = Date.now().toString(36).slice(-5);
  const mk = async (name, role, page) => { const u = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [`${name} ${SFX}`, role, `${name.toLowerCase()}${SFX}`]);
    if (page) await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,$2,'anywhere',$3)`, [u.id, page[0], page[1]]);
    return { id: Number(u.id), h: { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(u.id), role }) } }; };
  const dir = await mk('Dir', 'director');
  const ana = await mk('Ana', 'sales', ['quote', 'view']);      // 견적 화면 보기 권한 → 이 화면 열람
  const beto = await mk('Beto', 'sales', ['sales', 'edit']);
  const ciro = await mk('Ciro', 'sales');                      // 화면 권한 없음
  const call = (u, method, url, payload) => app.inject({ method, url, payload, headers: u.h });
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const th = async (n, { platform = 'messenger', min = 30, status = 'nuevo', answered = false, phone = null, days = 0 } = {}) => {
    const at = ago(min + days * 1440);
    const msgs = [{ at, me: false, text: 'Precio de horquilla ' + n }];
    if (answered) msgs.push({ at: ago(min + days * 1440 - 10), me: true, text: 'Claro, ¿qué año?' });
    const uid = platform === 'whatsapp' ? phone : 'psid' + n;
    return Number((await one(`INSERT INTO meta_threads (platform, thread_id, user_id, name, first_at, last_at, last_in_at, messages, customer_text, in_count, msg_count, status, a_phone)
       VALUES ($1,$2,$3,$4,$5,$5,$5,$6::jsonb,$7,1,$8,$9,$10) RETURNING id`,
      [platform, (platform === 'whatsapp' ? 'wa:' : 't') + uid, uid, 'Cliente ' + n, at, JSON.stringify(msgs), msgs[0].text, msgs.length, status, phone ? phone.slice(-10) : null])).id);
  };
  const T = {};
  for (let i = 1; i <= 6; i++) T[i] = await th(i, { min: 10 * i, answered: i % 2 === 0 });   // 홀수 = 답 기다림
  T.old = await th('old', { days: 10 });                       // 7일 지남 → 안 나눔
  T.done = await th('venta', { status: 'venta' });             // 신규 아님 → 안 나눔
  T.staff = await th('staff', { platform: 'whatsapp', phone: '528119990000' });   // 사내 번호
  T.wa = await th('wa', { platform: 'whatsapp', phone: '528110000077', min: 5 });

  await t.test('B1. 설정 — 대상자 클릭 · 목표 · 권한 표시 · 디렉터만', async () => {
    let c = (await call(dir, 'GET', '/api/meta-assign/config')).json();
    assert.equal(c.ready, true); assert.equal(c.is_admin, true);
    assert.equal(c.users.find((u) => u.id === ana.id).page_ok, true);
    assert.equal(c.users.find((u) => u.id === ciro.id).page_ok, false, '화면 권한 없음 표시');
    assert.equal(c.pool.n, 7, '신규 · 7일 안 · 사내 제외 = 1~6 + wa'); assert.equal(c.pool.waiting, 4);
    const r = await call(dir, 'PUT', '/api/meta-assign/config', { auto: true, default_target: 3, members: [{ user_id: ana.id, daily_target: 3 }, { user_id: beto.id, daily_target: 2 }] });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().members.filter((m) => m.active).map((m) => [m.user_id, m.daily_target]).sort(), [[ana.id, 3], [beto.id, 2]].sort());
    assert.equal((await call(ana, 'PUT', '/api/meta-assign/config', { auto: false })).statusCode, 403);
    assert.equal((await call(ana, 'POST', '/api/meta-assign/run')).statusCode, 403);
    assert.equal((await call(ciro, 'GET', '/api/meta-assign/config')).statusCode, 403, '화면 권한 없으면 못 봄');
    c = (await call(ana, 'GET', '/api/meta-assign/config')).json();
    assert.equal(c.is_admin, false); assert.equal(c.me.member, true); assert.equal(c.users, undefined);
    assert.equal((await call(dir, 'PUT', '/api/meta-assign/config', { work_start: 10, work_end: 9 })).json().error, 'bad_hours');
  });

  await t.test('B2. 자동 분배 — 목표만큼 · 남은 목표 순 · 답 안 한 것 먼저 · 다 차면 멈춤', async () => {
    const r = (await call(dir, 'POST', '/api/meta-assign/run')).json();
    assert.equal(r.assigned, 5, '3 + 2');
    assert.deepEqual(r.by_user, { [ana.id]: 3, [beto.id]: 2 });
    const rows = (await query(`SELECT id, assigned_to FROM meta_threads WHERE assigned_to IS NOT NULL`)).rows.map((x) => Number(x.id));
    for (const id of [T[1], T[3], T[5], T.wa]) assert.ok(rows.includes(id), '답 기다리는 문의 먼저');
    for (const id of [T.old, T.done, T.staff]) assert.ok(!rows.includes(id));
    assert.equal((await one(`SELECT count(*)::int n FROM meta_assignments WHERE how='auto'`)).n, 5);
    const again = (await call(dir, 'POST', '/api/meta-assign/run')).json();
    assert.equal(again.assigned, 0); assert.equal(again.skipped, 'targets_full');
    const { autoDistribute } = await import('../src/metaAssign.js');
    const night = new Date(); night.setUTCHours(9, 0, 0, 0);   // 03:00 멕시코시티
    assert.equal((await autoDistribute({ now: night })).skipped, 'off_hours', '근무 시간 밖에는 자동 안 함');
  });

  await t.test('B3. 내 할당 · 상세 담당 · 직접 넘김/풀기 · 목록 필터', async () => {
    const m = (await call(ana, 'GET', '/api/meta-assign/mine?scope=today')).json();
    assert.equal(m.items.length, 3); assert.equal(m.me.daily_target, 3); assert.equal(m.me.today_assigned, 3);
    assert.ok(m.items.every((x) => x.how === 'auto' && !x.done_at));
    const mine = (await call(ana, 'GET', '/api/meta-leads/list?assignee=__me')).json().items;
    assert.equal(mine.length, 3); assert.ok(mine.every((x) => x.assigned_to === ana.id && /Ana/.test(x.assigned_name)));
    assert.equal((await call(dir, 'GET', '/api/meta-leads/list?assignee=__none')).json().items.length, 5);
    const id = m.items[0].id;
    const d = (await call(ana, 'GET', `/api/meta-leads/${id}`)).json();
    assert.equal(d.assign.assigned_to, ana.id); assert.equal(d.assign.current.how, 'auto');
    // 넘김: Ana → Beto(직접)
    let r = await call(dir, 'POST', `/api/meta-leads/${id}/assign`, { user_id: beto.id });
    assert.equal(r.statusCode, 200); assert.equal(r.json().assign.assigned_to, beto.id); assert.equal(r.json().assign.current.how, 'manual');
    assert.equal((await one(`SELECT count(*)::int n FROM meta_assignments WHERE thread_id=$1 AND ended_at IS NOT NULL`, [id])).n, 1, '앞 할당은 끝');
    assert.equal((await call(ana, 'POST', `/api/meta-leads/${id}/assign`, { user_id: ana.id })).statusCode, 403);
    r = await call(dir, 'POST', `/api/meta-leads/${T.old}/assign`, { user_id: ana.id }); assert.equal(r.statusCode, 200);
    r = await call(dir, 'POST', `/api/meta-leads/${T.old}/assign`, { user_id: null }); assert.equal(r.json().assign.assigned_to, null, '풀기');
    assert.equal((await call(dir, 'POST', `/api/meta-leads/${T.old}/assign`, { user_id: 'x' })).json().error, 'bad_user');
  });

  await t.test('B4. 대화함 — 답장(WhatsApp) · 상태 변경(읽기 권한 담당자) · 📞 전화함 · 남의 것은 못 바꿈', async () => {
    const { refreshDone } = await import('../src/metaAssign.js');
    const ana1 = (await call(ana, 'GET', '/api/meta-assign/mine?scope=open')).json().items;
    assert.equal(ana1.length, 2);
    // WhatsApp 담당 문의에 ERP 답장
    const waA = await one(`SELECT user_id FROM meta_assignments WHERE thread_id=$1 AND ended_at IS NULL`, [T.wa]);
    await query(`INSERT INTO wa_messages (direction, phone, kind, body, source, ok, at) VALUES ('out','528110000077','text','Hola, ¿qué vehículo?','manual',true, now())`);
    await refreshDone();
    const w = await one(`SELECT done_at, done_how FROM meta_assignments WHERE thread_id=$1 AND ended_at IS NULL`, [T.wa]);
    assert.ok(w.done_at); assert.equal(w.done_how, 'reply'); void waA;
    // Ana(견적 보기 권한)가 자기 문의 상태를 「연락함」으로
    const own = ana1.find((x) => x.id !== T.wa) || ana1[0];
    let r = await call(ana, 'PATCH', `/api/meta-leads/${own.id}`, { status: 'contactado', note: 'llamar mañana' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await call(ana, 'PATCH', `/api/meta-leads/${own.id}`, { name: 'X' })).json().error, 'read_only', '담당자도 상태 · 메모만');
    const other = (await call(beto, 'GET', '/api/meta-assign/mine?scope=open')).json().items[0];
    assert.equal((await call(ana, 'PATCH', `/api/meta-leads/${other.id}`, { status: 'contactado' })).json().error, 'read_only', '남의 문의');
    await new Promise((res) => setTimeout(res, 150)); await refreshDone();
    assert.equal((await one(`SELECT done_how FROM meta_assignments WHERE thread_id=$1 AND ended_at IS NULL`, [own.id])).done_how, 'status');
    // Beto 📞 전화함(메모와 함께)
    assert.equal((await call(ana, 'POST', `/api/meta-leads/${other.id}/called`, {})).json().error, 'not_assignee');
    r = await call(beto, 'POST', `/api/meta-leads/${other.id}/called`, { note: 'No contesta, reintentar' });
    assert.equal(r.statusCode, 200); assert.equal(r.json().marked, true); assert.equal(r.json().assign.current.done_how, 'call');
    assert.match(r.json().assign.notes[0].text, /📞 No contesta/);
    assert.equal((await one(`SELECT status FROM meta_threads WHERE id=$1`, [other.id])).status, 'contactado');
  });

  await t.test('B5. 고객별 메모 — 쓰기 · 쓴 사람 · 지우기(본인 · 디렉터)', async () => {
    const id = T[1];
    let r = await call(ana, 'POST', `/api/meta-leads/${id}/notes`, { text: 'Taller en Apodaca, quiere 4 horquillas' });
    assert.equal(r.statusCode, 200); assert.equal(r.json().items.length, 1); assert.match(r.json().items[0].user_name, /Ana/);
    r = await call(beto, 'POST', `/api/meta-leads/${id}/notes`, { text: 'Le mandé la lista de precios' });
    const items = r.json().items; assert.equal(items.length, 2);
    assert.equal((await call(beto, 'DELETE', `/api/meta-leads/${id}/notes/${items[0].id}`)).json().error, 'not_author');
    assert.equal((await call(ana, 'DELETE', `/api/meta-leads/${id}/notes/${items[0].id}`)).json().items.length, 1);
    assert.equal((await call(dir, 'DELETE', `/api/meta-leads/${id}/notes/${items[1].id}`)).json().items.length, 0);
    assert.equal((await call(ana, 'POST', `/api/meta-leads/${id}/notes`, { text: '  ' })).json().error, 'empty');
    const d = (await call(dir, 'GET', `/api/meta-leads/${id}`)).json(); assert.equal(d.assign.notes.length, 0);
  });

  await t.test('B6. 실적 — 사람별 · 팀 · 목표 대비 · 본인만(영업)', async () => {
    const p = (await call(dir, 'GET', '/api/meta-assign/perf')).json();
    assert.equal(p.days, 1);
    const a = p.people.find((x) => x.user_id === ana.id); const b = p.people.find((x) => x.user_id === beto.id);
    assert.equal(a.assigned, 2, '자동 3 중 1 넘김 · 직접 1 풀음 = 2'); assert.equal(a.moved, 2); assert.equal(a.done, 1); assert.equal(a.target, 3); assert.equal(a.rate, 50);
    assert.equal(a.target_rate, 33.3);
    assert.equal(b.done, 2, 'WhatsApp 답장(넘겨받은 것) + 📞');
    assert.equal(b.assigned, 3, '자동 2 + 넘겨받음 1'); assert.equal(b.by_call, 1); assert.equal(b.target, 2);
    assert.equal(p.team.assigned, 5); assert.equal(p.team.target, 5);
    // 넘겨서 빈 자리는 다음 자동 분배에서 채움
    const re = (await call(dir, 'POST', '/api/meta-assign/run')).json(); assert.deepEqual(re.by_user, { [ana.id]: 1 });
    assert.equal(p.team.done, a.done + b.done); assert.equal(p.daily.length, 1);
    const own = (await call(ana, 'GET', `/api/meta-assign/perf?user=${beto.id}`)).json();
    assert.deepEqual(own.people.map((x) => x.user_id), [ana.id], '영업사원은 자기 실적만');
    assert.equal((await call(dir, 'GET', '/api/meta-assign/perf?from=2026-11-20&to=2026-11-01')).json().error, 'bad_range');
    // 대상에서 빼도 실적은 남음
    await call(dir, 'PUT', '/api/meta-assign/config', { members: [{ user_id: ana.id, daily_target: 3 }] });
    const p2 = (await call(dir, 'GET', '/api/meta-assign/perf')).json();
    const b2 = p2.people.find((x) => x.user_id === beto.id); assert.equal(b2.assigned, 3); assert.equal(p2.people.find((x) => x.user_id === ana.id).assigned, 3); assert.equal(b2.member, false); assert.equal(b2.target, null);
  });

  await t.test('B8. 0330 · 비율(%) 방식 — 남김없이 모두 · 비율대로 · 실적 비율 몫', async () => {
    for (let i = 1; i <= 10; i++) await th('s' + i, { min: 3 + i });
    const pool0 = (await call(dir, 'GET', '/api/meta-assign/config')).json().pool.n; assert.ok(pool0 >= 10);
    assert.equal((await call(dir, 'PUT', '/api/meta-assign/config', { mode: 'share', members: [{ user_id: ana.id, daily_target: 3, share_pct: 0 }] })).json().error, 'share_required');
    let r = await call(dir, 'PUT', '/api/meta-assign/config', { mode: 'share', members: [{ user_id: ana.id, daily_target: 3, share_pct: 50 }, { user_id: beto.id, daily_target: 2, share_pct: 50 }] });
    assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().settings.mode, 'share');
    assert.deepEqual(r.json().members.filter((m) => m.active).map((m) => m.share_pct).sort(), [50, 50]);
    const before = new Map((await call(dir, 'GET', '/api/meta-assign/config')).json().members.map((m) => [m.user_id, m.today_assigned]));
    const run = (await call(dir, 'POST', '/api/meta-assign/run')).json();
    assert.equal(run.assigned, pool0, '하루 목표와 관계없이 모두');
    assert.equal((await call(dir, 'GET', '/api/meta-assign/config')).json().pool.n, 0, '남은 문의 0');
    const after = new Map((await call(dir, 'GET', '/api/meta-assign/config')).json().members.map((m) => [m.user_id, m.today_assigned]));
    assert.ok(Math.abs(after.get(ana.id) - after.get(beto.id)) <= 1, '오늘 합계가 50:50');
    void before;
    const p = (await call(dir, 'GET', '/api/meta-assign/perf')).json();
    assert.equal(p.mode, 'share');
    const pa = p.people.find((x) => x.user_id === ana.id); assert.equal(pa.share_pct, 50);
    assert.equal(pa.target, Math.round(p.team.assigned / 2), '비율 몫 = 비율 × 팀 할당');
    // 하루 목표 방식으로 되돌리면 목표 = 하루 목표 × 날 수
    r = await call(dir, 'PUT', '/api/meta-assign/config', { mode: 'target' }); assert.equal(r.json().settings.mode, 'target');
    assert.equal((await call(dir, 'GET', '/api/meta-assign/perf')).json().people.find((x) => x.user_id === ana.id).target, 3);
  });

  await t.test('B7. 1119b · 전체 할당 목록 — 사람 · 대화 상태 · 검색 · 디렉터만', async () => {
    const all = (await call(dir, 'GET', '/api/meta-assign/list')).json().items;
    assert.ok(all.length >= 7);
    assert.ok(all.every((x) => x.user_name && x.day && x.name));
    const moved = (await call(dir, 'GET', '/api/meta-assign/list?state=moved')).json().items;
    assert.ok(moved.length >= 2 && moved.every((x) => x.ended_at && !x.done_at));
    const mv = moved.find((x) => x.id === T.wa); assert.ok(mv); assert.match(mv.now_name, /Beto/, '지금 담당');
    const done = (await call(dir, 'GET', '/api/meta-assign/list?state=done')).json().items;
    assert.ok(done.every((x) => x.done_at && x.mins != null));
    const ab = (await call(dir, 'GET', `/api/meta-assign/list?user=${beto.id}&state=open`)).json().items;
    assert.ok(ab.every((x) => x.user_id === beto.id && !x.done_at && !x.ended_at));
    assert.equal((await call(dir, 'GET', '/api/meta-assign/list?q=Cliente%20wa')).json().items.every((x) => /wa/.test(x.name)), true);
    assert.equal((await call(ana, 'GET', '/api/meta-assign/list')).statusCode, 403);
    assert.equal((await call(dir, 'GET', '/api/meta-assign/list?from=2026-11-20&to=2026-11-01')).json().error, 'bad_range');
  });
});
