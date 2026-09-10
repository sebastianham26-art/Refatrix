// 매출목표 화면의 표시 기간 — 12개월 고정 → 「끝 월」 지정
//
//   왜 고쳤나: 커미셔너 계약은 **2027-12 까지의 총액**이 기준인데, 화면이 시작월부터
//   12개월만 그려서 2026-09 에 열면 **2027-08 까지밖에 입력칸이 없었다.**
//   계약 기간의 마지막 4개월을 넣을 자리가 아예 없었다는 뜻이다.
//
//   여기서 못 박는 것 두 가지:
//     ① `end` 를 주면 그 달까지 실제로 칸이 생긴다 (2027-12 포함).
//     ② `end` 를 **안 주면 예전과 똑같다** — 다른 화면·호출이 조용히 바뀌면 안 된다.
//
//   실행: TEST_PG_URL=postgres://... node --test test/target_horizon.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, '..');
const REPO = join(API, '..');
const read = (p) => readFileSync(p, 'utf8');

const PG = process.env.TEST_PG_URL || '';
if (PG) process.env.DATABASE_URL = PG;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';

const routeSrc = read(join(API, 'src/routes/targetRoutes.js'));
const pageSrc = read(join(REPO, 'refatrix-targets.html'));

const { monthsInclusive, monthsHorizon } = await import('../src/salesTarget.js');

// ── A. 순수 로직 ─────────────────────────────────────────────────────
test('A1. 2026-09 에서 2027-12 까지는 16개월이고 마지막이 2027-12 다', () => {
  const ms = monthsInclusive('2026-09', '2027-12');
  assert.equal(ms.length, 16);
  assert.equal(ms[0], '2026-09');
  assert.equal(ms[ms.length - 1], '2027-12');
  // 고치기 전 동작 — 여기서 4개월이 잘려 나갔다.
  assert.equal(monthsHorizon('2026-09', 12).slice(-1)[0], '2027-08');
});

test('A2. 끝월이 시작월보다 앞이면 빈 배열(→ 서버가 기본 12개월로 폴백)', () => {
  assert.deepEqual(monthsInclusive('2027-12', '2026-09'), []);
});

// ── B. 소스 계약 ─────────────────────────────────────────────────────
test('B1. 두 조회 모두 같은 헬퍼를 쓴다(한쪽만 늘어나면 표가 어긋난다)', () => {
  const uses = routeSrc.match(/horizonMonths\(req\.query\)/g) || [];
  assert.equal(uses.length, 2, 'overview 와 team 조회 둘 다');
  assert.ok(!/monthsHorizon\(start, 12\)[\s\S]{0,80}monthlyـtargets/.test(routeSrc));
});

test('B2. 상한이 있다(표가 옆으로 무한정 늘어나지 않는다)', () => {
  assert.ok(routeSrc.includes('MAX_MONTHS = 24'));
  assert.ok(routeSrc.includes('.slice(0, MAX_MONTHS)'));
});

test('B3. end 를 안 주면 예전 그대로 12개월', () => {
  assert.ok(/return monthsHorizon\(start, 12\);/.test(routeSrc), '기본 경로 보존');
});

test('B4. 화면에 끝 월 칸이 있고 기본값이 2027-12 다', () => {
  assert.ok(pageSrc.includes('id="endYm"'));
  assert.ok(pageSrc.includes("PLAN_END='2027-12'"));
  assert.ok(pageSrc.includes("'&end='+endYm"), '조회에 끝 월을 실어 보낸다');
  assert.ok(pageSrc.includes('endYm<startYm'), '뒤집힌 입력을 화면에서도 막는다');
});

// ── C. 실 DB — 진짜로 2027-12 칸이 생기는가 ──────────────────────────
const dbTest = PG ? test : test.skip;

