// 날짜별 업로드 내역 · 날짜 단위 삭제(2026-11-24) — 실 PostgreSQL
//   실행: TEST_PG_URL=postgres://... NODE_ENV=test node --test test/survey_upload_days.test.mjs
//   못 박는 것
//     · 날짜는 멕시코 시간 기준(UTC 자정 넘긴 업로드도 전날로 묶임)
//     · 삭제는 디렉터만 · 날짜 형식·확인 장수(expect) 불일치 → 거부, 아무것도 안 지움
//     · 그 날짜 장만 지워지고 다른 날짜는 그대로 · AI 요약(ai_cache, 스페인어 포함)은 지워짐 · 감사 기록
//     · 플랫폼 열람 데이터(응답 목록·집계·다운로드 준비 장수)에 바로 반영
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
process.env.NODE_ENV = 'test';
const dbTest = PG ? test : test.skip;
const jpg = (m) => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from(m)]);
const QUESTIONS = [
  { k: 'q1', no: 1, text: 'Nombre', type: 'info' },
  { k: 'q2', no: 2, text: 'Puesto', type: 'single', options: ['Mecánico', 'Dueño'], seg: true },
];

dbTest('날짜별 업로드 내역 → 날짜 삭제 → 플랫폼 반영 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const R = await import('../src/routes/surveyRoutes.js');
  const V = await import('../src/surveyViewer.js');
  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET, sign: { expiresIn: '1h' } });
  app.register(R.default);
  await app.ready();

  const TAG = 'UD' + String(Date.now()).slice(-6);
  const mk = async (name, role) => Number((await query(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [name + TAG, role, (name + TAG).toLowerCase()])).rows[0].id);
  const dir = await mk('Dir', 'director');
  const mkt = await mk('Mkt', 'marketing');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'marketing','anywhere','edit')`, [mkt]);
  const cache = { generated_at: '2026-11-01T00:00:00.000Z', bullets: ['viejo'], themes: {}, es: { src: '2026-11-01T00:00:00.000Z', bullets: ['viejo es'] } };
  const sid = Number((await query(`INSERT INTO surveys (title, code_prefix, questions, created_by, platform_visible, ai_cache) VALUES ($1,'RUJAC',$2,$3,true,$4) RETURNING id`,
    ['RUJAC ' + TAG, JSON.stringify(QUESTIONS), dir, JSON.stringify(cache)])).rows[0].id);
  // 10-26 멕시코 3장(그중 1장은 UTC 로는 10-27 03:00 = 멕시코 10-26 21:00) · 10-27 멕시코 2장
  const ups = [
    ['2026-10-26T15:00:00Z', '0101', 'Mecánico'], ['2026-10-26T18:00:00Z', '0102', 'Mecánico'], ['2026-10-27T03:00:00Z', '0103', 'Dueño'],
    ['2026-10-27T16:00:00Z', '0201', 'Dueño'], ['2026-10-27T17:00:00Z', '0202', 'Dueño'],
  ];
  let seq = 0;
  for (const [at, no, pos] of ups) {
    seq++;
    await query(`INSERT INTO survey_pages (survey_id, seq, mime, file_data, view_data, redact_data, status, answers, red_number, uploaded_by, created_at)
                 VALUES ($1,$2,'image/jpeg',$3,$3,$3,'done',$4,$5,$6,$7)`,
      [sid, seq, jpg('F' + no), JSON.stringify({ q1: 'Juan ' + no, q2: pos }), no, dir, at]);
  }
  t.after(async () => {
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
    return { code: r.statusCode, j };
  };
  const erp = (uid) => app.jwt.sign({ sub: uid });

  // ① 내역 — 멕시코 날짜로 묶임
  const days = (await call(erp(mkt), 'GET', `/api/surveys/${sid}/upload-days`)).j;
  assert.deepEqual(days.items.map((d) => [d.day, d.total]), [['2026-10-27', 2], ['2026-10-26', 3]]);
  assert.equal(days.items[1].num_min, '0101'); assert.equal(days.items[1].num_max, '0103');
  const pg = (await call(erp(mkt), 'GET', `/api/surveys/${sid}/pages`)).j;
  assert.equal(pg.items.find((p) => p.red_number === '0103').up_day, '2026-10-26', 'UTC 10-27 03:00 → 멕시코 10-26');

  // ② 거부 — 권한·형식·확인 장수
  const U = `/api/surveys/${sid}/upload-days/2026-10-26`;
  assert.equal((await call(erp(mkt), 'DELETE', U + '?expect=3')).code, 403, '마케팅 편집권한만으로는 불가');
  assert.equal((await call(erp(dir), 'DELETE', `/api/surveys/${sid}/upload-days/26-10-2026?expect=3`)).j.error, 'bad_date');
  assert.equal((await call(erp(dir), 'DELETE', U)).j.error, 'no_expect');
  const cc = await call(erp(dir), 'DELETE', U + '?expect=2');
  assert.equal(cc.code, 409); assert.equal(cc.j.error, 'count_changed'); assert.equal(cc.j.count, 3);
  assert.equal((await call(erp(dir), 'DELETE', `/api/surveys/${sid}/upload-days/2026-10-20?expect=1`)).code, 404);
  assert.equal(Number((await query(`SELECT count(*) FROM survey_pages WHERE survey_id=$1`, [sid])).rows[0].count), 5, '거부되면 아무것도 안 지움');

  // 플랫폼 — 삭제 전
  V.platformApi.check = async () => ({ ok: true });
  const vt = (await call(null, 'POST', '/api/survey-viewer/platform-login', { token: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'Kim CTR' })).j.token;
  let pv = (await call(vt, 'GET', `/api/survey-viewer/surveys/${sid}`)).j;
  assert.equal(pv.responses.length, 5);

  // ③ 삭제
  const del = await call(erp(dir), 'DELETE', U + '?expect=3');
  assert.equal(del.code, 200, JSON.stringify(del.j));
  assert.equal(del.j.deleted, 3); assert.equal(del.j.ai_cache_cleared, true);
  assert.deepEqual(del.j.days.map((d) => d.day), ['2026-10-27']);
  assert.equal(del.j.counts.total, 2);
  const left = (await query(`SELECT red_number FROM survey_pages WHERE survey_id=$1 ORDER BY seq`, [sid])).rows.map((r) => r.red_number);
  assert.deepEqual(left, ['0201', '0202']);
  assert.equal((await query(`SELECT ai_cache FROM surveys WHERE id=$1`, [sid])).rows[0].ai_cache, null);
  const au = (await query(`SELECT detail FROM audit_log WHERE user_id=$1 AND target=$2 AND action='delete'`, [dir, 'survey:' + sid])).rows;
  assert.equal(au.length, 1); assert.equal(au[0].detail.upload_day, '2026-10-26'); assert.equal(au[0].detail.pages.length, 3);

  // ④ 플랫폼 반영 — 응답 목록·집계·다운로드 준비 장수·옛 AI 요약 없음
  pv = (await call(vt, 'GET', `/api/survey-viewer/surveys/${sid}`)).j;
  assert.deepEqual(pv.responses.map((r) => r.folio), ['0201', '0202']);
  assert.equal(pv.ai, null, '옛 AI 요약은 플랫폼에서도 사라짐');
  assert.ok(!JSON.stringify(pv).includes('0101'));
  const info = (await call(vt, 'GET', `/api/survey-viewer/surveys/${sid}/download-info`)).j;
  assert.equal(info.done, 2); assert.equal(info.ready, 2);
});
