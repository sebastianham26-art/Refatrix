// 고객 설문 — 외부 열람 계정 + 스페인어 결과 페이지 (2026-09-30, build 20260930sv8)
//   sv8: ERP 분석 리포트와 동일 — AI 요약(스페인어 번역 캐시)·서술형 주제·응답 목록·원본 이미지 · 헤더 링크 제거
//
//   실행: TEST_PG_URL=postgres://... NODE_ENV=test node --test test/survey_public.test.mjs
//   (C 는 TEST_PG_URL, B·D 는 jsdom 이 있어야 돈다)
//
//   못 박는 것
//     · 익명 데이터: 기재정보(이름·상호·전화)·서술형 원문·붉은 번호·손글씨 원문이 **응답에 없다**
//     · 열람 토큰으로 ERP API 는 401 · 허락 안 한 설문 404 · 정지/비밀번호 재발급 → 기존 토큰 즉시 401
//     · 5회 실패 → 잠금(429) · 없는 아이디와 틀린 비밀번호는 같은 응답 · 계정 관리는 디렉터만
//     · 결과 페이지: 로그인 → 스페인어 렌더(한글 0자) · 세션 만료 → 로그인 화면 · 데이터 파일(mx_survey_data.js) 안 씀
//     · ERP: 디렉터에게만 [🔐 외부 열람 계정], 만들면 스페인어 안내문(주소·아이디·비밀번호)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
process.env.NODE_ENV = 'test';

const REPO = new URL('../../', import.meta.url);
const read = (f) => readFileSync(new URL(f, REPO), 'utf8');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch (_) {}
const jt = JSDOM ? test : test.skip;
const dbTest = PG ? test : test.skip;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HANGUL = /[가-힣]/;

const QUESTIONS = [
  { k: 'q1', no: 1, type: 'info', text: 'Nombre:', ko: '이름' },
  { k: 'q2', no: 2, type: 'info', text: 'Empresa / Refaccionaria / Taller:', ko: '회사명' },
  { k: 'q3', no: 3, type: 'info', text: 'Teléfono:', ko: '전화번호' },
  { k: 'q4', no: 4, type: 'single', seg: true, text: 'Puesto:', ko: '직책', options: ['Mecánico / Técnico', 'Dueño / Gerente', 'Refaccionaria', 'Otro'] },
  { k: 'q6', no: 5, type: 'multi', text: '2. ¿Qué marcas atiendes? (Máx. 3)', ko: '브랜드', options: ['Nissan', 'Chevrolet', 'Volkswagen', 'Toyota'] },
  { k: 'q7', no: 6, type: 'scale', text: '5. ¿Qué tan satisfecho estás?', ko: '만족도', min: 1, max: 5, min_label: 'Nada', max_label: 'Mucho' },
  { k: 'q11', no: 7, type: 'text', text: 'Comentarios', ko: '의견' },
  { k: 'q12', no: 8, type: 'geo', free: true, seg: true, text: 'Ubicación escrita a mano', ko: '손으로 적은 지역', options: [] },
];
const PAGES = [
  { status: 'done', answers: { q1: 'Juan Pérez', q2: 'Taller Pérez', q3: '81-1111-2222', q4: 'Mecánico / Técnico', q6: ['Nissan', 'Toyota'], q7: 5, q11: 'Muy buen precio, llamen a Juan', q12: 'Nuevo León' }, geo: { q12: { estado: 'Nuevo León', ciudad: 'Monterrey', raw: 'Mty, N.L. casa de Juan', at: 'margen' } } },
  { status: 'done', answers: { q1: 'Ana Ruiz', q2: 'Refacciones Ruiz', q3: '999-123-4567', q4: 'Dueño / Gerente', q6: ['Chevrolet'], q7: 3, q11: '', q12: 'Yucatán' }, geo: { q12: { estado: 'Yucatán', ciudad: 'Mérida', raw: 'Mérida Yuc.' } } },
  { status: 'done', answers: { q1: 'Luis', q2: 'X', q3: '1', q4: 'Mecánico / Técnico', q6: [], q7: 4, q11: 'Entrega rápida', q12: null }, geo: { q12: { estado: null, ciudad: 'Guadalupe', raw: 'Guadalupe' } } },
  { status: 'done', answers: { q1: 'Pedro', q2: 'Y', q3: '2', q4: 'Refaccionaria', q6: ['Nissan'], q7: null, q11: '', q12: 'Nuevo León' }, geo: { q12: { estado: 'Nuevo León', ciudad: 'Apodaca', raw: 'Apodaca' } } },
  { status: 'queued', answers: null, geo: {} },
];
const SECRETS = ['Juan', 'Pérez', 'Ana Ruiz', 'Refacciones Ruiz', '81-1111-2222', '999-123-4567', 'llamen', 'Entrega rápida', 'casa de', 'Mty, N.L.', 'margen', '가격', '이름', '직책'];

