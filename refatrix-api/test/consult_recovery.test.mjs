// =====================================================================
// 끊긴 녹음 업로드 복구 + 토큰 슬라이딩 갱신 검증 — 실 PostgreSQL + 실 라우트(app.inject)
//
//   배경(2026-09-04 · dante 미팅 녹음): 2시간짜리 녹음을 브라우저에 들고 있는 동안
//   로그인 토큰(6h)이 만료 → 업로드가 401 로 거절 → 화면이 로그인으로 떨어지며 녹음 소실.
//   서버 쪽 대책 두 가지를 검증한다.
//     ① POST /api/auth/refresh — 아직 살아 있는 토큰으로 새 토큰(만료 뒤에는 불가)
//     ② GET  /api/consults/recordings/pending-uploads — 올라가다 끊긴 조각을 다시 찾아
//        commit 으로 이어붙일 수 있다. 조각 보관도 6h → 72h.
//
//   실행: TEST_PG_URL=postgres://... node --test test/consult_recovery.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanWebm } from '../src/audioSplit.js';
import { NORMAL_WEBM_B64 } from './fixtures/consult_webm.mjs';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, pool, consultRoutes, authRoutes, Fastify, jwt, app, requeueStuck;
const tok = {};
const ID = {};
const TAG = 'CSREC';
// 유효한 base64(3의 배수 길이) — 조각 본문
const B64 = 'QUJD'.repeat(64);

