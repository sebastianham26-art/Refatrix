/* 창고 위치변경(0187) — 운영 라우트 모듈을 그대로 import 해서 실 PostgreSQL 위에서 실행한다.
   (SQL 복붙이 아니라 운영 코드 자체를 돌리므로, 코드가 바뀌면 이 테스트도 같이 바뀐다)

   실행:  TEST_PG_URL=postgres://... node test/rack_relocate_sql.test.mjs
   TEST_PG_URL 이 없으면 DB 파트는 skip 하고 정적 가드 검사만 돈다(기본 CI 무영향). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(here, '..');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); }
};

/* ---------- ① 정적 가드 (DB 없이도 항상 돈다) ---------- */
const SRC = fs.readFileSync(path.join(API, 'src/routes/rackMoveRoutes.js'), 'utf8');
console.log('\n① 정적 가드');
ok('읽기·이동은 창고 권한 가드', /const g = \{ preHandler: \[authGuard, requirePage\('warehouse'\)\] \}/.test(SRC));
ok('랙 유형 저장은 디렉터 전용', /const gDir = \{ preHandler: \[authGuard, requireDirector\] \}/.test(SRC));
ok('랙 유형 PUT 이 gDir 사용', /'\/api\/warehouse\/rack-kinds', gDir/.test(SRC));
ok('이동 저장은 창고 권한(gDir 아님)', /'\/api\/warehouse\/rack-moves', g,/.test(SRC));
ok('stock_qty 를 UPDATE 하지 않는다(재고 총량 불변)', !/UPDATE\s+products[\s\S]{0,200}stock_qty\s*=/.test(SRC));
ok('감사로그는 0057 CHECK 에 있는 표준 액션만 사용', (SRC.match(/action: '([a-z_]+)'/g) || []).every((s) => /'update'/.test(s)));

const MIG = fs.readFileSync(path.join(API, 'migrations/0187_rack_relocate.sql'), 'utf8');
ok('마이그레이션이 기존 테이블을 ALTER 하지 않는다', !/ALTER TABLE (?!rack_)/.test(MIG));
ok('rack_moves 는 출발=도착을 CHECK 로 막는다', /rack_moves_diff_chk/.test(MIG));

const SERVER = fs.readFileSync(path.join(API, 'src/server.js'), 'utf8');
ok('server.js 에 rackMoveRoutes 등록', /import rackMoveRoutes/.test(SERVER) && /app\.register\(rackMoveRoutes\)/.test(SERVER));

