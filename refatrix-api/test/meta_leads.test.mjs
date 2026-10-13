// =====================================================================
// meta_leads.test.mjs — 제품·마케팅 › Meta 광고 문의 가져오기 (0270 · 2026-10-12)
//   A. 추출 규칙(실제 문의 문장) — 업종 · 지역 · 전화 · 차종 · 부품 · 광고 버튼 · 우리 번호 제외
//   B. 실제 서버 + PostgreSQL(TEST_PG_URL) + Graph 가짜 응답: 가져오기(페이지 넘김 · Messenger/Instagram) ·
//      고객/우리 메시지 구분 · 사람이 고친 값 유지 · 증분 가져오기 · 권한 · 다시 추출
//   C. 화면(jsdom): 상태 · 목록 · 한 건 열기 · 저장 · 엑셀 시트
//   실행: TEST_PG_URL=postgres://... node --test test/meta_leads.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-meta-leads';
const X = await import('../src/metaLeadExtract.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('A1. 실제 문의 문장 — 업종 · 지역(주/도시) · 차종+연식 · 부품', () => {
  let e = X.extractLead('tengo un versa 2024 soy taxista quiero precios de diferentes partes de suspensión\nvivo en Jiutepec Morelos\nLo más frecuente serían orquíllas, soportes de motor,cacahuates,bieletas y terminales');
  assert.equal(e.tipo, 'Taxi / app'); assert.equal(e.state, 'Morelos'); assert.equal(e.city, 'Jiutepec'); assert.equal(e.vehicles, 'Nissan Versa 2024');
  for (const p of ['Horquilla (brazo de control)', 'Soporte de motor / transmisión', 'Buje / cacahuate', 'Bieleta / tornillo estabilizador', 'Terminal']) assert.ok(e.parts.includes(p), p);
  assert.equal(e.intent, 'Precio');
  e = X.extractLead('Solo venden de mayoreo? Donde puedo conseguir sus refacciones en Guadalajara? Necesito horquillas para un versa 2018');
  assert.equal(e.tipo, null, '「¿solo mayoreo?」 질문은 업종이 아니다'); assert.equal(e.state, 'Jalisco'); assert.equal(e.city, 'Guadalajara');
  assert.match(e.intent, /Dónde comprar/);
  e = X.extractLead('Soy de Monclova \nEn el Estado de Coahuila'); assert.equal(e.state, 'Coahuila'); assert.equal(e.city, 'Monclova');
  e = X.extractLead('soy mecánico tengo taller en apodaca, ocupo rotulas para march 2015 y sentra 2019, mi cel 81-8765-4321');
  assert.equal(e.tipo, 'Taller mecánico'); assert.equal(e.state, 'Nuevo León'); assert.equal(e.phone, '8187654321');
  assert.equal(e.vehicles, 'Nissan Sentra 2019; Nissan March 2015', '다음 차의 연식을 끌어오지 않는다'); assert.equal(e.parts, 'Rótula');
  assert.equal(X.extractLead('Nissan kics2024 necesito horquillas').vehicles, 'Nissan Kicks 2024', '붙여 쓴 연식');
  assert.equal(X.extractLead('Majenan horquillas Sentra 2917\n2017').vehicles, 'Nissan Sentra 2017', '다음 줄 연식');
  assert.equal(X.extractLead('Sentra 2013-2019 terminal').vehicles, 'Nissan Sentra 2013-2019');
  e = X.extractLead('para un versa 2022\namortiguadores \nbases de amortiguadores \nprecio\nparticular');
  assert.equal(e.tipo, 'Particular'); assert.equal(e.parts, 'Amortiguador; Base de amortiguador');
  assert.equal(X.extractLead('bases de amortiguador para aveo').parts, 'Base de amortiguador', '받침만 말하면 쇼바는 아니다');
  e = X.extractLead('Orquillas para Verza 20217 torniyos de barra estabilizadora terminales exterior y interior.');
  assert.ok(e.parts.includes('Terminal exterior') && e.parts.includes('Terminal interior') && e.parts.includes('Bieleta / tornillo estabilizador'));
  assert.ok(!e.parts.includes('Barra estabilizadora'));
  assert.equal(X.extractLead('de guadalupe nl').state, 'Nuevo León');
  assert.equal(X.extractLead('Jose Guadalupe necesita horquillas').state, null, '애매한 이름은 en/de 뒤에만');
});

