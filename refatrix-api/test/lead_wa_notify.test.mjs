// =====================================================================
// 0268 · 웹 카달록 **가입신청** WhatsApp 알림 — 계약/동작 시험
//   실행: TEST_PG_URL=postgres://... node --test test/lead_wa_notify.test.mjs
//
//   디렉터 지시(2026-10-12):
//     ① 가입신청이 접수되면 디렉터(+알림 대상자)에게 ② 담당자를 지정하면 그 담당자에게
//     ③ Meta 템플릿은 디렉터가 직접 만들 수 있게 **가이드**
//
//   A. 순수 규칙 — 문구·수신자·설정
//   B. 실 서버 + PostgreSQL — 수신 훅 · 지정 훅 · 1회 가드 · 재시도 · 번호 없음 · 템플릿 우선
//   C. 화면 — 패널과 템플릿 안내가 서버가 준 값을 그대로 그리는가
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL;
if (!PG) console.log('[skip] TEST_PG_URL 없음 — B 구간 생략');
if (PG) process.env.DATABASE_URL = PG;

const N = await import('../src/leadWaNotify.js');
const SRC = readFileSync(new URL('../src/leadWaNotify.js', import.meta.url), 'utf8');

const LEAD = {
  id: 1, empresa: 'REFACCIONES DEL NORTE', nombre: 'Juan', apellido: 'Pérez',
  telefono: '8112345678', correo: 'juan@norte.mx', rfc: 'RNO950612BB2',
  ciudad: 'Monterrey', estado: 'NL', mensaje: 'Quiero precios', status: 'new',
  assigned_by_name: 'Sebastián',
};

// ── A. 순수 규칙 ─────────────────────────────────────────────────────
test('A1. 템플릿 한 줄(변수 {{1}})에는 줄바꿈이 들어가지 않는다', () => {
  // Meta 는 템플릿 파라미터에 줄바꿈·탭이 있으면 거절한다. 그래서 waParam 을 통과해야 한다.
  for (const kind of ['received', 'assigned']) {
    for (const lang of ['ko', 'es']) {
      const h = N.buildLeadHeadline(LEAD, lang, kind);
      assert.equal(/[\n\t]/.test(h), false, `${kind}/${lang} 에 줄바꿈이 있으면 Meta 가 거절한다`);
      assert.ok(h.includes('REFACCIONES DEL NORTE'), '상호는 반드시 들어가야 한다');
      assert.ok(h.includes('8112345678'), '전화가 없으면 받는 사람이 바로 연락할 수 없다');
    }
  }
});

test('A2. 값이 비어도 터지지 않고, 빈 자리를 지어내지 않는다', () => {
  const bare = { id: 2, status: 'new' };
  const h = N.buildLeadHeadline(bare, 'ko', 'received');
  assert.ok(h.length > 0, 'Meta 는 빈 파라미터를 거절한다 — 무언가는 있어야 한다');
  assert.ok(h.includes('상호 미기재'), '상호가 없으면 없다고 말한다');
  assert.equal(/undefined|null|NaN/.test(h), false);
  assert.equal(/undefined|null/.test(N.buildLeadText(bare, 'es', 'assigned')), false);
});

test('A3. 종류와 언어에 따라 문구가 갈린다', () => {
  assert.ok(N.buildLeadText(LEAD, 'ko', 'received').includes('접수되었습니다'));
  assert.ok(N.buildLeadText(LEAD, 'ko', 'assigned').includes('담당자로 지정'));
  assert.ok(N.buildLeadText(LEAD, 'es', 'received').includes('Nueva solicitud'));
  assert.ok(N.buildLeadText(LEAD, 'es', 'assigned').includes('Se le asignó'));
  // 지정 알림에는 **누가 지정했는지**가 들어간다 — 받는 사람이 되물을 상대를 안다.
  assert.ok(N.buildLeadHeadline(LEAD, 'ko', 'assigned').includes('Sebastián'));
  assert.equal(N.buildLeadHeadline(LEAD, 'ko', 'received').includes('Sebastián'), false,
    '접수 알림에 지정자가 들어가면 아직 없는 사실을 말하는 것이다');
});

test('A4. 닫힌 신청에는 보내지 않는다 — 끝난 일로 사람을 부르지 않는다', () => {
  assert.equal(N.notifiable({ status: 'new' }), true);
  assert.equal(N.notifiable({ status: 'assigned' }), true);
  assert.equal(N.notifiable({ status: 'registered' }), true);
  assert.equal(N.notifiable({ status: 'done' }), false);
  assert.equal(N.notifiable({ status: 'dismissed' }), false);
  assert.equal(N.notifiable(null), false);
});