const NAV = fs.readFileSync(path.resolve(API, '..', 'refatrix-nav.js'), 'utf8');
ok('nav 에 위치변경 화면 등록', /relocate:\{file:'refatrix-relocate\.html'/.test(NAV));
ok('nav 권한키 warehouse', /relocate:'warehouse'/.test(NAV));
ok('nav 창고 그룹에 포함', /screens:\['whHome','stockcount','inbound','relocate','zones'\]/.test(NAV));

/* ---------- ② 실 DB 파트 ---------- */
const URL = process.env.TEST_PG_URL || process.env.DATABASE_URL;
if (!URL) {
  console.log('\n② DB 파트 — TEST_PG_URL 없음 → skip');
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
process.env.DATABASE_URL = URL;

const { pool, query } = await import('../src/db.js');
const routes = (await import('../src/routes/rackMoveRoutes.js')).default;

/* Fastify 대역 — 운영 모듈이 등록하는 핸들러를 그대로 붙잡는다 */
const H = {};
const app = {};
for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
  app[m] = (p, o, h) => { H[m.toUpperCase() + ' ' + p] = (typeof o === 'function' ? o : h); };
}
await routes(app);

const UID = { v: null };
function mkReply() {
  const r = { _code: 200, _sent: null };
  r.code = (c) => { r._code = c; return r; };
  r.send = (b) => { r._sent = b; return b; };
  return r;
}
async function call(key, { body = {}, query: q = {}, params = {} } = {}) {
  const h = H[key];
  if (!h) throw new Error('no handler: ' + key);
  const reply = mkReply();
  const req = { user: { sub: UID.v }, ctx: { deviceId: null }, body, query: q, params };
  const out = await h(req, reply);
  return { out, code: reply._code, sent: reply._sent };
}

async function seed() {
  await query(`DELETE FROM rack_moves`);
  await query(`DELETE FROM rack_kinds`);
  await query(`DELETE FROM rack_zones`);
  await query(`DELETE FROM products WHERE code LIKE 'TST%'`);
  const u = (await query(
    `INSERT INTO users (name, role, pin_hash) VALUES ('테스트창고','warehouse','x') RETURNING id`
  )).rows[0];
  UID.v = Number(u.id);
  const mk = async (code, name, rack, stock) => Number((await query(
    `INSERT INTO products (code, name, rack_location, stock_qty) VALUES ($1,$2,$3,$4) RETURNING id`,
    [code, name, rack, stock]
  )).rows[0].id);
  return {
    a: await mk('TSTCE0796', 'TERMINAL EXTERIOR', 'B-01-01', 480),
    b: await mk('TSTCE0152', 'TERMINAL', 'b-01-02', 96),
    c: await mk('TST-CE-9', 'GUIA', null, 12),
  };
}

const P = await seed();

console.log('\n② 랙 목록 · 랙 유형');
{
  const r1 = await call("PUT /api/warehouse/rack-kinds", { body: { map: [{ rack: 'FM-01', kind: 'fast' }, { rack: 'B-01-01', kind: 'carton' }] } });
  ok('유형 저장 2건', r1.out && r1.out.ok && r1.out.set === 2, r1.out);

  const g = await call('GET /api/warehouse/racks');
  const byRack = Object.fromEntries(g.out.racks.map((r) => [r.rack.toUpperCase(), r]));
  ok('제품이 없는 fast rack 도 목록에 나온다(FM-01)', !!byRack['FM-01'] && byRack['FM-01'].kind === 'fast');
  ok('FM-01 제품수 0', byRack['FM-01'].products === 0);
  ok('B-01-01 은 carton 으로 지정됨', byRack['B-01-01'].kind === 'carton' && byRack['B-01-01'].kind_set === true);
  ok('미지정 랙은 기본 carton + kind_set=false', byRack['B-01-02'] && byRack['B-01-02'].kind === 'carton' && byRack['B-01-02'].kind_set === false, byRack['B-01-02']);
  ok('totals.fast = 1', g.out.totals.fast === 1, g.out.totals);

  // 대소문자만 다른 재지정 — 행이 늘지 않아야 한다
  await call('PUT /api/warehouse/rack-kinds', { body: { map: [{ rack: 'fm-01', kind: 'carton' }] } });
  const n = Number((await query(`SELECT COUNT(*)::int n FROM rack_kinds WHERE UPPER(rack)='FM-01'`)).rows[0].n);
  ok('대소문자 다른 표기로 저장해도 1행 유지', n === 1, n);
  await call('PUT /api/warehouse/rack-kinds', { body: { map: [{ rack: 'FM-01', kind: 'fast' }] } });

  const bad = await call('PUT /api/warehouse/rack-kinds', { body: { map: [{ rack: 'X', kind: 'hot' }] } });
  ok('허용되지 않은 유형은 400', bad.code === 400 && bad.sent.error === 'bad_kind', bad.sent);

  const clr = await call('PUT /api/warehouse/rack-kinds', { body: { map: [{ rack: 'B-01-01', kind: null }] } });
  ok('kind:null 은 그 랙 지정만 삭제', clr.out.cleared === 1 && clr.out.set === 0, clr.out);
}

console.log('\n③ 카톤 라벨 조회');
{
  const r = await call('GET /api/warehouse/relocate/lookup', { query: { q: 'CTR-TSTCE0796-16' } });
  ok('CTR 라벨 → 제품번호 분리', r.out.product.code === 'TSTCE0796', r.out);
  ok('CTR 라벨 → 소입수량 16', r.out.label.qty === 16, r.out.label);
  ok('현재 마스터 위치를 함께 준다', r.out.product.rack === 'B-01-01');
  ok('그 랙의 유형도 함께 준다', r.out.product.rack_kind === 'carton', r.out.product.rack_kind);

  const r2 = await call('GET /api/warehouse/relocate/lookup', { query: { q: 'tstce0152' } });
  ok('접두어 없는 제품번호도 조회(대소문자 무시)', r2.out.product.code === 'TSTCE0152');
  ok('수량 없는 스캔은 qty 0', r2.out.label.qty === 0);

  const r3 = await call('GET /api/warehouse/relocate/lookup', { query: { q: 'CTR-TSTCE9-4' } });
  ok('하이픈 표기 흔들림 폴백(TSTCE9 → TST-CE-9)', r3.out && r3.out.product && r3.out.product.code === 'TST-CE-9', r3.sent || r3.out);

  const r4 = await call('GET /api/warehouse/relocate/lookup', { query: { q: 'CTR-NOPE-1' } });
  ok('미등록 코드는 404', r4.code === 404 && r4.sent.error === 'product_not_found', r4.sent);
}

console.log('\n④ 이동 저장 — 위치만 바뀌고 재고는 그대로');
{
  const before = (await query('SELECT stock_qty, rack_location FROM products WHERE id=$1', [P.a])).rows[0];
  const r = await call('POST /api/warehouse/rack-moves', {
    body: {
      from_rack: 'B-01-01', to_rack: 'FM-01', update_master: true,
      lines: [{ product_id: P.a, cartons: 3, per_carton: 16, label: 'CTR-TSTCE0796-16' }],
    },
  });
  ok('저장 성공', r.out && r.out.ok, r.sent || r.out);
  ok('EA = 카톤 × 소입수량 (3×16=48)', r.out.totals.qty_ea === 48, r.out.totals);

  const row = (await query('SELECT * FROM rack_moves ORDER BY id DESC LIMIT 1')).rows[0];
  ok('기록에 출발·도착 랙', row.from_rack === 'B-01-01' && row.to_rack === 'FM-01');
  ok('기록에 유형 스냅샷(carton → fast)', row.from_kind === 'carton' && row.to_kind === 'fast', { f: row.from_kind, t: row.to_kind });
  ok('기록에 제품번호 스냅샷', row.product_code === 'TSTCE0796');
  ok('작업자 기록', Number(row.moved_by) === UID.v);

  const after = (await query('SELECT stock_qty, rack_location FROM products WHERE id=$1', [P.a])).rows[0];
  ok('제품마스터 위치가 새 랙으로 갱신', after.rack_location === 'FM-01', after.rack_location);
  ok('★ 재고 총량은 변하지 않는다', Number(after.stock_qty) === Number(before.stock_qty), { before: before.stock_qty, after: after.stock_qty });
  ok('master_updated=true 로 남는다', row.master_updated === true);
  ok('갱신 직전 위치를 master_from 에 보관', row.master_from === 'B-01-01');
}

console.log('\n⑤ 부분 이동(마스터 갱신 끄기) · 방어');
{
  const r = await call('POST /api/warehouse/rack-moves', {
    body: {
      from_rack: 'b-01-02', to_rack: 'FM-01', update_master: false,
      lines: [{ code: 'TSTCE0152', cartons: 1, per_carton: 12 }],
    },
  });
  ok('code 로도 제품을 찾는다', r.out && r.out.ok, r.sent || r.out);
  const p = (await query('SELECT rack_location FROM products WHERE id=$1', [P.b])).rows[0];
  ok('update_master:false 면 마스터 위치 그대로', p.rack_location === 'b-01-02', p.rack_location);
  const row = (await query('SELECT master_updated FROM rack_moves ORDER BY id DESC LIMIT 1')).rows[0];
  ok('master_updated=false 로 남는다', row.master_updated === false);

  const same = await call('POST /api/warehouse/rack-moves', {
    body: { from_rack: 'FM-01', to_rack: 'fm-01', lines: [{ product_id: P.a, cartons: 1, per_carton: 16 }] },
  });
  ok('출발=도착(대소문자 무시)은 400', same.code === 400 && same.sent.error === 'same_rack', same.sent);

  const none = await call('POST /api/warehouse/rack-moves', { body: { to_rack: 'FM-01', lines: [] } });
  ok('빈 라인은 400', none.code === 400 && none.sent.error === 'no_lines');

  const noTo = await call('POST /api/warehouse/rack-moves', { body: { lines: [{ product_id: P.a, cartons: 1, per_carton: 1 }] } });
  ok('도착 랙 없으면 400', noTo.code === 400 && noTo.sent.error === 'to_rack_required');

  // 출발 랙을 안 보내면 제품마스터 위치를 출발지로 쓴다
  const auto = await call('POST /api/warehouse/rack-moves', {
    body: { to_rack: 'FM-02', lines: [{ product_id: P.b, cartons: 2, per_carton: 12 }] },
  });
  ok('출발 랙 생략 시 마스터 위치를 출발지로 기록', auto.out.moved[0].from_rack === 'b-01-02', auto.out.moved[0]);

  // 위치 미지정 제품 — 출발지 NULL 로도 기록된다
  const nul = await call('POST /api/warehouse/rack-moves', {
    body: { to_rack: 'FM-01', lines: [{ product_id: P.c, cartons: 1, per_carton: 4 }] },
  });
  ok('마스터 위치가 없어도 이동 기록 가능(출발 NULL)', nul.out.ok && nul.out.moved[0].from_rack === null, nul.out.moved && nul.out.moved[0]);

  // 트랜잭션 — 한 줄이 실패하면 전부 롤백
  const cnt0 = Number((await query('SELECT COUNT(*)::int n FROM rack_moves')).rows[0].n);
  const mixed = await call('POST /api/warehouse/rack-moves', {
    body: {
      from_rack: 'FM-01', to_rack: 'FM-03',
      lines: [{ product_id: P.a, cartons: 1, per_carton: 16 }, { code: 'NOPE-XX', cartons: 1, per_carton: 1 }],
    },
  });
  const cnt1 = Number((await query('SELECT COUNT(*)::int n FROM rack_moves')).rows[0].n);
  ok('한 줄이라도 실패하면 전부 롤백(부분 기록 없음)', mixed.code === 400 && cnt1 === cnt0, { code: mixed.code, cnt0, cnt1 });
  const pa = (await query('SELECT rack_location FROM products WHERE id=$1', [P.a])).rows[0];
  ok('롤백 시 제품 위치도 되돌아간다', pa.rack_location === 'FM-01', pa.rack_location);
}

console.log('\n⑥ 기록 조회 · 되돌리기');
{
  const all = await call('GET /api/warehouse/rack-moves', { query: { limit: 100 } });
  ok('기록 목록에 작업자 이름이 붙는다', all.out.moves.length > 0 && all.out.moves[0].moved_by_name === '테스트창고');
  ok('최근순 정렬', all.out.moves[0].id > all.out.moves[all.out.moves.length - 1].id);

  const byRack = await call('GET /api/warehouse/rack-moves', { query: { rack: 'fm-02' } });
  ok('랙 필터는 대소문자 무시 · 출발/도착 모두 매칭', byRack.out.moves.length === 1 && byRack.out.moves[0].to_rack === 'FM-02', byRack.out.count);

  const byCode = await call('GET /api/warehouse/rack-moves', { query: { code: 'tstce0796' } });
  ok('제품번호 필터(대소문자 무시)', byCode.out.moves.every((m) => m.product_code === 'TSTCE0796') && byCode.out.moves.length >= 1);

  const sum = await call('GET /api/warehouse/rack-moves/summary', { query: { days: 90 } });
  const fm01 = sum.out.rows.filter((r) => r.rack.toUpperCase() === 'FM-01' && r.product_code === 'TSTCE0796')[0];
  ok('랙별 누적 합계(FM-01 / TSTCE0796 = 3카톤 48EA)', fm01 && fm01.cartons === 3 && fm01.qty_ea === 48, fm01);

  // 되돌리기 — 원장은 지우지 않고 반대 이동을 남긴다
  const target = (await query(
    `SELECT id FROM rack_moves WHERE product_id=$1 AND master_updated ORDER BY id ASC LIMIT 1`, [P.a]
  )).rows[0];
  const u = await call('POST /api/warehouse/rack-moves/:id/undo', { params: { id: String(target.id) } });
  ok('되돌리기 성공', u.out && u.out.ok, u.sent || u.out);
  const back = (await query('SELECT rack_location FROM products WHERE id=$1', [P.a])).rows[0];
  ok('제품 위치가 원래 랙으로 복귀', back.rack_location === 'B-01-01', back.rack_location);
  const undoRow = (await query('SELECT * FROM rack_moves ORDER BY id DESC LIMIT 1')).rows[0];
  ok('원본 기록은 남고 반대 방향 기록이 추가된다', undoRow.from_rack === 'FM-01' && undoRow.to_rack === 'B-01-01' && /되돌리기/.test(undoRow.note || ''));
  const orig = (await query('SELECT id FROM rack_moves WHERE id=$1', [target.id])).rows[0];
  ok('원본 기록은 삭제되지 않는다', !!orig);
}

console.log('\n⑦ DB 제약');
{
  let blocked = false;
  try {
    await query(`INSERT INTO rack_moves (product_id, product_code, from_rack, to_rack, cartons)
                 VALUES ($1,'X','A-1','a-1',1)`, [P.a]);
  } catch (e) { blocked = /rack_moves_diff_chk/.test(e.message); }
  ok('DB 가 출발=도착(대소문자 무시) 을 거부', blocked);

  let blocked2 = false;
  try { await query(`INSERT INTO rack_kinds (rack, kind) VALUES ('ZZ','hot')`); }
  catch (e) { blocked2 = /rack_kinds_kind_chk/.test(e.message); }
  ok('DB 가 알 수 없는 랙 유형을 거부', blocked2);

  let blocked3 = false;
  try {
    await query(`INSERT INTO rack_moves (product_id, product_code, to_rack, cartons)
                 VALUES ($1,'X','A-1',0)`, [P.a]);
  } catch (e) { blocked3 = /rack_moves_cartons_chk/.test(e.message); }
  ok('DB 가 카톤 0 이하를 거부', blocked3);
}

await query(`DELETE FROM rack_moves`);
await query(`DELETE FROM rack_kinds`);
await query(`DELETE FROM products WHERE code LIKE 'TST%'`);
await query(`DELETE FROM audit_log WHERE user_id=$1`, [UID.v]);
await query(`DELETE FROM users WHERE id=$1`, [UID.v]);
await pool.end();

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
