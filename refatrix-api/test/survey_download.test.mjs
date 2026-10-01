// 고객 설문 — 플랫폼 일괄 다운로드: 개인정보 가린 사본 + CTR 책임 확인 기록 (2026-09-30, build 20260930sv12)
//
//   실행: TEST_PG_URL=postgres://... NODE_ENV=test node --test test/survey_download.test.mjs
//
//   못 박는 것
//     · 가릴 영역: 천분율→비율·여백·뒤집힌 좌표·「장 전체」 무시 · 놓친 칸은 다른 장 위치(중앙값, 3장 이상)로 보충 · 위치 모르는 칸은 「확인 필요」
//     · 확인 문구: 스페인어 · 「CTR 책임」 포함 · 버전·sha 가 맞아야 동의 · 문구 전문이 기록된다
//     · zip: **가린 사본만**(원본 바이트 0) · 뺀 장·확인 필요 장 없음 · datos.csv 에 이름·상호·전화·메일·서술형 없음 · LEEME 에 확인번호·문구
//     · 플랫폼 세션 무효면 기록 안 남김(행 삭제) · 다운로드 표로 ERP·열람 API 못 엶 · 공개 끄면 다운로드 404 · 관리는 디렉터만
//     · ERP 화면: 🛡 → 영역 찾기 → 검은 사각형 칠해 업로드
//     · 플랫폼 index.html 「고객 설문」 화면: [⬇ 설문지 전체 다운로드] → 플랫폼 세션으로 ERP 확인 → 한국어 문구(+스페인어) → 체크해야 활성 → 동의 기록 → 다운로드 링크
//       (survey.html 안에는 다운로드 버튼이 없다)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { join } from 'node:path';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
process.env.NODE_ENV = 'test';
process.env.SURVEY_AI_CONCURRENCY = '1';
process.env.SURVEY_AI_PAUSE_MS = '50';

const REPO = new URL('../../', import.meta.url);
const read = (f) => readFileSync(new URL(f, REPO), 'utf8');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch (_) {}
const jt = JSDOM ? test : test.skip;
const dbTest = PG ? test : test.skip;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HANGUL = /[가-힣]/;

const RD = await import('../src/surveyRedact.js');

const QUESTIONS = [
  { k: 'q1', no: 1, type: 'info', text: 'Nombre:' },
  { k: 'q2', no: 2, type: 'info', text: 'Empresa / Taller:' },
  { k: 'q3', no: 3, type: 'info', text: 'Teléfono:' },
  { k: 'q4', no: 4, type: 'info', text: 'Correo:' },
  { k: 'q5', no: 5, type: 'single', seg: true, text: 'Puesto:', options: ['Mecánico', 'Dueño', 'Otro'] },
  { k: 'q6', no: 6, type: 'text', text: 'Comentarios' },
  { k: 'q7', no: 7, type: 'geo', free: true, seg: true, text: 'Ubicación escrita a mano', options: [] },
];

// ── A. 순수 로직 ─────────────────────────────────────────────────────
test('A1. 가릴 영역 정규화 — 천분율·여백·뒤집힌 좌표·장 전체 무시·종류', () => {
  const keys = new Set(['q1', 'q2']);
  const b = RD.normBox({ k: 'q1', x0: 100, y0: 200, x1: 600, y1: 230 }, keys);
  assert.deepEqual(b, { k: 'q1', x0: 0.075, y0: 0.188, x1: 0.625, y1: 0.242 });
  const sw = RD.normBox({ k: 'zz', x0: 600, y0: 230, x1: 100, y1: 200 }, keys);
  assert.equal(sw.k, 'otro'); assert.ok(sw.x0 < sw.x1 && sw.y0 < sw.y1);
  assert.equal(RD.normBox({ x0: 0, y0: 0, x1: 1000, y1: 1000 }, keys), null, '장 전체는 무시');
  assert.equal(RD.normBox({ x0: 'a', y0: 1, x1: 2, y1: 3 }, keys), null);
  const thin = RD.normBox({ k: 'q2', x0: 0.1, y0: 0.5, x1: 0.4, y1: 0.505 }, keys);
  assert.ok(thin.y1 - thin.y0 >= 0.024, '아주 얇은 줄도 최소 높이');
  const p = RD.parseRedactJson('```json\n{"boxes":[{"k":"q1","x0":50,"y0":60,"x1":900,"y1":110},{"x0":10,"y0":10},{"x0":0,"y0":0,"x1":1000,"y1":1000}],"notas":""}\n```', QUESTIONS);
  assert.equal(p.boxes.length, 1); assert.equal(RD.parseRedactJson('nada', QUESTIONS), null);
  const prompt = RD.buildRedactPrompt(QUESTIONS);
  assert.match(prompt, /"k":"q1"/); assert.match(prompt, /folio en ROJO/); assert.ok(!/"k":"q5"/.test(prompt), '선택 문항은 가릴 대상 아님');
});