test('A5. 두 알림을 따로 끌 수 있다', () => {
  const on = { notify_received: true, notify_assigned: true };
  assert.equal(N.kindEnabled(on, 'received'), true);
  assert.equal(N.kindEnabled({ notify_received: false, notify_assigned: true }, 'received'), false);
  assert.equal(N.kindEnabled({ notify_received: false, notify_assigned: true }, 'assigned'), true);
  // 0268 전 배포(테이블 없음)에서는 둘 다 켜진 것으로 본다 — 기존 동작이 기준이다.
  assert.equal(N.kindEnabled({}, 'received'), true);
  assert.equal(N.kindEnabled({}, 'assigned'), true);
});

test('A6. 종류마다 다른 템플릿을 쓴다', () => {
  assert.equal(N.templateFor('received'), N.leadWaTemplate());
  assert.equal(N.templateFor('assigned'), N.leadWaAssignTemplate());
  assert.notEqual(N.leadWaTemplate(), N.leadWaAssignTemplate(),
    '한 템플릿으로 둘을 쓰면 「접수」와 「지정」을 구분할 수 없다');
});

test('A7. 템플릿 우선 — 창이 열렸다고 확신할 때만 자유 문구', () => {
  // 2026-10-08/09 에 두 번 사고가 난 자리다: Meta 는 창 밖 자유 텍스트도 「접수」로 답한 뒤
  //   131047 로 버린다 → 원장엔 성공, 휴대폰엔 미도착. 그래서 공용 sendWaTo 를 쓴다.
  assert.ok(/import \{[^}]*sendWaTo/.test(SRC),
    '공용 발송부(sendWaTo)를 써야 템플릿 우선 규칙이 한 곳에만 있다');
  assert.ok(/windowOpen: ws\.open/.test(SRC), '창 상태를 그대로 넘겨야 한다');
  assert.equal(/sendWaText\(/.test(SRC), false,
    '자유 텍스트를 직접 보내면 템플릿 우선 규칙을 비껴간다');
});

test('A8. 수신자 명단을 새로 만들지 않았다 — 팝업 알림 대상과 같은 곳을 본다', () => {
  assert.ok(/crm_lead_notify_targets/.test(SRC),
    '팝업 알림 대상과 같은 명단이어야 「팝업은 오는데 WhatsApp 은 안 오는 사람」이 안 생긴다');
  assert.ok(/u\.role = 'director' OR/.test(SRC), '디렉터는 설정과 무관하게 항상 받는다');
  assert.ok(/u\.wa_phone/.test(SRC), '번호는 사용자 화면의 wa_phone 을 쓴다');
  assert.equal(/CREATE TABLE/.test(SRC), false, '모듈이 표를 만들면 안 된다(마이그레이션의 일)');
});

// ── B. 실 서버 + PostgreSQL ──────────────────────────────────────────
test('B. 실 서버 + PostgreSQL', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  after(async () => { await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });

  const keep = { ...process.env };
  process.env.WHATSAPP_TOKEN = 't'; process.env.WHATSAPP_PHONE_ID = '1';
  delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN; delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.LEAD_WA_ENABLED;
  t.after(() => { process.env = keep; });

  // 발송 스텁 — 실제 Meta 호출 없이 **무엇이 나갔는지** 기록한다.
  const sent = []; let mode = 'ok'; let seq = 0;
  N.setLeadWaSender(async (a) => {
    sent.push(a);
    if (mode === 'fail') return { ok: false, error: 'boom' };
    return { ok: true, mode: a.windowOpen === true ? 'text' : 'template', message_id: `wamid.L${++seq}` };
  });
  t.after(() => N.setLeadWaSender(null));

  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  t.after(() => app.close());

  const SFX = Date.now().toString(36).slice(-5).toUpperCase();
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  const mk = async (name, role, wa, lang) => Number((await one(
    `INSERT INTO users (name, role, pin_hash, login_id, wa_phone, lang)
     VALUES ($1,$2,'x',$3,$4,$5) RETURNING id`,
    [`LW${SFX}${name}`, role, `lw${SFX}${name}`.toLowerCase(), wa, lang])).id);

  const dir = await mk('Dir', 'director', '8110000001', 'ko');
  const rep = await mk('Rep', 'sales', '8110000002', 'es');
  const noPhone = await mk('NoP', 'sales', null, 'es');
  const D = { authorization: 'Bearer ' + app.jwt.sign({ sub: dir, role: 'director' }) };
  const call = (h, method, url, payload) => app.inject({ method, url, payload, headers: h });

  // 알림 대상자: 번호 없는 사람도 넣는다 — 「번호 없음」이 보이는지 보기 위해.
  await query(`INSERT INTO crm_lead_notify_targets (user_id, added_by) VALUES ($1,$2),($3,$2)
               ON CONFLICT DO NOTHING`, [rep, dir, noPhone]);

  const newLead = async (tag) => Number((await one(
    `INSERT INTO crm_web_leads (crm_lead_code, empresa, nombre, telefono, correo, rfc, ciudad, estado)
     VALUES ($1,$2,'Juan','8112345678','j@n.mx',$3,'Monterrey','NL') RETURNING id`,
    [`LW${SFX}-${tag}`, `LW${SFX} ${tag}`, `LWX99011${tag}A1`])).id);
  const ledger = (id) => query(
    `SELECT kind, user_id, status, attempts, sent_at, error FROM crm_lead_wa_sends
      WHERE lead_id=$1 ORDER BY kind, user_id`, [id]).then((r) => r.rows);

  await t.test('B1. 접수 → 디렉터 + 알림 대상자에게 간다', async () => {
    const id = await newLead('A');
    sent.length = 0;
    const r = await N.notifyLead(id, 'received');
    assert.ok(r.results, JSON.stringify(r));
    const rows = await ledger(id);
    // ⚠ 공용 시험 DB 에는 시드 디렉터·다른 시험이 남긴 대상자가 있다. **내가 만든 세 사람**만 본다
    //   (총 건수로 단정하면 다른 시험이 사람을 하나 추가하는 날 이 시험이 깨진다).
    const byUser = Object.fromEntries(rows.map((x) => [Number(x.user_id), x]));
    for (const u of [dir, rep, noPhone]) assert.ok(byUser[u], `user ${u} 에게 원장 행이 있어야 한다`);
    assert.equal(byUser[dir].status, 'sent_template');
    assert.equal(byUser[rep].status, 'sent_template');
    // 번호가 없는 사람은 **건너뜀**이고, 시도 횟수를 올리지 않는다.
    assert.equal(byUser[noPhone].status, 'skipped');
    assert.equal(Number(byUser[noPhone].attempts), 0,
      '번호를 나중에 채워도 3회를 넘겨 영원히 안 가는 사람이 생기면 안 된다');
    assert.ok(byUser[noPhone].error.includes('wa_phone'), '왜 못 갔는지 원장에 남아야 한다');
  });

  await t.test('B2. 창 상태를 모르면 템플릿으로 — 받는 사람 언어로 문구가 간다', async () => {
    const dirSend = sent.find((x) => String(x.to).endsWith('0000001'));
    const repSend = sent.find((x) => String(x.to).endsWith('0000002'));
    assert.ok(dirSend && repSend);
    assert.equal(dirSend.windowOpen, null, '웹훅 미설정 → 창 상태 모름');
    assert.equal(dirSend.templateName, N.leadWaTemplate());
    assert.ok(dirSend.text.includes('접수되었습니다'), '디렉터(ko) 는 한국어');
    assert.ok(repSend.text.includes('Nueva solicitud'), '영업(es) 는 스페인어');
    assert.equal(/[\n\t]/.test(dirSend.headline), false);
    assert.ok(String(dirSend.to).startsWith('52'), '멕시코 번호로 정규화돼야 한다');
  });

  await t.test('B3. 같은 건을 다시 보내도 두 번 가지 않는다(1회 가드)', async () => {
    const id = await newLead('B');
    await N.notifyLead(id, 'received');
    const before = (await ledger(id)).filter((r) => r.sent_at);
    sent.length = 0;
    await N.notifyLead(id, 'received');
    assert.equal(sent.length, 0, '성공한 건은 다시 발송하지 않는다');
    const after2 = (await ledger(id)).filter((r) => r.sent_at);
    assert.equal(after2.length, before.length);
  });

  await t.test('B4. 실패하면 시도 횟수가 올라가고 상한에서 멈춘다', async () => {
    const id = await newLead('C');
    mode = 'fail';
    for (let i = 0; i < N.MAX_ATTEMPTS + 2; i++) await N.notifyLead(id, 'received');
    mode = 'ok';
    const rows = await ledger(id);
    const r = rows.find((x) => Number(x.user_id) === dir);
    assert.equal(r.status, 'failed');
    assert.equal(Number(r.attempts), N.MAX_ATTEMPTS, '상한을 넘겨 무한히 두드리지 않는다');
    assert.equal(r.sent_at, null);
  });

  await t.test('B5. 담당자 지정 → 그 사람에게만 간다', async () => {
    const id = await newLead('D');
    sent.length = 0;
    const res = await call(D, 'POST', `/api/crm-leads/${id}/assign`, { user_id: rep });
    assert.equal(res.statusCode, 200, res.body);
    // 훅은 응답 뒤 300ms 뒤에 돈다 — 기다렸다가 원장을 본다.
    await new Promise((r) => setTimeout(r, 900));
    const rows = (await ledger(id)).filter((x) => x.kind === 'assigned');
    assert.equal(rows.length, 1, '지정된 한 사람에게만');
    assert.equal(Number(rows[0].user_id), rep);
    assert.equal(rows[0].status, 'sent_template');
    const s = sent.find((x) => x.templateName === N.leadWaAssignTemplate());
    assert.ok(s, '지정 알림은 지정 전용 템플릿을 쓴다');
    assert.ok(s.text.includes('Se le asignó'));
  });

  await t.test('B6. 담당자를 바꾸면 새 사람에게 1통 — 같은 사람에게 다시 지정하면 안 간다', async () => {
    const id = await newLead('E');
    await call(D, 'POST', `/api/crm-leads/${id}/assign`, { user_id: rep });
    await new Promise((r) => setTimeout(r, 900));
    sent.length = 0;
    await call(D, 'POST', `/api/crm-leads/${id}/assign`, { user_id: rep });   // 같은 사람
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(sent.length, 0, '같은 사람에게 두 번 알리지 않는다');
    await call(D, 'POST', `/api/crm-leads/${id}/assign`, { user_id: dir });    // 다른 사람
    await new Promise((r) => setTimeout(r, 900));
    const rows = (await ledger(id)).filter((x) => x.kind === 'assigned');
    assert.equal(rows.length, 2, '새 담당자에게는 새로 1통');
    assert.ok(rows.some((x) => Number(x.user_id) === dir && x.sent_at));
  });

  await t.test('B7. 끄면 안 간다 — 두 토글이 따로 듣는다', async () => {
    await call(D, 'PUT', '/api/crm-lead-wa/settings', { notify_received: false, notify_assigned: true });
    const id = await newLead('F');
    sent.length = 0;
    const r1 = await N.notifyLead(id, 'received');
    assert.equal(r1.skipped, 'kind_off');
    assert.equal(sent.length, 0);
    await query(`UPDATE crm_web_leads SET assigned_to=$1 WHERE id=$2`, [rep, id]);
    const r2 = await N.notifyLead(id, 'assigned');
    assert.ok(r2.results, '담당자 알림은 켜져 있으므로 가야 한다');
    await call(D, 'PUT', '/api/crm-lead-wa/settings', { notify_received: true, notify_assigned: true });
  });

  await t.test('B8. 닫힌 신청에는 보내지 않는다', async () => {
    const id = await newLead('G');
    await query(`UPDATE crm_web_leads SET status='dismissed' WHERE id=$1`, [id]);
    sent.length = 0;
    const r = await N.notifyLead(id, 'received');
    assert.equal(r.skipped, 'not_notifiable');
    assert.equal(sent.length, 0);
  });

  await t.test('B9. 놓친 건 줍기 — 번호를 채우면 밀린 알림이 나간다', async () => {
    const id = await newLead('H');
    await N.notifyLead(id, 'received');     // noPhone 은 skipped
    let rows = await ledger(id);
    assert.equal(rows.find((x) => Number(x.user_id) === noPhone).status, 'skipped');
    await query(`UPDATE users SET wa_phone='8110000003' WHERE id=$1`, [noPhone]);
    sent.length = 0;
    const job = await N.runLeadNotifyJob({});
    assert.ok(job.checked >= 1, JSON.stringify(job));
    rows = await ledger(id);
    const r = rows.find((x) => Number(x.user_id) === noPhone);
    assert.equal(r.status, 'sent_template', '번호를 채우면 다음 점검에서 나간다');
    assert.ok(r.sent_at);
  });

  await t.test('B10. 상태 API — 번호 없는 사람을 숨기지 않는다', async () => {
    await query(`UPDATE users SET wa_phone=NULL WHERE id=$1`, [noPhone]);
    const d = (await call(D, 'GET', '/api/crm-lead-wa/status')).json();
    assert.equal(d.migrated, true);
    assert.equal(d.api_ready, true);
    const ids = d.targets.map((t2) => Number(t2.id));
    assert.ok(ids.includes(dir) && ids.includes(rep) && ids.includes(noPhone));
    const np = d.targets.find((t2) => Number(t2.id) === noPhone);
    assert.equal(np.has_phone, false);
    assert.equal(np.wa_phone_masked, null, '번호가 없으면 가린 번호도 없다');
    assert.ok(d.no_phone_count >= 1, '화면이 숫자로 경고할 수 있어야 한다');
    assert.ok(d.recent.length > 0, '원장이 화면으로 내려가야 한다');
    // 번호 전체가 응답에 실리지 않는다 — 마스킹만.
    assert.equal(/8110000001/.test(JSON.stringify(d)), false, '전체 번호가 새면 안 된다');
  });

  await t.test('B11. 템플릿 가이드 — 실제로 쓰는 이름·언어·변수를 그대로 알려 준다', async () => {
    const g = (await call(D, 'GET', '/api/crm-lead-wa/template-guide')).json();
    assert.equal(g.items.length, 2);
    const [a, b] = g.items;
    assert.equal(a.name, N.leadWaTemplate());
    assert.equal(b.name, N.leadWaAssignTemplate());
    for (const it of g.items) {
      assert.equal(it.language, N.leadWaTemplateLang(), '가이드 언어와 발송 언어가 달라지면 승인돼도 안 간다');
      assert.equal(it.variables, 1);
      assert.ok(it.body.includes('{{1}}'), '본문에 변수 자리가 있어야 한다');
      assert.ok(it.sample && it.sample.length > 10, 'Meta 가 샘플값을 요구한다');
      assert.equal(/[\n\t]/.test(it.sample), false, '샘플에 줄바꿈이 있으면 Meta 가 거절한다');
    }
    assert.ok(/유틸리티|Utility/.test(a.category),
      '마케팅으로 만들면 동의 없는 번호에 못 간다 — 직원 알림은 유틸리티다');
    assert.ok(/마케팅/.test(g.note), '왜 유틸리티여야 하는지 말해 줘야 한다');
  });

  await t.test('B12. 미리보기 · 시험 발송', async () => {
    const pv = (await call(D, 'GET', '/api/crm-lead-wa/preview?kind=received&lang=ko')).json();
    assert.ok(pv.lead_id);
    assert.equal(/[\n\t]/.test(pv.headline), false);
    assert.ok(pv.text.includes('\n'), '자유 문구는 여러 줄이어야 읽힌다');

    sent.length = 0;
    const r = await call(D, 'POST', '/api/crm-lead-wa/send', { lead_id: pv.lead_id, kind: 'received', user_id: dir });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().results.length, 1, '시험은 고른 한 사람에게만');
    assert.equal(sent.length, 1, '이미 보낸 건이라도 force 로 다시 보낸다(사람이 누른 것이므로)');
  });

  await t.test('B13. 디렉터 전용 — 영업사원은 상태도 설정도 못 본다', async () => {
    const R = { authorization: 'Bearer ' + app.jwt.sign({ sub: rep, role: 'sales' }) };
    for (const [m, u] of [['GET', '/api/crm-lead-wa/status'], ['GET', '/api/crm-lead-wa/template-guide'],
                          ['PUT', '/api/crm-lead-wa/settings'], ['POST', '/api/crm-lead-wa/send']]) {
      const res = await call(R, m, u, {});
      assert.ok(res.statusCode === 403 || res.statusCode === 401, `${m} ${u} → ${res.statusCode}`);
    }
  });

  await t.test('B14. 뒷정리 — 공용 시험 DB 를 더럽히지 않는다', async () => {
    // 이 저장소의 시험들은 DB 하나를 공유하고 customer_merge 는 customers 를 통째로 지운다.
    await query(`DELETE FROM crm_lead_wa_sends WHERE lead_id IN (SELECT id FROM crm_web_leads WHERE crm_lead_code LIKE $1)`, [`LW${SFX}-%`]);
    await query(`DELETE FROM crm_web_leads WHERE crm_lead_code LIKE $1`, [`LW${SFX}-%`]);
    await query(`DELETE FROM crm_lead_notify_targets WHERE user_id = ANY($1::bigint[])`, [[rep, noPhone]]);
    await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [[dir, rep, noPhone]]).catch(() => {});
    // 설정 행이 updated_by 로 디렉터를 참조한다 — 지우는 순서가 곧 외래키 순서다.
    await query(`UPDATE crm_lead_wa_settings SET updated_by=NULL WHERE updated_by = ANY($1::bigint[])`,
      [[dir, rep, noPhone]]).catch(() => {});
    await query(`DELETE FROM crm_lead_wa_sends WHERE user_id = ANY($1::bigint[])`, [[dir, rep, noPhone]]);
    await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [[dir, rep, noPhone]]);
    const left = await one(`SELECT count(*)::int AS n FROM crm_web_leads WHERE crm_lead_code LIKE $1`, [`LW${SFX}-%`]);
    assert.equal(Number(left.n), 0);
  });
});

