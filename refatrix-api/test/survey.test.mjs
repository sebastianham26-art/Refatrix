// 고객 설문 분석(2026-09-11) — 순수 로직 + 실 PostgreSQL 종단(가짜 Claude)
//
//   실행: TEST_PG_URL=postgres://... NODE_ENV=test node --test test/survey.test.mjs
//   (TEST_PG_URL 이 없으면 C 묶음은 건너뛴다)
//
//   못 박는 것
//     · 붉은 번호 → 파일명 (정상 / 중복 -2 / 번호 없음 SIN-NUM / 판독 전 P###) — 접두어를 바꾸면 이름이 따라온다
//     · 보기 대조: 악센트·대소문자 무시, 목록 밖 값은 「Otro」 로 + 확신 낮음
//     · 같은 파일 두 번 → 409 · 문항 없는 설문에 업로드 → 409
//     · 일시 오류(429)는 자동 재시도, not_survey 는 실패로
//     · 사람이 고친 칸·번호는 다시 판독해도 지킨다
//     · zip 이 실제로 풀린다(unzip -t) · 권한(마케팅 없음 403 / 열람만 read_only)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, '..');
const REPO = join(API, '..');
const read = (p) => readFileSync(p, 'utf8');

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
process.env.NODE_ENV = 'test';
process.env.SURVEY_AI_CONCURRENCY = '1';   // 중복 순번(-2, -3)을 결정적으로 보려고 한 장씩
process.env.SURVEY_AI_PAUSE_MS = '50';

const S = await import('../src/surveyAi.js');

const QS = S.normalizeQuestions([
  { text: 'Tipo de negocio', ko: '업종', type: 'single', options: ['Refaccionaria', 'Taller mecánico', 'Distribuidor', 'Otro'], seg: true },
  { text: '¿Qué marcas compra?', type: 'multi', options: ['SYD', 'Moog', 'CTR', 'Otra'] },
  { text: 'Satisfacción', type: 'scale', min: 1, max: 5 },
  { text: 'Piezas al mes', type: 'number' },
  { text: 'Comentarios', type: 'text' },
  { text: 'Nombre del negocio', type: 'info' },
]).questions;

