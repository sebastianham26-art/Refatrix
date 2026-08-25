// 일지 API 실제 핸들러 × 실제 PostgreSQL 통합 테스트
// portalBoardRoutes.js 를 그대로 로드해 /api/journal 핸들러를 꺼내 호출한다.
import test from 'node:test';
import assert from 'node:assert';
import routes from '../src/routes/portalBoardRoutes.js';
import { requireDirector } from '../src/middleware/authGuard.js';
import { query } from '../src/db.js';

const R = {};
const app = {};
for (const m of ['get', 'post', 'patch', 'delete', 'put']) {
  app[m] = (path, opts, handler) => { R[`${m.toUpperCase()} ${path}`] = { opts, handler }; };
}
await routes(app);

function mkReply() {
  const rep = { statusCode: 200, payload: null };
  rep.code = (c) => { rep.statusCode = c; return rep; };
  rep.send = (p) => { rep.payload = p; return rep; };
  return rep;
}
const perm = (id, role = 'director') => ({ userId: id, role });
const call = async (key, { user = 1, role = 'director', params = {}, q = {}, body = null } = {}) => {
  const rep = mkReply();
  const out = await R[key].handler({ ctx: { perm: perm(user, role) }, params, query: q, body }, rep);
  return { out: out === rep ? null : out, rep };
};

test('라우트 4개가 모두 디렉터 전용(requireDirector)으로 등록된다', () => {
  for (const k of ['GET /api/journal', 'GET /api/journal/:date', 'PUT /api/journal/:date', 'DELETE /api/journal/:date']) {
    assert.ok(R[k], k + ' 등록됨');
    assert.ok(R[k].opts.preHandler.includes(requireDirector), k + ' 디렉터 전용');
  }
});

test('requireDirector: 영업 계정은 403', () => {
  const rep = mkReply();
  requireDirector({ ctx: { perm: perm(3, 'sales') } }, rep, () => assert.fail('통과하면 안 됨'));
  assert.equal(rep.statusCode, 403);
  assert.deepEqual(rep.payload, { error: 'director_only' });
});

test('신규 저장 → 조회 → 수정 → 목록 → 삭제 (전 과정)', async () => {
  await query('DELETE FROM calendar_journal');
  let r = await call('PUT /api/journal/:date', { params: { date: '2026-08-24' }, body: { content: '  오늘의 기록  ' } });
  assert.equal(r.out.ok, true); assert.equal(r.out.created, true);
  assert.equal(r.out.content, '오늘의 기록', '앞뒤 공백 제거');

  r = await call('GET /api/journal/:date', { params: { date: '2026-08-24' } });
  assert.equal(r.out.content, '오늘의 기록');
  assert.equal(r.out.exists, true);
  assert.ok(r.out.updated_at);

  r = await call('PUT /api/journal/:date', { params: { date: '2026-08-24' }, body: { content: '고친 기록' } });
  assert.equal(r.out.created, false, '같은 날 재저장은 수정');
  r = await call('GET /api/journal/:date', { params: { date: '2026-08-24' } });
  assert.equal(r.out.content, '고친 기록');

  await call('PUT /api/journal/:date', { params: { date: '2026-08-22' }, body: { content: '22일\n둘째 줄' } });
  r = await call('GET /api/journal', { q: { from: '2026-08-01', to: '2026-08-31' } });
  assert.deepEqual(r.out.dates, ['2026-08-24', '2026-08-22'], '최신순');
  assert.equal(r.out.items[1].preview, '22일 둘째 줄', '미리보기는 줄바꿈 정리');

  r = await call('DELETE /api/journal/:date', { params: { date: '2026-08-24' } });
  assert.equal(r.out.deleted, true);
  r = await call('GET /api/journal/:date', { params: { date: '2026-08-24' } });
  assert.equal(r.out.exists, false); assert.equal(r.out.content, '');
});