// ── A. 익명 데이터 ─────────────────────────────────────────────────
test('A. 익명 데이터 — 기재정보·원문·번호 없음, 문항 구성·지역·주제 건수', async () => {
  const { buildPublicSurveyData } = await import('../src/surveyPublic.js');
  const D = buildPublicSurveyData({ title: 'RUJAC_01', survey_date: '2026-09-14', questions: QUESTIONS,
    ai_cache: { themes: { q11: [{ name: 'Precio', ko: '가격', summary_ko: '가격 좋음', ids: [1] }, { name: 'Entrega', ko: '배송', ids: [3] }] } } },
  PAGES, { uploaded: 5, today: '2026-09-30' });
  const txt = JSON.stringify(D);
  for (const s of SECRETS) assert.ok(!txt.includes(s), '공개 데이터에 들어가면 안 됨: ' + s);
  assert.ok(!HANGUL.test(txt), '한글 없음');
  assert.deepEqual(D.questions.map((q) => q.k), ['q4', 'q6', 'q7', 'q12']);
  assert.equal(D.rows.length, 4); assert.equal(D.uploaded, 5);
  const geo = D.rows.map((r) => r[3]).filter(Boolean);
  assert.ok(geo.some((g) => g[0] === null && g[2] === 1), '주 미확인은 표시만');
  assert.ok(geo.some((g) => g[0] === 'Nuevo León' && g[1] === 'Monterrey'));
  assert.deepEqual(D.themes, [{ title: 'Comentarios', basis: 2, items: [{ name: 'Precio', count: 1 }, { name: 'Entrega', count: 1 }] }]);
});