async function boot() {
  ({ query, pool } = await import('../src/db.js'));
  consultRoutes = (await import('../src/routes/consultRoutes.js')).default;
  ({ requeueStuck } = await import('../src/routes/consultRoutes.js'));
  authRoutes = (await import('../src/routes/authRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  const CS = `SELECT id FROM sales_consults WHERE company_name LIKE '${TAG}%'`;
  await query(`DELETE FROM sales_consult_upload_parts WHERE consult_id IN (${CS})`);
  await query(`DELETE FROM sales_consult_recordings WHERE consult_id IN (${CS})`);
  try { await query(`DELETE FROM sales_consult_pendings WHERE consult_id IN (${CS})`); } catch (_) {}
  await query(`DELETE FROM sales_consults WHERE company_name LIKE '${TAG}%'`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'csrec%')`);
  await query(`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE login_id LIKE 'csrec%')`);
  await query(`DELETE FROM users WHERE login_id LIKE 'csrec%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`,
    [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'csrec_dir');
  ID.other = await mkUser(`${TAG}다른영업`, 'sales', 'csrec_other');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
               VALUES ($1,'pipeline','anywhere','edit') ON CONFLICT DO NOTHING`, [ID.other]);

  ID.consult = Number((await query(
    `INSERT INTO sales_consults (consult_date, company_name, created_by)
     VALUES (CURRENT_DATE, $1, $2) RETURNING id`, [`${TAG} dante`, ID.dir])).rows[0].id);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret', sign: { expiresIn: '6h' } });
  await app.register(authRoutes);
  await app.register(consultRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir, role: 'director' }, { expiresIn: '6h' });
  tok.other = app.jwt.sign({ sub: ID.other, role: 'sales' }, { expiresIn: '6h' });
  // 만료 토큰: fast-jwt 의 숫자 expiresIn 은 밀리초 — 1ms 로 서명하고 잠깐 기다리면 만료된다
  tok.expired = app.jwt.sign({ sub: ID.dir, role: 'director' }, { expiresIn: 1 });
  await new Promise((r) => setTimeout(r, 1200));
}
const get = (who, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + (tok[who] || who) } });
const post = (who, url, body) => app.inject({ method: 'POST', url, payload: body,
  headers: { authorization: 'Bearer ' + (tok[who] || who) } });
const del = (who, url) => app.inject({ method: 'DELETE', url, headers: { authorization: 'Bearer ' + (tok[who] || who) } });

const putPart = (who, key, seg, part, b64 = B64) =>
  post(who, `/api/consults/${ID.consult}/recordings/parts`, { session_key: key, seg_no: seg, part_no: part, b64 });

test('boot', { skip: SKIP }, async () => { await boot(); });

// ── ① 토큰 슬라이딩 갱신 ────────────────────────────────────────────────
test('① 살아 있는 토큰으로 새 토큰을 받는다 — 그 토큰이 실제로 쓰인다', { skip: SKIP }, async () => {
  const r = await post('dir', '/api/auth/refresh', {});
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.ok(d.token && d.token.length > 20);
  assert.equal(d.user.id, ID.dir);
  assert.equal(d.user.role, 'director');
  const use = await get(d.token, '/api/consults/recordings/pending-uploads');
  assert.equal(use.statusCode, 200, '새 토큰으로 API 가 열린다');
});

test('② 이미 만료된 토큰으로는 갱신되지 않는다 (재로그인해야 한다)', { skip: SKIP }, async () => {
  const r = await post(tok.expired, '/api/auth/refresh', {});
  assert.equal(r.statusCode, 401, '만료 토큰은 401 — 무한 연장이 되지 않는다');
  const none = await app.inject({ method: 'POST', url: '/api/auth/refresh' });
  assert.equal(none.statusCode, 401, '토큰 없이도 401');
});

// ── ② 끊긴 업로드 복구 ──────────────────────────────────────────────────
test('③ 올라가다 끊긴 조각이 목록에 잡힌다 (조각수·용량·상담명·보관시간)', { skip: SKIP }, async () => {
  ID.key = 'sess_dante_001';
  for (const p of [0, 1, 2]) {
    const r = await putPart('dir', ID.key, 0, p);
    assert.equal(r.statusCode, 200, r.body);
  }
  const r = await get('dir', '/api/consults/recordings/pending-uploads');
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.equal(d.ttl_hours, 72, '조각 보관은 72시간 — 6시간이면 알아채기 전에 지워졌다');
  const it = d.items.find((x) => x.session_key === ID.key);
  assert.ok(it, '내가 올린 조각 세션이 보인다');
  assert.equal(it.consult_id, ID.consult);
  assert.equal(it.company_name, `${TAG} dante`);
  assert.equal(it.parts, 3);
  assert.equal(it.segments, 1);
  assert.equal(it.size_bytes, Math.round(B64.length * 3 / 4) * 3);
  assert.ok(it.hours_left > 71, '방금 올렸으니 보관 시간이 거의 그대로 남아 있다');
  assert.equal(it.b64, undefined, '조각 본문은 절대 내보내지 않는다');
});

test('④ 여러 구간도 구간 수까지 함께 보인다', { skip: SKIP }, async () => {
  const key = 'sess_dante_002';
  await putPart('dir', key, 0, 0);
  await putPart('dir', key, 1, 0);
  await putPart('dir', key, 1, 1);
  const d = (await get('dir', '/api/consults/recordings/pending-uploads')).json();
  const it = d.items.find((x) => x.session_key === key);
  assert.equal(it.parts, 3);
  assert.equal(it.segments, 2);
  ID.key2 = key;
});

test('⑤ 남의 조각은 보이지 않는다', { skip: SKIP }, async () => {
  const mine = (await get('dir', '/api/consults/recordings/pending-uploads')).json();
  assert.ok(mine.items.some((x) => x.session_key === ID.key));
  const theirs = (await get('other', '/api/consults/recordings/pending-uploads')).json();
  assert.equal(theirs.items.length, 0, '자기가 올린 것만 — 남의 녹음 조각은 목록에도 안 뜬다');
});

test('⑥ 목록에서 본 그 session_key 로 commit 하면 녹음 1건이 만들어지고 목록에서 사라진다', { skip: SKIP }, async () => {
  const before = (await get('dir', '/api/consults/recordings/pending-uploads')).json();
  assert.ok(before.items.some((x) => x.session_key === ID.key));

  const c = await post('dir', `/api/consults/${ID.consult}/recordings/commit`,
    { session_key: ID.key, mime: 'audio/webm', mode: 'full' });
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().status, 'queued');

  const after = (await get('dir', '/api/consults/recordings/pending-uploads')).json();
  assert.ok(!after.items.some((x) => x.session_key === ID.key), '이어붙인 세션은 목록에서 빠진다');
  assert.ok(after.items.some((x) => x.session_key === ID.key2), '아직 안 붙인 세션은 그대로 남는다');

  const rec = (await query(
    `SELECT id, status, mime, length(audio_b64) AS len FROM sales_consult_recordings
      WHERE consult_id=$1 ORDER BY id DESC LIMIT 1`, [ID.consult])).rows[0];
  assert.ok(rec, '녹음 1건 생성');
  assert.equal(rec.mime, 'audio/webm');
  assert.equal(Number(rec.len), B64.length * 3, '조각 3개가 그대로 이어붙었다');
});

test('⑦ duration_sec 를 몰라도(복구 경로) commit 된다', { skip: SKIP }, async () => {
  const key = 'sess_dante_003';
  await putPart('dir', key, 0, 0);
  const c = await post('dir', `/api/consults/${ID.consult}/recordings/commit`, { session_key: key });
  assert.equal(c.statusCode, 200, c.body);
  const rec = (await query(
    `SELECT duration_sec FROM sales_consult_recordings WHERE consult_id=$1 ORDER BY id DESC LIMIT 1`,
    [ID.consult])).rows[0];
  assert.equal(rec.duration_sec, null, '길이는 비워두고 오디오는 살린다');
});

test('⑧ 조각을 버리면 목록에서 사라진다', { skip: SKIP }, async () => {
  const r = await del('dir', `/api/consults/${ID.consult}/recordings/parts?session_key=${ID.key2}`);
  assert.equal(r.statusCode, 200, r.body);
  const d = (await get('dir', '/api/consults/recordings/pending-uploads')).json();
  assert.equal(d.items.length, 0);
});

test('⑨ 회귀 — 기존 조각 업로드·잘못된 session_key 검사는 그대로', { skip: SKIP }, async () => {
  const bad = await post('dir', `/api/consults/${ID.consult}/recordings/parts`,
    { session_key: 'x', seg_no: 0, part_no: 0, b64: B64 });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'bad_session');
  const badChunk = await post('dir', `/api/consults/${ID.consult}/recordings/parts`,
    { session_key: 'sess_ok_0009', seg_no: 0, part_no: 0, b64: '!!!' });
  assert.equal(badChunk.statusCode, 400);
  assert.equal(badChunk.json().error, 'bad_chunk');
  const nf = await post('dir', `/api/consults/99999999/recordings/parts`,
    { session_key: 'sess_ok_0009', seg_no: 0, part_no: 0, b64: B64 });
  assert.equal(nf.statusCode, 404);
});

// ── ③ 25MB 를 넘는 구간도 [이어서 요약] 이 된다 (2026-09-04 dante 사례) ──
//   화면이 구간을 나누기 전에 녹음된 긴 파일은 **구간 하나가 통째로 25MB 초과**다.
//   서버가 클러스터 경계로 나눠 담아야 Whisper 가 받는다.
function bigWebm(minBytes) {
  const src = Buffer.from(NORMAL_WEBM_B64, 'base64');
  const s = scanWebm(src);
  const head = src.subarray(0, s.clusters[0].start);
  const body = src.subarray(s.clusters[0].start);
  const n = Math.ceil(minBytes / body.length);
  return Buffer.concat([head, ...new Array(n).fill(body)]);
}

test('⑩ 구간 하나가 25MB를 넘는 녹음도 commit 되고, 서버가 25MB 이하 구간들로 나눠 담는다', { skip: SKIP }, async () => {
  const key = 'sess_dante_big1';
  const buf = bigWebm(26 * 1024 * 1024);
  assert.ok(buf.length > 25 * 1024 * 1024, '25MB 초과 상황을 실제로 만든다');
  // 브라우저와 같은 방식으로 3바이트 배수 조각으로 잘라 올린다
  const CHUNK = 3 * 1024 * 1024;
  let part = 0;
  for (let off = 0; off < buf.length; off += CHUNK, part++) {
    const r = await putPart('dir', key, 0, part, buf.subarray(off, Math.min(buf.length, off + CHUNK)).toString('base64'));
    assert.equal(r.statusCode, 200, r.body);
  }
  const c = await post('dir', `/api/consults/${ID.consult}/recordings/commit`,
    { session_key: key, mime: 'audio/webm', mode: 'full' });
  assert.equal(c.statusCode, 200, c.body);

  const rec = (await query(
    `SELECT id, size_bytes,
            array_length(string_to_array(audio_b64,'|'),1) AS segs,
            (SELECT max(length(x)) FROM unnest(string_to_array(audio_b64,'|')) x) AS max_seg,
            (SELECT bool_and(left(x,4)='GkXf') FROM unnest(string_to_array(audio_b64,'|')) x) AS all_webm
       FROM sales_consult_recordings WHERE consult_id=$1 ORDER BY id DESC LIMIT 1`, [ID.consult])).rows[0];
  assert.ok(Number(rec.segs) >= 2, '여러 구간으로 나뉘어 저장된다');
  assert.ok(Number(rec.max_seg) <= 34 * 1024 * 1024, '구간마다 Whisper 한도(25MB) 이하');
  assert.equal(rec.all_webm, true, '구간마다 온전한 webm 으로 시작한다(EBML 매직)');
  assert.ok(Number(rec.size_bytes) > 25 * 1024 * 1024, '오디오는 그대로 다 들어 있다');

  const after = (await get('dir', '/api/consults/recordings/pending-uploads')).json();
  assert.ok(!after.items.some((x) => x.session_key === key), '이어붙인 세션은 목록에서 빠진다');
});

test('⑪ 나눌 수 없는 형식(mp4)이 25MB를 넘으면 이유와 함께 거절한다', { skip: SKIP }, async () => {
  const key = 'sess_dante_big2';
  const buf = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'),
    Buffer.alloc(26 * 1024 * 1024, 7)]);
  const CHUNK = 3 * 1024 * 1024;
  let part = 0;
  for (let off = 0; off < buf.length; off += CHUNK, part++) {
    await putPart('dir', key, 0, part, buf.subarray(off, Math.min(buf.length, off + CHUNK)).toString('base64'));
  }
  const c = await post('dir', `/api/consults/${ID.consult}/recordings/commit`,
    { session_key: key, mime: 'audio/mp4', mode: 'full' });
  assert.equal(c.statusCode, 400);
  assert.equal(c.json().error, 'segment_too_large');
  assert.equal(c.json().reason, 'unsupported_format');
  await del('dir', `/api/consults/${ID.consult}/recordings/parts?session_key=${key}`);
});

test('⑫ 처리 도중 서버가 재시작돼 멈춘 건은 자동으로 대기열에 되돌아온다', { skip: SKIP }, async () => {
  // 2시간 전에 시작해 transcribing 에서 멈춘 건 + 방금 시작해 정상 처리 중인 건
  const stuck = Number((await query(
    `INSERT INTO sales_consult_recordings (consult_id, mode, mime, audio_b64, status, attempts, created_by, created_at)
     VALUES ($1,'full','audio/webm','QUJD','transcribing',1,$2, now() - INTERVAL '3 hours') RETURNING id`,
    [ID.consult, ID.dir])).rows[0].id);
  const fresh = Number((await query(
    `INSERT INTO sales_consult_recordings (consult_id, mode, mime, audio_b64, status, attempts, created_by)
     VALUES ($1,'full','audio/webm','QUJD','transcribing',1,$2) RETURNING id`,
    [ID.consult, ID.dir])).rows[0].id);

  const n = await requeueStuck();
  assert.ok(n >= 1);
  const rows = (await query(
    `SELECT id, status, error FROM sales_consult_recordings WHERE id = ANY($1)`, [[stuck, fresh]])).rows;
  const byId = Object.fromEntries(rows.map((r) => [Number(r.id), r]));
  assert.equal(byId[stuck].status, 'queued', '오래 멈춘 건은 되살린다');
  assert.match(byId[stuck].error, /stalled/);
  assert.equal(byId[fresh].status, 'transcribing', '정상 처리 중인 건은 건드리지 않는다');
  await query(`DELETE FROM sales_consult_recordings WHERE id = ANY($1)`, [[stuck, fresh]]);
});

// 라우트를 등록하면 상담 녹음 큐 스케줄러(setInterval)가 돈다 — 테스트가 끝나도 프로세스가 안 죽으므로 정리한다.
test('zz 정리 — 스케줄러·서버·DB 풀 종료', { skip: SKIP }, async () => {
  for (const k of ['__refatrixConsultRecScheduler', '__refatrixConsultPartSweeper']) {
    if (globalThis[k]) { clearInterval(globalThis[k]); globalThis[k] = null; }
  }
  await app.close();
  await pool.end();
});