test('A2. 놓친 칸 보충(중앙값, 3장 이상) · 위치 모르는 칸은 확인 필요', () => {
  const box = (k, y) => ({ k, x0: 0.1, y0: y, x1: 0.8, y1: y + 0.04 });
  const pages = [1, 2, 3].map((i) => ({ redact_boxes: [box('q1', 0.10 + i * 0.001), box('q2', 0.15), box('q3', 0.20)] }));
  const med = RD.medianBoxes(pages);
  assert.deepEqual(Object.keys(med).sort(), ['q1', 'q2', 'q3']);
  assert.equal(med.q1.y0, 0.102);
  assert.deepEqual(RD.medianBoxes(pages.slice(0, 2)), {}, '2장으로는 중앙값을 쓰지 않는다');
  const pg = { answers: { q1: 'Juan', q2: 'Taller X', q3: '', q4: 'a@b.mx' }, redact_boxes: [box('q1', 0.1)] };
  const plan = RD.boxesForPage(pg, QUESTIONS, med);
  assert.deepEqual(plan.filled, ['q2']); assert.deepEqual(plan.missing, ['q4']);
  assert.equal(plan.boxes.length, 2, 'q1(자기 것) + q2(보충) · 빈 q3 은 칠하지 않음');
});

test('A3. 확인 문구 — 스페인어 · CTR 책임 · sha 고정 / CSV 에 개인정보·서술형 없음', () => {
  assert.match(RD.ACK_TEXT, /CTR asume la responsabilidad/);
  assert.match(RD.ACK_TEXT, /책임은 CTR 이 집니다/);
  assert.ok(RD.ACK_TEXT.startsWith(RD.ACK_LINES_KO[0]), '한국어 본문 + 스페인어 병기');
  assert.ok(RD.ACK_TEXT.includes(RD.ACK_LINES.join('\n')));
  assert.ok(!HANGUL.test(RD.ACK_LINES.join('')), '스페인어 쪽에는 한글 없음');
  assert.equal(RD.ACK_SHA, RD.sha256(RD.ACK_TEXT));
  const pages = [{ id: 1, status: 'done', red_number: '0101', file_name: 'R_0101.jpg', answers: { q1: 'Juan Pérez', q2: 'Taller Pérez', q3: '81-1111-2222', q4: 'juan@x.mx', q5: 'Mecánico', q6: 'llamen a Juan', q7: 'Nuevo León' }, geo: { q7: { estado: 'Nuevo León', ciudad: 'Monterrey' } } }];
  const csv = RD.buildCsv(QUESTIONS, pages, new Set([1]));
  for (const pii of ['Juan', 'Pérez', '81-1111-2222', 'juan@x.mx', 'llamen']) assert.ok(!csv.includes(pii), 'CSV 에 들어가면 안 됨: ' + pii);
  assert.match(csv, /0101,R_0101\.jpg,Sí,Mecánico,Nuevo León,Monterrey/);
  assert.equal(csv.charCodeAt(0), 0xFEFF, '엑셀용 BOM');
});

// ── B. 실 DB 종단 ───────────────────────────────────────────────────
const jpg = (marker) => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from(marker)]);