// ── B. 결과 페이지 (jsdom) ──────────────────────────────────────────
async function openPage({ loginOk = true, dataStatus = 200, stored = null } = {}) {
  const { buildPublicSurveyData } = await import('../src/surveyPublic.js');
  const DATA = buildPublicSurveyData({ title: 'RUJAC_01', survey_date: '2026-09-14', questions: QUESTIONS }, PAGES, { uploaded: 5 });
  DATA.all_questions = QUESTIONS.map(({ ko, ...q }) => q);
  DATA.responses = PAGES.map((p, i) => ({ id: i + 1, seq: i + 1, folio: p.status === 'done' ? '010' + (i + 1) : null, status: p.status, file_name: 'RUJAC_010' + (i + 1) + '.jpg',
    mime: 'image/jpeg', has_view: true, has_thumb: true, answers: p.answers, others: {}, geo: p.geo || {}, low_conf: i === 2 ? ['q12'] : [] }));
  DATA.ai = { generated_at: '2026-09-30T10:00:00Z', translated: true, bullets: ['Los mecánicos valoran la calidad (muestra pequeña).'],
    themes: { q11: [{ name: 'Precio', summary: 'Piden mejores precios.', ids: [1] }, { name: 'Entrega', summary: 'Quieren entrega rápida.', ids: [3] }] } };
  const log = [];
  const dom = new JSDOM(read('mx_survey_analysis.html'), {
    url: 'https://erp.refatrix.com/mx_survey_analysis.html', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
      if (stored) w.sessionStorage.setItem('rfx_survey_viewer', JSON.stringify(stored));
      w.fetch = async (url, opt = {}) => {
        const u = String(url); log.push({ u, opt });
        let status = 200; let body = {};
        if (u.endsWith('/api/survey-viewer/login')) {
          const b = JSON.parse(opt.body);
          if (loginOk && b.login === 'dev.juan' && b.password === 'Secreto123') body = { token: 'tok', name: 'Juan', surveys: [{ id: 2, title: 'RUJAC_01', date: '2026-09-14' }] };
          else { status = 401; body = { error: 'invalid_credentials' }; }
        } else if (u.endsWith('/api/survey-viewer/surveys')) body = { name: 'Juan', surveys: [{ id: 2, title: 'RUJAC_01', date: '2026-09-14' }] };
        else if (u.endsWith('/api/survey-viewer/surveys/2')) { status = dataStatus; body = dataStatus === 200 ? DATA : { error: 'unauthorized' }; }
        else if (/\/api\/survey-viewer\/pages\/\d+\/(thumb|view|file)$/.test(u)) return { ok: true, status: 200, blob: async () => new w.Blob(['x'], { type: 'image/jpeg' }), json: async () => ({}) };
        return { ok: status < 400, status, json: async () => body };
      };
    },
  });
  await wait(30);
  return { w: dom.window, d: dom.window.document, log };
}
async function submit(d, w, user, pass) {
  d.getElementById('lgUser').value = user; d.getElementById('lgPass').value = pass;
  d.getElementById('loginForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await wait(60);
}

jt('B1. 로그인 전에는 로그인 화면만 · 틀리면 스페인어 오류 · 맞으면 스페인어 결과(한글 0자)', async () => {
  const { w, d, log } = await openPage();
  assert.ok(!d.getElementById('login').classList.contains('hidden'));
  assert.match(d.body.textContent, /Acceso a resultados de encuesta/);
  assert.ok(!log.some((x) => x.u.includes('/surveys/')), '로그인 전 데이터 요청 없음');
  assert.ok(!read('mx_survey_analysis.html').includes('mx_survey_data.js'), '공개 데이터 파일을 읽지 않는다');
  await submit(d, w, 'dev.juan', 'mal');
  assert.match(d.getElementById('lgMsg').textContent, /Usuario o contraseña incorrectos/);
  await submit(d, w, 'dev.juan', 'Secreto123');
  assert.ok(d.getElementById('login').classList.contains('hidden'));
  const dataReq = log.find((x) => x.u.endsWith('/api/survey-viewer/surveys/2'));
  assert.equal(dataReq.opt.headers.Authorization, 'Bearer tok');
  assert.ok(dataReq.u.startsWith('https://refatrix-production.up.railway.app/'), 'API 주소 고정');
  const t = d.body.textContent;
  assert.match(t, /Encuesta de clientes · RUJAC_01/);
  assert.match(t, /Respuestas analizadas/); assert.match(t, /Ubicación del cliente \(escrita a mano\)/);
  assert.equal(d.querySelectorAll('svg.map path').length, 32);
  assert.match(t, /Comparación por segmento/);
  // AI 요약(스페인어)·서술형 주제+요약+인용
  assert.match(t, /Resumen IA/); assert.match(t, /Los mecánicos valoran la calidad/);
  assert.match(t, /Comentarios abiertos/); assert.match(t, /Piden mejores precios/); assert.match(t, /llamen a Juan/);
  // 헤더에는 다른 링크가 없다
  assert.equal(d.querySelectorAll('header a').length, 0, '헤더 링크 없음');
  assert.ok(!/mx_coverage_map|mx_dev_projects|mx_parts_coverage_dashboard/.test(read('mx_survey_analysis.html')), '다른 페이지로 가는 링크 없음');
  assert.match(d.getElementById('who').textContent, /Juan/);
  assert.ok(!HANGUL.test(d.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/g, '')), '화면에 한글 없음');
  assert.ok(!HANGUL.test(read('mx_survey_analysis.html')), '파일에 한글 없음');
  // 응답 목록 탭 → 상세(원본 이미지는 인증 요청)
  d.querySelector('[data-tab="resp"]').click(); await wait(30);
  assert.match(d.body.textContent, /Juan Pérez/); assert.match(d.body.textContent, /81-1111-2222/); assert.match(d.body.textContent, /RUJAC_0101\.jpg/);
  assert.match(d.body.textContent, /En cola/);
  const rF = d.getElementById('rF'); rF.value = 'flag'; rF.dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelectorAll('tr[data-r]').length, 1, '확신 낮음 1건');
  rF.value = ''; rF.dispatchEvent(new w.Event('change'));
  const rQ = d.getElementById('rQ'); rQ.value = 'ruiz'; rQ.dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('tr[data-r]').length, 1, '검색');
  d.querySelector('tr[data-r]').click(); await wait(40);
  assert.ok(d.getElementById('drawer').classList.contains('on'));
  assert.match(d.getElementById('drawer').textContent, /Refacciones Ruiz/);
  assert.ok(d.querySelector('#dImg img'), '원본 이미지 표시');
  const viewReq = log.find((x) => /\/pages\/2\/view$/.test(x.u));
  assert.ok(viewReq && viewReq.opt.headers.Authorization === 'Bearer tok', '이미지도 토큰으로');
  assert.ok(!HANGUL.test(d.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/g, '')), '응답 탭에도 한글 없음');
  d.getElementById('dX').click();
  d.querySelector('[data-tab="rep"]').click(); await wait(20);
  // 필터
  const fSeg = d.getElementById('fSeg'); fSeg.value = 'q4'; fSeg.dispatchEvent(new w.Event('change'));
  const fVal = d.getElementById('fVal'); fVal.value = 'Mecánico / Técnico'; fVal.dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelector('.kpi .v').textContent, '2');
  // 로그아웃
  d.getElementById('btnOut').click();
  assert.ok(!d.getElementById('login').classList.contains('hidden'));
  assert.equal(w.sessionStorage.getItem('rfx_survey_viewer'), null);
  w.close();
});