// ── C. 화면 ──────────────────────────────────────────────────────────
test('C1. 패널이 서버가 준 안내를 그대로 그린다 — 본문을 화면에 박아 두지 않았다', () => {
  const js = readFileSync(new URL('../../refatrix-leadwa.js', import.meta.url), 'utf8');
  assert.ok(/\/api\/crm-lead-wa\/template-guide/.test(js), '가이드는 서버에서 받아야 한다');
  // 템플릿 본문을 화면에 복제하면 템플릿을 바꾸는 날 코드와 안내가 갈라진다.
  assert.equal(/nuevo_registro_web|registro_web_asignado/.test(js), false,
    '템플릿 이름을 화면에 하드코딩하면 설정으로 바꿔도 안내가 옛 이름을 말한다');
  assert.equal(/Nueva solicitud del catálogo web/.test(js), false,
    '템플릿 본문도 화면에 박아 두면 안 된다');
  assert.ok(/RefLeadWa\.copy/.test(js), 'Meta 에 붙여 넣을 것은 복사 버튼이 있어야 한다');
  assert.ok(/execCommand\('copy'\)/.test(js), '클립보드 권한이 없는 환경에서도 복사가 되게');
});

test('C2. 번호 없는 사람과 미도착을 화면이 말한다', () => {
  const js = readFileSync(new URL('../../refatrix-leadwa.js', import.meta.url), 'utf8');
  assert.ok(/no_phone_count/.test(js), '번호 없는 사람 수를 경고해야 한다');
  assert.ok(/번호 없음/.test(js));
  assert.ok(/dlv_status/.test(js) && /미도착/.test(js),
    '「보냈다」와 「도착했다」는 다르다 — 웹훅 결과를 보여 줘야 한다');
});

