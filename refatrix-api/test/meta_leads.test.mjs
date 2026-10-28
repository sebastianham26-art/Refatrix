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
const AI = await import('../src/metaLeadsAi.js');
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
test('A3. 0271 · AI 입력 · 출력 정리 — 봇 안내문 제외 · 주 이름 맞추기 · 우리 번호 제거 · 차종-부품 짝', () => {
  const msgs = [{ me: true, text: 'Hola Juan, Qué gusto saludarte. Para empezar…' }, { me: false, text: 'tengo una flotilla de 12 verzas' },
    { me: true, text: '¿Confirmas que es para un Nissan Versa 2018?' }, { me: false, text: 'si, horquillas, estoy en cuernavaca' },
    { me: true, text: 'Claro, te comparto el link de nuestra pagina https://refatrix.com.mx' }];
  const tx = AI.conversationText(msgs);
  assert.equal(tx, 'C: tengo una flotilla de 12 verzas\nR: ¿Confirmas que es para un Nissan Versa 2018?\nC: si, horquillas, estoy en cuernavaca', '봇 정형 안내는 빼고 직원 확인 질문은 남긴다');
  assert.equal(AI.convHash(msgs), AI.convHash(JSON.parse(JSON.stringify(msgs)))); assert.notEqual(AI.convHash(msgs), AI.convHash(msgs.slice(1)));
  const pr = AI.buildPrompt([{ id: 7, text: tx }]); assert.match(pr, /### id=7/); assert.match(pr, /Taxi \/ app/); assert.match(pr, /"Quintana Roo"/); assert.match(pr, /de MTY.*NO es la ubicación/s);
  assert.deepEqual(AI.parseAiJson('aquí va:\n[{"id":7}]\nfin'), [{ id: 7 }]); assert.equal(AI.parseAiJson('nada'), null);
  const n = AI.normalizeAi({ id: 7, tipo: 'flotilla', tipo_fuente: 'dicho', estado: 'morelos', ciudad: 'Cuernavaca', telefono: '+52 81 1825 0003',
    vehiculos: [{ marca: 'Nissan', modelo: 'Versa', anio: '2018', piezas: ['Horquilla (brazo de control)'], cantidad: 12 }, { marca: null, modelo: null, anio: null, piezas: ['Rótula'] }],
    intencion: ['precio', 'precio'], resumen: 'Flotilla de 12 Versa 2018 pide horquillas' });
  assert.equal(n.tipo, 'Flotilla'); assert.equal(n.tipo_src, 'dicho'); assert.equal(n.state, 'Morelos', '대소문자 · 악센트 무시'); assert.equal(n.city, 'Cuernavaca');
  assert.equal(n.phone, null, '우리 번호는 고객 전화가 아니다'); assert.equal(n.vehicles, 'Nissan Versa 2018'); assert.equal(n.parts, 'Horquilla (brazo de control); Rótula');
  assert.equal(n.demand[0].cantidad, 12); assert.equal(n.intent, 'precio');
  assert.equal(AI.normalizeAi({ tipo: 'Cliente VIP', estado: 'Texas', telefono: '5512345678' }).tipo, null);
  assert.equal(AI.normalizeAi({ estado: 'Texas' }).state, null, '32개 주 밖은 버린다'); assert.equal(AI.normalizeAi({ telefono: '5512345678' }).phone, '5512345678');
});

test('A4. 0272 · 부품번호 매칭 규칙 — 부품 종류 · 좌우 · 연식 · 차종 나누기 · 결정', async () => {
  const MM = await import('../src/metaLeadsMatch.js');
  assert.equal(MM.partRule('Horquilla (brazo de control)').p, 'Horquilla (brazo de control)');
  assert.equal(MM.partRule('rotulas inferiores').p, 'Rótula');
  assert.equal(MM.partRule('Terminal exterior').p, 'Terminal exterior');
  assert.equal(MM.partRule('Suspensión completa (kit)'), null, '키트 · 브레이크는 매칭 안 함');
  const H = MM.partRule('Horquilla (brazo de control)');
  assert.ok(H.re.test('HORQUILLA INFERIOR DERECHA') && !H.re.test('BUJE DE HORQUILLA'.replace('HORQUILLA', 'X')));
  assert.equal(MM.sideOf('CQ0271L', 'HORQUILLA'), 'L'); assert.equal(MM.sideOf('CQ0271R', ''), 'R');
  assert.equal(MM.sideOf('X1', 'HORQUILLA INFERIOR IZQUIERDA'), 'L'); assert.equal(MM.sideOf('CB0318', 'ROTULA INFERIOR'), null);
  assert.equal(MM.slotOf('HORQUILLA INFERIOR IZQUIERDA'), MM.slotOf('Horquilla inferior derecha'));
  assert.deepEqual(MM.yearsOf('2018'), [2018, 2018]); assert.deepEqual(MM.yearsOf('2013-2019'), [2013, 2019]); assert.deepEqual(MM.yearsOf('17'), [2017, 2017]); assert.deepEqual(MM.yearsOf(null), [null, null]);
  assert.deepEqual(MM.splitVehicle('Nissan Versa 2018'), { marca: 'Nissan', modelo: 'Versa', anio: '2018' });
  assert.deepEqual(MM.splitVehicle('Np300 2009-2015'), { marca: null, modelo: 'Np300', anio: '2009-2015' });
  const line = { marca: 'Nissan', modelo: 'Versa', anio: '2018', piezas: [], cantidad: 2 };
  const pair = [{ pid: 1, code: 'CQ1L', name: 'HORQUILLA INFERIOR IZQUIERDA' }, { pid: 2, code: 'CQ1R', name: 'HORQUILLA INFERIOR DERECHA' }];
  let d = MM.decide(line, 'Horquilla (brazo de control)', pair, null);
  assert.equal(d.ambiguous, false); assert.deepEqual(d.items.map((i) => [i.code, i.qty, i.qty_src, i.conf]), [['CQ1L', 1, 'dicho', 'alta'], ['CQ1R', 1, 'dicho', 'alta']], '「par」 = 쪽당 1');
  d = MM.decide({ ...line, cantidad: null }, 'Horquilla (brazo de control)', pair, 'R');
  assert.deepEqual(d.items.map((i) => [i.code, i.qty, i.qty_src]), [['CQ1R', 1, 'supuesto']], '고객이 오른쪽만');
  d = MM.decide({ ...line, anio: null }, 'Horquilla (brazo de control)', [...pair, { pid: 3, code: 'CQ2L', name: 'HORQUILLA INFERIOR IZQ' }], null);
  assert.equal(d.ambiguous, true, '같은 쪽에 두 세대 → 못 정함'); assert.ok(d.items.every((i) => i.status === 'candidato'));
  assert.equal(MM.decide(line, 'Rótula', [], null).items[0].status, 'sin_catalogo');
  assert.equal(MM.decide({ ...line, modelo: null }, 'Rótula', [], null).items[0].status, 'sin_vehiculo');
  assert.equal(MM.sideHint([{ me: false, text: 'la del lado izquierdo' }, { me: true, text: 'derecha?' }]), 'L', '우리 말은 안 봄');
});

test('C. 화면 (jsdom)', { skip: (!JSDOM || !existsSync(HTML)) && 'jsdom 또는 HTML 없음' }, async (t) => {
  const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const ITEMS = [
    { id: 1, platform: 'messenger', name: 'Antonio Lopez', last_mx: '2026-10-12 10:00', first_mx: '2026-10-11', tipo: 'Taxi / app', tipo_btn: null, state: 'Morelos', city: 'Jiutepec', phone: '7771234567', vehicles: 'Nissan Versa 2024', parts: 'Horquilla (brazo de control); Bieleta / tornillo estabilizador', intent: 'Precio', customer_text: 'tengo un versa 2024\nvivo en Jiutepec', status: 'nuevo', edited: false,
      items: [{ model: 'Nissan Versa', veh: 'Nissan Versa 2024', pieza: 'Horquilla (brazo de control)', code: 'CQ9L', name: 'HORQUILLA INF IZQ', qty: 1, qty_src: 'supuesto', conf: 'alta', src: 'regla', status: 'ok' },
        { model: 'Nissan Versa', veh: 'Nissan Versa 2024', pieza: 'Horquilla (brazo de control)', code: 'CQ9R', name: 'HORQUILLA INF DER', qty: 1, qty_src: 'supuesto', conf: 'alta', src: 'regla', status: 'ok' },
        { model: 'Nissan Versa', veh: 'Nissan Versa 2024', pieza: 'Bieleta / tornillo estabilizador', status: 'sin_catalogo', qty: 1 }] },
    { id: 2, platform: 'instagram', name: null, username: 'taller.garza', last_mx: '2026-10-12 09:00', tipo: null, tipo_btn: 'Refaccionaria', state: 'Morelos', city: null, phone: null, vehicles: 'Nissan Versa 2018; Chevrolet Aveo 2016', parts: 'Horquilla (brazo de control)', customer_text: 'x', status: 'derivado', derived_to: 'Refacc. X', edited: true },
    { id: 3, platform: 'messenger', name: 'Sin datos', last_mx: '2026-10-11 09:00', tipo: null, state: null, parts: null, vehicles: null, customer_text: '', status: 'nuevo' },
    { id: 4, platform: 'whatsapp', name: 'Pepe Garza', last_mx: '2026-10-12 11:00', tipo: 'Flotilla', tipo_src: 'dicho', state: 'Morelos', city: 'Cuernavaca', phone: '7779990000',
      vehicles: 'Nissan Versa 2018; Nissan March 2015', parts: 'Horquilla (brazo de control); Rótula', summary: 'Flotilla de 12 Versa busca horquillas y rótulas para March', customer_text: 'tengo flotilla',
      demand: [{ marca: 'Nissan', modelo: 'Versa', anio: '2018', piezas: ['Horquilla (brazo de control)'] }, { marca: 'Nissan', modelo: 'March', anio: '2015', piezas: ['Rótula'] }], status: 'nuevo',
      items: [{ model: 'Nissan Versa', veh: 'Nissan Versa 2018', code: 'CQ8L', name: 'HORQUILLA INF IZQ', qty: 12, qty_src: 'dicho', conf: 'media', src: 'ia', status: 'ok' },
        { model: 'Nissan Versa', veh: 'Nissan Versa 2018', code: 'CQ9L', name: 'HORQUILLA INF IZQ', qty: 2, qty_src: 'dicho', conf: 'alta', src: 'ia', status: 'ok' },
        { model: 'Nissan March', veh: 'Nissan March 2015', pieza: 'Rótula', code: 'CB1', name: 'ROTULA INF', status: 'candidato' }, { model: 'Nissan March', veh: 'Nissan March 2015', pieza: 'Rótula', code: 'CB2', name: 'ROTULA SUP', status: 'candidato' }] },
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
          counts: { total: 4, messenger: 2, instagram: 1, whatsapp: 1, demand: 3, with_state: 3, with_phone: 2, with_tipo: 2, nuevo: 3, ai_done: 1, ai_pending: 0 },
          ai: { ready: true, model: 'claude-haiku-4-5-20251001', running: false, done: 0, total: 0, errors: 0 }, last_run: { ok: true, threads: 3, inserted: 3, finished_at: '2026-10-12T16:00:00Z' }, last_ok_at: '2026-10-12T16:00:00Z', auto: true,
          states: ['Jalisco', 'Morelos', 'Nuevo León'] });
        if (u.includes('/api/meta-leads/list')) return json({ items: ITEMS, stock: { CQ9L: 2, CQ8L: 40 } });
        if (u.includes('/api/meta-leads/match')) return json({ started: true });
        if (u.includes('/api/meta-leads/sync')) return json({ started: true });
        if (u.includes('/api/meta-leads/ai')) return json({ started: true });
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
    assert.match(d.title, /mtl-1028lpa/);
    assert.match(d.getElementById('sPage').textContent, /CTR.*@ctrmexico_/);
    assert.match(d.getElementById('sKpis').textContent, /전체 문의4/); assert.match(d.getElementById('sKpis').textContent, /WhatsApp1/);
    assert.match(d.getElementById('sAi').textContent, /AI 분석 1건 완료/);
    assert.equal(d.querySelectorAll('#lTable tbody tr').length, 4);
    const wa = d.querySelector('#lTable tr[data-id="4"]').textContent; assert.match(wa, /WA/); assert.match(wa, /🤖 Flotilla de 12 Versa/, 'AI 요약 표시');
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
    assert.equal(p.body.items, undefined, '부품번호를 안 고치면 보내지 않음');
    assert.match(d.getElementById('oItems').textContent, /CQ9R/); assert.match(d.getElementById('oItems').textContent, /개발 필요/);
    d.getElementById('eItems').value = 'CQ9L 4'; d.getElementById('eSave').click(); await tick(200);
    assert.equal(calls.filter((c) => c.method === 'PATCH').pop().body.items, 'CQ9L 4');
    d.getElementById('bMatch').click(); await tick();
    assert.ok(calls.some((c) => c.u.includes('/api/meta-leads/match') && c.body.all === true));
  });
  await t.test('C3. 가져오기 · AI 버튼 · 엑셀 7개 시트(차종·연식 × 부품) · 요약', async () => {
    d.getElementById('bSync').click(); await tick();
    assert.ok(calls.some((c) => c.u.includes('/api/meta-leads/sync') && c.method === 'POST' && c.body.full === false));
    d.getElementById('bXls').click(); await tick();
    assert.ok(written && /refatrix_meta_consultas_\d{4}-\d{2}-\d{2}\.xlsx/.test(written.name));
    assert.deepEqual([...written.wb.sheets.map((s) => s[0])], ['Contactos', 'Oportunidades por estado', 'Oportunidades por tipo', 'Oportunidades por vehículo', 'Códigos por tipo de cliente', 'Demanda por código CTR', 'Por confirmar - sin catálogo', 'Demanda vehículo-pieza', 'Por tipo', 'Por estado', 'Por vehículo', 'Por pieza']);
    const contacts = written.wb.sheets[0][1]; assert.equal(contacts.length, 5); assert.equal(contacts[1][2], 'Antonio Lopez'); assert.equal(contacts[2][2], 'taller.garza');
    const waRow = contacts[4]; assert.equal(waRow[3], 'WhatsApp'); assert.equal(waRow[4], 'Flotilla'); assert.equal(waRow[5], 'Lo dijo'); assert.equal(waRow[8], '7779990000'); assert.match(waRow[13], /Flotilla de 12/);
    assert.equal(contacts[2][4], 'Refaccionaria'); assert.equal(contacts[2][5], 'Botón del anuncio');
    const opp = written.wb.sheets[1][1]; assert.equal(opp[1][0], 'Morelos'); assert.equal(opp[1][1], 3); assert.equal(opp[1][2], 3);
    assert.match(opp[1][4], /Taxi 1/); assert.match(opp[1][4], /F 1/); assert.match(opp[1][4], /R 1/);
    assert.match(opp[1][5], /Nissan Versa 2018 \(2\)/, '연식 포함 차종');
    const byTipo = written.wb.sheets[2]; assert.equal(byTipo[0], 'Oportunidades por tipo');
    assert.ok(byTipo[1].find((r) => r[0] === 'Flotilla' && r[1] === 1 && /Morelos/.test(r[4]) && /Versa 2018/.test(r[5])), '고객 유형별 판매기회');
    const byVeh = written.wb.sheets[3]; assert.equal(byVeh[0], 'Oportunidades por vehículo');
    const vRow = byVeh[1].find((r) => r[0] === 'Nissan Versa'); assert.equal(vRow[1], 3); assert.match(vRow[4], /2018 \(2\)/);
    const ct = written.wb.sheets[4][1];
    assert.deepEqual([...ct[0]].slice(0, 6), ['Código CTR', 'Descripción', 'Vehículo (año)', 'Cantidad total', 'Flotilla', 'Taxi / app'], '유형 열(정해진 순서 · 있는 유형만)');
    assert.equal(ct[1][0], 'CQ8L'); assert.equal(ct[1][3], 12); assert.equal(ct[1][4], 12, 'CQ8L 은 Flotilla 12');
    const cq9t = ct.find((r) => r[0] === 'CQ9L'); assert.deepEqual([cq9t[3], cq9t[4], cq9t[5]], [3, 2, 1], 'CQ9L: 합계 3 = Flotilla 2 + Taxi 1');
    const byCode = written.wb.sheets[5][1];
    const cq9 = byCode.find((r) => r[0] === 'CQ9L'); assert.deepEqual([cq9[3], cq9[4], cq9[5], cq9[6]], [2, 3, 2, 2], 'CQ9L: 문의 2 · 수량 1+2 · 말한 수량 2 · 재고 2');
    assert.equal(byCode[1][0], 'CQ8L', '수량 많은 순'); assert.equal(byCode[1][4], 12);
    const open = written.wb.sheets[6][1];
    assert.ok(open.find((r) => /Sin catálogo/.test(r[0]) && r[2] === 'Bieleta / tornillo estabilizador'));
    assert.ok(open.find((r) => /Por confirmar/.test(r[0]) && r[1] === 'Nissan March 2015' && r[5] === 'CB1, CB2'));
    assert.equal(contacts[1][18], 'CQ9L x1; CQ9R x1', 'Contactos 마지막 열 = 부품번호 × 수량');
    const dem = written.wb.sheets[7][1];
    const versaH = dem.find((r) => r[0] === 'Nissan Versa' && r[1] === 'Horquilla (brazo de control)');
    assert.equal(versaH[2], 3); assert.match(versaH[3], /2018 \(2\)/); assert.match(versaH[3], /2024 \(1\)/); assert.match(versaH[4], /Morelos \(3\)/);
    assert.ok(dem.find((r) => r[0] === 'Nissan March' && r[1] === 'Rótula'), 'AI 가 짝지은 차종-부품');
    assert.ok(!dem.find((r) => r[0] === 'Nissan March' && r[1] === 'Horquilla (brazo de control)'), 'AI 짝(demand)이 있으면 곱하지 않는다');
    const veh = written.wb.sheets[10][1]; assert.deepEqual([...veh[1]], ['Nissan Versa', 3]);
    d.querySelector('#tabs .tab[data-p="sum"]').click(); await tick();
    // 기본 보기 = 차종
    assert.match(d.getElementById('sumPivotTitle').textContent, /차종별/);
    assert.match(d.getElementById('sumPivot').textContent, /Nissan Versa/);
    assert.match(d.getElementById('sumDemand').textContent, /Nissan Versa/);
    assert.ok(!d.getElementById('sumDemandBox').classList.contains('hidden'));
    assert.match(d.getElementById('sumPivot').textContent, /CQ8L \(12\)/, '차종별 판매기회에 부품번호 (수량)');
    const sc = d.getElementById('sumCodes').textContent; assert.match(sc, /CQ9L/); assert.match(sc, /합계 3개 품목/);
    assert.match(d.getElementById('sumOpen').textContent, /카탈로그 없음/); assert.match(d.getElementById('sumOpen').textContent, /CB2/);
    assert.match(d.getElementById('lTable').textContent, /CQ9R ×1/, '목록에 부품번호');
    // 지역
    d.querySelector('#sumDim button[data-d="state"]').click(); await tick();
    assert.match(d.getElementById('sumPivotTitle').textContent, /지역/);
    assert.match(d.getElementById('sumPivot').textContent, /Morelos/);
    assert.match(d.getElementById('sumMain').textContent, /Morelos/);
    assert.ok(d.getElementById('sumDemandBox').classList.contains('hidden')); assert.ok(d.getElementById('sumCodesBox').classList.contains('hidden'));
    // 고객 유형 → 행 클릭 = 연락처
    d.querySelector('#sumDim button[data-d="tipo"]').click(); await tick();
    assert.match(d.getElementById('sumPivotTitle').textContent, /고객 유형별/);
    assert.match(d.getElementById('sumMain').textContent, /Flotilla/);
    d.querySelector('#sumPivot tr[data-k="Flotilla"]').click(); await tick();
    assert.match(d.getElementById('sumDetail').textContent, /Flotilla — 부품번호 × 수량/, '유형 행 → 그 유형의 부품번호 수량 순');
    assert.ok(d.getElementById('sumDetail').textContent.indexOf('CQ8L') < d.getElementById('sumDetail').textContent.indexOf('CQ9L'), 'CQ8L(12) 이 CQ9L(2) 보다 위');
    assert.match(d.getElementById('sumDetail').textContent, /Flotilla — 연락처 1건/);
    assert.match(d.getElementById('sumDetail').textContent, /7779990000/);
    // 2026-10-14 · 📦 부품번호 보기 — 수량 많은 순 · 유형별 열 · 유형 고르면 그 유형 순
    d.querySelector('#sumDim button[data-d="code"]').click(); await tick();
    const codeRows = () => [...d.querySelectorAll('#sumPivot tr[data-k]')].map((tr) => tr.dataset.k);
    assert.deepEqual(codeRows(), ['CQ8L', 'CQ9L', 'CQ9R'], '수량 많은 순(12 · 3 · 1)');
    assert.match(d.getElementById('sumPivotTitle').textContent, /부품번호별 판매기회/);
    assert.match(d.getElementById('sumMain').textContent, /CQ8L/);
    d.querySelector('#sumPivot button[data-ct="Taxi / app"]').click(); await tick();
    assert.deepEqual(codeRows(), ['CQ9L', 'CQ9R'], 'Taxi 만: Taxi 수량 순, 없는 코드는 빠짐');
    d.querySelector('#sumPivot tr[data-k="CQ9L"]').click(); await tick();
    assert.match(d.getElementById('sumDetail').textContent, /CQ9L .*연락처 1건/, 'Taxi 로 고른 상태에선 Taxi 연락처만');
    d.querySelector('#sumPivot button[data-ct=""]').click(); await tick();
    d.querySelector('#sumDim button[data-d="tipo"]').click(); await tick();
    d.getElementById('bAi').click(); await tick();
    assert.ok(calls.some((c) => c.u.includes('/api/meta-leads/ai') && c.method === 'POST' && c.body.all === true));
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
  await query(`DELETE FROM meta_threads; DELETE FROM meta_sync_runs; DELETE FROM wa_messages;`);
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
    assert.equal((await call(D, 'POST', '/api/meta-leads/sync', {})).statusCode, 200, '토큰 없어도 WhatsApp 은 가져온다');
    await untilDone();
    assert.match((await call(D, 'GET', '/api/meta-leads/status')).json().last_run.error, /no_token/);
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
  await t.test('B7. 0271 · WhatsApp 문의 — ERP 가 받은 대화를 같은 목록에 · 번호 = 연락처 · 프로필 이름 · 사내 번호 제외', async () => {
    const at = (m) => new Date(Date.now() - m * 60000).toISOString();
    await query(`INSERT INTO wa_messages (direction, phone, kind, body, source, at) VALUES
      ('in','528112223344','text','Hola, soy mecánico en Saltillo, ocupo rótulas para tsuru 2015',  'inbound',$1),
      ('out','528112223344','text','Claro, ¿cuántas piezas?','manual',$2),
      ('in','528112223344','image',NULL,'inbound',$3),
      ('in','528110001111','text','ok gracias','inbound',$1)`, [at(30), at(20), at(10)]);
    await query(`INSERT INTO wa_inbound (wa_from, last_at, msg_count, profile_name) VALUES ('528112223344', now(), 2, 'Taller Ramírez')
                 ON CONFLICT (wa_from) DO UPDATE SET profile_name = EXCLUDED.profile_name`);
    await query(`UPDATE users SET wa_phone = '528110001111' WHERE id = $1`, [dir.id]);   // 사내(디렉터) 번호는 문의가 아니다
    await call(D, 'POST', '/api/meta-leads/sync', {}); await untilDone();
    const l = (await call(D, 'GET', '/api/meta-leads/list?platform=whatsapp')).json().items;
    assert.equal(l.length, 1, '사내 번호 제외');
    const w = l[0];
    assert.equal(w.name, 'Taller Ramírez'); assert.equal(w.phone, '8112223344', 'WhatsApp 번호가 연락처');
    assert.equal(w.tipo, 'Taller mecánico'); assert.equal(w.state, 'Coahuila'); assert.equal(w.vehicles, 'Nissan Tsuru 2015'); assert.equal(w.parts, 'Rótula');
    const one = (await call(D, 'GET', `/api/meta-leads/${w.id}`)).json();
    assert.deepEqual(one.messages.map((m) => [m.me, m.text]), [[false, 'Hola, soy mecánico en Saltillo, ocupo rótulas para tsuru 2015'], [true, 'Claro, ¿cuántas piezas?'], [false, '(imagen)']]);
    assert.equal((await call(D, 'GET', '/api/meta-leads/status')).json().counts.whatsapp, 1);
    // 2026-10-13 hotfix: 마지막 성공 가져오기보다 오래된 WhatsApp 대화도(목록에 없으면) 「새 문의 가져오기」로 들어온다
    await query(`INSERT INTO wa_messages (direction, phone, kind, body, source, at) VALUES ('in','528187776655','text','horquillas versa 2017','inbound', now() - interval '20 days')`);
    await call(D, 'POST', '/api/meta-leads/sync', {}); await untilDone();
    const l2 = (await call(D, 'GET', '/api/meta-leads/list?platform=whatsapp')).json().items;
    assert.ok(l2.some((x) => x.phone === '8187776655'), '오래된 WhatsApp 대화도 들어옴');
    // 바뀐 게 없으면 다시 읽지 않음 · 새 메시지가 생기면 그 번호만
    const r0 = (await query(`SELECT by_platform FROM meta_sync_runs ORDER BY id DESC LIMIT 1`)).rows[0].by_platform.whatsapp;
    assert.equal(r0.threads, 1, '이번에 새로 생긴 번호 1개만 읽음');
    await call(D, 'POST', '/api/meta-leads/sync', {}); await untilDone();
    assert.equal((await query(`SELECT by_platform FROM meta_sync_runs ORDER BY id DESC LIMIT 1`)).rows[0].by_platform.whatsapp.threads, 0, '변화 없으면 0');
    // 2026-10-13 · WhatsApp 앱 번호(8118250003) 대화 파일 올리기 — 'wab:' 로 따로 · 사내 번호 제외 · 다시 올리면 덮어씀
    const up = { threads: [
      { key: 'x1', name: 'Marcos Puc', phone: '+52 1 998 110 5335', messages: [{ at: Date.now() - 5000, me: false, text: 'Soy Particular de MTY, quiero comprar producto CTR' }, { at: Date.now() - 4000, me: false, text: 'horquillas versa 2018' }, { at: Date.now() - 3000, me: true, text: 'Claro, ¿cuántas?' }] },
      { key: 'x2', name: 'Dir', phone: '528110001111', messages: [{ at: Date.now(), me: false, text: 'interno' }] },
      { key: 'x3', name: 'Vacío', phone: '5215500000000', messages: [] }] };
    let ir = (await call(D, 'POST', '/api/meta-leads/import-wa-app', up)).json();
    assert.deepEqual([ir.threads, ir.inserted, ir.skipped], [1, 1, 2]);
    ir = (await call(D, 'POST', '/api/meta-leads/import-wa-app', up)).json(); assert.deepEqual([ir.threads, ir.inserted], [1, 0], '다시 올리면 덮어씀');
    const wab = (await call(D, 'GET', '/api/meta-leads/list?platform=whatsapp&q=Marcos')).json().items[0];
    assert.equal(wab.source, 'wa_app'); assert.equal(wab.phone, '9981105335'); assert.equal(wab.thread_id, 'wab:529981105335'); assert.match(wab.vehicles || '', /Versa/);
    assert.equal((await call(R, 'POST', '/api/meta-leads/import-wa-app', up)).statusCode, 403);
    await query(`DELETE FROM meta_threads WHERE thread_id LIKE 'wab:%'`);
    const wd = (await call(D, 'GET', '/api/meta-leads/status')).json().wa;
    assert.deepEqual([wd.in_phones, wd.internal, wd.customers, wd.listed], [3, 1, 2, 2], '진단: 받은 번호 · 사내 · 고객 · 목록');
  });

  await t.test('B8. 0271 · AI 분석 — 바뀐 대화만 · 고객 말 없는 대화는 안 보냄 · 우선순위 사람 > AI > 규칙', async () => {
    const keepKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal((await call(D, 'POST', '/api/meta-leads/ai', {})).json().error, 'ai_not_configured');
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const prompts = [];
    AI.setMetaAiCaller(async (prompt) => {
      prompts.push(prompt);
      const ids = [...prompt.matchAll(/### id=(\d+)/g)].map((m) => Number(m[1]));
      return { ok: true, text: JSON.stringify(ids.map((id) => ({ id, tipo: 'Flotilla', tipo_fuente: 'dicho', estado: 'Yucatán', ciudad: 'Mérida',
        vehiculos: [{ marca: 'Nissan', modelo: 'March', anio: '2016', piezas: ['Amortiguador'] }], intencion: ['precio'], resumen: 'R' + id }))) };
    });
    try {
      const r = await call(D, 'POST', '/api/meta-leads/ai', { all: true }); assert.equal(r.statusCode, 200, r.body);
      for (let i = 0; i < 100 && AI.aiState.running; i++) await wait(30);
      await wait(50);
      const sent = prompts.filter((x) => !x.includes('Pedidos:')).join('\n').match(/### id=/g).length;   // 0272 부품번호 매칭 질의는 제외
      const withText = (await query(`SELECT count(*)::int n FROM meta_threads WHERE in_count > 0`)).rows[0].n;
      assert.equal(sent, withText, '고객이 쓴 말이 있는 대화만 AI 로');
      assert.ok(!prompts.join('\n').includes('Qué gusto saludarte'), '봇 안내문은 안 보냄');
      const ant = (await call(D, 'GET', `/api/meta-leads/${idAnt}`)).json();
      assert.equal(ant.summary, 'R' + idAnt); assert.equal(ant.tipo, 'Flotilla'); assert.equal(ant.tipo_src, 'dicho');
      assert.equal(ant.state, 'Yucatán', 'AI 가 규칙(Morelos)보다 우선'); assert.equal(ant.vehicles, 'Nissan March 2016');
      assert.equal(ant.phone, '5511112222', '사람이 고친 전화는 AI 보다 우선');
      assert.deepEqual(ant.demand, [{ marca: 'Nissan', modelo: 'March', anio: '2016', piezas: ['Amortiguador'], cantidad: null }]);
      const st = (await call(D, 'GET', '/api/meta-leads/status')).json();
      assert.equal(st.counts.ai_done, (await query(`SELECT count(*)::int n FROM meta_threads`)).rows[0].n); assert.equal(st.counts.ai_pending, 0); assert.equal(st.ai.ready, true);
      // 다시 돌려도(all 아님) 바뀐 대화가 없으면 AI 호출 없음
      prompts.length = 0;
      await AI.analyzeThreads({});
      assert.equal(prompts.length, 0, '같은 대화는 다시 보내지 않는다');
      // 사람이 차종을 고치면 AI 짝(demand)은 숨긴다(사람 값 기준으로 집계)
      const p = (await call(D, 'PATCH', `/api/meta-leads/${idAnt}`, { vehicles: 'Nissan Versa 2024' })).json();
      assert.equal(p.vehicles, 'Nissan Versa 2024'); assert.equal(p.demand, null);
      // AI 응답이 깨지면 오류로 남기고 대기(다음에 다시)
      AI.setMetaAiCaller(async () => ({ ok: true, text: 'lo siento' }));
      await query(`UPDATE meta_threads SET ai_hash = NULL WHERE id = $1`, [idAnt]);
      await AI.analyzeThreads({});
      const e = (await call(D, 'GET', `/api/meta-leads/${idAnt}`)).json(); assert.match(e.ai_error, /응답 형식/);
      assert.equal((await call(D, 'GET', '/api/meta-leads/status')).json().counts.ai_pending, 1);
    } finally { AI.setMetaAiCaller(null); if (keepKey) process.env.ANTHROPIC_API_KEY = keepKey; else delete process.env.ANTHROPIC_API_KEY; }
  });

  await t.test('B9. 0272 · 부품번호 × 수량 — 규칙 확정 · AI 가 고름 · 카탈로그 없음 · 실패는 다음에 다시 · 사람이 고친 코드', async () => {
    const MM = await import('../src/metaLeadsMatch.js');
    await wait(400); await MM.matchThreads({ ids: [0] });   // 앞 시험(B8)이 남긴 자동 매칭이 끝날 때까지
    await query(`DELETE FROM meta_threads`);
    const prod = async (code, name, model, y1, y2, stock = 0) => {
      const p = await one(`INSERT INTO products (code, name, stock_qty) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, stock_qty = EXCLUDED.stock_qty, deleted_at = NULL RETURNING id`, [code, name, stock]);
      await query(`DELETE FROM product_applications WHERE product_id = $1`, [p.id]);
      await query(`INSERT INTO product_applications (product_id, app_text, maker, model, year_from, year_to) VALUES ($1,$2,'NISSAN',$3,$4,$5)`, [p.id, `NISSAN ${model} ${y1}-${y2}`, model, y1, y2]);
    };
    const P = 'ZT' + SFX.toUpperCase();
    await prod(P + '01L', 'HORQUILLA INFERIOR IZQUIERDA', 'Versa', 2012, 2019, 7);
    await prod(P + '01R', 'HORQUILLA INFERIOR DERECHA', 'Versa', 2012, 2019, 5);
    await prod(P + '02L', 'HORQUILLA INFERIOR IZQUIERDA', 'Versa', 2020, 2024);
    await prod(P + '02R', 'HORQUILLA INFERIOR DERECHA', 'Versa', 2020, 2024);
    await prod(P + '11', 'AMORTIGUADOR DELANTERO', 'March', 2011, 2020);
    await prod(P + '12', 'AMORTIGUADOR TRASERO', 'March', 2011, 2020);
    const th = async (tid, demand, msgs) => Number((await one(`INSERT INTO meta_threads (platform, thread_id, messages, in_count, ai_demand, last_at) VALUES ('messenger',$1,$2::jsonb,1,$3::jsonb, now()) RETURNING id`,
      [tid + SFX, JSON.stringify(msgs.map((t, i) => ({ at: new Date().toISOString(), me: false, text: t }))), JSON.stringify(demand)])).id);
    const v = (modelo, anio, piezas, cantidad = null) => [{ marca: 'Nissan', modelo, anio, piezas, cantidad }];
    const t1 = await th('x1', v('Versa', '2018', ['Horquilla (brazo de control)']), ['horquillas versa 2018']);
    const t2 = await th('x2', v('Versa', null, ['Horquilla (brazo de control)'], 2), ['ocupo el par de horquillas del versa nuevo, el sense 2022']);
    const t3 = await th('x3', v('March', '2016', ['Amortiguador']), ['amortiguadores march 2016']);
    const t4 = await th('x4', v('Tsuru', '2015', ['Rótula']), ['rotulas tsuru']);
    const t5 = await th('x5', v('Versa', '2018', ['Horquilla (brazo de control)']), ['solo la del lado izquierdo, versa 2018']);
    const keepKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'test-key';
    const prompts = [];
    AI.setMetaAiCaller(async (prompt) => {
      prompts.push(prompt);
      const ids = [...prompt.matchAll(/### id=(\d+)/g)].map((m) => Number(m[1]));
      return { ok: true, text: JSON.stringify(ids.filter((id) => id !== t3).map((id) => ({ id, pedidos: [{ n: 1, partes: [
        { codigo: P + '02L', cantidad: 1, cantidad_dicha: true, confianza: 'alta' }, { codigo: P + '02R', cantidad: 1, cantidad_dicha: true, confianza: 'alta' }, { codigo: 'NOEXISTE', cantidad: 9 }] }] }))) };
    });
    try {
      await MM.matchThreads({});
      const get = async (id) => (await call(D, 'GET', `/api/meta-leads/${id}`)).json();
      const it = (x) => x.items.map((i) => [i.code || null, i.qty, i.status, i.src || null]);
      assert.deepEqual(it(await get(t1)), [[P + '01L', 1, 'ok', 'regla'], [P + '01R', 1, 'ok', 'regla']], '연식 2018 → 1세대 좌우 확정(AI 안 씀)');
      assert.deepEqual(it(await get(t2)), [[P + '02L', 1, 'ok', 'ia'], [P + '02R', 1, 'ok', 'ia']], '연식 없음 → AI 가 대화(sense 2022)로 2세대 고름 · 후보 밖 코드 버림');
      assert.equal((await get(t2)).items[0].qty_src, 'dicho');
      const x3 = await get(t3); assert.ok(x3.items.every((i) => i.status === 'candidato')); assert.equal(x3.items.length, 2); assert.match(x3.items_error, /응답 형식/);
      assert.deepEqual(it(await get(t4)), [[null, 1, 'sin_catalogo', null]], '카탈로그 없음 = 개발 필요');
      assert.deepEqual(it(await get(t5)), [[P + '01L', 1, 'ok', 'regla']], '고객이 왼쪽만');
      assert.equal(prompts.length, 1, '애매한 대화만 한 번에 AI 로'); assert.ok(prompts[0].includes(P + '02R') && prompts[0].includes('Pedidos:'));
      assert.ok(!prompts[0].includes(`### id=${t1}\n`), '정해진 대화는 AI 에 안 보냄');
      // 다시: 지문이 같으면 건너뜀 · 실패한 건(t3)만 다시
      prompts.length = 0; await MM.matchThreads({});
      assert.equal(prompts.length, 1); assert.deepEqual([...prompts[0].matchAll(/### id=(\d+)/g)].map((m) => Number(m[1])), [t3]);
      // 목록: 부품번호 · 재고 · 상태 건수
      const l = (await call(D, 'GET', '/api/meta-leads/list')).json();
      assert.equal(l.stock[P + '01L'], 7); assert.equal(l.stock[P + '01R'], 5);
      assert.equal((await call(D, 'GET', '/api/meta-leads/status')).json().counts.with_code, 3);
      // 사람이 고친 코드 × 수량 — 모르는 코드는 알려줌 · 빈 값이면 자동으로
      let r = (await call(D, 'PATCH', `/api/meta-leads/${t3}`, { items: `${P}11 4\nNOPE9` })).json();
      assert.equal(r.items_manual, true); assert.deepEqual(r.items.map((i) => [i.code, i.qty, i.src]), [[P + '11', 4, 'manual']]); assert.deepEqual(r.unknown_codes, ['NOPE9']);
      assert.equal((await call(D, 'PATCH', `/api/meta-leads/${t3}`, { items: 'NOPE9' })).statusCode, 400);
      r = (await call(D, 'PATCH', `/api/meta-leads/${t3}`, { items: '' })).json(); assert.equal(r.items_manual, false); assert.equal(r.items[0].status, 'candidato');
      // 한 건 다시 매칭(API)
      const one1 = (await call(D, 'POST', '/api/meta-leads/match', { id: t1 })).json(); assert.equal(one1.items.length, 2);
    } finally {
      AI.setMetaAiCaller(null); if (keepKey) process.env.ANTHROPIC_API_KEY = keepKey; else delete process.env.ANTHROPIC_API_KEY;
      await query(`DELETE FROM product_applications WHERE product_id IN (SELECT id FROM products WHERE code LIKE $1)`, [P + '%']);
      await query(`DELETE FROM products WHERE code LIKE $1`, [P + '%']);
    }
  });

});
