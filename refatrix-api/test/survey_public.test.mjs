// 고객 설문 — REFATRIX Platform 로그인으로만 열람 (2026-09-30, build 20260930sv10)
//
//   실행: TEST_PG_URL=postgres://... NODE_ENV=test node --test test/survey_public.test.mjs
//   (C 는 TEST_PG_URL, B·D 는 jsdom 이 있어야 돈다)
//
//   못 박는 것
//     · 익명 집계 빌더(A) · 플랫폼 화면(templates/survey_platform.html = Netlify survey.html):
//       플랫폼 세션으로 자동 열람 · 리포트·AI 요약·서술형·응답 목록·원본 이미지(토큰) · 헤더 링크 0 · 한글 0자 · 세션 없으면 안내 · 401 재확인
//     · 서버: 플랫폼 세션 확인 · 공개 설문만 · 끄면 즉시 404 · ERP API 401 · AI 요약 스페인어 번역 캐시 · 다른 설문 이미지 404
//     · 닫힘(디렉터 결정): erp 의 mx_survey_analysis.html → 플랫폼으로 이동 · 아이디/비밀번호 로그인 410 · 계정 토큰 401 · 계정 만들기 410
//     · ERP: 디렉터에게만 [🌐 플랫폼 공개] — 설문별 공개 체크만
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

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


// ── B. 플랫폼 안 결과 화면 (jsdom) ─────────────────────────────────────
const TPL = () => read('refatrix-api/templates/survey_platform.html');
async function openPlatformPage({ sess, first401 = false } = {}) {
  const { buildPublicSurveyData } = await import('../src/surveyPublic.js');
  const DATA = buildPublicSurveyData({ title: 'RUJAC_01', survey_date: '2026-09-14', questions: QUESTIONS }, PAGES, { uploaded: 5 });
  DATA.all_questions = QUESTIONS.map(({ ko, ...q }) => q);
  DATA.responses = PAGES.map((p, i) => ({ id: i + 1, seq: i + 1, folio: p.status === 'done' ? '010' + (i + 1) : null, status: p.status, file_name: 'RUJAC_010' + (i + 1) + '.jpg',
    mime: 'image/jpeg', has_view: true, has_thumb: true, answers: p.answers, others: {}, geo: p.geo || {}, low_conf: i === 2 ? ['q12'] : [] }));
  DATA.ai = { generated_at: '2026-09-30T10:00:00Z', translated: true, bullets: ['Los mecánicos valoran la calidad (muestra pequeña).'],
    themes: { q11: [{ name: 'Precio', summary: 'Piden mejores precios.', ids: [1] }, { name: 'Entrega', summary: 'Quieren entrega rápida.', ids: [3] }] } };
  const log = []; let n401 = first401 ? 1 : 0;
  const dom = new JSDOM(TPL(), { url: 'https://refatrix-platform.netlify.app/survey.html', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
      if (sess) w.sessionStorage.setItem('rfx_sess', JSON.stringify(sess));
      w.fetch = async (url, opt = {}) => {
        const u = String(url); log.push({ u, body: opt.body, auth: opt.headers && opt.headers.Authorization });
        if (/\/api\/survey-viewer\/pages\/\d+\/(thumb|view|file)$/.test(u)) return { ok: true, status: 200, blob: async () => new w.Blob(['x'], { type: 'image/jpeg' }), json: async () => ({}) };
        let status = 200; let body = {};
        if (u.endsWith('/platform-login')) body = { token: 'erp-tok-' + log.length, name: 'Kim CTR', surveys: [{ id: 2, title: 'RUJAC_01', date: '2026-09-14' }] };
        else if (u.endsWith('/api/survey-viewer/surveys')) body = { name: 'Kim CTR', surveys: [{ id: 2, title: 'RUJAC_01', date: '2026-09-14' }] };
        else if (u.endsWith('/surveys/2')) { if (n401 > 0) { n401--; status = 401; body = { error: 'unauthorized' }; } else body = DATA; }
        return { ok: status < 400, status, json: async () => body };
      };
    } });
  await wait(80);
  return { w: dom.window, d: dom.window.document, log };
}
const SESS = { t: 'aaaaaaaa-1111-2222-3333-444444444444', u: { name: 'Kim CTR' }, e: Date.now() + 3600e3 };