dbTest('end=2027-12 로 조회하면 그 달까지 실제로 나온다 (실 DB)', async (t) => {
  const { query } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const targetRoutes = (await import('../src/routes/targetRoutes.js')).default;

  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET, sign: { expiresIn: '1h' } });
  app.register(targetRoutes);
  await app.ready();

  const TAG = 'TH' + String(Date.now()).slice(-6);
  const dir = Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id) VALUES ($1,'director','x',$2) RETURNING id`,
    ['Dir' + TAG, 'dir' + TAG])).rows[0].id);
  const team = Number((await query(
    `INSERT INTO sales_teams (name, is_sales) VALUES ($1,true) RETURNING id`, ['T' + TAG])).rows[0].id);
  const cust = Number((await query(
    `INSERT INTO customers (code, name, team_id, owner_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['C-' + TAG, 'Cust' + TAG, team, dir])).rows[0].id);

  t.after(async () => {
    await query(`DELETE FROM target_customer_months WHERE customer_id=$1`, [cust]).catch(() => {});
    await query(`DELETE FROM customers WHERE id=$1`, [cust]);
    await query(`DELETE FROM target_team_status WHERE team_id=$1`, [team]).catch(() => {});
    await query(`DELETE FROM target_team_months WHERE team_id=$1`, [team]).catch(() => {});
    await query(`DELETE FROM sales_teams WHERE id=$1`, [team]);
    await query(`DELETE FROM users WHERE id=$1`, [dir]);
    await app.close();
    // pool 은 파일의 마지막 DB 테스트에서만 닫는다 — 먼저 닫으면 다음 테스트의 뒷정리가 죽는다.
  });

  const hdr = { authorization: 'Bearer ' + app.jwt.sign({ sub: dir }) };
  const get = (url) => app.inject({ method: 'GET', url, headers: hdr });

  // C1. 끝 월을 주면 2027-12 까지
  let d = (await get('/api/targets/overview?start=2026-09&end=2027-12')).json();
  assert.equal(d.months.length, 16);
  assert.equal(d.months[d.months.length - 1], '2027-12');

  // C2. 안 주면 예전 그대로 12개월(회귀 없음)
  d = (await get('/api/targets/overview?start=2026-09')).json();
  assert.equal(d.months.length, 12);
  assert.equal(d.months[d.months.length - 1], '2027-08');

  // C3. 고객 배분 표에도 같은 기간이 온다 — 여기가 실제로 숫자를 넣는 칸이다
  d = (await get('/api/targets/team/' + team + '?start=2026-09&end=2027-12')).json();
  assert.equal(d.months.length, 16);
  assert.equal(d.months[d.months.length - 1], '2027-12');
  assert.equal(d.customers.length, 1);

  // C4. 2027-12 에 저장한 값이 그 표에 다시 실려 나온다(칸만 생기고 안 읽히면 소용없다)
  await query(
    `INSERT INTO target_customer_months (customer_id, ym, amount) VALUES ($1,'2027-12',123456)
     ON CONFLICT (customer_id, ym) DO UPDATE SET amount=123456`, [cust]);
  d = (await get('/api/targets/team/' + team + '?start=2026-09&end=2027-12')).json();
  assert.equal(Number(d.customers[0].alloc['2027-12']), 123456);
  assert.equal(Number(d.cust_sum['2027-12']), 123456);

  // C5. 상한 24칸 — 끝 월을 아무리 멀리 잡아도 표가 무한정 늘어나지 않는다
  d = (await get('/api/targets/overview?start=2026-09&end=2035-12')).json();
  assert.equal(d.months.length, 24);

  // C6. 뒤집힌 입력은 기본 12개월로 떨어진다(빈 표를 그리지 않는다)
  d = (await get('/api/targets/overview?start=2027-12&end=2026-09')).json();
  assert.equal(d.months.length, 12);
  assert.equal(d.months[0], '2027-12');
});