dbTest('B. 영역 찾기 → 가린 사본 → 동의 기록 → zip(가린 사본만) · 차단·권한 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const R = await import('../src/routes/surveyRoutes.js');
  const V = await import('../src/surveyViewer.js');

  // 가짜 Claude — 그림 표식 RD:<경우>
  let fail429 = 1;
  const BOX = { q1: { k: 'q1', x0: 100, y0: 100, x1: 900, y1: 140 }, q2: { k: 'q2', x0: 100, y0: 160, x1: 900, y1: 200 }, q3: { k: 'q3', x0: 100, y0: 220, x1: 600, y1: 260 } };
  R.surveyAiApi.call = async (content) => {
    const media = content.find((b) => b.type === 'image');
    const text = content.find((b) => b.type === 'text').text;
    if (!text.includes('Coordenadas en milésimas')) return { ok: false, error: 'unexpected', transient: false };
    const m = /RD:(\w+)/.exec(Buffer.from(media.source.data, 'base64').toString('latin1')) || [];
    if (m[1] === 'A1' && fail429 > 0) { fail429--; return { ok: false, status: 429, error: 'ai: rate', transient: true }; }
    const k = { A1: ['q1', 'q2', 'q3'], A2: ['q1', 'q2', 'q3'], A3: ['q1', 'q2', 'q3'], B: ['q1'], C: [], D: ['q1', 'q2', 'q3'] }[m[1]] || [];
    return { ok: true, text: JSON.stringify({ boxes: k.map((x) => BOX[x]) }) };
  };
  const pfLogs = [];
  V.platformApi.log = async (tok, txt) => { pfLogs.push({ tok, txt }); return tok.startsWith('aaaaaaaa') ? { ok: true } : { ok: false, invalid: true }; };
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET, sign: { expiresIn: '1h' } });
  app.register(R.default);
  await app.ready();

  const TAG = 'DL' + String(Date.now()).slice(-6);
  const mk = async (name, role) => Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name + TAG, role, (name + TAG).toLowerCase()])).rows[0].id);
  const dir = await mk('Dir', 'director');
  const mkt = await mk('Mkt', 'marketing');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'marketing','anywhere','edit')`, [mkt]);
  const sid = Number((await query(`INSERT INTO surveys (title, code_prefix, survey_date, questions, created_by, platform_visible) VALUES ($1,'RUJAC','2026-09-14',$2,$3,true) RETURNING id`,
    ['RUJAC ' + TAG, JSON.stringify(QUESTIONS), dir])).rows[0].id);
  const ans = (n, extra = {}) => ({ q1: 'Juan Pérez ' + n, q2: 'Taller Pérez ' + n, q3: '81-1111-22' + n, q4: '', q5: 'Mecánico', q6: 'llamen a Juan ' + n, q7: 'Nuevo León', ...extra });
  const cases = [['A1', ans(11)], ['A2', ans(12)], ['A3', ans(13)], ['B', ans(14)], ['C', ans(15)], ['D', ans(16, { q4: 'juan16@x.mx' })]];
  const pid = {};
  let seq = 0;
  for (const [c, a] of cases) {
    seq++;
    pid[c] = Number((await query(
      `INSERT INTO survey_pages (survey_id, seq, mime, file_data, view_data, status, answers, geo, red_number, uploaded_by)
       VALUES ($1,$2,'image/jpeg',$3,$4,'done',$5,$6,$7,$8) RETURNING id`,
      [sid, seq, jpg('ORIGINAL-FILE RD:' + c), jpg('ORIGINAL-VIEW RD:' + c), JSON.stringify(a), JSON.stringify({ q7: { estado: 'Nuevo León', ciudad: 'Monterrey', raw: 'Mty' } }), '01' + String(seq).padStart(2, '0'), dir])).rows[0].id);
  }
  t.after(async () => {
    await query(`DELETE FROM survey_download_acks WHERE survey_id=$1`, [sid]).catch(() => {});
    await query(`DELETE FROM survey_pages WHERE survey_id=$1`, [sid]).catch(() => {});
    await query(`DELETE FROM surveys WHERE id=$1`, [sid]).catch(() => {});
    await query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[])`, [[dir, mkt]]).catch(() => {});
    await query(`DELETE FROM user_page_access WHERE user_id = ANY($1::bigint[])`, [[dir, mkt]]);
    await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [[dir, mkt]]);
    await app.close(); await pool.end();
  });
  const call = async (token, method, url, payload) => {
    const r = await app.inject({ method, url, headers: token ? { authorization: 'Bearer ' + token } : {}, payload });
    let j = null; try { j = r.json(); } catch (_) {}
    return { code: r.statusCode, j, raw: r.rawPayload, headers: r.headers };
  };
  const erp = (uid) => app.jwt.sign({ sub: uid });

  // 권한 — 디렉터만
  assert.equal((await call(erp(mkt), 'GET', `/api/surveys/${sid}/redact`)).code, 403);
  assert.equal((await call(erp(mkt), 'POST', `/api/surveys/${sid}/redact-scan`, {})).code, 403);
  assert.equal((await call(erp(mkt), 'GET', '/api/surveys/download-acks')).code, 403);

  // ① 영역 찾기
  const sc = await call(erp(dir), 'POST', `/api/surveys/${sid}/redact-scan`, { scope: 'new' });
  assert.equal(sc.j.queued, 6);
  assert.ok(await R.drainForTest());
  let st = (await call(erp(dir), 'GET', `/api/surveys/${sid}/redact`)).j;
  const it = (c) => st.items.find((x) => x.id === pid[c]);
  assert.equal(st.counts.scanned, 6); assert.equal(st.counts.errors, 0);
  assert.deepEqual(it('B').filled.sort(), ['q2', 'q3'], 'B: 놓친 칸 보충');
  assert.deepEqual(it('C').filled.sort(), ['q1', 'q2', 'q3'], 'C: 하나도 못 찾음 → 전부 보충');
  assert.deepEqual(it('D').missing, ['q4'], 'D: 메일은 위치를 모름 → 확인 필요');
  assert.equal(st.counts.review, 1); assert.equal(st.counts.to_paint, 6);

  // ② 가린 사본 올리기
  assert.equal((await call(erp(dir), 'PUT', `/api/surveys/pages/${pid.A1}/redacted`, { data_b64: Buffer.from('nojpeg').toString('base64'), boxes: it('A1').boxes })).j.error, 'not_jpeg');
  assert.equal((await call(erp(dir), 'PUT', `/api/surveys/pages/${pid.A1}/redacted`, { data_b64: jpg('x').toString('base64'), boxes: [] })).j.error, 'no_boxes_used');
  const d409 = await call(erp(dir), 'PUT', `/api/surveys/pages/${pid.D}/redacted`, { data_b64: jpg('REDACTED-D').toString('base64'), boxes: it('D').boxes });
  assert.equal(d409.code, 409); assert.equal(d409.j.error, 'redact_review_needed');
  for (const c of ['A1', 'A2', 'A3', 'B', 'C']) {
    const r = await call(erp(dir), 'PUT', `/api/surveys/pages/${pid[c]}/redacted`, { data_b64: jpg('REDACTED-' + c).toString('base64'), boxes: it(c).boxes });
    assert.equal(r.code, 200, c + ' ' + JSON.stringify(r.j));
  }
  assert.equal((await call(erp(dir), 'PATCH', `/api/surveys/pages/${pid.A3}/redact`, { excluded: true })).j.excluded, true);
  st = (await call(erp(dir), 'GET', `/api/surveys/${sid}/redact`)).j;
  assert.equal(st.counts.ready, 4); assert.equal(st.counts.excluded, 1);

  // ③ 플랫폼 — 열람 데이터에 다운로드 정보
  V.platformApi.check = async (tok) => (tok.startsWith('aaaaaaaa') ? { ok: true } : { ok: false, invalid: true });
  const GOOD = 'aaaaaaaa-1111-2222-3333-444444444444';
  const tok = (await call(null, 'POST', '/api/survey-viewer/platform-login', { token: GOOD, name: 'Kim CTR' })).j.token;
  const info = (await call(tok, 'GET', `/api/survey-viewer/surveys/${sid}/download-info`)).j;
  assert.equal(info.ready, 4); assert.equal(info.done, 6); assert.equal(info.title, 'RUJAC ' + TAG);
  assert.equal(info.ack.sha, RD.ACK_SHA); assert.deepEqual(info.ack.lines_ko, RD.ACK_LINES_KO); assert.deepEqual(info.ack.lines_es, RD.ACK_LINES);
  assert.ok(!('download' in (await call(tok, 'GET', `/api/survey-viewer/surveys/${sid}`)).j), '설문 화면 데이터에는 다운로드 정보 없음');
  assert.equal((await call(erp(dir), 'GET', `/api/survey-viewer/surveys/${sid}/download-info`)).code, 401, 'ERP 토큰 불가');

  // ④ 동의 — 문구·세션 검증
  const AURL = `/api/survey-viewer/surveys/${sid}/download-ack`;
  assert.equal((await call(tok, 'POST', AURL, { accept: false, version: RD.ACK_VERSION, sha: RD.ACK_SHA, platform_token: GOOD })).j.error, 'ack_required');
  assert.equal((await call(tok, 'POST', AURL, { accept: true, version: RD.ACK_VERSION, sha: 'x', platform_token: GOOD })).j.error, 'ack_required');
  const bad = await call(tok, 'POST', AURL, { accept: true, version: RD.ACK_VERSION, sha: RD.ACK_SHA, platform_token: 'bbbbbbbb-1111-2222-3333-444444444444' });
  assert.equal(bad.code, 401);
  assert.equal(Number((await query(`SELECT COUNT(*)::int AS n FROM survey_download_acks WHERE survey_id=$1`, [sid])).rows[0].n), 0, '세션 무효면 기록 안 남김');
  assert.equal((await call(erp(dir), 'POST', AURL, { accept: true, version: RD.ACK_VERSION, sha: RD.ACK_SHA, platform_token: GOOD })).code, 401, 'ERP 토큰으로 동의 불가');
  const ok = await call(tok, 'POST', AURL, { accept: true, version: RD.ACK_VERSION, sha: RD.ACK_SHA, platform_token: GOOD });
  assert.equal(ok.code, 200, JSON.stringify(ok.j)); assert.equal(ok.j.ready, 4);
  const row = (await query(`SELECT * FROM survey_download_acks WHERE id=$1`, [ok.j.ack_id])).rows[0];
  assert.equal(row.ack_text, RD.ACK_TEXT, '문구 전문 기록'); assert.equal(row.viewer_name, 'Kim CTR'); assert.equal(row.platform_logged, true);
  assert.equal(row.platform_session_sha, RD.sha256(GOOD)); assert.ok(!JSON.stringify(row).includes(GOOD), '플랫폼 토큰 원문은 저장 안 함');
  const lastLog = pfLogs[pfLogs.length - 1];
  assert.match(lastLog.txt, new RegExp('확인번호 #' + ok.j.ack_id)); assert.match(lastLog.txt, /CTR/);

  // ⑤ 다운로드 — 표로만, 가린 사본만
  const ticket = new URL('http://x' + ok.j.url).searchParams.get('t');
  for (const u of ['/api/surveys', `/api/surveys/${sid}`]) assert.equal((await call(ticket, 'GET', u)).code, 401, '표로 ERP 불가: ' + u);
  assert.equal((await call(ticket, 'GET', '/api/survey-viewer/surveys')).code, 401, '표로 열람 API 불가');
  assert.equal((await call(null, 'GET', '/api/survey-viewer/download?t=nope')).code, 401);
  const z = await call(null, 'GET', ok.j.url);
  assert.equal(z.code, 200); assert.equal(z.headers['content-type'], 'application/zip');
  assert.match(z.headers['content-disposition'], /RUJAC_encuestas_sin_datos_personales_\d{8}\.zip/);
  const zbuf = z.raw;
  assert.ok(!zbuf.includes(Buffer.from('ORIGINAL')), '원본 바이트가 zip 에 없다');
  for (const c of ['A1', 'A2', 'B', 'C']) assert.ok(zbuf.includes(Buffer.from('REDACTED-' + c)), c + ' 가린 사본 포함');
  assert.ok(!zbuf.includes(Buffer.from('REDACTED-A3')), '뺀 장 없음');
  const dir2 = mkdtempSync(join(os.tmpdir(), 'dl-')); const zp = join(dir2, 'x.zip'); writeFileSync(zp, zbuf);
  execFileSync('unzip', ['-tq', zp]);
  const names = execFileSync('unzip', ['-Z1', zp]).toString().trim().split('\n').sort();
  assert.deepEqual(names, ['LEEME.txt', 'datos.csv', 'encuestas/RUJAC_0101.jpg', 'encuestas/RUJAC_0102.jpg', 'encuestas/RUJAC_0104.jpg', 'encuestas/RUJAC_0105.jpg']);
  const csv = execFileSync('unzip', ['-p', zp, 'datos.csv']).toString();
  for (const pii of ['Juan', 'Pérez', '81-1111', 'juan16@x.mx', 'llamen']) assert.ok(!csv.includes(pii), 'CSV: ' + pii);
  assert.equal(csv.trim().split(/\r?\n/).length, 7, '머리 + 판독 6장(사진 포함 여부 표시)');
  const leeme = execFileSync('unzip', ['-p', zp, 'LEEME.txt']).toString();
  assert.match(leeme, new RegExp('N\\.º de confirmación: ' + ok.j.ack_id)); assert.match(leeme, /Kim CTR/); assert.ok(leeme.includes(RD.ACK_LINES[4]));
  assert.match(leeme, /2 encuestas leídas no se incluyen/);
  const after = (await query(`SELECT download_count, downloaded_at FROM survey_download_acks WHERE id=$1`, [ok.j.ack_id])).rows[0];
  assert.equal(Number(after.download_count), 1); assert.ok(after.downloaded_at);

  // ⑥ 기록 — 디렉터 화면용
  const acks = (await call(erp(dir), 'GET', `/api/surveys/download-acks?survey_id=${sid}`)).j.items;
  assert.equal(acks.length, 1); assert.equal(acks[0].viewer_name, 'Kim CTR'); assert.equal(acks[0].download_count, 1); assert.equal(acks[0].files_ready, 4);

  // ⑦ 공개를 끄면 받은 표로도 다운로드 불가
  await call(erp(dir), 'PATCH', `/api/surveys/${sid}/platform`, { visible: false });
  assert.equal((await call(null, 'GET', ok.j.url)).code, 404);
  // 전체 다시 → 만든 사본은 버려진다
  await call(erp(dir), 'POST', `/api/surveys/${sid}/redact-scan`, { scope: 'all' });
  assert.equal(Number((await query(`SELECT COUNT(*)::int AS n FROM survey_pages WHERE survey_id=$1 AND redact_data IS NOT NULL`, [sid])).rows[0].n), 0);
  assert.ok(await R.drainForTest());
});