test('A2. 광고 버튼 문구 — 「de MTY」는 지역이 아니고, 업종은 버튼값으로만 · 우리 번호 · 연식 나열은 전화 아님', () => {
  let e = X.extractLead('Soy Particular de MTY, quiero comprar producto CTR como equipo Origina\nen puebla');
  assert.equal(e.tipo, null); assert.equal(e.tipo_btn, 'Particular'); assert.equal(e.state, 'Puebla');
  e = X.extractLead('Soy Refaccionaria de MTY, quiero comprar producto CTR como equipo Origina\nSoy Taller mecánico de MTY, quiero comprar producto CTR como equipo Original');
  assert.equal(e.state, null, '버튼의 MTY 는 지역으로 쓰지 않는다'); assert.equal(e.tipo_btn, 'Refaccionaria / Taller mecánico'); assert.equal(e.wrote, false);
  e = X.extractLead('¿Cómo puedo cotizar o hacer una compra?'); assert.equal(e.intent, 'Precio'); assert.equal(e.wrote, false);
  assert.equal(X.extractLead('escribí al 81 1825 0003 y no contestan').phone, null, '우리 WhatsApp 번호');
  assert.equal(X.extractLead('modelos 2015 2016 2017 2018').phone, null);
  assert.equal(X.extractLead('+52 1 55 1234 5678').phone, '5512345678');
  assert.equal(X.extractLead('mi correo juan.perez@gmail.com').email, 'juan.perez@gmail.com');
  assert.ok(X.META_STATES.length === 32);
});