jt('B1. 플랫폼 세션으로 자동 열람 — 리포트·AI 요약·서술형·응답 목록·원본 이미지 · 헤더 링크 0 · 한글 0자', async () => {
  const { w, d, log } = await openPlatformPage({ sess: SESS });
  const pl = log.find((x) => x.u.endsWith('/platform-login'));
  assert.deepEqual(JSON.parse(pl.body), { token: SESS.t, name: 'Kim CTR' });
  assert.ok(pl.u.startsWith('https://refatrix-production.up.railway.app/'), 'API 주소 고정');
  assert.ok(d.getElementById('login').classList.contains('hidden'), '별도 로그인 화면 없음');
  assert.ok(d.getElementById('btnOut').classList.contains('hidden'), '로그아웃은 플랫폼에서');
  assert.equal(d.querySelectorAll('header a').length, 0, '헤더 링크 없음');
  const t = d.body.textContent;
  assert.match(t, /Encuesta de clientes · RUJAC_01/); assert.match(t, /Respuestas analizadas/);
  assert.equal(d.querySelectorAll('svg.map path').length, 32);
  assert.match(t, /Resumen IA/); assert.match(t, /Los mecánicos valoran la calidad/);
  assert.match(t, /Piden mejores precios/); assert.match(t, /llamen a Juan/);
  assert.ok(!HANGUL.test(d.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/g, '')), '화면에 한글 없음');
  assert.ok(!HANGUL.test(TPL()), '파일에 한글 없음');
  // 필터
  const fSeg = d.getElementById('fSeg'); fSeg.value = 'q4'; fSeg.dispatchEvent(new w.Event('change'));
  const fVal = d.getElementById('fVal'); fVal.value = 'Mecánico / Técnico'; fVal.dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelector('.kpi .v').textContent, '2');
  d.getElementById('fClear').click();
  // 응답 목록 → 상세
  d.querySelector('[data-tab="resp"]').click(); await wait(30);
  assert.match(d.body.textContent, /Juan Pérez/); assert.match(d.body.textContent, /RUJAC_0101\.jpg/);
  const rQ = d.getElementById('rQ'); rQ.value = 'ruiz'; rQ.dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('tr[data-r]').length, 1);
  d.querySelector('tr[data-r]').click(); await wait(40);
  assert.ok(d.getElementById('drawer').classList.contains('on'));
  assert.ok(d.querySelector('#dImg img'), '원본 이미지');
  const viewReq = log.find((x) => /\/pages\/2\/view$/.test(x.u));
  assert.match(viewReq.auth || '', /^Bearer erp-tok-/, '이미지도 열람 토큰으로');
  w.close();
});

jt('B2. 플랫폼 세션이 없으면 안내만(ERP 호출 없음) · 열람 토큰 401 이면 플랫폼 세션으로 다시 받아 이어서', async () => {
  const a = await openPlatformPage({});
  assert.match(a.d.body.textContent, /Inicia sesión en REFATRIX Platform/);
  assert.equal(a.d.querySelector('#app a').getAttribute('href'), '/');
  assert.equal(a.log.length, 0);
  a.w.close();
  const b = await openPlatformPage({ sess: { ...SESS, e: Date.now() - 1000 } });
  assert.match(b.d.body.textContent, /Inicia sesión en REFATRIX Platform/, '만료된 플랫폼 세션');
  assert.equal(b.log.length, 0);
  b.w.close();
  const c = await openPlatformPage({ sess: SESS, first401: true });
  assert.equal(c.log.filter((x) => x.u.endsWith('/platform-login')).length, 2);
  assert.match(c.d.body.textContent, /Respuestas analizadas/);
  c.w.close();
});