// ── C. ERP 화면 (jsdom) ─────────────────────────────────────────────
jt('C. ERP: 🛡 가린 사본 만들기 → 영역 찾기 → 검은 사각형 칠해 업로드 · 확인 필요 장은 건너뜀 · 기록 표', async () => {
  const log = []; const fills = [];
  let scanned = false;
  const items = () => [
    { id: 11, seq: 1, folio: '0101', scan: scanned ? 'done' : null, has_redacted: false, excluded: false, missing: [], filled: [], boxes: [{ k: 'q1', x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.15 }] },
    { id: 12, seq: 2, folio: '0102', scan: scanned ? 'done' : null, has_redacted: false, excluded: false, missing: ['q4'], filled: [], boxes: [] },
  ];
  const counts = () => ({ done: 2, scanned: scanned ? 2 : 0, scanning: 0, errors: 0, ready: 0, to_paint: scanned ? 2 : 0, excluded: 0, review: scanned ? 1 : 0 });
  const dom = new JSDOM(read('refatrix-survey.html'), {
    url: 'https://erp.refatrix.com/refatrix-survey.html', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.sessionStorage.setItem('refatrix_session', JSON.stringify({ token: 't', api: 'https://api.test', user: { id: 1, name: 'Dir', role: 'director' }, perm: { role: 'director' } }));
      w.confirm = () => true; w.scrollTo = () => {}; w.print = () => {}; w.alert = () => {};
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.createImageBitmap = async () => ({ width: 1000, height: 1400 });
      w.HTMLCanvasElement.prototype.getContext = function () { return { fillStyle: '', fillRect: (x, y, ww, hh) => fills.push({ style: this._ctxStyle, x, y, w: ww, h: hh }), drawImage() {} }; };
      w.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new w.Blob([new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2])], { type: 'image/jpeg' })); };
      w.fetch = async (url, opt = {}) => {
        const u = String(url).replace('https://api.test', ''); const m = (opt.method || 'GET').toUpperCase();
        log.push(m + ' ' + u + (opt.body && m !== 'GET' ? ' ' + opt.body : ''));
        let body = {};
        if (u === '/api/surveys' && m === 'GET') body = { items: [{ id: 2, title: 'RUJAC_01', code_prefix: 'RUJAC', total: 2, done: 2 }] };
        else if (u === '/api/surveys/2') body = { id: 2, title: 'RUJAC_01', code_prefix: 'RUJAC', questions: QUESTIONS, counts: { total: 2, done: 2 }, can_edit: true, is_director: true, ai_ready: true };
        else if (u === '/api/surveys/2/pages') body = { items: [], counts: { total: 2, done: 2 }, ai_ready: true };
        else if (u === '/api/surveys/viewers') body = { items: [], platform: [{ id: 2, title: 'RUJAC_01', code_prefix: 'RUJAC', visible: true }] };
        else if (u === '/api/surveys/2/redact') body = { ai_ready: true, counts: counts(), items: items() };
        else if (u === '/api/surveys/2/redact-scan') { scanned = true; body = { ok: true, queued: 2, ai_ready: true }; }
        else if (u === '/api/surveys/download-acks') body = { items: [{ id: 7, survey_id: 2, title: 'RUJAC_01', code_prefix: 'RUJAC', viewer_name: 'Kim CTR', ack_version: '2026-09-30', ack_text: 'x', files_ready: 120, files_done: 157, ip: '1.2.3.4', created_at: '2026-09-30 21:00', downloaded_at: '2026-09-30 21:01', download_count: 1 }] };
        else if (u === '/api/surveys/pages/11/view') return { ok: true, status: 200, blob: async () => new w.Blob(['img'], { type: 'image/jpeg' }), json: async () => ({}) };
        else if (u === '/api/surveys/pages/11/redacted' && m === 'PUT') body = { ok: true };
        return { ok: true, status: 200, json: async () => body, blob: async () => new w.Blob([]) };
      };
    },
  });
  const w = dom.window; const d = w.document;
  for (let i = 0; i < 40 && !d.getElementById('surveySel')?.options.length; i++) await wait(25);
  const sel = d.getElementById('surveySel'); if (sel && sel.value !== '2') { sel.value = '2'; sel.dispatchEvent(new w.Event('change')); }
  await wait(150);
  const btn = d.getElementById('btnViewers'); assert.match(btn.textContent, /플랫폼 공개/);
  btn.click(); await wait(80);
  assert.match(d.getElementById('rdCard').textContent, /개인정보 가린 사본/);
  assert.match(d.getElementById('ackCard').textContent, /Kim CTR/);
  d.getElementById('rdGo').click(); await wait(150);
  assert.ok(log.some((l) => l.startsWith('POST /api/surveys/2/redact-scan') && l.includes('"scope":"new"')));
  const put = log.filter((l) => l.startsWith('PUT /api/surveys/pages/'));
  assert.equal(put.length, 1, '확인 필요 장(12)은 칠하지 않는다');
  assert.ok(put[0].startsWith('PUT /api/surveys/pages/11/redacted'));
  const body = JSON.parse(put[0].slice(put[0].indexOf('{')));
  assert.ok(body.data_b64.length > 4); assert.deepEqual(body.boxes, [{ k: 'q1', x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.15 }]);
  const black = fills.filter((f) => f.w === 800);
  assert.equal(black.length, 1, '1000px 폭 × (0.9-0.1) = 800px 검은 사각형');
  assert.equal(black[0].x, 100); assert.equal(black[0].y, 140);
  w.close();
});