// ── D. 담당(owner) 기반 편집 — 커미셔너가 자기 고객 줄만 넣는다 ──────
//
//   `00_CTR Recomendation` 처럼 여러 커미셔너의 고객이 한 팀에 모이는 운영에서,
//   경계는 팀이 아니라 **담당자**다. 여기서 못 박는 것:
//     ① 커미셔너에게는 자기 담당 고객만 보인다(남의 고객이 새면 계약 전제가 깨진다).
//     ② 자기 줄은 targets=열람 권한만으로도 저장된다.
//     ③ 남의 줄은 보내도 저장되지 않는다.
dbTest('담당 고객 줄만 보이고, 그 줄만 저장된다 (실 DB)', async (t) => {
  const { query } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const targetRoutes = (await import('../src/routes/targetRoutes.js')).default;

  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET, sign: { expiresIn: '1h' } });
  app.register(targetRoutes);
  await app.ready();

  const TAG = 'OW' + String(Date.now()).slice(-6);
  const mkUser = async (n, role, teamId = null) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id, team_id) VALUES ($1,$2,'x',$3,$4) RETURNING id`,
    [n + TAG, role, n.toLowerCase() + TAG, teamId])).rows[0].id);

  const team = Number((await query(
    `INSERT INTO sales_teams (name, is_sales) VALUES ($1,true) RETURNING id`,
    ['00_CTR Recomendation ' + TAG])).rows[0].id);
  const dir = await mkUser('Dir', 'director');
  const comA = await mkUser('ComA', 'sales', team);
  const comB = await mkUser('ComB', 'sales', team);
  // 커미셔너는 targets 를 **열람만** 갖는다 — 이게 현장 기본값이다.
  for (const u of [comA, comB]) {
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
                 VALUES ($1,'targets','anywhere','view') ON CONFLICT DO NOTHING`, [u]);
  }
  const mkCust = async (n, owner) => Number((await query(
    `INSERT INTO customers (code, name, team_id, owner_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['C-' + TAG + n, n + TAG, team, owner])).rows[0].id);
  const a1 = await mkCust('A1', comA);
  const b1 = await mkCust('B1', comB);

  t.after(async () => {
    await query(`DELETE FROM target_customer_months WHERE customer_id = ANY($1)`, [[a1, b1]]).catch(() => {});
    await query(`DELETE FROM customers WHERE id = ANY($1)`, [[a1, b1]]);
    await query(`DELETE FROM target_team_status WHERE team_id=$1`, [team]).catch(() => {});
    await query(`DELETE FROM user_page_access WHERE user_id = ANY($1)`, [[comA, comB]]);
    // 저장이 감사로그를 남기므로 사용자보다 먼저 지운다(FK).
    await query(`DELETE FROM audit_log WHERE user_id = ANY($1)`, [[dir, comA, comB]]).catch(() => {});
    await query(`DELETE FROM users WHERE id = ANY($1)`, [[dir, comA, comB]]);
    await query(`DELETE FROM sales_teams WHERE id=$1`, [team]);
    await app.close();
    // pool 은 파일의 마지막 DB 테스트에서만 닫는다.
  });

  const hdr = (u) => ({ authorization: 'Bearer ' + app.jwt.sign({ sub: u }) });
  const getTeam = (u) => app.inject({ method: 'GET',
    url: '/api/targets/team/' + team + '?start=2026-09&end=2027-12', headers: hdr(u) });
  const post = (u, allocations) => app.inject({ method: 'POST', url: '/api/targets/customers',
    headers: { ...hdr(u), 'content-type': 'application/json' },
    payload: { team_id: team, allocations } });

  // D1. 커미셔너 A → 자기 고객 1명만, 그 줄은 편집 가능
  let d = (await getTeam(comA)).json();
  assert.deepEqual(d.customers.map((c) => Number(c.id)), [a1], 'A 에게 B 의 고객이 보이면 안 된다');
  assert.equal(d.customers[0].can_edit, true);
  assert.equal(d.can_edit, false, '팀 계획 편집자는 아니다');
  assert.equal(d.can_edit_own, true, '내 고객 줄은 쓸 수 있다');
  assert.equal(d.customers[0].owner_name, 'ComA' + TAG, '담당자 이름이 나온다');
  assert.equal(d.months[d.months.length - 1], '2027-12');

  // D2. 디렉터 → 팀 전체가 보이고 전부 편집 가능
  d = (await getTeam(dir)).json();
  assert.equal(d.customers.length, 2);
  assert.equal(d.can_edit, true);
  assert.ok(d.customers.every((c) => c.can_edit === true));

  // D3. 열람 권한만으로도 내 줄은 저장된다 (예전엔 403 read_only 였다)
  let r = await post(comA, [
    { customer_id: a1, ym: '2027-12', amount: 250000 },
    { customer_id: b1, ym: '2027-12', amount: 999999 },   // 남의 담당
  ]);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().saved, 1);
  assert.equal(r.json().skipped, 1);
  const bRows = (await query(
    `SELECT COUNT(*)::int n FROM target_customer_months WHERE customer_id=$1`, [b1])).rows[0].n;
  assert.equal(bRows, 0, '남의 담당 고객에는 한 줄도 들어가면 안 된다');
  const aAmt = Number((await query(
    `SELECT amount FROM target_customer_months WHERE customer_id=$1 AND ym='2027-12'`, [a1])).rows[0].amount);
  assert.equal(aAmt, 250000);

  // D4. 저장한 값과 실적 칸이 그 사람 화면에 다시 실려 나온다
  await query(`INSERT INTO sales_invoices (customer_id, inv_date, status, subtotal_mxn, total_mxn)
               VALUES ($1, DATE '2026-09-15', 'posted', 40000, 46400)`, [a1]);
  d = (await getTeam(comA)).json();
  assert.equal(Number(d.customers[0].alloc['2027-12']), 250000);
  assert.equal(Number(d.customers[0].actual['2026-09']), 40000, '담당 고객의 실적이 보인다');
  await query(`DELETE FROM sales_invoices WHERE customer_id=$1`, [a1]);

  // D4b. 소속팀이 아니어도 담당 고객이 있으면 팀 목록에 뜬다
  //   (팀 선택지에 없으면 화면에 들어갈 방법 자체가 없다)
  await query(`UPDATE users SET team_id=NULL WHERE id=$1`, [comA]);
  const ov = (await app.inject({ method: 'GET', url: '/api/targets/overview?start=2026-09&end=2027-12',
    headers: hdr(comA) })).json();
  assert.ok((ov.teams || []).some((t) => Number(t.id) === team),
    '담당 고객이 있는 팀은 소속팀이 아니어도 선택지에 있어야 한다');
  assert.equal((await getTeam(comA)).statusCode, 200, '그 팀 화면도 열려야 한다');
  await query(`UPDATE users SET team_id=$2 WHERE id=$1`, [comA, team]);

  // D5. 담당 고객이 하나도 없는 사람은 그 팀에 저장할 수 없다
  const outsider = await mkUser('Out', 'sales');
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
               VALUES ($1,'targets','anywhere','view')`, [outsider]);
  assert.equal((await post(outsider, [{ customer_id: a1, ym: '2027-12', amount: 1 }])).statusCode, 403);
  await query(`DELETE FROM user_page_access WHERE user_id=$1`, [outsider]);
  await query(`DELETE FROM audit_log WHERE user_id=$1`, [outsider]).catch(() => {});
  await query(`DELETE FROM users WHERE id=$1`, [outsider]);
});

