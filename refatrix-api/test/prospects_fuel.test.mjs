// =====================================================================
// prospects_fuel.test.mjs — 1126 · 담당별 주/월 유류비 예산 (디렉터 본인만)
//   실행: TEST_PG_URL=postgres://... node --test test/prospects_fuel.test.mjs
// =====================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-fuel';
process.env.META_ASSIGN_WORKER = '0';

test('기간 — 주(월~일) · 월, 이번 기간이 마지막', async () => {
  const { fuelPeriods } = await import('../src/routes/prospectRoutes.js');
  const w = fuelPeriods('2026-11-26', 'week', 3);
  assert.deepEqual(w.map((p) => [p.from, p.to]), [['2026-11-09', '2026-11-15'], ['2026-11-16', '2026-11-22'], ['2026-11-23', '2026-11-29']]);
  const m = fuelPeriods('2026-01-15', 'month', 3);
  assert.deepEqual(m.map((p) => [p.key, p.from, p.to]), [['2025-11', '2025-11-01', '2025-11-30'], ['2025-12', '2025-12-01', '2025-12-31'], ['2026-01', '2026-01-01', '2026-01-31']]);
});

test('서버 — 담당별 · 기간별 합계 · 디렉터만', { skip: !PG && 'TEST_PG_URL 없음' }, async () => {
  const { query, pool } = await import('../src/db.js');
  after(async () => { await pool.end().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300); });
  const { buildApp } = await import('../src/server.js');
  const app = buildApp(); await app.ready();
  const one = async (sql, a) => (await query(sql, a)).rows[0];
  const SFX = Date.now().toString(36).slice(-5);
  const mk = async (n, role) => { const u = await one(`INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,$2,'x',$3) RETURNING id`, [n + ' ' + SFX, role, n.toLowerCase() + SFX]);
    return { id: Number(u.id), h: { authorization: 'Bearer ' + app.jwt.sign({ sub: Number(u.id), role }) } }; };
  const dir = await mk('FDir', 'director'); const rep = await mk('FRep', 'sales'); const mgr = await mk('FMgr', 'sales');
  await query(`INSERT INTO prospect_managers (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [mgr.id]).catch(() => {});
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access) VALUES ($1,'pipeline','anywhere','edit'),($2,'pipeline','anywhere','edit')`, [rep.id, mgr.id]);
  await query(`INSERT INTO prospect_settings (key, value) VALUES ('fuel_price', 25), ('km_per_liter', 10), ('road_factor', 1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
  const pr = async (lat) => Number((await one(`INSERT INTO prospects (nom_estab, lat, lng, stage) VALUES ($1,$2,-100.3,'asignado') RETURNING id`, ['Fuel ' + SFX, lat])).id);
  const a = await pr(25.60), b = await pr(25.70), c = await pr(25.80);
  const today = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
  const route = async (uid, d, ids) => { const r = await one(`INSERT INTO prospect_routes (user_id, route_date, name) VALUES ($1,$2,'t') RETURNING id`, [uid, d]);
    let k = 1; for (const id of ids) await query(`INSERT INTO prospect_route_stops (route_id, prospect_id, seq) VALUES ($1,$2,$3)`, [r.id, id, k++]); };
  await route(rep.id, today, [a, b, c]);          // 약 22.2km
  await route(rep.id, today.slice(0, 8) + '01', [a, b]);
  await query(`INSERT INTO prospect_routes (user_id, route_date, name) VALUES ($1, NULL, '목록')`, [rep.id]);   // 날짜 없는 목록 = 제외
  await route(rep.id, null, [a, b]);              // 1127 · 날짜 미정 방문 목록(정류장 있음) = 「날짜 미정」 칸
  const r = await app.inject({ method: 'GET', url: '/api/prospect-fuel?unit=month&n=2', headers: dir.h });
  assert.equal(r.statusCode, 200); const d = r.json();
  assert.equal(d.periods.length, 2); assert.equal(d.priced, true);
  const u = d.users.find((x) => x.user_id === rep.id); assert.ok(u);
  const curKey = d.periods[1].key; const c0 = u.cells[curKey];
  assert.equal(c0.routes, 2, '이번 달 루트 2개(날짜 없는 목록 제외)');
  assert.ok(c0.km > 33 && c0.km < 34, 'km ' + c0.km);
  assert.ok(Math.abs(c0.fuel_cost - c0.fuel_l * 25) < 3, '유류비 = L × 25');
  assert.equal(u.undated.routes, 1, '날짜 미정 목록 1개'); assert.ok(u.undated.fuel_cost > 0, '날짜 미정 목록도 유류비');
  assert.equal(u.dated.routes, 2); assert.equal(u.total.routes, 3, '합계 = 날짜 있는 2 + 날짜 미정 1');
  assert.ok(d.undated.routes >= 1); assert.ok(d.dated.routes >= 2);
  const w = (await app.inject({ method: 'GET', url: '/api/prospect-fuel?unit=week', headers: dir.h })).json(); assert.equal(w.periods.length, 8);
  assert.equal((await app.inject({ method: 'GET', url: '/api/prospect-fuel', headers: rep.h })).statusCode, 403, '영업');
  assert.equal((await app.inject({ method: 'GET', url: '/api/prospect-fuel', headers: mgr.h })).statusCode, 403, '관리자 지정자도 안 됨');
  const meta = (await app.inject({ method: 'GET', url: '/api/prospect-meta', headers: dir.h }));
  if (meta.statusCode === 200) assert.equal(meta.json().is_real_director, true);
  await query(`DELETE FROM prospect_settings WHERE key IN ('fuel_price')`); await query(`UPDATE prospect_settings SET value=1.3 WHERE key='road_factor'`);
  await app.close();
});
