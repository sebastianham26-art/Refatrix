// =====================================================================
// 견적 재고예약 현황 — 종단 검증 (실 PostgreSQL)  2026-09-30
//   화면 요구: 누가 · 언제 · 어떤 제품을 · 몇 개 · 어떤 견적으로 예약했고 · 언제 풀리나.
//   잠그는 것
//     ① 「살아 있는 예약」 정의가 가용재고 계산(quoteBuild.assignReservations)과 같다
//        — 만료·전환·삭제·예약 0 은 안 보이고, 포장지시 인쇄 건은 시각이 지나도 보인다.
//     ② 팀 가시성은 견적 목록과 같다. 단 제품별 「전체 예약·가용」은 회사 전체 숫자.
//     ③ 웹카달록 견적은 작성자 대신 「웹카달록 · 담당」으로 표시.
//     ④ ?released=N 은 만료로 풀린 예약만, N 시간 안의 것만.
//   실행: TEST_PG_URL=postgres://... node --test test/reservations_e2e.test.mjs
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PG = process.env.TEST_PG_URL;
const SKIP = !PG;
if (SKIP) console.log('[skip] TEST_PG_URL 없음 — 실 Postgres 검증 생략');
if (PG) process.env.DATABASE_URL = PG;

let query, app, reserveExpiresAt;
const tok = {};
const ID = {};
const TAG = 'RSVTEST';

async function cleanup() {
  const U = `SELECT id FROM users WHERE login_id LIKE 'rsvtest%'`;
  await query(`DELETE FROM quote_lines WHERE quote_id IN (SELECT id FROM quotes WHERE memo LIKE '${TAG}%')`);
  await query(`DELETE FROM quotes WHERE memo LIKE '${TAG}%'`);
  await query(`DELETE FROM products WHERE code LIKE '${TAG}%'`);
  await query(`DELETE FROM customers WHERE name LIKE '${TAG}%'`);
  await query(`DELETE FROM user_page_access WHERE user_id IN (${U})`);
  await query(`DELETE FROM audit_log WHERE user_id IN (${U})`).catch(() => {});
  await query(`DELETE FROM users WHERE login_id LIKE 'rsvtest%'`);
  await query(`DELETE FROM sales_teams WHERE name LIKE '${TAG}%'`);
}

const H = 3600000;
const at = (h) => new Date(Date.now() + h * H).toISOString();