// ── C. 실 DB 종단 ───────────────────────────────────────────────────
dbTest('C. 플랫폼 세션 → 열람 · 공개 설문만 · 번역 캐시 · 이미지 · ERP 차단 · 아이디/비밀번호 경로 닫힘 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const R = await import('../src/routes/surveyRoutes.js');
  const V = await import('../src/surveyViewer.js');
  const seen = [];
  V.platformApi.check = async (tok) => { seen.push(tok); return tok.startsWith('aaaaaaaa') ? { ok: true } : tok.startsWith('eeeeeeee') ? { ok: false, error: 'platform_timeout' } : { ok: false, invalid: true }; };
  let aiCalls = 0;
  R.surveyAiApi.call = async (content) => {
    const text = content.find((b) => b.type === 'text').text;
    if (text.includes('Traduce al español')) { aiCalls++; return { ok: true, text: JSON.stringify({ bullets: ['Resumen en español.'], themes: { q11: ['Buenos precios.'] } }) }; }
    return { ok: false, error: 'unexpected', transient: false };
  };
  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET, sign: { expiresIn: '1h' } });
  app.register(R.default);
  await app.ready();
  const TAG = 'PF' + String(Date.now()).slice(-6);
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
    [s1, seq, Buffer.from([0xFF, 0xD8, 0xFF, seq]), TAG + seq, p.status, p.answers ? JSON.stringify(p.answers) : null, JSON.stringify(p.geo || {}), '01' + String(seq).padStart(2, '0'), dir]);
  }
  const other = Number((await query(`INSERT INTO survey_pages (survey_id, seq, mime, file_data, status, uploaded_by) VALUES ($1,1,'image/jpeg',$2,'done',$3) RETURNING id`, [s2, Buffer.from([0xFF, 0xD8, 0xFF, 9]), dir])).rows[0].id);
  t.after(async () => {
    await query(`DELETE FROM survey_pages WHERE survey_id = ANY($1::bigint[])`, [[s1, s2]]).catch(() => {});
    await query(`DELETE FROM surveys WHERE id = ANY($1::bigint[])`, [[s1, s2]]).catch(() => {});
    await query(`DELETE FROM survey_viewers WHERE login LIKE $1`, ['%' + TAG.toLowerCase() + '%']).catch(() => {});
    await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [[dir, mkt]]).catch(() => {});
    await query(`DELETE FROM user_page_access WHERE user_id = ANY($1::bigint[])`, [[dir, mkt]]);
    await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [[dir, mkt]]);
    await app.close(); await pool.end();
  });
  const call = async (token, method, url, payload) => {
    const r = await app.inject({ method, url, headers: token ? { authorization: 'Bearer ' + token } : {}, payload });
    let j = null; try { j = r.json(); } catch (_) {}
    return { code: r.statusCode, j, raw: r.payload, headers: r.headers };
  };
  const erp = (uid) => app.jwt.sign({ sub: uid });
  const GOOD = 'aaaaaaaa-1111-2222-3333-444444444444';

  // 플랫폼 세션 확인
  assert.equal((await call(null, 'POST', '/api/survey-viewer/platform-login', { token: 'no-uuid' })).code, 401);
  assert.equal(seen.length, 0, 'uuid 아니면 플랫폼에 묻지도 않음');
  assert.equal((await call(null, 'POST', '/api/survey-viewer/platform-login', { token: 'bbbbbbbb-1111-2222-3333-444444444444' })).j.error, 'platform_session_invalid');
  assert.equal((await call(null, 'POST', '/api/survey-viewer/platform-login', { token: 'eeeeeeee-1111-2222-3333-444444444444' })).code, 502);

  // 공개 설정 — 디렉터만
  assert.equal((await call(erp(mkt), 'PATCH', `/api/surveys/${s1}/platform`, { visible: true })).code, 403);
  assert.equal((await call(erp(mkt), 'GET', '/api/surveys/viewers')).code, 403);
  assert.equal((await call(erp(dir), 'PATCH', `/api/surveys/${s1}/platform`, { visible: true })).j.visible, true);
  const adm = await call(erp(dir), 'GET', '/api/surveys/viewers');
  assert.equal(adm.j.platform.find((x) => x.id === s1).visible, true);
  assert.equal(adm.j.platform.find((x) => x.id === s2).visible, false);

  const lg = await call(null, 'POST', '/api/survey-viewer/platform-login', { token: GOOD, name: 'Kim CTR' });
  assert.equal(lg.code, 200); assert.equal(lg.j.name, 'Kim CTR');
  assert.deepEqual(lg.j.surveys.map((x) => x.id).filter((id) => id === s1 || id === s2), [s1]);
  const tok = lg.j.token;

  // 데이터 — ERP 와 동일(응답 목록 포함) · 한국어 필드 없음 · AI 요약 번역 캐시
  const dd = await call(tok, 'GET', `/api/survey-viewer/surveys/${s1}`);
  assert.equal(dd.code, 200, dd.raw);
  assert.equal(dd.j.rows.length, 4); assert.equal(dd.j.uploaded, 5); assert.equal(dd.j.responses.length, 5);
  const r1 = dd.j.responses.find((r) => r.folio === '0101');
  assert.equal(r1.answers.q1, 'Juan Pérez'); assert.equal(r1.file_name, 'RUJAC_0101.jpg');
  assert.ok(!('ko' in dd.j.all_questions[0]));
  assert.ok(!HANGUL.test(JSON.stringify({ q: dd.j.all_questions, ai: dd.j.ai })));
  assert.deepEqual(dd.j.ai.bullets, ['Resumen en español.']); assert.equal(dd.j.ai.themes.q11[0].summary, 'Buenos precios.');
  assert.equal(aiCalls, 1);
  await call(tok, 'GET', `/api/survey-viewer/surveys/${s1}`);
  assert.equal(aiCalls, 1, '두 번째 열람은 AI 호출 없음');
  await query(`UPDATE surveys SET ai_cache = jsonb_set(ai_cache, '{generated_at}', '"2026-10-01T00:00:00Z"') WHERE id=$1`, [s1]);
  await call(tok, 'GET', `/api/survey-viewer/surveys/${s1}`);
  assert.equal(aiCalls, 2, 'ERP 에서 요약을 다시 만들면 다시 번역');

  // 원본 이미지
  const p1 = dd.j.responses[0].id;
  const img = await call(tok, 'GET', `/api/survey-viewer/pages/${p1}/view`);
  assert.equal(img.code, 200); assert.equal(img.headers['content-type'], 'image/jpeg');
  assert.match((await call(tok, 'GET', `/api/survey-viewer/pages/${p1}/file`)).headers['content-disposition'], /RUJAC_0101\.jpg/);
  assert.equal((await call(tok, 'GET', `/api/survey-viewer/pages/${other}/view`)).code, 404, '공개 안 한 설문의 이미지');
  assert.equal((await call(tok, 'GET', `/api/survey-viewer/surveys/${s2}`)).code, 404);
  assert.equal((await call(erp(dir), 'GET', `/api/survey-viewer/pages/${p1}/view`)).code, 401, 'ERP 토큰으로 열람 API 불가');

  // ERP 는 열리지 않는다
  for (const u of ['/api/surveys', `/api/surveys/${s1}`, `/api/surveys/${s1}/pages`, '/api/surveys/viewers']) assert.equal((await call(tok, 'GET', u)).code, 401, 'ERP 차단: ' + u);

  // 아이디·비밀번호 경로는 닫혔다
  assert.equal((await call(null, 'POST', '/api/survey-viewer/login', { login: 'x', password: 'Secreto123' })).code, 410);
  assert.equal((await call(erp(dir), 'POST', '/api/surveys/viewers', { login: 'dev.' + TAG.toLowerCase(), password: 'Secreto123', survey_ids: [s1] })).code, 410);
  const vid = Number((await query(`INSERT INTO survey_viewers (login, pass_hash, survey_ids) VALUES ($1,'x:00',$2::bigint[]) RETURNING id`, ['old.' + TAG.toLowerCase(), [s1]])).rows[0].id);
  const forged = app.jwt.sign({ sub: 'sv:' + vid, typ: 'survey_viewer', tv: 1 });
  assert.equal((await call(forged, 'GET', `/api/survey-viewer/surveys/${s1}`)).code, 401, '예전 계정 토큰은 무효');

  // 공개를 끄면 이미 받은 토큰으로도 바로 막힌다
  await call(erp(dir), 'PATCH', `/api/surveys/${s1}/platform`, { visible: false });
  assert.equal((await call(tok, 'GET', `/api/survey-viewer/surveys/${s1}`)).code, 404);
});