test('C3. 고객 화면이 패널을 디렉터에게만 띄우고 캐시 마커가 맞다', () => {
  const h = readFileSync(new URL('../../refatrix-customers.html', import.meta.url), 'utf8');
  assert.ok(/refatrix-leadwa\.js\?v=/.test(h), '캐시버스터 없이 올리면 옛 파일이 계속 뜬다');
  assert.ok(/RefLeadWa\.render\(\{/.test(h));
  assert.ok(/isDirector:isDirector\(\)/.test(h), '화면도 디렉터에게만 보여야 한다(서버도 막는다)');
  assert.ok(/id="leadWaCard"/.test(h) && /id="leadWaBody"/.test(h));
  assert.match(h, /<title>[^<]*tx-1012leadwa\)?<\/title>/, '빌드 토큰');
});

test('C4. 템플릿 이름을 외부 서비스 키 화면에서 바꿀 수 있다', () => {
  const s = readFileSync(new URL('../src/secrets.js', import.meta.url), 'utf8');
  for (const k of ['LEAD_WA_TEMPLATE', 'LEAD_WA_ASSIGN_TEMPLATE', 'LEAD_WA_TEMPLATE_LANG']) {
    assert.ok(s.includes(k), `${k} 가 키 목록에 없으면 Meta 승인 이름이 달라도 고칠 수 없다`);
  }
});

test('C5. 훅이 두 자리에 들어갔다 — 접수와 담당자 지정', () => {
  const r = readFileSync(new URL('../src/routes/crmLeadRoutes.js', import.meta.url), 'utf8');
  assert.ok(/kickLeadNotify\(row\.id, 'received', app\)/.test(r), '수신 INSERT 직후');
  assert.ok(/kickLeadNotify\(id, 'assigned', app\)/.test(r), '담당자 지정 성공 직후');
  // 상대(CRM)가 보낸 요청을 우리 알림 때문에 실패시키면 상대는 같은 신청을 다시 보낸다.
  assert.equal(/await kickLeadNotify/.test(r), false, '기다리면 상대 응답이 느려진다');
});