// ── A. 순수 로직 ─────────────────────────────────────────────────────
test('A1. 문항 key 는 q1… 로 붙고, 다시 저장해도 바뀌지 않으며 새 문항은 다음 번호를 받는다', () => {
  assert.deepEqual(QS.map((q) => q.k), ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
  assert.equal(QS[0].seg, true);
  assert.equal(QS[1].seg, false, '복수선택은 세그먼트가 될 수 없다');
  const edited = [QS[0], QS[2], { text: 'Nueva', type: 'text' }];
  const n = S.normalizeQuestions(edited, QS).questions;
  assert.deepEqual(n.map((q) => q.k), ['q1', 'q3', 'q7'], '지운 q2 를 재사용하지 않는다');
  assert.deepEqual(n.map((q) => q.no), [1, 2, 3]);
});

test('A2. 문항 검증 — 보기 2개 미만·빈 문항은 오류, 척도 범위는 보정', () => {
  const n = S.normalizeQuestions([{ text: '', type: 'single', options: ['A'] }, { text: 'X', type: 'scale', min: 3, max: 1 }]);
  assert.deepEqual(n.errors.map((e) => e.error).sort(), ['few_options', 'no_text']);
  assert.equal(n.questions[1].min, 3); assert.equal(n.questions[1].max, 7);
});

test('A3. 붉은 번호 정규화', () => {
  assert.equal(S.normRedNumber('Nº 137'), '0137');
  assert.equal(S.normRedNumber('0137'), '0137');
  assert.equal(S.normRedNumber(' 12 '), '0012');
  assert.equal(S.normRedNumber('10234'), '10234');
  assert.equal(S.normRedNumber('137 / 2026'), '0137');
  assert.equal(S.normRedNumber(null), null);
  assert.equal(S.normRedNumber('null'), null);
  assert.equal(S.normRedNumber('??'), null);
});

test('A4. 파일명 — 정상/중복/번호없음/판독전, 접두어 정리', () => {
  const b = { prefix: 'expo 26', seq: 7, mime: 'image/jpeg', status: 'done' };
  assert.equal(S.pageFileName({ ...b, red_number: '0137', dup_idx: 1 }), 'EXPO26_0137.jpg');
  assert.equal(S.pageFileName({ ...b, red_number: '0137', dup_idx: 2 }), 'EXPO26_0137-2.jpg');
  assert.equal(S.pageFileName({ ...b, red_number: null }), 'EXPO26_SIN-NUM_007.jpg');
  assert.equal(S.pageFileName({ ...b, red_number: null, status: 'queued' }), 'EXPO26_P007.jpg');
  assert.equal(S.pageFileName({ ...b, red_number: '0001', mime: 'application/pdf' }), 'EXPO26_0001.pdf');
  assert.equal(S.normPrefix('Encuésta 2026!'), 'ENCUESTA2026');
});

test('A5. 판독 결과 정규화 — 악센트 무시·Otro 매핑·복수선택 순서·척도 범위·숫자', () => {
  const p = S.parsePageJson('```json\n' + JSON.stringify({
    red_number: 'N° 45', red_number_confidence: 'high',
    answers: { q1: 'taller mecanico', q2: ['CTR', 'syd', 'Bosch'], q3: 7, q4: '$1,200', q5: 'Entregas\nmás rápidas', q6: 'Refacciones López' },
    others: {}, low_confidence: ['q5', 'zz'], notes: '',
  }) + '\n```', QS);
  assert.equal(p.red_number, '0045');
  assert.equal(p.answers.q1, 'Taller mecánico');
  assert.deepEqual(p.answers.q2, ['SYD', 'CTR', 'Otra'], '보기 순서로, 목록 밖(Bosch)은 Otra');
  assert.equal(p.others.q2, 'Bosch');
  assert.equal(p.answers.q3, null, '1~5 밖이면 비우고');
  assert.equal(p.answers.q4, 1200);
  assert.equal(p.answers.q5, 'Entregas\nmás rápidas');
  assert.deepEqual(p.low_conf.sort(), ['q2', 'q3', 'q5'], '모르는 키(zz)는 버린다');
  const q = S.parsePageJson(JSON.stringify({ red_number: null, answers: { q1: 'Flotilla' } }), QS);
  assert.equal(q.red_number, null);
  assert.equal(q.answers.q1, 'Otro'); assert.equal(q.others.q1, 'Flotilla');
  assert.deepEqual(S.parsePageJson('{"not_survey":true}', QS), { not_survey: true });
  assert.equal(S.parsePageJson('no json', QS), null);
  const low = S.parsePageJson(JSON.stringify({ red_number: '12', red_number_confidence: 'low', answers: {} }), QS);
  assert.ok(low.low_conf.includes('_no'));
});

test('A6. 주제 묶기 파서 — 모르는 id 제거, 한 id 는 한 주제에만, 남은 id 는 Otros', () => {
  const t = S.parseThemeJson(JSON.stringify({ themes: [
    { name: 'Entrega', ko: '배송', ids: [1, 2, 99] }, { name: 'Precio', ko: '가격', ids: [2, 3] }] }), [1, 2, 3, 4]);
  assert.deepEqual(t.map((x) => [x.name, x.ids]), [['Entrega', [1, 2]], ['Precio', [3]], ['Otros', [4]]]);
});

test('A7. zip — unzip 이 받아들이고 내용이 같다', async () => {
  const entries = [{ name: 'EXPO26_0001.jpg', data: Buffer.from('hello') }, { name: 'EXPO26_0002.pdf', data: Buffer.alloc(70000, 7) }];
  const chunks = [];
  for await (const c of S.zipStream((async function* () { yield* entries; })())) chunks.push(c);
  const dir = mkdtempSync(join(os.tmpdir(), 'svz-'));
  const f = join(dir, 'a.zip'); writeFileSync(f, Buffer.concat(chunks));
  const outp = execFileSync('unzip', ['-t', f]).toString();
  assert.match(outp, /No errors detected/);
  assert.equal(execFileSync('unzip', ['-p', f, 'EXPO26_0001.jpg']).toString(), 'hello');
  assert.equal(S.crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('A8. 교차 요약 텍스트에는 비율만 있고 서술형 원문은 없다', () => {
  const rows = [
    { answers: { q1: 'Refaccionaria', q2: ['SYD'], q3: 4, q5: 'secreto 123' } },
    { answers: { q1: 'Taller mecánico', q2: ['CTR', 'SYD'], q3: 2, q5: '' } },
  ];
  const t = S.crossSummaryText(QS, rows);
  assert.match(t, /Total respuestas: 2/);
  assert.match(t, /Tipo de negocio=Refaccionaria \(n=1\)/);
  assert.ok(!t.includes('secreto'), '서술형 원문을 보내지 않는다');
});

// ── B. 소스 계약 ─────────────────────────────────────────────────────
test('B1. 서버에 등록되고, 권한은 marketing 화면키를 쓴다', () => {
  const server = read(join(API, 'src/server.js'));
  assert.match(server, /import surveyRoutes from '\.\/routes\/surveyRoutes\.js'/);
  assert.match(server, /app\.register\(surveyRoutes\)/);
  const r = read(join(API, 'src/routes/surveyRoutes.js'));
  assert.match(r, /const PAGE = 'marketing'/);
  assert.ok(!/preHandler: \[authGuard\]\s*}/.test(r), '권한 가드 없는 라우트가 없다');
});
test('B2. 모델 설정이 외부 서비스 키 화면 등록부에 있다', () => {
  assert.match(read(join(API, 'src/secrets.js')), /SURVEY_AI_MODEL/);
});

// ── C. 실 DB 종단 ────────────────────────────────────────────────────
const dbTest = PG ? test : test.skip;

// 가짜 이미지: JPEG 머리(FFD8FF) + 표식 문자열. 가짜 Claude 가 표식을 읽어 답을 만든다.
function fakeJpeg(marker) { return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from(marker)]); }
function fakePdf(marker) { return Buffer.from('%PDF-1.4\n% ' + marker + '\n%%EOF'); }

dbTest('C. 업로드 → 판독 큐 → 파일명·중복·번호없음·재시도·수정 보존·요약·zip·권한 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const R = await import('../src/routes/surveyRoutes.js');

  // 가짜 Claude
  const seen = [];
  let fail429 = 1;
  const override = { q3: null };
  R.surveyAiApi.call = async (content) => {
    const media = content.find((b) => b.type === 'image' || b.type === 'document');
    const text = content.find((b) => b.type === 'text').text;
    if (!media) {
      if (text.includes('"themes"')) {
        const ids = [...text.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]));
        return { ok: true, text: JSON.stringify({ themes: [{ name: 'Entrega', ko: '배송', summary_ko: '빠른 배송', ids: ids.slice(0, 2) }] }) };
      }
      return { ok: true, text: JSON.stringify({ bullets: ['Taller는 품질을 중시(표본 적음).', '제안: 정비소 대상 보증 강조.'] }) };
    }
    if (text.includes('FORMULARIO VACÍO')) {
      return { ok: true, text: 'Aquí está:\n' + JSON.stringify({ title: 'Encuesta 2026', number_hint: 'esquina superior derecha',
        questions: [{ text: 'Giro', ko: '업종', type: 'single', options: ['Refaccionaria', 'Taller'], seg: true },
          { text: 'Teléfono', type: 'info' }, { text: 'Califique', type: 'scale', min: 1, max: 10 }] }) };
    }
    const raw = Buffer.from(media.source.data, 'base64').toString('utf8');
    seen.push({ type: media.type, raw });
    const m = /MK:([^|]*)\|([^|]*)\|([^|]*)\|?([A-Z]*)/.exec(raw) || [];
    if (m[1] === 'NOTSURVEY') return { ok: true, text: '{"not_survey":true}' };
    if (m[4] === 'RATE' && fail429 > 0) { fail429--; return { ok: false, status: 429, error: 'ai: rate', transient: true }; }
    return { ok: true, text: JSON.stringify({
      red_number: m[1] === 'NONE' ? null : m[1], red_number_confidence: 'high',
      answers: { q1: m[2] || 'Refaccionaria', q2: ['SYD'], q3: override.q3 != null ? override.q3 : 4, q4: 10, q5: m[3] || '', q6: 'Negocio ' + m[1] },
      low_confidence: m[2] === 'Flotilla' ? ['q1'] : [],
    }) };
  };
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET, sign: { expiresIn: '1h' } });
  app.register(R.default);
  await app.ready();

  const TAG = 'SV' + String(Date.now()).slice(-6);
  const mk = async (name, role) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name + TAG, role, (name + TAG).toLowerCase()])).rows[0].id);
  const dir = await mk('Dir', 'director');
  const mkt = await mk('Mkt', 'marketing');
  const viewer = await mk('View', 'sales');
  const sales = await mk('Sal', 'sales');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'marketing','anywhere','edit'),($2,'marketing','anywhere','view')`, [mkt, viewer]);

  let sid = null;
  t.after(async () => {
    if (sid) await query(`DELETE FROM surveys WHERE id=$1`, [sid]).catch(() => {});
    await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [[dir, mkt, viewer, sales]]).catch(() => {});
    await query(`DELETE FROM user_page_access WHERE user_id = ANY($1::bigint[])`, [[dir, mkt, viewer, sales]]);
    await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [[dir, mkt, viewer, sales]]);
    await app.close();
    await pool.end();
  });

  const H = (uid) => ({ authorization: 'Bearer ' + app.jwt.sign({ sub: uid }) });
  const call = async (uid, method, url, payload) => {
    const r = await app.inject({ method, url, headers: H(uid), payload });
    let j = null; try { j = r.json(); } catch (_) {}
    return { code: r.statusCode, j, raw: r.rawPayload, headers: r.headers };
  };

  // C1. 권한
  assert.equal((await call(sales, 'GET', '/api/surveys')).code, 403, '마케팅 권한 없음 → 403');
  assert.equal((await call(viewer, 'GET', '/api/surveys')).code, 200);
  const ro = await call(viewer, 'POST', '/api/surveys', { title: 'x', code_prefix: 'X' });
  assert.equal(ro.code, 403); assert.equal(ro.j.error, 'read_only');

  // C2. 생성 → 문항 없이 업로드는 409
  const cr = await call(mkt, 'POST', '/api/surveys', { title: 'Expo ' + TAG, code_prefix: 'expo26', survey_date: '2026-09-05' });
  assert.equal(cr.code, 200); sid = cr.j.id;
  const up0 = await call(mkt, 'POST', `/api/surveys/${sid}/pages`, { mime: 'image/jpeg', file_b64: fakeJpeg('MK:0001||').toString('base64') });
  assert.equal(up0.code, 409); assert.equal(up0.j.error, 'no_questions');

  // C3. 빈 양식 → AI 제안(저장은 하지 않는다) → 사람이 확인한 문항 저장
  const tp = await call(mkt, 'POST', `/api/surveys/${sid}/template`, { mime: 'image/jpeg', data_b64: fakeJpeg('TEMPLATE').toString('base64') });
  assert.equal(tp.code, 200, JSON.stringify(tp.j));
  assert.deepEqual(tp.j.proposal.questions.map((q) => [q.k, q.type]), [['q1', 'single'], ['q2', 'info'], ['q3', 'scale']]);
  assert.equal(tp.j.proposal.questions[2].max, 10);
  assert.equal(tp.j.proposal.number_hint, 'esquina superior derecha');
  assert.equal((await call(viewer, 'GET', `/api/surveys/${sid}`)).j.questions.length, 0, '제안은 저장되지 않는다');
  assert.equal((await call(viewer, 'GET', `/api/surveys/${sid}/template`)).code, 200, '양식 이미지는 저장');
  const put = await call(mkt, 'PUT', `/api/surveys/${sid}`, { questions: QS.map((q) => ({ ...q })) });
  assert.equal(put.code, 200); assert.equal(put.j.questions.length, 6);
  const bad = await call(mkt, 'PUT', `/api/surveys/${sid}`, { questions: [{ text: 'X', type: 'single', options: ['A'] }] });
  assert.equal(bad.code, 400);

  // C4. 업로드 6장: 정상 0137, 0138, 중복 0137, 번호 없음, 설문 아님, 429 한 번 → 재시도로 성공(PDF + 화면용 JPEG)
  const files = [
    ['image/jpeg', fakeJpeg('MK:0137|Taller mecánico|Entregas más rápidas')],
    ['image/jpeg', fakeJpeg('MK:0138|Refaccionaria|Mejor precio')],
    ['image/jpeg', fakeJpeg('MK:137|Distribuidor|')],
    ['image/jpeg', fakeJpeg('MK:NONE|Flotilla|Visitas')],
    ['image/jpeg', fakeJpeg('MK:NOTSURVEY||')],
    ['application/pdf', fakePdf('pdf-original'), fakeJpeg('MK:0137|Refaccionaria|Garantía|RATE')],
  ];
  const ids = [];
  for (const [mime, buf, view] of files) {
    const r = await call(mkt, 'POST', `/api/surveys/${sid}/pages`, {
      orig_name: 'x', mime, file_b64: buf.toString('base64'), view_b64: view ? view.toString('base64') : undefined });
    assert.equal(r.code, 200, JSON.stringify(r.j)); ids.push(r.j.id);
  }
  const same = await call(mkt, 'POST', `/api/surveys/${sid}/pages`, { mime: 'image/jpeg', file_b64: files[0][1].toString('base64') });
  assert.equal(same.code, 409); assert.equal(same.j.error, 'same_file');
  const fake = await call(mkt, 'POST', `/api/surveys/${sid}/pages`, { mime: 'image/jpeg', file_b64: Buffer.from('not a jpeg').toString('base64') });
  assert.equal(fake.code, 400, '확장자만 jpeg 인 가짜 파일 거부');

  assert.ok(await R.drainForTest(15000), '큐가 비어야 한다');
  let L = (await call(viewer, 'GET', `/api/surveys/${sid}/pages`)).j;
  const byId = (id) => L.items.find((x) => x.id === id);
  assert.equal(byId(ids[0]).file_name, 'EXPO26_0137.jpg');
  assert.equal(byId(ids[1]).file_name, 'EXPO26_0138.jpg');
  assert.equal(byId(ids[2]).file_name, 'EXPO26_0137-2.jpg', '같은 번호 두 번째 → -2');
  assert.equal(byId(ids[3]).file_name, 'EXPO26_SIN-NUM_004.jpg');
  assert.equal(byId(ids[3]).answers.q1, 'Otro'); assert.equal(byId(ids[3]).others.q1, 'Flotilla');
  assert.equal(byId(ids[4]).status, 'error'); assert.match(byId(ids[4]).error, /not_survey/);
  assert.equal(byId(ids[5]).status, 'done', '429 는 자동 재시도로 끝내 성공');
  assert.equal(byId(ids[5]).attempts, 2);
  assert.equal(byId(ids[5]).file_name, 'EXPO26_0137-3.pdf', 'PDF 원본 확장자 유지');
  assert.equal(seen.filter((x) => x.raw.includes('pdf-original')).length, 0, 'PDF 는 화면용 JPEG 로 판독한다');
  assert.deepEqual(L.counts.total, 6); assert.equal(L.counts.done, 5); assert.equal(L.counts.error, 1);
  assert.equal(L.counts.nonum, 1); assert.equal(L.counts.dup, 2); assert.equal(L.counts.lowconf, 1);
  assert.equal(byId(ids[0]).answers.q5, 'Entregas más rápidas');
  assert.equal(byId(ids[0]).answers.q6, 'Negocio 0137');

  // C5. 번호 고치기: 번호 없음 → 0139 / 이미 있는 번호 → 409 / 앞 번호 삭제 후 -2 → 원래 이름
  let pr = await call(mkt, 'PATCH', `/api/surveys/pages/${ids[3]}`, { red_number: '139' });
  assert.equal(pr.code, 200); assert.equal(pr.j.file_name, 'EXPO26_0139.jpg');
  pr = await call(mkt, 'PATCH', `/api/surveys/pages/${ids[3]}`, { red_number: '0138' });
  assert.equal(pr.code, 409); assert.equal(pr.j.error, 'number_taken');
  assert.equal((await call(viewer, 'DELETE', `/api/surveys/pages/${ids[0]}`)).code, 403, '열람 전용은 삭제 불가');
  assert.equal((await call(mkt, 'DELETE', `/api/surveys/pages/${ids[0]}`)).code, 200);
  pr = await call(mkt, 'PATCH', `/api/surveys/pages/${ids[2]}`, { red_number: '0137' });
  assert.equal(pr.j.file_name, 'EXPO26_0137.jpg', '비었으니 -2 가 떨어진다');

  // C6. 답 고치기 → 다시 판독해도 사람이 고친 칸·번호는 지킨다
  pr = await call(mkt, 'PATCH', `/api/surveys/pages/${ids[1]}`, { answers: { q3: 2 } });
  assert.equal(pr.code, 200);
  assert.equal((await call(mkt, 'PATCH', `/api/surveys/pages/${ids[1]}`, { answers: { q3: 9 } })).code, 400, '척도 밖 값 거부');
  override.q3 = 5;
  const rp = await call(mkt, 'POST', `/api/surveys/${sid}/reprocess`, { scope: 'all' });
  assert.equal(rp.j.queued, 5);
  assert.ok(await R.drainForTest(15000));
  L = (await call(viewer, 'GET', `/api/surveys/${sid}/pages`)).j;
  assert.equal(byId(ids[1]).answers.q3, 2, '고친 칸 유지');
  assert.equal(byId(ids[2]).answers.q3, 5, '안 고친 칸은 새 판독값');
  assert.equal(byId(ids[3]).file_name, 'EXPO26_0139.jpg', '사람이 넣은 번호 유지(AI 는 번호 없음이라고 읽어도)');

  // C7. 실패 1장 재시도 → 여전히 not_survey
  assert.equal((await call(mkt, 'POST', `/api/surveys/pages/${ids[4]}/retry`)).code, 200);
  assert.ok(await R.drainForTest(15000));

  // C8. 접두어를 바꾸면 파일명이 따라온다
  await call(mkt, 'PUT', `/api/surveys/${sid}`, { code_prefix: 'RUJAC' });
  L = (await call(viewer, 'GET', `/api/surveys/${sid}/pages`)).j;
  assert.equal(byId(ids[1]).file_name, 'RUJAC_0138.jpg');

  // C9. AI 요약 캐시
  const ins = await call(mkt, 'POST', `/api/surveys/${sid}/insights`, {});
  assert.equal(ins.code, 200, JSON.stringify(ins.j));
  assert.equal(ins.j.ai_cache.themes.q5[0].name, 'Entrega');
  assert.equal(ins.j.ai_cache.bullets.length, 2);
  const g = (await call(viewer, 'GET', `/api/surveys/${sid}`)).j;
  assert.equal(g.ai_cache.basis.done, 4);
  assert.equal(g.can_edit, false, '열람 전용');

  // C10. 원본 zip(전체·선택) — 실제로 풀린다
  const z = await call(viewer, 'GET', `/api/surveys/${sid}/zip`);
  assert.equal(z.code, 200); assert.equal(z.headers['content-type'], 'application/zip');
  const zf = join(mkdtempSync(join(os.tmpdir(), 'svz-')), 'all.zip'); writeFileSync(zf, z.raw);
  const listing = execFileSync('unzip', ['-Z1', zf]).toString().trim().split('\n');
  assert.deepEqual(listing, ['RUJAC_0137.jpg', 'RUJAC_0137-2.pdf', 'RUJAC_0138.jpg', 'RUJAC_0139.jpg', 'RUJAC_P005.jpg']);
  assert.match(execFileSync('unzip', ['-t', zf]).toString(), /No errors detected/);
  assert.equal(execFileSync('unzip', ['-p', zf, 'RUJAC_0137-2.pdf']).toString('latin1'), fakePdf('pdf-original').toString('latin1'), 'PDF 원본 그대로');
  const z2 = await call(viewer, 'GET', `/api/surveys/${sid}/zip?ids=${ids[1]}`);
  const zf2 = zf.replace('all.zip', 'one.zip'); writeFileSync(zf2, z2.raw);
  assert.deepEqual(execFileSync('unzip', ['-Z1', zf2]).toString().trim().split('\n'), ['RUJAC_0138.jpg']);

  // C11. 단건 원본·화면용
  const f1 = await call(viewer, 'GET', `/api/surveys/pages/${ids[5]}/file`);
  assert.equal(f1.headers['content-type'], 'application/pdf');
  const v1 = await call(viewer, 'GET', `/api/surveys/pages/${ids[5]}/view`);
  assert.equal(v1.headers['content-type'], 'image/jpeg');

  // C12. 설문 삭제는 디렉터만
  assert.equal((await call(mkt, 'DELETE', `/api/surveys/${sid}`)).code, 403);
  assert.equal((await call(dir, 'DELETE', `/api/surveys/${sid}`)).code, 200);
  assert.equal((await call(dir, 'GET', `/api/surveys/${sid}`)).code, 404);
  const lst = (await call(dir, 'GET', '/api/surveys')).j;
  assert.ok(!lst.items.some((x) => x.id === sid));
});