async function boot() {
  ({ query } = await import('../src/db.js'));
  ({ reserveExpiresAt } = await import('../src/quoteExpiry.js'));
  const routes = (await import('../src/routes/reservationRoutes.js')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await cleanup();

  const team = async (n) => Number((await query(`INSERT INTO sales_teams (name) VALUES ($1) RETURNING id`, [`${TAG}${n}`])).rows[0].id);
  ID.tA = await team('A'); ID.tB = await team('B');
  const mkUser = async (name, role, login, teamId) => Number((await query(
    `INSERT INTO users (name, role, pin_hash, login_id, team_id) VALUES ($1,$2,'x',$3,$4) RETURNING id`,
    [name, role, login, teamId])).rows[0].id);
  ID.dir = await mkUser(`${TAG}디렉터`, 'director', 'rsvtest_dir', null);
  ID.repA = await mkUser('Oscar', 'sales', 'rsvtest_repa', ID.tA);
  ID.repB = await mkUser('Armando', 'sales', 'rsvtest_repb', ID.tB);
  ID.noPerm = await mkUser('NoPerm', 'sales', 'rsvtest_noperm', ID.tA);
  for (const u of [ID.repA, ID.repB]) {
    await query(`INSERT INTO user_page_access (user_id, page_key, device_req, access)
                 VALUES ($1,'quote','anywhere','edit') ON CONFLICT DO NOTHING`, [u]);
  }
  const mkCust = async (n, teamId) => Number((await query(
    `INSERT INTO customers (name, code, team_id, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`${TAG}${n}`, `${TAG}-${n}`, teamId, ID.dir])).rows[0].id);
  ID.cA = await mkCust('ClienteA', ID.tA); ID.cB = await mkCust('ClienteB', ID.tB);

  const mkProd = async (code, stock) => Number((await query(
    `INSERT INTO products (code, name, stock_qty) VALUES ($1,$2,$3) RETURNING id`, [`${TAG}${code}`, `Prod ${code}`, stock])).rows[0].id);
  ID.p1 = await mkProd('P1', 20); ID.p2 = await mkProd('P2', 2); ID.p3 = await mkProd('P3', 10);

  let seq = 0;
  const mkQuote = async ({ cust, by, status = 'draft', exp, packed = null, origin = null, assigned = null, deleted = false, created = null, lines }) => {
    seq += 1;
    const q = (await query(
      `INSERT INTO quotes (quote_no, customer_id, quote_date, status, memo, created_by, reserve_expires_at,
                           packing_printed_at, origin, assigned_to, deleted_at, created_at, external_quote_no)
       VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, now()),$12) RETURNING id`,
      [`${TAG}-Q${seq}`, cust, status, `${TAG} q${seq}`, by, exp, packed, origin, assigned,
       deleted ? new Date().toISOString() : null, created, origin === 'crm' ? `COT-${TAG}-${seq}` : null])).rows[0];
    let n = 0;
    for (const [pid, qty, rsv, price] of lines) {
      n += 1;
      await query(
        `INSERT INTO quote_lines (quote_id, line_no, product_id, ctr_code, product_name, qty, reserved_qty, final_price, line_subtotal)
         VALUES ($1,$2,$3,(SELECT code FROM products WHERE id=$3),(SELECT name FROM products WHERE id=$3),$4,$5,$6,$7)`,
        [q.id, n, pid, qty, rsv, price, qty * price]);
    }
    return Number(q.id);
  };
  // 살아 있는 예약
  ID.qA = await mkQuote({ cust: ID.cA, by: ID.repA, exp: at(3), lines: [[ID.p1, 5, 5, 100], [ID.p2, 4, 2, 50]] });
  ID.qB = await mkQuote({ cust: ID.cB, by: ID.repB, status: 'confirmed', exp: at(1), lines: [[ID.p1, 3, 3, 100]] });
  ID.qCat = await mkQuote({ cust: ID.cA, by: null, exp: at(20), origin: 'crm', assigned: ID.repA, lines: [[ID.p3, 2, 2, 80]] });
  ID.qHold = await mkQuote({ cust: ID.cA, by: ID.repA, status: 'confirmed', exp: at(-10), packed: at(-11), lines: [[ID.p1, 1, 1, 100]] });
  // 토요일 12:00(MX) 접수 → 다음 근무일 07:30 기산
  const sat = '2026-10-03T18:00:00Z';
  ID.qOff = await mkQuote({ cust: ID.cA, by: ID.repA, exp: reserveExpiresAt(new Date(sat)).toISOString(), created: sat, lines: [[ID.p3, 1, 1, 80]] });
  // 안 보여야 하는 것
  ID.qExp5 = await mkQuote({ cust: ID.cA, by: ID.repA, status: 'expired', exp: at(-5), lines: [[ID.p3, 4, 4, 80]] });
  ID.qLapsed = await mkQuote({ cust: ID.cB, by: ID.repB, exp: at(-2), lines: [[ID.p3, 1, 1, 80]] });   // 스위퍼 전(아직 draft)
  ID.qExp30 = await mkQuote({ cust: ID.cA, by: ID.repA, status: 'expired', exp: at(-30), lines: [[ID.p3, 6, 6, 80]] });
  ID.qConv = await mkQuote({ cust: ID.cA, by: ID.repA, status: 'converted', exp: at(5), lines: [[ID.p1, 7, 7, 100]] });
  ID.qDel = await mkQuote({ cust: ID.cA, by: ID.repA, exp: at(5), deleted: true, lines: [[ID.p1, 9, 9, 100]] });
  ID.qZero = await mkQuote({ cust: ID.cA, by: ID.repA, exp: at(5), lines: [[ID.p2, 3, 0, 50]] });

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret' });
  await app.register(routes);
  await app.ready();
  for (const k of ['dir', 'repA', 'repB', 'noPerm']) tok[k] = app.jwt.sign({ sub: ID[k] });
}

const get = (who, url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + tok[who] } });
const mine = (items) => items.filter((i) => String(i.quote_no).startsWith(TAG));
const qids = (items) => [...new Set(mine(items).map((i) => i.quote_id))];

test('boot', { skip: SKIP }, async () => { await boot(); });

test('① 살아 있는 예약만 — 만료·전환·삭제·예약 0 은 빠지고 포장지시는 남는다', { skip: SKIP }, async () => {
  const r = await get('dir', '/api/reservations');
  assert.equal(r.statusCode, 200, r.body);
  const d = r.json();
  assert.deepEqual(qids(d.items).sort((a, b) => a - b), [ID.qA, ID.qB, ID.qCat, ID.qHold, ID.qOff].sort((a, b) => a - b));
  // 곧 풀리는 순, 포장지시는 맨 뒤
  const order = qids(d.items);
  assert.equal(order[0], ID.qB, '1시간 남은 견적이 먼저');
  assert.equal(order[order.length - 1], ID.qHold, '포장지시(시간 무관)는 맨 뒤');
  const hold = mine(d.items).find((i) => i.quote_id === ID.qHold);
  assert.equal(hold.state, 'hold'); assert.equal(hold.releases_at, null);
  const b = mine(d.items).find((i) => i.quote_id === ID.qB);
  assert.equal(b.urgency, 'soon'); assert.equal(b.quote_status, 'confirmed');
  assert.ok(b.remaining_min > 50 && b.remaining_min <= 60);
  assert.equal(d.released.length, 0, '기본은 풀린 예약을 안 보낸다');
});

test('② 누가 · 언제 · 몇 개 · 금액 · 부분예약', { skip: SKIP }, async () => {
  const d = (await get('dir', '/api/reservations')).json();
  const a = mine(d.items).filter((i) => i.quote_id === ID.qA);
  assert.equal(a.length, 2);
  assert.equal(a[0].by.label, 'Oscar'); assert.equal(a[0].by.sub, 'rsvtest_repa'); assert.equal(a[0].by.kind, 'user');
  assert.equal(a[0].party_name, `${TAG}ClienteA`);
  assert.ok(a[0].reserved_at, '예약(접수) 시각');
  const p2 = a.find((i) => i.product_id === ID.p2);
  assert.equal(p2.qty, 4); assert.equal(p2.reserved_qty, 2); assert.equal(p2.partial, true);
  assert.equal(p2.reserved_sub, 100, '4개 200 중 예약 2개분 = 100');
  const cat = mine(d.items).find((i) => i.quote_id === ID.qCat);
  assert.equal(cat.by.kind, 'catalog'); assert.equal(cat.by.label, '웹카달록'); assert.equal(cat.by.sub, '담당 Oscar');
  assert.equal(cat.origin, 'catalog'); assert.ok(cat.external_quote_no.startsWith('COT-'));
});

test('③ 근무시간 밖 접수 → 기산 시각이 다음 근무일 07:30', { skip: SKIP }, async () => {
  const d = (await get('dir', '/api/reservations')).json();
  const off = mine(d.items).find((i) => i.quote_id === ID.qOff);
  assert.equal(off.offhours, true);
  assert.equal(off.count_from, '2026-10-05T13:30:00.000Z', '월 07:30 MX');
  assert.equal(off.releases_at, '2026-10-06T13:30:00.000Z', '+24h');
  const a = mine(d.items).find((i) => i.quote_id === ID.qA);
  assert.equal(typeof a.offhours, 'boolean');
});

test('④ 팀 가시성 — 견적 목록과 같다 · 제품 합계는 회사 전체', { skip: SKIP }, async () => {
  const d = (await get('repA', '/api/reservations')).json();
  assert.equal(d.scope, 'team');
  const ids = qids(d.items);
  assert.ok(!ids.includes(ID.qB), 'B팀 견적은 안 보인다');
  assert.ok(ids.includes(ID.qA) && ids.includes(ID.qCat));
  const p1 = d.products.find((p) => p.product_id === ID.p1);
  assert.equal(p1.stock_qty, 20);
  assert.equal(p1.reserved_all, 9, 'A 5 + B 3 + 포장 1 — 안 보이는 B팀 예약도 가용에서 뺀다');
  assert.equal(p1.available, 11);
  assert.equal(p1.reserved_qty, 6, '이 사람에게 보이는 예약은 5 + 1');
  assert.equal(p1.items, undefined, '제품 묶음에 줄을 중복으로 싣지 않는다');
  const dB = (await get('repB', '/api/reservations')).json();
  assert.deepEqual(qids(dB.items), [ID.qB]);
});

test('⑤ 가용재고 계산과 같은 정의 — 제품별 전체 예약 = quoteBuild 의 타 견적 합', { skip: SKIP }, async () => {
  const d = (await get('dir', '/api/reservations')).json();
  for (const pid of [ID.p1, ID.p2, ID.p3]) {
    const ref = Number((await query(
      `SELECT COALESCE(SUM(ql.reserved_qty),0) AS s
         FROM quote_lines ql JOIN quotes q ON q.id=ql.quote_id
        WHERE ql.product_id=$1 AND q.status IN ('draft','confirmed')
          AND (q.reserve_expires_at > now() OR q.packing_printed_at IS NOT NULL)
          AND q.deleted_at IS NULL`, [pid])).rows[0].s);
    const g = d.products.find((p) => p.product_id === pid);
    assert.equal(g.reserved_all, ref, 'product ' + pid);
  }
});

test('⑥ 최근 풀린 예약 — 만료로 풀린 것만, 기간 안의 것만', { skip: SKIP }, async () => {
  const d24 = (await get('dir', '/api/reservations?released=24')).json();
  assert.equal(d24.released_hours, 24);
  assert.deepEqual(qids(d24.released).sort((a, b) => a - b), [ID.qExp5, ID.qLapsed].sort((a, b) => a - b),
    '스위퍼 전(draft)이어도 시각이 지났으면 풀린 것');
  assert.ok(mine(d24.released).every((i) => i.state === 'released'));
  assert.equal(qids(d24.released)[0], ID.qLapsed, '최근에 풀린 것부터');
  const d48 = (await get('dir', '/api/reservations?released=48')).json();
  assert.ok(qids(d48.released).includes(ID.qExp30));
  const big = (await get('dir', '/api/reservations?released=99999')).json();
  assert.equal(big.released_hours, 168, '상한 7일');
  const junk = (await get('dir', '/api/reservations?released=abc')).json();
  assert.equal(junk.released_hours, 0);
  const dA = (await get('repA', '/api/reservations?released=24')).json();
  assert.ok(!qids(dA.released).includes(ID.qLapsed), '풀린 예약에도 팀 가시성');
});

test('⑦ 화면 권한(견적·영업) 없으면 403', { skip: SKIP }, async () => {
  const r = await get('noPerm', '/api/reservations');
  assert.equal(r.statusCode, 403);
});

test('cleanup', { skip: SKIP }, async () => { await cleanup(); await app.close(); const { pool } = await import('../src/db.js'); await pool.end(); });