// ── C. 화면 ──
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* skip */ }
const HTML = path.join(ROOT, 'refatrix-metaleads.html');
test('C. 화면 (jsdom)', { skip: (!JSDOM || !existsSync(HTML)) && 'jsdom 또는 HTML 없음' }, async (t) => {
  const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const ITEMS = [
    { id: 1, platform: 'messenger', name: 'Antonio Lopez', last_mx: '2026-10-12 10:00', first_mx: '2026-10-11', tipo: 'Taxi / app', tipo_btn: null, state: 'Morelos', city: 'Jiutepec', phone: '7771234567', vehicles: 'Nissan Versa 2024', parts: 'Horquilla (brazo de control); Bieleta / tornillo estabilizador', intent: 'Precio', customer_text: 'tengo un versa 2024\nvivo en Jiutepec', status: 'nuevo', edited: false },
    { id: 2, platform: 'instagram', name: null, username: 'taller.garza', last_mx: '2026-10-12 09:00', tipo: null, tipo_btn: 'Refaccionaria', state: 'Morelos', city: null, phone: null, vehicles: 'Nissan Versa 2018; Chevrolet Aveo 2016', parts: 'Horquilla (brazo de control)', customer_text: 'x', status: 'derivado', derived_to: 'Refacc. X', edited: true },
    { id: 3, platform: 'messenger', name: 'Sin datos', last_mx: '2026-10-11 09:00', tipo: null, state: null, parts: null, vehicles: null, customer_text: '', status: 'nuevo' },
  ];
  const calls = []; let written = null;
  const dom = new JSDOM(readFileSync(HTML, 'utf-8').replace(/<script src="https:\/\/cdn[^>]+><\/script>/, ''), {
    runScripts: 'dangerously', url: 'https://example.test/refatrix-metaleads.html',
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 'T', api: 'https://api.test', user: { name: 'U', role: 'director' } }));
      w.confirm = () => true; w.alert = () => {};
      w.XLSX = { utils: { aoa_to_sheet: (a) => ({ __aoa: a }), encode_cell: () => 'A1', encode_range: () => 'A1:B2', book_new: () => ({ sheets: [] }),
        book_append_sheet: (wb, ws, name) => wb.sheets.push([name, ws.__aoa]) }, writeFile: (wb, name) => { written = { wb, name }; } };
      w.fetch = async (url, opt = {}) => {
        const u = String(url); const method = opt.method || 'GET'; const body = opt.body ? JSON.parse(opt.body) : null; calls.push({ u, method, body });
        const json = (d, s = 200) => ({ ok: s < 400, status: s, json: async () => d });
        if (u.includes('/api/meta-leads/status')) return json({ configured: true, migrated: true, token_source: 'META_PAGE_TOKEN', page_id: '1', page: { name: 'CTR', ig_username: 'ctrmexico_' },
          counts: { total: 3, messenger: 2, instagram: 1, demand: 2, with_state: 2, with_phone: 1, nuevo: 2 }, last_run: { ok: true, threads: 3, inserted: 3, finished_at: '2026-10-12T16:00:00Z' }, last_ok_at: '2026-10-12T16:00:00Z', auto: true,
          states: ['Jalisco', 'Morelos', 'Nuevo León'] });
        if (u.includes('/api/meta-leads/list')) return json({ items: ITEMS });
        if (u.includes('/api/meta-leads/sync')) return json({ started: true });
        if (/\/api\/meta-leads\/1$/.test(u) && method === 'GET') return json({ ...ITEMS[0], meta_name: 'Antonio Lopez', a_state: 'Morelos', a_city: 'Jiutepec', a_phone: '7771234567', a_vehicles: 'Nissan Versa 2024', a_parts: 'Horquilla', a_tipo: 'Taxi / app',
          messages: [{ at: '2026-10-12T15:00:00Z', me: true, text: 'Hola' }, { at: '2026-10-12T15:01:00Z', me: false, text: 'tengo un versa' }] });
        if (/\/api\/meta-leads\/1$/.test(u) && method === 'PATCH') return json({ ...ITEMS[0], status: body.status, derived_to: body.derived_to, edited: true });   // 서버는 빈 칸을 자동값으로 돌려준다
        return json({});
      };
    },
  });
  const w = dom.window, d = w.document;
  await new Promise((r) => (d.readyState === 'complete' ? r() : w.addEventListener('load', r))); await tick(400);
  t.after(() => w.close());

  await t.test('C1. 상태 · 목록 · 빌드 토큰', async () => {
    assert.match(d.title, /mtl-1013b/);
    assert.match(d.getElementById('sPage').textContent, /CTR.*@ctrmexico_/);
    assert.match(d.getElementById('sKpis').textContent, /전체 문의3/);
    assert.equal(d.querySelectorAll('#lTable tbody tr').length, 3);
    assert.match(d.getElementById('lTable').textContent, /Refaccionaria \(버튼\)/, '버튼으로만 고른 업종 표시');
    assert.equal(d.getElementById('sGuide').classList.contains('hidden'), true, '정상이면 안내 숨김');
    assert.equal(d.querySelectorAll('#fState option').length, 5);
  });
  await t.test('C2. 한 건 열기 · 저장(PATCH 본문)', async () => {
    d.querySelector('#lTable tr[data-id="1"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await tick(200);
    assert.ok(d.getElementById('mOne').classList.contains('on'));
    assert.equal(d.querySelectorAll('#oChat .bub').length, 2); assert.ok(d.querySelector('#oChat .bub.me'));
    assert.match(d.getElementById('eVeh').placeholder, /자동: Nissan Versa 2024/);
    d.getElementById('eStatus').value = 'derivado'; d.getElementById('eDerived').value = 'Refacc. Cuernavaca';
    d.getElementById('eSave').click(); await tick(200);
    const p = calls.filter((c) => c.method === 'PATCH').pop();
    assert.equal(p.body.status, 'derivado'); assert.equal(p.body.derived_to, 'Refacc. Cuernavaca'); assert.equal(p.body.state, '', '안 고친 칸은 빈 값(=자동값)');
  });
  await t.test('C3. 가져오기 버튼 · 엑셀 5개 시트 · 요약', async () => {
    d.getElementById('bSync').click(); await tick();
    assert.ok(calls.some((c) => c.u.includes('/api/meta-leads/sync') && c.method === 'POST' && c.body.full === false));
    d.getElementById('bXls').click(); await tick();
    assert.ok(written && /refatrix_meta_consultas_\d{4}-\d{2}-\d{2}\.xlsx/.test(written.name));
    assert.deepEqual([...written.wb.sheets.map((s) => s[0])], ['Contactos', 'Oportunidades por estado', 'Por estado', 'Por vehículo', 'Por pieza']);
    const contacts = written.wb.sheets[0][1]; assert.equal(contacts.length, 4); assert.equal(contacts[1][2], 'Antonio Lopez'); assert.equal(contacts[2][2], 'taller.garza');
    const opp = written.wb.sheets[1][1]; assert.equal(opp[1][0], 'Morelos'); assert.equal(opp[1][1], 2);
    assert.match(opp[1][3], /Nissan Versa \(2\)/, '연식을 뗀 모델로 묶는다');
    const veh = written.wb.sheets[3][1]; assert.deepEqual([...veh[1]], ['Nissan Versa', 2]);
    d.querySelector('#tabs .tab[data-p="sum"]').click(); await tick();
    assert.match(d.getElementById('sumOpp').textContent, /Morelos/);
  });
  await t.test('C4. 새 코드에 인라인 onclick 없음 · 메뉴 등록', () => {
    const h = readFileSync(HTML, 'utf-8'); assert.ok(!/onclick=/.test(h));
    const nav = readFileSync(path.join(ROOT, 'refatrix-nav.js'), 'utf-8');
    assert.ok(nav.includes("metaleads:{file:'refatrix-metaleads.html'") && nav.includes("metaleads:['products','marketing','pricemaster','devrequest','quote','sales']") && nav.includes("'wapromo','metaleads'"));
  });
});

