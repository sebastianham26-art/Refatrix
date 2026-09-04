// =====================================================================
// WBR 「📝 나의 기록 → 팀별 이슈 초안」 — 실 PostgreSQL + 실 라우트(app.inject)
//
//   POST /api/wbr/journal-draft  { from, to }
//   확인하는 것:
//     · 디렉터 전용(영업 403) · 기간 검증(형식·최대 14일) — 둘 다 AI 미호출
//     · 본인이 쓴 calendar_journal 만 재료가 된다(다른 디렉터 기록 제외)
//     · 기간 밖·빈 내용 기록 제외 · 기록이 없으면 404 no_journal (AI 미호출)
//     · 성공 시 5개 조직 키가 모두 채워진 draft 반환 + 감사로그
//     · wbr_board 는 서버가 건드리지 않는다(프런트가 붙여 넣는 설계)
//     · AI 응답이 JSON 이 아니거나 비면 502, 호출 실패도 502
//
//   Anthropic 만 스텁(globalThis.fetch 교체), DB·권한·라우트는 실제.
//   실행: TEST_PG_URL=postgres://... node --test test/wbr_journal_draft_api.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 검증 생략');
if (PG) process.env.DATABASE_URL = PG;
process.env.ANTHROPIC_API_KEY = 'test-key';   // aiEnabled() 통과용(실제 호출은 스텁)

let query, wbrRoutes, Fastify, jwt, app;
const tok = {};
const ID = {};
const TAG = 'WJD';

// ── Anthropic 스텁 ───────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let aiCalls = [];           // 보낸 프롬프트 기록
let aiNext = null;          // 다음 응답: {text} | {httpError} | {throw}
function installFetchStub() {
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('api.anthropic.com')) {
      const body = JSON.parse(opt.body);
      aiCalls.push(body.messages[0].content);
      if (aiNext && aiNext.throw) throw new Error('network down');
      if (aiNext && aiNext.httpError) {
        return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: (aiNext && aiNext.text) || '' }] }) };
    }
    return realFetch(url, opt);
  };
}

const GOOD = JSON.stringify({
  sales: { this: ['9/1 Autozone 견적 발송 → 9/3 수주 확정'], next: ['미결 견적 3건 팔로업'] },
  support: { this: ['RFC 누락 고객 4건 보완'], next: [] },
  pm: { this: [], next: ['신규 품번 12개 카탈로그 반영'] },
  wh: { this: ['9/2 컨테이너 1대 입고'], next: [] },
  mgmt: { this: ['마케팅 담당자 채용 공고 게시'], next: ['최종 면접 2명 일정 확정'] },
});

