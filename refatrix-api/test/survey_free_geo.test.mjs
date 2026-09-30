// 고객 설문 분석 — 양식에 없는 지역을 손글씨에서 찾기 (2026-09-30)
//
//   실행: TEST_PG_URL=postgres://... NODE_ENV=test node --test test/survey_free_geo.test.mjs
//
//   못 박는 것
//     · 「손으로 적은 지역」 문항(geo · free)은 저장해도 free 가 남고, 프롬프트에 「어디든 찾아라 · 인쇄된 글자 무시」 규칙이 붙는다
//     · 이미 읽은 장은 geo-scan 으로 **지역만** 다시 찾는다 — 다른 답·번호는 그대로
//     · 적힌 지역 없음 = 무응답(확인 필요 아님) · 모호한 도시(Guadalupe)는 주 미확인 · 사람이 고른 주는 다시 찾아도 유지
//     · 429 는 자동 재시도 · free 문항 없는 설문은 409 · 새로 올린 장은 본 판독에서 함께 찾는다
//     · 화면(jsdom): 지역 문항이 없으면 「손글씨 지역 찾기」 카드 → 문항 추가 + geo-scan 호출

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
process.env.NODE_ENV = 'test';
process.env.SURVEY_AI_CONCURRENCY = '1';
process.env.SURVEY_AI_PAUSE_MS = '50';

const S = await import('../src/surveyAi.js');

const BASE = [
  { text: 'Tipo de negocio', type: 'single', options: ['Refaccionaria', 'Taller', 'Otro'], seg: true },
  { text: 'Nombre del negocio', type: 'info' },
];
const FREE = { text: 'Ubicación escrita a mano', ko: '손으로 적은 지역', type: 'geo', free: true, seg: true };

// ── A. 순수 로직 ─────────────────────────────────────────────────────
test('A1. free 표시는 저장 후에도 남고, 일반 지역 문항에는 붙지 않는다', () => {
  const qs = S.normalizeQuestions([...BASE, FREE, { text: 'Estado', type: 'geo' }]).questions;
  assert.equal(qs[2].free, true);
  assert.equal(qs[2].options.length, 32);
  assert.equal(qs[3].free, undefined);
  assert.deepEqual(S.freeGeoQuestions(qs).map((q) => q.k), ['q3']);
  const again = S.normalizeQuestions(qs, qs).questions;
  assert.equal(again[2].free, true, '다시 저장해도 유지');
});

test('A2. 본 판독 프롬프트 — free 문항이 있을 때만 「어디든 · 인쇄 무시」 규칙', () => {
  const withFree = S.normalizeQuestions([...BASE, FREE]).questions;
  const without = S.normalizeQuestions(BASE).questions;
  const p1 = S.buildPagePrompt(withFree, '');
  assert.match(p1, /"free":true/);
  assert.match(p1, /NO está impresa/);
  assert.match(p1, /IGNORA todo texto IMPRESO/);
  assert.doesNotMatch(S.buildPagePrompt(without, ''), /NO está impresa/);
  const g = S.buildGeoScanPrompt(withFree);
  assert.match(g, /"k":"q3"/);
  assert.doesNotMatch(g, /Tipo de negocio/, '지역만 묻는다');
  assert.match(g, /LADA/, '전화 지역번호로 추측 금지');
});

test('A3. geo-scan 응답 해석 — 찾음 / 없음 / 모호 / 깨진 응답', () => {
  const qs = S.normalizeQuestions([...BASE, FREE]).questions;
  const a = S.parseGeoScanJson('```json\n{"q3":{"estado":"N.L.","ciudad":"Mty","donde":"margen superior"}}\n```', qs);
  assert.deepEqual(a.q3, { estado: 'Nuevo León', ciudad: 'Monterrey', raw: 'Mty, N.L.', at: 'margen superior' });
  assert.equal(S.parseGeoScanJson('{"q3":{"estado":"","ciudad":""}}', qs).q3, null);
  const amb = S.parseGeoScanJson('{"answers":{"q3":{"ciudad":"Guadalupe"}}}', qs).q3;
  assert.equal(amb.estado, null); assert.equal(amb.raw, 'Guadalupe');
  assert.equal(S.parseGeoScanJson('{"q3":"Mérida Yuc."}', qs).q3.estado, 'Yucatán', '문자열로 와도 받는다');
  assert.equal(S.parseGeoScanJson('no json', qs), null);
});