// ── D. 플랫폼 index.html (jsdom) ─────────────────────────────────────
const PF_INDEX = '/home/claude/platform/index.html';
const pfIndex = () => { try { return readFileSync(PF_INDEX, 'utf8'); } catch (_) { return null; } };
jt('D. 플랫폼 index.html: [⬇ 설문지 전체 다운로드] → 문구(한국어+스페인어) → 체크해야 활성 → 동의 기록 → 다운로드 링크 · 준비 0장이면 불가', async () => {
  const html = pfIndex(); if (!html) return;
  const PFTOK = 'aaaaaaaa-1111-2222-3333-444444444444';
  const run = async (ready) => {
    const log = []; const clicks = [];
    const dom = new JSDOM(html, { url: 'https://refatrix-platform.netlify.app/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w) {
        w.sessionStorage.setItem('rfx_sess', JSON.stringify({ t: PFTOK, u: { id: 1, name: 'Kim CTR', role: 'dev' }, e: Date.now() + 3600e3 }));
        w.scrollTo = () => {};
        w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
        w.HTMLAnchorElement.prototype.click = function () { clicks.push(this.href); };
        w.fetch = async (url, opt = {}) => {
          const u = String(url); log.push({ u, body: opt.body, auth: opt.headers && opt.headers.Authorization });
          let body = [];
          if (u.includes('supabase.co')) body = [];
          else if (u.endsWith('/api/survey-viewer/platform-login')) body = { token: 'VTOK', name: 'Kim CTR', surveys: [{ id: 2, title: 'RUJAC_01' }] };
          else if (u.endsWith('/surveys/2/download-info')) body = { id: 2, title: 'RUJAC_01', ready, done: 157, ack: { version: RD.ACK_VERSION, sha: RD.ACK_SHA, lines_ko: RD.ACK_LINES_KO, lines_es: RD.ACK_LINES } };
          else if (u.endsWith('/surveys/2/download-ack')) body = { ok: true, ack_id: 9, created_at: '2026-09-30 21:00:00', ready, url: '/api/survey-viewer/download?t=TICKET' };
          return { ok: true, status: 200, json: async () => body };
        };
      } });
    await wait(150);
    return { w: dom.window, d: dom.window.document, log, clicks };
  };
  const z = await run(0);
  z.d.getElementById('navSurvey').click(); await wait(10);
  assert.ok(!z.d.getElementById('viewSurvey').classList.contains('hidden'));
  z.d.getElementById('svDl').click(); await wait(60);
  assert.ok(z.d.getElementById('svDlChk').disabled && z.d.getElementById('svDlGo').disabled, '준비 0장이면 동의·다운로드 불가');
  z.w.close();

  const { w, d, log, clicks } = await run(120);
  d.getElementById('navSurvey').click(); await wait(10);
  d.getElementById('svDl').click(); await wait(60);
  const pl = log.find((x) => x.u.endsWith('/platform-login'));
  assert.deepEqual(JSON.parse(pl.body), { token: PFTOK, name: 'Kim CTR' }, '이 플랫폼 세션으로 확인');
  assert.equal(log.find((x) => x.u.endsWith('/download-info')).auth, 'Bearer VTOK');
  const m = d.getElementById('svDlModal'); assert.ok(m.classList.contains('show'));
  const t = m.textContent;
  assert.match(t, /책임은 CTR 이 집니다/); assert.match(t, /CTR asume la responsabilidad/);
  assert.match(t, /사진 120장/); assert.match(t, /37장은 가림 준비가 안 되어 빠집니다/); assert.match(t, /Kim CTR/);
  assert.ok(d.getElementById('svDlGo').disabled, '체크 전에는 비활성');
  const chk = d.getElementById('svDlChk'); chk.checked = true; chk.dispatchEvent(new w.Event('change'));
  assert.ok(!d.getElementById('svDlGo').disabled);
  d.getElementById('svDlGo').click(); await wait(60);
  const ack = log.find((x) => x.u.endsWith('/download-ack'));
  assert.deepEqual(JSON.parse(ack.body), { accept: true, version: RD.ACK_VERSION, sha: RD.ACK_SHA, platform_token: PFTOK });
  assert.equal(ack.auth, 'Bearer VTOK');
  assert.deepEqual(clicks, ['https://refatrix-production.up.railway.app/api/survey-viewer/download?t=TICKET']);
  assert.match(d.getElementById('svDlOk').textContent, /확인번호 #9 기록됨/);
  d.getElementById('svDlX').click(); assert.ok(!m.classList.contains('show'));
  w.close();
});

test('D2. survey.html(설문 화면) 안에는 다운로드 버튼이 없다 · 플랫폼 index 는 설문 메뉴 유지', () => {
  const tpl = read('refatrix-api/templates/survey_platform.html');
  assert.ok(!/btnDl|download-ack|Descargar encuestas/.test(tpl));
  const h = pfIndex(); if (!h) return;
  assert.match(h, /<button id="navSurvey">고객 설문<\/button>/); assert.match(h, /id="svDl"/); assert.match(h, /f\.src="survey\.html"/);
});

test('E. 빌드 토큰 · Netlify 사본과 레포 원본 일치', () => {
  assert.match(read('refatrix-survey.html'), /build 20260930sv12/);
  let h = null; try { h = readFileSync('/home/claude/platform/survey.html', 'utf8'); } catch (_) { return; }
  assert.equal(h, read('refatrix-api/templates/survey_platform.html'), 'Netlify survey.html = 레포 원본');
});