// ── E. 계약 총목표 진척 바 ────────────────────────────────────────────
//
//   커미셔너 계약은 «본인 담당 고객 전체를 합쳐 기한까지 300만(IVA 제외)» 이다.
//   그래서 이 수치는 **화면에 보이는 기간이 아니라 계약 기간 전체**를 세야 한다.
//   보이는 12~16칸만 세면 «다 채웠다»가 거짓이 된다 — 여기가 이 기능의 급소다.
test('E0. 진척 계산이 소스에서 기간 전체를 센다', () => {
  assert.ok(routeSrc.includes('agentProgress'), '진척 헬퍼');
  assert.ok(/t\.ym <= \$2/.test(routeSrc), '계획 합계는 기한까지 전부');
  assert.ok(!/agentProgress\([\s\S]{0,120}months/.test(routeSrc), '표시 기간(months)에 묶이면 안 된다');
  assert.ok(pageSrc.includes('id="myGoal"') && pageSrc.includes('id="agentsProg"'));
  assert.ok(pageSrc.includes('본인고객 전체 매출목표'), '진척 바 라벨');
});

dbTest('진척 바 수치와 담당자별 표 · 총목표 설정 (실 DB)', async (t) => {
  const { query } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const targetRoutes = (await import('../src/routes/targetRoutes.js')).default;

  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET, sign: { expiresIn: '1h' } });
  app.register(targetRoutes);
  await app.ready();

  const TAG = 'GP' + String(Date.now()).slice(-6);
  const team = Number((await query(
    `INSERT INTO sales_teams (name, is_sales) VALUES ($1,true) RETURNING id`, ['GT' + TAG])).rows[0].id);
  const mk = async (n, role, tid = null) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id, team_id) VALUES ($1,$2,'x',$3,$4) RETURNING id`,
    [n + TAG, role, n.toLowerCase() + TAG, tid])).rows[0].id);
  const dir = await mk('Dir', 'director');
  const com = await mk('Com', 'sales', team);
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
               VALUES ($1,'targets','anywhere','view')`, [com]);
  const c1 = Number((await query(
    `INSERT INTO customers (code, name, team_id, owner_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['C-' + TAG + '1', 'C1' + TAG, team, com])).rows[0].id);

  t.after(async () => {
    await query(`DELETE FROM target_customer_months WHERE customer_id=$1`, [c1]).catch(() => {});
    await query(`DELETE FROM sales_invoices WHERE customer_id=$1`, [c1]).catch(() => {});
    await query(`DELETE FROM customers WHERE id=$1`, [c1]);
    await query(`DELETE FROM agent_plan_goals WHERE user_id = ANY($1)`, [[com, dir]]).catch(() => {});
    await query(`DELETE FROM user_page_access WHERE user_id=$1`, [com]);
    await query(`DELETE FROM audit_log WHERE user_id = ANY($1)`, [[com, dir]]).catch(() => {});
    await query(`DELETE FROM users WHERE id = ANY($1)`, [[com, dir]]);
    await query(`DELETE FROM sales_teams WHERE id=$1`, [team]);
    await app.close();
    // pool 은 파일의 마지막 DB 테스트에서만 닫는다.
  });

  const hdr = (u) => ({ authorization: 'Bearer ' + app.jwt.sign({ sub: u }) });
  const getTeam = (u, qs = '?start=2026-09&end=2027-12') => app.inject({ method: 'GET',
    url: '/api/targets/team/' + team + qs, headers: hdr(u) });

  // E1. 설정이 없으면 기본 300만 / 2027-12
  let g = (await getTeam(com)).json().my_progress;
  assert.ok(g, '커미셔너 화면에는 진척이 실린다');
  assert.equal(g.goal_amount, 3000000);
  assert.equal(g.horizon, '2027-12');
  assert.equal(g.plan_total, 0);
  assert.equal(g.remaining, 3000000);
  assert.equal(g.reached, false);

  // E2. 계획을 넣으면 합계·부족액·달성률이 따라 움직인다
  for (const [ym, amt] of [['2026-10', 500000], ['2027-11', 400000], ['2027-12', 100000]]) {
    await query(`INSERT INTO target_customer_months (customer_id, ym, amount) VALUES ($1,$2,$3)`, [c1, ym, amt]);
  }
  g = (await getTeam(com)).json().my_progress;
  assert.equal(g.plan_total, 1000000);
  assert.equal(g.remaining, 2000000);
  assert.equal(g.pct, 33.3);

  // E3. ★ 보이는 기간이 아니라 계약 기간 전체를 센다.
  //     화면을 2027-01 부터 열어도(2026-10 이 안 보여도) 합계는 그대로다.
  g = (await getTeam(com, '?start=2027-01&end=2027-12')).json().my_progress;
  assert.equal(g.plan_total, 1000000, '표시 기간을 좁혀도 계약 합계는 변하지 않는다');

  // E4. 기한 뒤의 계획은 안 센다
  await query(`INSERT INTO target_customer_months (customer_id, ym, amount) VALUES ($1,'2028-03',900000)`, [c1]);
  g = (await getTeam(com)).json().my_progress;
  assert.equal(g.plan_total, 1000000, '2027-12 기한 뒤 금액은 제외');

  // E5. 실적 누계도 담당 고객 기준으로 나온다
  await query(`INSERT INTO sales_invoices (customer_id, inv_date, status, subtotal_mxn, total_mxn)
               VALUES ($1, DATE '2026-10-05','posted', 120000, 139200)`, [c1]);
  g = (await getTeam(com)).json().my_progress;
  assert.equal(g.actual_total, 120000);

  // E6. 디렉터가 총목표를 바꾸면 즉시 반영된다
  let r = await app.inject({ method: 'PUT', url: '/api/targets/agent-goal',
    headers: { ...hdr(dir), 'content-type': 'application/json' },
    payload: { user_id: com, goal_amount: 900000, horizon: '2027-12' } });
  assert.equal(r.statusCode, 200);
  g = (await getTeam(com)).json().my_progress;
  assert.equal(g.goal_amount, 900000);
  assert.equal(g.reached, true, '1,000,000 ≥ 900,000');
  assert.equal(g.goal_stored, true);

  // E7. 커미셔너는 총목표를 못 바꾼다
  r = await app.inject({ method: 'PUT', url: '/api/targets/agent-goal',
    headers: { ...hdr(com), 'content-type': 'application/json' },
    payload: { user_id: com, goal_amount: 1 } });
  assert.equal(r.statusCode, 403);

  // E8. 디렉터 화면에는 담당자별 표가, 커미셔너 화면에는 안 온다
  const dd = (await getTeam(dir)).json();
  assert.ok(Array.isArray(dd.agents_progress));
  assert.ok(dd.agents_progress.some((a) => Number(a.user_id) === com && a.goal_amount === 900000));
  assert.equal((await getTeam(com)).json().agents_progress, null,
    '커미셔너에게 남의 진척이 새면 안 된다');
});

// ── F. 커미셔너 온보딩 게이트 ────────────────────────────────────────
//
//   «300만을 고객별로 다 배분할 때까지, 로그인하면 안내서로 보낸다».
//   위험한 오작동은 **엉뚱한 사람을 끌고 가는 것**이다 — 디렉터나 목표를 안 쓰는
//   직원이 매번 안내서로 튕기면 업무가 막힌다. 그래서 대상을 좁히고 그걸 고정한다.
const portalSrc = read(join(REPO, 'refatrix-portal.html'));

test('F0. 게이트는 포털에서 세션당 한 번만 걸린다', () => {
  assert.ok(portalSrc.includes('guideGateRedirect'), '게이트 함수');
  assert.ok(portalSrc.includes("sessionStorage.getItem('rfx_guide_gate')"), '세션당 1회');
  assert.ok(portalSrc.includes("sessionStorage.removeItem('rfx_guide_gate')"),
    '실제 로그인에서 플래그를 지워야 «로그인할 때마다» 가 지켜진다');
  assert.ok(portalSrc.includes('refatrix-guia-comisionista.html#token='),
    '세션을 들고 이동해야 안내서에서 로그인 화면으로 튕기지 않는다');
  assert.ok(/setItem\('rfx_guide_gate','1'\);[\s\S]{0,400}location\.href=/.test(portalSrc),
    '이동 전에 플래그를 세워야 안내서가 안 열려도 무한 반복되지 않는다');
});

test('F0b. 안내서의 2단계가 실제 화면 경로를 설명하고, 없는 화면을 가리키지 않는다', () => {
  const guide = read(join(REPO, 'refatrix-guia-comisionista.html'));
  assert.ok(guide.includes('② 고객별 목표 배분'), '메뉴 경로를 그대로 적는다');
  assert.ok(guide.includes('04_dante'), '팀 버튼 예시');
  assert.ok(guide.includes('refatrix-targets.html'), '실제 배포된 화면으로 연결');
  assert.ok(!guide.includes('refatrix-mytargets.html'), '배포하지 않은 화면을 가리키면 안 된다');
});

dbTest('게이트 대상 판정 — 커미셔너만, 다 채우면 해제 (실 DB)', async (t) => {
  const { query, pool } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const fastifyJwt = (await import('@fastify/jwt')).default;
  const targetRoutes = (await import('../src/routes/targetRoutes.js')).default;

  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET, sign: { expiresIn: '1h' } });
  app.register(targetRoutes);
  await app.ready();

  const TAG = 'GT' + String(Date.now()).slice(-6);
  const team = Number((await query(
    `INSERT INTO sales_teams (name, is_sales) VALUES ($1,true) RETURNING id`, ['04_dante' + TAG])).rows[0].id);
  const mk = async (n, role, tid = null) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id, team_id) VALUES ($1,$2,'x',$3,$4) RETURNING id`,
    [n + TAG, role, n.toLowerCase() + TAG, tid])).rows[0].id);
  const dante = await mk('Dante', 'sales', team);
  const otroSales = await mk('Otro', 'sales', team);      // 안내서 권한 없음
  const dir = await mk('Dir', 'director');
  // 안내서 권한은 dante 에게만 켠다 — 이게 대상 지정 방식이다.
  await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
               VALUES ($1,'guiacom','anywhere','view')`, [dante]);
  const c1 = Number((await query(
    `INSERT INTO customers (code, name, team_id, owner_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['C-' + TAG, 'Cli' + TAG, team, dante])).rows[0].id);

  t.after(async () => {
    await query(`DELETE FROM target_customer_months WHERE customer_id=$1`, [c1]).catch(() => {});
    await query(`DELETE FROM customers WHERE id=$1`, [c1]);
    await query(`DELETE FROM agent_plan_goals WHERE user_id = ANY($1)`, [[dante]]).catch(() => {});
    await query(`DELETE FROM user_page_access WHERE user_id=$1`, [dante]);
    await query(`DELETE FROM audit_log WHERE user_id = ANY($1)`, [[dante, dir, otroSales]]).catch(() => {});
    await query(`DELETE FROM users WHERE id = ANY($1)`, [[dante, otroSales, dir]]);
    await query(`DELETE FROM sales_teams WHERE id=$1`, [team]);
    await app.close();
    await pool.end().catch(() => {});
  });

  const status = (u) => app.inject({ method: 'GET', url: '/api/targets/my-plan-status',
    headers: { authorization: 'Bearer ' + app.jwt.sign({ sub: u }) } }).then((r) => r.json());

  // F1. 안내서 권한이 켜진 커미셔너 · 배분 0 → 게이트 ON
  let d = await status(dante);
  assert.equal(d.has_guide, true);
  assert.equal(d.needs_guide, true);
  assert.equal(d.goal_amount, 3000000);

  // F2. 안내서 권한이 없는 직원은 대상이 아니다 (업무가 막히면 안 된다)
  d = await status(otroSales);
  assert.equal(d.has_guide, false);
  assert.equal(d.needs_guide, false);

  // F3. 디렉터도 대상이 아니다
  assert.equal((await status(dir)).needs_guide, false);

  // F4. 일부만 배분하면 여전히 ON
  await query(`INSERT INTO target_customer_months (customer_id, ym, amount) VALUES ($1,'2027-01',1500000)`, [c1]);
  d = await status(dante);
  assert.equal(d.plan_total, 1500000);
  assert.equal(d.needs_guide, true, '절반만 채우면 아직 안내서로 보낸다');

  // F5. 300만을 다 채우면 게이트가 풀린다 ★
  await query(`INSERT INTO target_customer_months (customer_id, ym, amount) VALUES ($1,'2027-02',1500000)`, [c1]);
  d = await status(dante);
  assert.equal(d.plan_total, 3000000);
  assert.equal(d.reached, true);
  assert.equal(d.needs_guide, false, '다 배분하면 더 이상 안내서로 보내지 않는다');

  // F6. 디렉터가 목표를 올리면 다시 ON — 판정이 저장된 목표를 따라간다
  await app.inject({ method: 'PUT', url: '/api/targets/agent-goal',
    headers: { authorization: 'Bearer ' + app.jwt.sign({ sub: dir }), 'content-type': 'application/json' },
    payload: { user_id: dante, goal_amount: 5000000, horizon: '2027-12' } });
  assert.equal((await status(dante)).needs_guide, true);
});