// ── D. ERP 화면 (jsdom) ────────────────────────────────────────────
async function openErp(role) {
  const log = [];
  let pf = [{ id: 2, title: 'RUJAC_01', code_prefix: 'RUJAC', visible: false }];
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
        else if (u === '/api/surveys/viewers') body = { items: [], platform: pf };
        else if (u === '/api/surveys/2/platform') { const v = JSON.parse(opt.body).visible; pf = [{ ...pf[0], visible: v }]; body = { ok: true, id: 2, visible: v }; }
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

jt('D1. 디렉터: [🌐 플랫폼 공개] → 설문 체크 → PATCH · 계정 만들기·ERP 열람 주소 없음', async () => {
  const { w, d, log } = await openErp('director');
  const btn = d.getElementById('btnViewers');
  assert.ok(!btn.classList.contains('hidden')); assert.match(btn.textContent, /플랫폼 공개/);
  btn.click(); await wait(60);
  const body = d.getElementById('vwBody');
  assert.match(body.textContent, /refatrix-platform\.netlify\.app/);
  assert.ok(!d.getElementById('vwLogin') && !d.getElementById('vwCreate'), '아이디·비밀번호 계정 만들기 없음');
  assert.ok(!/mx_survey_analysis/.test(read('refatrix-survey.html')), 'ERP 열람 주소 없음');
  const cb = body.querySelector('input[data-pf="2"]');
  cb.checked = true; cb.dispatchEvent(new w.Event('change')); await wait(40);
  assert.ok(log.some((l) => l.startsWith('PATCH /api/surveys/2/platform') && l.includes('"visible":true')));
  assert.match(d.getElementById('vwBody').textContent, /플랫폼 공개 중/);
  w.close();
});

jt('D2. 디렉터가 아니면 버튼이 없다', async () => {
  const { w, d } = await openErp('marketing');
  assert.ok(d.getElementById('btnViewers').classList.contains('hidden'));
  w.close();
});

// ── E. 닫힌 ERP 주소 · 링크 · 빌드 ─────────────────────────────────────
test('E. erp 의 mx_survey_analysis.html 은 플랫폼으로 이동만 · 커버리지 사이트 링크 없음 · 빌드 토큰', () => {
  const stub = read('mx_survey_analysis.html');
  assert.match(stub, /location\.replace\('https:\/\/refatrix-platform\.netlify\.app\/'\)/);
  assert.match(stub, /http-equiv="refresh" content="0; url=https:\/\/refatrix-platform\.netlify\.app\/"/);
  assert.ok(stub.length < 1200 && !/survey-viewer|railway|Encuesta/.test(stub), '데이터·API 흔적 없음');
  for (const f of ['mx_parts_coverage_dashboard.html', 'mx_coverage_map.html', 'mx_dev_projects.html']) assert.ok(!read(f).includes('mx_survey_analysis'), f);
  assert.match(read('refatrix-survey.html'), /build 20260930sv1\d/);
  assert.match(read('refatrix-api/src/middleware/authGuard.js'), /survey_viewer/);
});

test('F. 플랫폼 index.html 패치 — 메뉴·화면·iframe·로그아웃 시 비우기', () => {
  let h = null; try { h = readFileSync('/home/claude/platform/index.html', 'utf8'); } catch (_) { return; }
  assert.match(h, /<button id="navSurvey">고객 설문<\/button>/);
  assert.match(h, /id="viewSurvey"/); assert.match(h, /f\.src="survey\.html"/);
  assert.match(h, /f\.src="about:blank"/);
  assert.equal(readFileSync('/home/claude/platform/survey.html', 'utf8'), TPL(), 'Netlify survey.html = 레포 원본');
});