test('A4. 본 판독에서 free 지역의 위치(donde)도 남는다', () => {
  const qs = S.normalizeQuestions([...BASE, FREE]).questions;
  const r = S.normalizeAnswers({ q1: 'Taller', q2: 'X', q3: { estado: 'Coah.', ciudad: 'Saltillo', donde: 'al reverso' } }, {}, [], qs);
  assert.equal(r.answers.q3, 'Coahuila');
  assert.equal(r.geo.q3.at, 'al reverso');
});

// ── B. 화면 (jsdom) ──────────────────────────────────────────────────
test('B1. 지역 문항이 없으면 「손글씨 지역 찾기」 → 문항 추가(PUT free) → geo-scan(new)', async () => {
  let JSDOM;
  try { ({ JSDOM } = await import('jsdom')); } catch (_) { return; }       // jsdom 이 없으면 건너뜀
  const html = readFileSync(new URL('../../refatrix-survey.html', import.meta.url), 'utf8');
  const qs = S.normalizeQuestions(BASE).questions;
  let serverQs = qs;
  const log = [];
  const page = (id, n) => ({ id, seq: id, status: 'done', red_number: n, dup_idx: 1, file_name: 'EXPO_' + n + '.jpg',
    answers: { q1: 'Taller', q2: 'N' + id }, others: {}, geo: {}, low_conf: [], edited: {}, geo_scan: null });
  const dom = new JSDOM(html, {
    url: 'https://x.github.io/Refatrix/refatrix-survey.html', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 1, name: 'Dir', role: 'director' }, perm: { role: 'director' } }));
      w.confirm = () => true; w.scrollTo = () => {}; w.print = () => {};
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.fetch = async (url, opt = {}) => {
        const u = String(url); const m = (opt.method || 'GET').toUpperCase();
        log.push(m + ' ' + u.replace('https://api.test', '') + (opt.body && m !== 'GET' ? ' ' + opt.body : ''));
        let body = {};
        if (u.endsWith('/api/surveys') && m === 'GET') body = { items: [{ id: 7, title: 'Expo', code_prefix: 'EXPO', total: 2, done: 2 }] };
        else if (/\/api\/surveys\/7$/.test(u) && m === 'GET') body = { id: 7, title: 'Expo', code_prefix: 'EXPO', questions: serverQs, counts: { total: 2, done: 2 }, can_edit: true, is_director: true, ai_ready: true };
        else if (/\/api\/surveys\/7$/.test(u) && m === 'PUT') { serverQs = S.normalizeQuestions(JSON.parse(opt.body).questions, serverQs).questions; body = { ok: true, questions: serverQs, schema_changed: true, counts: { total: 2, done: 2 } }; }
        else if (/\/api\/surveys\/7\/pages$/.test(u)) body = { items: [page(1, '0001'), page(2, '0002')], counts: { total: 2, done: 2, geo_pending: log.some((l) => l.includes('geo-scan')) ? 2 : 0 }, ai_ready: true };
        else if (/geo-scan$/.test(u)) body = { ok: true, queued: 2, ai_ready: true, counts: { total: 2, done: 2, geo_pending: 2 } };
        return { ok: true, status: 200, json: async () => body, blob: async () => new w.Blob([]) };
      };
    },
  });
  const w = dom.window;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40 && !w.document.getElementById('surveySel')?.options.length; i++) await wait(25);
  const sel = w.document.getElementById('surveySel');
  if (sel && sel.value !== '7') { sel.value = '7'; sel.dispatchEvent(new w.Event('change')); }
  await wait(150);
  const rep = [...w.document.querySelectorAll('[data-tab="report"],#tabReport,.tab')].find((b) => /리포트/.test(b.textContent));
  if (rep) rep.click();
  await wait(150);
  const btn = w.document.getElementById('btnFreeGeo');
  assert.ok(btn, '지역 문항이 없으면 손글씨 지역 찾기 버튼이 보여야 한다');
  assert.match(w.document.getElementById('geoCards').textContent, /손으로 적은 지역 찾기/);
  btn.click();
  await wait(200);
  const put = log.find((l) => l.startsWith('PUT /api/surveys/7 '));
  assert.ok(put, '문항 저장 호출');
  const sent = JSON.parse(put.slice(put.indexOf('{')));
  const last = sent.questions[sent.questions.length - 1];
  assert.equal(last.type, 'geo'); assert.equal(last.free, true);
  assert.equal(sent.questions.length, 3, '기존 문항은 그대로');
  assert.ok(log.some((l) => l.startsWith('POST /api/surveys/7/geo-scan') && l.includes('"scope":"new"')), 'geo-scan(new) 호출');
  assert.ok(!log.some((l) => l.includes('/reprocess')), '전체 재판독은 하지 않는다');
  assert.match(w.document.getElementById('cRunChip').textContent, /지역 찾는 중 2/);
  w.close();
});