test('빈 내용으로 저장하면 그 날 기록이 삭제된다', async () => {
  await query('DELETE FROM calendar_journal');
  await call('PUT /api/journal/:date', { params: { date: '2026-08-23' }, body: { content: '지울 것' } });
  const r = await call('PUT /api/journal/:date', { params: { date: '2026-08-23' }, body: { content: '   ' } });
  assert.equal(r.out.deleted, true);
  const g = await call('GET /api/journal/:date', { params: { date: '2026-08-23' } });
  assert.equal(g.out.exists, false);
});

test('격리: 다른 디렉터 계정은 내 기록을 조회·수정·삭제할 수 없다', async () => {
  await query('DELETE FROM calendar_journal');
  await call('PUT /api/journal/:date', { user: 1, params: { date: '2026-08-24' }, body: { content: '내 비밀 기록' } });

  const other = await call('GET /api/journal/:date', { user: 4, params: { date: '2026-08-24' } });
  assert.equal(other.out.content, '', '다른 디렉터에게는 빈 화면');
  assert.equal(other.out.exists, false);

  const list = await call('GET /api/journal', { user: 4, q: { from: '2026-08-01', to: '2026-08-31' } });
  assert.deepEqual(list.out.dates, [], '목록에도 안 보임');

  await call('PUT /api/journal/:date', { user: 4, params: { date: '2026-08-24' }, body: { content: '남의 글 덮어쓰기 시도' } });
  const mine = await call('GET /api/journal/:date', { user: 1, params: { date: '2026-08-24' } });
  assert.equal(mine.out.content, '내 비밀 기록', '내 기록은 그대로');

  await call('DELETE /api/journal/:date', { user: 4, params: { date: '2026-08-24' } });
  const still = await call('GET /api/journal/:date', { user: 1, params: { date: '2026-08-24' } });
  assert.equal(still.out.exists, true, '남이 삭제해도 내 기록 보존');
});

test('잘못된 날짜 형식은 400', async () => {
  for (const bad of ['2026-8-4', 'ayer', '2026-08-24; DROP TABLE users', '']) {
    const r = await call('GET /api/journal/:date', { params: { date: bad } });
    assert.equal(r.rep.statusCode, 400, bad);
  }
  const p = await call('PUT /api/journal/:date', { params: { date: 'x' }, body: { content: 'a' } });
  assert.equal(p.rep.statusCode, 400);
});

test('20,000자 초과는 400', async () => {
  const r = await call('PUT /api/journal/:date', { params: { date: '2026-08-24' }, body: { content: 'ㄱ'.repeat(20001) } });
  assert.equal(r.rep.statusCode, 400);
  assert.equal(r.rep.payload.error, 'too_long');
});

test('20,000자까지는 정상 저장(긴 일기)', async () => {
  const long = '가'.repeat(20000);
  const r = await call('PUT /api/journal/:date', { params: { date: '2026-08-19' }, body: { content: long } });
  assert.equal(r.out.ok, true);
  const g = await call('GET /api/journal/:date', { params: { date: '2026-08-19' } });
  assert.equal(g.out.content.length, 20000);
});

test('테이블이 없으면 500 이 아니라 503 migration_required', async () => {
  await query('ALTER TABLE calendar_journal RENAME TO calendar_journal_bak');
  try {
    const r = await call('GET /api/journal', { q: {} });
    assert.equal(r.rep.statusCode, 503);
    assert.equal(r.rep.payload.error, 'migration_required');
    const p = await call('PUT /api/journal/:date', { params: { date: '2026-08-24' }, body: { content: 'x' } });
    assert.equal(p.rep.statusCode, 503);
  } finally {
    await query('ALTER TABLE calendar_journal_bak RENAME TO calendar_journal');
  }
});

test('기존 일정/공지/할일 라우트가 그대로 등록돼 있다(무회귀)', () => {
  for (const k of ['GET /api/calendar', 'POST /api/calendar', 'GET /api/notices', 'GET /api/todos', 'POST /api/calendar/:id/memos']) {
    assert.ok(R[k], k);
  }
});

test.after(async () => { const { pool } = await import('../src/db.js'); await pool.end(); });