jt('B2. 세션이 끝났거나 계정이 정지되면(401) 로그인 화면으로', async () => {
  const { w, d } = await openPage({ stored: { token: 'old', name: 'Juan', surveys: [] }, dataStatus: 401 });
  await wait(60);
  assert.ok(!d.getElementById('login').classList.contains('hidden'));
  assert.match(d.getElementById('lgMsg').textContent, /Tu sesión terminó/);
  assert.equal(d.getElementById('app').textContent, '');
  w.close();
});

// ── C. 실 DB 종단 ───────────────────────────────────────────────────
dbTest('C. 열람 계정 — 만들기·로그인·익명 데이터·ERP 차단·설문 제한·정지/재발급·잠금·디렉터 전용 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const R = await import('../src/routes/surveyRoutes.js');
  let aiCalls = 0;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  R.surveyAiApi.call = async (content) => {
    const text = content.find((b) => b.type === 'text').text;
    if (text.includes('Traduce al español')) { aiCalls++; return { ok: true, text: JSON.stringify({ bullets: ['Resumen en español.'], themes: { q11: ['Buenos precios.'] } }) }; }
    return { ok: false, error: 'unexpected', transient: false };
  };
  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET, sign: { expiresIn: '1h' } });
  app.register(R.default);
  await app.ready();

  const TAG = 'VW' + String(Date.now()).slice(-6);
  const mk = async (name, role) => Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name + TAG, role, (name + TAG).toLowerCase()])).rows[0].id);
  const dir = await mk('Dir', 'director');
  const mkt = await mk('Mkt', 'marketing');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'marketing','anywhere','edit')`, [mkt]);
  const s1 = Number((await query(`INSERT INTO surveys (title, code_prefix, survey_date, questions, ai_cache, created_by) VALUES ($1,'RUJAC','2026-09-14',$2,$3,$4) RETURNING id`,
    ['RUJAC ' + TAG, JSON.stringify(QUESTIONS), JSON.stringify({ generated_at: '2026-09-30T10:00:00Z', bullets: ['정비사는 품질을 중시'], themes: { q11: [{ name: 'Precio', ko: '가격', summary_ko: '가격이 좋다', ids: [1] }] } }), dir])).rows[0].id);
  const s2 = Number((await query(`INSERT INTO surveys (title, code_prefix, questions, created_by) VALUES ($1,'OTRA',$2,$3) RETURNING id`, ['Otra ' + TAG, JSON.stringify(QUESTIONS), dir])).rows[0].id);
  let seq = 0;
  for (const p of PAGES) {
    seq++;
    await query(`INSERT INTO survey_pages (survey_id, seq, mime, file_data, file_sha, status, answers, geo, red_number, uploaded_by)
                 VALUES ($1,$2,'image/jpeg',$3,$4,$5,$6,$7,$8,$9)`,
    [s1, seq, Buffer.from([0xFF, 0xD8, 0xFF, seq]), TAG + seq, p.status, p.answers ? JSON.stringify(p.answers) : null, JSON.stringify(p.geo || {}), '01' + String(seq).padStart(2, '0'), dir]).catch(async (e) => {
      throw new Error('insert page: ' + e.message);
    });
  }
  t.after(async () => {
    await query(`DELETE FROM survey_viewers WHERE login LIKE $1`, ['%' + TAG.toLowerCase() + '%']).catch(() => {});
    await query(`DELETE FROM survey_pages WHERE survey_id = ANY($1::bigint[])`, [[s1, s2]]).catch(() => {});
    await query(`DELETE FROM surveys WHERE id = ANY($1::bigint[])`, [[s1, s2]]).catch(() => {});
    await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [[dir, mkt]]).catch(() => {});
    await query(`DELETE FROM user_page_access WHERE user_id = ANY($1::bigint[])`, [[dir, mkt]]);
    await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [[dir, mkt]]);
    await app.close(); await pool.end();
  });
  const call = async (token, method, url, payload) => {
    const r = await app.inject({ method, url, headers: token ? { authorization: 'Bearer ' + token } : {}, payload });
    let j = null; try { j = r.json(); } catch (_) {}
    return { code: r.statusCode, j, raw: r.payload };
  };
  const erp = (uid) => app.jwt.sign({ sub: uid });
  const login = 'dev.' + TAG.toLowerCase();

  // 관리 — 디렉터만 · 검증
  assert.equal((await call(erp(mkt), 'GET', '/api/surveys/viewers')).code, 403, '마케팅 편집권한이어도 디렉터가 아니면 403');
  assert.equal((await call(erp(dir), 'POST', '/api/surveys/viewers', { login: 'A B', password: 'Secreto123', survey_ids: [s1] })).j.error, 'bad_login');
  assert.equal((await call(erp(dir), 'POST', '/api/surveys/viewers', { login, password: 'corta1', survey_ids: [s1] })).j.error, 'password_short');
  assert.equal((await call(erp(dir), 'POST', '/api/surveys/viewers', { login, password: 'soloLetras', survey_ids: [s1] })).j.error, 'password_weak');
  const cr = await call(erp(dir), 'POST', '/api/surveys/viewers', { login: login.toUpperCase(), name: 'Juan · Prov', password: 'Secreto123', survey_ids: [s1] });
  assert.equal(cr.code, 200, cr.raw); assert.equal(cr.j.item.login, login); assert.deepEqual(cr.j.item.survey_ids, [s1]);
  assert.ok(!cr.raw.includes('Secreto123') && !cr.raw.includes('pass_hash'), '비밀번호·해시는 돌려주지 않는다');
  assert.equal((await call(erp(dir), 'POST', '/api/surveys/viewers', { login, password: 'Secreto123' })).code, 409);
  const vid = cr.j.item.id;

  // 로그인
  const bad = await call(null, 'POST', '/api/survey-viewer/login', { login, password: 'Nope12345' });
  const ghost = await call(null, 'POST', '/api/survey-viewer/login', { login: 'nadie.' + TAG.toLowerCase(), password: 'Nope12345' });
  assert.equal(bad.code, 401); assert.deepEqual(ghost.j, bad.j, '없는 아이디와 틀린 비밀번호는 같은 응답');
  const lg = await call(null, 'POST', '/api/survey-viewer/login', { login: '  ' + login.toUpperCase() + ' ', password: 'Secreto123' });
  assert.equal(lg.code, 200, lg.raw); assert.deepEqual(lg.j.surveys.map((x) => x.id), [s1]);
  const tok = lg.j.token;

  // 데이터 — ERP 와 동일(디렉터 결정): 응답 목록에 이름·전화·번호, AI 요약은 스페인어로 한 번 번역해 캐시
  const dd = await call(tok, 'GET', `/api/survey-viewer/surveys/${s1}`);
  assert.equal(dd.code, 200, dd.raw);
  assert.equal(dd.j.rows.length, 4); assert.equal(dd.j.uploaded, 5);
  assert.equal(dd.j.responses.length, 5);
  const r1 = dd.j.responses.find((r) => r.folio === '0101');
  assert.equal(r1.answers.q1, 'Juan Pérez'); assert.equal(r1.file_name, 'RUJAC_0101.jpg');
  assert.ok(!('ko' in dd.j.all_questions[0]), '한국어 번역 필드는 보내지 않는다');
  assert.ok(!HANGUL.test(JSON.stringify({ q: dd.j.all_questions, ai: dd.j.ai })), '문항·AI 요약에 한글 없음');
  assert.deepEqual(dd.j.ai.bullets, ['Resumen en español.']);
  assert.equal(dd.j.ai.themes.q11[0].name, 'Precio'); assert.equal(dd.j.ai.themes.q11[0].summary, 'Buenos precios.');
  assert.equal(aiCalls, 1);
  await call(tok, 'GET', `/api/survey-viewer/surveys/${s1}`);
  assert.equal(aiCalls, 1, '번역은 캐시 — 두 번째 열람은 AI 호출 없음');
  await query(`UPDATE surveys SET ai_cache = jsonb_set(ai_cache, '{generated_at}', '"2026-10-01T00:00:00Z"') WHERE id=$1`, [s1]);
  await call(tok, 'GET', `/api/survey-viewer/surveys/${s1}`);
  assert.equal(aiCalls, 2, 'ERP 에서 요약을 다시 만들면 다시 번역');
  assert.equal((await call(tok, 'GET', `/api/survey-viewer/surveys/${s2}`)).code, 404, '허락 안 한 설문');
  // 원본 이미지 — 허락된 설문 페이지만
  const p1 = dd.j.responses[0].id;
  const img = await app.inject({ method: 'GET', url: `/api/survey-viewer/pages/${p1}/view`, headers: { authorization: 'Bearer ' + tok } });
  assert.equal(img.statusCode, 200); assert.equal(img.headers['content-type'], 'image/jpeg');
  const fl = await app.inject({ method: 'GET', url: `/api/survey-viewer/pages/${p1}/file`, headers: { authorization: 'Bearer ' + tok } });
  assert.match(fl.headers['content-disposition'], /RUJAC_0101\.jpg/);
  const other = Number((await query(`INSERT INTO survey_pages (survey_id, seq, mime, file_data, status, uploaded_by) VALUES ($1,1,'image/jpeg',$2,'done',$3) RETURNING id`, [s2, Buffer.from([0xFF, 0xD8, 0xFF, 9]), dir])).rows[0].id);
  await call(erp(dir), 'PATCH', `/api/surveys/viewers/${vid}`, { survey_ids: [s1] });
  assert.equal((await call(tok, 'GET', `/api/survey-viewer/pages/${other}/view`)).code, 404, '다른 설문 페이지 이미지 불가');
  assert.equal((await call(erp(dir), 'GET', `/api/survey-viewer/pages/${p1}/view`)).code, 401, 'ERP 토큰으로 열람 이미지 API 불가');

  // ERP 는 열리지 않는다
  for (const u of ['/api/surveys', `/api/surveys/${s1}`, `/api/surveys/${s1}/pages`, '/api/surveys/viewers']) {
    assert.equal((await call(tok, 'GET', u)).code, 401, 'ERP 차단: ' + u);
  }
  assert.equal((await call(erp(dir), 'GET', '/api/survey-viewer/surveys')).code, 401, 'ERP 토큰으로 열람 API 불가');

  // 설문 권한 변경 → 즉시 반영
  assert.equal((await call(erp(dir), 'PATCH', `/api/surveys/viewers/${vid}`, { survey_ids: [s1, s2] })).code, 200);
  assert.equal((await call(tok, 'GET', `/api/survey-viewer/surveys/${s2}`)).code, 200);

  // 비밀번호 재발급 → 기존 토큰 무효
  assert.equal((await call(erp(dir), 'PATCH', `/api/surveys/viewers/${vid}`, { password: 'Nuevo4567x' })).code, 200);
  assert.equal((await call(tok, 'GET', '/api/survey-viewer/surveys')).code, 401, '재발급 후 기존 토큰 무효');
  assert.equal((await call(null, 'POST', '/api/survey-viewer/login', { login, password: 'Secreto123' })).code, 401);
  const tok2 = (await call(null, 'POST', '/api/survey-viewer/login', { login, password: 'Nuevo4567x' })).j.token;
  assert.ok(tok2);

  // 정지 → 즉시 무효, 재개 → 다시 로그인 가능
  assert.equal((await call(erp(dir), 'PATCH', `/api/surveys/viewers/${vid}`, { active: false })).code, 200);
  assert.equal((await call(tok2, 'GET', '/api/survey-viewer/surveys')).code, 401);
  assert.equal((await call(null, 'POST', '/api/survey-viewer/login', { login, password: 'Nuevo4567x' })).code, 401);
  assert.equal((await call(erp(dir), 'PATCH', `/api/surveys/viewers/${vid}`, { active: true })).code, 200);

  // 5회 실패 → 잠금(맞는 비밀번호도 429) → 디렉터 잠금 해제
  for (let i = 0; i < 5; i++) await call(null, 'POST', '/api/survey-viewer/login', { login, password: 'Mal12345' + i });
  const lk = await call(null, 'POST', '/api/survey-viewer/login', { login, password: 'Nuevo4567x' });
  assert.equal(lk.code, 429); assert.equal(lk.j.error, 'locked');
  assert.equal((await call(erp(dir), 'GET', '/api/surveys/viewers')).j.items.find((x) => x.id === vid).locked, true);
  assert.equal((await call(erp(dir), 'PATCH', `/api/surveys/viewers/${vid}`, { unlock: true })).code, 200);
  assert.equal((await call(null, 'POST', '/api/survey-viewer/login', { login, password: 'Nuevo4567x' })).code, 200);

  // 삭제
  assert.equal((await call(erp(dir), 'DELETE', `/api/surveys/viewers/${vid}`)).code, 200);
  assert.equal((await call(null, 'POST', '/api/survey-viewer/login', { login, password: 'Nuevo4567x' })).code, 401);
});

// ── D. ERP 관리 화면 (jsdom) ────────────────────────────────────────
async function openErp(role) {
  const log = [];
  let items = [];
  const dom = new JSDOM(read('refatrix-survey.html'), {
    url: 'https://erp.refatrix.com/refatrix-survey.html', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 1, name: 'U', role }, perm: { role } }));
      w.confirm = () => true; w.scrollTo = () => {}; w.print = () => {}; w.prompt = () => null;
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.fetch = async (url, opt = {}) => {
        const u = String(url).replace('https://api.test', ''); const m = (opt.method || 'GET').toUpperCase();
        log.push(m + ' ' + u + (opt.body && m !== 'GET' ? ' ' + opt.body : ''));
        let body = {};
        if (u === '/api/surveys' && m === 'GET') body = { items: [{ id: 2, title: 'RUJAC_01', code_prefix: 'RUJAC', total: 5, done: 4 }] };
        else if (u === '/api/surveys/2') body = { id: 2, title: 'RUJAC_01', code_prefix: 'RUJAC', questions: QUESTIONS, counts: { total: 5, done: 4 }, can_edit: true, is_director: role === 'director', ai_ready: true };
        else if (u === '/api/surveys/2/pages') body = { items: [], counts: { total: 5, done: 4 }, ai_ready: true };
        else if (u === '/api/surveys/viewers' && m === 'GET') body = { items };
        else if (u === '/api/surveys/viewers' && m === 'POST') { const b = JSON.parse(opt.body); const it = { id: 9, login: b.login, name: b.name, active: true, survey_ids: b.survey_ids, locked: false }; items = [it]; body = { ok: true, item: it }; }
        return { ok: true, status: 200, json: async () => body, blob: async () => new w.Blob([]) };
      };
    },
  });
  const w = dom.window;
  for (let i = 0; i < 40 && !w.document.getElementById('surveySel')?.options.length; i++) await wait(25);
  const sel = w.document.getElementById('surveySel');
  if (sel && sel.value !== '2') { sel.value = '2'; sel.dispatchEvent(new w.Event('change')); }
  await wait(150);
  return { w, d: w.document, log };
}

jt('D1. 디렉터: [🔐 외부 열람 계정] → 계정 만들기 → 스페인어 안내문(주소·아이디·비밀번호)', async () => {
  const { w, d, log } = await openErp('director');
  const btn = d.getElementById('btnViewers');
  assert.ok(!btn.classList.contains('hidden'));
  assert.ok(!d.getElementById('btnPublish'), '공개 데이터 파일 내보내기는 없앴다');
  btn.click(); await wait(60);
  assert.ok(d.getElementById('vwDrawer').classList.contains('on'));
  assert.match(d.getElementById('vwBody').textContent, /https:\/\/erp\.refatrix\.com\/mx_survey_analysis\.html/);
  assert.match(d.getElementById('vwBody').textContent, /고객 이름·상호·전화가 그대로 보입니다/);
  d.getElementById('vwLogin').value = 'Dev.Juan';
  d.getElementById('vwName').value = 'Juan';
  d.getElementById('vwGen').click();
  const pass = d.getElementById('vwPass').value;
  assert.ok(pass.length === 12 && /\d/.test(pass) && /[A-Za-z]/.test(pass), '자동 비밀번호: 12자 영문+숫자');
  d.getElementById('vwCreate').click(); await wait(60);
  const post = log.find((l) => l.startsWith('POST /api/surveys/viewers'));
  const sent = JSON.parse(post.slice(post.indexOf('{')));
  assert.equal(sent.login, 'dev.juan'); assert.equal(sent.password, pass); assert.deepEqual(sent.survey_ids, [2]);
  const cred = d.getElementById('vwCred').textContent;
  assert.match(cred, /Usuario: dev\.juan/); assert.ok(cred.includes('Contraseña: ' + pass));
  assert.match(cred, /erp\.refatrix\.com\/mx_survey_analysis\.html/);
  assert.match(d.getElementById('vwBody').textContent, /다시 볼 수 없습니다/);
  w.close();
});

jt('D2. 디렉터가 아니면 버튼이 없다', async () => {
  const { w, d } = await openErp('marketing');
  assert.ok(d.getElementById('btnViewers').classList.contains('hidden'));
  w.close();
});

test('E. 커버리지 사이트 링크 · 빌드 토큰', () => {
  for (const f of ['mx_parts_coverage_dashboard.html', 'mx_coverage_map.html', 'mx_dev_projects.html']) {
    assert.match(read(f), /href="mx_survey_analysis\.html">Encuesta de clientes ↗</, f);
  }
  assert.match(read('refatrix-survey.html'), /build 20260930sv8/);
  assert.match(read('refatrix-api/src/middleware/authGuard.js'), /survey_viewer/);
});