// ── C. 실 DB 종단 ────────────────────────────────────────────────────
const dbTest = PG ? test : test.skip;
const fakeJpeg = (marker) => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from(marker)]);

dbTest('C. 읽어 둔 장에서 지역만 찾기 · 없음/모호/사람 선택 유지 · 재시도 · 새 업로드 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const R = await import('../src/routes/surveyRoutes.js');

  // 가짜 Claude — 표식 MK:번호|손글씨(주;도시;위치 또는 빈칸)|RATE
  const geoCalls = []; let fail429 = 1;
  R.surveyAiApi.call = async (content) => {
    const media = content.find((b) => b.type === 'image');
    const text = content.find((b) => b.type === 'text').text;
    const raw = Buffer.from(media.source.data, 'base64').toString('utf8');
    const m = /MK:([^|]*)\|([^|]*)\|?([A-Z]*)/.exec(raw) || [];
    const [st = '', ci = '', at = ''] = (m[2] || '').split(';');
    if (text.includes('Claves a llenar')) {                    // 지역만 찾기
      geoCalls.push(m[1]);
      if (m[3] === 'RATE' && fail429 > 0) { fail429--; return { ok: false, status: 429, error: 'ai: rate', transient: true }; }
      return { ok: true, text: JSON.stringify({ q3: { estado: st, ciudad: ci, donde: at } }) };
    }
    const hasFree = text.includes('"free":true');
    return { ok: true, text: JSON.stringify({ red_number: m[1], red_number_confidence: 'high',
      answers: { q1: 'Taller', q2: 'Negocio ' + m[1], ...(hasFree ? { q3: { estado: st, ciudad: ci, donde: at } } : {}) }, low_confidence: [] }) };
  };
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET, sign: { expiresIn: '1h' } });
  app.register(R.default);
  await app.ready();

  const TAG = 'FG' + String(Date.now()).slice(-6);
  const dir = Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x',$2) RETURNING id`,
    ['Dir' + TAG, ('dir' + TAG).toLowerCase()])).rows[0].id);
  t.after(async () => {
    await query(`DELETE FROM surveys WHERE created_by = $1 OR updated_by = $1`, [dir]).catch(() => {});
    await query(`DELETE FROM audit_log WHERE user_id = $1`, [dir]).catch(() => {});
    await query(`DELETE FROM users WHERE id = $1`, [dir]);
    await app.close(); await pool.end();
  });
  const H = { authorization: 'Bearer ' + app.jwt.sign({ sub: dir }) };
  const call = async (method, url, payload) => {
    const r = await app.inject({ method, url, headers: H, payload });
    let j = null; try { j = r.json(); } catch (_) {}
    return { code: r.statusCode, j };
  };
  const pages = async (sid) => (await call('GET', `/api/surveys/${sid}/pages`)).j;

  const sid = (await call('POST', '/api/surveys', { title: 'Expo ' + TAG, code_prefix: 'expo26' })).j.id;
  assert.equal((await call('PUT', `/api/surveys/${sid}`, { questions: BASE })).code, 200);
  for (const mk of ['MK:0001|N.L.;Mty;margen superior', 'MK:0002|', 'MK:0003|;Guadalupe;junto al nombre|RATE', 'MK:0004|Yuc.;Mérida;pie']) {
    assert.equal((await call('POST', `/api/surveys/${sid}/pages`, { mime: 'image/jpeg', file_b64: fakeJpeg(mk).toString('base64') })).code, 200);
  }
  assert.ok(await R.drainForTest());
  let L = await pages(sid);
  assert.equal(L.counts.done, 4);
  assert.equal(L.items[0].geo_scan, null, '지역 문항이 없을 때는 대상 아님');

  // free 문항이 없으면 409
  assert.equal((await call('POST', `/api/surveys/${sid}/geo-scan`, {})).j.error, 'no_free_geo');

  // 사람이 0004 의 업종을 고쳐 둔다 — 지역 찾기가 건드리면 안 된다
  const p4 = L.items.find((p) => p.red_number === '0004');
  assert.equal((await call('PATCH', `/api/surveys/pages/${p4.id}`, { answers: { q1: 'Refaccionaria' } })).code, 200);

  // 손으로 적은 지역 문항 추가 → 지역만 찾기
  const put = await call('PUT', `/api/surveys/${sid}`, { questions: [...(await call('GET', `/api/surveys/${sid}`)).j.questions, FREE] });
  assert.equal(put.code, 200); assert.equal(put.j.questions[2].free, true);
  const gs = await call('POST', `/api/surveys/${sid}/geo-scan`, { scope: 'new' });
  assert.equal(gs.j.queued, 4); assert.equal(gs.j.counts.geo_pending, 4);
  assert.ok(await R.drainForTest());
  L = await pages(sid);
  const by = Object.fromEntries(L.items.map((p) => [p.red_number, p]));
  assert.equal(L.counts.geo_pending, 0); assert.equal(L.counts.geo_error, 0);
  assert.equal(by['0001'].answers.q3, 'Nuevo León');
  assert.deepEqual(by['0001'].geo.q3, { estado: 'Nuevo León', ciudad: 'Monterrey', raw: 'Mty, N.L.', at: 'margen superior' });
  assert.equal(by['0002'].answers.q3, null, '적힌 지역 없음 = 무응답');
  assert.ok(!by['0002'].low_conf.includes('q3'), '무응답은 확인 필요가 아니다');
  assert.equal(by['0003'].answers.q3, null); assert.equal(by['0003'].geo.q3.raw, 'Guadalupe');
  assert.ok(by['0003'].low_conf.includes('q3'), '모호한 도시는 주 미확인');
  assert.equal(by['0004'].answers.q3, 'Yucatán');
  assert.equal(by['0004'].answers.q1, 'Refaccionaria', '사람이 고친 다른 칸은 그대로');
  assert.equal(by['0001'].answers.q2, 'Negocio 0001', '다른 답은 그대로');
  assert.equal(by['0001'].red_number, '0001');
  assert.equal(geoCalls.filter((x) => x === '0003').length, 2, '429 는 한 번 더 시도');

  // 사람이 0003 의 주를 고른다 → 전체 다시 찾아도 유지
  assert.equal((await call('PATCH', `/api/surveys/pages/${by['0003'].id}`, { geo: { q3: { estado: 'Nuevo León', ciudad: 'Guadalupe' } } })).code, 200);
  assert.equal((await call('POST', `/api/surveys/${sid}/geo-scan`, { scope: 'new' })).j.queued, 0, 'new = 아직 안 찾은 장만');
  assert.equal((await call('POST', `/api/surveys/${sid}/geo-scan`, { scope: 'all' })).j.queued, 4);
  assert.ok(await R.drainForTest());
  L = await pages(sid);
  const p3 = L.items.find((p) => p.red_number === '0003');
  assert.equal(p3.answers.q3, 'Nuevo León'); assert.equal(p3.geo.q3.ciudad, 'Guadalupe'); assert.equal(p3.geo.q3.at, 'junto al nombre');
  assert.ok(!p3.low_conf.includes('q3'));

  // 새로 올린 장은 본 판독에서 함께 찾는다(별도 호출 없음)
  const before = geoCalls.length;
  await call('POST', `/api/surveys/${sid}/pages`, { mime: 'image/jpeg', file_b64: fakeJpeg('MK:0005|Jal.;GDL;margen').toString('base64') });
  assert.ok(await R.drainForTest());
  const p5 = (await pages(sid)).items.find((p) => p.red_number === '0005');
  assert.equal(p5.answers.q3, 'Jalisco'); assert.equal(p5.geo.q3.at, 'margen'); assert.equal(p5.geo_scan, 'done');
  assert.equal(geoCalls.length, before, '지역만 따로 부르지 않는다');

  // 기존 지역 다시 정리(무AI)도 free 문항에 동작
  const gn = await call('POST', `/api/surveys/${sid}/geo-normalize`, {});
  assert.equal(gn.code, 200); assert.equal(gn.j.scanned, 5);
});