// ── Graph 가짜 응답 ──
const PAGE = '1338649012669713', IG = '17841400000000000';
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
function conv(id, user, msgs, upd, ig = false) {
  return { id, updated_time: upd, message_count: msgs.length,
    participants: { data: [ig ? { username: user.u, id: user.id } : { name: user.n, id: user.id }, ig ? { username: 'ctrmexico_', id: IG } : { name: 'CTR', id: PAGE }] },
    messages: { data: msgs.map((m, i) => ({ id: id + '_' + i, created_time: m[2], from: { id: m[0] === 'c' ? user.id : (ig ? IG : PAGE) }, message: m[1] })).reverse() } };
}

test('B. 실제 서버 + PostgreSQL', { skip: !PG && 'TEST_PG_URL 없음' }, async (t) => {
  const { query, pool } = await import('../src/db.js');
  after(async () => { await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });
  const keep = { ...process.env };
  process.env.META_PAGE_TOKEN = 'SYS_TOKEN'; delete process.env.META_PAGE_ID; process.env.META_LEADS_AUTO = '0';
  t.after(() => { process.env = keep; });
  const M = await import('../src/metaLeads.js');

  let calls = []; let pageMode = 'ok'; let convs = { messenger: [[]], instagram: [[]] };
  M.setMetaFetch(async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/' + PAGE)) {
      if (pageMode === 'bad') return { ok: false, status: 400, json: { error: { code: 190, message: 'Invalid OAuth access token' } } };
      return { ok: true, status: 200, json: { id: PAGE, name: 'CTR Suspensión y Dirección México', access_token: 'PAGE_TOKEN', instagram_business_account: { id: IG, username: 'ctrmexico_' } } };
    }
    if (u.pathname.endsWith('/conversations')) {
      assert.equal(u.searchParams.get('access_token'), 'PAGE_TOKEN', '시스템 사용자 토큰 → 페이지 토큰으로 바꿔서 읽는다');
      const plat = u.searchParams.get('platform'); const pg = Number(u.searchParams.get('after') || 0);
      const pages = convs[plat] || [[]];
      const next = pg + 1 < pages.length ? `https://graph.facebook.com/v20.0/${PAGE}/conversations?platform=${plat}&after=${pg + 1}&access_token=PAGE_TOKEN` : undefined;
      return { ok: true, status: 200, json: { data: pages[pg] || [], paging: next ? { next } : {} } };
    }
    return { ok: false, status: 404, json: { error: { message: 'unknown ' + u.pathname } } };
  });
  t.after(() => M.setMetaFetch(null));

  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  t.after(() => app.close());
  const SFX = Date.now().toString(36).slice(-5);
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  await query(`DELETE FROM meta_threads; DELETE FROM meta_sync_runs;`);
  const dir = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x',$2) RETURNING id`, [`ML Dir ${SFX}`, `mldir${SFX}`]);
  const rep = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'sales','x',$2) RETURNING id`, [`ML Rep ${SFX}`, `mlrep${SFX}`]);
  const D = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(dir.id), role: 'director' }) };
  const R = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(rep.id), role: 'sales' }) };
  const call = (h, method, url, payload) => app.inject({ method, url, payload, headers: h });
  const untilDone = async () => { for (let i = 0; i < 100; i++) { await wait(50); if (!M.syncState.running) return; } throw new Error('sync timeout'); };

  const BOT_Q = 'Hola Juan, Qué gusto saludarte.  Para empezar, platícanos un poquito sobre ti';
  const BOT_L = 'Claro, te comparto el link de nuestra pagina https://refatrix.com.mx En un momento un agente… WhatsApp al 8118250003';
  convs.messenger = [
    [conv('t_m1', { n: 'Antonio Lopez', id: 'psid1' }, [['p', BOT_Q, iso(300)], ['c', 'tengo un versa 2024 soy taxista', iso(299)], ['c', 'vivo en Jiutepec Morelos', iso(298)], ['p', 'por el momento estas horquillas esta agotadas', iso(200)], ['c', 'orquillas y bieletas, mi cel 777 123 4567', iso(10)]], iso(10)),
     conv('t_m2', { n: 'Juan Rios', id: 'psid2' }, [['p', BOT_Q, iso(400)], ['c', 'Soy Refaccionaria de MTY, quiero comprar producto CTR como equipo Origina', iso(399)], ['p', BOT_L, iso(399)]], iso(399))],
    [conv('t_m3', { n: 'Hugo BG', id: 'psid3' }, [['c', 'Donde puedo conseguir sus refacciones en Guadalajara? Necesito horquillas para un versa 2018', iso(3000)]], iso(3000))],
  ];
  convs.instagram = [[conv('t_i1', { u: 'taller.garza', id: 'igsid1' }, [['c', 'somos taller en saltillo, precio de rotulas aveo 2016?', iso(50)], ['p', 'hola buen dia con gusto le atiendo', iso(40)]], iso(40), true)]];

  await t.test('B1. 토큰 없음 · 권한 · 마이그레이션 상태', async () => {
    const keepTok = process.env.META_PAGE_TOKEN, keepWa = process.env.WHATSAPP_TOKEN;
    delete process.env.META_PAGE_TOKEN; delete process.env.WHATSAPP_TOKEN;
    let s = (await call(D, 'GET', '/api/meta-leads/status')).json();
    assert.equal(s.configured, false); assert.equal(s.migrated, true);
    assert.equal((await call(D, 'POST', '/api/meta-leads/sync', {})).statusCode, 400);
    process.env.META_PAGE_TOKEN = keepTok; if (keepWa) process.env.WHATSAPP_TOKEN = keepWa;
    assert.equal((await call(R, 'GET', '/api/meta-leads/list')).statusCode, 403, '마케팅 화면 권한이 없으면 못 본다');
    assert.equal((await call(R, 'POST', '/api/meta-leads/sync', {})).statusCode, 403, '가져오기는 마케팅 편집 권한');
    // 2026-10-13 · 제품·마케팅 메뉴에 들어가는 사람은 모두 본다(제품 보기만 있어도) · 상태 변경은 그중 edit 권한
    const pv = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'ops','x',$2) RETURNING id`, [`ML Prod ${SFX}`, `mlprod${SFX}`]);
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'products','anywhere','view')`, [pv.id]);
    const Pv = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(pv.id), role: 'ops' }) };
    assert.equal((await call(Pv, 'GET', '/api/meta-leads/list')).statusCode, 200, '제품(보기) 권한으로 목록');
    assert.equal((await call(Pv, 'GET', '/api/meta-leads/status')).statusCode, 200);
    assert.equal((await call(Pv, 'POST', '/api/meta-leads/sync', {})).json().error, 'read_only', '보기 권한은 가져오기 불가');
    const sv = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'sales','x',$2) RETURNING id`, [`ML Sales ${SFX}`, `mlsal${SFX}`]);
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'sales','anywhere','edit')`, [sv.id]);
    const Sv = { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(sv.id), role: 'sales' }) };
    assert.equal((await call(Sv, 'GET', '/api/meta-leads/list')).statusCode, 200, '영업(개발 요청 화면 경로) 권한으로도 본다');
    s = (await call(D, 'GET', '/api/meta-leads/status')).json();
    assert.equal(s.configured, true); assert.equal(s.page.name, 'CTR Suspensión y Dirección México'); assert.equal(s.page.ig_username, 'ctrmexico_');
    assert.equal(s.token_source, 'META_PAGE_TOKEN'); assert.equal(s.counts.total, 0); assert.equal(s.states.length, 32);
  });

  let idAnt;
  await t.test('B2. 가져오기 — 페이지 넘김 · Messenger + Instagram · 고객 말만 추출 · 우리 번호 무시', async () => {
    const r = await call(D, 'POST', '/api/meta-leads/sync', { full: true });
    assert.equal(r.statusCode, 200, r.body); await untilDone();
    assert.equal((await call(D, 'POST', '/api/meta-leads/sync', {})).statusCode, 200, '끝난 뒤엔 다시 가능');
    await untilDone();
    const s = (await call(D, 'GET', '/api/meta-leads/status')).json();
    assert.equal(s.counts.total, 4); assert.equal(s.counts.messenger, 3); assert.equal(s.counts.instagram, 1);
    assert.equal(s.last_run.ok, true);
    const items = (await call(D, 'GET', '/api/meta-leads/list')).json().items;
    assert.deepEqual(items.map((x) => x.name), ['Antonio Lopez', 'taller.garza', 'Juan Rios', 'Hugo BG'], '최근 대화 순');
    const ant = items.find((x) => x.name === 'Antonio Lopez'); idAnt = ant.id;
    assert.equal(ant.tipo, 'Taxi / app'); assert.equal(ant.state, 'Morelos'); assert.equal(ant.city, 'Jiutepec');
    assert.equal(ant.phone, '7771234567'); assert.equal(ant.vehicles, 'Nissan Versa 2024');
    assert.ok(ant.parts.includes('Horquilla') && ant.parts.includes('Bieleta'));
    assert.ok(!/agotadas|Qué gusto/.test(ant.customer_text), '우리 메시지는 고객 말에 넣지 않는다');
    const juan = items.find((x) => x.name === 'Juan Rios');
    assert.equal(juan.phone, null, '봇 안내문의 8118250003 은 고객 전화가 아니다'); assert.equal(juan.tipo_btn, 'Refaccionaria'); assert.equal(juan.state, null);
    const ig = items.find((x) => x.platform === 'instagram');
    assert.equal(ig.username, 'taller.garza'); assert.equal(ig.tipo, 'Taller mecánico'); assert.equal(ig.state, 'Coahuila'); assert.equal(ig.vehicles, 'Chevrolet Aveo 2016');
    const one1 = (await call(D, 'GET', `/api/meta-leads/${idAnt}`)).json();
    assert.equal(one1.messages.length, 5); assert.deepEqual(one1.messages.map((m) => m.me), [true, false, false, true, false]);
    assert.ok(calls.some((u) => u.includes('platform=instagram')) && calls.some((u) => u.includes('after=1')), '두 채널 · 다음 페이지');
  });

  await t.test('B3. 필터 · 사람이 고친 값은 다시 가져와도 유지 · 상태', async () => {
    let l = (await call(D, 'GET', '/api/meta-leads/list?state=Jalisco')).json().items; assert.deepEqual(l.map((x) => x.name), ['Hugo BG']);
    l = (await call(D, 'GET', '/api/meta-leads/list?state=__none')).json().items; assert.deepEqual(l.map((x) => x.name), ['Juan Rios']);
    l = (await call(D, 'GET', '/api/meta-leads/list?platform=instagram')).json().items; assert.equal(l.length, 1);
    l = (await call(D, 'GET', '/api/meta-leads/list?demand=1')).json().items; assert.equal(l.length, 3);
    l = (await call(D, 'GET', '/api/meta-leads/list?tipo=Refaccionaria')).json().items; assert.deepEqual(l.map((x) => x.name), ['Juan Rios'], '버튼 업종으로도 걸린다');
    l = (await call(D, 'GET', '/api/meta-leads/list?q=bieletas')).json().items; assert.deepEqual(l.map((x) => x.name), ['Antonio Lopez']);
    assert.equal((await call(D, 'PATCH', `/api/meta-leads/${idAnt}`, { status: 'x' })).statusCode, 400);
    assert.equal((await call(R, 'PATCH', `/api/meta-leads/${idAnt}`, { note: 'x' })).statusCode, 403);
    const p = (await call(D, 'PATCH', `/api/meta-leads/${idAnt}`, { state: 'Ciudad de México', phone: '5511112222', status: 'derivado', derived_to: 'Refacc. Morelos Centro', note: '보냄' })).json();
    assert.equal(p.state, 'Ciudad de México'); assert.equal(p.edited, true); assert.equal(p.status, 'derivado');
    // 다시 전체 가져오기 — 고친 값 · 상태 · 메모 유지, 자동값은 새로
    await call(D, 'POST', '/api/meta-leads/sync', { full: true }); await untilDone();
    const again = (await call(D, 'GET', `/api/meta-leads/${idAnt}`)).json();
    assert.equal(again.state, 'Ciudad de México'); assert.equal(again.a_state, 'Morelos'); assert.equal(again.phone, '5511112222');
    assert.equal(again.status, 'derivado'); assert.equal(again.derived_to, 'Refacc. Morelos Centro'); assert.equal(again.note, '보냄');
    // 빈 값 = 자동값으로 되돌리기
    const back = (await call(D, 'PATCH', `/api/meta-leads/${idAnt}`, { state: '' })).json(); assert.equal(back.state, 'Morelos');
  });

  await t.test('B4. 증분 — 마지막 성공 이후 바뀐 대화까지만 읽고 멈춤 · 새 대화 추가', async () => {
    convs.messenger[0].unshift(conv('t_m9', { n: 'Nuevo Cliente', id: 'psid9' }, [['c', 'necesito amortiguadores para sentra 2019, soy de queretaro', iso(1)]], iso(1)));
    calls = [];
    await call(D, 'POST', '/api/meta-leads/sync', {}); await untilDone();
    const s = (await call(D, 'GET', '/api/meta-leads/status')).json();
    assert.equal(s.counts.total, 5); assert.equal(s.last_run.inserted, 1);
    assert.ok(!calls.some((u) => u.includes('after=1')), '오래된 대화(다음 페이지)는 다시 읽지 않는다');
    const nu = (await call(D, 'GET', '/api/meta-leads/list?q=Nuevo')).json().items[0];
    assert.equal(nu.state, 'Querétaro'); assert.equal(nu.vehicles, 'Nissan Sentra 2019');
  });

  await t.test('B6. 2026-10-13 · 페이지 토큰에 pages_read_engagement 가 없어 페이지 정보가 #100 이어도 대화는 가져온다 · Instagram 계정은 참여자로 추정', async () => {
    const seen = [];
    M.setMetaFetch(async (url) => {
      const u = new URL(url); seen.push(u.pathname + '?' + (u.searchParams.get('fields') || '').slice(0, 20) + '&' + (u.searchParams.get('platform') || ''));
      if (u.pathname.endsWith('/' + PAGE)) return { ok: false, status: 400, json: { error: { code: 100, message: "(#100) Object does not exist, cannot be loaded due to missing permission or reviewable feature … requires the 'pages_read_engagement' permission" } } };
      if (u.pathname.endsWith('/conversations')) {
        assert.equal(u.searchParams.get('access_token'), 'SYS_TOKEN', '받은 토큰을 그대로 쓴다');
        const plat = u.searchParams.get('platform');
        if (u.searchParams.get('limit') === '1') return { ok: true, status: 200, json: { data: [{ id: 't_probe' }] } };
        if (plat === 'instagram') return { ok: true, status: 200, json: { data: [
          conv('t_i7', { u: 'cliente.uno', id: 'ig7' }, [['c', 'rotulas para tsuru 2015, soy de puebla', iso(5)]], iso(5), true),
          conv('t_i8', { u: 'cliente.dos', id: 'ig8' }, [['p', 'hola', iso(7)], ['c', 'bujes para march', iso(6)]], iso(6), true)] } };
        return { ok: true, status: 200, json: { data: [conv('t_m7', { n: 'Solo Messenger', id: 'psid7' }, [['c', 'horquillas versa 2019 en cancun', iso(4)]], iso(4))] } };
      }
      return { ok: false, status: 404, json: {} };
    });
    const st0 = (await call(D, 'GET', '/api/meta-leads/status')).json();
    assert.equal(st0.page_error, null, '오류가 아니다'); assert.match(st0.page_warning, /pages_read_engagement/);
    await call(D, 'POST', '/api/meta-leads/sync', {}); await untilDone();
    const s1 = (await call(D, 'GET', '/api/meta-leads/status')).json();
    assert.equal(s1.last_run.ok, true, s1.last_run.error);
    const l = (await call(D, 'GET', '/api/meta-leads/list?q=cliente')).json().items;
    const uno = l.find((x) => x.username === 'cliente.uno');
    assert.ok(uno, 'IG 대화 저장'); assert.equal(uno.state, 'Puebla'); assert.equal(uno.vehicles, 'Nissan Tsuru 2015');
    const dos = (await call(D, 'GET', `/api/meta-leads/${l.find((x) => x.username === 'cliente.dos').id}`)).json();
    assert.deepEqual(dos.messages.map((m) => m.me), [true, false], 'IG 우리 계정을 참여자로 추정해 구분');
    const m7 = (await call(D, 'GET', '/api/meta-leads/list?q=cancun')).json().items[0];
    assert.equal(m7.state, 'Quintana Roo');
    assert.equal(M.inferBusinessId([conv('a', { n: 'x', id: '1' }, [], iso(1))]), null, '대화 1건이면 추정하지 않음');
  });

  await t.test('B5. 토큰 오류 → 실패 기록 · 다시 추출', async () => {
    pageMode = 'bad'; M.setMetaFetch(async (url) => {
      const u = new URL(url); if (u.pathname.endsWith('/' + PAGE)) return { ok: false, status: 400, json: { error: { code: 190, message: 'Invalid OAuth access token' } } };
      return { ok: false, status: 400, json: { error: { message: 'x' } } }; });
    await call(D, 'POST', '/api/meta-leads/sync', {}); await untilDone();
    const s = (await call(D, 'GET', '/api/meta-leads/status')).json();
    assert.equal(s.last_run.ok, false); assert.match(s.last_run.error, /#190 Invalid OAuth/); assert.match(s.page_error, /#190/);
    await query(`UPDATE meta_threads SET a_state = NULL`);
    const r = (await call(D, 'POST', '/api/meta-leads/reextract', {})).json(); assert.equal(r.updated, 8);
    const l = (await call(D, 'GET', '/api/meta-leads/list?state=Coahuila')).json().items; assert.equal(l.length, 1, '저장된 대화로 다시 추출');
  });
});

