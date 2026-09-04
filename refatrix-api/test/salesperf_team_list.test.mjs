// =====================================================================
// 영업실적/WBR 팀 선택칩 — 삭제된 팀·비영업 팀이 섞이지 않는지 (실 PostgreSQL + 실 라우트)
//
//   버그: salesPerfRoutes 의 팀 목록/월목표 합계 쿼리가 `deleted_at IS NULL` 을 빠뜨려서
//        **삭제한 팀이 WBR·영업 대시보드의 팀 칩에 계속 뜨고, 월목표 합계에도 섞였다.**
//        (다른 라우트 — targetRoutes/customerRoutes/dashboardRoutes — 는 전부 걸러내고 있었다)
//
//   확인하는 것:
//     · GET /api/salesperf/summary       teams 에 삭제팀·비영업팀 없음
//     · GET /api/salesperf/team-monthly  teams 에 삭제팀·비영업팀 없음
//     · 월 목표 합계에 삭제팀 목표가 더해지지 않음
//
//   실행: TEST_PG_URL=postgres://... node --test test/salesperf_team_list.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, salesPerfRoutes, Fastify, jwt, app;
const ID = {};
let tok;
const TAG = 'SPTEAM';
const YM = '2026-08';

async function boot() {
  ({ query } = await import('../src/db.js'));
  salesPerfRoutes = (await import('../src/routes/salesPerfRoutes.js')).default;
  Fastify = (await import('fastify')).default;
  jwt = (await import('@fastify/jwt')).default;

  const TEAMS = `SELECT id FROM sales_teams WHERE name LIKE '${TAG}%'`;
  await query(`DELETE FROM target_team_months WHERE team_id IN (${TEAMS})`);
  await query(`UPDATE users SET team_id=NULL WHERE login_id LIKE 'spteam%'`);
  await query(`DELETE FROM users WHERE login_id LIKE 'spteam%'`);
  await query(`DELETE FROM sales_teams WHERE name LIKE '${TAG}%'`);

  const mkTeam = async (name, opt = {}) => {
    const id = Number((await query(
      `INSERT INTO sales_teams (name, sort_order, is_sales) VALUES ($1,$2,$3) RETURNING id`,
      [TAG + name, 0, opt.isSales === false ? false : true])).rows[0].id);
    if (opt.deleted) await query(`UPDATE sales_teams SET deleted_at=now() WHERE id=$1`, [id]);
    return id;
  };
  ID.live1 = await mkTeam('01_Monterrey');
  ID.live2 = await mkTeam('02_Merida');
  ID.gone = await mkTeam('0_CTR추천', { deleted: true });   // 삭제한 팀
  ID.notSales = await mkTeam('9_비영업', { isSales: false }); // 비영업 팀

  // 각 팀에 월목표 — 삭제팀 목표가 합계에 섞이는지 보기 위해 큰 값
  for (const [tid, amt] of [[ID.live1, 100], [ID.live2, 200], [ID.gone, 9000], [ID.notSales, 7000]]) {
    await query(
      `INSERT INTO target_team_months (team_id, ym, amount) VALUES ($1,$2,$3)
       ON CONFLICT (team_id, ym) DO UPDATE SET amount=EXCLUDED.amount`, [tid, YM, amt]);
  }

  ID.dir = Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x','spteam_dir') RETURNING id`,
    [`${TAG}디렉터`])).rows[0].id);

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(salesPerfRoutes);
  await app.ready();
  tok = app.jwt.sign({ sub: ID.dir });
}
const get = (url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok } });
const mine = (teams) => (teams || []).filter((t) => String(t.name).startsWith(TAG)).map((t) => t.name);

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① summary 의 팀 목록에 삭제팀·비영업팀이 없다', { skip: SKIP }, async () => {
  const r = await get(`/api/salesperf/summary?ym=${YM}&team=total&carry=1`);
  assert.equal(r.statusCode, 200, r.body);
  const names = mine(r.json().teams);
  assert.deepEqual(names.sort(), [`${TAG}01_Monterrey`, `${TAG}02_Merida`]);
  assert.ok(!names.some((n) => n.includes('추천')), '삭제한 팀이 칩으로 뜨면 안 된다');
  assert.ok(!names.some((n) => n.includes('비영업')), '비영업 팀도 뜨면 안 된다');
});

test('② team-monthly 의 팀 목록도 동일하게 걸러진다', { skip: SKIP }, async () => {
  const r = await get(`/api/salesperf/team-monthly?yms=${YM}`);
  assert.equal(r.statusCode, 200, r.body);
  const names = mine(r.json().teams);
  assert.ok(!names.some((n) => n.includes('추천') || n.includes('비영업')), names.join(','));
});

test('③ 월 목표 합계에 삭제팀·비영업팀 목표가 섞이지 않는다', { skip: SKIP }, async () => {
  const r = await get(`/api/salesperf/summary?ym=${YM}&team=total&carry=0`);
  const target = Number(r.json().sales.target || 0);
  assert.ok(target < 9000, `삭제팀 목표 9,000 이 합계에 섞였다 (target=${target})`);
  assert.ok(target < 7000, `비영업팀 목표 7,000 이 합계에 섞였다 (target=${target})`);
});

test('cleanup', { skip: SKIP }, async () => {
  const TEAMS = `SELECT id FROM sales_teams WHERE name LIKE '${TAG}%'`;
  await query(`DELETE FROM target_team_months WHERE team_id IN (${TEAMS})`);
  await query(`DELETE FROM users WHERE login_id LIKE 'spteam%'`);
  await query(`DELETE FROM sales_teams WHERE name LIKE '${TAG}%'`);
  await app.close();
  const { pool } = await import('../src/db.js');
  await pool.end();
});