async function boot() {
  ({ query } = await import('../src/db.js'));
  wbrRoutes = (await import('../src/routes/wbrRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  const USERS = `SELECT id FROM users WHERE login_id LIKE '${TAG.toLowerCase()}%'`;
  await query(`DELETE FROM calendar_journal WHERE user_id IN (${USERS})`);
  await query(`DELETE FROM audit_log WHERE user_id IN (${USERS})`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (${USERS})`);
  await query(`DELETE FROM users WHERE login_id LIKE '${TAG.toLowerCase()}%'`);

  const mkUser = async (name, role, login) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`,
    [name, role, login])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'wjd_dir');
  ID.dir2 = await mkUser(`${TAG}디렉터2`, 'director', 'wjd_dir2');
  ID.sales = await mkUser(`${TAG}영업`, 'sales', 'wjd_sales');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
               VALUES ($1,'wbr','anywhere','edit') ON CONFLICT DO NOTHING`, [ID.sales]);

  const j = async (uid, date, content) => query(
    `INSERT INTO calendar_journal (user_id, entry_date, content) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, entry_date) DO UPDATE SET content=EXCLUDED.content`, [uid, date, content]);
  // 이번 주(월~금) = 2026-08-31 ~ 2026-09-04 로 고정해 검증
  await j(ID.dir, '2026-08-31', 'Autozone 방문, 견적 발송');
  await j(ID.dir, '2026-09-02', '컨테이너 1대 입고, 랙 정리');
  await j(ID.dir, '2026-09-04', '채용 공고 게시');
  await j(ID.dir, '2026-09-05', '기간 밖 — 토요일 기록');      // 범위 밖
  await j(ID.dir, '2026-09-03', '');                            // 빈 내용
  await j(ID.dir2, '2026-09-01', '다른 디렉터의 사적인 기록');  // 남의 일지

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(wbrRoutes);
  await app.ready();
  tok.dir = app.jwt.sign({ sub: ID.dir });
  tok.dir2 = app.jwt.sign({ sub: ID.dir2 });
  tok.sales = app.jwt.sign({ sub: ID.sales });
  installFetchStub();
}

const post = (who, body) => app.inject({
  method: 'POST', url: '/api/wbr/journal-draft',
  headers: { authorization: 'Bearer ' + tok[who] }, payload: body,
});
const WEEK = { from: '2026-08-31', to: '2026-09-04' };

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 디렉터 전용 — wbr 수정 권한이 있는 영업도 403, AI 미호출', { skip: SKIP }, async () => {
  aiCalls = [];
  const r = await post('sales', WEEK);
  assert.equal(r.statusCode, 403, r.body);
  assert.equal(aiCalls.length, 0, '권한 차단이 AI 호출보다 먼저여야 한다');
});

test('② 기간 검증 — 형식 오류·역순·14일 초과는 400, AI 미호출', { skip: SKIP }, async () => {
  aiCalls = [];
  for (const body of [
    {}, { from: '2026-9-1', to: '2026-09-04' }, { from: '2026-02-30', to: '2026-03-02' },
    { from: '2026-09-04', to: '2026-08-31' },                       // 역순 → span<1
    { from: '2026-08-01', to: '2026-09-04' },                       // 35일
    { from: "2026-08-31'; DROP TABLE users;--", to: '2026-09-04' }, // 인젝션 문자열
  ]) {
    const r = await post('dir', body);
    assert.equal(r.statusCode, 400, JSON.stringify(body) + ' → ' + r.body);
    assert.equal(r.json().error, 'bad_range');
  }
  assert.equal(aiCalls.length, 0);
  const still = (await query(`SELECT count(*)::int c FROM users WHERE id=$1`, [ID.dir])).rows[0].c;
  assert.equal(still, 1, 'users 테이블 무사');
});

test('③ 기록이 없는 기간 — 404 no_journal, AI 미호출(토큰 낭비 방지)', { skip: SKIP }, async () => {
  aiCalls = [];
  const r = await post('dir', { from: '2026-07-06', to: '2026-07-10' });
  assert.equal(r.statusCode, 404, r.body);
  assert.equal(r.json().error, 'no_journal');
  assert.equal(aiCalls.length, 0);
});

test('④ 빈 내용·기간 밖·남의 일지는 재료에서 빠진다', { skip: SKIP }, async () => {
  aiCalls = []; aiNext = { text: GOOD };
  const r = await post('dir', WEEK);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(aiCalls.length, 1, 'AI 는 정확히 1회');
  const p = aiCalls[0];
  assert.ok(p.includes('Autozone 방문, 견적 발송'));
  assert.ok(p.includes('컨테이너 1대 입고'));
  assert.ok(p.includes('채용 공고 게시'));
  assert.ok(!p.includes('기간 밖'), '범위 밖 날짜는 들어가면 안 된다');
  assert.ok(!p.includes('다른 디렉터의 사적인 기록'), '남의 일지는 절대 들어가면 안 된다');
  assert.equal(r.json().entry_count, 3, '빈 내용 하루는 빠져 3일');
});

test('⑤ 성공 응답 — 5개 조직 키 + 기간 + 날짜 목록', { skip: SKIP }, async () => {
  aiCalls = []; aiNext = { text: GOOD };
  const d = (await post('dir', WEEK)).json();
  assert.equal(d.ok, true);
  assert.equal(d.from, '2026-08-31');
  assert.equal(d.to, '2026-09-04');
  assert.deepEqual(Object.keys(d.draft).sort(), ['mgmt', 'pm', 'sales', 'support', 'wh']);
  assert.equal(d.draft.sales.this[0], '9/1 Autozone 견적 발송 → 9/3 수주 확정');
  assert.equal(d.draft.pm.next[0], '신규 품번 12개 카탈로그 반영');
  assert.deepEqual(d.draft.support.next, []);
  assert.deepEqual(d.days.map((x) => x.date), ['2026-08-31', '2026-09-02', '2026-09-04']);
  assert.ok(d.model);
});

test('⑥ 서버는 wbr_board 를 건드리지 않는다(초안 반영은 프런트 몫)', { skip: SKIP }, async () => {
  await query(`INSERT INTO wbr_board (id, data) VALUES (1, '{"issues":{},"memo":"기존"}'::jsonb)
               ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`);
  aiNext = { text: GOOD };
  assert.equal((await post('dir', WEEK)).statusCode, 200);
  const row = (await query(`SELECT data FROM wbr_board WHERE id=1`)).rows[0];
  assert.equal(row.data.memo, '기존', '보드가 덮어써지면 안 된다');
});

test('⑦ 감사로그가 남는다(본문 없이 행위만)', { skip: SKIP }, async () => {
  await query(`DELETE FROM audit_log WHERE user_id=$1`, [ID.dir]);
  aiNext = { text: GOOD };
  await post('dir', WEEK);
  await new Promise((r) => setTimeout(r, 250));   // logEvent 는 비동기 기록
  const rows = (await query(
    `SELECT action, target FROM audit_log WHERE user_id=$1 ORDER BY id DESC LIMIT 5`, [ID.dir])).rows;
  // action 은 audit_log CHECK 가 허용하는 표준값('create')이어야 실제로 기록된다
  const hit = rows.find((r) => r.action === 'create' && String(r.target).startsWith('wbr_journal_draft:'));
  assert.ok(hit, '감사로그가 실제로 기록돼야 함: ' + JSON.stringify(rows));
  assert.equal(hit.target, 'wbr_journal_draft:2026-08-31~2026-09-04');
  assert.ok(!JSON.stringify(rows).includes('Autozone'), '일지 본문은 로그에 남지 않는다');
});

test('⑧ AI 응답이 JSON 이 아니거나 비면 502 ai_empty', { skip: SKIP }, async () => {
  aiNext = { text: '죄송합니다. 요약할 수 없습니다.' };
  let r = await post('dir', WEEK);
  assert.equal(r.statusCode, 502); assert.equal(r.json().error, 'ai_empty');
  aiNext = { text: JSON.stringify({ sales: { this: [], next: [] } }) };
  r = await post('dir', WEEK);
  assert.equal(r.statusCode, 502); assert.equal(r.json().error, 'ai_empty');
});

test('⑨ AI 호출 실패(HTTP/네트워크)는 502 ai_failed', { skip: SKIP }, async () => {
  aiNext = { httpError: true };
  let r = await post('dir', WEEK);
  assert.equal(r.statusCode, 502); assert.equal(r.json().error, 'ai_failed');
  aiNext = { throw: true };
  r = await post('dir', WEEK);
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().detail, 'network');
});

test('⑩ 보드 GET 이 journal_draft 플래그를 내려준다(버튼 노출 판단)', { skip: SKIP }, async () => {
  const g = (who) => app.inject({ method: 'GET', url: '/api/wbr/board', headers: { authorization: 'Bearer ' + tok[who] } });
  assert.equal((await g('dir')).json().journal_draft, true, '디렉터 + API 키 → true');
  assert.equal((await g('sales')).json().journal_draft, false, '비디렉터는 false');
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await g('dir')).json().journal_draft, false, 'API 키 없으면 false');
  const r = await post('dir', WEEK);
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().error, 'no_api_key');
  process.env.ANTHROPIC_API_KEY = saved;
});

test('cleanup', { skip: SKIP }, async () => {
  globalThis.fetch = realFetch;
  const USERS = `SELECT id FROM users WHERE login_id LIKE '${TAG.toLowerCase()}%'`;
  await query(`DELETE FROM calendar_journal WHERE user_id IN (${USERS})`);
  await query(`DELETE FROM audit_log WHERE user_id IN (${USERS})`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (${USERS})`);
  await query(`DELETE FROM users WHERE login_id LIKE '${TAG.toLowerCase()}%'`);
  await app.close();
  const { pool } = await import('../src/db.js');
  await pool.end();
});
